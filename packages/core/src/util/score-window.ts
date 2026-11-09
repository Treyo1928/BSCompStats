/**
 * A pool's "count scores from ... to ..." dates. Organisers pick whole days;
 * the days are read in one fixed time zone (the league's, US Central), so the
 * window is the same moments for everyone, whatever their browser says.
 */
export const SCORE_WINDOW_ZONE = 'America/Chicago';

/** Unix seconds; either end may be open. Both ends are inclusive. */
export interface ScoreWindow {
  from: number | null;
  until: number | null;
}

/** Set outside the window. A time not known (0) is kept. */
export function outsideWindow(window: ScoreWindow | undefined, timeset: number): boolean {
  if (!window || !(timeset > 0)) return false;
  return (window.from != null && timeset < window.from) || (window.until != null && timeset > window.until);
}

/** Where a map is in more than one pool: only what every window allows. */
export function narrowWindows(a: ScoreWindow, b: ScoreWindow): ScoreWindow {
  const pick = (x: number | null, y: number | null, f: (p: number, q: number) => number) =>
    x == null ? y : y == null ? x : f(x, y);
  return { from: pick(a.from, b.from, Math.max), until: pick(a.until, b.until, Math.min) };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The zone's offset from UTC at this moment, in ms (Central: -6h or -5h). */
function offsetAt(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** 12:00 AM on this day ("YYYY-MM-DD") in the zone, as a Date. Null for anything that is not a real day. */
export function startOfDay(day: string, zone = SCORE_WINDOW_ZONE): Date | null {
  const m = DAY.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const utc = Date.UTC(y, mo, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  // Midnight is never inside a US daylight-saving jump (those happen at 2 AM), so two passes settle it.
  let at = utc - offsetAt(utc, zone);
  at = utc - offsetAt(at, zone);
  return new Date(at);
}

/** 11:59:59.999 PM on this day in the zone: the instant before the next day starts. */
export function endOfDay(day: string, zone = SCORE_WINDOW_ZONE): Date | null {
  if (!startOfDay(day, zone)) return null;
  const [y, m, d] = day.trim().split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return new Date(startOfDay(next, zone)!.getTime() - 1);
}

/** The day ("YYYY-MM-DD") this moment falls on in the zone. */
export function dayIn(at: Date, zone = SCORE_WINDOW_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const n = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${n('year')}-${n('month')}-${n('day')}`;
}
