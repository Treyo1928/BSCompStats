import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import { Avatar, Badge, Empty, Meter, PageHeader, Panel, pct, teamInk, teamWash } from '@/components/ui';
import { StyleBadge, signedPoints } from '@/components/player-stats';
import { getActorOrAnonymous } from '@/server/session';
import { buildTournamentStats, type PlayerStats, type TeamStats } from '@/server/player-stats';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Player stats' };

export default async function StatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ team?: string }>;
}) {
  const { slug } = await params;
  const { team: wantedTeam } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const stats = await buildTournamentStats(tournament.id);
  const shown = stats.teams.filter((t) => !wantedTeam || t.teamId === wantedTeam);
  const group = stats.playersPerMap === 2 ? 'duo' : 'group';

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Player stats"
        meta={`${stats.fieldSize} players with scores across ${stats.mapCount} pool maps. Everything here is measured against teammates first, then the field.`}
      />

      {stats.teams.length > 1 && (
        <nav className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 text-xs sm:mx-0 sm:flex-wrap sm:px-0">
          <TeamTab href={`/t/${slug}/stats`} name="All teams" active={!wantedTeam} />
          {stats.teams.map((t) => (
            <TeamTab
              key={t.teamId}
              href={`/t/${slug}/stats?team=${t.teamId}`}
              name={t.name}
              color={t.color}
              active={t.teamId === wantedTeam}
            />
          ))}
        </nav>
      )}

      {shown.length === 0 && (
        <Panel>
          <Empty>No teams yet. Player stats appear once teams have players with scores.</Empty>
        </Panel>
      )}

      {shown.map((team) => (
        <Panel key={team.teamId} flush>
          <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-edge px-4 py-3"
            style={{
              background: `linear-gradient(90deg, ${teamWash(team.color)}, transparent 70%)`,
              borderLeft: `3px solid ${team.color}`,
            }}
          >
            <div className="min-w-0">
              <h2
                className="flex items-center gap-2 truncate text-base font-semibold tracking-tight"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                {team.name}
                {team.adHoc && <Badge title="Put together for a particular match">Match-only</Badge>}
              </h2>
              {team.shape && <p className="text-xs text-muted">{team.shape}</p>}
            </div>
            {team.meanAcc != null && (
              <p className="text-xs text-muted">
                Team average <span className="font-semibold tabular text-ink">{pct(team.meanAcc)}</span>
              </p>
            )}
          </div>

          {team.players.length === 0 ? (
            <div className="p-4">
              <Empty>No players yet.</Empty>
            </div>
          ) : (
            <>
              <ul className="grid gap-3 p-3 sm:p-4 md:grid-cols-2">
                {[...team.players]
                  .sort((a, b) => (a.teamRank ?? 99) - (b.teamRank ?? 99))
                  .map((player) => (
                    <PlayerCard
                      key={player.playerId}
                      slug={slug}
                      team={team}
                      player={player}
                      mapCount={stats.mapCount}
                      group={group}
                    />
                  ))}
              </ul>
              <ComparisonTable team={team} slug={slug} mapCount={stats.mapCount} group={group} />
            </>
          )}
        </Panel>
      ))}

      <p className="text-xs text-faint">
        Style and consistency come from the same model as the pool board&apos;s predictions, fitted on{' '}
        {stats.model.observationCount} scores. A lean toward a kind of map needs two maps behind it before
        it names a player&apos;s style; with one it is listed and marked as thin.
      </p>
    </div>
  );
}

