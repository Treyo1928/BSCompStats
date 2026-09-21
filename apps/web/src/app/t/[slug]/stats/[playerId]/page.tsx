import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import { linkScoreSaber } from '@/server/actions';
import { SCORE_SOURCES, type ScoreSource } from '@/server/score-sources';
import {
  Avatar,
  Button,
  Field,
  FieldAction,
  FormError,
  inputClass,
  Badge,
  DifficultyChip,
  Empty,
  MapCover,
  Meter,
  PageHeader,
  Panel,
  Stat,
  num,
  pct,
  teamInk,
} from '@/components/ui';
import { StyleBadges, signedPoints } from '@/components/player-stats';
import { getActorOrAnonymous } from '@/server/session';
import { buildTournamentStats, STATS_VIEWS, type StatsView } from '@/server/player-stats';
import { KindBreakdown, type KindRow } from '@/components/kind-breakdown';
import { getPlayerStatsSummary } from '@/server/summaries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; playerId: string }>;
}): Promise<Metadata> {
  const { slug, playerId } = await params;
  const summary = await getPlayerStatsSummary(slug, playerId);
  if (!summary) return { title: 'Player stats' };

  const title = `${summary.name} (${summary.team.name}) - ${summary.tournamentName}`;
  return { title, description: summary.description, openGraph: { title, description: summary.description } };
}

const toneInk = { good: 'text-win', bad: 'text-lose', neutral: 'text-ink' } as const;

