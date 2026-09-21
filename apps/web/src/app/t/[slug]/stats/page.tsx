import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import { Avatar, Badge, Button, Empty, Meter, PageHeader, Panel, pct, teamInk, teamWash } from '@/components/ui';
import { StyleBadges, signedPoints } from '@/components/player-stats';
import { getActorOrAnonymous } from '@/server/session';
import { setKeepHistory } from '@/server/actions';
import { getStatsSummary } from '@/server/summaries';
import { MIN_PP_SCORES } from '@bscs/core/stats';
import { SCORE_SOURCES, type ScoreSource } from '@/server/score-sources';
import {
  buildTournamentStats,
  isPpKey,
  OVERALL,
  STATS_VIEWS,
  type PlayerStats,
  type RankKey,
  type StatsView,
  type TeamStats,
} from '@/server/player-stats';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const summary = await getStatsSummary((await params).slug);
  // Private or missing: say nothing about it, and let the site's card stand in.
  if (!summary) return { title: 'Player stats' };

  const title = `Player stats - ${summary.tournamentName}`;
  return { title, description: summary.description, openGraph: { title, description: summary.description } };
}

const rankLabel = (key: RankKey) => (key === OVERALL ? 'Overall' : key);
/** "same maps" / "same Tech maps" */
const sameMaps = (key: RankKey) => (key === OVERALL ? 'same maps' : `same ${key} maps`);
const wholePp = (pp: number) => `${Math.round(pp).toLocaleString('en-US')}pp`;
/** A pp rank's figure: one platform's pp, or each platform's side by side - they are different currencies and are never added. */
const ppText = (standing: { pp?: number; ppParts?: { BL?: number; SS?: number } }): string => {
  const parts = [
    standing.ppParts?.BL ? `${wholePp(standing.ppParts.BL)} BL` : null,
    standing.ppParts?.SS ? `${wholePp(standing.ppParts.SS)} SS` : null,
  ].filter(Boolean);
  if (parts.length === 0) return standing.pp && standing.pp > 1 ? wholePp(standing.pp) : '—';
  return parts.length === 1 ? parts[0]!.replace(/ (BL|SS)$/, '') : parts.join(' · ');
};

