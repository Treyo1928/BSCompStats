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
  Avatar,
  FormError,
  FieldAction,
  inputClass,
  Badge,
  AvatarStack,
  CoverStrip,
  teamInk,
  teamWash,
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { NewMatchForm } from '@/components/new-match-form';
import {
  importPoolAction,
  createTeam,
  triggerRefresh,
  setTournamentVisibility,
  setCaptainsEnterScores,
  addTournamentMember,
  removeTournamentMember,
  deleteTournament,
} from '@/server/actions';

export const dynamic = 'force-dynamic';

export default async function TournamentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isPublic: true,
      captainsEnterScores: true,
      members: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, user: { select: { name: true, image: true } } },
      },
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
  const grantsAdmin = actor.globalRole === 'ADMIN' || actor.tournamentRole === 'OWNER';
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
            {can(actor, 'MANAGE_TOURNAMENT') && (
              <form action={setCaptainsEnterScores}>
                <input type="hidden" name="tournamentId" value={tournament.id} />
                {!tournament.captainsEnterScores && <input type="hidden" name="allow" value="on" />}
                <Button
                  variant="ghost"
                  type="submit"
                  title={
                    tournament.captainsEnterScores
                      ? 'Captains can enter their own team\'s match scores. Click to make it organisers only.'
                      : 'Only organisers and admins can enter match scores. Click to let captains enter their own team\'s.'
                  }
                >
                  Scores: {tournament.captainsEnterScores ? 'captains + staff' : 'staff only'}
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

      <FormError message={error} />

      {/* Matches first: on match night this is what everyone came for. */}
      <Panel title="Matches">
        {tournament.matches.length === 0 ? (
          <Empty>
            No matches yet. One needs two teams and a map pool.
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

      {can(actor, 'CREATE_MATCH') && (
        <NewMatchForm
          tournamentId={tournament.id}
          teams={teams}
          pools={tournament.pools}
          from="tournament"
        />
      )}

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

      {can(actor, 'MANAGE_TOURNAMENT') && (
        <Panel
          title="People"
          subtitle={
            tournament.isPublic
              ? 'Tournament admins can do everything inside this tournament'
              : 'Tournament admins run it; viewers are who else can see this private tournament'
          }
        >
          <ul className="divide-y divide-edge text-sm">
            {tournament.members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 py-2">
                <Avatar src={member.user.image} name={member.user.name ?? '?'} size={28} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {member.user.name ?? 'Unnamed user'}
                </span>
                <Badge tone={member.role === 'VIEWER' ? 'neutral' : 'accent'}>
                  {member.role === 'OWNER'
                    ? 'Owner'
                    : member.role === 'ORGANIZER'
                      ? 'Tournament admin'
                      : member.role === 'VIEWER'
                        ? 'Viewer'
                        : member.role.toLowerCase()}
                </Badge>
                {member.role !== 'OWNER' && (member.role !== 'ORGANIZER' || grantsAdmin) && (
                  <form action={removeTournamentMember}>
                    <input type="hidden" name="memberId" value={member.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
                    >
                      Remove
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          <form
            action={addTournamentMember}
            className="mt-3 flex flex-wrap items-start gap-3 border-t border-edge pt-3"
          >
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <div className="min-w-[12rem] flex-1">
              <Field
                label="Add someone"
                hint="Their account name here, or their BeatLeader ID. They must have signed in once."
              >
                <input name="who" className={inputClass} required />
              </Field>
            </div>
            <Field label="As">
              <select name="role" className={inputClass} defaultValue={grantsAdmin ? 'ORGANIZER' : 'VIEWER'}>
                {grantsAdmin && <option value="ORGANIZER">Tournament admin</option>}
                <option value="VIEWER">Viewer</option>
              </select>
            </Field>
            <FieldAction>
              <Button type="submit">Add</Button>
            </FieldAction>
          </form>
          <p className="mt-2 text-xs text-faint">
            Players on a roster, and their captains, can already see a private tournament - they do
            not need adding here.
          </p>
        </Panel>
      )}

      {grantsAdmin && (
        <details className="rounded-xl border border-red-400/20 bg-red-500/5 p-4 text-sm">
          <summary className="cursor-pointer font-medium text-red-200">Delete this tournament</summary>
          <form action={deleteTournament} className="mt-3 flex flex-wrap items-start gap-3">
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <div className="min-w-[14rem] flex-1">
              <Field
                label={`Type "${tournament.name}" to confirm`}
                hint="Deletes its teams, rosters, pools and every match. Players and their scores are kept. This cannot be undone."
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
