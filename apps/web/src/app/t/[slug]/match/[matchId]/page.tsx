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
  Meter,
  chanceColor,
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
import { loadMatch, buildAdvice } from '@/server/matches';
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
} from '@/server/match-actions';
import { LineupEditor } from '@/components/lineup-editor';
import { AnswerCard } from '@/components/answer-card';

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
  searchParams: Promise<{ as?: string; error?: string }>;
}) {
  const { slug, matchId } = await params;
  const { as: requestedSide, error: formError } = await searchParams;

  const match = await loadMatch(matchId);
  if (!match || match.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(match.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: match.tournament.isPublic })) notFound();

  // Advice is shown from the viewer's own side. Staff and spectators see it
  // from team A's perspective, which the heading makes explicit.
  // Anyone can look at it from either side with ?as=<teamId>; the advice is
  // built from public scores, so there is nothing here to keep from a viewer.
  const myTeamId =
    requestedSide === match.teamA.id || requestedSide === match.teamB.id
      ? requestedSide
      : isCaptainOf(actor, match.teamA.id)
        ? match.teamA.id
        : isCaptainOf(actor, match.teamB.id)
          ? match.teamB.id
          : match.teamA.id;
  const myTeam = myTeamId === match.teamA.id ? match.teamA : match.teamB;

  const advice = await buildAdvice(match, myTeamId);
  const mapValueById = new Map(advice.mapValues.map((v) => [v.mapId, v]));

  const usedPoolMapIds = new Set(match.actions.map((a) => a.poolMapId));
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
  // its own. Someone on a team in this match is held to that even if they also
  // run the event - otherwise the organiser-captain of a scrim sees the other
  // card. Staff with no side see everything.
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
  const canSeeLineup = (teamId: string) =>
    lineupsRevealed || (mySides.size > 0 ? mySides.has(teamId) : isStaff(actor));

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
                      const value = mapValueById.get(map.poolMapId);
                      const rank = advice.actionAdvice.findIndex(
                        (a) => a.mapId === map.poolMapId,
                      );
                      return (
                        <form key={map.poolMapId} action={submitPickBan} className="contents">
                          <input type="hidden" name="matchId" value={match.id} />
                          <input type="hidden" name="poolMapId" value={map.poolMapId} />
                          <input type="hidden" name="teamId" value={match.pending!.teamId} />
                          <button
                            type="submit"
                            disabled={!canAct}
                            className={`flex items-center gap-3 rounded-lg border bg-raised/40 p-2 text-left text-sm transition enabled:hover:border-accent enabled:hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60 ${
                              rank === 0 ? 'border-accent/60' : 'border-edge'
                            }`}
                          >
                            <MapCover src={map.coverImage} size={48} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{map.name}</span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <DifficultyChip
                                  value={map.difficultyValue}
                                  label={map.difficultyLabel}
                                />
                                {map.category && (
                                  <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                                    {map.category}
                                  </span>
                                )}
                              </span>
                            </span>
                            {value && (
                              <span className="w-14 shrink-0 text-right">
                                <span
                                  className="block text-base font-semibold tabular"
                                  style={{ color: chanceColor(value.likely) }}
                                >
                                  {pct(value.likely, 0)}
                                </span>
                                <span className="block text-[9px] uppercase tracking-wider text-faint">
                                  {rank === 0
                                    ? match.pending!.type === 'PICK'
                                      ? 'best pick'
                                      : 'best ban'
                                    : 'win chance'}
                                </span>
                              </span>
                            )}
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
                  const totalA = planned.totals[match.teamA.id];
                  const totalB = planned.totals[match.teamB.id];
                  const decided = totalA != null && totalB != null;
                  const winner = !decided
                    ? null
                    : totalA! > totalB!
                      ? match.teamA
                      : totalB! > totalA!
                        ? match.teamB
                        : null;
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

                          {decided && (
                            <div className="text-right">
                              <p className="text-base tabular">
                                <span
                                  className={totalA! > totalB! ? 'font-semibold' : 'text-muted'}
                                  style={
                                    totalA! > totalB!
                                      ? { color: teamInk(match.teamA.color, match.teamA.colorSecondary) }
                                      : undefined
                                  }
                                >
                                  {num(totalA!)}
                                </span>
                                <span className="mx-2 text-xs text-faint">vs</span>
                                <span
                                  className={totalB! > totalA! ? 'font-semibold' : 'text-muted'}
                                  style={
                                    totalB! > totalA!
                                      ? { color: teamInk(match.teamB.color, match.teamB.colorSecondary) }
                                      : undefined
                                  }
                                >
                                  {num(totalB!)}
                                </span>
                              </p>
                              <p className="text-xs text-muted">
                                {winner ? `${winner.name} by ${num(Math.abs(totalA! - totalB!))}` : 'Level'}
                              </p>
                            </div>
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
                            recommended={
                              team.id === myTeamId
                                ? (advice.lineups.winProbability?.lineups[planned.poolMapId] as
                                    | string[]
                                    | undefined)
                                : undefined
                            }
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
                                Both teams play the map again and enter the new scores in the Replay
                                column. Each player&apos;s best run counts.
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

                          {match.state !== 'COMPLETE' && (
                            <div className="grid gap-3 sm:grid-cols-2">
                              {[match.teamA, match.teamB].map((team) => {
                                const lineup = canSeeLineup(team.id) ? (planned.lineups[team.id] ?? []) : [];
                                const mayEnter = can(actor, 'ENTER_SCORE', {
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
                                    )}
                                    {mayReplay && (
                                      <form action={callReplay}>
                                        <input type="hidden" name="matchId" value={match.id} />
                                        <input type="hidden" name="matchMapId" value={planned.matchMapId!} />
                                        <input type="hidden" name="teamId" value={team.id} />
                                        <ConfirmButton
                                          question={`Use ${team.name}'s replay on ${planned.map.name}?\n\nBoth teams play the map again and enter their new scores. Each player's best run counts. ${team.name} ${match.format.rules.replaysPerTeam === 1 ? 'only gets one replay' : `gets ${match.format.rules.replaysPerTeam} replays`} this match.`}
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

        {/* Advice sidebar */}
        <aside className="space-y-6">
          {advice.calculating && match.pending && advice.actionAdvice.length === 0 && (
            <Panel title={match.pending.type === 'PICK' ? 'Suggested pick' : 'Suggested ban'}>
              <Calculating>Working out the best {match.pending.type === 'PICK' ? 'pick' : 'ban'}…</Calculating>
            </Panel>
          )}

          {advice.actionAdvice.length > 0 && match.pending && (() => {
            const top = advice.actionAdvice[0]!;
            const map = match.pool.maps.find((m) => m.poolMapId === top.mapId);
            return (
              <Panel
                title={match.pending.type === 'PICK' ? 'Suggested pick' : 'Suggested ban'}
                className="border-accent/40"
              >
                <div className="flex items-center gap-3">
                  <MapCover src={map?.coverImage} size={48} />
                  <p className="font-semibold">{map?.name}</p>
                </div>
                <p className="mt-3 text-sm text-muted">{top.reason}</p>
              </Panel>
            );
          })()}

          <Panel
            title="Win chance by map"
            subtitle={`From ${myTeam.name}'s side, with each team fielding its strongest lineup for that map`}
            actions={
              <div className="flex items-center gap-1 text-xs">
                {[match.teamA, match.teamB].map((team) => (
                  <Link
                    key={team.id}
                    href={`/t/${slug}/match/${match.id}?as=${team.id}`}
                    scroll={false}
                    aria-current={team.id === myTeamId ? 'true' : undefined}
                    title={`See the advice from ${team.name}'s side`}
                    className={`rounded-full border px-2 py-0.5 font-medium transition ${
                      team.id === myTeamId
                        ? 'border-accent bg-accent/15 text-ink'
                        : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
                    }`}
                  >
                    {team.name}
                  </Link>
                ))}
              </div>
            }
          >
            {advice.mapValues.length === 0 ? (
              advice.calculating ? (
                <Calculating>Working out win chances…</Calculating>
              ) : (
                <Empty>Both teams need a full roster before this can be estimated.</Empty>
              )
            ) : (
              <ul className="space-y-2.5 text-sm">
                {[...advice.mapValues]
                  .sort((a, b) => b.likely - a.likely)
                  .map((value) => {
                    const map = match.pool.maps.find((m) => m.poolMapId === value.mapId);
                    const used = usedPoolMapIds.has(value.mapId);
                    return (
                      <li
                        key={value.mapId}
                        className={`flex items-center gap-2.5 ${used ? 'opacity-60' : ''}`}
                        title={used ? 'Already picked or banned' : undefined}
                      >
                        <MapCover src={map?.coverImage} size={30} rounded="rounded-md" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate">{map?.name ?? value.mapId}</span>
                            <span
                              className="shrink-0 font-semibold tabular"
                              style={{ color: chanceColor(value.likely) }}
                            >
                              {pct(value.likely, 0)}
                            </span>
                          </span>
                          <Meter
                            value={value.likely}
                            color={chanceColor(value.likely)}
                            className="mt-1"
                          />
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </Panel>

          {advice.calculating && !match.pending && match.plannedMaps.length > 0 && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <Calculating>Working out the best lineups…</Calculating>
              <p className="mt-2 text-xs text-muted">
                This takes a few seconds and appears by itself. You can set your players in the
                meantime - suggestions will show up here and as stars beside their names.
              </p>
            </Panel>
          )}

          {match.pending && match.plannedMaps.length > 0 && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <p className="text-sm text-muted">
                Lineup advice appears once every map has been picked. The rules about who can pair
                up and how often span the whole card, so a lineup for part of it would mislead.
              </p>
            </Panel>
          )}

          {!match.pending && match.plannedMaps.length > 0 && (
            <AnswerCard
              matchId={match.id}
              us={myTeam}
              them={myTeamId === match.teamA.id ? match.teamB : match.teamA}
              playersPerMap={match.format.playersPerMap}
              maps={match.plannedMaps.map((pm) => {
                const theirId = myTeamId === match.teamA.id ? match.teamB.id : match.teamA.id;
                const known = canSeeLineup(theirId) ? (pm.lineups[theirId] ?? []) : [];
                return {
                  poolMapId: pm.poolMapId,
                  name: pm.map.name,
                  isTiebreaker: pm.isTiebreaker,
                  known: known.length === match.format.playersPerMap ? known : undefined,
                };
              })}
            />
          )}

          {advice.lineupsInfeasible && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <p className="text-sm text-amber-300">No legal lineup is possible.</p>
              <p className="mt-2 text-sm text-muted">{advice.lineupsInfeasible}</p>
            </Panel>
          )}

          {(advice.lineups.winProbability || advice.lineups.expectedMargin) && (
            <Panel
              title="Lineup strategy"
              subtitle={`For ${myTeam.name}, assuming the other captain answers your card with their best`}
            >
              <div className="space-y-4 text-sm">
                {advice.lineups.winProbability && (
                  <Strategy
                    label="Maximise win chance"
                    result={advice.lineups.winProbability}
                    match={match}
                    myTeamId={myTeamId}
                    highlight
                  />
                )}
                {advice.lineups.expectedMargin && (
                  <Strategy
                    label="Maximise total score"
                    result={advice.lineups.expectedMargin}
                    match={match}
                    myTeamId={myTeamId}
                  />
                )}
                {advice.lineups.winProbability &&
                  advice.lineups.expectedMargin &&
                  advice.lineups.winProbability.winProbability >
                    advice.lineups.expectedMargin.winProbability + 0.01 && (
                    <p className="border-t border-edge pt-3 text-xs text-muted">
                      Chasing points costs you{' '}
                      {pct(
                        advice.lineups.winProbability.winProbability -
                          advice.lineups.expectedMargin.winProbability,
                        1,
                      )}{' '}
                      of win chance here.
                    </p>
                  )}
              </div>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Advice that is still being computed on the advice thread. */
function Calculating({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <span
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-edge-strong border-t-accent"
      />
      {children}
    </p>
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

function Strategy({
  label,
  result,
  match,
  myTeamId,
  highlight = false,
}: {
  label: string;
  result: {
    lineups: Record<string, readonly string[]>;
    winProbability: number;
    expectedMargin: number;
    conceded: string[];
    opponentLineups?: Record<string, readonly string[]>;
    perMap?: Record<string, { winProbability: number; expectedMargin: number }>;
  };
  match: Awaited<ReturnType<typeof loadMatch>>;
  myTeamId: string;
  highlight?: boolean;
}) {
  if (!match) return null;
  const nameOf = new Map(
    [...match.teamA.players, ...match.teamB.players].map((p) => [p.id, p.name]),
  );
  const names = (ids: readonly string[] | undefined) => (ids ?? []).map((id) => nameOf.get(id) ?? id).join(' + ');
  const them = myTeamId === match.teamA.id ? match.teamB : match.teamA;
  const mapsWon = match.plannedMaps.filter((pm) => !pm.isTiebreaker && (result.perMap?.[pm.poolMapId]?.winProbability ?? 0) >= 0.5).length;
  const regular = match.plannedMaps.filter((pm) => !pm.isTiebreaker).length;

  return (
    <div className={highlight ? 'rounded-lg border border-accent/30 bg-accent/5 p-2.5' : 'px-2.5 opacity-85'}>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="tabular" title="Chance of winning the match with this card, against the best card the other captain can answer it with">
          {pct(result.winProbability, 1)}
        </span>
      </div>
      {result.perMap && (
        <p className="mb-2 text-[11px] text-muted">
          Expected to take {mapsWon} of {regular} maps
          {result.expectedMargin !== 0 && (
            <>
              {' '}
              · {result.expectedMargin > 0 ? '+' : '−'}
              {num(Math.round(Math.abs(result.expectedMargin)))} points over the match
            </>
          )}
          . Against {them.name}&apos;s best answer, shown under each map.
        </p>
      )}
      <ul className="space-y-1.5 text-xs">
        {match.plannedMaps.map((planned) => {
          const group = result.lineups[planned.poolMapId];
          if (!group) return null;
          const outcome = result.perMap?.[planned.poolMapId];
          const conceded = result.conceded.includes(planned.poolMapId);
          const theirs = result.opponentLineups?.[planned.poolMapId];
          return (
            <li key={planned.poolMapId} className="border-t border-edge/60 pt-1.5 first:border-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-ink">
                  {planned.map.name}
                  {planned.isTiebreaker && <span className="ml-1 text-[10px] text-faint">TB</span>}
                </span>
                {outcome && (
                  <span
                    className={`shrink-0 tabular ${conceded ? 'text-amber-300' : outcome.winProbability >= 0.5 ? 'text-win' : 'text-lose'}`}
                    title={`Chance of taking this map with these two lineups, and the expected score difference`}
                  >
                    {pct(outcome.winProbability, 0)}
                    <span className="ml-1 text-faint">
                      {outcome.expectedMargin >= 0 ? '+' : '−'}
                      {num(Math.round(Math.abs(outcome.expectedMargin)))}
                    </span>
                    {conceded && <span className="ml-1 font-medium">conceding</span>}
                  </span>
                )}
              </div>
              <div className="flex justify-between gap-2 text-muted">
                <span className={conceded ? 'text-amber-300/90' : ''}>{names(group)}</span>
                {theirs && <span className="truncate text-right text-faint">vs {names(theirs)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
