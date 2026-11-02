import type { TaPhase, TaPlayerState } from '@bscs/core/match';
import { Badge, Button, pct, num } from './ui';
import { LocalTime } from './local-time';
import { taStartForm } from '@/server/match-actions';
import type { MatchView } from '@/server/matches';

type Planned = MatchView['plannedMaps'][number];

const PHASE: Record<TaPhase, { label: string; tone: 'neutral' | 'win' | 'lose' | 'warn' | 'accent' }> = {
  waiting: { label: 'Waiting for players', tone: 'neutral' },
  loading: { label: 'Loading', tone: 'warn' },
  playing: { label: 'Playing', tone: 'accent' },
  finished: { label: 'Finished', tone: 'win' },
  error: { label: 'Error', tone: 'lose' },
};

const PLAYER: Record<TaPlayerState, { label: string; className: string }> = {
  loading: { label: 'loading', className: 'text-amber-300' },
  ready: { label: 'ready', className: 'text-green-300' },
  playing: { label: 'playing', className: 'text-violet-200' },
  finished: { label: 'finished', className: 'text-ink' },
  failed: { label: 'failed', className: 'text-lose' },
  missing: { label: 'not in TA', className: 'text-lose' },
};

/**
 * One map's TournamentAssistant start: the button for staff, then the request
 * and whatever the TA bridge reports about it, for everyone.
 *
 * The site does not start anything itself. Pressing the button records the
 * request; the bridge, following the match over the API, starts the song in TA
 * and reports back here.
 */
export function TaStart({
  match,
  planned,
  isNext,
  staff,
  playerName,
  visible,
}: {
  match: MatchView;
  planned: Planned;
  /** This is the map to play next: the first whose scores are open. */
  isNext: boolean;
  staff: boolean;
  playerName: (playerId: string) => string;
  /** Players whose lineup this viewer may see: a hidden lineup stays hidden here too. */
  visible: (playerId: string) => boolean;
}) {
  const { start } = planned;
  if (!planned.matchMapId || match.state === 'COMPLETE') return null;

  const button = (step: 'start' | 'restart' | 'cancel', label: string, variant: 'primary' | 'ghost', title: string) => (
    <form action={taStartForm}>
      <input type="hidden" name="matchId" value={match.id} />
      <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
      <input type="hidden" name="step" value={step} />
      <Button type="submit" variant={variant} title={title} className={step === 'start' ? 'h-10 px-4' : 'h-8 text-xs'}>
        {label}
      </Button>
    </form>
  );

  if (!start) {
    if (!isNext || planned.scoresClosed) return null;
    const ready = [match.teamA.id, match.teamB.id].every(
      (id) => (planned.lineups[id] ?? []).length >= match.format.playersPerMap,
    );
    if (!staff) {
      return (
        <p className="text-xs text-muted">
          An organiser starts this map in TournamentAssistant for everyone at once, once both lineups are set.
        </p>
      );
    }
    return ready ? (
      <div className="flex flex-wrap items-center gap-3">
        {button('start', 'Start map in TA', 'primary', 'Ask the TA bridge to start this map for every player in both lineups at once')}
        <span className="text-xs text-muted">Both lineups are set. TA starts the song for all of them together.</span>
      </div>
    ) : (
      <p className="text-xs text-muted">Set both teams&apos; lineups to start this map in TournamentAssistant.</p>
    );
  }

  const status = start.status;
  const at = new Date(start.requestedAt).toISOString();
  if (planned.scoresClosed) {
    return (
      <p className="text-xs text-faint">
        Started in TA by {start.requestedBy?.name ?? 'an organiser'} at <LocalTime at={at} />.
      </p>
    );
  }
  const players = (status?.players ?? []).filter((p) => visible(p.playerId));
  return (
    <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {status ? <Badge tone={PHASE[status.phase].tone}>TA: {PHASE[status.phase].label}</Badge> : <Badge>TA</Badge>}
        <span className="text-muted">
          Start requested by {start.requestedBy?.name ?? 'an organiser'} at <LocalTime at={at} />
          {status ? (
            <>
              {' · '}last word from TA at <LocalTime at={status.reportedAt} />
            </>
          ) : (
            ', waiting for TA…'
          )}
        </span>
        {staff && (
          <span className="ml-auto flex items-center gap-2">
            {status && button('restart', 'Restart map', 'ghost', 'Ask TA to start this map again, after a failed or aborted start')}
            {button('cancel', 'Cancel', 'ghost', 'Take the start request back')}
          </span>
        )}
      </div>
      {status?.phase === 'error' && (
        <p className="text-xs text-lose">{status.message || 'TA reported an error.'}</p>
      )}
      {status && status.phase !== 'error' && status.message && <p className="text-xs text-muted">{status.message}</p>}
      {players.length > 0 && (
        <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
          {players.map((p) => (
            <li key={p.playerId} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">{playerName(p.playerId)}</span>
              <span className="shrink-0 tabular">
                {p.score != null && <span className="mr-1.5 text-muted">{num(p.score)}</span>}
                {p.accuracy != null && <span className="mr-1.5 text-muted">{pct(p.accuracy)}</span>}
                <span className={PLAYER[p.state].className}>{PLAYER[p.state].label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
