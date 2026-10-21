import type { MatchView } from '@/server/matches';
import { Badge, DifficultyChip, MapCover, pct, teamInk } from './ui';

type Team = MatchView['teamA'];
type Planned = MatchView['plannedMaps'][number];

/**
 * The whole match on one screen: every map in play order with who picked it,
 * who played it for each side, what each of them scored, how the map went,
 * and any replays - with the bans above. Read-only; the detailed view is where
 * lineups are set and scores pulled.
 *
 * `visible` is the teams whose lineups this viewer may see (hidden lineups).
 */
export function MatchSummaryTable({
  match,
  visible,
  detailHref,
}: {
  match: MatchView;
  visible: ReadonlySet<string>;
  /** The detailed view, to which each map links. */
  detailHref: string;
}) {
  const points = match.scoring.mode === 'MATCH_POINTS';
  const teams = [match.teamA, match.teamB] as const;
  const bans = match.actions.filter((a) => a.type === 'BAN');

  const figure = (planned: Planned, teamId: string) => {
    const team = planned.result.teams[teamId];
    if (!team) return null;
    return points && team.points != null ? team.points.toFixed(2) : pct(team.accEquivalent);
  };

  const players = (planned: Planned, team: Team) => {
    if (!visible.has(team.id)) {
      return <span className="text-xs text-faint">Hidden until both teams have set every map</span>;
    }
    const lineup = planned.lineups[team.id] ?? [];
    if (lineup.length === 0) return <span className="text-xs text-faint">Lineup not set</span>;
    const scores = planned.scores[team.id] ?? [];
    return (
      <ul className="max-w-[16rem] space-y-0.5">
        {lineup.map((playerId) => {
          const name = team.players.find((p) => p.id === playerId)?.name ?? 'Player';
          const s = scores.find((x) => x.playerId === playerId);
          return (
            <li key={playerId} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate" title={name}>
                {name}
              </span>
              <span className="shrink-0 tabular text-muted">
                {s ? (
                  <>
                    {s.points != null && <span className="mr-1.5 font-semibold text-ink">{s.points.toFixed(2)}</span>}
                    {pct(s.accuracy)}
                    {s.failed && (
                      <span
                        className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-300"
                        title={
                          match.scoring.doubleFails
                            ? 'Failed: No Fail halved it, so it counts doubled'
                            : 'Failed: No Fail kicked in; it counts as scored'
                        }
                      >
                        {match.scoring.doubleFails ? 'NF ×2' : 'NF'}
                      </span>
                    )}
                    {s.attempt > 1 && (
                      <span className="ml-1 rounded bg-edge px-1 text-[10px] font-semibold text-muted" title="Counted from a replay">
                        R{s.attempt - 1}
                      </span>
                    )}
                    {s.endType && s.endType !== 'CLEAR' && (
                      <span className="ml-1 text-lose" title={`Run ${s.endType.toLowerCase()}`}>
                        ✗
                      </span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </span>
            </li>
          );
        })}
      </ul>
    );
  };

  const teamHead = (team: Team) => (
    <span className="font-semibold" style={{ color: teamInk(team.color, team.colorSecondary) }}>
      {team.name}
    </span>
  );

  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-panel">
      {bans.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-4 py-2 text-xs">
          <span className="font-medium uppercase tracking-wider text-faint">Bans</span>
          {bans.map((ban) => {
            const team = ban.teamId === match.teamA.id ? match.teamA : match.teamB;
            return (
              <span key={ban.seq} className="inline-flex items-center gap-1.5">
                <span style={{ color: teamInk(team.color, team.colorSecondary) }}>{ban.teamName}</span>
                <span className="text-red-300">✕</span>
                <span className="text-muted line-through">{ban.mapName}</span>
              </span>
            );
          })}
        </div>
      )}

      {match.plannedMaps.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No maps yet: they appear here as they are picked.</p>
      ) : (
        <>
        {/* Phones: a block per map rather than a table to scroll sideways. */}
        <ul className="divide-y divide-edge md:hidden">
          {match.plannedMaps.map((planned) => {
            const picker = teams.find((t) => t.id === planned.pickedByTeamId) ?? null;
            const winner = teams.find((t) => t.id === planned.result.winnerId) ?? null;
            return (
              <li key={planned.poolMapId} className="space-y-2 px-3 py-3">
                <div className="flex items-center gap-2.5">
                  <MapCover src={planned.map.coverImage} size={36} />
                  <a href={`${detailHref}#map-${planned.poolMapId}`} className="min-w-0 flex-1 hover:underline">
                    <span
                      className={`block text-[10px] font-semibold uppercase tracking-wider ${planned.isTiebreaker ? 'text-amber-300' : 'text-muted'}`}
                    >
                      {planned.isTiebreaker ? 'Tiebreaker' : `Map ${planned.order}`}
                      {picker && (
                        <>
                          {' · '}
                          <span style={{ color: teamInk(picker.color, picker.colorSecondary) }}>{picker.name}</span>
                          {' pick'}
                        </>
                      )}
                    </span>
                    <span className="block truncate text-sm font-medium">{planned.map.name}</span>
                  </a>
                  <span className="shrink-0 text-right text-sm tabular">
                    {planned.result.decided ? (
                      teams.map((team, i) => (
                        <span key={team.id}>
                          {i === 1 && <span className="mx-1 text-xs text-faint">–</span>}
                          <span
                            className={winner?.id === team.id ? 'font-semibold' : 'text-muted'}
                            style={winner?.id === team.id ? { color: teamInk(team.color, team.colorSecondary) } : undefined}
                          >
                            {figure(planned, team.id) ?? '—'}
                          </span>
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-faint">Not played</span>
                    )}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {teams.map((team) => (
                    <div key={team.id} className="min-w-0 border-l-2 pl-2" style={{ borderColor: team.color }}>
                      {players(planned, team)}
                    </div>
                  ))}
                </div>
                {(planned.replayCalledByTeamIds.length > 0 || winner) && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {winner && (
                      <span className="font-semibold" style={{ color: teamInk(winner.color, winner.colorSecondary) }}>
                        {winner.name} take it
                        {planned.result.catchUp != null && (
                          <span className="ml-1 font-normal text-faint">by {pct(planned.result.catchUp)}</span>
                        )}
                      </span>
                    )}
                    {planned.replayCalledByTeamIds.map((id, i) => (
                      <Badge key={i} tone="warn">
                        Replay: {id === match.teamA.id ? match.teamA.name : match.teamB.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-edge bg-surface/50 text-left text-[10px] font-medium uppercase tracking-wider text-faint">
                <th className="px-3 py-2 font-medium">Map</th>
                <th className="w-[22%] px-3 py-2 font-medium">{teamHead(match.teamA)}</th>
                <th className="px-3 py-2 text-center font-medium">{points ? 'Points' : 'Accuracy'}</th>
                <th className="w-[22%] px-3 py-2 font-medium">{teamHead(match.teamB)}</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {match.plannedMaps.map((planned) => {
                const picker = teams.find((t) => t.id === planned.pickedByTeamId) ?? null;
                const winner = teams.find((t) => t.id === planned.result.winnerId) ?? null;
                const loser = winner ? teams.find((t) => t.id !== winner.id)! : null;
                return (
                  <tr key={planned.poolMapId} className="align-top">
                    <td className="px-3 py-2.5">
                      <a
                        href={`${detailHref}#map-${planned.poolMapId}`}
                        className="flex min-w-0 items-center gap-2.5 hover:underline"
                        title="Open this map in the detailed view"
                      >
                        <MapCover src={planned.map.coverImage} size={40} />
                        <span className="min-w-0">
                          <span
                            className={`block text-[10px] font-semibold uppercase tracking-wider ${planned.isTiebreaker ? 'text-amber-300' : 'text-muted'}`}
                          >
                            {planned.isTiebreaker ? 'Tiebreaker' : `Map ${planned.order}`}
                            {picker && (
                              <>
                                {' · '}
                                <span style={{ color: teamInk(picker.color, picker.colorSecondary) }}>{picker.name}</span>
                                {' pick'}
                              </>
                            )}
                          </span>
                          <span className="block max-w-[16rem] truncate font-medium">{planned.map.name}</span>
                          <DifficultyChip value={planned.map.difficultyValue} label={planned.map.difficultyLabel} />
                        </span>
                      </a>
                    </td>
                    <td className="px-3 py-2.5">{players(planned, match.teamA)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center tabular">
                      {planned.result.decided ? (
                        <>
                          {teams.map((team, i) => (
                            <span key={team.id}>
                              {i === 1 && <span className="mx-1.5 text-xs text-faint">–</span>}
                              <span
                                className={winner?.id === team.id ? 'font-semibold' : 'text-muted'}
                                style={winner?.id === team.id ? { color: teamInk(team.color, team.colorSecondary) } : undefined}
                              >
                                {figure(planned, team.id) ?? '—'}
                              </span>
                            </span>
                          ))}
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">{players(planned, match.teamB)}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <div className="flex flex-col items-start gap-1">
                        {planned.result.decided ? (
                          winner ? (
                            <span className="font-semibold" style={{ color: teamInk(winner.color, winner.colorSecondary) }}>
                              {winner.name}
                              {loser && planned.result.catchUp != null && (
                                <span
                                  className="ml-1 font-normal text-faint"
                                  title={`Each player on ${loser.name} would have needed about ${pct(planned.result.catchUp)} more accuracy to take this map.`}
                                >
                                  by {pct(planned.result.catchUp)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted">Level</span>
                          )
                        ) : (
                          <span className="text-faint">Not played yet</span>
                        )}
                        {planned.replayCalledByTeamIds.map((id, i) => (
                          <Badge key={i} tone="warn">
                            Replay: {id === match.teamA.id ? match.teamA.name : match.teamB.name}
                          </Badge>
                        ))}
                        {planned.scoresClosed && <Badge tone="win">Closed</Badge>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-edge bg-surface/50 text-xs">
                <td className="px-3 py-2 font-medium uppercase tracking-wider text-faint">Maps won</td>
                <td className="px-3 py-2">{teamHead(match.teamA)}</td>
                <td className="px-3 py-2 text-center text-base font-bold tabular">
                  {match.scoreboard.a}
                  <span className="mx-1.5 text-xs font-medium text-faint">–</span>
                  {match.scoreboard.b}
                </td>
                <td className="px-3 py-2">{teamHead(match.teamB)}</td>
                <td className="px-3 py-2 text-muted">
                  {match.state === 'COMPLETE'
                    ? match.winnerId
                      ? `${(teams.find((t) => t.id === match.winnerId) ?? match.teamA).name} won`
                      : 'Draw'
                    : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        </>
      )}
    </section>
  );
}
