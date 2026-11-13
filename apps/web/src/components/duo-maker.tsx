'use client';

import { useState } from 'react';
import { makeDuos } from '@bscs/core/bracket';
import { makeDuosFromPool } from '@/server/pool-actions';
import { Button } from './button';
import { Avatar } from './ui';

export interface DuoPlayer {
  memberId: string;
  name: string;
  avatar: string | null;
  /** What they are seeded by, as shown: "9,120pp", "97.31% · 6/7". */
  stat: string;
  /** The same as a number, for a duo's average. Null where there is none. */
  value: number | null;
}

/**
 * The duos that will be made from the player pool, shown before they are made.
 * It starts on the seeded pairing (top seed with the bottom one, and so on);
 * Shuffle draws a random one. Two players swap by dragging one onto the other,
 * or by pressing one and then the other. Make duos creates exactly what is
 * shown, so a shuffle is drawn here and not on the server.
 */
export function DuoMaker({
  tournamentId,
  players,
  format,
}: {
  tournamentId: string;
  /** The pool's players, strongest first. */
  players: DuoPlayer[];
  /** How a duo's average is written: 'pp' or 'acc'. */
  format: 'pp' | 'acc';
}) {
  const seeded = () => {
    const { duos, left } = makeDuos(players, 'SEEDED');
    return [...duos.flat(), ...left].map((p) => p.memberId);
  };
  // Pairs are positions 0+1, 2+3...; an odd player out is last and stays in the pool.
  const [slots, setSlots] = useState<string[]>(seeded);
  const [held, setHeld] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = new Map(players.map((p) => [p.memberId, p]));
  // The pool changed under the preview (someone added or removed): start again from the seeding.
  const stale = slots.length !== players.length || slots.some((id) => !byId.has(id));
  const shown = stale ? seeded() : slots;

  const swap = (a: string, b: string) => {
    if (a === b) return;
    setSlots(shown.map((id) => (id === a ? b : id === b ? a : id)));
  };
  const press = (id: string) => {
    if (!held) return setHeld(id);
    swap(held, id);
    setHeld(null);
  };
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < shown.length; i += 2) pairs.push([shown[i]!, shown[i + 1]!]);
  const left = shown.length % 2 === 1 ? shown[shown.length - 1]! : null;
  const isSeeded = seeded().every((id, i) => id === shown[i]);
  const average = (ids: string[]) => {
    const values = ids.map((id) => byId.get(id)!.value).filter((v): v is number => v != null);
    if (!values.length) return '';
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return format === 'acc' ? `${(mean * 100).toFixed(2)}%` : `${Math.round(mean).toLocaleString('en-US')}pp`;
  };
  const small = 'h-7 rounded-md border border-edge bg-raised/60 px-2 text-xs font-medium hover:border-faint';

  const chip = (id: string) => {
    const p = byId.get(id)!;
    return (
      <button
        type="button"
        key={id}
        draggable
        onDragStart={(e) => {
          setDragging(id);
          setHeld(null);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => dragging && dragging !== id && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (dragging) swap(dragging, id);
          setDragging(null);
        }}
        onClick={() => press(id)}
        aria-pressed={held === id}
        title={held && held !== id ? `Swap with ${byId.get(held)!.name}` : 'Drag onto another player to swap them, or press one and then the other'}
        className={`flex w-full min-w-0 cursor-grab items-center gap-2 rounded-md border px-2 py-1 text-left text-sm transition ${
          held === id || dragging === id ? 'border-accent bg-accent/15' : held ? 'border-dashed border-faint hover:border-accent' : 'border-edge bg-surface hover:border-faint'
        }`}
      >
        <Avatar src={p.avatar} name={p.name} size={20} />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        <span className="shrink-0 text-xs tabular text-muted">{p.stat}</span>
      </button>
    );
  };

  return (
    <form action={makeDuosFromPool} className="space-y-3 border-t border-edge pt-3">
      <input type="hidden" name="tournamentId" value={tournamentId} />
      <input type="hidden" name="pairs" value={JSON.stringify(pairs)} />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wider text-faint">Duos that will be made</span>
        <button type="button" className={`${small} ${isSeeded ? 'border-accent text-accent' : ''}`} onClick={() => (setSlots(seeded()), setHeld(null))}>
          Seeded
        </button>
        <button
          type="button"
          className={small}
          onClick={() => {
            const { duos, left: odd } = makeDuos(players, 'RANDOM');
            setSlots([...duos.flat(), ...odd].map((p) => p.memberId));
            setHeld(null);
          }}
        >
          Shuffle
        </button>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {pairs.map(([a, b], i) => (
          <li key={i} className="space-y-1 rounded-lg border border-edge bg-raised/40 p-2">
            <p className="flex items-baseline justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
              <span>Duo {i + 1}</span>
              <span className="tabular normal-case tracking-normal text-muted">{average([a, b])}</span>
            </p>
            {chip(a)}
            {chip(b)}
          </li>
        ))}
        {left && (
          <li className="space-y-1 rounded-lg border border-dashed border-edge p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Stays in the pool</p>
            {chip(left)}
          </li>
        )}
      </ol>
      <Button type="submit" disabled={pairs.length === 0}>
        Make {pairs.length === 1 ? 'this duo' : `these ${pairs.length} duos`}
      </Button>
    </form>
  );
}
