import { prisma } from '@bscs/db';
import type { PlayStyle, PlayerProfile } from '@bscs/core/stats';
import { parseFormat } from './match-helpers';
import { buildPoolBoard, loadBoardMembers, type BoardCell, type BoardMap } from './board';
import { buildTournamentModel, type TournamentModel } from './stats';

/**
 * Player stats: the same scores and model as the pool board, turned to face
 * the player instead of the map.
 *
 * Everything is measured inside the team first - rank among teammates, maps
 * where they are the team's best, how often they make the strongest group -
 * because the question a captain is asking is "who do I field", and the answer
 * is always relative to who else they have.
 */

export interface PlayerMapLine {
  map: BoardMap;
  poolId: string;
  poolName: string;
  cell: BoardCell;
  /** What they are expected to score: the real score, or the model's figure where there is none (or only an abandoned run). */
  expected: number;
  /** 1-based, by expected accuracy, among this team. */
  teamRank: number;
  teamSize: number;
  /** Against the mean of their teammates' expected accuracy - themselves left out. */
  vsTeam: number | null;
  /** Against the field's mean of real scores on this map. */
  vsField: number | null;
  /** Among the team's strongest group for this map. */
  inBestGroup: boolean;
}

export interface MatchRecord {
  maps: number;
  mapsWon: number;
  meanAcc: number | null;
  /** Match accuracy against their leaderboard best on the same maps; negative is below it. */
  vsBest: number | null;
  runs: Array<{
    matchId: string;
    matchName: string;
    mapName: string;
    teamName: string;
    accuracy: number;
    score: number;
    won: boolean | null;
  }>;
}

export interface PlayerStats {
  playerId: string;
  name: string;
  avatar: string | null;
  beatLeaderId: string;
  pp: number;
  globalRank: number;
  available: boolean;
  isSub: boolean;
  isCaptain: boolean;

  profile: PlayerProfile | null;
  style: PlayStyle | null;

  /** By model skill, 1-based. Null without a profile. */
  teamRank: number | null;
  fieldRank: number | null;
  /** Mean accuracy against the mean of their teammates'. */
  accVsTeam: number | null;
  /** Typical run-to-run spread in accuracy points, at their own level. */
  spreadPoints: number | null;

  lines: PlayerMapLine[];
  played: number;
  bestOnTeam: number;
  inBestGroup: number;

  match: MatchRecord;
}

export interface TeamStats {
  teamId: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  adHoc: boolean;
  players: PlayerStats[];
  meanAcc: number | null;
  /** "2 all-rounders, 1 Tech specialist" */
  shape: string;
}

