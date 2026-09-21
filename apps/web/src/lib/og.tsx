import type { ReactNode } from 'react';

/**
 * Shared look for link-preview images (Discord, Slack, iMessage...).
 *
 * Rendered by next/og, which lays out with Satori rather than a browser: every
 * element with more than one child must be `display: flex`, and only a subset
 * of CSS exists. Hence inline styles and no Tailwind.
 */

export const OG_SIZE = { width: 1200, height: 630 };

export const OG_COLORS = {
  surface: '#0a0c13',
  panel: '#12151f',
  raised: '#191d2b',
  edge: '#2a3147',
  ink: '#eceef6',
  muted: '#9aa3bd',
  accent: '#8b7bff',
  win: '#4ade80',
  saberLeft: '#ff4d5e',
  saberRight: '#3d9bff',
};

/** A team colour that reads on the dark card: dark ones are lifted toward white. */
export function readable(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return OG_COLORS.ink;
  const n = parseInt(m[1]!, 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = rgb
    .map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  if (lum >= 0.25) return `#${m[1]}`;
  const lifted = rgb.map((v) => Math.round(v + (255 - v) * 0.55));
  return `rgb(${lifted[0]}, ${lifted[1]}, ${lifted[2]})`;
}

/**
 * Fetch a remote image as a data URI, or null.
 *
 * Satori fetches <img> sources itself and fails the whole image if one is slow,
 * missing, or a format it cannot decode (WebP, GIF - which avatars often are).
 * A preview without a cover is better than no preview, so images are fetched
 * here, briefly, and simply left out when they do not work.
 */
export async function loadImage(url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (type !== 'image/png' && type !== 'image/jpeg') return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 1_500_000) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function Sabers({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="6" fill={OG_COLORS.raised} />
      <path d="M7 17 17 7" stroke={OG_COLORS.saberLeft} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M7 7l10 10" stroke={OG_COLORS.saberRight} strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/** The card every preview shares: brand row, a coloured band, then the page's own content. */
export function OgFrame({
  eyebrow,
  bandColors,
  children,
}: {
  /** Small line beside the logo - usually the tournament's name. */
  eyebrow?: string;
  /** Team colours, drawn as a band across the top. */
  bandColors?: string[];
  children: ReactNode;
}) {
  const band = bandColors?.length ? bandColors : [OG_COLORS.accent];
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: OG_COLORS.surface,
        backgroundImage: `radial-gradient(900px 420px at 12% -10%, rgba(139,123,255,0.22), transparent 60%), radial-gradient(800px 380px at 100% -10%, rgba(56,189,248,0.14), transparent 60%)`,
        color: OG_COLORS.ink,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', height: 12 }}>
        {band.map((color, i) => (
          <div key={i} style={{ flex: 1, backgroundColor: color }} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', padding: '36px 56px 0', fontSize: 28 }}>
        <Sabers size={44} />
        <div style={{ display: 'flex', marginLeft: 16, fontWeight: 700 }}>BSCompStats</div>
        {eyebrow ? (
          <div style={{ display: 'flex', marginLeft: 16, color: OG_COLORS.muted }}>· {eyebrow}</div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '24px 56px 44px' }}>
        {children}
      </div>
    </div>
  );
}

/** A labelled number, for the row of facts along the bottom of a card. */
export function OgStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginRight: 48 }}>
      <div style={{ display: 'flex', fontSize: 44, fontWeight: 700 }}>{value}</div>
      <div style={{ display: 'flex', fontSize: 22, color: OG_COLORS.muted }}>{label}</div>
    </div>
  );
}
