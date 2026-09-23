import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can, isCaptainOf, isStaff } from '@/server/match-helpers';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Badge,
  FormError,
  inputClass,
  AvatarStack,
  DifficultyChip,
  MapCover,
  teamInk,
  teamWash,
  pct,
  num,
} from '@/components/ui';
import { LiveBadge } from '@/components/live-badge';
import { PlayerAvatarStack } from '@/components/player-card';
import { MatchLive } from '@/components/match-live';
import { getMatchSummary } from '@/server/summaries';
import { ConfirmButton } from '@/components/confirm-button';
import { loadMatch, type MatchView } from '@/server/matches';
import { getActorOrAnonymous } from '@/server/session';
import {
  submitPickBan,
  undoLastAction,
  saveScores,
  deleteMatch,
  callReplay,
  cancelReplay,
  completeMatch,
  reopenMatch,
  closeMapScores,
  reopenMapScores,
} from '@/server/match-actions';
import { LineupEditor } from '@/components/lineup-editor';
import { PullScores } from '@/components/pull-scores';
import { PointsCalculator } from '@/components/points-calculator';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; matchId: string }>;
}): Promise<Metadata> {
  const { slug, matchId } = await params;
  const match = await getMatchSummary(slug, matchId);
  if (!match) return {};

  const title = `${match.teamA.name} vs ${match.teamB.name} - ${match.tournamentName}`;
  const description = [
    match.status,
    match.maps.length
      ? `Maps: ${match.maps.map((m) => (m.isTiebreaker ? `${m.name} (tiebreaker)` : m.name)).join(', ')}`
      : `Pool: ${match.poolName}`,
    `${match.teamA.name}: ${match.teamA.players.join(', ')}`,
    `${match.teamB.name}: ${match.teamB.players.join(', ')}`,
  ].join('. ');
  return { title, description, openGraph: { title, description } };
}