export default async function StatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ team?: string; view?: string; by?: string; src?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const stats = await buildTournamentStats(tournament.id, query.view, query.src);
  const by: RankKey = stats.rankKeys.find((key) => key === query.by) ?? OVERALL;
  const shown = stats.teams.filter((t) => !query.team || t.teamId === query.team);
  const group = stats.playersPerMap === 2 ? 'duo' : 'group';

  // Every control is a link that changes one thing and keeps the rest.
  const href = (change: { team?: string | null; view?: StatsView; by?: RankKey; src?: ScoreSource }) => {
    const next = new URLSearchParams();
    const team = change.team === undefined ? query.team : change.team;
    const view = change.view ?? stats.view;
    const rankBy = change.by ?? by;
    if (team) next.set('team', team);
    // Pool maps and overall are what a bare link means.
    if (view !== 'pool') next.set('view', view);
    if (rankBy !== OVERALL) next.set('by', rankBy);
    // Both platforms together is what a bare link means.
    if ((change.src ?? stats.source) !== 'both') next.set('src', change.src ?? stats.source);
    const qs = next.toString();
    return `/t/${slug}/stats${qs ? `?${qs}` : ''}`;
  };
  // Carries the team: someone on two teams is ranked differently in each, and
  // their page has to open on the one the viewer was just looking at.
  const playerHref = (playerId: string, teamId: string) => {
    const next = new URLSearchParams();
    if (stats.view !== 'pool') next.set('view', stats.view);
    if (stats.source !== 'both') next.set('src', stats.source);
    next.set('team', teamId);
    return `/t/${slug}/stats/${playerId}?${next}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Player stats"
        meta={`${stats.fieldSize} players with scores. Ranked on like-for-like comparisons: only maps both players have actually played.`}
      />

      {/* One strip: it wraps where there is room and scrolls sideways on a phone, but it is never three rows tall. */}
      <div className="-mx-3 flex items-center gap-x-5 gap-y-2 overflow-x-auto px-3 text-xs sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        <Pills label="Based on">
          {(Object.keys(STATS_VIEWS) as StatsView[]).map((view) => (
            <Pill key={view} href={href({ view })} active={stats.view === view}>
              {STATS_VIEWS[view].label}
            </Pill>
          ))}
        </Pills>
        <Pills label="Platform">
          {(Object.keys(SCORE_SOURCES) as ScoreSource[]).map((src) => (
            <Pill key={src} href={href({ src })} active={stats.source === src}>
              {SCORE_SOURCES[src]}
            </Pill>
          ))}
        </Pills>
        <Pills label="Rank by">
          {stats.rankKeys.map((key) => (
            <Pill key={key} href={href({ by: key })} active={by === key}>
              {rankLabel(key)}
            </Pill>
          ))}
        </Pills>
        {stats.teams.length > 1 && (
          <Pills label="Team">
            <Pill href={href({ team: null })} active={!query.team}>
              All
            </Pill>
            {stats.teams.map((t) => (
              <Pill key={t.teamId} href={href({ team: t.teamId })} active={t.teamId === query.team} color={t.color}>
                {t.name}
              </Pill>
            ))}
          </Pills>
        )}
      </div>

      {/* A wider view is only as good as what has been downloaded for it. */}
      {(stats.view !== 'pool' || can(actor, 'MANAGE_TOURNAMENT')) && (!stats.keepsHistory || stats.widerScores === 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="min-w-0 flex-1">
            {stats.keepsHistory
              ? 'Players’ BeatLeader history is being downloaded. Ranked and all-map views fill in as it arrives - a few minutes for a new tournament.'
              : 'Ranked and all-map views need each player’s BeatLeader history, which this tournament has not downloaded - so they currently show the pool’s scores and nothing more.'}
          </p>
          {!stats.keepsHistory && can(actor, 'MANAGE_TOURNAMENT') && (
            <form action={setKeepHistory}>
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <input type="hidden" name="keep" value="on" />
              <Button type="submit" variant="ghost">
                Download history
              </Button>
            </form>
          )}
        </div>
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
            <p className="text-xs text-muted">
              Ranked by <span className="font-semibold text-ink">{rankLabel(by).toLowerCase()}</span>
              {team.meanAcc != null && (
                <>
                  {' '}
                  · team average <span className="font-semibold tabular text-ink">{pct(team.meanAcc)}</span>
                </>
              )}
            </p>
          </div>

          {team.players.length === 0 ? (
            <div className="p-4">
              <Empty>No players yet.</Empty>
            </div>
          ) : (
            <>
              <ul className="grid gap-3 p-3 sm:p-4 md:grid-cols-2">
                {sorted(team.players, by).map((player) => (
                  <PlayerCard
                    key={player.playerId}
                    href={playerHref(player.playerId, team.teamId)}
                    team={team}
                    player={player}
                    by={by}
                    rankKeys={stats.rankKeys}
                    poolView={stats.view === 'pool'}
                    mapCount={stats.mapCount}
                    group={group}
                  />
                ))}
              </ul>
              <RankTable team={team} by={by} rankKeys={stats.rankKeys} playerHref={playerHref} sortHref={(key) => href({ by: key })} />
            </>
          )}
        </Panel>
      ))}

      <p className="text-xs text-faint">
        A rank here is a rank by the number beside it: the average gap to teammates, in accuracy points,
        over the maps both have a real score on. A map only one of them has played never counts, for or
        against, and someone with no map in common is left unranked rather than placed last. That only
        works where histories overlap. Tech pp, Acc pp and Speed pp rank by BeatLeader&apos;s own figures
        instead - everything ranked a player has ever played - and are the ones to trust for players
        who share few maps with anyone here.
        A kind of map means exactly the maps called that - a Speed Tech map counts toward Speed Tech and
        toward nothing else - and it means the same maps on a player&apos;s own page. The specialist and
        &quot;worst on&quot; labels are about the player, not the team, and two teammates can share one. For
        anyone with {MIN_PP_SCORES} or more ranked scores they say where that player earns their BeatLeader pp,
        which needs no maps in common with anybody. For everyone else they come from the maps they share with
        the field. In the Ranked and All views the ranks themselves are by pp - overall, and earned on each kind
        of map - because across whole histories accuracy on shared maps only says who is more accurate.
      </p>
    </div>
  );
}

/** Best first by the chosen key; anyone unranked on it goes after, in roster order. */
function sorted(players: PlayerStats[], by: RankKey): PlayerStats[] {
  return [...players].sort(
    (a, b) => (a.standings[by].teamRank ?? Infinity) - (b.standings[by].teamRank ?? Infinity),
  );
}

function Pills({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <nav aria-label={label} className="flex shrink-0 items-center gap-1.5">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-faint">{label}</span>
      {children}
    </nav>
  );
}

function Pill({
  href,
  active,
  color,
  children,
}: {
  href: string;
  active: boolean;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 font-medium transition ${
        active
          ? 'border-accent bg-accent/15 text-ink'
          : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
      }`}
    >
      {color && <span className="h-2 w-2 rounded-full ring-1 ring-white/25" style={{ background: color }} />}
      {children}
    </Link>
  );
}

