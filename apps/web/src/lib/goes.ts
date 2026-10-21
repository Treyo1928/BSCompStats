/** What a go at a map is called: the first run, then the replay(s). */
export function goName(attempt: number, goCount: number): string {
  if (attempt <= 1) return 'First run';
  return goCount === 2 ? 'Replay' : `Replay ${attempt - 1}`;
}
