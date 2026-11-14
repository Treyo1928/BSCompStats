/**
 * Saber colours come from the team: its first colour is the left saber, its second the right.
 *
 * What an organiser chose is used exactly as chosen, however alike the two are: that is their call (the Teams page
 * tells them when two sabers will be hard to tell apart). Only a second colour that nobody chose is replaced: the
 * one every new team is given, which is a pale tint of the first or a stock lilac and would make two sabers that
 * look the same. The right saber then gets a colour of its own, clearly different from the left.
 *
 * Colours are "#rrggbb".
 */
export interface SaberPair {
  left: string;
  right: string;
}

const HEX = /^#([0-9a-f]{6})$/i;

function rgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** CIELAB, so that "how different" means how different it looks, not how far apart the numbers are. */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** How different two colours look (CIELAB distance; about 2 is the smallest step an eye sees, 100 is black to white). */
export function colourDistance(a: string, b: string): number {
  const A = rgb(a), B = rgb(b);
  if (!A || !B) return 0;
  const [l1, a1, b1] = lab(A), [l2, a2, b2] = lab(B);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Closer than this and two sabers are hard to tell apart at speed (a colour and its own pale tint are about 25). */
export const SABERS_TOO_ALIKE = 40;

export const tooAlike = (a: string, b: string) => colourDistance(a, b) < SABERS_TOO_ALIKE;

/**
 * A second colour for a team that has only one to speak of: clearly not the first. Opposite hue, kept vivid; for a
 * grey (no hue to oppose) white or a mid grey, whichever is further away.
 */
export function contrastingColour(first: string): string {
  const c = rgb(first);
  if (!c) return '#ffffff';
  const [h, s, l] = hsl(c);
  // a grey has no hue to oppose: whichever of a few plain, bright colours is furthest from it
  const furthest = (options: string[]) => options.reduce((best, o) => (colourDistance(first, o) > colourDistance(first, best) ? o : best));
  if (s < 0.2) return furthest(['#f5f5f5', '#ffd23f', '#4db8ff', '#ff5a6e']);
  for (const turn of [180, 150, 210, 120, 240]) {
    const other = fromHsl(h + turn, Math.max(0.65, s), l > 0.62 ? 0.42 : 0.6);
    if (!tooAlike(first, other)) return other;
  }
  return furthest(['#f5f5f5', '#ffd23f', '#4db8ff', '#ff5a6e', '#1f2937']);
}

/**
 * The second colours teams are given when they are made, never picked by anyone: the stock one for a new team or
 * the player pool whatever its first colour, and the pale tint that goes with each colour the duo maker hands out.
 * Kept here so that "was this chosen?" can be answered without another column: a team still on one of these has
 * not had its second colour chosen.
 */
const STOCK_SECOND = new Set(['#a5b4fc', '#d1d5db']);
const STOCK_PAIRS = new Set(
  [
    ['#ff4d5e', '#ffb3ba'], ['#3d9bff', '#b3d7ff'], ['#2ecc71', '#a9ebc4'], ['#f5a623', '#fbd79a'],
    ['#a26bfa', '#d6c2fd'], ['#1abc9c', '#a3e4d7'], ['#ff7ac6', '#ffc9e8'], ['#e0e04a', '#f3f3b5'],
  ].map(([a, b]) => `${a} ${b}`),
);
/** Whether a team's second colour is one somebody picked (and not what the team was made with). */
export function secondColourChosen(first: string, second: string | null | undefined): boolean {
  if (!second || !rgb(second)) return false;
  const a = first.trim().toLowerCase(), b = second.trim().toLowerCase();
  return !STOCK_SECOND.has(b) && !STOCK_PAIRS.has(`${a} ${b}`);
}

/**
 * The two sabers a team's players are shown with: the team's own two colours. `adjusted`: the right one is not the
 * team's second colour, because nobody has chosen one yet.
 */
export function teamSabers(first: string, second: string | null | undefined): SaberPair & { adjusted: boolean } {
  const left = rgb(first) ? first.trim().toLowerCase() : '#ff4d5e';
  if (secondColourChosen(first, second)) return { left, right: second!.trim().toLowerCase(), adjusted: false };
  return { left, right: contrastingColour(left), adjusted: true };
}
