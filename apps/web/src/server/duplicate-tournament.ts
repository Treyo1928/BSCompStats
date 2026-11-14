'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma, Prisma } from '@bscs/db';
import { assertCan } from '@bscs/core/match';
import { getActor } from './session';

/**
 * A copy of a tournament to practise on: the same teams, players (with the names, pictures, saber colours and
 * replays set for them here), map pools, settings, staff and brackets, under a new name and address.
 *
 * What is NOT copied, on purpose:
 *   - matches and their results: the copy starts with nothing played, and its brackets are empty of results;
 *   - the TournamentAssistant link (two tournaments on one TA tournament would fight over it) and API keys;
 *   - visibility: the copy is always private, so nobody mistakes a rehearsal for the event.
 * Scores on the pool maps belong to the players, not the tournament, so the copy's pool boards fill in by themselves.
 *
 * For whoever may manage the tournament being copied. The copy is theirs: they become its owner.
 */
export async function duplicateTournament(formData: FormData): Promise<void> {
  const sourceId = String(formData.get('tournamentId'));
  const actor = await getActor(sourceId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const source = await prisma.tournament.findUnique({
    where: { id: sourceId },
    include: {
      divisions: { include: { teams: { where: { adHoc: false }, include: { members: true } } } },
      pools: { include: { maps: true } },
      members: true,
      players: true,
      uploads: { select: { id: true, mime: true, bytes: true } },
      brackets: { include: { entries: true, nodes: true } },
    },
  });
  if (!source) throw new Error('No such tournament.');

  const name = (String(formData.get('name') ?? '').trim() || `${source.name} (test copy)`).slice(0, 120);
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tournament';
  let slug = base;
  for (let suffix = 2; await prisma.tournament.findUnique({ where: { slug }, select: { id: true } }); suffix++) slug = `${base}-${suffix}`;

  const copy = await prisma.$transaction(
    async (tx) => {
      const made = await tx.tournament.create({
        data: {
          name,
          slug,
          description: source.description,
          isPublic: false,
          unlisted: false,
          ownerId: actor.userId,
          captainsEnterScores: source.captainsEnterScores,
          captainsPullScores: source.captainsPullScores,
          captainsCreateMatches: source.captainsCreateMatches,
          matchScoring: source.matchScoring,
          scoringLocked: source.scoringLocked,
          perfectFromBeatLeader: source.perfectFromBeatLeader,
          replayCounting: source.replayCounting,
          doubleFailedRuns: source.doubleFailedRuns,
          taModeDefault: source.taModeDefault,
        },
        select: { id: true, slug: true },
      });

      // Every id that something else points at gets its new one here; settings kept as JSON may name pools too.
      const ids = new Map<string, string>();

      // pictures first: team logos and player pictures point at them by address
      for (const up of source.uploads) {
        const row = await tx.upload.create({ data: { tournamentId: made.id, mime: up.mime, bytes: up.bytes }, select: { id: true } });
        ids.set(up.id, row.id);
      }
      const picture = (path: string | null) => {
        const old = path?.match(/^\/api\/img\/([^/?#]+)/)?.[1];
        return old && ids.has(old) ? `/api/img/${ids.get(old)}` : path;
      };

      for (const pool of source.pools) {
        const row = await tx.mapPool.create({
          data: {
            tournamentId: made.id,
            name: pool.name,
            sourceType: pool.sourceType,
            sourceRef: pool.sourceRef,
            scoresSince: pool.scoresSince,
            scoresUntil: pool.scoresUntil,
            pickBanSequence: pool.pickBanSequence ?? Prisma.JsonNull,
          },
          select: { id: true },
        });
        ids.set(pool.id, row.id);
        for (const map of pool.maps) {
          const m = await tx.poolMap.create({
            data: {
              poolId: row.id,
              leaderboardId: map.leaderboardId,
              order: map.order,
              category: map.category,
              label: map.label,
              isTiebreaker: map.isTiebreaker,
              perfectAcc: map.perfectAcc,
            },
            select: { id: true },
          });
          ids.set(map.id, m.id);
        }
      }

      for (const division of source.divisions) {
        const d = await tx.division.create({ data: { tournamentId: made.id, name: division.name, order: division.order }, select: { id: true } });
        ids.set(division.id, d.id);
        for (const team of division.teams) {
          const t = await tx.team.create({
            data: {
              divisionId: d.id,
              name: team.name,
              color: team.color,
              colorSecondary: team.colorSecondary,
              logo: picture(team.logo),
              playerPool: team.playerPool,
              members: {
                create: team.members.map((m) => ({ playerId: m.playerId, role: m.role, order: m.order, isSub: m.isSub, available: m.available })),
              },
            },
            select: { id: true },
          });
          ids.set(team.id, t.id);
        }
      }

      if (source.players.length) {
        await tx.tournamentPlayer.createMany({
          data: source.players.map((p) => ({
            tournamentId: made.id,
            playerId: p.playerId,
            nickname: p.nickname,
            avatar: picture(p.avatar),
            replays: p.replays ?? [],
            saberLeft: p.saberLeft,
            saberRight: p.saberRight,
          })),
        });
      }

      // Staff, captains and viewers keep their part; whoever makes the copy owns it.
      const staff = source.members.filter((m) => m.userId !== actor.userId);
      await tx.tournamentMember.createMany({
        data: [
          { tournamentId: made.id, userId: actor.userId, role: 'OWNER' as const, teamId: null },
          ...staff.map((m) => ({
            tournamentId: made.id,
            userId: m.userId,
            role: m.role === 'OWNER' ? ('ORGANIZER' as const) : m.role,
            // a captain of a team put together for one match has no team in the copy
            teamId: m.teamId ? (ids.get(m.teamId) ?? null) : null,
          })),
        ],
      });

      // Brackets as they were drawn, with nothing played in them.
      for (const bracket of source.brackets) {
        const entries = bracket.entries.filter((e) => ids.has(e.teamId));
        if (entries.length !== bracket.entries.length) continue;      // seeded with a one-match side: nothing sensible to copy
        await tx.bracket.create({
          data: {
            tournamentId: made.id,
            name: bracket.name,
            format: bracket.format,
            order: bracket.order,
            poolId: bracket.poolId ? (ids.get(bracket.poolId) ?? null) : null,
            entries: { create: entries.map((e) => ({ teamId: ids.get(e.teamId)!, seed: e.seed })) },
            nodes: {
              create: bracket.nodes.map((n) => ({
                key: n.key,
                section: n.section,
                round: n.round,
                position: n.position,
                sources: n.sources ?? Prisma.JsonNull,
                poolId: n.poolId ? (ids.get(n.poolId) ?? null) : null,
              })),
            },
          },
        });
      }

      // Settings kept as JSON, with any pool, map or team they name pointed at the copy's.
      const renamed = (value: unknown): unknown =>
        typeof value === 'string'
          ? (ids.get(value) ?? value)
          : Array.isArray(value)
            ? value.map(renamed)
            : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, renamed(v)]))
              : value;
      const json = (value: unknown) => (value == null ? Prisma.JsonNull : (renamed(value) as Prisma.InputJsonValue));
      await tx.tournament.update({
        where: { id: made.id },
        data: {
          defaultFormat: json(source.defaultFormat),
          statsScope: json(source.statsScope),
          pointsCurve: json(source.pointsCurve),
          scorePull: json(source.scorePull),
        },
      });
      return made;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  revalidatePath('/', 'layout');
  redirect(`/t/${copy.slug}/teams`);
}
