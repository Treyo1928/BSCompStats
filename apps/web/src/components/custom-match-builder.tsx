'use client';

import { useState } from 'react';
import { draftSequence, draftTeamSizes, type DraftOrder } from '@bscs/core/match';
import { registerGuest, searchGuestCandidates } from '@/server/actions';
import { createCustomMatch, createDraft } from '@/server/draft-actions';
import { PlayerPicker } from './roster-controls';
import { Avatar, Button, Field, Panel, inputClass, pct } from './ui';

export interface BuilderPlayer {
  id: string;
  beatLeaderId: string;
  name: string;
  avatar: string | null;
  /** The team they are entered with, if any - guests have none. */
  teamName: string | null;
  teamColor: string | null;
  meanAcc: number | null;
}

type Side = 'A' | 'B';
const SIDE_INK: Record<Side, string> = { A: 'var(--color-saber-left)', B: 'var(--color-saber-right)' };
const DEFAULT_COLOR: Record<Side, string> = { A: '#ff4d5e', B: '#3d9bff' };

/**
 * Builds a match between sides that are not tournament teams: either named
 * outright, or left for two captains to draft.
 *
 * Every choice lives in hidden inputs of one plain form, so the server action
 * is the only thing that decides what is valid.
 */
export function CustomMatchBuilder({
  tournamentId,
  players: initialPlayers,
  pools,
}: {
  tournamentId: string;
  players: BuilderPlayer[];
  pools: Array<{ id: string; name: string }>;
}) {
  const [mode, setMode] = useState<'manual' | 'draft'>('manual');
  const [players, setPlayers] = useState(initialPlayers);

  // Manual sides. A player may be on both.
  const [sides, setSides] = useState<Record<string, Side[]>>({});
  // Draft.
  const [captains, setCaptains] = useState<Record<Side, string>>({ A: '', B: '' });
  const [inPool, setInPool] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<DraftOrder>('SNAKE');
  const [firstPick, setFirstPick] = useState<'A' | 'B' | 'RANDOM'>('RANDOM');
  const [shareOdd, setShareOdd] = useState(true);

  const onSide = (side: Side) => players.filter((p) => sides[p.id]?.includes(side));
  const toggleSide = (playerId: string, side: Side) =>
    setSides((current) => {
      const mine = current[playerId] ?? [];
      return {
        ...current,
        [playerId]: mine.includes(side) ? mine.filter((s) => s !== side) : [...mine, side],
      };
    });

  const draftPool = players.filter(
    (p) => inPool.has(p.id) && p.id !== captains.A && p.id !== captains.B,
  );
  const settings = { order, firstPick: firstPick === 'B' ? 'B' : 'A', shareOdd } as const;
  const sequence = draftSequence(settings, draftPool.length);
  const sizes = draftTeamSizes(settings, draftPool.length);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name;

  async function addGuest(candidate: { beatLeaderId: string }) {
    const result = await registerGuest(tournamentId, candidate.beatLeaderId);
    if (result.error || !result.player) return { error: result.error ?? 'Could not add that player.' };
    const guest = result.player;
    setPlayers((current) =>
      current.some((p) => p.id === guest.id)
        ? current
        : [...current, { ...guest, teamName: null, teamColor: null, meanAcc: null }],
    );
    setInPool((current) => new Set(current).add(guest.id));
    return {};
  }

  const guestPicker = (
    <PlayerPicker
      title="Add a guest"
      label="Find a player"
      takenLabel="Listed"
      search={async (query) => {
        const found = await searchGuestCandidates(tournamentId, query);
        const listed = new Set(players.map((p) => p.beatLeaderId));
        return {
          ...found,
          candidates: found.candidates.map((c) => ({ ...c, onTeam: listed.has(c.beatLeaderId) })),
        };
      }}
      add={addGuest}
    />
  );

  return (
    <div className="space-y-6">
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl border border-edge bg-panel/90 p-1 text-sm">
        {(
          [
            ['manual', 'Choose the sides', 'You decide who plays for whom'],
            ['draft', "Captains' draft", 'Two captains take turns picking'],
          ] as const
        ).map(([key, label, hint]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`rounded-lg px-3 py-2 text-left transition ${
              mode === key ? 'bg-accent/20 text-ink ring-1 ring-inset ring-accent/40' : 'text-muted hover:bg-raised'
            }`}
          >
            <span className="block font-semibold">{label}</span>
            <span className="block text-xs opacity-80">{hint}</span>
          </button>
        ))}
      </div>

      {/* Its own panel, outside both forms: the search is a form too, and forms do not nest. */}
      <Panel
        title="Guests"
        subtitle="Anyone already on a team here is listed below. Someone from outside can be looked up on BeatLeader and added."
      >
        {guestPicker}
        {players.some((p) => !p.teamName) && (
          <p className="mt-3 text-xs text-muted">
            Guests: {players.filter((p) => !p.teamName).map((p) => p.name).join(', ')}
          </p>
        )}
      </Panel>

      {mode === 'manual' ? (
        <form action={createCustomMatch} className="space-y-6">
          <input type="hidden" name="tournamentId" value={tournamentId} />
          {(['A', 'B'] as const).flatMap((side) =>
            onSide(side).map((p) => (
              <input key={`${side}:${p.id}`} type="hidden" name={`player${side}`} value={p.id} />
            )),
          )}

          <Panel
            title="Players"
            subtitle="Tap A or B to put someone on a side. Both is allowed - a shared player's run counts for each team."
            flush
          >
            <ul className="divide-y divide-edge/60">
              {players.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2">
                  <PlayerLine player={p} />
                  {(['A', 'B'] as const).map((side) => {
                    const on = sides[p.id]?.includes(side) ?? false;
                    return (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={on}
                        aria-label={`${p.name} on side ${side}`}
                        onClick={() => toggleSide(p.id, side)}
                        className="h-10 w-12 shrink-0 rounded-lg border text-sm font-bold transition"
                        style={
                          on
                            ? { background: SIDE_INK[side], borderColor: SIDE_INK[side], color: '#0a0c13' }
                            : { borderColor: 'var(--color-edge-strong)', color: SIDE_INK[side] }
                        }
                      >
                        {side}
                      </button>
                    );
                  })}
                </li>
              ))}
            </ul>
          </Panel>

          <div className="grid gap-6 md:grid-cols-2">
            {(['A', 'B'] as const).map((side) => (
              <Panel
                key={side}
                title={<span style={{ color: SIDE_INK[side] }}>Side {side}</span>}
                subtitle={onSide(side).map((p) => p.name).join(', ') || 'Nobody yet'}
              >
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Field label="Team name">
                        <input name={`name${side}`} className={inputClass} placeholder={`Team ${side}`} />
                      </Field>
                    </div>
                    <Field label="Colour">
                      <input
                        type="color"
                        name={`color${side}`}
                        defaultValue={DEFAULT_COLOR[side]}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                  </div>
                  <Field
                    label="Captain (optional)"
                    hint="Can pick, ban and set lineups from their own account. Organisers can always do it for them."
                  >
                    <select name={`captain${side}`} className={inputClass} defaultValue="">
                      <option value="">No captain</option>
                      {onSide(side).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </Panel>
            ))}
          </div>

          <Panel title="The match">
            <div className="space-y-3">
              <MatchOptions pools={pools} sideNames={['Side A', 'Side B']} />
              <Button type="submit" disabled={onSide('A').length === 0 || onSide('B').length === 0}>
                Create match
              </Button>
            </div>
          </Panel>
        </form>
      ) : (
        <form action={createDraft} className="space-y-6">
          <input type="hidden" name="tournamentId" value={tournamentId} />
          <input type="hidden" name="order" value={order} />
          <input type="hidden" name="firstPick" value={firstPick} />
          {shareOdd && <input type="hidden" name="shareOdd" value="on" />}
          {draftPool.map((p) => (
            <input key={p.id} type="hidden" name="poolPlayer" value={p.id} />
          ))}

          <div className="grid gap-6 md:grid-cols-2">
            {(['A', 'B'] as const).map((side) => (
              <Panel key={side} title={<span style={{ color: SIDE_INK[side] }}>Captain {side}</span>}>
                <div className="space-y-3">
                  <Field label="Captain">
                    <select
                      name={`captain${side}`}
                      className={inputClass}
                      value={captains[side]}
                      onChange={(e) => setCaptains((c) => ({ ...c, [side]: e.target.value }))}
                      required
                    >
                      <option value="">Choose…</option>
                      {players
                        .filter((p) => p.id !== captains[side === 'A' ? 'B' : 'A'])
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Field label="Team name">
                        <input
                          name={`name${side}`}
                          className={inputClass}
                          placeholder={`Team ${nameOf(captains[side]) ?? side}`}
                        />
                      </Field>
                    </div>
                    <Field label="Colour">
                      <input
                        type="color"
                        name={`color${side}`}
                        defaultValue={DEFAULT_COLOR[side]}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                  </div>
                </div>
              </Panel>
            ))}
          </div>

          <Panel
            title="Player pool"
            subtitle={`${draftPool.length} to pick from`}
            actions={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setInPool(new Set(players.map((p) => p.id)))}
                >
                  Everyone
                </Button>
                <Button type="button" variant="ghost" onClick={() => setInPool(new Set())}>
                  Clear
                </Button>
              </>
            }
            flush
          >
            <ul className="divide-y divide-edge/60">
              {players.map((p) => {
                const captainOf = captains.A === p.id ? 'A' : captains.B === p.id ? 'B' : null;
                return (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2">
                      <PlayerLine player={p} />
                      {captainOf ? (
                        <span className="text-xs font-semibold" style={{ color: SIDE_INK[captainOf] }}>
                          Captain {captainOf}
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-[var(--color-accent)]"
                          checked={inPool.has(p.id)}
                          onChange={() =>
                            setInPool((current) => {
                              const next = new Set(current);
                              if (!next.delete(p.id)) next.add(p.id);
                              return next;
                            })
                          }
                        />
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="How they pick">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Pick order"
                  hint={
                    order === 'SNAKE'
                      ? 'Whoever picks first gives the next two away, which evens out first pick.'
                      : 'Strictly one each. First pick is a real advantage.'
                  }
                >
                  <select
                    className={inputClass}
                    value={order}
                    onChange={(e) => setOrder(e.target.value as DraftOrder)}
                  >
                    <option value="SNAKE">Snake (A B B A A B)</option>
                    <option value="ALTERNATE">Alternate (A B A B)</option>
                  </select>
                </Field>
                <Field label="First pick">
                  <select
                    className={inputClass}
                    value={firstPick}
                    onChange={(e) => setFirstPick(e.target.value as 'A' | 'B' | 'RANDOM')}
                  >
                    <option value="RANDOM">Coin toss</option>
                    <option value="A">{nameOf(captains.A) ?? 'Captain A'}</option>
                    <option value="B">{nameOf(captains.B) ?? 'Captain B'}</option>
                  </select>
                </Field>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={shareOdd}
                  onChange={(e) => setShareOdd(e.target.checked)}
                />
                <span>
                  With an odd number, the last player plays for both teams
                  <span className="block text-xs text-faint">
                    Keeps the sides the same size. Their run on a map counts once for each team. Left
                    off, the last player simply goes to whoever&apos;s turn it is.
                  </span>
                </span>
              </label>

              {draftPool.length > 0 && (
                <div className="rounded-lg border border-edge bg-raised/40 p-3 text-xs text-muted">
                  <p className="flex flex-wrap items-center gap-1">
                    {sequence.map((slot, i) => (
                      <span
                        key={i}
                        className="inline-flex h-6 min-w-6 items-center justify-center rounded px-1 font-bold"
                        style={
                          slot === 'BOTH'
                            ? { background: 'var(--color-edge-strong)', color: 'var(--color-ink)' }
                            : { background: SIDE_INK[slot], color: '#0a0c13' }
                        }
                        title={slot === 'BOTH' ? 'Shared by both teams' : `Pick ${i + 1}`}
                      >
                        {slot === 'BOTH' ? 'A+B' : firstPick === 'RANDOM' ? (slot === 'A' ? '1st' : '2nd') : slot}
                      </span>
                    ))}
                  </p>
                  <p className="mt-2">
                    Teams of {sizes.a} and {sizes.b}, captains included
                    {sequence.includes('BOTH') && ' - the last player left is shared'}
                    {sizes.a !== sizes.b && ' - odd numbers, so one side gets an extra player'}.
                  </p>
                </div>
              )}

              <Button type="submit" disabled={!captains.A || !captains.B || draftPool.length === 0}>
                Start the draft
              </Button>
              <p className="text-xs text-faint">
                The map pool and coin flip are chosen when the draft is done and the match is opened.
              </p>
            </div>
          </Panel>
        </form>
      )}
    </div>
  );
}

function PlayerLine({ player }: { player: BuilderPlayer }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <Avatar src={player.avatar} name={player.name} size={32} ring={player.teamColor ?? undefined} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{player.name}</span>
        <span className="block truncate text-xs text-faint">
          {[player.teamName ?? 'Guest', player.meanAcc != null ? `${pct(player.meanAcc)} average` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </span>
  );
}

/** Pool, coin flip and hidden lineups - what any match is opened with. */
export function MatchOptions({
  pools,
  sideNames,
}: {
  pools: Array<{ id: string; name: string }>;
  sideNames: [string, string];
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Map pool">
          <select name="poolId" className={inputClass} required>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Coin flip winner" hint="They take the first step in the pick/ban order.">
          <select name="coinFlip" className={inputClass} defaultValue="A">
            <option value="A">{sideNames[0]}</option>
            <option value="B">{sideNames[1]}</option>
          </select>
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="blindLineups" className="mt-1" />
        <span>
          Hide lineups until both teams are done
          <span className="block text-xs text-faint">
            Each team sees only its own player choices until every map has been set by both sides.
          </span>
        </span>
      </label>
    </>
  );
}