function PlayerCard({
  href,
  team,
  player,
  by,
  rankKeys,
  poolView,
  mapCount,
  group,
}: {
  href: string;
  team: TeamStats;
  player: PlayerStats;
  by: RankKey;
  rankKeys: RankKey[];
  poolView: boolean;
  mapCount: number;
  group: string;
}) {
  const { profile, style } = player;
  const standing = player.standings[by];
  const gap = standing.vsTeam.gap;
  const thinCoverage = poolView && player.played < mapCount;

  return (
    // min-w-0: a grid item will otherwise grow to its longest unbreakable line and out of the panel.
    <li className="min-w-0">
      <Link
        href={href}
        className="flex h-full flex-col gap-3 rounded-lg border border-edge bg-raised/40 p-3 transition hover:border-faint hover:bg-raised"
      >
        <div className="flex items-center gap-3">
          <span
            className="w-7 shrink-0 text-center text-lg font-bold tabular text-muted"
            title={
              standing.teamRank
                ? `#${standing.teamRank} of the ${standing.teamRanked} on ${team.name} who can be compared, ${rankLabel(by).toLowerCase()}`
                : `No ${by === 'overall' ? '' : `${by} `}map in common with a teammate, so there is nothing to rank them by`
            }
          >
            {standing.teamRank ? `#${standing.teamRank}` : '—'}
          </span>
          <Avatar src={player.avatar} name={player.name} size={40} ring={team.color} />
          <p className={`min-w-0 flex-1 truncate font-semibold ${player.available ? '' : 'text-muted'}`}>
            {player.name}
            {player.isCaptain && <span className="ml-1.5 text-xs text-accent">★</span>}
          </p>
          {/* The ranking number leads. What it is a gap to, and the average for context, go on their own line below. */}
          {standing.pp != null ? (
            <p
              className="shrink-0 text-right text-sm font-bold leading-tight tabular text-ink sm:text-base"
              title="pp over every ranked map they have played. This is what the rank is a rank of."
            >
              {standing.pp > 0 ? ppText(standing) : '—'}
            </p>
          ) : (
            <p
              className={`shrink-0 text-right text-lg font-bold leading-none tabular ${gap == null ? 'text-faint' : gap >= 0 ? 'text-win' : 'text-lose'}`}
              title={`Against teammates, over the ${sameMaps(by)} both have played - ${standing.vsTeam.comparisons} comparisons on ${standing.vsTeam.maps} maps. This is what the rank is a rank of.`}
            >
              {gap != null ? signedPoints(gap) : '—'}
            </p>
          )}
        </div>

        {/* On their own line: a style label can be long, and beside the name it pushed the card wider than a phone. */}
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          <StyleBadges style={profile ? player.specialty : null} />
          {!player.available && <Badge tone="warn">{player.isSub ? 'Sub' : 'Absent'}</Badge>}
        </div>

        <p className="-mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-faint">
          <span>
            {standing.pp != null
              ? isPpKey(by)
                ? `BeatLeader ${by}, whole ranked history`
                : by === OVERALL
                  ? 'pp, whole ranked history'
                  : `pp earned on ${by} maps`
              : gap != null
                ? `vs teammates, on the ${sameMaps(by)}`
                : `no ${sameMaps(by).replace('same ', '')} in common with a teammate`}
          </span>
          {profile && profile.meanAcc > 0 && (
            <span
              className={`tabular ${thinCoverage ? 'text-warn' : ''}`}
              title={
                thinCoverage
                  ? `Their average covers only the ${player.played} of ${mapCount} pool maps they have played, so it is not comparable with a teammate who has played them all`
                  : undefined
              }
            >
              {pct(profile.meanAcc)} avg ·{' '}
              {poolView
                ? `${player.played}/${mapCount} maps`
                : `${profile.scoreCount} shared of ${player.storedScores.toLocaleString('en-US')} stored`}
            </span>
          )}
        </p>

        {profile && style && !style.thin ? (
          <>
            <p className="text-xs text-muted">{player.specialty.summary}</p>
            <dl className="grid grid-cols-4 gap-1.5 text-center">
              {rankKeys.map((key) => {
                const s = player.standings[key];
                return (
                  <div
                    key={key}
                    className={`rounded-md border px-1 py-1.5 ${key === by ? 'border-accent/50 bg-accent/10' : 'border-edge bg-panel/60'}`}
                    title={
                      !s?.teamRank
                        ? `${rankLabel(key)}: ${isPpKey(key) ? 'no ranked pp' : 'no map in common with a teammate'}`
                        : s.pp != null
                          ? `${rankLabel(key)}: #${s.teamRank} of ${s.teamRanked} on the team, ${ppText(s)}`
                          : `${rankLabel(key)}: #${s.teamRank} of ${s.teamRanked} on the team, ${signedPoints(s.vsTeam.gap!)} vs teammates on the ${sameMaps(key)}`
                    }
                  >
                    <dt className="text-[9px] font-medium uppercase tracking-wider text-faint">{rankLabel(key)}</dt>
                    <dd className="text-sm font-semibold tabular">{s.teamRank ? `#${s.teamRank}` : '—'}</dd>
                  </div>
                );
              })}
            </dl>
            <div className="flex items-center gap-3 text-[11px] text-muted">
              <span title={`Maps where they are in the team's strongest ${group}. A map they have not played counts at the cautious end of its prediction.`}>
                Best {group} <span className="font-semibold tabular text-ink">{player.inBestGroup}/{mapCount}</span>
              </span>
              <span className="min-w-0 flex-1" title="How closely their scores follow expectation, against the rest of the field">
                <Meter value={style.percentiles.consistency} color={team.color} />
              </span>
              <span className="tabular">±{player.spreadPoints?.toFixed(2)} pts</span>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted">
            {profile ? player.specialty.summary : 'No scores yet, so there is nothing to say about how they play.'}
          </p>
        )}
        <p className="mt-auto flex items-center justify-end gap-1 border-t border-edge/70 pt-2 text-xs font-medium text-accent">
          Full stats, map by map <span aria-hidden>→</span>
        </p>
      </Link>
    </li>
  );
}