export default async function PlayerStatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; playerId: string }>;
  searchParams: Promise<{ view?: string; team?: string; error?: string; src?: string }>;
}) {
  const { slug, playerId } = await params;
  const { view: wantedView, team: wantedTeam, error, src: wantedSource } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const stats = await buildTournamentStats(tournament.id, wantedView, wantedSource);
  const viewQuery = (() => {
    const next = new URLSearchParams();
    if (stats.view !== 'pool') next.set('view', stats.view);
    if (stats.source !== 'both') next.set('src', stats.source);
    return next.size ? `?${next}` : '';
  })();
  const pageHref = (change: { view?: StatsView; team?: string; src?: ScoreSource }) => {
    const next = new URLSearchParams();
    const view = change.view ?? stats.view;
    if ((change.src ?? stats.source) !== 'both') next.set('src', change.src ?? stats.source);
    const teamId = change.team ?? (spots.length > 1 ? primary.team.teamId : undefined);
    if (view !== 'pool') next.set('view', view);
    if (teamId) next.set('team', teamId);
    const qs = next.toString();
    return `/t/${slug}/stats/${playerId}${qs ? `?${qs}` : ''}`;
  };
  // Entered teams are listed first, so that is the side their headline figures are against.
  const spots = stats.teams.flatMap((team) =>
    team.players.filter((p) => p.playerId === playerId).map((player) => ({ team, player })),
  );
  // Someone on two teams has two sets of ranks. The team the link came from
  // decides which is shown - arriving from White and reading Coaches' ranks
  // looked exactly like the two pages disagreeing.
  const primary = spots.find((spot) => spot.team.teamId === wantedTeam) ?? spots[0];
  if (!primary) notFound();

  const { team, player } = primary;
  const { profile, style } = player;
  const group = stats.playersPerMap === 2 ? 'duo' : 'group';
  const overall = player.standings.overall;
  const points = (gap: number | null) => (gap == null ? null : gap * 100);
  const kindRows: KindRow[] = [
    {
      kind: 'Overall',
      maps: overall.vsField.maps || overall.vsTeam.maps,
      team: {
        gap: points(overall.vsTeam.gap),
        rank: overall.teamRank,
        ranked: overall.teamRanked,
        comparisons: overall.vsTeam.comparisons,
      },
      field: {
        gap: points(overall.vsField.gap),
        rank: overall.fieldRank,
        ranked: overall.fieldRanked,
        comparisons: overall.vsField.comparisons,
      },
      // Their own level is what every kind is measured against; overall, it is zero by definition.
      predicted: null,
      pp: overall.pp,
    },
    ...player.kinds.map((k): KindRow => ({
    kind: k.kind,
    maps: k.maps,
    team: { gap: points(k.vsTeam.gap), rank: k.teamRank, ranked: k.teamRanked, comparisons: k.vsTeam.comparisons },
    field: { gap: points(k.vsField.gap), rank: k.fieldRank, ranked: k.fieldRanked, comparisons: k.vsField.comparisons },
    pp: k.pp,
    predicted: k.predicted
      ? { gap: k.predicted.accPoints, rank: k.predicted.fieldRank, ranked: k.predicted.fieldSize }
      : null,
    })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[
          { label: tournament.name, href: `/t/${slug}` },
          { label: 'Player stats', href: `/t/${slug}/stats${viewQuery}` },
        ]}
        media={<Avatar src={player.avatar} name={player.name} size={56} ring={team.color} />}
        title={player.name}
        meta={
          <>
            {spots.map(({ team: t }, i) => (
              <span key={t.teamId}>
                {i > 0 && ' · '}
                <span style={{ color: teamInk(t.color, t.colorSecondary) }}>{t.name}</span>
              </span>
            ))}
            {player.pp > 0 && ` · ${Math.round(player.pp).toLocaleString('en-US')}pp`}
            {player.globalRank > 0 && ` · #${player.globalRank.toLocaleString('en-US')} on BeatLeader`}
          </>
        }
        actions={
          <>
          <a
            href={`https://beatleader.com/u/${player.beatLeaderId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium hover:border-faint"
          >
            BeatLeader profile
          </a>
          {player.scoreSaber && (
            <a
              href={`https://scoresaber.com/u/${player.scoreSaber.id}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-9 items-center rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium hover:border-faint"
            >
              ScoreSaber profile
            </a>
          )}
          </>
        }
      />

      <nav aria-label="Based on" className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 text-xs sm:mx-0 sm:px-0">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-faint">Based on</span>
        {(Object.keys(STATS_VIEWS) as StatsView[]).map((view) => (
          <Link
            key={view}
            href={pageHref({ view })}
            scroll={false}
            aria-current={stats.view === view ? 'true' : undefined}
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 font-medium transition ${
              stats.view === view
                ? 'border-accent bg-accent/15 text-ink'
                : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
            }`}
          >
            {STATS_VIEWS[view].label}
          </Link>
        ))}
      </nav>

      <nav aria-label="Platform" className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 text-xs sm:mx-0 sm:px-0">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-faint">Platform</span>
        {(Object.keys(SCORE_SOURCES) as ScoreSource[]).map((src) => (
          <Link
            key={src}
            href={pageHref({ src })}
            scroll={false}
            aria-current={stats.source === src ? 'true' : undefined}
            className={`inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 font-medium transition ${
              stats.source === src
                ? 'border-accent bg-accent/15 text-ink'
                : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
            }`}
          >
            {SCORE_SOURCES[src]}
          </Link>
        ))}
      </nav>

      {spots.length > 1 && (
        <nav aria-label="Ranked within" className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 text-xs sm:mx-0 sm:px-0">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-faint">Ranked within</span>
          {spots.map(({ team: t }) => (
            <Link
              key={t.teamId}
              href={pageHref({ team: t.teamId })}
              scroll={false}
              aria-current={t.teamId === team.teamId ? 'true' : undefined}
              className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-medium transition ${
                t.teamId === team.teamId
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
              }`}
            >
              <span className="h-2 w-2 rounded-full ring-1 ring-white/25" style={{ background: t.color }} />
              {t.name}
            </Link>
          ))}
        </nav>
      )}

      {!profile || !style ? (
        <Panel>
          <Empty>
            {stats.source === 'scoresaber'
              ? player.scoreSaber
                ? 'No ScoreSaber scores that count here yet. Switch the platform to Both to see their BeatLeader record.'
                : 'Their ScoreSaber is not linked, so there is nothing to show on ScoreSaber alone. Switch the platform to Both, or link it below.'
              : 'No scores that count here yet, so there is nothing to measure.'}
          </Empty>
        </Panel>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Specialty"
              actions={
                <span className="flex flex-wrap justify-end gap-1.5">
                  <StyleBadges style={player.specialty} />
                </span>
              }
            >
              <p className="text-sm">{player.specialty.summary}</p>

              {player.specialty.pp && (
                <div className="mt-4 space-y-2">
                  {Object.entries(player.specialty.pp.share)
                    .sort((x, y) => y[1] - x[1])
                    .filter(([, share]) => share >= 0.005)
                    .map(([kind, share]) => (
                      <div key={kind}>
                        <div className="mb-1 flex items-baseline justify-between text-xs">
                          <span className="font-medium text-ink">{kind}</span>
                          <span className="tabular text-faint">{pct(share, 0)} of their pp</span>
                        </div>
                        <Meter value={share} color={team.color} className="h-1.5" />
                      </div>
                    ))}
                  <p className="text-[11px] text-faint">
                    Where their pp comes from, over {player.specialty.pp.scores} ranked scores
                    {stats.source === 'both' ? ' - BeatLeader and ScoreSaber each worked out separately, then averaged' : ` on ${SCORE_SOURCES[stats.source]}`}.
                    It needs no maps in common with anyone.
                  </p>
                </div>
              )}

              {player.specialty.kinds.length >= 2 && (
                <ol className="mt-4 space-y-1 border-t border-edge pt-3 text-sm">
                  <li className="pb-1 text-[11px] text-faint">
                    {player.specialty.source === 'PP'
                      ? 'For comparison, accuracy against the field on the maps they share with it:'
                      : 'From the maps they share with the rest of the field - they have too few ranked scores for a pp profile to mean much:'}
                  </li>
                  {player.specialty.kinds.map((k, i, all) => (
                    <li key={k.kind} className="flex items-baseline justify-between gap-3">
                      <span
                        className={
                          i === 0 ? 'font-semibold text-win' : i === all.length - 1 ? 'font-semibold text-warn' : 'text-muted'
                        }
                      >
                        {k.kind}
                        {player.specialty.source === 'SHARED_MAPS' && i === 0 && ' - best'}
                        {player.specialty.source === 'SHARED_MAPS' && i === all.length - 1 && ' - worst'}
                      </span>
                      <span
                        className={`shrink-0 tabular ${k.gap >= 0 ? 'text-win' : 'text-lose'}`}
                        title={`Against the rest of the field on the ${k.kind} maps both have played. Ordered by that gap relative to how far ${k.kind} maps spread players apart.`}
                      >
                        {signedPoints(k.gap, 1)} vs the field
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {style.traits.length > 0 && (
                <ul className="mt-4 space-y-2.5">
                  {style.traits.map((trait) => (
                    <li key={trait.key} className="text-sm">
                      <span className={`font-semibold ${toneInk[trait.tone]}`}>{trait.label}.</span>{' '}
                      <span className="text-muted">{trait.detail}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 space-y-3 border-t border-edge pt-4">
                {(
                  [
                    [
                      'Standing',
                      overall.fieldRank && overall.fieldRanked > 1
                        ? (overall.fieldRanked - overall.fieldRank) / (overall.fieldRanked - 1)
                        : 0,
                      'Where they rank in the field, on maps in common with each other player',
                    ],
                    ['Consistency', style.percentiles.consistency, 'How tight a band their scores sit in, against the rest of the field'],
                    ['Full combos', style.percentiles.fullCombos, 'Share of maps full-comboed'],
                  ] as const
                ).map(([label, value, hint]) => (
                  <div key={label} title={hint}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-muted">{label}</span>
                      <span className="tabular text-faint">
                        ahead of {Math.round(value * 100)}% of the field
                      </span>
                    </div>
                    <Meter value={value} color={team.color} className="h-1.5" />
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Numbers"
              subtitle={
                stats.view === 'pool'
                  ? `From ${player.played} of ${stats.mapCount} pool maps${player.played < stats.mapCount ? ' - the averages cover only those' : ''}`
                  : `From ${profile.scoreCount} of their ${player.storedScores.toLocaleString('en-US')} stored scores - the ones on maps someone else here has also played, which are all that can be compared`
              }
            >
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Average">{pct(profile.meanAcc)}</Stat>
                <Stat label="Median">{pct(profile.medianAcc)}</Stat>
                <Stat label="Best / worst">
                  {pct(profile.bestAcc, 1)} / {pct(profile.worstCleanAcc, 1)}
                </Stat>
                <Stat
                  label="On team"
                  hint={`By average gap to teammates on the maps both have played: ${overall.vsTeam.gap != null ? signedPoints(overall.vsTeam.gap) : 'nothing in common'}`}
                >
                  {overall.teamRank ? `#${overall.teamRank} of ${overall.teamRanked}` : '—'}
                  {overall.vsTeam.gap != null && (
                    <span className={`ml-1.5 text-xs ${overall.vsTeam.gap >= 0 ? 'text-win' : 'text-lose'}`}>
                      {signedPoints(overall.vsTeam.gap, 1)}
                    </span>
                  )}
                </Stat>
                <Stat
                  label="In the field"
                  hint="By average gap to everyone in the tournament, on the maps both have played"
                >
                  {overall.fieldRank ? `#${overall.fieldRank} of ${overall.fieldRanked}` : '—'}
                  {overall.vsField.gap != null && (
                    <span className={`ml-1.5 text-xs ${overall.vsField.gap >= 0 ? 'text-win' : 'text-lose'}`}>
                      {signedPoints(overall.vsField.gap, 1)}
                    </span>
                  )}
                </Stat>
                <Stat label="Spread" hint="Typical run-to-run swing in accuracy points">
                  ±{player.spreadPoints?.toFixed(2)} pts
                </Stat>
                <Stat label="Full combos">{pct(profile.fcRate, 0)}</Stat>
                <Stat label="Paused" hint="Share of scores set with a pause">
                  {pct(profile.pauseRate, 0)}
                </Stat>
                <Stat label="Hands" hint="Average cut score, left minus right">
                  {Math.abs(profile.handBalance) < 0.05
                    ? 'Even'
                    : `${profile.handBalance > 0 ? 'Left' : 'Right'} +${Math.abs(profile.handBalance).toFixed(1)}`}
                </Stat>
                <Stat
                  label={`Best ${group}`}
                  hint={`Maps where they are in ${team.name}'s strongest ${group} by expected score`}
                >
                  {player.inBestGroup} of {stats.mapCount} maps
                </Stat>
                <Stat label="Team best" hint="Maps where no teammate is expected to outscore them">
                  {player.bestOnTeam} of {stats.mapCount} maps
                </Stat>
                <Stat label="Abandoned">{profile.failCount}</Stat>
              </dl>
            </Panel>
          </div>

          <Panel
            title="By kind of map"
            subtitle={`Rank on ${team.name}, in the field, or against their own level - the same ranks the team view sorts by`}
          >
            {player.kinds.length === 0 ? (
              <Empty>
                No map they have played is tagged with a kind. An organiser can set each map&apos;s kind on the
                pool page.
              </Empty>
            ) : (
              <KindBreakdown rows={kindRows} teamName={team.name} />
            )}
            {player.kinds.some((k) => k.maps === 0) && (
              <p className="mt-3 text-xs text-warn">
                No score on: {player.kinds.filter((k) => k.maps === 0).map((k) => k.kind).join(', ')}.
              </p>
            )}
          </Panel>
        </>
      )}

      {spots.map(({ team: t, player: me }) => {
        const mates = t.players.filter((p) => p.playerId !== playerId);
        if (mates.length === 0) return null;
        return (
          <Panel
            key={t.teamId}
            title={
              <>
                Against teammates on{' '}
                <span style={{ color: teamInk(t.color, t.colorSecondary) }}>{t.name}</span>
              </>
            }
            subtitle="Only on maps both have actually played - a prediction never wins a comparison"
            flush
          >
            <ul className="divide-y divide-edge/60">
              {mates.map((mate) => {
                const theirs = new Map(
                  mate.lines.filter((l) => l.proven).map((l) => [l.map.leaderboardId, l.expected]),
                );
                const shared = me.lines.filter((l) => l.proven && theirs.has(l.map.leaderboardId));
                const ahead = shared.filter((l) => l.expected > theirs.get(l.map.leaderboardId)!).length;
                const gap = shared.length
                  ? shared.reduce((sum, l) => sum + l.expected - theirs.get(l.map.leaderboardId)!, 0) /
                    shared.length
                  : null;
                return (
                  <li key={mate.playerId} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar src={mate.avatar} name={mate.name} size={32} ring={t.color} />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/t/${slug}/stats/${mate.playerId}${viewQuery}`}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {mate.name}
                      </Link>
                      <div className="mt-1 flex items-center gap-2">
                        <Meter
                          value={shared.length ? ahead / shared.length : 0}
                          color={t.color}
                          className="flex-1"
                        />
                        <span className="shrink-0 text-xs tabular text-muted">
                          ahead on {ahead} of {shared.length}
                        </span>
                      </div>
                    </div>
                    <div className="w-20 shrink-0 text-right">
                      {gap != null ? (
                        <>
                          <p className={`text-sm font-semibold tabular ${gap >= 0 ? 'text-win' : 'text-lose'}`}>
                            {signedPoints(gap)}
                          </p>
                          <p className="text-[10px] text-faint">on those maps</p>
                        </>
                      ) : (
                        <p className="text-xs text-faint">no shared maps</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        );
      })}

      <ScoreSaberPanel
        slug={slug}
        playerId={playerId}
        name={player.name}
        scoreSaber={player.scoreSaber}
        mayLink={(actor.userId !== '' && actor.userId === player.userId) || can(actor, 'MANAGE_TEAMS')}
        error={error}
      />

      <Panel title="Map by map" subtitle={`Ranked within ${team.name}`} flush>
        {player.lines.length === 0 ? (
          <div className="p-4">
            <Empty>No map pools yet.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-edge/60">
            {player.lines.map((line) => (
              <li key={line.map.leaderboardId} className="flex items-center gap-3 px-4 py-2.5">
                <MapCover src={line.map.coverImage} size={40} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/t/${slug}/pool/${line.poolId}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {line.map.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <DifficultyChip value={line.map.difficultyValue} label={line.map.difficultyLabel} />
                    {(line.map.category ?? line.map.autoCategory) && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                        {line.map.category ?? line.map.autoCategory}
                      </span>
                    )}
                    <span className="tabular">
                      #{line.teamRank} of {line.teamSize} on team
                    </span>
                    {line.inBestGroup && <Badge tone="accent">best {group}</Badge>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {line.cell.acc != null ? (
                    <>
                      <p className={`text-sm font-semibold tabular ${line.cell.isDnf ? 'text-lose line-through' : ''}`}>
                        {pct(line.cell.acc)}
                      </p>
                      <p className="text-[10px] tabular text-faint">{num(line.cell.score ?? 0)}</p>
                    </>
                  ) : (
                    <>
                      <p
                        className="text-sm italic tabular text-faint"
                        title="Not played. This is the cautious end of the model's prediction, which is what their team rank on this map is judged on."
                      >
                        ~{pct(line.expected, 1)}
                      </p>
                      <p className="text-[10px] text-faint">not played</p>
                    </>
                  )}
                </div>
                <div className="hidden w-24 shrink-0 text-right text-xs tabular sm:block">
                  {line.vsTeam != null && (
                    <p className={line.vsTeam >= 0 ? 'text-win' : 'text-lose'}>{signedPoints(line.vsTeam)} team</p>
                  )}
                  {line.vsField != null && (
                    <p className={line.vsField >= 0 ? 'text-win/80' : 'text-lose/80'}>
                      {signedPoints(line.vsField)} field
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="In matches"
        subtitle="What was scored on the night, which is not always what the leaderboard says"
        flush
      >
        {player.match.maps === 0 ? (
          <div className="p-4">
            <Empty>No match scores recorded yet.</Empty>
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
              <Stat label="Maps played">{player.match.maps}</Stat>
              <Stat label="Maps won" hint="Their team took the map">
                {player.match.mapsWon}
              </Stat>
              <Stat label="Match average">
                {player.match.meanAcc != null ? pct(player.match.meanAcc) : '—'}
              </Stat>
              <Stat
                label="Against their best"
                hint="Match accuracy against their leaderboard best on the same maps. Nearly everyone is below zero - the leaderboard keeps only the best run."
              >
                {player.match.vsBest != null ? `${signedPoints(player.match.vsBest)} pts` : '—'}
              </Stat>
            </dl>
            <ul className="divide-y divide-edge/60 border-t border-edge text-sm">
              {player.match.runs.slice(0, 20).map((run, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{run.mapName}</p>
                    <Link
                      href={`/t/${slug}/match/${run.matchId}`}
                      className="block truncate text-xs text-muted hover:underline"
                    >
                      {run.matchName} · for {run.teamName}
                    </Link>
                  </div>
                  {run.won != null && <Badge tone={run.won ? 'win' : 'lose'}>{run.won ? 'Map won' : 'Map lost'}</Badge>}
                  <span className="w-16 shrink-0 text-right tabular">{pct(run.accuracy)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}

/**
 * ScoreSaber: a second ranked system, with its own pp and its own maps. Linked
 * by itself for Steam players, whose id is the same on both sites; by pasting a
 * profile for everyone else.
 */
function ScoreSaberPanel({
  slug,
  playerId,
  name,
  scoreSaber,
  mayLink,
  error,
}: {
  slug: string;
  playerId: string;
  name: string;
  scoreSaber: NonNullable<Awaited<ReturnType<typeof buildTournamentStats>>['teams'][number]['players'][number]['scoreSaber']> | null;
  mayLink: boolean;
  error?: string;
}) {
  if (!scoreSaber && !mayLink) return null;
  return (
    <Panel
      title="ScoreSaber"
      subtitle={
        scoreSaber
          ? 'Their other ranked profile: different ranked maps, its own pp'
          : 'Not linked. Linking adds their ScoreSaber pp, rank and score history.'
      }
      actions={
        scoreSaber ? (
          <a
            href={`https://scoresaber.com/u/${scoreSaber.id}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center rounded-lg border border-edge bg-raised/60 px-2.5 text-xs font-medium hover:border-faint"
          >
            ScoreSaber profile
          </a>
        ) : null
      }
    >
      <FormError message={error} />
      {scoreSaber ? (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="ScoreSaber pp">{Math.round(scoreSaber.pp).toLocaleString('en-US')}pp</Stat>
            <Stat label="Rank" hint={scoreSaber.countryRank ? `#${scoreSaber.countryRank.toLocaleString('en-US')} in their country` : undefined}>
              {scoreSaber.rank ? `#${scoreSaber.rank.toLocaleString('en-US')}` : '—'}
            </Stat>
            <Stat label="Ranked average" hint="ScoreSaber's own figure, over every ranked map they have played there">
              {scoreSaber.avgRankedAcc > 0 ? pct(scoreSaber.avgRankedAcc) : '—'}
            </Stat>
            <Stat label="Scores stored" hint={`${scoreSaber.storedRanked.toLocaleString('en-US')} of them on maps ranked on ScoreSaber`}>
              {scoreSaber.synced || scoreSaber.storedScores > 0
                ? scoreSaber.storedScores.toLocaleString('en-US')
                : 'fetching…'}
            </Stat>
          </dl>
          {mayLink && (
            <form action={linkScoreSaber} className="mt-3">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="playerId" value={playerId} />
              <input type="hidden" name="unlink" value="on" />
              <button type="submit" className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink">
                Not {name}&apos;s profile? Unlink it
              </button>
            </form>
          )}
        </>
      ) : (
        <form action={linkScoreSaber} className="flex flex-wrap items-start gap-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="playerId" value={playerId} />
          <div className="min-w-[14rem] flex-1">
            <Field
              label="ScoreSaber profile"
              hint="The link to their profile page, or the number in it. Steam players are linked by themselves within a few minutes."
            >
              <input name="profile" className={inputClass} placeholder="https://scoresaber.com/u/7656119..." required />
            </Field>
          </div>
          <FieldAction>
            <Button type="submit">Link</Button>
          </FieldAction>
        </form>
      )}
    </Panel>
  );
}
