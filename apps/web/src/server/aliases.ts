import { prisma } from '@bscs/db';
import { parseShowcaseReplays, type ShowcaseReplay } from '@bscs/core';

/**
 * How players appear in one tournament: an organiser's nickname and picture
 * where one was set, else what BeatLeader says. Also the replays they chose
 * to show on stream. See the TournamentPlayer table.
 */
export interface PlayerAlias {
  nickname: string | null;
  avatar: string | null;
  replays: ShowcaseReplay[];
  /** Their saber colours ("#rrggbb"), or null for the game's own. */
  sabers: { left: string; right: string } | null;
}

export type Aliases = Map<string, PlayerAlias>;

export async function tournamentAliases(tournamentId: string): Promise<Aliases> {
  const rows = await prisma.tournamentPlayer.findMany({
    where: { tournamentId },
    select: { playerId: true, nickname: true, avatar: true, replays: true, saberLeft: true, saberRight: true },
  });
  return new Map(
    rows.map((r) => [
      r.playerId,
      {
        nickname: r.nickname,
        avatar: r.avatar,
        replays: parseShowcaseReplays(r.replays),
        sabers: r.saberLeft && r.saberRight ? { left: r.saberLeft, right: r.saberRight } : null,
      },
    ]),
  );
}

/** A player's name and picture as this tournament shows them. */
export function shownAs<P extends { id: string; name: string; avatar: string | null }>(player: P, aliases: Aliases): P {
  const alias = aliases.get(player.id);
  if (!alias?.nickname && !alias?.avatar) return player;
  return { ...player, name: alias.nickname || player.name, avatar: alias.avatar || player.avatar };
}
