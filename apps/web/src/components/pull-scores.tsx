'use client';

import { useState } from 'react';
import { pullMapScores, savePulledRuns, type PullPlayer } from '@/server/match-actions';
import { Button, pct } from './ui';

/**
 * Fill a map's scores in from BeatLeader. Press it any time after the song -
 * and again, as often as needed: whoever has finished is saved, anyone who has
 * not is listed as waiting, and the next press picks them up. A run that wants
 * a person's eye is listed to be chosen, never saved on a guess.
 */
export function PullScores({
  matchId,
  matchMapId,
  replays,
}: {
  matchId: string;
  matchMapId: string;
  /** Replays called on the map: a pull fills in the latest run. */
  replays: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [players, setPlayers] = useState<PullPlayer[] | null>(null);
  const [pulledAt, setPulledAt] = useState<Date | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});

  const runLabel = replays === 0 ? 'scores' : replays === 1 ? 'replay scores' : `replay ${replays} scores`;

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await pullMapScores(matchId, matchMapId);
      if (outcome.status === 'error') {
        setError(outcome.error);
        return;
      }
      setPlayers(outcome.players);
      setPulledAt(new Date());
      setChoices(
        Object.fromEntries(
          outcome.players.filter((p) => p.status === 'CHECK' && p.chosenId != null).map((p) => [p.playerId, p.chosenId!]),
        ),
      );
    } catch {
      setError('Could not reach the server. Reload the page and try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveChosen = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await savePulledRuns(
        matchId,
        matchMapId,
        Object.entries(choices).map(([playerId, runId]) => ({ playerId, runId })),
      );
      if (result.error) setError(result.error);
      else {
        setChoices({});
        setPlayers((current) =>
          current?.map((p) => (p.playerId in choices ? { ...p, status: 'SAVED', notes: ['Saved the run you chose.'] } : p)) ??
          null,
        );
      }
    } catch {
      setError('Could not reach the server. Reload the page and try again.');
    } finally {
      setBusy(false);
    }
  };

  const waiting = players?.filter((p) => p.status === 'WAITING').length ?? 0;
  const pickable = players?.filter((p) => (p.status === 'CHECK' || p.status === 'WAITING') && p.candidates.length > 0) ?? [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={players && waiting === 0 ? 'ghost' : 'primary'}
          className="h-8"
          disabled={busy}
          onClick={pull}
          title="Take every fielded player's run on this map from BeatLeader - the runs that started together since the map opened. Press again as often as you like: it fills in whoever has finished since."
        >
          {busy ? 'Asking BeatLeader…' : players ? `Pull ${runLabel} again` : `Pull ${runLabel} from BeatLeader`}
        </Button>
        {pulledAt && (
          <span className="text-xs text-faint">
            last pulled {pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-lose" role="status">
          {error}
        </p>
      )}

      {players && (
        <ul className="space-y-1.5 rounded-lg border border-edge bg-panel/50 p-2 text-xs">
          {players.map((p) => (
            <li key={p.playerId}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <StatusDot status={p.status} />
                <span className="font-medium text-ink">{p.playerName}</span>
                <span className="text-faint">{p.teamNames.join(' & ')}</span>
                <span className={STATUS[p.status].tone}>{STATUS[p.status].label}</span>
              </div>
              {p.notes.map((note) => (
                <p key={note} className="ml-4 text-muted">
                  {note}
                </p>
              ))}
              {(p.status === 'CHECK' || p.status === 'WAITING') && p.candidates.length > 0 && (
                <div className="ml-4 mt-1 space-y-0.5">
                  {p.candidates.slice(0, 5).map((run) => (
                    <label key={run.id} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name={`run-${matchMapId}-${p.playerId}`}
                        checked={choices[p.playerId] === run.id}
                        onChange={() => setChoices((c) => ({ ...c, [p.playerId]: run.id }))}
                      />
                      <span className="tabular">{run.score.toLocaleString('en-US')}</span>
                      <span className="tabular text-muted">{pct(run.accuracy)}</span>
                      <span className={run.endType === 'CLEAR' ? 'text-muted' : 'text-amber-300'}>
                        {run.endType === 'CLEAR' ? 'cleared' : `${run.endType.toLowerCase()} at ${clock(run.time)}`}
                      </span>
                      <span className="text-faint">ended {agoText(run.timeset)}</span>
                    </label>
                  ))}
                  {p.playerId in choices && (
                    <button
                      type="button"
                      className="text-muted underline decoration-faint underline-offset-2 hover:text-ink"
                      onClick={() =>
                        setChoices((c) => {
                          const next = { ...c };
                          delete next[p.playerId];
                          return next;
                        })
                      }
                    >
                      Don&apos;t use any of these
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
          {pickable.length > 0 && Object.keys(choices).length > 0 && (
            <li className="pt-1">
              <Button type="button" className="h-8" disabled={busy} onClick={saveChosen}>
                Save the {Object.keys(choices).length === 1 ? 'run' : 'runs'} chosen
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const STATUS: Record<PullPlayer['status'], { label: string; tone: string }> = {
  SAVED: { label: 'saved', tone: 'text-win' },
  KEPT: { label: 'kept as typed', tone: 'text-muted' },
  CHECK: { label: 'needs a look - not saved', tone: 'text-amber-300' },
  WAITING: { label: 'waiting', tone: 'text-faint' },
};

function StatusDot({ status }: { status: PullPlayer['status'] }) {
  const color =
    status === 'SAVED' ? 'bg-win' : status === 'CHECK' ? 'bg-amber-400' : status === 'KEPT' ? 'bg-muted' : 'bg-edge-strong';
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function agoText(unixSeconds: number): string {
  const ago = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.round(ago / 60)} min ago`;
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
