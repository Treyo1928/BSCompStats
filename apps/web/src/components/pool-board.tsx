import { Avatar, DifficultyChip, MapCover, heat, pct, num, teamInk, teamWash } from './ui';
import type { PoolBoard, BoardCell, BoardMap } from '@/server/board';

/**
 * The pool board.
 *
 * Laid out the way the spreadsheet was, because that layout is genuinely good
 * for the job: team blocks down the side, maps across the top, a score and the
 * accuracy underneath it in each cell. What is new is everything a sheet could
 * not do - shading computed from the live field rather than typed in, a
 * prediction where a score is missing, abandoned runs called out instead of
 * sitting there as a number that drags an average down silently.
 */

export function PoolBoardTable({
  board,
  showPredictions = true,
}: {
  board: PoolBoard;
  showPredictions?: boolean;
}) {
  // Shade each column against its own range: comparing a 98% on an easy map
  // with a 91% on a hard one is exactly the mistake the colours should prevent.
  const columnRange = new Map<string, { min: number; max: number }>();
  for (const map of board.maps) {
    const accs = board.teams
      .flatMap((t) => t.rows)
      .map((r) => r.cells.find((c) => c.leaderboardId === map.leaderboardId))
      // An abandoned run is drawn in its own style, and would otherwise
      // stretch the scale until every real score on the map looked identical.
      .filter((c) => c != null && !c.isDnf)
      .map((c) => c?.acc)
      .filter((a): a is number => a != null);
    if (accs.length >= 2) {
      columnRange.set(map.leaderboardId, {
        min: Math.min(...accs),
        max: Math.max(...accs),
      });
    }
  }

  const allRows = board.teams.flatMap((t) => t.rows);
  const averages = allRows.map((r) => r.meanAcc).filter((a): a is number => a != null);
  const avgRange =
    averages.length >= 2 ? { min: Math.min(...averages), max: Math.max(...averages) } : undefined;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 w-44 bg-panel px-4 pb-3 pt-4 text-left align-bottom text-[10px] font-medium uppercase tracking-wider text-faint">
              Player
            </th>
            {board.maps.map((map) => (
              <MapHeader key={map.leaderboardId} map={map} />
            ))}
            <th className="px-4 pb-3 pt-4 text-right align-bottom text-[10px] font-medium uppercase tracking-wider text-faint">
              Average
            </th>
          </tr>
        </thead>

        {board.teams.map((team) => {
          const ink = teamInk(team.color, team.rows[0]?.teamColorSecondary);
          return (
            <tbody key={team.teamId ?? 'unassigned'}>
              <tr>
                <td
                  colSpan={board.maps.length + 2}
                  className="border-y border-edge p-0"
                  style={{
                    background: `linear-gradient(90deg, ${teamWash(team.color, 0.85)}, ${teamWash(team.color, 0.15)} 55%, transparent)`,
                  }}
                >
                  <div
                    className="sticky left-0 inline-flex items-center gap-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest"
                    style={{ color: ink, borderLeft: `3px solid ${team.color}` }}
                  >
                    {team.teamName}
                    <span className="font-normal normal-case tracking-normal text-faint">
                      {team.rows.length} players
                    </span>
                  </div>
                </td>
              </tr>

              {team.rows.map((row) => (
                <tr key={row.playerId} className="group">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-panel px-4 py-1 text-left font-medium group-hover:bg-raised"
                  >
                    <a
                      href={`https://beatleader.com/u/${row.beatLeaderId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-2.5 hover:underline"
                    >
                      <Avatar src={row.avatar} name={row.playerName} size={26} ring={team.color} />
                      <span
                        className={`truncate ${row.available ? '' : 'text-muted line-through decoration-faint'}`}
                        title={row.available ? undefined : 'Not available - left out of lineups and predictions'}
                      >
                        {row.playerName}
                      </span>
                    </a>
                  </th>

                  {row.cells.map((cell) => (
                    <Cell
                      key={cell.leaderboardId}
                      cell={cell}
                      range={columnRange.get(cell.leaderboardId)}
                      showPredictions={showPredictions}
                    />
                  ))}

                  <td className="px-4 py-1 text-right">
                    {row.meanAcc != null ? (
                      <span
                        className="inline-block rounded-md px-2 py-1 text-sm font-semibold tabular"
                        style={
                          avgRange && avgRange.max > avgRange.min
                            ? heat((row.meanAcc - avgRange.min) / (avgRange.max - avgRange.min))
                            : undefined
                        }
                        title={`${row.played} of ${board.maps.length} maps played`}
                      >
                        {pct(row.meanAcc)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}

        <tfoot>
          <tr>
            <th className="sticky left-0 z-10 border-t border-edge bg-panel px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-faint">
              Field average
            </th>
            {board.maps.map((map) => (
              <td
                key={map.leaderboardId}
                className="border-t border-edge px-1 py-2.5 text-center text-xs tabular text-muted"
              >
                {map.fieldMeanAcc != null ? pct(map.fieldMeanAcc, 1) : '—'}
              </td>
            ))}
            <td className="border-t border-edge" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function MapHeader({ map }: { map: BoardMap }) {
  return (
    <th className="px-1 pb-3 pt-4 align-bottom font-normal">
      <a
        href={`https://beatleader.com/leaderboard/global/${map.leaderboardId}`}
        target="_blank"
        rel="noreferrer noopener"
        className="group/map mx-auto flex w-[7.25rem] flex-col items-center gap-1.5 text-center"
        title={[map.name, map.mapper ? `mapped by ${map.mapper}` : null, `max ${num(map.maxScore)}`]
          .filter(Boolean)
          .join(' · ')}
      >
        <span className="relative">
          <MapCover
            src={map.coverImage}
            size={56}
            rounded="rounded-xl"
            className="shadow-lg shadow-black/50 transition group-hover/map:scale-105"
          />
          {map.isTiebreaker && (
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-warn px-1.5 text-[9px] font-bold leading-4 text-black">
              TB
            </span>
          )}
        </span>
        <span className="line-clamp-2 h-[1.875rem] text-xs font-medium leading-tight text-ink group-hover/map:underline">
          {map.name}
        </span>
        <DifficultyChip value={map.difficultyValue} label={map.difficultyLabel} />
        <span className="h-3 text-[9px] font-semibold uppercase tracking-widest text-accent">
          {map.category ?? ''}
        </span>
      </a>
    </th>
  );
}

function Cell({
  cell,
  range,
  showPredictions,
}: {
  cell: BoardCell;
  range?: { min: number; max: number };
  showPredictions: boolean;
}) {
  // No score: show what the model expects, clearly marked as an estimate so it
  // is never mistaken for something somebody actually played.
  if (cell.acc == null) {
    return (
      <td className="p-[3px] text-center align-middle">
        <div className="flex h-[42px] items-center justify-center rounded-md border border-dashed border-edge">
          {showPredictions ? (
            <span
              className="text-xs italic text-faint"
              title={`Predicted - nobody has recorded a score here. Confidence ${Math.round(cell.predictionConfidence * 100)}%.`}
            >
              ~{pct(cell.predictedAcc, 1)}
            </span>
          ) : (
            <span className="text-faint">—</span>
          )}
        </div>
      </td>
    );
  }

  const t =
    range && range.max > range.min ? (cell.acc - range.min) / (range.max - range.min) : 0.5;

  const inner = (
    <span className="relative flex h-[42px] flex-col items-center justify-center leading-tight">
      <span className="text-[13px] font-semibold tabular">{pct(cell.acc)}</span>
      <span className="text-[10px] tabular opacity-75">{num(cell.score ?? 0)}</span>
      {cell.rank === 1 && !cell.isDnf && (
        <span className="absolute right-1 top-0.5 text-[9px] opacity-80" aria-label="Best on this map">
          ★
        </span>
      )}
      {cell.fullCombo && (
        <span className="absolute left-1 top-0.5 text-[8px] font-bold tracking-wide opacity-70">
          FC
        </span>
      )}
    </span>
  );

  return (
    <td
      className="p-[3px] text-center align-middle"
      title={
        [
          cell.rank ? `#${cell.rank} in this pool` : null,
          cell.fullCombo ? 'Full combo' : cell.misses ? `${cell.misses} misses` : null,
          cell.isDnf
            ? 'Abandoned or anomalous run - far below this player’s normal and everyone else on this map. Not counted.'
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      }
    >
      <div
        className={`rounded-md transition hover:brightness-125 ${cell.isDnf ? 'cell-void' : ''}`}
        style={cell.isDnf ? undefined : heat(t)}
      >
        {cell.replayUrl ? (
          <a href={cell.replayUrl} target="_blank" rel="noreferrer noopener" className="block">
            {inner}
          </a>
        ) : (
          inner
        )}
      </div>
    </td>
  );
}