export interface TournamentStats {
  teams: TeamStats[];
  mapCount: number;
  fieldSize: number;
  playersPerMap: number;
  model: TournamentModel;
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export async function buildTournamentStats(tournamentId: string): Promise<TournamentStats> {
  const [tournament, pools, members] = await Promise.all([
    prisma.tournament.findUnique({ where: { id: tournamentId }, select: { defaultFormat: true } }),
    prisma.mapPool.findMany({
      where: { tournamentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),
    loadBoardMembers(tournamentId),
  ]);
  const playersPerMap = parseFormat(tournament?.defaultFormat).playersPerMap;

  const boards = (await Promise.all(pools.map((p) => buildPoolBoard(p.id)))).filter((b) => b != null);
  const model = boards[0]?.model ?? (await buildTournamentModel(tournamentId));

  // One column per leaderboard, however many pools it appears in.
  const columns: Array<{ map: BoardMap; poolId: string; poolName: string }> = [];
  const cellsOf = new Map<string, Map<string, BoardCell>>();
  for (const board of boards) {
    for (const map of board.maps) {
      if (!columns.some((c) => c.map.leaderboardId === map.leaderboardId)) {
        columns.push({ map, poolId: board.poolId, poolName: board.poolName });
      }
    }
    for (const row of board.teams.flatMap((t) => t.rows)) {
      const mine = cellsOf.get(row.playerId) ?? new Map<string, BoardCell>();
      for (const cell of row.cells) mine.set(cell.leaderboardId, cell);
      cellsOf.set(row.playerId, mine);
    }
  }

  // An abandoned run says nothing about what they would score next time.
  const expectedOf = (cell: BoardCell): number =>
    cell.acc != null && !cell.isDnf ? cell.acc : cell.predictedAcc;

  const fieldSkill = Object.values(model.profiles)
    .map((p) => p.skill)
    .sort((a, b) => b - a);

  const records = await loadMatchRecords(tournamentId, cellsOf);

  const teamOrder: string[] = [];
  const byTeam = new Map<string, typeof members>();
  for (const member of members) {
    if (!byTeam.has(member.team.id)) {
      byTeam.set(member.team.id, []);
      teamOrder.push(member.team.id);
    }
    byTeam.get(member.team.id)!.push(member);
  }

  const teams: TeamStats[] = teamOrder.map((teamId) => {
    const roster = byTeam.get(teamId)!;
    const team = roster[0]!.team;
    const skills = roster
      .map((m) => model.profiles[m.player.id]?.skill)
      .filter((v): v is number => v != null)
      .sort((a, b) => b - a);

    const players: PlayerStats[] = roster.map((member) => {
      const id = member.player.id;
      const profile = model.profiles[id] ?? null;
      const teammates = roster.filter((m) => m.player.id !== id);

      const lines: PlayerMapLine[] = columns.flatMap(({ map, poolId, poolName }) => {
        const cell = cellsOf.get(id)?.get(map.leaderboardId);
        if (!cell) return [];
        const expected = expectedOf(cell);
        const others = teammates
          .map((m) => cellsOf.get(m.player.id)?.get(map.leaderboardId))
          .filter((c): c is BoardCell => c != null)
          .map(expectedOf);
        const teamRank = 1 + others.filter((v) => v > expected).length;
        const othersMean = mean(others);
        return [
          {
            map,
            poolId,
            poolName,
            cell,
            expected,
            teamRank,
            teamSize: others.length + 1,
            vsTeam: othersMean == null ? null : expected - othersMean,
            vsField:
              cell.acc != null && !cell.isDnf && map.fieldMeanAcc != null
                ? cell.acc - map.fieldMeanAcc
                : null,
            inBestGroup: teamRank <= playersPerMap,
          },
        ];
      });

      const teammateMeans = teammates
        .map((m) => model.profiles[m.player.id]?.meanAcc)
        .filter((v): v is number => v != null && v > 0);
      const othersMeanAcc = mean(teammateMeans);

      return {
        playerId: id,
        name: member.player.name,
        avatar: member.player.avatar,
        beatLeaderId: member.player.beatLeaderId,
        pp: member.player.pp,
        globalRank: member.player.rank,
        available: member.available,
        isSub: member.isSub,
        isCaptain: member.role === 'CAPTAIN',
        profile,
        style: model.styles[id] ?? null,
        teamRank: profile ? 1 + skills.filter((v) => v > profile.skill).length : null,
        fieldRank: profile ? 1 + fieldSkill.filter((v) => v > profile.skill).length : null,
        accVsTeam: profile && othersMeanAcc != null ? profile.meanAcc - othersMeanAcc : null,
        // One sigma of run-to-run noise, as accuracy points at their own level.
        spreadPoints: profile
          ? profile.sigma * profile.meanAcc * (1 - profile.meanAcc) * 100
          : null,
        lines,
        played: lines.filter((l) => l.cell.acc != null).length,
        bestOnTeam: lines.filter((l) => l.teamRank === 1 && l.teamSize > 1).length,
        inBestGroup: lines.filter((l) => l.inBestGroup).length,
        match: records.get(id) ?? { maps: 0, mapsWon: 0, meanAcc: null, vsBest: null, runs: [] },
      };
    });

    const labels = new Map<string, number>();
    for (const p of players) {
      if (p.style && !p.style.thin) labels.set(p.style.label, (labels.get(p.style.label) ?? 0) + 1);
    }

    return {
      teamId,
      name: team.name,
      color: team.color,
      colorSecondary: team.colorSecondary,
      adHoc: team.adHoc,
      players,
      meanAcc: mean(players.map((p) => p.profile?.meanAcc).filter((v): v is number => v != null && v > 0)),
      shape: [...labels.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `${n} ${label.toLowerCase()}${n === 1 ? '' : 's'}`)
        .join(', '),
    };
  });

  return { teams, mapCount: columns.length, fieldSize: fieldSkill.length, playersPerMap, model };
}

/**
 * What each player has done in actual matches. A map is theirs to have won or
 * lost only when both sides have a score on it.
 */
async function loadMatchRecords(
  tournamentId: string,
  cellsOf: Map<string, Map<string, BoardCell>>,
): Promise<Map<string, MatchRecord>> {
  const matchMaps = await prisma.matchMap.findMany({
    where: { match: { tournamentId }, attempts: { some: {} } },
    orderBy: [{ match: { createdAt: 'desc' } }, { order: 'asc' }],
    select: {
      match: {
        select: {
          id: true,
          name: true,
          teamAId: true,
          teamBId: true,
          teamA: { select: { name: true } },
          teamB: { select: { name: true } },
        },
      },
      poolMap: {
        select: { leaderboardId: true, leaderboard: { select: { map: { select: { name: true } } } } },
      },
      attempts: { select: { teamId: true, playerId: true, score: true, accuracy: true } },
    },
  });

  const records = new Map<string, MatchRecord & { accs: number[]; diffs: number[] }>();
  for (const mm of matchMaps) {
    // Each player's best run for each side they played it for.
    const best = new Map<string, { teamId: string; playerId: string; score: number; accuracy: number }>();
    for (const attempt of mm.attempts) {
      const key = `${attempt.teamId}::${attempt.playerId}`;
      if ((best.get(key)?.score ?? -1) < attempt.score) best.set(key, attempt);
    }
    const total = (teamId: string) =>
      [...best.values()].filter((r) => r.teamId === teamId).reduce((sum, r) => sum + r.score, 0);
    const totalA = total(mm.match.teamAId);
    const totalB = total(mm.match.teamBId);
    const winner =
      !totalA || !totalB || totalA === totalB
        ? null
        : totalA > totalB
          ? mm.match.teamAId
          : mm.match.teamBId;

    for (const run of best.values()) {
      const record = records.get(run.playerId) ?? {
        maps: 0,
        mapsWon: 0,
        meanAcc: null,
        vsBest: null,
        runs: [],
        accs: [],
        diffs: [],
      };
      const won = winner == null ? null : winner === run.teamId;
      record.maps++;
      if (won) record.mapsWon++;
      record.accs.push(run.accuracy);
      const pb = cellsOf.get(run.playerId)?.get(mm.poolMap.leaderboardId);
      if (pb?.acc != null && !pb.isDnf) record.diffs.push(run.accuracy - pb.acc);
      record.runs.push({
        matchId: mm.match.id,
        matchName: mm.match.name,
        mapName: mm.poolMap.leaderboard.map.name,
        teamName: run.teamId === mm.match.teamAId ? mm.match.teamA.name : mm.match.teamB.name,
        accuracy: run.accuracy,
        score: run.score,
        won,
      });
      records.set(run.playerId, record);
    }
  }

  for (const record of records.values()) {
    record.meanAcc = mean(record.accs);
    record.vsBest = mean(record.diffs);
  }
  return records;
}
