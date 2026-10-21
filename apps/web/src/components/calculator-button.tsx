'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointsCurve } from '@bscs/core/match';
import { PointsCalculator } from './points-calculator';

type CalcMap = { id: string; name: string; difficulty: string; maxScore: number; perfectAcc: number | null };

/**
 * A small "Calculator" button that opens the score / accuracy / points
 * calculator in a dialog, on the map it sits beside. The calculator used to be
 * a box of its own beside the match, taking width the maps needed.
 */
export function CalculatorButton({
  maps,
  mapId,
  curve,
  showPoints,
  className = '',
}: {
  maps: CalcMap[];
  mapId?: string;
  curve: PointsCurve;
  showPoints: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Score, accuracy and points on this map, each from the others"
        className={`inline-flex h-7 items-center gap-1 rounded-lg border border-edge bg-raised/60 px-2 text-[11px] font-medium text-muted transition hover:border-faint hover:text-ink ${className}`}
      >
        <span aria-hidden>±</span> Calculator
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        // A click on the dialog itself, not its content, is the backdrop.
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-edge bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {open && (
          <div>
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
              <div>
                <h3 className="text-base font-semibold tracking-tight">Calculator</h3>
                <p className="text-xs text-muted">Type any one; the others follow.</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-muted transition hover:bg-raised hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="p-4">
              <PointsCalculator maps={maps} curve={curve} showPoints={showPoints} initialMapId={mapId} />
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
