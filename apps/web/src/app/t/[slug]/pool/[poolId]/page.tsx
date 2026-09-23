import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import {
  Panel,
  PageHeader,
  Empty,
  FormError,
  Field,
  FieldAction,
  inputClass,
  Button,
  Badge,
  CoverStrip,
  DifficultyChip,
  MapCover,
  Meter,
  Stat,
  pct,
  TeamScopeTabs,
} from '@/components/ui';
import { PoolBoardTable } from '@/components/pool-board';
import { LiveBadge } from '@/components/live-badge';
import { buildPoolBoard } from '@/server/board';
import { getPoolSummary } from '@/server/summaries';
import { PerfectAccForm } from '@/components/perfect-acc-form';
import { getActorOrAnonymous } from '@/server/session';
import { deletePool, triggerRefresh } from '@/server/actions';

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
  searchParams: Promise<{ error?: string; show?: string }>;
}) {
  const { slug, poolId } = await params;
  const query = await searchParams;

  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: {
      id: true,
      tournament: { select: { id: true, name: true, slug: true, isPublic: true, perfectFromBeatLeader: true } },
      _count: { select: { matches: true } },
    },
  });
  if (!pool || pool.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(pool.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: pool.tournament.isPublic })) notFound();

  const board = await buildPoolBoard(poolId);
  if (!board) notFound();

  // The board is the tournament's teams. Match-only sides still playing are behind a tab, not in among them.
  const matchOnlyCount = board.teams.filter((t) => t.adHoc).length;
  const showing = query.show === 'match-only' && matchOnlyCount > 0 ? ('adHoc' as const) : ('entered' as const);
  const boardTeams = board.teams.filter((t) => t.adHoc === (showing === 'adHoc'));

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
          {matchOnlyCount > 0 && (
            <div className="border-b border-edge p-2">
              <TeamScopeTabs
                hrefs={{ entered: `/t/${slug}/pool/${poolId}`, adHoc: `/t/${slug}/pool/${poolId}?show=match-only` }}
                showing={showing}
                counts={{ entered: board.teams.length - matchOnlyCount, adHoc: matchOnlyCount }}
              />
            </div>
          )}
          <PoolBoardTable maps={board.maps} teams={boardTeams} myTeamIds={myTeamIds} />
          <Legend />
        </Panel>
      )}

      <FormError message={query.error} />

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
                      {map.perfectAcc != null && (
                        <Badge title="What counts as a perfect score here, for match points">
                          perfect {pct(map.perfectAcc, 2)}
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
                  <PerfectAccForm
                    poolMapId={map.poolMapId}
                    perfectAcc={map.perfectAcc}
                    fallback={pool.tournament.perfectFromBeatLeader ? map.blPredictedAcc : null}
                  />
                )}
              </li>
            ))}
          </ul>
          {can(actor, 'IMPORT_POOL') && (
            <p className="mt-3 text-xs text-faint">
              Perfect % is what counts as a perfect score on the map for match points: it sets how big a
              map&apos;s points are, never who wins it.
              {pool.tournament.perfectFromBeatLeader
                ? " Left blank, BeatLeader's predicted accuracy for the map is used where it has one."
                : ''}
            </p>
          )}
        </Panel>

        <Panel title="Behind the board" subtitle="Everything on it was played">
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Scores">{board.data.scoreCount}</Stat>
            <Stat label="Players / maps">
              {playerCount} / {board.maps.length}
            </Stat>
            <Stat
              label="Runs shown"
              hint="BeatLeader shows every run - fails and quits included - only for players who show their stats publicly. For everyone else the board has their best clear alone."
            >
              <Link href={`/t/${slug}/stats#runs`} className="underline decoration-faint underline-offset-2 hover:text-ink">
                {board.data.runsKnownFor} of {board.data.playerCount}
              </Link>
            </Stat>
            <Stat label="Abandoned runs" hint="Far below the player's own normal and everyone else's on the map. Shown, but left out of averages.">
              {board.data.failKeys.size}
            </Stat>
          </dl>
        </Panel>
      </div>

      {can(actor, 'IMPORT_POOL') && (
        <details className="rounded-xl border border-red-400/20 bg-red-500/5 p-4 text-sm">
          <summary className="cursor-pointer font-medium text-red-200">Delete this pool</summary>
          <form action={deletePool} className="mt-3 flex flex-wrap items-start gap-3">
            <input type="hidden" name="poolId" value={poolId} />
            <div className="min-w-[14rem] flex-1">
              <Field
                label={`Type "${board.poolName}" to confirm`}
                hint={
                  pool._count.matches > 0
                    ? `Deletes the pool and the ${pool._count.matches === 1 ? 'match' : `${pool._count.matches} matches`} played on it, with their picks, lineups and scores. Players and their BeatLeader scores are kept. This cannot be undone.`
                    : 'Deletes the pool and its settings. Players and their scores are kept. This cannot be undone.'
                }
              >
                <input name="confirmName" className={inputClass} autoComplete="off" required />
              </Field>
            </div>
            <FieldAction>
              <Button type="submit" variant="danger">
                Delete forever
              </Button>
            </FieldAction>
          </form>
        </details>
      )}
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
        <span className="rounded border border-dashed border-edge px-1.5 text-faint">—</span>
        not played
      </span>
      <span className="text-ink/80">Tap a player&apos;s name for their overview and stats</span>
      <span
        className="flex items-center gap-1.5"
        title="Far below that player's normal and far below everyone else on the map. Left out of averages. A low score on a map that is simply beyond a player is a real score and counts as one."
      >
        <span className="cell-void h-3 w-5 rounded" />
        abandoned run, not counted
      </span>
      <span>★ best on map</span>
      <span>FC full combo</span>
      <span title="No Fail kicked in: they died partway and played the rest of the map on. Matches are played with No Fail on, so this is a real result.">
        <span className="font-bold text-amber-300">NF</span> died, played on with No Fail
      </span>
      <span
        className="flex items-center gap-1.5"
        title="Never cleared, but BeatLeader saw them try: the accuracy of their longest run of ten notes or more (or the most accurate within a tenth of the song of it) stands as their number here, and in their average, until they clear it. Underneath is how far into the song it ended. Shown only for players who show their stats publicly on BeatLeader."
      >
        <span className="relative rounded px-1.5 font-semibold outline outline-1 outline-dashed outline-white/25" style={{ background: 'rgba(127,29,29,0.5)' }}>
          <span className="absolute left-0.5 top-0 text-[8px] text-red-300">✗</span>85%
        </span>
        best run, never cleared
      </span>
      <span title="How many runs BeatLeader has recorded on the map, clears and fails together.">↻3 runs recorded</span>
      <span title="Tried, never cleared, and no run hit ten notes.">✗3 tries, none hit 10 notes</span>
    </div>
  );
}
