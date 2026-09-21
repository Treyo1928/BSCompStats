import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { describeScope } from '@bscs/core/stats';
import {
  Panel,
  PageHeader,
  Empty,
  FieldAction,
  FormError,
  inputClass,
  Field,
  Button,
  Badge,
  CoverStrip,
  DifficultyChip,
  MapCover,
  Meter,
  Stat,
  AvatarStack,
  chanceColor,
  pct,
} from '@/components/ui';
import { PoolBoardTable } from '@/components/pool-board';
import { LiveBadge } from '@/components/live-badge';
import { buildPoolBoard } from '@/server/board';
import { buildPoolOutlook } from '@/server/outlook';
import { getPoolSummary } from '@/server/summaries';
import { PlayerAvatarStack } from '@/components/player-card';
import { MapKindForm } from '@/components/map-kind-form';
import { getActorOrAnonymous } from '@/server/session';
import { setPredictionEstimate, setStatsScope, triggerRefresh } from '@/server/actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; poolId: string }>;
}): Promise<Metadata> {
  const { slug, poolId } = await params;
  const pool = await getPoolSummary(slug, poolId);
  if (!pool) return {};

  const title = `${pool.name} - ${pool.tournamentName}`;
  const description = [
    pool.facts,
    pool.leadersLine,
    `Maps: ${pool.maps.map((m) => m.name).join(', ')}`,
  ].join('. ');
  return { title, description, openGraph: { title, description } };
}

