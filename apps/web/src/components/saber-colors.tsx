'use client';

import { useRef, useState } from 'react';
import { setPlayerSabers } from '@/server/team-media-actions';
import { replayHref } from '@/lib/replay-viewer';
import { Button } from './button';

/** The game's own red and blue: what a player with no colours of their own is drawn in. */
const GAME = { left: '#c81414', right: '#288ed2' };

/**
 * A player's saber colours for this tournament, with the two sabers drawn in
 * them as they are picked. Preview plays one of the player's own replays of a
 * pool map in the site's replay viewer with the colours as picked (saved or
 * not), so they are seen in motion before anyone else sees them.
 */
export function SaberColors({
  memberId,
  playerName,
  sabers,
  replays,
  viewer,
}: {
  memberId: string;
  playerName: string;
  /** What is saved, or null for the game's own. */
  sabers: { left: string; right: string } | null;
  /** Their replays of pool maps: what Preview can play. */
  replays: Array<{ scoreId: number; label: string }>;
  /** The site's own replay viewer, or null where it has none (then there is no preview). */
  viewer: string | null;
}) {
  const [left, setLeft] = useState(sabers?.left ?? GAME.left);
  const [right, setRight] = useState(sabers?.right ?? GAME.right);
  const [scoreId, setScoreId] = useState(replays[0]?.scoreId ?? null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const changed = left !== (sabers?.left ?? GAME.left) || right !== (sabers?.right ?? GAME.right);
  const canPreview = viewer != null && replays.length > 0;
  const saber = (color: string, flip: boolean) => (
    <svg viewBox="0 0 120 16" className={`h-4 w-24 ${flip ? '-scale-x-100' : ''}`} aria-hidden>
      <rect x="0" y="5" width="26" height="6" rx="2" fill="#8a8f98" />
      <rect x="26" y="3" width="4" height="10" rx="1" fill="#c9ced6" />
      <rect x="30" y="4" width="88" height="8" rx="4" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      <rect x="32" y="7" width="84" height="2" rx="1" fill="#fff" opacity=".75" />
    </svg>
  );

  return (
    <form action={setPlayerSabers} className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-edge pt-2">
      <input type="hidden" name="memberId" value={memberId} />
      <span className="text-faint">Saber colours</span>
      <label className="flex items-center gap-1.5" title="Left saber">
        <input type="color" name="left" value={left} onChange={(e) => setLeft(e.target.value)} aria-label={`${playerName}'s left saber colour`} className="h-7 w-9 cursor-pointer rounded border border-edge bg-transparent p-0" />
        {saber(left, true)}
      </label>
      <label className="flex items-center gap-1.5" title="Right saber">
        {saber(right, false)}
        <input type="color" name="right" value={right} onChange={(e) => setRight(e.target.value)} aria-label={`${playerName}'s right saber colour`} className="h-7 w-9 cursor-pointer rounded border border-edge bg-transparent p-0" />
      </label>
      <span className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="ghost" className="h-8 text-xs" disabled={!changed && sabers != null}>
          {sabers == null && !changed ? 'Save these' : 'Save'}
        </Button>
        {sabers != null && (
          <Button type="submit" name="clear" value="1" variant="ghost" className="h-8 text-xs" title="Back to the game's own red and blue">
            Game colours
          </Button>
        )}
        <button
          type="button"
          disabled={!canPreview}
          title={
            viewer == null
              ? 'This site has no replay viewer of its own to preview in'
              : replays.length === 0
                ? `${playerName} has no replay of a pool map yet`
                : 'Play one of their replays with these colours'
          }
          className="h-8 rounded-lg border border-edge bg-raised/60 px-3 text-xs font-medium hover:border-faint disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setOpen(true);
            dialog.current?.showModal();
          }}
        >
          Preview
        </button>
      </span>
      <span className="basis-full text-faint">
        {sabers ? 'Shown' : 'Once saved, shown'} on stream and wherever this site plays {playerName}&apos;s replays, in this tournament.
      </span>

      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
        className="m-auto w-[min(64rem,94vw)] rounded-xl border border-edge bg-panel p-0 text-ink backdrop:bg-black/70"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2 text-sm">
          <span className="font-semibold">{playerName}</span>
          <select
            value={scoreId ?? ''}
            onChange={(e) => setScoreId(Number(e.target.value))}
            aria-label="Replay to preview"
            className="h-8 min-w-0 flex-1 rounded-md border border-edge bg-surface px-2 text-xs"
          >
            {replays.map((r) => (
              <option key={r.scoreId} value={r.scoreId}>
                {r.label}
              </option>
            ))}
          </select>
          <input type="color" value={left} onChange={(e) => setLeft(e.target.value)} aria-label="Left saber colour" className="h-7 w-9 cursor-pointer rounded border border-edge bg-transparent p-0" />
          <input type="color" value={right} onChange={(e) => setRight(e.target.value)} aria-label="Right saber colour" className="h-7 w-9 cursor-pointer rounded border border-edge bg-transparent p-0" />
          <button type="button" className="h-8 rounded-md border border-edge px-3 text-xs font-medium hover:border-faint" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        {/* only while open, so nothing loads (or keeps playing) behind a closed preview; keyed so new colours start it afresh */}
        {open && scoreId != null && viewer != null && (
          <iframe
            key={`${scoreId}:${left}:${right}`}
            src={replayHref({ scoreId }, { sabers: { left, right }, embed: true, base: viewer })!}
            title={`${playerName}'s replay with these saber colours`}
            allow="autoplay; fullscreen"
            className="block aspect-video w-full bg-black"
          />
        )}
        {changed && <p className="px-3 py-2 text-xs text-warn">Not saved yet: close this and press Save to keep these colours.</p>}
      </dialog>
    </form>
  );
}
