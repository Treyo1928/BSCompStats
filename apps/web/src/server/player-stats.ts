import { prisma } from '@bscs/db';
import { categorizeMap } from '@bscs/core/beatleader';
import {
  compareOnSharedMaps,
  indexScores,
  rankByGap,
  sortKinds,
  buildPpProfile,
  buildSpecialty,
  canonicalKind,
  kindPp,
  meanShare,
  kindSpread,
  RATING_CAUTION,
  SCOPE_PRESETS,
  type CategoryLean,
  type Comparison,
  type PlayStyle,
  type PlayerProfile,
  type Specialty,
  type StatsScope,
} from '@bscs/core/stats';
import { parseFormat } from './match-helpers';
import { buildPoolBoard, loadBoardMembers, type BoardCell, type BoardMap } from './board';
import { buildTournamentModel, type TournamentModel } from './stats';
import { loadScores, parseSource, type ScoreSource } from './score-sources';

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
  /**
   * What to count on from them here: the real score, or - where there is none,
   * or only an abandoned run - the cautious end of the prediction. A map nobody
   * has seen them play must not beat a teammate's real score on a guess.
   */
  expected: number;
  /** False when `expected` is a prediction rather than something they scored. */
  proven: boolean;
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

/**
 * What a ranking is over: "overall", or one kind of map exactly as it is
 * named. The same keys, meaning the same maps, on every page that ranks.
 */
export type RankKey = string;
export const OVERALL: RankKey = 'overall';

/**
 * Ranks by BeatLeader's own pp for each corner of the skill triangle. They
 * answer a different question from the kinds of map: not "who did better on
 * the maps they share" but "who is better at this, over everything ranked they
 * have ever played". For players whose histories barely overlap - two coaches
 * with a thousand plays each, a handful of them in common - it is the only one
 * of the two that means anything.
 */
export const PP_KEYS = { 'Tech pp': 'techPp', 'Acc pp': 'accPp', 'Speed pp': 'passPp', 'ScoreSaber pp': 'ssPp' } as const;
export const isPpKey = (key: RankKey): key is keyof typeof PP_KEYS => key in PP_KEYS;

/**
 * Where a player stands, on like-for-like comparisons: against teammates and
 * against the whole field, over the maps both sides have actually played. The
 * ranks are ranks by exactly the gaps shown beside them.
 */
export interface Standing {
  vsTeam: Comparison;
  vsField: Comparison;
  /** Null when there is no shared map to judge by - unranked, not last. */
  teamRank: number | null;
  /** How many on the team could be ranked. */
  teamRanked: number;
  fieldRank: number | null;
  fieldRanked: number;
  /** Set for a pp rank: what that rank is a rank of. On one platform, its pp; on both, a 0..1 blend - see `ppParts`. */
  pp?: number;
  /** Each platform's own pp behind a pp rank, for showing. Absent where the player has none there. */
  ppParts?: { BL?: number; SS?: number };
}

/** The same, for one kind of map as the organiser (or the guess) named it. */
export interface KindStanding extends Standing {
  kind: string;
  /** Their own scores of this kind. */
  maps: number;
  /** Against what their general level predicts - the model's view, where there is one. */
  predicted: CategoryLean | null;
}

/** Which scores the stats are being looked at over. */
export type StatsView = 'pool' | 'ranked' | 'all';
/**
 * The wider views drop the presets' cap of 400 scores a player. The cap is
 * there to keep a model fit quick, and is applied newest-first *before* maps
 * nobody else has played are set aside - so for someone with 1,400 plays it
 * kept the latest 400 and then threw nearly all of them away, leaving 52. A
 * comparison wants the opposite: every score, because any of them might be on
 * a map a teammate has played.
 *
 * They drop the presets' one-year age limit for the same reason. Recency
 * matters to a model predicting tonight's score; it does not matter to "which
 * of these two did better on this map", where both figures are personal bests.
 * Strong players set most of their ranked scores years ago, and the limit hid
 * nine tenths of the ranked maps the coaches have in common.
 */