export default async function PoolPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; poolId: string }>;
  searchParams: Promise<{ team?: string; vs?: string; once?: string; error?: string }>;
}) {
  const { slug, poolId } = await params;
  const query = await searchParams;

  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: { id: true, tournament: { select: { id: true, name: true, slug: true, isPublic: true } } },
  });
  if (!pool || pool.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(pool.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: pool.tournament.isPublic })) notFound();

  const board = await buildPoolBoard(poolId);
  if (!board) notFound();

  // The outlook is the pool from one team's side. Which side is a plain query
  // parameter, so any pairing can be linked to and none of it needs signing in.
  const realTeams = board.teams.filter(
    (t): t is typeof t & { teamId: string } => t.teamId !== null,
  );
  const outlookTeam = realTeams.find((t) => t.teamId === query.team) ?? realTeams[0] ?? null;
  const outlookOpponent =
    realTeams.find((t) => t.teamId === query.vs && t.teamId !== outlookTeam?.teamId) ??
    realTeams.find((t) => t.teamId !== outlookTeam?.teamId) ??
    null;
  const eachGroupOnce = query.once === '1';
  const outlook = outlookTeam
    ? await buildPoolOutlook(
        board,
        pool.tournament.id,
        outlookTeam.teamId,
        outlookOpponent?.teamId ?? null,
        { eachGroupOnce },
      )
    : null;
  const outlookHref = (team: string, vs?: string | null, once = eachGroupOnce) =>
    `/t/${slug}/pool/${poolId}?team=${team}${vs ? `&vs=${vs}` : ''}${once ? '&once=1' : ''}#outlook`;
  const mapById = new Map(board.maps.map((m) => [m.poolMapId, m]));

  // Which teams the viewer plays for - they stay open when a big board starts collapsed.
  const myTeamIds = actor.userId
    ? (
        await prisma.teamMember.findMany({
          where: {
            player: { userId: actor.userId },
            team: { division: { tournamentId: pool.tournament.id } },
          },
          select: { teamId: true },
        })
      ).map((spot) => spot.teamId)
    : [];

  // Estimates are the viewer's own and touch nobody else's view, so anyone
  // looking at the board may set them for any player.
  const allRows = board.teams.flatMap((t) => t.rows);
  const seenPlayers = new Set<string>();
  const estimablePlayers = allRows.filter((row) => {
    if (seenPlayers.has(row.playerId)) return false;
    seenPlayers.add(row.playerId);
    return true;
  });
  const seenEstimates = new Set<string>();
  const currentEstimates = allRows.flatMap((row) =>
    row.cells
      .filter((cell) => cell.isEstimate && cell.acc == null)
      .filter((cell) => {
        // A player on two teams has two rows but one estimate.
        const key = `${row.playerId}:${cell.leaderboardId}`;
        if (seenEstimates.has(key)) return false;
        seenEstimates.add(key);
        return true;
      })
      .map((cell) => ({
        playerId: row.playerId,
        playerName: row.playerName,
        leaderboardId: cell.leaderboardId,
        mapName: board.maps.find((m) => m.leaderboardId === cell.leaderboardId)?.name ?? 'map',
        accuracy: cell.predictedAcc,
        canClear: true,
      })),
  );

  // People, not rows: someone on a match-only side as well as their own team is on the board twice.
  const playerCount = new Set(board.teams.flatMap((t) => t.rows.map((r) => r.playerId))).size;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: pool.tournament.name, href: `/t/${slug}` }]}
        title={board.poolName}
        meta={
          <span className="flex flex-wrap items-center gap-3">
            <CoverStrip covers={board.maps.map((m) => m.coverImage)} size={28} />
            <span>
              {board.maps.length} maps · {playerCount} players
            </span>
          </span>
        }
        actions={
          <>
            <LiveBadge poolId={poolId} />
            {actor.userId && (
              <form action={triggerRefresh}>
                <input type="hidden" name="poolId" value={poolId} />
                <input type="hidden" name="tournamentId" value={pool.tournament.id} />
                <Button variant="ghost" type="submit">
                  Refresh now
                </Button>
              </form>
            )}
          </>
        }
      />

      {playerCount === 0 ? (
        <Panel>
          <Empty>
            No players yet. Add teams and rosters on the{' '}
            <Link href={`/t/${slug}/teams`} className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              teams page
            </Link>{' '}
            and their scores will fill in automatically.
          </Empty>
        </Panel>
      ) : (
        <Panel flush>
          <PoolBoardTable maps={board.maps} teams={board.teams} myTeamIds={myTeamIds} />
          <Legend />
        </Panel>
      )}

      <FormError message={query.error} />

      {estimablePlayers.length > 0 && (
        <Panel
          title="Your own estimates"
          subtitle="Where you know better than the numbers. Only you see these, and they are forgotten when you close your browser."
        >
          <form action={setPredictionEstimate} className="flex flex-wrap items-start gap-3">
            <input type="hidden" name="poolId" value={poolId} />
            <div className="min-w-[10rem] flex-1">
              <Field label="Player">
                <select name="playerId" className={inputClass}>
                  {estimablePlayers.map((row) => (
                    <option key={`${row.teamId}:${row.playerId}`} value={row.playerId}>
                      {row.playerName} ({row.teamName})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field label="Map">
                <select name="leaderboardId" className={inputClass}>
                  {board.maps.map((m) => (
                    <option key={m.leaderboardId} value={m.leaderboardId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="w-32">
              <Field label="Expected accuracy">
                <input
                  name="accuracy"
                  inputMode="decimal"
                  placeholder="e.g. 45"
                  className={inputClass}
                  required
                />
              </Field>
            </div>
            <FieldAction>
              <Button type="submit">Set</Button>
            </FieldAction>
          </form>
          <p className="mt-2 text-xs text-faint">
            Shown on your board as ≈ and used in the lineups and win chances you are shown - nobody
            else&apos;s. It only applies while the player has no real score on that map.
          </p>

          {currentEstimates.length > 0 && (
            <ul className="mt-3 divide-y divide-edge border-t border-edge text-sm">
              {currentEstimates.map((e) => (
                <li key={`${e.playerId}:${e.leaderboardId}`} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{e.playerName}</span>
                    <span className="text-muted"> on {e.mapName}</span>
                  </span>
                  <span className="tabular text-accent">≈{pct(e.accuracy, 1)}</span>
                  {e.canClear && (
                    <form action={setPredictionEstimate}>
                      <input type="hidden" name="poolId" value={poolId} />
                      <input type="hidden" name="playerId" value={e.playerId} />
                      <input type="hidden" name="leaderboardId" value={e.leaderboardId} />
                      <input type="hidden" name="clear" value="on" />
                      <button
                        type="submit"
                        className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
                      >
                        Clear
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}


      {outlook && outlookTeam && (
        <section id="outlook" className="scroll-mt-20">
          <Panel
            title="Team outlook"
            subtitle={`Best ${outlook.playersPerMap}-player group on each map (${outlook.formatName})${
              outlookOpponent ? ', and the chance of taking it' : ''
            }`}
            flush
          >
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-edge px-4 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">From the side of</span>
                {realTeams.map((t) => (
                  <TeamPill
                    key={t.teamId}
                    href={outlookHref(
                      t.teamId,
                      t.teamId === outlookOpponent?.teamId ? outlookTeam.teamId : outlookOpponent?.teamId,
                    )}
                    name={t.teamName}
                    color={t.color}
                    active={t.teamId === outlookTeam.teamId}
                  />
                ))}
              </div>
              {realTeams.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">against</span>
                  {realTeams
                    .filter((t) => t.teamId !== outlookTeam.teamId)
                    .map((t) => (
                      <TeamPill
                        key={t.teamId}
                        href={outlookHref(outlookTeam.teamId, t.teamId)}
                        name={t.teamName}
                        color={t.color}
                        active={t.teamId === outlookOpponent?.teamId}
                      />
                    ))}
                </div>
              )}
            </div>

            {outlookOpponent && !outlook.shortHanded && (
              <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2 text-xs">
                <span className="text-muted">Rules</span>
                <Link
                  href={outlookHref(outlookTeam.teamId, outlookOpponent.teamId, !eachGroupOnce)}
                  scroll={false}
                  role="switch"
                  aria-checked={eachGroupOnce}
                  title="When on, a pairing used on one map cannot be used on another, as in a match. The groups shown are then the best set across the whole pool rather than the best for each map alone."
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
                    eachGroupOnce
                      ? 'border-accent bg-accent/15 text-ink'
                      : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${eachGroupOnce ? 'bg-accent' : 'bg-edge-strong'}`}
                  />
                  Each {outlook.playersPerMap === 2 ? 'duo' : 'group'} on one map only
                </Link>
              </div>
            )}

            {outlook.shortHanded ? (
              <div className="p-4">
                <Empty>{outlook.shortHanded}</Empty>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left text-[10px] uppercase tracking-wider text-faint">
                      <th className="px-4 py-2 font-medium">Map</th>
                      <th className="px-3 py-2 font-medium">{outlookTeam.teamName} should field</th>
                      <th className="px-3 py-2 text-right font-medium">Expected acc</th>
                      {outlookOpponent && (
                        <>
                          <th className="px-3 py-2 font-medium">{outlookOpponent.teamName}&apos;s best</th>
                          <th
                            className="px-3 py-2 text-right font-medium"
                            title="Chance of taking the map when both teams field the groups shown."
                          >
                            Win chance
                          </th>
                          <th
                            className="px-4 py-2 text-right font-medium"
                            title="Chance of taking the map averaged over every group either team could field - how the map leans before anyone picks a lineup."
                          >
                            Any lineups
                          </th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {outlook.maps.map((row) => {
                      const map = mapById.get(row.poolMapId)!;
                      return (
                        <tr key={row.poolMapId} className="border-b border-edge/60 last:border-0">
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-2.5">
                              <MapCover src={map.coverImage} size={32} />
                              <span className="min-w-0">
                                <span className="block max-w-[16rem] truncate font-medium">
                                  {map.name}
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <DifficultyChip value={map.difficultyValue} label={map.difficultyLabel} />
                                  {map.isTiebreaker && <Badge tone="warn">tiebreaker</Badge>}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <LineupCell people={row.lineup} ring={outlookTeam.color} />
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            {row.lineupAcc != null ? pct(row.lineupAcc) : '—'}
                          </td>
                          {outlookOpponent && (
                            <>
                              <td className="px-3 py-2">
                                {row.versus ? (
                                  <LineupCell people={row.versus.opponentLineup} ring={outlookOpponent.color} />
                                ) : (
                                  <span className="text-xs text-faint">roster too small</span>
                                )}
                              </td>
                              <td
                                className="px-3 py-2 text-right font-semibold tabular"
                                style={row.versus ? { color: chanceColor(row.versus.winProbability) } : undefined}
                              >
                                {row.versus ? pct(row.versus.winProbability, 0) : '—'}
                              </td>
                              <td className="px-4 py-2 text-right tabular text-muted">
                                {row.versus ? pct(row.versus.anyPairing, 0) : '—'}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t border-edge px-4 py-2 text-xs text-faint">
              {eachGroupOnce
                ? outlook.repeatsNeeded.length === 0
                  ? `No ${outlook.playersPerMap === 2 ? 'duo' : 'group'} is used twice on either side, so these are the best groups across the whole pool rather than map by map.`
                  : `Repeats are kept to the minimum. ${outlook.repeatsNeeded
                      .map(
                        (r) =>
                          `${r.teamName} has ${r.available} possible ${outlook.playersPerMap === 2 ? 'duos' : 'groups'} for ${r.maps} maps, so ${r.maps - r.available === 1 ? 'one has' : `${r.maps - r.available} have`} to play again.`,
                      )
                      .join(' ')} A real match plays fewer maps than the whole pool, so this rarely bites there.`
                : 'Each map is judged on its own: the group shown is the strongest for that map alone. Turn on the rule above to see the best set when no pairing can be used twice.'}{' '}
              A match also limits how many maps one player can play, which the lineup advice on a
              match page accounts for.
            </p>
          </Panel>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel title="Maps" subtitle="How each one played out for this field">
          <ul className="grid gap-2 sm:grid-cols-2">
            {board.maps.map((map) => (
              <li key={map.leaderboardId} className="flex flex-col">
                <a
                  href={`https://beatleader.com/leaderboard/global/${map.leaderboardId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex h-full items-center gap-3 rounded-lg border border-edge bg-raised/40 p-2.5 transition hover:border-faint hover:bg-raised"
                >
                  <MapCover src={map.coverImage} size={52} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{map.name}</p>
                    <p className="truncate text-xs text-muted">
                      {map.mapper ?? 'Unknown mapper'}
                      {!map.ranked && ' · unranked'}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <DifficultyChip value={map.difficultyValue} label={map.difficultyLabel} />
                      {map.category ? (
                        <Badge tone="accent">{map.category}</Badge>
                      ) : (
                        map.autoCategory && (
                          <Badge
                            title={`Guessed from BeatLeader's ratings: pass ${map.ratings.pass.toFixed(1)}, tech ${map.ratings.tech.toFixed(1)}, acc ${map.ratings.acc.toFixed(1)}. Pass is speed and stamina; tech is awkward patterns.`}
                          >
                            {map.autoCategory}
                          </Badge>
                        )
                      )}
                      {map.scatter >= 1.75 && (
                        <Badge
                          tone="warn"
                          title={`Scores here scatter about ${map.scatter.toFixed(1)}x more than on a typical map, so predictions on it are less certain.`}
                        >
                          volatile
                        </Badge>
                      )}
                    </div>
                  </div>
                  {map.fieldMeanAcc != null && (
                    <div className="w-16 shrink-0 text-right">
                      <p className="text-sm font-semibold tabular">{pct(map.fieldMeanAcc, 1)}</p>
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-faint">field</p>
                      <Meter value={(map.fieldMeanAcc - 0.5) / 0.5} />
                    </div>
                  )}
                </a>
                {can(actor, 'IMPORT_POOL') && (
                  <MapKindForm poolMapId={map.poolMapId} kind={map.category} guess={map.autoCategory} />
                )}
              </li>
            ))}
          </ul>
          {can(actor, 'IMPORT_POOL') && (
            <p className="mt-3 text-xs text-faint">
              The kind under each map is yours to set. Until you do, it is a guess from BeatLeader&apos;s
              ratings, which often calls a slow, awkward map &quot;speed&quot; because it is hard to pass. Player
              styles and the Acc / Tech / Speed rankings all follow these labels.
            </p>
          )}
        </Panel>

        <Panel title="Model" subtitle="What the predictions are based on">
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Scores used">{board.model.observationCount}</Stat>
            <Stat label="Players / maps">
              {board.model.playerCount} / {board.model.mapCount}
            </Stat>
            <Stat label="Fit quality" hint="Share of score variance the model explains">
              R² {board.model.model.rSquared.toFixed(3)}
              {board.model.chosenLatentFactors > 0 &&
                ` · ${board.model.chosenLatentFactors}f`}
            </Stat>
            <Stat label="Typical spread" hint="Run-to-run scatter on a map of ordinary volatility">
              ±{spreadInAccPoints(board).toFixed(2)} pts
            </Stat>
          </dl>
          <p className="mt-3 text-xs text-muted">
            <span className="text-faint">Scope · </span>
            {describeScope(board.model.scope)}
          </p>

          {can(actor, 'MANAGE_TOURNAMENT') && (
            <form action={setStatsScope} className="mt-3 space-y-2 border-t border-edge pt-3">
              <input type="hidden" name="tournamentId" value={pool.tournament.id} />
              <Field
                label="Learn from"
                hint="The pool alone only knows the maps people chose to practise. A wider scope shows what a player is like on everything else - their weak styles included."
              >
                <select
                  name="source"
                  className={inputClass}
                  defaultValue={
                    board.model.scope.source === 'RANKED_ONLY'
                      ? 'rankedOnly'
                      : board.model.scope.source === 'FULL_HISTORY'
                        ? 'fullHistory'
                        : 'poolOnly'
                  }
                >
                  <option value="poolOnly">This tournament&apos;s pools only</option>
                  <option value="rankedOnly">Ranked maps each player has played</option>
                  <option value="fullHistory">Every BeatLeader score</option>
                </select>
              </Field>
              <Field label="Going back">
                <select
                  name="months"
                  className={inputClass}
                  defaultValue={String(
                    board.model.scope.maxAgeDays
                      ? Math.max(1, Math.round(board.model.scope.maxAgeDays / 30.5))
                      : board.model.scope.source === 'POOL_ONLY'
                        ? 6
                        : 0,
                  )}
                >
                  <option value="3">3 months</option>
                  <option value="6">6 months</option>
                  <option value="12">12 months</option>
                  <option value="24">2 years</option>
                  <option value="0">All time</option>
                </select>
              </Field>
              <Button variant="ghost" type="submit">
                Apply
              </Button>
              <p className="text-xs text-faint">
                A wider scope is downloaded from BeatLeader in the background. Predictions settle
                over the next minute or two as it arrives.
              </p>
            </form>
          )}

          {Object.keys(board.model.excluded).length > 0 && (
            <div className="mt-3 border-t border-edge pt-3">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-faint">
                Scores left out
              </p>
              <ul className="space-y-0.5 text-xs text-muted">
                {Object.entries(board.model.excluded).map(([reason, count]) => (
                  <li key={reason}>
                    {count} — {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-edge px-4 py-2.5 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span
          className="h-2 w-16 rounded-full"
          style={{
            background:
              'linear-gradient(90deg, hsl(4 52% 30%), hsl(44 52% 30%), hsl(140 52% 30%))',
          }}
        />
        worst to best on that map
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-edge px-1 italic text-faint">~95%</span>
        predicted, not played
      </span>
      <span className="text-ink/80">Tap a player&apos;s name for their overview and stats</span>
      <span
        className="flex items-center gap-1.5"
        title="Far below that player's normal and far below everyone else on the map. Left out of averages and predictions. A low score on a map that is simply beyond a player is a real score and counts as one."
      >
        <span className="cell-void h-3 w-5 rounded" />
        abandoned run, not counted
      </span>
      <span>★ best on map</span>
      <span>FC full combo</span>
    </div>
  );
}

/**
 * The model works in logit space, where a sigma is not directly readable. Near
 * an accuracy of p, one logit unit is worth about p(1-p) in accuracy - so at
 * the 95% these players live at, a logit sigma of 0.16 is well under one
 * accuracy point, not the four a naive conversion suggests.
 */
function spreadInAccPoints(board: Awaited<ReturnType<typeof buildPoolBoard>>): number {
  if (!board) return 0;
  const accs = board.teams
    .flatMap((t) => t.rows)
    .flatMap((r) => r.cells.map((c) => c.acc))
    .filter((a): a is number => a != null);
  const mean = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : 0.95;
  return board.model.model.globalSigma * mean * (1 - mean) * 100;
}

function TeamPill({
  href,
  name,
  color,
  active,
}: {
  href: string;
  name: string;
  color: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
        active ? 'border-accent bg-accent/15 text-ink' : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
      }`}
    >
      <span className="h-2 w-2 rounded-full ring-1 ring-white/25" style={{ background: color }} />
      {name}
    </Link>
  );
}

function LineupCell({
  people,
  ring,
}: {
  people: Array<{ id: string; name: string; avatar: string | null }>;
  ring: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <PlayerAvatarStack people={people} size={24} ring={ring} />
      <span className="min-w-0 truncate text-xs text-muted">{people.map((p) => p.name).join(', ')}</span>
    </span>
  );
}
