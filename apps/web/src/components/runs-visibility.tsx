import { prisma } from '@bscs/db';
import { Avatar, Panel } from './ui';
import { PlayerLink } from './player-card';

/**
 * Who shows their runs on BeatLeader. The leaderboard keeps a best clear per
 * map; the fails, restarts and quits behind it are served only for players
 * with "Show my stats publicly" on. This is the one place to see who does,
 * so a captain knows whose bad maps the board can and cannot see.
 */
export async function RunsVisibilityPanel({ tournamentId }: { tournamentId: string }) {
  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId }, adHoc: false } },
    select: {
      team: { select: { id: true, name: true } },
      player: { select: { id: true, name: true, avatar: true, attemptsPublic: true, attemptsSyncedAt: true } },
    },
    orderBy: [{ team: { name: 'asc' } }, { player: { name: 'asc' } }],
  });
  if (members.length === 0) return null;
  const seen = new Set<string>();
  const players = members.filter((m) => !seen.has(m.player.id) && seen.add(m.player.id));
  const groups: Array<{ key: boolean | null; title: string; note: string }> = [
    { key: true, title: 'Runs public', note: 'every fail, restart and quit on the pool maps is on the board, and match scores can be pulled for them' },
    { key: false, title: 'Runs private', note: 'only their clears are known; a map they have tried and never finished looks unplayed' },
    { key: null, title: 'Not asked yet', note: 'the worker asks within a few minutes of a player joining a roster' },
  ];
  return (
    <section id="runs" className="scroll-mt-20">
      <Panel
        title="Recorded runs on BeatLeader"
        subtitle="Who shows the runs behind their scores - which is also whose match scores can be pulled straight from BeatLeader. It is a switch in each player's own BeatLeader profile settings: Show my stats publicly."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {groups.map((g) => {
            const list = players.filter((m) => m.player.attemptsPublic === g.key);
            return (
              <div key={String(g.key)}>
                <p className="text-[10px] font-medium uppercase tracking-wider text-faint">
                  {g.title} <span className="text-muted">· {list.length}</span>
                </p>
                <p className="mt-0.5 text-xs text-faint">{g.note}</p>
                {list.length === 0 ? (
                  <p className="mt-2 text-xs text-faint">nobody</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {list.map((m) => (
                      <li key={m.player.id}>
                        <PlayerLink
                          playerId={m.player.id}
                          name={m.player.name}
                          className="inline-flex items-center gap-2 text-sm hover:underline"
                        >
                          <Avatar src={m.player.avatar} name={m.player.name} size={20} />
                          <span>{m.player.name}</span>
                          <span className="text-xs text-faint">{m.team.name}</span>
                        </PlayerLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-faint">
          Signing in here does not unlock anyone&apos;s runs: BeatLeader answers that request from its own
          session only. Once a player flips the switch, the next score pull sees it at once, and the board
          catches up within two hours.
        </p>
      </Panel>
    </section>
  );
}
