'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { AnswerCardResult } from '@bscs/core/optimize';
import { answerOpponentCardAction } from '@/server/answer-card';
import { Avatar, Button, num, pct, teamInk } from './ui';

interface Player {
  id: string;
  name: string;
  avatar: string | null;
}

interface Team {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  players: Player[];
}

interface PlannedMap {
  poolMapId: string;
  name: string;
  isTiebreaker: boolean;
  /** What the other side has actually set, where it is known - the starting point of a guess. */
  known?: string[];
}

/**
 * "If they field this, what should we field?"
 *
 * The lineup panel assumes the other captain answers our card with their best.
 * That is the right default and the wrong answer when the captain knows
 * better: the other card is visible, or a scouting report says who plays what.
 * Here they set the opponent's card themselves and get the best answer to it.
 */
export function AnswerCard({
  matchId,
  us,
  them,
  maps,
  playersPerMap,
}: {
  matchId: string;
  us: Team;
  them: Team;
  maps: PlannedMap[];
  playersPerMap: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [guess, setGuess] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(maps.map((m) => [m.poolMapId, m.known ?? []])),
  );
  const [result, setResult] = useState<AnswerCardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, start] = useTransition();

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const toggle = (mapId: string, playerId: string) => {
    setResult(null);
    setGuess((current) => {
      const group = current[mapId] ?? [];
      const next = group.includes(playerId)
        ? group.filter((id) => id !== playerId)
        : group.length >= playersPerMap
          ? [...group.slice(1), playerId]
          : [...group, playerId];
      return { ...current, [mapId]: next };
    });
  };

  const filled = maps.filter((m) => (guess[m.poolMapId] ?? []).length === playersPerMap).length;

  function run() {
    setError(null);
    start(async () => {
      try {
        const answer = await answerOpponentCardAction(matchId, us.id, guess);
        if (answer.error) setError(answer.error);
        else setResult(answer.result ?? null);
      } catch {
        setError('The server could not be reached. Check your connection and try again.');
      }
    });
  }

  const nameOf = new Map([...us.players, ...them.players].map((p) => [p.id, p.name]));
  const names = (ids: readonly string[] | undefined) => (ids ?? []).map((id) => nameOf.get(id) ?? id).join(' + ');
  const themInk = teamInk(them.color, them.colorSecondary);
  const usInk = teamInk(us.color, us.colorSecondary);

  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="w-full">
        If {them.name} fields…
      </Button>

      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        className="m-auto w-[min(44rem,calc(100vw-1.5rem))] rounded-2xl border border-edge bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {open && (
          <div className="flex max-h-[min(50rem,90vh)] flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold tracking-tight">
                  If <span style={{ color: themInk }}>{them.name}</span> fields…
                </h3>
                <p className="text-xs text-muted">
                  Set what you expect them to play, and get {us.name}&apos;s best answer to it. A map you leave blank is
                  filled with what their captain would most likely do given the ones you set.
                </p>
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

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ul className="space-y-3">
                {maps.map((map) => {
                  const chosen = guess[map.poolMapId] ?? [];
                  const answer = result?.winProbability;
                  const outcome = answer?.perMap[map.poolMapId];
                  return (
                    <li key={map.poolMapId} className="rounded-lg border border-edge bg-raised/30 p-2.5">
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {map.name}
                          {map.isTiebreaker && <span className="ml-1 text-[10px] text-faint">TB</span>}
                        </span>
                        <span className="shrink-0 text-[10px] text-faint">
                          {chosen.length === playersPerMap
                            ? map.known && [...chosen].sort().join() === [...map.known].sort().join()
                              ? 'as they set it'
                              : 'your guess'
                            : result && answer?.opponentLineups[map.poolMapId]
                              ? 'inferred'
                              : `${chosen.length}/${playersPerMap}`}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {chosen.length < playersPerMap && answer?.opponentLineups[map.poolMapId] && (
                          <button
                            type="button"
                            data-inline
                            onClick={() => {
                              setResult(null);
                              setGuess((current) => ({ ...current, [map.poolMapId]: [...answer.opponentLineups[map.poolMapId]!] }));
                            }}
                            className="inline-flex h-8 items-center rounded-full border border-dashed border-edge-strong px-2 text-xs text-muted hover:border-faint hover:text-ink"
                            title="Keep this inferred lineup as your guess, so it stays fixed while you change others"
                          >
                            Keep inferred
                          </button>
                        )}
                        {them.players.map((p) => {
                          const on = chosen.includes(p.id);
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => toggle(map.poolMapId, p.id)}
                              aria-pressed={on}
                              data-inline
                              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2 text-xs transition ${
                                on ? 'border-transparent text-surface' : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
                              }`}
                              style={on ? { background: themInk } : undefined}
                            >
                              <Avatar src={p.avatar} name={p.name} size={18} />
                              {p.name}
                            </button>
                          );
                        })}
                      </div>
                      {answer && outcome && (
                        <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-edge/60 pt-2 text-xs">
                          <span>
                            {chosen.length < playersPerMap && (
                              <span className="mr-2">
                                <span className="text-faint">They&apos;d likely play </span>
                                <span className="font-medium" style={{ color: themInk }}>
                                  {names(answer.opponentLineups[map.poolMapId])}
                                </span>
                                <span className="text-faint"> · </span>
                              </span>
                            )}
                            <span className="text-faint">Answer: </span>
                            <span className="font-medium" style={{ color: usInk }}>
                              {names(answer.lineups[map.poolMapId])}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 tabular ${
                              answer.conceded.includes(map.poolMapId)
                                ? 'text-amber-300'
                                : outcome.winProbability >= 0.5
                                  ? 'text-win'
                                  : 'text-lose'
                            }`}
                          >
                            {pct(outcome.winProbability, 0)}
                            <span className="ml-1 text-faint">
                              {outcome.expectedMargin >= 0 ? '+' : '−'}
                              {num(Math.round(Math.abs(outcome.expectedMargin)))}
                            </span>
                            {answer.conceded.includes(map.poolMapId) && <span className="ml-1 font-medium">conceding</span>}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {error && <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</p>}
              {result?.infeasible && !result.winProbability && (
                <p className="mt-3 text-sm text-amber-300">{result.infeasible}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3">
              <div className="text-sm">
                {result?.winProbability ? (
                  <>
                    <span className="text-muted">Against that card, </span>
                    <span className="font-semibold" style={{ color: usInk }}>
                      {us.name}
                    </span>{' '}
                    <span className="font-semibold tabular">{pct(result.winProbability.winProbability, 1)}</span>
                    <span className="text-muted"> to win</span>
                    {result.expectedMargin &&
                      result.expectedMargin.winProbability < result.winProbability.winProbability - 0.01 && (
                        <span className="block text-xs text-faint">
                          Chasing points instead ({names(Object.values(result.expectedMargin.lineups)[0])} first) would
                          cost {pct(result.winProbability.winProbability - result.expectedMargin.winProbability, 1)}.
                        </span>
                      )}
                  </>
                ) : (
                  <span className="text-xs text-muted">
                    {filled} of {maps.length} maps set
                    {filled < maps.length ? ' - the rest will be inferred from what their captain would likely do' : ''}
                  </span>
                )}
              </div>
              <Button type="button" onClick={run} disabled={working}>
                {working ? 'Working it out…' : result ? 'Run again' : 'Best answer'}
              </Button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