export const STATS_VIEWS: Record<StatsView, { label: string; scope: StatsScope }> = {
  pool: { label: 'Pool maps', scope: SCOPE_PRESETS.poolOnly! },
  ranked: { label: 'Ranked maps', scope: { ...SCOPE_PRESETS.rankedOnly!, maxScoresPerPlayer: null, maxAgeDays: null } },
  all: { label: 'All maps', scope: { ...SCOPE_PRESETS.fullHistory!, maxScoresPerPlayer: null, maxAgeDays: null } },
};

export interface PlayerStats {
  playerId: string;
  name: string;
  avatar: string | null;
  beatLeaderId: string;
  pp: number;
  rankedPlayCount: number;
  /** Whose account this player is, so their own page can offer them the link controls. */
  userId: string | null;
  scoreSaber: {
    id: string;
    pp: number;
    rank: number;
    countryRank: number;
    rankedPlayCount: number;
    avgRankedAcc: number;
    /** Scores of theirs stored from ScoreSaber, and how many of those are ranked there. */
    storedScores: number;
    storedRanked: number;
    synced: boolean;
  } | null;
  /** Scores of theirs held here, of any kind - so "52 compared" can be read against what there was to compare. */
  storedScores: number;
  /**
   * How many of their compared scores are on a map that has a kind at all. A
   * map has one only if an organiser tagged it or BeatLeader has rated it,
   * which it does for ranked maps alone - so for someone who mostly plays
   * unranked maps this is a small fraction, and their per-kind ranks are blank
   * for that reason rather than for want of scores.
   */
  kindedScores: number;
  comparedScores: number;
  globalRank: number;
  available: boolean;
  isSub: boolean;
  isCaptain: boolean;

  profile: PlayerProfile | null;
  /** Descriptive only: consistency, full combos, hands. Says nothing about what they are good at. */
  style: PlayStyle | null;
  /**
   * The kind of map they do best on, and worst. About the player, measured
   * against the whole field, so it reads the same whichever team they are
   * being looked at in - and two teammates can share one.
   */
  specialty: Specialty;

  /** Keyed by `TournamentStats.rankKeys`: overall, then each kind of map. */
  standings: Record<RankKey, Standing>;
  /** One per kind of map anyone in the field has played, this player's own kinds first. */
  kinds: KindStanding[];
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
  /** Who leads each kind of map: "Tech: Treyo · Speed: LS" */
  shape: string;
}

