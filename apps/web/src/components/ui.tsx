import type { CSSProperties, ReactNode } from 'react';

/** Shared primitives. The data is the interface; these just stay out of its way. */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding - for tables and media that run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section
      className={`overflow-hidden rounded-xl border border-edge bg-panel/90 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset,0_12px_32px_-16px_rgb(0_0_0/0.6)] ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/** Breadcrumb, title, meta line and actions - the top of every page. */
export function PageHeader({
  crumbs = [],
  title,
  meta,
  actions,
  media,
}: {
  crumbs?: Array<{ label: string; href: string }>;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  media?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {media}
        <div className="min-w-0">
          {crumbs.length > 0 && (
            <nav className="mb-1 flex items-center gap-1.5 text-xs text-muted">
              {crumbs.map((c, i) => (
                <span key={c.href} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-faint">/</span>}
                  <a href={c.href} className="hover:text-ink">
                    {c.label}
                  </a>
                </span>
              ))}
            </nav>
          )}
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {meta && <p className="mt-1 text-sm text-muted">{meta}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'win' | 'lose' | 'warn' | 'accent';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-edge/70 text-muted ring-white/5',
    win: 'bg-green-500/12 text-green-300 ring-green-400/20',
    lose: 'bg-red-500/12 text-red-300 ring-red-400/20',
    warn: 'bg-amber-500/12 text-amber-300 ring-amber-400/20',
    accent: 'bg-accent/15 text-violet-200 ring-accent/25',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const variants: Record<string, string> = {
    primary:
      'bg-accent text-white shadow-[0_6px_16px_-8px_var(--color-accent)] hover:brightness-110',
    ghost: 'border border-edge bg-raised/60 text-ink hover:border-faint hover:bg-raised',
    danger: 'bg-red-600/80 text-white hover:bg-red-600',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-edge bg-surface/80 px-3 py-1.5 text-sm outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20';

// ---------------------------------------------------------------------------
//  Media
// ---------------------------------------------------------------------------

/**
 * A map's cover art.
 *
 * The image sits over a gradient tile with an empty alt, so a cover that is
 * missing or fails to load leaves a tidy placeholder rather than a broken-image
 * icon - without needing a client component for an onError handler.
 */
export function MapCover({
  src,
  size = 40,
  className = '',
  rounded = 'rounded-lg',
}: {
  src: string | null | undefined;
  size?: number;
  className?: string;
  rounded?: string;
}) {
  return (
    <span
      className={`relative inline-block shrink-0 overflow-hidden bg-gradient-to-br from-raised to-edge ring-1 ring-white/10 ${rounded} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        className="absolute inset-0 m-auto h-1/2 w-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <path d="M9 18V6l10-2v12" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="16" r="2.5" />
      </svg>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

export function Avatar({
  src,
  name,
  size = 24,
  ring,
}: {
  src: string | null | undefined;
  name: string;
  size?: number;
  /** Ring colour - normally the player's team. */
  ring?: string;
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised font-semibold uppercase text-muted"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.42),
        boxShadow: ring ? `0 0 0 1.5px ${ring}` : '0 0 0 1px rgb(255 255 255 / 0.10)',
      }}
      title={name}
    >
      {name.slice(0, 1)}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

export function AvatarStack({
  people,
  size = 24,
  ring,
  max = 6,
}: {
  people: Array<{ id: string; name: string; avatar: string | null }>;
  size?: number;
  ring?: string;
  max?: number;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <span key={p.id} style={{ marginLeft: i === 0 ? 0 : -size * 0.28 }}>
          <Avatar src={p.avatar} name={p.name} size={size} ring={ring} />
        </span>
      ))}
      {extra > 0 && <span className="ml-1.5 text-xs text-muted">+{extra}</span>}
    </span>
  );
}

/** A strip of covers - a pool at a glance. */
export function CoverStrip({
  covers,
  size = 36,
  max = 7,
}: {
  covers: Array<string | null>;
  size?: number;
  max?: number;
}) {
  const shown = covers.slice(0, max);
  const extra = covers.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((src, i) => (
        <span key={i} style={{ marginLeft: i === 0 ? 0 : -size * 0.22 }}>
          <MapCover src={src} size={size} className="shadow-md shadow-black/40" />
        </span>
      ))}
      {extra > 0 && <span className="ml-2 text-xs text-muted">+{extra}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
//  Beat Saber vocabulary
// ---------------------------------------------------------------------------

/** The colours every Beat Saber player already reads difficulties in. */
const DIFFICULTY_COLORS: Record<number, string> = {
  1: '#3cb371', // Easy
  3: '#59b0f4', // Normal
  5: '#ff7a59', // Hard
  7: '#e5484d', // Expert
  9: '#a66bff', // Expert+
};

export function difficultyColor(value: number): string {
  return DIFFICULTY_COLORS[value] ?? '#8f98b3';
}

export function DifficultyChip({ value, label }: { value: number; label: string }) {
  const color = difficultyColor(value);
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold leading-4"
      style={{ background: `${color}22`, color }}
      title={label}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * A team colour that can be read as text on a dark page. MSU's maroon is
 * #8B1A3A, which is a fine swatch and an illegible heading; when the primary
 * is that dark, use the secondary, or failing that a lightened primary.
 */
export function teamInk(color: string, secondary?: string | null): string {
  if (luminance(color) >= 0.2) return color;
  if (secondary && luminance(secondary) >= 0.2) return secondary;
  return mixWithWhite(color, 0.5);
}

/**
 * A team colour as a background wash. A dark colour needs a strong wash to show
 * at all; a near-white one at the same strength turns the panel grey.
 */
export function teamWash(color: string, strength = 1): string {
  const rgb = parseHex(color);
  if (!rgb) return 'transparent';
  const alpha = (0.4 - 0.27 * Math.min(1, luminance(color) / 0.7)) * strength;
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha.toFixed(3)})`;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mixWithWhite(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((v) => Math.round(v + (255 - v) * amount));
  return `rgb(${r} ${g} ${b})`;
}

/** A thin horizontal meter, 0..1. */
export function Meter({
  value,
  color = 'var(--color-accent)',
  className = '',
}: {
  value: number;
  color?: string;
  className?: string;
}) {
  const width = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
  return (
    <span className={`block h-1 overflow-hidden rounded-full bg-edge ${className}`}>
      <span className="block h-full rounded-full" style={{ width, background: color }} />
    </span>
  );
}

/** Red through amber to green, tuned to sit on the dark panel. */
export function heat(t: number): CSSProperties {
  const clamped = Math.min(1, Math.max(0, t));
  // Ease toward the ends so the middle of a tight column does not all look amber.
  const hue = clamped < 0.5 ? 4 + clamped * 2 * 40 : 44 + (clamped - 0.5) * 2 * 96;
  return {
    background: `hsl(${hue} 52% 17%)`,
    color: `hsl(${hue} 85% 84%)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 30% / 0.55)`,
  };
}

/** Win chance as a colour: red below even, green above. */
export function chanceColor(p: number): string {
  if (p >= 0.6) return 'var(--color-win)';
  if (p <= 0.4) return 'var(--color-lose)';
  return 'var(--color-warn)';
}

export function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-raised/50 px-3 py-2" title={hint}>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

/** Formats accuracy the way the spreadsheets did: two decimals and a percent. */
export function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function num(value: number): string {
  return value.toLocaleString('en-US');
}
