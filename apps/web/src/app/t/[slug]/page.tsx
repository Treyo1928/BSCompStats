import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
  FieldAction,
  inputClass,
  Badge,
  AvatarStack,
  CoverStrip,
  teamInk,
  teamWash,
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import {
  importPoolAction,
  createTeam,
  triggerRefresh,
  setTournamentVisibility,
} from '@/server/actions';

export const dynamic = 'force-dynamic';

export default async function TournamentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isPublic: true,
      pools: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          sourceType: true,
          _count: { select: { maps: true } },
          maps: {
            orderBy: { order: 'asc' },
            select: { leaderboard: { select: { map: { select: { coverImage: true } } } } },
          },
        },
      },
      divisions: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          teams: {
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              color: true,
              colorSecondary: true,
              members: {
                orderBy: { order: 'asc' },
                select: { player: { select: { id: true, name: true, avatar: true } } },
              },
            },
          },
        },
      },
      matches: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          name: true,
          state: true,
          teamA: { select: { name: true, color: true, colorSecondary: true } },
          teamB: { select: { name: true, color: true, colorSecondary: true } },
          pool: { select: { name: true } },
        },
      },
    },
  });

  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const canManage = can(actor, 'MANAGE_TEAMS');
  const teams = tournament.divisions.flatMap((d) => d.teams);

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: 'Tournaments', href: '/' }]}
        title={tournament.name}
        meta={
          tournament.description ??
          `${tournament.pools.length} pools · ${teams.length} teams · ${tournament.matches.length} matches`
        }
        actions={
          <>
            {!tournament.isPublic && <Badge>Private</Badge>}
            {can(actor, 'MANAGE_TOURNAMENT') && (
              <form action={setTournamentVisibility}>
                <input type="hidden" name="tournamentId" value={tournament.id} />
                {/* Absent means private, matching how a checkbox submits. */}
                {!tournament.isPublic && <input type="hidden" name="isPublic" value="on" />}
                <Button variant="ghost" type="submit">
                  {tournament.isPublic ? 'Make private' : 'Make public'}
                </Button>
              </form>
            )}
            {actor.userId && (
              <form action={triggerRefresh}>
                <input type="hidden" name="tournamentId" value={tournament.id} />
                <Button variant="ghost" type="submit">
                  Refresh scores
                </Button>
              </form>
            )}
          </>
        }
      />

      {/* Matches first: on match night this is what everyone came for. */}
      <Panel title="Matches">
        {tournament.matches.length === 0 ? (
          <Empty>
            No matches yet. Create one from the{' '}
            <Link href={`/t/${tournament.slug}/teams`} className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              teams page
            </Link>{' '}
            once you have two teams and a pool.
          </Empty>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {tournament.matches.map((match) => (
              <li key={match.id}>
                <Link
                  href={`/t/${tournament.slug}/match/${match.id}`}
                  className="group block overflow-hidden rounded-lg border border-edge transition hover:border-faint"
                  style={{
                    background: `linear-gradient(90deg, ${teamWash(match.teamA.color, 0.8)}, transparent 45%, transparent 55%, ${teamWash(match.teamB.color, 0.8)})`,
                  }}
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <span
                      className="min-w-0 flex-1 truncate text-base font-semibold"
                      style={{ color: teamInk(match.teamA.color, match.teamA.colorSecondary) }}
                    >
                      {match.teamA.name}
                    </span>
                    <span className="text-xs font-medium uppercase tracking-widest text-faint">
                      vs
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-right text-base font-semibold"
                      style={{ color: teamInk(match.teamB.color, match.teamB.colorSecondary) }}
                    >
                      {match.teamB.name}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-edge/70 bg-panel/60 px-4 py-2 text-xs text-muted">
                    <span className="truncate">
                      {match.name || 'Match'} · {match.pool.name}
                    </span>
                    <MatchState state={match.state} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Map pools"
          subtitle="Imported from a BeatLeader or ScoreSaber playlist"
        >
          {tournament.pools.length === 0 ? (
            <Empty>No pools yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {tournament.pools.map((pool) => (
                <li key={pool.id}>
                  <Link
                    href={`/t/${tournament.slug}/pool/${pool.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-raised/40 px-3 py-2.5 transition hover:border-faint hover:bg-raised"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{pool.name}</p>
                      <p className="text-xs text-muted">{pool._count.maps} maps · open the board</p>
                    </div>
                    <CoverStrip
                      covers={pool.maps.map((m) => m.leaderboard.map.coverImage)}
                      size={34}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {can(actor, 'IMPORT_POOL') && (
            <details className="group mt-4 border-t border-edge pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted hover:text-ink">
                <span className="text-accent transition group-open:rotate-45">+</span> Import a pool
              </summary>
              <form action={importPoolAction} className="mt-3 space-y-3">
                <input type="hidden" name="tournamentId" value={tournament.id} />
                <Field label="Pool name">
                  <input
                    name="name"
                    className={inputClass}
                    defaultValue={`Pool ${tournament.pools.length + 1}`}
                    required
                  />
                </Field>
                <Field
                  label="Playlist"
                  hint="A BeatLeader playlist link (beatleader.com/playlist/110086), any direct link to a .bplist, or upload the file below."
                >
                  <input
                    name="source"
                    className={inputClass}
                    placeholder="https://beatleader.com/playlist/110086"
                  />
                </Field>
                <Field label="…or upload a .bplist">
                  <input
                    type="file"
                    name="file"
                    accept=".bplist,.json,application/json"
                    className="w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-edge file:px-3 file:py-1.5 file:text-sm file:text-ink"
                  />
                </Field>
                <Button type="submit">Import pool</Button>
              </form>
            </details>
          )}
        </Panel>

        <Panel
          title="Teams"
          actions={
            teams.length > 0 ? (
              <Link
                href={`/t/${tournament.slug}/teams`}
                className="text-xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                Manage rosters
              </Link>
            ) : null
          }
        >
          {teams.length === 0 ? (
            <Empty>No teams yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {teams.map((team) => (
                <li key={team.id}>
                  <Link
                    href={`/t/${tournament.slug}/teams`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2.5 transition hover:border-faint"
                    style={{
                      background: `linear-gradient(90deg, ${teamWash(team.color, 0.7)}, transparent 60%)`,
                      borderLeft: `3px solid ${team.color}`,
                    }}
                  >
                    <div className="min-w-0">
                      <p
                        className="truncate font-semibold"
                        style={{ color: teamInk(team.color, team.colorSecondary) }}
                      >
                        {team.name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {team.members.map((m) => m.player.name).join(', ') || 'No players yet'}
                      </p>
                    </div>
                    <AvatarStack
                      people={team.members.map((m) => m.player)}
                      size={28}
                      ring={team.color}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {canManage && (
            <form
              action={createTeam}
              className="mt-4 flex flex-wrap items-start gap-3 border-t border-edge pt-4"
            >
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <div className="min-w-[10rem] flex-1">
                <Field label="New team">
                  <input name="name" className={inputClass} required />
                </Field>
              </div>
              <Field label="Colour">
                <input
                  type="color"
                  name="color"
                  defaultValue="#7c3aed"
                  className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                />
              </Field>
              <FieldAction>
                <Button type="submit">Add</Button>
              </FieldAction>
            </form>
          )}
        </Panel>
      </div>
    </div>
  );
}

function MatchState({ state }: { state: string }) {
  const tone = state === 'COMPLETE' ? 'win' : state === 'PLAYING' ? 'warn' : 'accent';
  const label: Record<string, string> = {
    SETUP: 'Setup',
    PICKBAN: 'Pick / ban',
    PLAYING: 'In play',
    COMPLETE: 'Final',
  };
  return <Badge tone={tone}>{label[state] ?? state}</Badge>;
}
