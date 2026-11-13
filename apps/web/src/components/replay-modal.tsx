'use client';

import { useEffect, useRef, useState } from 'react';

/** BeatLeader's own viewer cannot be framed in another site; ours can. */
const ours = (href: string) => !/^https:\/\/replay\.beatleader\.com\//.test(href);

/**
 * A link to a replay. In the site's own viewer it plays in a window over the
 * page (ReplayModal, mounted once per page); a BeatLeader link, or a click
 * with Ctrl / Shift / the middle button, opens a tab as any link does.
 */
export function ReplayLink({ href, title, className, children }: { href: string; title?: string; className?: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
      onClick={(e) => {
        if (!ours(href) || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('bscs:replay', { detail: { href, title } }));
      }}
    >
      {children}
    </a>
  );
}

/** The window ReplayLink opens. Put one on any page that has replay links. */
export function ReplayModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [replay, setReplay] = useState<{ href: string; title?: string } | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      setReplay((e as CustomEvent<{ href: string; title?: string }>).detail);
      dialog.current?.showModal();
    };
    window.addEventListener('bscs:replay', open);
    return () => window.removeEventListener('bscs:replay', open);
  }, []);
  // taken away at once on closing, whichever way it is closed, so the replay and its sound stop
  const close = () => {
    setReplay(null);
    dialog.current?.close();
  };
  // starts by itself in the window; the link itself (a new tab) does not
  const src = replay ? `${replay.href}${replay.href.includes('?') ? '&' : '?'}autoplay=true` : null;
  return (
    <dialog
      ref={dialog}
      onClose={() => setReplay(null)}
      onClick={(e) => e.target === dialog.current && close()}
      className="m-auto w-[min(72rem,96vw)] rounded-xl border border-edge bg-panel p-0 text-ink backdrop:bg-black/75"
    >
      <div className="flex items-center gap-3 border-b border-edge px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-semibold">{replay?.title ?? 'Replay'}</span>
        {replay && (
          <a href={replay.href} target="_blank" rel="noreferrer noopener" className="text-xs text-muted hover:text-ink">
            Open in a tab
          </a>
        )}
        <button type="button" className="h-8 rounded-md border border-edge px-3 text-xs font-medium hover:border-faint" onClick={close}>
          Close
        </button>
      </div>
      {/* only while open: closing it stops the replay and its sound */}
      {src && <iframe key={src} src={src} title={replay?.title ?? 'Replay'} allow="autoplay; fullscreen" className="block aspect-video w-full bg-black" />}
    </dialog>
  );
}
