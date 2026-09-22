'use client';

import { useState } from 'react';
import { Avatar, DifficultyChip, MapCover, heat, pct, num, teamInk, teamWash } from './ui';
import type { PoolBoard, BoardCell, BoardMap } from '@/server/board';
import { PlayerLink } from './player-card';

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

/** Above this many teams the board opens collapsed, so a big field is scannable. */
const COLLAPSE_ABOVE = 5;

export function PoolBoardTable({
  maps,
  teams,
  myTeamIds = [],
  showPredictions = true,
}: {
  // Only the plain data: the board's model holds functions, which cannot cross
  // into a client component.
  maps: PoolBoard['maps'];
  teams: PoolBoard['teams'];
  /** Teams the viewer is on; these stay open when the rest start collapsed. */
  myTeamIds?: string[];
  showPredictions?: boolean;
}) {
  const board = { maps, teams };
  const keyOf = (teamId: string | null) => teamId ?? 'unassigned';
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        teams.length > COLLAPSE_ABOVE
          ? teams.filter((t) => !t.teamId || !myTeamIds.includes(t.teamId)).map((t) => keyOf(t.teamId))
          : [],
      ),
  );
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

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
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm sm:min-w-[760px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 w-28 bg-panel px-2 pb-3 pt-4 text-left align-bottom text-[10px] font-medium uppercase tracking-wider text-faint sm:w-44 sm:px-4">
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
          const key = keyOf(team.teamId);
          const isCollapsed = collapsed.has(key);
          const teamAverages = team.rows.map((r) => r.meanAcc).filter((a): a is number => a != null);
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
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? `Show ${team.teamName}'s players` : `Hide ${team.teamName}'s players`}
                    className="sticky left-0 inline-flex items-center gap-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest"
                    style={{ color: ink, borderLeft: `3px solid ${team.color}` }}
                  >
                    <span
                      aria-hidden
                      className={`inline-block text-[9px] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    >
                      ▶
                    </span>
                    {team.teamName}
                    <span className="font-normal normal-case tracking-normal text-faint">
                      {team.rows.length} players
                      {isCollapsed && teamAverages.length > 0 &&
                        ` · team average ${pct(teamAverages.reduce((a, b) => a + b, 0) / teamAverages.length, 1)}`}
                    </span>
                  </button>
                </td>
              </tr>

              {!isCollapsed && team.rows.map((row) => (
                <tr key={row.playerId} className="group">
                  <th
                    scope="row"
                    // Narrow on a phone, with a hairline so scores sliding under it read as "more that way".
                    className="sticky left-0 z-10 max-w-28 border-r border-edge/70 bg-panel px-2 py-1 text-left font-medium group-hover:bg-raised sm:max-w-none sm:border-r-0 sm:px-4"
                  >
                    <PlayerLink
                      playerId={row.playerId}
                      name={row.playerName}
                      className="flex w-full items-center gap-1.5 hover:underline sm:gap-2.5"
                    >
                      <span className="hidden sm:inline-flex">
                        <Avatar src={row.avatar} name={row.playerName} size={26} ring={team.color} />
                      </span>
                      <span
                        className={`truncate ${row.available ? '' : 'text-muted line-through decoration-faint'}`}
                        title={row.available ? undefined : 'Not available - left out of lineups and predictions'}
                      >
                        {row.playerName}
                      </span>
                    </PlayerLink>
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
            <th className="sticky left-0 z-10 border-t border-edge bg-panel px-2 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-faint sm:px-4">
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
        className="group/map mx-auto flex w-[5.5rem] flex-col items-center gap-1.5 text-center sm:w-[7.25rem]"
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
          {map.category ?? map.autoCategory ?? ''}
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
  // Tried, never cleared, and no run hit ten notes: nothing of theirs to show,
  // so the prediction sits in the middle as on any unplayed map, and the
  // tries are a mark in the corner. A reviewer reads the number, not a hover.
  const triesOnly = cell.acc == null && cell.runs != null && cell.runs.fails + cell.runs.falseStarts > 0;
  const tries = triesOnly ? cell.runs!.fails + cell.runs!.falseStarts : 0;

  // No score: show what the model expects, clearly marked as an estimate so it
  // is never mistaken for something somebody actually played.
  if (cell.acc == null) {
    const triesNote = triesOnly
      ? ` They have tried it ${tries} ${tries === 1 ? 'time' : 'times'} without hitting ten notes: ${cell.runs!.fails} ${cell.runs!.fails === 1 ? 'fail' : 'fails'}, ${cell.runs!.falseStarts} ${cell.runs!.falseStarts === 1 ? 'false start' : 'false starts'}.`
      : '';
    return (
      <td className="p-[3px] text-center align-middle" title={triesOnly && !showPredictions ? triesNote.trim() : undefined}>
        <div className="relative flex h-[42px] items-center justify-center rounded-md border border-dashed border-edge">
          {triesOnly && (
            <span className="absolute left-1 top-0.5 text-[9px] font-bold text-red-300/90" aria-label={`${tries} tries, none hit ten notes`}>
              ✗{tries}
            </span>
          )}
          {showPredictions ? (
            cell.isEstimate ? (
              <span
                className="text-xs font-medium text-accent"
                title="Your own estimate, in place of the model's prediction. Only you see it, and it is used in the lineups and win chances you are shown."
              >
                ≈{pct(cell.predictedAcc, 1)}
              </span>
            ) : (
              <span
                className="text-xs italic text-faint"
                title={`Predicted - no score recorded here. Likely between ${pct(cell.predictedLow, 0)} and ${pct(cell.predictedHigh, 0)}; the fewer comparable maps they have played, the wider that is.${cell.cappedBy ? ' Held down by their real score on an easier map: they cannot be expected to do better here than that implies.' : ''}${triesNote} Someone who knows better can set their own estimate below the board.`}
              >
                ~{pct(cell.predictedAcc, 1)}
              </span>
            )
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
      <span className="text-[10px] tabular opacity-75">
        {cell.isRun ? `≈${num(cell.projectedScore ?? 0)}` : num(cell.score ?? 0)}
      </span>
      {cell.isRun && (
        <span className="absolute left-1 top-0.5 text-[9px] font-bold text-red-300" aria-label="Best run, never cleared">
          ✗
        </span>
      )}
      {cell.rank === 1 && !cell.isDnf && (
        <span className="absolute right-1 top-0.5 text-[9px] opacity-80" aria-label="Best on this map">
          ★
        </span>
      )}
      {cell.platform === 'SS' && (
        <span className="absolute bottom-0.5 right-1 text-[8px] font-bold tracking-wide opacity-70" aria-label="Set on ScoreSaber">
          SS
        </span>
      )}
      {cell.fullCombo && (
        <span className="absolute left-1 top-0.5 text-[8px] font-bold tracking-wide opacity-70">
          FC
        </span>
      )}
      {cell.runs && cell.runs.total > 1 && (
        <span
          className="absolute bottom-0.5 left-1 text-[8px] font-bold tracking-wide opacity-70"
          aria-label={`${cell.runs.total} runs recorded`}
        >
          ↻{cell.runs.total}
        </span>
      )}
    </span>
  );

  return (
    <td
      className="p-[3px] text-center align-middle"
      title={
        [
          cell.isRun && cell.runs?.bestTry
            ? `Never cleared. Their longest run was scoring ${pct(cell.runs.bestTry.acc)} over ${cell.runs.bestTry.notesHit} notes when it ended ${Math.round(cell.runs.bestTry.seconds)} s in (${Math.round(cell.runs.bestTry.progress * 100)}% of the song) - about ${num(cell.projectedScore ?? 0)} over the whole map. That is their score here, and what predictions rest on, until they clear it.`
            : null,
          cell.rank ? `#${cell.rank} in this pool` : null,
          cell.platform === 'SS' ? 'Set on ScoreSaber - their best here across both platforms' : null,
          cell.fullCombo ? 'Full combo' : cell.misses ? `${cell.misses} misses` : null,
          cell.isDnf
            ? 'Abandoned or anomalous run - far below this player’s normal and everyone else on this map. Not counted.'
            : null,
          cell.runs && cell.runs.total > 0
            ? `${cell.runs.total} ${cell.runs.total === 1 ? 'run' : 'runs'} recorded: ${cell.runs.finished} cleared, ${cell.runs.fails} failed` +
              (cell.runs.falseStarts ? `, ${cell.runs.falseStarts} false starts` : '')
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      }
    >
      <div
        className={`rounded-md transition hover:brightness-125 ${cell.isDnf ? 'cell-void' : ''} ${cell.isRun ? 'outline outline-1 outline-dashed outline-white/25' : ''}`}
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
