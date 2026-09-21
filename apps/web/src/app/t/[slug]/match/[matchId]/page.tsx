import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, isCaptainOf, isStaff } from '@/server/match-helpers';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Badge,
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
import { loadMatch, buildAdvice } from '@/server/matches';
import { getActorOrAnonymous } from '@/server/session';
import {
  submitPickBan,
  undoLastAction,
  pullScores,
  completeMatch,
  reopenMatch,
} from '@/server/match-actions';
import { LineupEditor } from '@/components/lineup-editor';

export const dynamic = 'force-dynamic';

export default async function MatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; matchId: string }>;
  searchParams: Promise<{ as?: string }>;
}) {
  const { slug, matchId } = await params;
  const { as: requestedSide } = await searchParams;

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

  const coverOf = new Map(match.pool.maps.map((m) => [m.poolMapId, m.coverImage]));
  const stateLabel: Record<string, string> = {
    SETUP: 'Setup',
    PICKBAN: 'Pick / ban',
    PLAYING: 'In play',
    COMPLETE: 'Final',
  };

  return (
    <div className="space-y-6">
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
        actions={<LiveBadge poolId={match.pool.id} />}
      />

      {/* Scoreboard */}
      <section
        className="relative overflow-hidden rounded-2xl border border-edge"
        style={{
          background: `linear-gradient(90deg, ${teamWash(match.teamA.color)}, ${teamWash(match.teamA.color, 0.2)} 35%, var(--color-panel) 50%, ${teamWash(match.teamB.color, 0.2)} 65%, ${teamWash(match.teamB.color)})`,
        }}
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-6 sm:px-8">
          <TeamScore team={match.teamA} score={match.scoreboard.a} leading={match.scoreboard.a > match.scoreboard.b} />
          <div className="flex flex-col items-center gap-2">
            <Badge tone={match.state === 'COMPLETE' ? 'win' : match.state === 'PLAYING' ? 'warn' : 'accent'}>
              {stateLabel[match.state] ?? match.state}
            </Badge>
            <span className="text-[10px] uppercase tracking-[0.2em] text-faint">maps won</span>
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
                                  style={{ color: chanceColor(value.expected) }}
                                >
                                  {pct(value.expected, 0)}
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
              subtitle="Set each team's players, then pull scores"
              actions={
                <div className="flex items-center gap-2">
                  {can(actor, 'ENTER_SCORE') && match.state !== 'COMPLETE' && (
                    <form action={pullScores}>
                      <input type="hidden" name="matchId" value={match.id} />
                      <Button variant="ghost" type="submit">
                        Pull scores
                      </Button>
                    </form>
                  )}
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
                            // an undo clears the map.
                            key={`${team.id}:${(planned.lineups[team.id] ?? []).join(',')}`}
                            matchId={match.id}
                            matchMapId={planned.matchMapId}
                            team={team}
                            selected={planned.lineups[team.id] ?? []}
                            playersPerMap={match.format.playersPerMap}
                            scores={planned.scores[team.id] ?? []}
                            canEdit={can(actor, 'SET_LINEUP', { teamId: team.id })}
                            canOverride={can(actor, 'OVERRIDE_RULES')}
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
                    </article>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>

        {/* Advice sidebar */}
        <aside className="space-y-6">
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
            subtitle={`From ${myTeam.name}'s side, averaged over every lineup either team could field`}
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
              <Empty>Both teams need a full roster before this can be estimated.</Empty>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {[...advice.mapValues]
                  .sort((a, b) => b.expected - a.expected)
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
                              style={{ color: chanceColor(value.expected) }}
                            >
                              {pct(value.expected, 0)}
                            </span>
                          </span>
                          <Meter
                            value={value.expected}
                            color={chanceColor(value.expected)}
                            className="mt-1"
                          />
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </Panel>

          {match.pending && match.plannedMaps.length > 0 && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <p className="text-sm text-muted">
                Lineup advice appears once every map has been picked. The rules about who can pair
                up and how often span the whole card, so a lineup for part of it would mislead.
              </p>
            </Panel>
          )}

          {advice.lineupsInfeasible && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <p className="text-sm text-amber-300">No legal lineup is possible.</p>
              <p className="mt-2 text-sm text-muted">{advice.lineupsInfeasible}</p>
            </Panel>
          )}

          {(advice.lineups.winProbability || advice.lineups.expectedMargin) && (
            <Panel title="Lineup strategy" subtitle={`For ${myTeam.name}`}>
              <div className="space-y-4 text-sm">
                {advice.lineups.winProbability && (
                  <Strategy
                    label="Maximise win chance"
                    result={advice.lineups.winProbability}
                    match={match}
                    highlight
                  />
                )}
                {advice.lineups.expectedMargin && (
                  <Strategy
                    label="Maximise total score"
                    result={advice.lineups.expectedMargin}
                    match={match}
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
    <div className={`flex items-center gap-4 sm:gap-6 ${right ? 'flex-row-reverse text-right' : ''}`}>
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-xl font-bold tracking-tight sm:text-2xl"
          style={{ color: teamInk(team.color, team.colorSecondary) }}
        >
          {team.name}
        </p>
        <div className={`mt-2 flex ${right ? 'justify-end' : ''}`}>
          <AvatarStack people={team.players} size={26} ring={team.color} />
        </div>
      </div>
      <span
        className={`text-5xl font-bold tabular sm:text-6xl ${leading ? 'text-ink' : 'text-muted'}`}
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
  highlight = false,
}: {
  label: string;
  result: {
    lineups: Record<string, readonly string[]>;
    winProbability: number;
    expectedMargin: number;
    conceded: string[];
  };
  match: Awaited<ReturnType<typeof loadMatch>>;
  highlight?: boolean;
}) {
  if (!match) return null;
  const nameOf = new Map(
    [...match.teamA.players, ...match.teamB.players].map((p) => [p.id, p.name]),
  );

  return (
    <div className={highlight ? 'rounded-lg border border-accent/30 bg-accent/5 p-2.5' : 'px-2.5 opacity-85'}>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="tabular">{pct(result.winProbability, 1)}</span>
      </div>
      <ul className="space-y-0.5 text-xs text-muted">
        {match.plannedMaps.map((planned) => {
          const group = result.lineups[planned.poolMapId];
          if (!group) return null;
          const conceded = result.conceded.includes(planned.poolMapId);
          return (
            <li key={planned.poolMapId} className="flex justify-between gap-2">
              <span className="truncate">{planned.map.name}</span>
              <span className={conceded ? 'text-amber-300' : ''}>
                {group.map((id) => nameOf.get(id) ?? id).join(' + ')}
                {conceded && ' ·  conceding'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
