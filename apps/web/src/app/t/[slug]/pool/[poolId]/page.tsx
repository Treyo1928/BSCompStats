import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { describeScope } from '@bscs/core/stats';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Badge,
  CoverStrip,
  DifficultyChip,
  MapCover,
  Meter,
  Stat,
  pct,
} from '@/components/ui';
import { PoolBoardTable } from '@/components/pool-board';
import { LiveBadge } from '@/components/live-badge';
import { buildPoolBoard } from '@/server/board';
import { getActorOrAnonymous } from '@/server/session';
import { triggerRefresh } from '@/server/actions';

export const dynamic = 'force-dynamic';

export default async function PoolPage({
  params,
}: {
  params: Promise<{ slug: string; poolId: string }>;
}) {
  const { slug, poolId } = await params;

  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: { id: true, tournament: { select: { id: true, name: true, slug: true, isPublic: true } } },
  });
  if (!pool || pool.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(pool.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: pool.tournament.isPublic })) notFound();

  const board = await buildPoolBoard(poolId);
  if (!board) notFound();

  const playerCount = board.teams.reduce((acc, t) => acc + t.rows.length, 0);
  const leaderboardIds = board.maps.map((m) => m.leaderboardId);

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
            <LiveBadge leaderboardIds={leaderboardIds} />
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
            <Link href={`/t/${slug}/teams`} className="text-accent hover:underline">
              teams page
            </Link>{' '}
            and their scores will fill in automatically.
          </Empty>
        </Panel>
      ) : (
        <Panel flush>
          <PoolBoardTable board={board} />
          <Legend />
        </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Panel title="Maps" subtitle="How each one played out for this field">
          <ul className="grid gap-2 sm:grid-cols-2">
            {board.maps.map((map) => (
              <li key={map.leaderboardId}>
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
                      {map.category && <Badge tone="accent">{map.category}</Badge>}
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
              </li>
            ))}
          </ul>
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
