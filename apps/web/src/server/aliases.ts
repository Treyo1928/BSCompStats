import { prisma } from '@bscs/db';
import { parseShowcaseReplays, type ShowcaseReplay } from '@bscs/core';

/**
 * How players appear in one tournament: an organiser's nickname and picture
 * where one was set, else what BeatLeader says. Also their saber colours and
 * the replays to show on stream: the tournament's own for them where it has
 * any (the TournamentPlayer table), else the ones on the player's own profile
 * (the Player table).
 */
export interface PlayerAlias {
  nickname: string | null;
  avatar: string | null;
  /** The replays that are shown: the tournament's where it has any, else their profile's. */
  replays: ShowcaseReplay[];
  /** Their saber colours ("#rrggbb"), or null for the game's own: the tournament's, else their profile's. */
  sabers: { left: string; right: string } | null;
  /** Where each of the two comes from: set for this tournament, taken from their profile, or not set at all. */
  replaysFrom: 'tournament' | 'profile' | null;
  sabersFrom: 'tournament' | 'profile' | null;
  /** What their own profile has, whatever the tournament shows. */
  profile: { replays: ShowcaseReplay[]; sabers: { left: string; right: string } | null };
  /** The tournament's replays are locked (stream day): `replays` is what was kept then, not what the profile has now. */
  locked: boolean;
}

export type Aliases = Map<string, PlayerAlias>;

const pair = (left: string | null, right: string | null) => (left && right ? { left, right } : null);

export async function tournamentAliases(tournamentId: string): Promise<Aliases> {
  const [rows, players, tournament] = await Promise.all([
    prisma.tournamentPlayer.findMany({
      where: { tournamentId },
      select: { playerId: true, nickname: true, avatar: true, replays: true, lockedReplays: true, saberLeft: true, saberRight: true },
    }),
    // everyone on one of its teams (the player pool and one-match sides included) who has set something of their own
    prisma.player.findMany({
      where: {
        teamMembers: { some: { team: { division: { tournamentId } } } },
        OR: [{ saberLeft: { not: null } }, { NOT: { replays: { equals: [] } } }],
      },
      select: { id: true, replays: true, saberLeft: true, saberRight: true },
    }),
    prisma.tournament.findUnique({ where: { id: tournamentId }, select: { replaysLockedAt: true } }),
  ]);
  const locked = !!tournament?.replaysLockedAt;
  const profiles = new Map(players.map((p) => [p.id, { replays: parseShowcaseReplays(p.replays), sabers: pair(p.saberLeft, p.saberRight) }]));
  const set = new Map(rows.map((r) => [r.playerId, r]));
  const out: Aliases = new Map();
  for (const playerId of new Set([...set.keys(), ...profiles.keys()])) {
    const row = set.get(playerId);
    const profile = profiles.get(playerId) ?? { replays: [], sabers: null };
    const ownReplays = parseShowcaseReplays(row?.replays);
    const ownSabers = pair(row?.saberLeft ?? null, row?.saberRight ?? null);
    out.set(playerId, {
      nickname: row?.nickname ?? null,
      avatar: row?.avatar ?? null,
      // Locked: what was kept for them when the lock went on. Someone with nothing kept (they joined a team
      // afterwards) shows only what the tournament itself has for them: their profile can still change.
      replays: locked ? (row?.lockedReplays != null ? parseShowcaseReplays(row.lockedReplays) : ownReplays) : ownReplays.length ? ownReplays : profile.replays,
      sabers: ownSabers ?? profile.sabers,
      replaysFrom: ownReplays.length ? 'tournament' : profile.replays.length ? 'profile' : null,
      sabersFrom: ownSabers ? 'tournament' : profile.sabers ? 'profile' : null,
      profile,
      locked,
    });
  }
  return out;
}

/** A player's name and picture as this tournament shows them. */
export function shownAs<P extends { id: string; name: string; avatar: string | null }>(player: P, aliases: Aliases): P {
  const alias = aliases.get(player.id);
  if (!alias?.nickname && !alias?.avatar) return player;
  return { ...player, name: alias.nickname || player.name, avatar: alias.avatar || player.avatar };
}
