'use client';

import { useMemo, useState } from 'react';
import {
  BRACKET_FORMAT_NAMES,
  generateBracket,
  resolveBracket,
  shuffle,
  type BracketFormat,
} from '@bscs/core/bracket';
import { createBracket } from '@/server/bracket-actions';
import type { BracketSlotView, BracketTeam } from '@/server/brackets';
import { describeSide, layoutBracket, nameSlots } from '@/lib/bracket-layout';
import { Button } from './button';
import { Field, inputClass, teamInk } from './ui';

interface FormTeam {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  members: number;
  /** Mean BeatLeader pp of its available players. */
  pp: number;
}

/**
 * Making a bracket, with the bracket itself drawn underneath as it will be
 * made: who meets whom in the first round, who sits a round out, where the
 * winners go. The seeding is the order of the list, so what is drawn is
 * exactly what Create makes - also for a shuffle, which is done here rather
 * than on the server for that reason.
 */
export function NewBracketForm({
  tournamentId,
  pools,
  teams,
  brackets,
  namePlaceholder,
}: {
  tournamentId: string;
  pools: Array<{ id: string; name: string }>;
  teams: FormTeam[];
  /** Brackets teams can be taken from, with the order they finished in (null: not decided yet). */
  brackets: Array<{ id: string; name: string; order: string[] | null }>;
  namePlaceholder: string;
}) {
  const [format, setFormat] = useState<BracketFormat>('SINGLE_ELIM');
  const [entrants, setEntrants] = useState<'TEAMS' | 'FROM_BRACKET'>('TEAMS');
  const [order, setOrder] = useState(() => teams.map((t) => t.id));
  const [out, setOut] = useState<ReadonlySet<string>>(new Set());
  const [fromId, setFromId] = useState(brackets[0]?.id ?? '');
  const [top, setTop] = useState(4);
  const [dragging, setDragging] = useState<string | null>(null);

  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const included = order.filter((id) => !out.has(id));
  const from = brackets.find((b) => b.id === fromId) ?? null;
  const seeds = entrants === 'TEAMS' ? included : (from?.order ?? []).slice(0, Math.max(0, top));
  const roundRobin = format === 'ROUND_ROBIN';

  /** Put `id` where `before` is in the list. */
  const moveTo = (id: string, before: string) =>
    setOrder((all) => {
      if (id === before) return all;
      const rest = all.filter((x) => x !== id);
      const at = rest.indexOf(before);
      // dropped on a row below where it came from: it goes after that row
      rest.splice(all.indexOf(id) < all.indexOf(before) ? at + 1 : at, 0, id);
      return rest;
    });
  const step = (id: string, by: -1 | 1) =>
    setOrder((all) => {
      // past the next team that is in, so one press always changes its seed
      const i = all.indexOf(id);
      let j = i + by;
      while (j >= 0 && j < all.length && out.has(all[j]!)) j += by;
      if (j < 0 || j >= all.length) return all;
      const next = [...all];
      next.splice(i, 1);
      next.splice(j, 0, id);
      return next;
    });
  const sortIncluded = (sorted: string[]) => setOrder((all) => [...sorted, ...all.filter((id) => out.has(id))]);
  const small = 'h-7 rounded-md border border-edge bg-raised/60 px-2 text-xs font-medium hover:border-faint';

  return (
    <form action={createBracket} className="space-y-4">
      <input type="hidden" name="tournamentId" value={tournamentId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input name="name" className={inputClass} placeholder={namePlaceholder} />
        </Field>
        <Field label="Format">
          <select name="format" className={inputClass} value={format} onChange={(e) => setFormat(e.target.value as BracketFormat)}>
            {(['ROUND_ROBIN', 'SINGLE_ELIM', 'DOUBLE_ELIM'] as const).map((f) => (
              <option key={f} value={f}>
                {BRACKET_FORMAT_NAMES[f]}
                {f === 'DOUBLE_ELIM' ? ' (with a losers bracket)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Map pool" hint="Its matches are played on this.">
          <select name="poolId" className={inputClass} defaultValue={pools[0]?.id ?? ''}>
            <option value="">Choose later</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-edge p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wider text-faint">Who plays</legend>
        <input type="hidden" name="entrants" value={entrants} />
        {brackets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={`${small} ${entrants === 'TEAMS' ? 'border-accent text-accent' : ''}`} onClick={() => setEntrants('TEAMS')}>
              These teams
            </button>
            <button
              type="button"
              className={`${small} ${entrants === 'FROM_BRACKET' ? 'border-accent text-accent' : ''}`}
              onClick={() => setEntrants('FROM_BRACKET')}
            >
              The top of another bracket
            </button>
          </div>
        )}

        {entrants === 'TEAMS' ? (
          <div className="space-y-2">
            <input type="hidden" name="seeding" value="MANUAL" />
            {included.map((id, i) => (
              <span key={id}>
                <input type="hidden" name="teamId" value={id} />
                <input type="hidden" name={`seed:${id}`} value={i + 1} />
              </span>
            ))}
            {!roundRobin && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-faint">Seed</span>
                <button type="button" className={small} onClick={() => sortIncluded([...included].sort((a, b) => teamById.get(b)!.pp - teamById.get(a)!.pp))}>
                  By average pp
                </button>
                <button type="button" className={small} onClick={() => sortIncluded(shuffle(included))}>
                  Shuffle
                </button>
                <span className="text-xs text-faint">or drag a team</span>
              </div>
            )}
            <ul className="max-w-xl divide-y divide-edge overflow-hidden rounded-lg border border-edge">
              {order.map((id) => {
                const team = teamById.get(id)!;
                const isIn = !out.has(id);
                const seed = included.indexOf(id) + 1;
                return (
                  <li
                    key={id}
                    draggable={isIn && !roundRobin}
                    onDragStart={(e) => {
                      setDragging(id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => dragging && dragging !== id && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragging) moveTo(dragging, id);
                      setDragging(null);
                    }}
                    className={`flex items-center gap-3 px-3 py-1.5 text-sm transition ${isIn ? '' : 'opacity-45'} ${
                      dragging === id ? 'bg-accent/15' : isIn && !roundRobin ? 'cursor-grab hover:bg-raised/70' : ''
                    }`}
                    style={{ borderLeft: `3px solid ${team.color}` }}
                  >
                    <input
                      type="checkbox"
                      checked={isIn}
                      aria-label={`${team.name} plays`}
                      className="h-4 w-4"
                      onChange={() =>
                        setOut((was) => {
                          const next = new Set(was);
                          if (!next.delete(id)) next.add(id);
                          return next;
                        })
                      }
                    />
                    {!roundRobin && <span className="w-5 text-right text-xs tabular text-faint">{isIn ? seed : ''}</span>}
                    <span className="min-w-0 flex-1 truncate font-medium" style={{ color: teamInk(team.color, team.colorSecondary) }} title={team.name}>
                      {team.name}
                    </span>
                    <span className="text-xs tabular text-muted" title="Players · their average BeatLeader pp">
                      {team.members}
                      {team.pp > 0 ? ` · ${Math.round(team.pp).toLocaleString('en-US')}pp` : ''}
                    </span>
                    {isIn && !roundRobin && (
                      <span className="flex shrink-0 gap-1">
                        <button type="button" aria-label={`Seed ${team.name} higher`} disabled={seed === 1} className={`${small} w-7 px-0 disabled:opacity-30`} onClick={() => step(id, -1)}>
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Seed ${team.name} lower`}
                          disabled={seed === included.length}
                          className={`${small} w-7 px-0 disabled:opacity-30`}
                          onClick={() => step(id, 1)}
                        >
                          ↓
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            <Field label="From">
              <select name="fromBracketId" className={inputClass} value={fromId} onChange={(e) => setFromId(e.target.value)}>
                {brackets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Top">
              <input
                name="top"
                inputMode="numeric"
                value={top || ''}
                onChange={(e) => setTop(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
                className={`${inputClass} tabular`}
              />
            </Field>
            {from && !from.order && (
              <p className="text-sm text-warn sm:col-span-2">{from.name} has no finishing order yet: it needs a winner first.</p>
            )}
          </div>
        )}
      </fieldset>

      <div className="rounded-lg border border-edge">
        <p className="border-b border-edge px-3 py-2 text-xs font-medium uppercase tracking-wider text-faint">
          What Create will make · {BRACKET_FORMAT_NAMES[format]} · {seeds.length} teams
        </p>
        {seeds.length < 2 ? (
          <p className="p-3 text-sm text-muted">A bracket needs at least two teams.</p>
        ) : (
          <BracketPreview format={format} seeds={seeds.map((id, i) => ({ ...teamById.get(id)!, seed: i + 1 }))} />
        )}
      </div>

      <Button type="submit" disabled={seeds.length < 2}>
        Create bracket
      </Button>
    </form>
  );
}

const CARD_W = 190;
const CARD_H = 50;
const GAP_X = 36;
const GAP_Y = 12;
const HEAD_H = 22;

/** The bracket as it would be made from these seeds: the same shapes and rules the real one is drawn from. */
export function BracketPreview({ format, seeds }: { format: BracketFormat; seeds: BracketTeam[] }) {
  const slots = useMemo<BracketSlotView[]>(() => {
    const byId = new Map(seeds.map((t) => [t.id, t]));
    const nodes = generateBracket(format, seeds.length);
    return resolveBracket(nodes, seeds.map((t) => t.id), {}).map((node) => ({
      key: node.key,
      section: node.section,
      round: node.round,
      position: node.position,
      state: node.state,
      teamA: node.teamA ? (byId.get(node.teamA) ?? null) : null,
      teamB: node.teamB ? (byId.get(node.teamB) ?? null) : null,
      sourceA: '',
      sourceB: '',
      sources: { a: node.a, b: node.b },
      passThrough: node.passThrough,
      winnerId: null,
      match: null,
      pool: null,
      ownPool: false,
    }));
  }, [format, seeds]);
  const names = useMemo(() => nameSlots(slots), [slots]);
  const byKey = useMemo(() => new Map(slots.map((s) => [s.key, s])), [slots]);
  const seedNumbers = useMemo(() => new Set(seeds.map((t) => t.seed)), [seeds]);

  const side = (team: BracketTeam | null, source: BracketSlotView['sources']['a'], seeded: boolean) => (
    <div className="flex h-[22px] items-center gap-1.5 px-2 text-xs">
      {team ? (
        <>
          {seeded && <span className="w-4 shrink-0 text-right text-[10px] tabular text-faint">{team.seed}</span>}
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: team.color }} />
          <span className="truncate font-medium" style={{ color: teamInk(team.color, team.colorSecondary) }}>
            {team.name}
          </span>
        </>
      ) : (
        <span className="truncate italic text-faint">{describeSide(source, byKey, seedNumbers, names.slots)}</span>
      )}
    </div>
  );

  if (format === 'ROUND_ROBIN') {
    const rounds = [...new Set(slots.map((s) => s.round))].sort((a, b) => a - b);
    return (
      <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {rounds.map((round) => (
          <div key={round} className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-faint">Round {round}</p>
            {slots
              .filter((s) => s.round === round)
              .map((s) => (
                <div key={s.key} className="rounded-md border border-edge bg-raised">
                  {side(s.teamA, s.sources.a, false)}
                  {side(s.teamB, s.sources.b, false)}
                </div>
              ))}
          </div>
        ))}
      </div>
    );
  }

  const byes = slots.filter((s) => s.section === 'W' && s.state === 'BYE').map((s) => s.teamA ?? s.teamB).filter((t) => t != null);
  const trees: Array<Array<'W' | 'L' | 'GF'>> = format === 'DOUBLE_ELIM' ? [['W', 'GF'], ['L']] : [['W']];
  return (
    <div className="space-y-2 p-3">
      {trees.map((sections) => {
        const layout = layoutBracket(slots, sections);
        if (!layout.placed.length) return null;
        const x = (column: number) => column * (CARD_W + GAP_X);
        const y = (row: number) => HEAD_H + row * (CARD_H + GAP_Y);
        const width = layout.columns * (CARD_W + GAP_X) - GAP_X;
        const height = y(layout.rows) - GAP_Y;
        return (
          <div key={sections.join()} className="overflow-x-auto">
            <div className="relative" style={{ width, height }}>
              {layout.headings.map((heading, i) => (
                <p key={i} className="absolute top-0 text-[10px] font-semibold uppercase tracking-widest text-faint" style={{ left: x(i), width: CARD_W }}>
                  {heading}
                </p>
              ))}
              <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} aria-hidden>
                {layout.lines.map(({ from, to }) => {
                  const x1 = x(from.column) + CARD_W;
                  const y1 = y(from.row) + CARD_H / 2;
                  const x2 = x(to.column);
                  const y2 = y(to.row) + CARD_H / 2;
                  const mid = x1 + (x2 - x1) / 2;
                  return (
                    <path key={`${from.slot.key}-${to.slot.key}`} d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`} fill="none" stroke="var(--color-edge-strong)" strokeWidth={1.5} />
                  );
                })}
              </svg>
              {layout.placed.map(({ slot, column, row }) => (
                <div
                  key={slot.key}
                  className={`absolute rounded-md border bg-raised ${slot.state === 'READY' ? 'border-accent/60' : 'border-edge'}`}
                  style={{ left: x(column), top: y(row), width: CARD_W, height: CARD_H }}
                  title={names.slots.get(slot.key)}
                >
                  <div className="flex h-full flex-col justify-center divide-y divide-edge/60">
                    {side(slot.teamA, slot.sources.a, true)}
                    {side(slot.teamB, slot.sources.b, true)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {byes.length > 0 && (
        <p className="text-xs text-muted">
          Straight into the next round: {byes.map((t) => t.name).join(', ')}
        </p>
      )}
    </div>
  );
}
