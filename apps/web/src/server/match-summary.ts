/**
 * Maps won by each side, from a match's recorded runs - the same counting the
 * match page and `completeMatch` use: each player's best run on a map, summed
 * per team; the tiebreaker only counts when the other maps finish level.
 */
export function tallyMaps(
  maps: ReadonlyArray<{
    isTiebreaker: boolean;
    attempts: ReadonlyArray<{ teamId: string; playerId: string; score: number }>;
  }>,
  teamAId: string,
  teamBId: string,
): { a: number; b: number } {
  const totalFor = (attempts: (typeof maps)[number]['attempts'], teamId: string) => {
    const best = new Map<string, number>();
    for (const attempt of attempts) {
      if (attempt.teamId !== teamId) continue;
      best.set(attempt.playerId, Math.max(best.get(attempt.playerId) ?? 0, attempt.score));
    }
    return [...best.values()].reduce((sum, score) => sum + score, 0);
  };

  let a = 0;
  let b = 0;
  const count = (map: (typeof maps)[number]) => {
    const totalA = totalFor(map.attempts, teamAId);
    const totalB = totalFor(map.attempts, teamBId);
    if (!totalA && !totalB) return;
    if (totalA > totalB) a++;
    else if (totalB > totalA) b++;
  };

  maps.filter((m) => !m.isTiebreaker).forEach(count);
  if (a === b) maps.filter((m) => m.isTiebreaker).forEach(count);
  return { a, b };
}
