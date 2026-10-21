'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A bracket slot's "start ▾" / "result ▾" menu, opened as a dialog.
 *
 * It used to drop down inside the bracket drawing, which scrolls sideways -
 * and anything that scrolls clips what spills out of it, so a slot near the
 * bottom had its menu cut off. A dialog is drawn above the whole page.
 */
export function SlotMenu({
  label,
  title,
  children,
}: {
  /** The link-like trigger, e.g. "start ▾". */
  label: string;
  /** What the dialog is about, e.g. "Maroon vs White". */
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-accent hover:underline">
        {label}
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        // A click on the dialog itself, not its content, is the backdrop.
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        className="m-auto w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-edge bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {open && (
          <div>
            <div className="flex items-start justify-between gap-3 border-b border-edge px-3 py-2.5">
              <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg px-1.5 text-muted transition hover:bg-raised hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="max-h-[80vh] space-y-3 overflow-y-auto p-3 text-xs">{children}</div>
          </div>
        )}
      </dialog>
    </>
  );
}
