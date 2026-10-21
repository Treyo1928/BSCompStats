'use client';

import { useState } from 'react';
import { saveLineup } from '@/server/match-actions';
import type { MatchScore } from '@/server/matches';
import { goName } from '@/lib/goes';
import { Avatar, Button, pct, num, teamInk } from './ui';

/**
 * Picks the players a team fields on one map, and shows what each scored.
 *
 * Validation is server-side - the duo rule spans every map, so no single
 * control can judge it - and what it objects to is shown right here.
 */
export function LineupEditor({
  matchId,
  matchMapId,
  team,
  selected,
  playersPerMap,
  scores,
  goCount = 1,
  doubleFails = false,
  canEdit,
  canOverride,
  hidden,
  ruleBreaks,
  reveal,
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
  scores: MatchScore[];
  /** Goes at the map so far: above 1, each score says which go it is from. */
  goCount?: number;
  /** A fail counts doubled back from No Fail's halving. */
  doubleFails?: boolean;
  canEdit: boolean;
  canOverride: boolean;
  /** The rules this saved lineup was pushed through in spite of, if any. */
  ruleBreaks?: string;
  /** Set when this team's lineup is being kept from the viewer; says why. */
  hidden?: string;
  /** For an organiser playing in the match: a deliberate look at the hidden card. */
  reveal?: { href: string; label: string };
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

  const scoreBy = new Map(scores.map((s) => [s.playerId, s]));
  // Exactly enough players for a map: everyone plays, so there is nothing to pick.
  const forced = team.players.length === playersPerMap;
  const editable = canEdit && !forced;

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
      </div>

      {hidden && <p className="px-1 py-2 text-xs text-muted">{hidden}</p>}
      {hidden && reveal && (
        <a
          href={reveal.href}
          className="block px-1 pb-1 text-[11px] text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:decoration-amber-300"
          title="For correcting a mistake."
        >
          {reveal.label}
        </a>
      )}
      {ruleBreaks && !hidden && (
        <p
          className="mb-1 rounded-md bg-amber-500/12 px-2 py-1 text-[11px] text-amber-200"
          title={ruleBreaks}
        >
          Saved with the rules overridden: {ruleBreaks}
        </p>
      )}

      <div className="space-y-1" hidden={Boolean(hidden)}>
        {team.players.map((player) => {
          const isChosen = chosen.includes(player.id);
          const score = scoreBy.get(player.id);
          return (
            <button
              key={player.id}
              type="button"
              disabled={!editable || !matchMapId}
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
              </span>
              {score && (
                <span
                  className="shrink-0 text-right tabular text-xs"
                  title={[
                    score.source === 'AUTO' ? 'From BeatLeader' : 'Entered by hand',
                    score.endType && score.endType !== 'CLEAR' ? `run ${score.endType.toLowerCase()}` : null,
                    score.failed
                      ? doubleFails
                        ? 'Failed: No Fail halved it, so it counts doubled'
                        : 'Failed: No Fail kicked in; it counts as scored'
                      : null,
                    goCount > 1 ? `Counted from the ${goName(score.attempt, goCount).toLowerCase()}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  {goCount > 1 && (
                    <span className="mr-1.5 rounded bg-edge px-1 text-[10px] font-semibold text-muted">{goName(score.attempt, goCount)}</span>
                  )}
                  {score.points != null && <span className="mr-1.5 font-semibold text-ink">{score.points.toFixed(2)}</span>}
                  {num(score.score)} <span className="opacity-70">{pct(score.accuracy)}</span>
                  {score.failed && (
                    <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-300">
                      {doubleFails ? 'NF ×2' : 'NF'}
                    </span>
                  )}
                  {score.endType && score.endType !== 'CLEAR' && <span className="ml-1 text-lose">✗</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!hidden && scores.some((s) => s.replayUrl) && (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px]">
          {scores
            .filter((s) => s.replayUrl)
            .map((s) => (
              <a
                key={s.playerId}
                href={s.replayUrl!}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                ▶ {s.playerName}&apos;s replay
              </a>
            ))}
        </p>
      )}

      {forced && !hidden && (
        <p className="mt-1.5 px-1 text-[11px] text-faint">
          {team.players.length === 1 ? 'Their only player plays every map.' : `All ${team.players.length} of them play every map.`}
        </p>
      )}

      {editable && matchMapId && (
        <form
          action={async (formData) => {
            setSaving(true);
            setError(null);
            try {
              const result = await saveLineup(formData);
              if (result.error) setError(result.error);
            } catch {
              setError('Could not save the lineup. Reload the page and try again.');
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
                  className="flex items-center gap-1.5 text-xs text-amber-300"
                  title="Save this lineup even though it breaks the rules. What was overridden is kept on the lineup for the organisers to see."
                >
                  <input type="checkbox" name="override" />
                  Save anyway
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
