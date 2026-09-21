'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  addPlayerToTeam,
  removePlayerFromTeam,
  searchPlayerCandidates,
  setTeamCaptain,
  type PlayerCandidate,
} from '@/server/actions';
import { Avatar, Badge, Button, Field, FieldAction, inputClass } from './ui';

const UNREACHABLE = 'The server could not be reached. Check your connection and try again.';

/**
 * Adding a player is a two-step affair: search, then pick.
 *
 * Names on BeatLeader are not unique and the top hit is often not the person
 * meant, so nothing is added until the organiser has chosen from the list.
 */
export function AddPlayerForm({ teamId, teamName }: { teamId: string; teamName: string }) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<PlayerCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const dialog = useRef<HTMLDialogElement>(null);

  const open = candidates !== null;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    startSearch(async () => {
      // A rejected action inside a transition takes the whole page down with
      // it, and "the request did not get through" is not worth that.
      try {
        const result = await searchPlayerCandidates(teamId, query);
        setError(result.error ?? null);
        setCandidates(result.candidates);
      } catch {
        setError(UNREACHABLE);
        setCandidates((current) => current ?? []);
      }
    });
  }

  async function add(candidate: PlayerCandidate) {
    setAdding(candidate.beatLeaderId);
    let result: { error?: string };
    try {
      result = await addPlayerToTeam(teamId, candidate.beatLeaderId);
    } catch {
      result = { error: UNREACHABLE };
    }
    setAdding(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setQuery('');
    close();
  }

  function close() {
    setCandidates(null);
    setError(null);
  }

  return (
    <>
      <form
        onSubmit={search}
        className="mt-3 flex items-start gap-2 border-t border-[var(--color-edge)] pt-3"
      >
        <div className="flex-1">
          <Field label="Add player" hint="BeatLeader ID, profile link, or name to search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
        </div>
        <FieldAction>
          <Button type="submit" disabled={searching}>
            {searching ? 'Searching…' : 'Add'}
          </Button>
        </FieldAction>
      </form>

      <dialog
        ref={dialog}
        onClose={close}
        // A click that lands on the dialog itself, not its content, is the backdrop.
        onClick={(e) => e.target === e.currentTarget && close()}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-edge bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {open && (
          <div className="flex max-h-[min(36rem,80vh)] flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold tracking-tight">Add to {teamName}</h3>
                <p className="truncate text-xs text-muted">
                  {candidates.length === 0
                    ? `Nothing found for “${query}”`
                    : `Who did you mean by “${query}”?`}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-muted transition hover:bg-raised hover:text-ink"
              >
                ✕
              </button>
            </div>

            {error && (
              <p className="border-b border-edge bg-raised/60 px-4 py-2 text-xs text-warn">{error}</p>
            )}

            <ul className="overflow-y-auto p-2 text-sm">
              {candidates.map((c) => (
                <li key={c.beatLeaderId}>
                  <button
                    type="button"
                    disabled={c.onTeam || adding !== null}
                    onClick={() => add(c)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-raised disabled:cursor-not-allowed disabled:opacity-75 disabled:hover:bg-transparent"
                  >
                    <Avatar src={c.avatar} name={c.name} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{c.name}</span>
                        {c.linked && (
                          <Badge tone="accent" title="Has signed in here and linked this profile">
                            {c.accountName && c.accountName !== c.name
                              ? `Account: ${c.accountName}`
                              : 'Has account'}
                          </Badge>
                        )}
                      </span>
                      <span className="block truncate text-xs text-faint">
                        {[c.country, c.rank > 0 ? `#${c.rank.toLocaleString('en-US')}` : null, c.beatLeaderId]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="w-20 text-right text-xs tabular text-muted">
                      {c.onTeam
                        ? 'On team'
                        : adding === c.beatLeaderId
                          ? 'Adding…'
                          : c.pp > 0
                            ? `${Math.round(c.pp).toLocaleString('en-US')}pp`
                            : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </dialog>
    </>
  );
}

/** The per-row controls a roster manager gets: captain toggle and remove. */
export function MemberControls({
  memberId,
  playerName,
  teamName,
  isCaptain,
}: {
  memberId: string;
  playerName: string;
  teamName: string;
  isCaptain: boolean;
}) {
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  function run(action: () => Promise<void>) {
    setFailed(false);
    start(async () => {
      try {
        await action();
      } catch {
        setFailed(true);
      }
    });
  }

  const captainLabel = isCaptain
    ? `Remove ${playerName} as captain`
    : `Make ${playerName} captain of ${teamName}`;

  return (
    <span className="-mr-2 flex shrink-0 items-center" title={failed ? UNREACHABLE : undefined}>
      <button
        type="button"
        disabled={pending}
        aria-pressed={isCaptain}
        title={captainLabel}
        aria-label={captainLabel}
        onClick={() => run(() => setTeamCaptain(memberId, !isCaptain))}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-[13px] leading-none transition hover:bg-raised disabled:opacity-50 ${
          isCaptain ? 'text-accent' : 'text-faint hover:text-ink'
        }`}
      >
        {isCaptain ? '★' : '☆'}
      </button>
      <button
        type="button"
        disabled={pending}
        title={`Remove ${playerName} from ${teamName}`}
        aria-label={`Remove ${playerName} from ${teamName}`}
        onClick={() => {
          if (!window.confirm(`Remove ${playerName} from ${teamName}?`)) return;
          run(() => removePlayerFromTeam(memberId));
        }}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-[13px] leading-none transition hover:bg-red-600/20 hover:text-lose disabled:opacity-50 ${
          failed ? 'text-warn' : 'text-faint'
        }`}
      >
        ✕
      </button>
    </span>
  );
}