export default async function MatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; matchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug, matchId } = await params;
  const { error: formError } = await searchParams;

  const match = await loadMatch(matchId);
  if (!match || match.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(match.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: match.tournament.isPublic })) notFound();

  const canAct = match.pending
    ? can(actor, 'MAKE_PICK_BAN', { teamId: match.pending.teamId })
    : false;
  const pendingTeam =
    match.pending?.teamId === match.teamA.id ? match.teamA : match.teamB;

  // Say in what capacity the viewer can touch this match. Staff can act for
  // both sides, and without being told so that looks exactly like a bug.
  const captainedTeams = [match.teamA, match.teamB].filter((t) => isCaptainOf(actor, t.id));
  const capacity = isStaff(actor)
    ? `You are ${actor.globalRole === 'ADMIN' ? 'a site admin' : 'an organiser'}${
        captainedTeams.length > 0 ? ` and captain of ${captainedTeams.map((t) => t.name).join(' and ')}` : ''
      }, so you can pick, ban and set lineups for both teams. Anything you do for a team you do not captain is recorded as made on its captain's behalf.`
    : captainedTeams.length > 0
      ? `You captain ${captainedTeams.map((t) => t.name).join(' and ')}. You can pick, ban and set lineups for your own team only, and only on its turn.`
      : actor.userId
        ? 'You are watching. Only team captains and organisers can pick, ban or set lineups.'
        : null;

  // Hidden lineups: until both teams have set every map, each side sees only
  // its own. Organisers see and set both, even when playing in the match.
  const rosterSpots = actor.userId
    ? await prisma.teamMember.findMany({
        where: { teamId: { in: [match.teamA.id, match.teamB.id] }, player: { userId: actor.userId } },
        select: { teamId: true },
      })
    : [];
  const mySides = new Set([
    ...rosterSpots.map((spot) => spot.teamId),
    ...[match.teamA.id, match.teamB.id].filter((id) => isCaptainOf(actor, id)),
  ]);
  const everyLineupSet =
    !match.pending &&
    match.plannedMaps.length > 0 &&
    match.plannedMaps.every((pm) =>
      [match.teamA.id, match.teamB.id].every(
        (id) => (pm.lineups[id] ?? []).length >= match.format.playersPerMap,
      ),
    );
  const lineupsRevealed = !match.blindLineups || everyLineupSet || match.state === 'COMPLETE';
  // Organisers see and set both cards, even while playing in the match themselves.
  const canSeeLineup = (teamId: string) => lineupsRevealed || isStaff(actor) || mySides.has(teamId);

  const replaysUsed = new Map<string, number>();
  for (const pm of match.plannedMaps) {
    for (const id of pm.replayCalledByTeamIds) replaysUsed.set(id, (replaysUsed.get(id) ?? 0) + 1);
  }

  const coverOf = new Map(match.pool.maps.map((m) => [m.poolMapId, m.coverImage]));
  const stateLabel: Record<string, string> = {
    SETUP: 'Setup',
    PICKBAN: 'Pick / ban',
    PLAYING: 'In play',
    COMPLETE: 'Final',
  };

  return (
    <div className="space-y-6">
      <MatchLive matchId={match.id} />
      <PageHeader
        crumbs={[{ label: match.tournament.name, href: `/t/${slug}` }]}
        title={match.name}
        meta={
          <>
            {match.pool.name} · {match.format.name}
            {match.coinFlipWinnerId && (
              <>
                {' · coin flip: '}
                {match.coinFlipWinnerId === match.teamA.id ? match.teamA.name : match.teamB.name}
              </>
            )}
          </>
        }
        actions={
          <>
            <LiveBadge poolId={match.pool.id} />
            {can(actor, 'CREATE_MATCH') && (
              <form action={deleteMatch}>
                <input type="hidden" name="matchId" value={match.id} />
                <ConfirmButton
                  question={`Delete ${match.name}?\n\nIts picks, bans, lineups and scores go with it. This cannot be undone.`}
                  className="inline-flex h-9 items-center rounded-lg border border-edge px-3 text-sm font-medium text-muted transition hover:border-red-400/50 hover:text-lose"
                >
                  Delete match
                </ConfirmButton>
              </form>
            )}
          </>
        }
      />

      {/* Score and replay actions report back here; without this the page just reloaded and the message was lost. */}
      <FormError message={formError} />

      {/* Scoreboard */}
      <section
        className="relative overflow-hidden rounded-2xl border border-edge"
        style={{
          background: `linear-gradient(90deg, ${teamWash(match.teamA.color)}, ${teamWash(match.teamA.color, 0.2)} 35%, var(--color-panel) 50%, ${teamWash(match.teamB.color, 0.2)} 65%, ${teamWash(match.teamB.color)})`,
        }}
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-4 sm:gap-4 sm:px-8 sm:py-6">
          <TeamScore team={match.teamA} score={match.scoreboard.a} leading={match.scoreboard.a > match.scoreboard.b} />
          <div className="flex flex-col items-center gap-2">
            <Badge tone={match.state === 'COMPLETE' ? 'win' : match.state === 'PLAYING' ? 'warn' : 'accent'}>
              {stateLabel[match.state] ?? match.state}
            </Badge>
            <span className="text-[10px] uppercase tracking-[0.2em] text-faint">maps won</span>
            {match.state === 'COMPLETE' && (
              <span className="text-sm font-semibold text-win">
                {match.winnerId === match.teamA.id
                  ? `${match.teamA.name} won`
                  : match.winnerId === match.teamB.id
                    ? `${match.teamB.name} won`
                    : 'Draw'}
              </span>
            )}
          </div>
          <TeamScore
            team={match.teamB}
            score={match.scoreboard.b}
            leading={match.scoreboard.b > match.scoreboard.a}
            align="right"
          />
        </div>
      </section>

      {capacity && (
        <p className="rounded-lg border border-edge bg-raised/50 px-4 py-2 text-xs text-muted">
          {capacity}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_21rem]">
        <div className="space-y-6">
          {/* Pick / ban */}
          <Panel
            title="Pick and ban"
            subtitle={
              match.pending
                ? `${pendingTeam.name} to ${match.pending.type.toLowerCase()}`
                : 'Complete'
            }
            actions={
              can(actor, 'UNDO_ACTION') && match.actions.length > 0 ? (
                <form action={undoLastAction}>
                  <input type="hidden" name="matchId" value={match.id} />
                  <Button variant="ghost" type="submit">
                    Undo last
                  </Button>
                </form>
              ) : null
            }
          >
            {match.actions.length === 0 ? (
              <p className="text-sm text-muted">Nothing picked yet.</p>
            ) : (
              <ol className="flex flex-wrap gap-2">
                {match.actions.map((action) => {
                  const team = action.teamId === match.teamA.id ? match.teamA : match.teamB;
                  const banned = action.type === 'BAN';
                  return (
                    <li
                      key={action.seq}
                      className="flex items-center gap-2.5 rounded-lg border border-edge bg-raised/40 py-1.5 pl-1.5 pr-3"
                      style={{ borderBottom: `2px solid ${team.color}` }}
                      title={
                        action.onBehalf && action.actingUserName
                          ? `Entered by ${action.actingUserName} on the captain's behalf`
                          : undefined
                      }
                    >
                      <span className="relative">
                        <MapCover
                          src={coverOf.get(action.poolMapId)}
                          size={36}
                          className={banned ? 'opacity-40 grayscale' : ''}
                        />
                        {banned && (
                          <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-red-400">
                            ✕
                          </span>
                        )}
                      </span>
                      <span className="leading-tight">
                        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                          <span className={banned ? 'text-red-300' : 'text-green-300'}>
                            {action.seq + 1}. {action.type}
                          </span>
                          <span style={{ color: teamInk(team.color, team.colorSecondary) }}>
                            {action.teamName}
                          </span>
                          {action.onBehalf && <span className="text-faint">*</span>}
                        </span>
                        <span className={`block text-sm ${banned ? 'text-muted line-through' : 'font-medium'}`}>
                          {action.mapName}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            {match.pending && (
              <div className="mt-4 border-t border-edge pt-4">
                <p className="mb-3 text-sm">
                  {canAct ? (
                    <>
                      <span
                        className="font-semibold"
                        style={{ color: teamInk(pendingTeam.color, pendingTeam.colorSecondary) }}
                      >
                        {pendingTeam.name}
                      </span>
                      , choose a map to {match.pending.type.toLowerCase()}:
                    </>
                  ) : (
                    <span className="text-muted">
                      Waiting for {pendingTeam.name} to {match.pending.type.toLowerCase()}.
                    </span>
                  )}
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  {match.pool.maps
                    .filter((m) => match.pending!.availableMapIds.includes(m.poolMapId))
                    .map((map) => {
                      return (
                        <form key={map.poolMapId} action={submitPickBan} className="contents">
                          <input type="hidden" name="matchId" value={match.id} />
                          <input type="hidden" name="poolMapId" value={map.poolMapId} />
                          <input type="hidden" name="teamId" value={match.pending!.teamId} />
                          <button
                            type="submit"
                            disabled={!canAct}
                            className="flex items-center gap-3 rounded-lg border border-edge bg-raised/40 p-2 text-left text-sm transition enabled:hover:border-accent enabled:hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <MapCover src={map.coverImage} size={48} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{map.name}</span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <DifficultyChip
                                  value={map.difficultyValue}
                                  label={map.difficultyLabel}
                                />
                              </span>
                            </span>
                          </button>
                        </form>
                      );
                    })}
                </div>
              </div>
            )}
          </Panel>

          {/* Maps and lineups */}
          {match.plannedMaps.length > 0 && (
            <Panel
              title="Maps"
              subtitle="Set each team's players, then enter what they scored"
              actions={
                <div className="flex items-center gap-2">
                  {can(actor, 'MANAGE_TOURNAMENT') && (
                    <form action={match.state === 'COMPLETE' ? reopenMatch : completeMatch}>
                      <input type="hidden" name="matchId" value={match.id} />
                      <Button
                        variant={match.state === 'COMPLETE' ? 'ghost' : 'primary'}
                        type="submit"
                        title={
                          match.state === 'COMPLETE'
                            ? 'Unfreeze so scores can be corrected'
                            : 'Freeze the result - later practice on these maps will not change it'
                        }
                      >
                        {match.state === 'COMPLETE' ? 'Reopen' : 'Complete match'}
                      </Button>
                    </form>
                  )}
                </div>
              }
            >
              <div className="space-y-4">
                {match.plannedMaps.map((planned) => {
                  const result = planned.result;
                  const winner =
                    result.winnerId === match.teamA.id ? match.teamA : result.winnerId === match.teamB.id ? match.teamB : null;
                  const loser = winner ? (winner.id === match.teamA.id ? match.teamB : match.teamA) : null;
                  const picker =
                    planned.pickedByTeamId === match.teamA.id
                      ? match.teamA
                      : planned.pickedByTeamId === match.teamB.id
                        ? match.teamB
                        : null;

                  return (
                    <article
                      key={planned.poolMapId}
                      className="overflow-hidden rounded-xl border border-edge"
                    >
                      {/* Cover art as the banner, blurred out so text stays readable. */}
                      <div className="relative">
                        {planned.map.coverImage && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={planned.map.coverImage}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-xl"
                          />
                        )}
                        <div className="relative flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-panel/90 via-panel/60 to-panel/90 p-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <MapCover
                              src={planned.map.coverImage}
                              size={56}
                              rounded="rounded-xl"
                              className="shadow-lg shadow-black/50"
                            />
                            <div className="min-w-0">
                              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                                {planned.isTiebreaker ? 'Tiebreaker' : `Map ${planned.order}`}
                                {picker && (
                                  <>
                                    {' · picked by '}
                                    <span style={{ color: teamInk(picker.color, picker.colorSecondary) }}>
                                      {picker.name}
                                    </span>
                                  </>
                                )}
                              </p>
                              <h3 className="truncate text-base font-semibold">{planned.map.name}</h3>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <DifficultyChip
                                  value={planned.map.difficultyValue}
                                  label={planned.map.difficultyLabel}
                                />
                                {planned.map.mapper && (
                                  <span className="text-xs text-muted">{planned.map.mapper}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          {result.decided && (
                            <MapScore match={match} planned={planned} winner={winner} loser={loser} />
                          )}
                        </div>
                      </div>

                      <div className="grid gap-3 p-3 sm:grid-cols-2">
                        {[match.teamA, match.teamB].map((team) => (
                          <LineupEditor
                            // Keyed on the saved lineup too: the editor keeps its own
                            // selection, and must drop it when someone else saves or
                            // an undo clears the map. Only what this viewer may see
                            // goes in the key - it is serialised to the client, so
                            // the raw lineup here would hand the hidden card over.
                            key={`${team.id}:${
                              canSeeLineup(team.id)
                                ? (planned.lineups[team.id] ?? []).join(',')
                                : `hidden:${(planned.lineups[team.id] ?? []).length}`
                            }`}
                            matchId={match.id}
                            matchMapId={planned.matchMapId}
                            team={team}
                            selected={canSeeLineup(team.id) ? (planned.lineups[team.id] ?? []) : []}
                            playersPerMap={match.format.playersPerMap}
                            scores={canSeeLineup(team.id) ? (planned.scores[team.id] ?? []) : []}
                            hidden={
                              canSeeLineup(team.id)
                                ? undefined
                                : (planned.lineups[team.id] ?? []).length >= match.format.playersPerMap
                                  ? 'Set. Hidden until both teams have set every map.'
                                  : 'Not set yet. Hidden until both teams have set every map.'
                            }
                            canEdit={canSeeLineup(team.id) && can(actor, 'SET_LINEUP', { teamId: team.id })}
                            canOverride={can(actor, 'OVERRIDE_RULES', { teamId: team.id })}
                            ruleBreaks={canSeeLineup(team.id) ? planned.ruleBreaks[team.id] : undefined}
                          />
                        ))}
                      </div>

                      {/* Scores and replays */}
                      {planned.matchMapId && (
                        <div className="space-y-3 border-t border-edge p-3">
                          {planned.replayCalledByTeamIds.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                              {planned.replayCalledByTeamIds.map((id, i) => (
                                <Badge key={i} tone="warn">
                                  Replay called by {id === match.teamA.id ? match.teamA.name : match.teamB.name}
                                </Badge>
                              ))}
                              <span>
                                Both teams play the map again; pull or enter the new scores once it is
                                over. Each player&apos;s best run counts.
                              </span>
                              {can(actor, 'UNDO_ACTION') && match.state !== 'COMPLETE' && (
                                <form action={cancelReplay}>
                                  <input type="hidden" name="matchId" value={match.id} />
                                  <input type="hidden" name="matchMapId" value={planned.matchMapId} />
                                  <button type="submit" className="underline decoration-faint underline-offset-2 hover:text-ink">
                                    Cancel last replay
                                  </button>
                                </form>
                              )}
                            </div>
                          )}

                          {(() => {
                            const mayPull = can(actor, 'PULL_SCORES', {
                              captainsPullScores: match.tournament.captainsPullScores,
                              matchTeamIds: [match.teamA.id, match.teamB.id],
                            });
                            const mayType = [match.teamA, match.teamB].some((t) =>
                              can(actor, 'ENTER_SCORE', { teamId: t.id, captainsEnterScores: match.tournament.captainsEnterScores }),
                            );
                            const hasLineup = [match.teamA, match.teamB].some((t) => (planned.lineups[t.id] ?? []).length > 0);
                            if (match.state === 'COMPLETE') return null;
                            // Maps are played in order: the first map whose scores are still open is the one being played.
                            const waitingOn = match.plannedMaps.find(
                              (m) =>
                                !m.scoresClosed &&
                                m.poolMapId !== planned.poolMapId &&
                                (planned.isTiebreaker ? !m.isTiebreaker : !m.isTiebreaker && m.order < planned.order),
                            );
                            if (!planned.scoresClosed && waitingOn && (mayPull || mayType)) {
                              if (!isStaff(actor)) {
                                return (
                                  <p className="text-xs text-muted">
                                    Played after {waitingOn.isTiebreaker ? 'the tiebreaker' : `map ${waitingOn.order}`} ({waitingOn.map.name}):
                                    its scores are filled in once that map&apos;s are closed.
                                  </p>
                                );
                              }
                            }
                            if (planned.scoresClosed) {
                              return (
                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                                  <Badge tone="win">Scores closed</Badge>
                                  <span>Nothing more is pulled or typed in for this map.</span>
                                  {can(actor, 'UNDO_ACTION') && (
                                    <form action={reopenMapScores}>
                                      <input type="hidden" name="matchId" value={match.id} />
                                      <input type="hidden" name="matchMapId" value={planned.matchMapId} />
                                      <button type="submit" className="underline decoration-faint underline-offset-2 hover:text-ink">
                                        Reopen
                                      </button>
                                    </form>
                                  )}
                                </div>
                              );
                            }
                            return (
                              <>
                                {waitingOn && isStaff(actor) && (
                                  <p className="text-xs text-amber-300">
                                    {waitingOn.isTiebreaker ? 'The tiebreaker' : `Map ${waitingOn.order}`} ({waitingOn.map.name}) is still open. Maps are
                                    played in order; as an organiser you can fill this one in anyway.
                                  </p>
                                )}
                                {mayPull && hasLineup && (
                                  <PullScores
                                    matchId={match.id}
                                    matchMapId={planned.matchMapId!}
                                    replays={planned.replayCalledByTeamIds.length}
                                  />
                                )}
                                {(mayPull || mayType) && Object.keys(planned.scores).length > 0 && (
                                  <form action={closeMapScores} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                                    <input type="hidden" name="matchId" value={match.id} />
                                    <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
                                    <ConfirmButton
                                      question={`Close the scores for ${planned.map.name}?\n\nNothing more is pulled or typed in for it. ${can(actor, 'UNDO_ACTION') ? 'You can reopen it.' : 'Only an organiser can reopen it.'}`}
                                      className="inline-flex h-8 items-center rounded-lg border border-edge bg-raised/60 px-3 text-xs font-medium text-ink transition hover:border-faint"
                                    >
                                      Close scores
                                    </ConfirmButton>
                                    <span>once everyone&apos;s is in and right.</span>
                                  </form>
                                )}
                              </>
                            );
                          })()}

                          {match.state !== 'COMPLETE' && (
                            <div className="grid gap-3 sm:grid-cols-2">
                              {[match.teamA, match.teamB].map((team) => {
                                const lineup = canSeeLineup(team.id) ? (planned.lineups[team.id] ?? []) : [];
                                const outOfTurn =
                                  !isStaff(actor) &&
                                  match.plannedMaps.some(
                                    (m) =>
                                      !m.scoresClosed &&
                                      m.poolMapId !== planned.poolMapId &&
                                      (planned.isTiebreaker ? !m.isTiebreaker : !m.isTiebreaker && m.order < planned.order),
                                  );
                                const mayEnter =
                                  !planned.scoresClosed &&
                                  !outOfTurn &&
                                  can(actor, 'ENTER_SCORE', {
                                    teamId: team.id,
                                    captainsEnterScores: match.tournament.captainsEnterScores,
                                  });
                                const mayReplay =
                                  can(actor, 'SET_LINEUP', { teamId: team.id }) &&
                                  (replaysUsed.get(team.id) ?? 0) < match.format.rules.replaysPerTeam;
                                if (!mayEnter && !mayReplay) return <div key={team.id} />;

                                const replays = planned.replayCalledByTeamIds.length;
                                const runLabels = ['First run', ...Array.from({ length: replays }, (_, n) =>
                                  replays === 1 ? 'Replay' : `Replay ${n + 1}`,
                                )];
                                const entered = planned.runs[team.id] ?? {};

                                return (
                                  <div key={team.id} className="space-y-2">
                                    {mayEnter && lineup.length === 0 && (
                                      <p className="text-xs text-faint">
                                        Set {team.name}&apos;s lineup for this map to enter their scores.
                                      </p>
                                    )}
                                    {mayEnter && lineup.length > 0 && (
                                      <details className="group">
                                        <summary className="cursor-pointer text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink">
                                          Type {team.name}&apos;s scores in by hand
                                        </summary>
                                      <form
                                        // Uncontrolled inputs keep what was typed; re-key so a
                                        // save by someone else, or a new replay, shows up.
                                        key={JSON.stringify([entered, replays])}
                                        action={saveScores}
                                        className="space-y-1.5"
                                      >
                                        <input type="hidden" name="matchId" value={match.id} />
                                        <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
                                        <input type="hidden" name="teamId" value={team.id} />
                                        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-faint">
                                          <span className="w-20 shrink-0 truncate sm:w-24">{team.name}</span>
                                          {runLabels.map((label) => (
                                            <span key={label} className="min-w-0 flex-1">
                                              {label}
                                            </span>
                                          ))}
                                        </div>
                                        {lineup.map((playerId) => {
                                          const name = team.players.find((p) => p.id === playerId)?.name ?? 'Player';
                                          return (
                                            <div key={playerId} className="flex items-center gap-2 text-xs">
                                              <span className="w-20 shrink-0 truncate text-muted sm:w-24">{name}</span>
                                              {runLabels.map((label, index) => (
                                                <input
                                                  key={label}
                                                  name={`score:${playerId}:${index + 1}`}
                                                  inputMode="numeric"
                                                  autoComplete="off"
                                                  defaultValue={entered[playerId]?.[index + 1] ?? ''}
                                                  placeholder="Score"
                                                  aria-label={`${name}, ${label.toLowerCase()}`}
                                                  className={`${inputClass} h-8 min-w-0 flex-1 tabular`}
                                                />
                                              ))}
                                            </div>
                                          );
                                        })}
                                        <Button variant="ghost" type="submit" className="h-8">
                                          Save {team.name} scores
                                        </Button>
                                      </form>
                                      </details>
                                    )}
                                    {mayReplay && (
                                      <form action={callReplay}>
                                        <input type="hidden" name="matchId" value={match.id} />
                                        <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
                                        <input type="hidden" name="teamId" value={team.id} />
                                        <ConfirmButton
                                          question={`Use ${team.name}'s replay on ${planned.map.name}?\n\nBoth teams play the map again. Each player's best run counts. ${team.name} ${match.format.rules.replaysPerTeam === 1 ? 'only gets one replay' : `gets ${match.format.rules.replaysPerTeam} replays`} this match.`}
                                          title={`Spend ${team.name}'s replay on this map. Both teams play it again and each player's best run counts.`}
                                          className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
                                        >
                                          Call {team.name}&apos;s replay on this map
                                        </ConfirmButton>
                                      </form>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>

        <aside className="space-y-6">
          <ScoringPanel match={match} />
          {match.plannedMaps.length > 0 || match.pool.maps.length > 0 ? (
            <Panel title="Calculator" subtitle="Score, accuracy and points, each from the others">
              <PointsCalculator
                maps={(match.plannedMaps.length > 0 ? match.plannedMaps.map((pm) => pm.map) : match.pool.maps).map((m) => ({
                  id: m.poolMapId,
                  name: m.name,
                  difficulty: m.difficultyLabel,
                  maxScore: m.maxScore,
                  perfectAcc: m.perfectAcc,
                }))}
                curve={match.scoring.curve}
                showPoints={match.scoring.mode === 'MATCH_POINTS'}
              />
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function TeamScore({
  team,
  score,
  leading,
  align = 'left',
}: {
  team: {
    name: string;
    color: string;
    colorSecondary: string | null;
    players: Array<{ id: string; name: string; avatar: string | null }>;
  };
  score: number;
  leading: boolean;
  align?: 'left' | 'right';
}) {
  const right = align === 'right';
  return (
    // Stacked on a phone: a name and a 60px numeral do not fit side by side in a third of the width.
    <div
      className={`flex min-w-0 flex-col gap-2 sm:items-center sm:gap-6 ${
        right ? 'items-end text-right sm:flex-row-reverse' : 'items-start sm:flex-row'
      }`}
    >
      <div className="min-w-0 max-w-full sm:flex-1">
        <p
          className="truncate text-base font-bold tracking-tight sm:text-2xl"
          style={{ color: teamInk(team.color, team.colorSecondary) }}
        >
          {team.name}
        </p>
        <div className={`mt-2 flex ${right ? 'justify-end' : ''}`}>
          <PlayerAvatarStack people={team.players} size={26} ring={team.color} />
        </div>
      </div>
      <span
        className={`text-4xl font-bold leading-none tabular sm:text-6xl ${leading ? 'text-ink' : 'text-muted'}`}
      >
        {score}
      </span>
    </div>
  );
}

/** The name match points go by for now. */
const POINTS_NAME = 'match points';

/** How the match is scored, said once. */
function ScoringPanel({ match }: { match: MatchView }) {
  const { mode, curve } = match.scoring;
  const missing = match.plannedMaps.filter((pm) => pm.map.perfectAcc == null).length;
  return (
    <Panel title="Scoring" subtitle={mode === 'MATCH_POINTS' ? 'Match points' : 'Average accuracy'}>
      {mode === 'MATCH_POINTS' ? (
        <div className="space-y-2 text-sm text-muted">
          <p>
            Each player&apos;s accuracy is turned into {POINTS_NAME} on a curve first, and then the team&apos;s
            points are averaged. Near 100% every point of accuracy is worth more, so a strong player carrying a
            newer one is not dragged down by the gap alone.
          </p>
          <p className="text-xs text-faint">
            A score at a map&apos;s perfect % is worth {curve.perfectPoints} points. Curve: padding {curve.padding},
            slope {curve.slope}.
            {missing > 0 &&
              ` ${missing === 1 ? 'One map has' : `${missing} maps have`} no perfect % set, so ${missing === 1 ? 'it shows' : 'they show'} accuracy instead of points; the curve still decides ${missing === 1 ? 'it' : 'them'}.`}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">
          Each team&apos;s average accuracy on a map decides it, as the league sheets always have.
        </p>
      )}
    </Panel>
  );
}

/** One map's result: each team's number, who took it, and how close it was. */
function MapScore({
  match,
  planned,
  winner,
  loser,
}: {
  match: MatchView;
  planned: MatchView['plannedMaps'][number];
  winner: { id: string; name: string; color: string; colorSecondary: string | null } | null;
  loser: { name: string } | null;
}) {
  const points = match.scoring.mode === 'MATCH_POINTS';
  const figure = (teamId: string) => {
    const team = planned.result.teams[teamId];
    if (!team) return '—';
    return points && team.points != null ? team.points.toFixed(2) : pct(team.accEquivalent);
  };
  const side = (team: MatchView['teamA']) => (
    <span
      className={winner?.id === team.id ? 'font-semibold' : 'text-muted'}
      style={winner?.id === team.id ? { color: teamInk(team.color, team.colorSecondary) } : undefined}
    >
      {figure(team.id)}
    </span>
  );
  const catchUp = planned.result.catchUp;
  return (
    <div className="text-right">
      <p className="text-base tabular">
        {side(match.teamA)}
        <span className="mx-2 text-xs text-faint">vs</span>
        {side(match.teamB)}
      </p>
      {points && (
        <p className="text-[11px] tabular text-faint" title="The accuracy each team's average points come to">
          ≈ {pct(planned.result.teams[match.teamA.id]!.accEquivalent)} vs {pct(planned.result.teams[match.teamB.id]!.accEquivalent)}
        </p>
      )}
      <p className="text-xs text-muted">
        {winner ? `${winner.name} take it` : 'Level'}
        {winner && loser && catchUp != null && (
          <span
            className="ml-1.5 cursor-help underline decoration-dotted decoration-faint underline-offset-2"
            title={`Each player on ${loser.name} would have needed about ${pct(catchUp)} more accuracy for ${loser.name} to take this map.`}
          >
            · {pct(catchUp)} difference
          </span>
        )}
      </p>
    </div>
  );
}
