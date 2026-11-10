import Link from 'next/link';
import type { TaLinkPhase, TaPhase, TaPlayerState } from '@bscs/core/match';
import { Badge, Button, pct, num } from './ui';
import { LocalTime } from './local-time';
import { taStartForm } from '@/server/match-actions';
import type { MatchView } from '@/server/matches';

type Planned = MatchView['plannedMaps'][number];

const PHASE: Record<TaPhase, { label: string; tone: 'neutral' | 'win' | 'lose' | 'warn' | 'accent' }> = {
  waiting: { label: 'Waiting for players', tone: 'warn' },
  loading: { label: 'Loading the map', tone: 'warn' },
  ready: { label: 'Everyone is ready', tone: 'win' },
  playing: { label: 'Playing', tone: 'accent' },
  finished: { label: 'Finished', tone: 'win' },
  error: { label: 'Stopped', tone: 'lose' },
};

const PLAYER: Record<TaPlayerState, { label: string; className: string }> = {
  loading: { label: 'loading', className: 'text-amber-300' },
  ready: { label: 'ready', className: 'text-green-300' },
  playing: { label: 'playing', className: 'text-violet-200' },
  finished: { label: 'finished', className: 'text-ink' },
  failed: { label: 'failed', className: 'text-lose' },
  quit: { label: 'left the song', className: 'text-lose' },
  missing: { label: 'not in TA', className: 'text-lose' },
};

/** What staff are shown about the tournament's TA link beside a map's start. */
export interface TaLinkSummary {
  /** `none`: no link set up. `noWorker`: set up, but the worker is not reporting. */
  phase: TaLinkPhase | 'none' | 'noWorker';
  message: string | null;
  /** Roster players connected to the TA tournament right now. */
  connected: string[];
  /** The TA tournament players join in game. */
  tournamentName: string | null;
}

/** Why maps cannot be started right now, in a sentence, or null when they can. */
function linkProblem(link: TaLinkSummary): string | null {
  switch (link.phase) {
    case 'ready':
      return null;
    case 'none':
      return 'This tournament is not connected to TournamentAssistant yet.';
    case 'off':
      return 'The TournamentAssistant link is switched off.';
    case 'noWorker':
      return 'The site\'s worker, which talks to TournamentAssistant, is not running.';
    case 'signIn':
      return 'The site is not signed in to TournamentAssistant.';
    case 'noTournament':
      return 'No TA tournament has been chosen for the players to join.';
    case 'connecting':
      return link.message ?? 'Connecting to TournamentAssistant…';
    case 'error':
      return link.message ?? 'The site cannot reach TournamentAssistant.';
  }
}

/**
 * One map's TournamentAssistant start: the buttons for staff, and how it is
 * going for everyone.
 *
 * Two presses. "Load map" puts the map on every lineup player's game (it
 * waits for anyone not connected yet). "Start song", once they all have it and
 * are in their headsets, starts it for all of them at the same moment. The
 * site's worker does the TA side and writes back what is shown here, then
 * enters the scores TA recorded.
 */
