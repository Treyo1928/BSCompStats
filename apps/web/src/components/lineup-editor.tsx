'use client';

import { useState } from 'react';
import { saveLineup } from '@/server/match-actions';
import { Avatar, Button, pct, num, teamInk } from './ui';

/**
 * Picks the players a team fields on one map.
 *
 * Validation is server-side - the duo rule spans every map, so no single
 * control can judge it - but the UI shows the recommendation inline and warns
 * before submitting, so a captain is steered rather than only scolded.
 */
export function LineupEditor({
  matchId,
  matchMapId,
  team,
  selected,
  playersPerMap,
  scores,
  canEdit,
  canOverride,
  recommended,
}: {
  matchId: string;
  matchMapId: string | null;
  team: {
    id: string;
    name: string;
    color: string;
    colorSecondary: string | null;
    players: Array<{ id: string; name: string; avatar: string | null }>;
  };
  selected: string[];
  playersPerMap: number;
  scores: Array<{ playerId: string; playerName: string; score: number; accuracy: number }>;
  canEdit: boolean;
  canOverride: boolean;
  recommended?: string[];
}) {
  const [chosen, setChosen] = useState<string[]>(selected);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggle = (playerId: string) => {
    setError(null);
    setChosen((prev) =>
      prev.includes(playerId)
        ? prev.filter((id) => id !== playerId)
        : prev.length >= playersPerMap
          ? // Replace the oldest choice rather than refusing the click - the
            // captain clearly wants this player on the map.
            [...prev.slice(1), playerId]
          : [...prev, playerId],
    );
  };

  const recommendedSet = new Set(recommended ?? []);
  const scoreBy = new Map(scores.map((s) => [s.playerId, s]));

  return (
    <div
      className="rounded-lg border border-edge bg-raised/30 p-2"
      style={{ borderTop: `2px solid ${team.color}` }}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: teamInk(team.color, team.colorSecondary) }}
        >
          {team.name}
        </span>
        {recommended && recommended.length > 0 && (
          <span
            className="truncate text-[10px] text-muted"
            title="What the optimiser suggests for this map"
          >
            suggested: {recommended.map((id) => team.players.find((p) => p.id === id)?.name ?? id).join(' + ')}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {team.players.map((player) => {
          const isChosen = chosen.includes(player.id);
          const score = scoreBy.get(player.id);
          return (
            <button
              key={player.id}
              type="button"
              disabled={!canEdit || !matchMapId}
              onClick={() => toggle(player.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-sm transition ${
                isChosen
                  ? 'bg-accent/20 text-ink ring-1 ring-inset ring-accent/40'
                  : 'text-muted enabled:hover:bg-edge'
              } disabled:cursor-default`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar
                  src={player.avatar}
                  name={player.name}
                  size={22}
                  ring={isChosen ? team.color : undefined}
                />
                <span className="truncate">{player.name}</span>
                {recommendedSet.has(player.id) && !isChosen && (
                  <span className="text-[10px] text-accent" title="Suggested by the optimiser">★</span>
                )}
              </span>
              {score && (
                <span className="shrink-0 tabular text-xs">
                  {num(score.score)}{' '}
                  <span className="opacity-70">{pct(score.accuracy)}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {canEdit && matchMapId && (
        <form
          action={async (formData) => {
            setSaving(true);
            setError(null);
            try {
              await saveLineup(formData);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setSaving(false);
            }
          }}
          className="mt-2 space-y-2"
        >
          <input type="hidden" name="matchId" value={matchId} />
          <input type="hidden" name="matchMapId" value={matchMapId} />
          <input type="hidden" name="teamId" value={team.id} />
          {chosen.map((id) => (
            <input key={id} type="hidden" name="playerId" value={id} />
          ))}

          {error && (
            <p className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-300">{error}</p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted">
              {chosen.length}/{playersPerMap} chosen
            </span>
            <div className="flex items-center gap-2">
              {canOverride && error && (
                <label
                  className="flex items-center gap-1 text-[10px] text-amber-300"
                  title="Force an illegal lineup through. Recorded in the match log."
                >
                  <input type="checkbox" name="override" />
                  override
                </label>
              )}
              <Button type="submit" disabled={saving} variant="ghost">
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
