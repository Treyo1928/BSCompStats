'use client';

import { useState } from 'react';
import { arrangeRosters } from '@/server/pool-actions';
import { Button } from './button';
import { Avatar, teamInk } from './ui';

export interface BoardTeam {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  /** The player pool: players not in a team yet. */
  pool: boolean;
  members: Array<{ id: string; name: string; avatar: string | null }>;
  /** Which places in the team are a captain's, by position: whoever ends up there captains it. */
  captainPlaces: boolean[];
}

/**
 * Every team's roster side by side, to rearrange: drag a player onto another
 * to swap the two, or onto a team to move them there (or press a player, then
 * a player or a team). Nothing is saved until Save: the board shows the teams
 * as they will be, with everyone who would move marked and listed.
 */
export function RosterBoard({ tournamentId, teams }: { tournamentId: string; teams: BoardTeam[] }) {
  const original = () => Object.fromEntries(teams.map((t) => [t.id, t.members.map((m) => m.id)]));
  const [rosters, setRosters] = useState<Record<string, string[]>>(original);
  const [held, setHeld] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const memberById = new Map(teams.flatMap((t) => t.members.map((m) => [m.id, m] as const)));
  const homeOf = new Map(teams.flatMap((t) => t.members.map((m) => [m.id, t] as const)));
  const teamOf = (id: string, in_: Record<string, string[]> = rosters) => Object.keys(in_).find((teamId) => in_[teamId]!.includes(id))!;
  const moved = [...memberById.keys()].filter((id) => teamOf(id) !== homeOf.get(id)!.id);
  // Same team, another place: only matters where it changes who captains.
  const reordered = teams.some((t) => rosters[t.id]!.some((id, i) => homeOf.get(id)!.id === t.id && t.members[i]?.id !== id));

  const swap = (a: string, b: string) => {
    if (a === b) return;
    setRosters((was) => Object.fromEntries(Object.entries(was).map(([teamId, ids]) => [teamId, ids.map((id) => (id === a ? b : id === b ? a : id))])));
  };
  const moveTo = (id: string, teamId: string) => {
    if (teamOf(id) === teamId) return;
    setRosters((was) => Object.fromEntries(Object.entries(was).map(([t, ids]) => [t, t === teamId ? [...ids, id] : ids.filter((x) => x !== id)])));
  };
  const active = dragging ?? held;

  return (
    <form action={arrangeRosters} className="space-y-3">
      <input type="hidden" name="tournamentId" value={tournamentId} />
      <input type="hidden" name="rosters" value={JSON.stringify(rosters)} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {teams.map((team) => {
          const ids = rosters[team.id]!;
          const target = active != null && teamOf(active) !== team.id;
          return (
            <div
              key={team.id}
              onDragOver={(e) => dragging && target && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) moveTo(dragging, team.id);
                setDragging(null);
              }}
              className={`flex flex-col gap-1 rounded-lg border p-2 transition ${target ? 'border-dashed border-accent/70' : 'border-edge'} ${team.pool ? 'bg-surface/40' : 'bg-raised/40'}`}
              style={{ borderLeftColor: team.color, borderLeftWidth: 3, borderLeftStyle: 'solid' }}
            >
              <p className="flex items-center justify-between gap-2 text-xs font-semibold">
                <span className="truncate" style={{ color: team.pool ? undefined : teamInk(team.color, team.colorSecondary) }} title={team.name}>
                  {team.name}
                </span>
                <span className="shrink-0 tabular font-normal text-faint">{ids.length}</span>
              </p>
              {ids.map((id, i) => {
                const m = memberById.get(id)!;
                const from = homeOf.get(id)!;
                const isMoved = from.id !== team.id;
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
                    onDragOver={(e) => {
                      if (dragging && dragging !== id) {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragging) swap(dragging, id);
                      setDragging(null);
                    }}
                    onClick={() => {
                      if (!held) return setHeld(id);
                      swap(held, id);
                      setHeld(null);
                    }}
                    aria-pressed={held === id}
                    title={
                      active && active !== id
                        ? `Swap with ${memberById.get(active)!.name}`
                        : 'Drag onto a player to swap them, or onto a team to move here. Or press, then press a player or a team.'
                    }
                    className={`flex w-full min-w-0 cursor-grab items-center gap-2 rounded-md border px-2 py-1 text-left text-sm transition ${
                      active === id
                        ? 'border-accent bg-accent/15'
                        : isMoved
                          ? 'border-warn/70 bg-warn/10'
                          : active
                            ? 'border-dashed border-faint bg-surface hover:border-accent'
                            : 'border-edge bg-surface hover:border-faint'
                    }`}
                  >
                    <Avatar src={m.avatar} name={m.name} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.name}</span>
                      {isMoved && <span className="block truncate text-[10px] text-warn">from {from.name}</span>}
                    </span>
                    {!team.pool && team.captainPlaces[i] && (
                      <span className="shrink-0 rounded bg-edge px-1 text-[10px] font-semibold text-muted" title="This place captains the team">
                        C
                      </span>
                    )}
                  </button>
                );
              })}
              {held && target && (
                <button
                  type="button"
                  className="h-8 rounded-md border border-dashed border-accent/70 text-xs font-medium text-accent hover:bg-accent/10"
                  onClick={() => {
                    moveTo(held, team.id);
                    setHeld(null);
                  }}
                >
                  Move {memberById.get(held)!.name} here
                </button>
              )}
              {ids.length === 0 && !(held && target) && <p className="py-1 text-center text-xs text-faint">Empty</p>}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {moved.length === 0 && !reordered ? (
          <p className="text-sm text-muted">No changes.</p>
        ) : (
          <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5 text-xs">
            {moved.map((id) => (
              <li key={id} className="rounded-md border border-warn/50 bg-warn/10 px-2 py-1">
                <span className="font-medium">{memberById.get(id)!.name}</span>
                <span className="text-muted">
                  {' '}
                  {homeOf.get(id)!.name} → {teams.find((t) => t.id === teamOf(id))!.name}
                </span>
              </li>
            ))}
            {moved.length === 0 && <li className="py-1 text-muted">Places changed within a team.</li>}
          </ul>
        )}
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={moved.length === 0 && !reordered}
            className="h-9 rounded-lg border border-edge px-3 text-sm font-medium text-muted hover:border-faint disabled:opacity-40"
            onClick={() => (setRosters(original()), setHeld(null))}
          >
            Undo all
          </button>
          <Button type="submit" disabled={moved.length === 0 && !reordered}>
            {moved.length ? `Save · ${moved.length} ${moved.length === 1 ? 'player moves' : 'players move'}` : 'Save'}
          </Button>
        </span>
      </div>
    </form>
  );
}
