import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import {
  Avatar,
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
import { DivergingBar, StyleBadge, signedPoints } from '@/components/player-stats';
import { getActorOrAnonymous } from '@/server/session';
import { buildTournamentStats } from '@/server/player-stats';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ playerId: string }>;
}): Promise<Metadata> {
  const player = await prisma.player.findUnique({
    where: { id: (await params).playerId },
    select: { name: true },
  });
  return { title: player ? `${player.name} - player stats` : 'Player stats' };
}

const toneInk = { good: 'text-win', bad: 'text-lose', neutral: 'text-ink' } as const;

export default async function PlayerStatsPage({
  params,
}: {
  params: Promise<{ slug: string; playerId: string }>;
}) {
  const { slug, playerId } = await params;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const stats = await buildTournamentStats(tournament.id);
  // Entered teams are listed first, so that is the side their headline figures are against.
  const spots = stats.teams.flatMap((team) =>
    team.players.filter((p) => p.playerId === playerId).map((player) => ({ team, player })),
  );
  const primary = spots[0];
  if (!primary) notFound();

  const { team, player } = primary;
  const { profile, style } = player;
  const group = stats.playersPerMap === 2 ? 'duo' : 'group';
  const leanScale = Math.max(0.5, ...(style?.categories.map((c) => Math.abs(c.accPoints)) ?? []));

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[
          { label: tournament.name, href: `/t/${slug}` },
          { label: 'Player stats', href: `/t/${slug}/stats` },
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
          <a
            href={`https://beatleader.com/u/${player.beatLeaderId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium hover:border-faint"
          >
            BeatLeader profile
          </a>
        }
      />

      {!profile || !style ? (
        <Panel>
          <Empty>No scores on this tournament&apos;s pools yet, so there is nothing to measure.</Empty>
        </Panel>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Play style" actions={<StyleBadge style={style} />}>
              <p className="text-sm">{style.summary}</p>

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
                    ['Skill', style.percentiles.skill, 'Overall level from the model'],
                    ['Consistency', style.percentiles.consistency, 'How closely scores follow expectation'],
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

            <Panel title="Numbers" subtitle={`${profile.scoreCount} scores on the pool`}>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Average">{pct(profile.meanAcc)}</Stat>
                <Stat label="Median">{pct(profile.medianAcc)}</Stat>
                <Stat label="Best / worst">
                  {pct(profile.bestAcc, 1)} / {pct(profile.worstCleanAcc, 1)}
                </Stat>
                <Stat label="On team" hint="By model skill, among teammates">
                  #{player.teamRank} of {team.players.length}
                </Stat>
                <Stat label="In the field" hint="By model skill, among everyone with scores">
                  #{player.fieldRank} of {stats.fieldSize}
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

          {style.categories.length > 0 && (
            <Panel
              title="By kind of map"
              subtitle="Against what their general level predicts, in accuracy points"
            >
              <ul className="space-y-3">
                {style.categories.map((c) => (
                  <li key={c.category} className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-3 text-sm">
                    <span className="truncate font-medium">{c.category}</span>
                    <DivergingBar value={c.accPoints} scale={leanScale} />
                    <span
                      className={`text-right tabular ${c.accPoints >= 0 ? 'text-win' : 'text-lose'}`}
                      title={`${c.maps} map${c.maps === 1 ? '' : 's'}`}
                    >
                      {c.accPoints >= 0 ? '+' : '−'}
                      {Math.abs(c.accPoints).toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
              {style.categories.some((c) => c.maps < 2) && (
                <p className="mt-3 text-xs text-faint">
                  A category with a single map behind it is one score, not a pattern.
                </p>
              )}
            </Panel>
          )}
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
            subtitle="Map by map, on real scores where both have one and predictions where not"
            flush
          >
            <ul className="divide-y divide-edge/60">
              {mates.map((mate) => {
                const mateLine = new Map(mate.lines.map((l) => [l.map.leaderboardId, l.expected]));
                const shared = me.lines.filter((l) => mateLine.has(l.map.leaderboardId));
                const ahead = shared.filter((l) => l.expected > mateLine.get(l.map.leaderboardId)!).length;
                const gap =
                  me.profile && mate.profile && me.profile.meanAcc > 0 && mate.profile.meanAcc > 0
                    ? me.profile.meanAcc - mate.profile.meanAcc
                    : null;
                return (
                  <li key={mate.playerId} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar src={mate.avatar} name={mate.name} size={32} ring={t.color} />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/t/${slug}/stats/${mate.playerId}`}
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
                          <p className="text-[10px] text-faint">average</p>
                        </>
                      ) : (
                        <p className="text-xs text-faint">no scores</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        );
      })}

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
                      <p className="text-sm italic tabular text-faint">~{pct(line.expected, 1)}</p>
                      <p className="text-[10px] text-faint">predicted</p>
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