function TeamTab({
  href,
  name,
  color,
  active,
}: {
  href: string;
  name: string;
  color?: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-medium transition ${
        active
          ? 'border-accent bg-accent/15 text-ink'
          : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
      }`}
    >
      {color && <span className="h-2 w-2 rounded-full ring-1 ring-white/25" style={{ background: color }} />}
      {name}
    </Link>
  );
}

function PlayerCard({
  slug,
  team,
  player,
  mapCount,
  group,
}: {
  slug: string;
  team: TeamStats;
  player: PlayerStats;
  mapCount: number;
  group: string;
}) {
  const { profile, style } = player;
  return (
    <li>
      <Link
        href={`/t/${slug}/stats/${player.playerId}`}
        className="flex h-full flex-col gap-3 rounded-lg border border-edge bg-raised/40 p-3 transition hover:border-faint hover:bg-raised"
      >
        <div className="flex items-center gap-3">
          <Avatar src={player.avatar} name={player.name} size={40} ring={team.color} />
          <div className="min-w-0 flex-1">
            <p className={`truncate font-semibold ${player.available ? '' : 'text-muted'}`}>
              {player.name}
              {player.isCaptain && <span className="ml-1.5 text-xs text-accent">★</span>}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <StyleBadge style={style} />
              {!player.available && <Badge tone="warn">{player.isSub ? 'Sub' : 'Absent'}</Badge>}
            </div>
          </div>
          {profile && profile.meanAcc > 0 && (
            <div className="shrink-0 text-right">
              <p className="text-lg font-bold leading-none tabular">{pct(profile.meanAcc)}</p>
              {player.accVsTeam != null && (
                <p
                  className={`mt-1 text-[11px] tabular ${player.accVsTeam >= 0 ? 'text-win' : 'text-lose'}`}
                  title="Average accuracy against the average of their teammates"
                >
                  {signedPoints(player.accVsTeam)} vs team
                </p>
              )}
            </div>
          )}
        </div>

        {profile && style && !style.thin ? (
          <>
            <p className="text-xs text-muted">{style.summary}</p>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <Figure
                label="On team"
                value={`#${player.teamRank} of ${team.players.length}`}
                hint="By the model's skill estimate, which allows for which maps each of them has played and how hard those proved - so it can differ from the order of their averages"
              />
              <Figure
                label={`Best ${group}`}
                value={`${player.inBestGroup}/${mapCount}`}
                hint={`Maps where they are in the team's strongest ${group} by expected score`}
              />
              <Figure
                label="Team best"
                value={`${player.bestOnTeam}/${mapCount}`}
                hint="Maps where nobody on the team is expected to outscore them"
              />
            </dl>
            <div title="How closely their scores follow expectation, against the rest of the field">
              <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-faint">
                <span>Consistency</span>
                <span className="tabular">±{player.spreadPoints?.toFixed(2)} pts</span>
              </div>
              <Meter value={style.percentiles.consistency} color={team.color} />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">
            {style?.summary ?? 'No scores on the pool yet, so there is nothing to say about how they play.'}
          </p>
        )}
      </Link>
    </li>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-edge bg-panel/60 px-1 py-1.5" title={hint}>
      <dt className="text-[9px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-sm font-semibold tabular">{value}</dd>
    </div>
  );
}

/** The whole team on one grid. Wide, so it is for screens that have the room. */
function ComparisonTable({
  team,
  slug,
  mapCount,
  group,
}: {
  team: TeamStats;
  slug: string;
  mapCount: number;
  group: string;
}) {
  const rows = team.players.filter((p) => p.profile);
  if (rows.length < 2) return null;
  return (
    <div className="hidden overflow-x-auto border-t border-edge md:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
            <th className="px-4 py-2 font-medium">Side by side</th>
            <th className="px-3 py-2 text-right font-medium">Average</th>
            <th className="px-3 py-2 text-right font-medium">Best</th>
            <th className="px-3 py-2 text-right font-medium">Spread</th>
            <th className="px-3 py-2 text-right font-medium">Full combos</th>
            <th className="px-3 py-2 text-right font-medium">Best {group}</th>
            <th className="px-3 py-2 text-right font-medium">Field rank</th>
            <th className="px-4 py-2 text-right font-medium" title="Accuracy in matches against their leaderboard best on the same maps">
              In matches
            </th>
          </tr>
        </thead>
        <tbody>
          {rows
            .sort((a, b) => (a.teamRank ?? 99) - (b.teamRank ?? 99))
            .map((p) => (
              <tr key={p.playerId} className="border-t border-edge/60">
                <td className="px-4 py-2">
                  <Link href={`/t/${slug}/stats/${p.playerId}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular">{pct(p.profile!.meanAcc)}</td>
                <td className="px-3 py-2 text-right tabular text-muted">{pct(p.profile!.bestAcc)}</td>
                <td className="px-3 py-2 text-right tabular text-muted">±{p.spreadPoints?.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular text-muted">{pct(p.profile!.fcRate, 0)}</td>
                <td className="px-3 py-2 text-right tabular">
                  {p.inBestGroup}/{mapCount}
                </td>
                <td className="px-3 py-2 text-right tabular text-muted">#{p.fieldRank}</td>
                <td className="px-4 py-2 text-right tabular text-muted">
                  {p.match.vsBest != null ? `${signedPoints(p.match.vsBest)} · ${p.match.maps} maps` : '—'}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
