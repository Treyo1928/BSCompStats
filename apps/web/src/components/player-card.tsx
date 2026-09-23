'use client';

import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getPlayerOverview, type PlayerOverview } from '@/server/player-overview';
import { Avatar, teamInk } from './ui';

/**
 * The player card: tap anyone, anywhere in a tournament, and get who they are,
 * their team, and their BeatLeader and ScoreSaber profiles.
 *
 * One dialog per tournament layout, opened through context, so a board with
 * forty names on it mounts forty buttons and not forty dialogs.
 */
const OpenPlayer = createContext<((playerId: string) => void) | null>(null);

export function PlayerCardProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [overview, setOverview] = useState<PlayerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  const open = useCallback((id: string) => {
    setOverview(null);
    setError(null);
    setPlayerId(id);
  }, []);
  const close = useCallback(() => setPlayerId(null), []);

  useEffect(() => {
    if (playerId && !dialog.current?.open) dialog.current?.showModal();
    if (!playerId && dialog.current?.open) dialog.current.close();
  }, [playerId]);

  // Following one of the card's own links is a navigation; the card has done its job.
  useEffect(() => setPlayerId(null), [pathname]);

  useEffect(() => {
    if (!playerId) return;
    let stale = false;
    getPlayerOverview(slug, playerId)
      .then((result) => {
        if (stale) return;
        if (result.overview) setOverview(result.overview);
        else setError(result.error ?? 'Could not load this player.');
      })
      .catch(() => !stale && setError('The server could not be reached. Check your connection and try again.'));
    return () => {
      stale = true;
    };
  }, [slug, playerId]);

  const action =
    'flex h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition';
  const ghost = `${action} border-edge bg-raised/60 text-ink hover:border-faint hover:bg-raised`;

  return (
    <OpenPlayer.Provider value={open}>
      {children}
      <dialog
        ref={dialog}
        onClose={close}
        // A click that lands on the dialog itself, not its content, is the backdrop.
        onClick={(e) => e.target === e.currentTarget && close()}
        className="m-auto w-[min(26rem,calc(100vw-1.5rem))] rounded-2xl border border-edge bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {playerId && (
          <div className="p-4">
            <div className="flex items-start gap-3">
              <Avatar
                src={overview?.avatar}
                name={overview?.name ?? '…'}
                size={56}
                ring={overview?.teams[0]?.color}
              />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-lg font-semibold tracking-tight">
                  {overview?.name ?? (error ? 'Player' : 'Loading…')}
                </h3>
                {overview && (
                  <>
                    <p className="truncate text-sm">
                      {overview.teams.length === 0 ? (
                        <span className="text-muted">Not on a team here yet</span>
                      ) : (
                        overview.teams.map((t, i) => (
                          <span key={t.teamId}>
                            {i > 0 && <span className="text-faint"> · </span>}
                            <span style={{ color: teamInk(t.color, t.colorSecondary) }}>{t.name}</span>
                            {t.isCaptain && <span className="ml-1 text-xs text-accent">★</span>}
                          </span>
                        ))
                      )}
                    </p>
                    {overview.country && <p className="mt-0.5 truncate text-xs text-faint">{overview.country}</p>}
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-muted transition hover:bg-raised hover:text-ink"
              >
                ✕
              </button>
            </div>

            {error && <p className="mt-4 rounded-lg bg-raised/60 px-3 py-2 text-sm text-warn">{error}</p>}

            {!overview && !error && (
              <div className="mt-4 space-y-2" aria-hidden>
                <div className="h-16 animate-pulse rounded-lg bg-raised/60" />
                <div className="h-11 animate-pulse rounded-lg bg-raised/60" />
              </div>
            )}

            {overview && (
              <>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-center">
                  <Figure
                    label="BeatLeader"
                    value={overview.pp > 0 ? `${Math.round(overview.pp).toLocaleString('en-US')}pp` : '—'}
                    note={overview.globalRank > 0 ? `#${overview.globalRank.toLocaleString('en-US')} global` : 'unranked'}
                  />
                  <Figure
                    label="ScoreSaber"
                    value={overview.ssPp > 0 ? `${Math.round(overview.ssPp).toLocaleString('en-US')}pp` : '—'}
                    note={overview.scoreSaberId ? (overview.ssRank > 0 ? `#${overview.ssRank.toLocaleString('en-US')} global` : 'unranked') : 'not linked'}
                  />
                </dl>
                <p className={`mt-3 text-xs ${overview.runsPublic === false ? 'text-warn' : 'text-muted'}`}>
                  {overview.runsPublic === true
                    ? 'Shows their runs on BeatLeader, so match scores can be pulled for them.'
                    : overview.runsPublic === false
                      ? 'Keeps their BeatLeader stats private: only a new personal best can be pulled. They can turn on "Show my stats publicly" in their BeatLeader settings.'
                      : 'Not yet known whether BeatLeader shows their runs.'}
                </p>

                <div className="mt-4 space-y-2">
                  {/* Both platforms, side by side: neither is the player's "real" profile. */}
                  <div className={`grid gap-2 ${overview.scoreSaberId ? 'grid-cols-2' : ''}`}>
                    <a
                      href={`https://beatleader.com/u/${overview.beatLeaderId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={ghost}
                    >
                      BeatLeader ↗
                    </a>
                    {overview.scoreSaberId && (
                      <a
                        href={`https://scoresaber.com/u/${overview.scoreSaberId}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={ghost}
                      >
                        ScoreSaber ↗
                      </a>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </dialog>
    </OpenPlayer.Provider>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised/50 px-1 py-2">
      <dt className="text-[9px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-base font-semibold tabular">{value}</dd>
      <dd className="text-[10px] tabular text-faint">{note}</dd>
    </div>
  );
}

/**
 * Anything that names a player. Opens their card; outside a tournament, where
 * there is no card to open, it is just its contents.
 */
export function PlayerLink({
  playerId,
  name,
  className = '',
  children,
}: {
  playerId: string;
  /** For the accessible label, when the children are an avatar or otherwise not the name. */
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  const open = useContext(OpenPlayer);
  if (!open) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => open(playerId)}
      aria-haspopup="dialog"
      title={`${name} - profile`}
      // Exempt from the 44px touch-target rule in globals.css: an avatar in a
      // stack, or a name in a row that is already tall enough, must not grow.
      data-inline
      className={`cursor-pointer text-left ${className}`}
    >
      {children}
    </button>
  );
}

/** AvatarStack, with each face opening that player's card. Not for use inside a link - buttons do not nest in anchors. */
export function PlayerAvatarStack({
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
          <PlayerLink playerId={p.id} name={p.name} className="block rounded-full transition hover:-translate-y-0.5">
            <Avatar src={p.avatar} name={p.name} size={size} ring={ring} />
          </PlayerLink>
        </span>
      ))}
      {extra > 0 && <span className="ml-1.5 text-xs text-muted">+{extra}</span>}
    </span>
  );
}