export interface TournamentStats {
  view: StatsView;
  /** Which platform's scores and pp everything here is worked out from. */
  source: ScoreSource;
  /** Scores from beyond the pools that are actually stored - zero means a wider view has nothing to show yet. */
  widerScores: number;
  keepsHistory: boolean;
  /** "overall", then every kind of map the field has a score on. */
  rankKeys: RankKey[];
  teams: TeamStats[];
  mapCount: number;
  fieldSize: number;
  playersPerMap: number;
  model: TournamentModel;
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export async function buildTournamentStats(
  tournamentId: string,
  wantedView?: string,
  wantedSource?: string,
): Promise<TournamentStats> {
  const source = parseSource(wantedSource);
  const [tournament, pools, members] = await Promise.all([
    prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { defaultFormat: true, statsScope: true },
    }),
    prisma.mapPool.findMany({
      where: { tournamentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),
    loadBoardMembers(tournamentId),
  ]);
  const playersPerMap = parseFormat(tournament?.defaultFormat).playersPerMap;

  // The pool unless asked otherwise. These pages are about the tournament's
  // maps first; what its predictions learn from is a separate setting.
  const stored = (tournament?.statsScope ?? {}) as { source?: string; keepHistory?: boolean };
  const view: StatsView = wantedView === 'ranked' || wantedView === 'all' ? wantedView : 'pool';
  // A pool-only tournament's own scope stands - its organiser may have tuned
  // it. Anything else is looked at through the preset for the view.
  const scope =
    view === 'pool' && (stored.source ?? 'POOL_ONLY') === 'POOL_ONLY' ? undefined : STATS_VIEWS[view].scope;

  const boards = (await Promise.all(pools.map((p) => buildPoolBoard(p.id, scope, source)))).filter((b) => b != null);
  const model = boards[0]?.model ?? (await buildTournamentModel(tournamentId, scope, source));

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

  const proven = (cell: BoardCell | undefined): cell is BoardCell & { acc: number } =>
    cell?.acc != null && !cell.isDnf;
  const logit = (v: number) => Math.log(v / (1 - v));

  // An abandoned run says nothing about what they would score next time, and
  // a map they have not played is taken at the low end of what the model
  // expects - the same caution the rating applies. The viewer's own estimate
  // is their call, and stands as entered.
  const expectedOf = (playerId: string, cell: BoardCell): number => {
    if (proven(cell)) return cell.acc;
    if (cell.isEstimate) return cell.predictedAcc;
    const prediction = model.model.predict(playerId, cell.leaderboardId);
    const acc = Math.min(1 - 1e-6, Math.max(1e-6, prediction.acc));
    return 1 / (1 + Math.exp(-(logit(acc) - RATING_CAUTION * prediction.sigmaLogit)));
  };

  // Standings: everyone against everyone, on the maps both have played.
  const index = indexScores(model.scores);
  const fieldIds = [...new Set(members.map((m) => m.player.id))];
  const kindOf = (leaderboardId: string) => model.categories[leaderboardId] ?? null;
  // Every ranked, unmodified score the field has, whatever anyone else has
  // played: a pp profile needs no overlap, which is the whole point of it.
  // Each platform in full, loaded apart. The merged set keeps one run a map - the better - which is right
  // for accuracy and wrong for pp: a map played better on ScoreSaber would vanish from BeatLeader's tally.
  const ranked = (
    await Promise.all(
      (['beatleader', 'scoresaber'] as const)
        .filter((platform) => source === 'both' || source === platform)
        .map((platform) => loadScores(fieldIds, { source: platform })),
    )
  )
    .flat()
    .filter((sc) => sc.pp > 0 && sc.leaderboard.ranked);
  /** A platform's pp only means anything next to the same platform's, so the two are kept apart throughout. */
  const ppByPlayer = new Map<string, Record<'BL' | 'SS', Array<{ kind: string | null; pp: number }>>>();
  for (const sc of ranked) {
    // An organiser's word for a map still wins over the guess from its ratings.
    const kind =
      model.categories[sc.leaderboardId] ??
      canonicalKind(
        categorizeMap({
          acc: sc.leaderboard.accRating,
          pass: sc.leaderboard.passRating,
          tech: sc.leaderboard.techRating,
        }),
      );
    const mine = ppByPlayer.get(sc.playerId) ?? { BL: [], SS: [] };
    mine[sc.platform].push({ kind, pp: sc.pp });
    ppByPlayer.set(sc.playerId, mine);
  }
  const PLATFORMS = ['BL', 'SS'] as const;
  const platformScores = (id: string, platform: 'BL' | 'SS') => ppByPlayer.get(id)?.[platform] ?? [];
  // A profile per platform, then averaged: each site gets one vote on where a player's pp comes from.
  const ppProfilesByPlatform = new Map(
    fieldIds.map((id) => [id, PLATFORMS.map((pl) => buildPpProfile(platformScores(id, pl))).filter((pr) => pr != null)]),
  );
  const ppProfiles = new Map(
    fieldIds.map((id) => {
      const profiles = ppProfilesByPlatform.get(id) ?? [];
      if (profiles.length === 0) return [id, null] as const;
      return [
        id,
        {
          scores: profiles.reduce((sum, pr) => sum + pr.scores, 0),
          share: meanShare(profiles),
          byKind: {},
        },
      ] as const;
    }),
  );
  const kindPps = new Map(
    fieldIds.map((id) => [id, { BL: kindPp(platformScores(id, 'BL')), SS: kindPp(platformScores(id, 'SS')) }]),
  );
  const fieldShare = meanShare([...ppProfiles.values()].filter((profile) => profile != null));

  /**
   * In the wider views, what a player is ranked by: their pp overall, or the
   * pp they have earned on one kind of map. Accuracy on shared maps stays the
   * measure for the pool, which everyone plays; across whole histories it only
   * says who is more accurate, and needs an overlap that often is not there.
   */
  /** One platform's pp for a player: overall, or earned on one kind of map. */
  const platformPp = (id: string, key: RankKey, platform: 'BL' | 'SS'): number =>
    key === OVERALL
      ? ((platform === 'BL' ? ppOf.get(id)?.pp : ppOf.get(id)?.ssPp) ?? 0)
      : (kindPps.get(id)?.[platform][key] ?? 0);
  const wanted: ReadonlyArray<'BL' | 'SS'> = source === 'both' ? PLATFORMS : source === 'beatleader' ? ['BL'] : ['SS'];
  // The best anyone in the field has on each platform - what makes the two comparable enough to combine.
  const ceilings = new Map<string, number>();
  const ceiling = (key: RankKey, platform: 'BL' | 'SS') => {
    const cacheKey = `${platform}:${key}`;
    if (!ceilings.has(cacheKey)) ceilings.set(cacheKey, Math.max(0, ...fieldIds.map((id) => platformPp(id, key, platform))));
    return ceilings.get(cacheKey)!;
  };
  /**
   * What the rank is a rank of. On one platform, that platform's pp. On both,
   * each platform's pp as a fraction of the best in the field there, averaged
   * over the platforms the player is actually on - so the two count equally,
   * and someone who is only on one is judged on that one rather than marked
   * down for the other.
   */
  const ppValue = (id: string, key: RankKey): number => {
    const parts = wanted
      .filter((platform) => platformPp(id, key, platform) > 0 && ceiling(key, platform) > 0)
      .map((platform) => platformPp(id, key, platform) / ceiling(key, platform));
    if (parts.length === 0) return 0;
    const value = parts.reduce((a, b) => a + b, 0) / parts.length;
    return wanted.length === 1 ? platformPp(id, key, wanted[0]!) : value;
  };
  const ppRanks = (ids: readonly string[], key: RankKey) =>
    rankByGap(new Map(ids.map((id) => [id, ppValue(id, key) > 0 ? ppValue(id, key) : null])));

  // The pool's kinds are the ones its maps carry. The wider views add every kind anyone has earned pp on.
  const allKinds = sortKinds([
    ...model.scores.map((sc) => kindOf(sc.leaderboardId)).filter((k): k is string => !!k),
    ...(view === 'pool' ? [] : [...kindPps.values()].flatMap((byKind) => [...Object.keys(byKind.BL), ...Object.keys(byKind.SS)])),
  ]);
  // BeatLeader's triangle corners and ScoreSaber's pp are each one platform's figure, offered only where that platform is in view.
  const rankKeys: RankKey[] = [
    OVERALL,
    ...allKinds,
    ...Object.keys(PP_KEYS).filter((key) =>
      key === 'ScoreSaber pp' ? source !== 'beatleader' : source !== 'scoresaber',
    ),
  ];
  const byPp = view !== 'pool';
  const filterFor = (key: RankKey): ((leaderboardId: string) => boolean) | undefined =>
    key === OVERALL ? undefined : (id) => kindOf(id) === key;

  /** Against the field, for every player, for one key - computed once and ranked. */
  const fieldBoards = new Map<string, { of: Map<string, Comparison>; ranks: Map<string, number | null> }>();
  const fieldBoard = (key: RankKey) => {
    const cacheKey = key;
    let board = fieldBoards.get(cacheKey);
    if (!board) {
      const include = filterFor(key);
      const of = new Map(fieldIds.map((id) => [id, compareOnSharedMaps(index, id, fieldIds, include)]));
      board = { of, ranks: rankByGap(new Map([...of].map(([id, c]) => [id, c.gap]))) };
      fieldBoards.set(cacheKey, board);
    }
    return board;
  };
  const countRanked = (ranks: Map<string, number | null>) => [...ranks.values()].filter((r) => r != null).length;

  const NOTHING: Comparison = { gap: null, comparisons: 0, maps: 0 };
  const ppOf = new Map(members.map((m) => [m.player.id, m.player]));

  /** Rank a set of players by one corner's pp. Someone with none is unranked, not last. */
  const ppBoard = (ids: readonly string[], key: keyof typeof PP_KEYS) => {
    const value = (id: string) => ppOf.get(id)?.[PP_KEYS[key]] ?? 0;
    // rankByGap ranks by "bigger is better", which pp is.
    const ranks = rankByGap(new Map(ids.map((id) => [id, value(id) > 0 ? value(id) : null])));
    return { value, ranks };
  };
  const ssCounts = new Map<string, { all: number; ranked: number }>();
  for (const row of await prisma.scoreSaberScore.groupBy({
    by: ['playerId', 'ranked'],
    where: { playerId: { in: fieldIds } },
    _count: true,
  })) {
    const entry = ssCounts.get(row.playerId) ?? { all: 0, ranked: 0 };
    entry.all += row._count;
    if (row.ranked) entry.ranked += row._count;
    ssCounts.set(row.playerId, entry);
  }
  const storedCounts = new Map(
    (
      await prisma.score.groupBy({ by: ['playerId'], where: { playerId: { in: fieldIds } }, _count: true })
    ).map((row) => [row.playerId, row._count]),
  );

  // How far each kind of map spreads the field - the unit a specialty is measured in.
  const spreads = new Map<string, number | null>();
  const spreadOf = (kind: string): number | null => {
    if (!spreads.has(kind)) spreads.set(kind, kindSpread([...fieldBoard(kind).of.values()].map((c) => c.gap)));
    return spreads.get(kind) ?? null;
  };

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
    const rosterIds = roster.map((m) => m.player.id);
    const teamBoards = new Map<string, { of: Map<string, Comparison>; ranks: Map<string, number | null> }>();
    const teamBoard = (key: RankKey) => {
      const cacheKey = key;
      let board = teamBoards.get(cacheKey);
      if (!board) {
        const include = filterFor(key);
        const of = new Map(rosterIds.map((id) => [id, compareOnSharedMaps(index, id, rosterIds, include)]));
        board = { of, ranks: rankByGap(new Map([...of].map(([id, c]) => [id, c.gap]))) };
        teamBoards.set(cacheKey, board);
      }
      return board;
    };
    const standingFor = (id: string, key: RankKey): Standing => {
      if (isPpKey(key)) {
        const team = ppBoard(rosterIds, key);
        const field = ppBoard(fieldIds, key);
        return {
          vsTeam: NOTHING,
          vsField: NOTHING,
          teamRank: team.ranks.get(id) ?? null,
          teamRanked: countRanked(team.ranks),
          fieldRank: field.ranks.get(id) ?? null,
          fieldRanked: countRanked(field.ranks),
          pp: team.value(id),
        };
      }
      if (byPp) {
        const team = ppRanks(rosterIds, key);
        const field = ppRanks(fieldIds, key);
        return {
          // The like-for-like gaps are still worked out and shown beside the pp; they no longer decide the rank.
          vsTeam: teamBoard(key).of.get(id)!,
          vsField: fieldBoard(key).of.get(id)!,
          teamRank: team.get(id) ?? null,
          teamRanked: countRanked(team),
          fieldRank: field.get(id) ?? null,
          fieldRanked: countRanked(field),
          pp: ppValue(id, key),
          ppParts: Object.fromEntries(
            wanted.filter((platform) => platformPp(id, key, platform) > 0).map((platform) => [platform, platformPp(id, key, platform)]),
          ),
        };
      }
      const team = teamBoard(key);
      const field = fieldBoard(key);
      return {
        vsTeam: team.of.get(id)!,
        vsField: field.of.get(id)!,
        teamRank: team.ranks.get(id) ?? null,
        teamRanked: countRanked(team.ranks),
        fieldRank: field.ranks.get(id) ?? null,
        fieldRanked: countRanked(field.ranks),
      };
    };

    const players: PlayerStats[] = roster.map((member) => {
      const id = member.player.id;
      const profile = model.profiles[id] ?? null;
      const teammates = roster.filter((m) => m.player.id !== id);

      const lines: PlayerMapLine[] = columns.flatMap(({ map, poolId, poolName }) => {
        const cell = cellsOf.get(id)?.get(map.leaderboardId);
        if (!cell) return [];
        const expected = expectedOf(id, cell);
        const others = teammates.flatMap((m) => {
          const theirs = cellsOf.get(m.player.id)?.get(map.leaderboardId);
          return theirs ? [expectedOf(m.player.id, theirs)] : [];
        });
        const teamRank = 1 + others.filter((v) => v > expected).length;
        const othersMean = mean(others);
        return [
          {
            map,
            poolId,
            poolName,
            cell,
            expected,
            proven: proven(cell),
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

      const style = model.styles[id] ?? null;
      const ownKinds = new Map<string, number>();
      for (const leaderboardId of index.get(id)?.keys() ?? []) {
        const kind = kindOf(leaderboardId);
        if (kind) ownKinds.set(kind, (ownKinds.get(kind) ?? 0) + 1);
      }
      const kinds: KindStanding[] = allKinds
        .map((kind) => ({
          kind,
          maps: ownKinds.get(kind) ?? 0,
          predicted: style?.categories.find((c) => c.category === kind) ?? null,
          ...standingFor(id, kind),
        }))
        // In the same order as everywhere else, with what they have never played after.
        .sort((a, b) => Number(b.maps > 0) - Number(a.maps > 0));

      return {
        playerId: id,
        name: member.player.name,
        avatar: member.player.avatar,
        beatLeaderId: member.player.beatLeaderId,
        pp: member.player.pp,
        rankedPlayCount: member.player.rankedPlayCount,
        userId: member.player.userId,
        scoreSaber: member.player.scoreSaberId
          ? {
              id: member.player.scoreSaberId,
              pp: member.player.ssPp,
              rank: member.player.ssRank,
              countryRank: member.player.ssCountryRank,
              rankedPlayCount: member.player.ssRankedPlayCount,
              avgRankedAcc: member.player.ssAvgRankedAcc,
              storedScores: ssCounts.get(id)?.all ?? 0,
              storedRanked: ssCounts.get(id)?.ranked ?? 0,
              synced: member.player.ssSyncedAt != null,
            }
          : null,
        storedScores: storedCounts.get(id) ?? 0,
        kindedScores: [...ownKinds.values()].reduce((a, b) => a + b, 0),
        comparedScores: index.get(id)?.size ?? 0,
        globalRank: member.player.rank,
        available: member.available,
        isSub: member.isSub,
        isCaptain: member.role === 'CAPTAIN',
        profile,
        style,
        specialty: buildSpecialty({
          kinds: kinds.map((k) => ({
            kind: k.kind,
            gap: k.vsField.gap,
            spread: spreadOf(k.kind),
            maps: k.maps,
            comparisons: k.vsField.comparisons,
          })),
          scoreCount: profile?.scoreCount ?? 0,
          // Their whole ranked history, where there is enough of it - the shared maps are the fallback.
          pp: ppProfiles.get(id) ?? null,
          fieldShare,
        }),
        standings: Object.fromEntries(rankKeys.map((key) => [key, standingFor(id, key)])),
        kinds,
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

    // Who the team turns to for each kind of map - a line that credits people rather than grading them.
    const leaders = allKinds.flatMap((kind) => {
      const leader = players.find((p) => {
        const standing = p.kinds.find((k) => k.kind === kind);
        return standing?.teamRank === 1 && standing.teamRanked >= 2;
      });
      return leader ? [`${kind}: ${leader.name}`] : [];
    });

    return {
      teamId,
      name: team.name,
      color: team.color,
      colorSecondary: team.colorSecondary,
      adHoc: team.adHoc,
      players,
      meanAcc: mean(players.map((p) => p.profile?.meanAcc).filter((v): v is number => v != null && v > 0)),
      shape: leaders.join(' · '),
    };
  });

  const widerScores =
    view === 'pool' && !stored.keepHistory
      ? 0
      : await prisma.score.count({
          where: { playerId: { in: fieldIds }, leaderboard: { poolMaps: { none: { pool: { tournamentId } } } } },
        });

  return {
    view,
    source,
    widerScores,
    keepsHistory: stored.keepHistory === true || (stored.source != null && stored.source !== 'POOL_ONLY'),
    rankKeys,
    teams,
    mapCount: columns.length,
    fieldSize: fieldIds.filter((id) => index.has(id)).length,
    playersPerMap,
    model,
  };
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