export function TaStart({
  match,
  planned,
  isNext,
  staff,
  playerName,
  visible,
  link,
}: {
  match: MatchView;
  planned: Planned;
  /** This is the map to play next: the first whose scores are open. */
  isNext: boolean;
  staff: boolean;
  playerName: (playerId: string) => string;
  /** Players whose lineup this viewer may see: a hidden lineup stays hidden here too. */
  visible: (playerId: string) => boolean;
  /** The TA link as staff see it; null for everyone else. */
  link: TaLinkSummary | null;
}) {
  const { start } = planned;
  if (!planned.matchMapId || match.state === 'COMPLETE') return null;
  const taPage = `/t/${match.tournament.slug}/ta`;

  const button = (
    step: 'start' | 'play' | 'restart' | 'cancel',
    label: string,
    variant: 'primary' | 'ghost',
    title: string,
  ) => (
    <form action={taStartForm}>
      <input type="hidden" name="matchId" value={match.id} />
      <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
      <input type="hidden" name="step" value={step} />
      <Button type="submit" variant={variant} title={title} className={step === 'start' || step === 'play' ? 'h-10 px-4' : 'h-8 text-xs'}>
        {label}
      </Button>
    </form>
  );
  const problem = link ? linkProblem(link) : null;
  const linkWarning = staff && problem && (
    <p className="text-xs text-warn">
      {problem}{' '}
      <Link href={taPage} className="underline">
        Open the TA page
      </Link>
    </p>
  );
  const lineup = [match.teamA.id, match.teamB.id].flatMap((id) => planned.lineups[id] ?? []).filter(visible);

  if (!start) {
    if (!isNext || planned.scoresClosed) return null;
    const ready = [match.teamA.id, match.teamB.id].every(
      (id) => (planned.lineups[id] ?? []).length >= match.format.playersPerMap,
    );
    if (!staff) {
      return (
        <p className="text-xs text-muted">
          An organiser starts this map in TournamentAssistant for everyone at once, once both lineups are set. Be in the
          {link?.tournamentName ? ` "${link.tournamentName}"` : ''} TA tournament in game.
        </p>
      );
    }
    const connected = new Set(link?.connected ?? []);
    return (
      <div className="space-y-2">
        {linkWarning}
        {ready ? (
          <div className="flex flex-wrap items-center gap-3">
            {button('start', 'Load map in TA', 'primary', 'Put this map on every lineup player\'s game, ready to start')}
            <span className="text-xs text-muted">
              Loads the map for both lineups. The song starts on a second press, when everyone is ready.
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted">Set both teams&apos; lineups to load this map in TournamentAssistant.</p>
        )}
        {link?.phase === 'ready' && lineup.length > 0 && (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span className="text-faint">In TA:</span>
            {lineup.map((id) => (
              <span key={id} className={connected.has(id) ? 'text-green-300' : 'text-lose'} title={connected.has(id) ? 'Connected to the TA tournament' : 'Not connected to the TA tournament'}>
                {connected.has(id) ? '●' : '○'} {playerName(id)}
              </span>
            ))}
          </p>
        )}
      </div>
    );
  }

  const status = start.status;
  const at = new Date(start.requestedAt).toISOString();
  if (planned.scoresClosed) {
    return (
      <p className="text-xs text-faint">
        Played in TA, started by {start.requestedBy?.name ?? 'an organiser'} at <LocalTime at={at} />.
      </p>
    );
  }
  const players = (status?.players ?? []).filter((p) => visible(p.playerId));
  const phase = status?.phase;
  return (
    <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {status ? <Badge tone={PHASE[status.phase].tone}>TA: {PHASE[status.phase].label}</Badge> : <Badge>TA</Badge>}
        <span className="text-muted">
          {phase === 'playing' && status?.startedAt ? (
            <>
              Song started at <LocalTime at={status.startedAt} />
            </>
          ) : (
            <>
              Asked for by {start.requestedBy?.name ?? 'an organiser'} at <LocalTime at={at} />
              {!status && ', waiting for TournamentAssistant…'}
            </>
          )}
        </span>
        {staff && (
          <span className="ml-auto flex items-center gap-2">
            {button(
              'restart',
              phase === 'finished' ? 'Play it again' : 'Restart map',
              'ghost',
              phase === 'finished'
                ? 'Load the map again and play it over: the new scores replace these'
                : 'Send the players back to the menu and load the map again',
            )}
            {button('cancel', 'Cancel', 'ghost', 'Take the request back: players in the song or holding the map go back to the menu')}
          </span>
        )}
      </div>
      {linkWarning}
      {phase === 'ready' && staff && (
        <div className="flex flex-wrap items-center gap-3">
          {button('play', 'Start song', 'primary', 'Start the song for every player at the same moment')}
          <span className="text-xs text-muted">Everyone has the map. Press when the players are in their headsets and ready.</span>
        </div>
      )}
      {phase === 'ready' && !staff && <p className="text-xs text-muted">Everyone has the map. An organiser starts the song.</p>}
      {phase === 'error' && <p className="text-xs text-lose">{status?.message || 'TournamentAssistant could not start the map.'}</p>}
      {phase === 'finished' && staff && (
        <p className="text-xs text-muted">The scores below came from TournamentAssistant. The map was left open: check them, then close it.</p>
      )}
      {status && phase !== 'error' && status.message && <p className="text-xs text-muted">{status.message}</p>}
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
