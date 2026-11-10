/**
 * Everyone in one list for the "By average" order. Players are grouped by how
 * many of the pool's maps they have played, most first, and ranked by average
 * inside each group: an average over three maps says less than one over seven,
 * and skipping a hard map must not lift anyone above those who played it.
 * Places run on through the groups; players with nothing played have none.
 */
export function rankTiers<R extends { playerName: string; meanAcc: number | null; played: number }>(
  rows: readonly R[],
  mapCount: number,
): Array<{ played: number; label: string; rows: Array<{ row: R; place: number | null }> }> {
  const byPlayed = new Map<number, R[]>();
  for (const row of rows) {
    const played = row.meanAcc == null ? 0 : row.played;
    byPlayed.set(played, [...(byPlayed.get(played) ?? []), row]);
  }
  let place = 0;
  return [...byPlayed.entries()]
    .sort(([a], [b]) => b - a)
    .map(([played, group]) => ({
      played,
      label:
        played === 0
          ? 'No maps played'
          : played >= mapCount
            ? `Played all ${mapCount} maps`
            : `Played ${played} of ${mapCount} maps`,
      rows: [...group]
        .sort((a, b) => (b.meanAcc ?? -1) - (a.meanAcc ?? -1) || a.playerName.localeCompare(b.playerName))
        .map((row) => ({ row, place: played === 0 ? null : ++place })),
    }));
}