/** The whole team on one grid: every ranking side by side. Scrolls sideways on a phone. */
function RankTable({
  team,
  by,
  rankKeys,
  playerHref,
  sortHref,
}: {
  team: TeamStats;
  by: RankKey;
  rankKeys: RankKey[];
  playerHref: (playerId: string, teamId: string) => string;
  sortHref: (key: RankKey) => string;
}) {
  if (team.players.length < 2) return null;
  return (
    <div className="overflow-x-auto border-t border-edge">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
            <th className="px-4 py-2 font-medium">Rank within {team.name}</th>
            {rankKeys.map((key) => (
              <th key={key} className="px-3 py-2 text-right font-medium">
                <Link
                  href={sortHref(key)}
                  scroll={false}
                  className={key === by ? 'text-accent' : 'hover:text-ink'}
                  title={`Sort by ${rankLabel(key).toLowerCase()}`}
                >
                  {rankLabel(key)}
                  {key === by && ' ↓'}
                </Link>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium">In field</th>
            <th className="px-4 py-2 text-right font-medium" title="Accuracy in matches against their leaderboard best on the same maps">
              In matches
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted(team.players, by).map((p) => (
            <tr key={p.playerId} className="border-t border-edge/60">
              <td className="px-4 py-2">
                <Link href={playerHref(p.playerId, team.teamId)} className="font-medium hover:underline">
                  {p.name}
                </Link>
              </td>
              {rankKeys.map((key) => {
                const s = p.standings[key];
                return (
                  <td
                    key={key}
                    className={`px-3 py-2 text-right tabular ${key === by ? 'bg-accent/5' : ''}`}
                    title={
                      s.pp != null
                        ? 'BeatLeader pp, over their whole ranked history - this is what the rank is a rank of'
                        : s.teamRank
                          ? `${s.vsTeam.comparisons} comparisons on ${s.vsTeam.maps} maps`
                          : 'No map in common with a teammate'
                    }
                  >
                    {s.teamRank ? (
                      <>
                        <span className="font-semibold">#{s.teamRank}</span>{' '}
                        {s.pp != null ? (
                          <span className="text-xs text-muted">{ppText(s)}</span>
                        ) : (
                          <span className={`text-xs ${s.vsTeam.gap! >= 0 ? 'text-win' : 'text-lose'}`}>
                            {signedPoints(s.vsTeam.gap!, 1)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right tabular text-muted">
                {p.standings[by].fieldRank ? `#${p.standings[by].fieldRank} of ${p.standings[by].fieldRanked}` : '—'}
              </td>
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
