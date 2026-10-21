import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { BRACKET_FORMAT_NAMES, parseBracketFormat } from '@bscs/core/bracket';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
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
import { PlayerAvatarStack } from '@/components/player-card';
import { tallyMaps } from '@/server/match-summary';
import { getTournamentSummary } from '@/server/summaries';
import {
  importPoolAction,
  createTeam,
  triggerRefresh,
} from '@/server/actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const t = await getTournamentSummary((await params).slug);
  // Private or missing: say nothing about it, and let the site's card stand in.
  if (!t) return {};

  const description = [t.description, t.facts, t.results.length ? `Latest: ${t.results.join('; ')}.` : null]
    .filter(Boolean)
    .join(' - ');
  return { title: t.name, description, openGraph: { title: t.name, description } };
}

/** What a match card shows of each team: its colours and who is on it. */
const matchTeamSelect = {
  id: true,
  name: true,
  color: true,
  colorSecondary: true,
  members: {
    orderBy: { order: 'asc' },
    select: { available: true, player: { select: { id: true, name: true, avatar: true } } },
  },
} as const;

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
      unlisted: true,
      captainsCreateMatches: true,
      matchScoring: true,
      scoringLocked: true,
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
            where: { adHoc: false, playerPool: false },
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
      brackets: {
        orderBy: { order: 'asc' },
        select: { id: true, name: true, format: true, _count: { select: { entries: true } }, pool: { select: { name: true } } },
      },
      drafts: {
        where: { matchId: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          players: { select: { pickNumber: true } },
          teamA: { select: { color: true } },
          teamB: { select: { color: true } },
        },
      },
      matches: {
        orderBy: { createdAt: 'desc' },
        take: 60,
        select: {
          id: true,
          name: true,
          state: true,
          winnerId: true,
          completedAt: true,
          unlisted: true,
          scoring: true,
          pointsCurve: true,
          replayCounting: true,
          doubleFailedRuns: true,
          teamAId: true,
          teamBId: true,
          teamA: { select: matchTeamSelect },
          teamB: { select: matchTeamSelect },
          pool: { select: { name: true } },
          maps: {
            orderBy: { order: 'asc' },
            select: {
              isTiebreaker: true,
              poolMap: { select: { leaderboard: { select: { map: { select: { coverImage: true } } } } } },
              attempts: { select: { teamId: true, playerId: true, score: true, accuracy: true, attempt: true, failed: true } },
            },
          },
        },
      },
    },
  });

  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const canManage = can(actor, 'MANAGE_TEAMS');
  const teams = tournament.divisions.flatMap((d) => d.teams);
  // Unlisted matches are listed only for staff and the two teams in them.
  const myTeamIds = new Set(
    actor.userId
      ? (
          await prisma.teamMember.findMany({
            where: { player: { userId: actor.userId }, team: { division: { tournamentId: tournament.id } } },
            select: { teamId: true },
          })
        ).map((m) => m.teamId)
      : [],
  );
  const listed = tournament.matches.filter(
    (m) => !m.unlisted || canManage || myTeamIds.has(m.teamAId) || myTeamIds.has(m.teamBId),
  );
  const currentMatches = listed.filter((m) => m.state !== 'COMPLETE');
  const finishedMatches = listed
    .filter((m) => m.state === 'COMPLETE')
    .sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0));

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: 'Tournaments', href: '/' }]}
        title={tournament.name}
        meta={
          tournament.description ??
          `${tournament.pools.length} pools · ${teams.length} teams · ${listed.length} matches`
        }
        actions={
          <>
            {!tournament.isPublic ? (
              <Badge>Private</Badge>
            ) : (
              tournament.unlisted && <Badge title="Opens for anyone with the link; not on the front page">Unlisted</Badge>
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
      <Panel
        title="Matches"
        subtitle={currentMatches.length > 0 ? 'Under way or still to play' : undefined}
        actions={
          can(actor, 'CREATE_MATCH') ? (
            <Link
              href={`/t/${tournament.slug}/custom`}
              title="A match between sides that are not tournament teams: chosen by hand, or drafted by two captains"
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium text-ink transition hover:border-faint hover:bg-raised"
            >
              <span className="text-accent">+</span> Custom match
            </Link>
          ) : null
        }
      >
        {currentMatches.length === 0 ? (
          <Empty>
            {finishedMatches.length === 0
              ? 'No matches yet. One needs two teams and a map pool.'
              : 'Nothing under way. Finished matches are below.'}
          </Empty>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {currentMatches.map((match) => (
              <MatchCard key={match.id} slug={tournament.slug} match={match} />
            ))}
          </ul>
        )}
      </Panel>

      {tournament.drafts.length > 0 && (
        <Panel title="Captains' drafts" subtitle="Sides being picked for a custom match">
          <ul className="grid gap-3 md:grid-cols-2">
            {tournament.drafts.map((draft) => {
              const left = draft.players.filter((p) => p.pickNumber == null).length;
              return (
                <li key={draft.id}>
                  <Link
                    href={`/t/${tournament.slug}/draft/${draft.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge px-4 py-3 transition hover:border-faint"
                    style={{
                      background: `linear-gradient(90deg, ${teamWash(draft.teamA.color, 0.8)}, transparent 45%, transparent 55%, ${teamWash(draft.teamB.color, 0.8)})`,
                    }}
                  >
                    <span className="min-w-0 truncate font-semibold">{draft.name}</span>
                    <Badge tone={left === 0 ? 'win' : 'accent'}>
                      {left === 0 ? 'Ready to play' : `${left} to pick`}
                    </Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {(tournament.brackets.length > 0 || can(actor, 'MANAGE_TOURNAMENT')) && (
        <Panel
          title="Brackets"
          subtitle={tournament.brackets.length ? undefined : 'Optional: round robin, single or double elimination'}
          actions={
            <Link
              href={`/t/${tournament.slug}/brackets`}
              className="text-xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {can(actor, 'MANAGE_TOURNAMENT') ? 'All brackets · new bracket' : 'All brackets'}
            </Link>
          }
        >
          {tournament.brackets.length === 0 ? (
            <Empty>None yet. Matches can be set up without one.</Empty>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {tournament.brackets.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/t/${tournament.slug}/bracket/${b.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-raised/40 px-3 py-2.5 transition hover:border-faint"
                  >
                    <span className="min-w-0 truncate font-medium">{b.name}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {BRACKET_FORMAT_NAMES[parseBracketFormat(b.format)]} · {b._count.entries} teams
                      {b.pool ? ` · ${b.pool.name}` : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {can(actor, 'CREATE_MATCH', { captainsCreateMatches: tournament.captainsCreateMatches }) && (
        <div className="space-y-2">
          <NewMatchForm
            tournamentId={tournament.id}
            teams={teams}
            pools={tournament.pools}
            from="tournament"
            scoring={{ mode: tournament.matchScoring, locked: tournament.scoringLocked }}
            ownTeamIds={can(actor, 'CREATE_MATCH') ? undefined : [...(actor.captainOfTeamIds ?? [])]}
          />
          {can(actor, 'CREATE_MATCH') && (
          <p className="px-1 text-sm text-muted">
            Sides that are not tournament teams?{' '}
            <Link
              href={`/t/${tournament.slug}/custom`}
              className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              Set up a custom match or a captains&apos; draft
            </Link>
            .
          </p>
          )}
        </div>
      )}

      {finishedMatches.length > 0 && (
        <Panel title="Finished matches" subtitle="Most recent first">
          <ul className="grid gap-3 md:grid-cols-2">
            {finishedMatches.map((match) => (
              <MatchCard key={match.id} slug={tournament.slug} match={match} />
            ))}
          </ul>
        </Panel>
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
              <>
                <Link
                  href={`/t/${tournament.slug}/teams`}
                  className="text-xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                >
                  Manage rosters
                </Link>
              </>
            ) : null
          }
        >
          {teams.length === 0 ? (
            <Empty>No teams yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {teams.map((team) => (
                <li
                  key={team.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2.5 transition hover:border-faint"
                  style={{
                    background: `linear-gradient(90deg, ${teamWash(team.color, 0.7)}, transparent 60%)`,
                    borderLeft: `3px solid ${team.color}`,
                  }}
                >
                  <Link href={`/t/${tournament.slug}/teams`} className="group min-w-0 flex-1">
                    <p
                      className="truncate font-semibold group-hover:underline"
                      style={{ color: teamInk(team.color, team.colorSecondary) }}
                    >
                      {team.name}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {team.members.length > 0
                        ? `${team.members.length} players`
                        : 'No players yet'}
                    </p>
                  </Link>
                  <PlayerAvatarStack people={team.members.map((m) => m.player)} size={28} ring={team.color} />
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

interface MatchCardData {
  id: string;
  name: string;
  state: string;
  unlisted: boolean;
  winnerId: string | null;
  scoring: string;
  pointsCurve: unknown;
  replayCounting: string;
  doubleFailedRuns: boolean;
  teamAId: string;
  teamBId: string;
  teamA: MatchCardTeam;
  teamB: MatchCardTeam;
  pool: { name: string };
  maps: Array<{
    isTiebreaker: boolean;
    poolMap: { leaderboard: { map: { coverImage: string | null } } };
    attempts: Array<{ teamId: string; playerId: string; score: number; accuracy: number; attempt: number; failed: boolean }>;
  }>;
}

interface MatchCardTeam {
  name: string;
  color: string;
  colorSecondary: string;
  members: Array<{ available: boolean; player: { id: string; name: string; avatar: string | null } }>;
}

/** A match at a glance: who, on which maps, and how it stands or ended. */
function MatchCard({ slug, match }: { slug: string; match: MatchCardData }) {
  const tally = tallyMaps(match.maps, match.teamAId, match.teamBId, match);
  const finished = match.state === 'COMPLETE';
  const winner =
    match.winnerId === match.teamAId ? match.teamA : match.winnerId === match.teamBId ? match.teamB : null;
  const started = tally.a + tally.b > 0;
  // A finished match shows whoever was on the roster; a live one, who is available.
  const people = (team: MatchCardTeam) =>
    team.members.filter((m) => finished || m.available).map((m) => m.player);

  const side = (team: MatchCardTeam, won: boolean, align: 'left' | 'right') => (
    <div className={`min-w-0 flex-1 ${align === 'right' ? 'text-right' : ''}`}>
      <p
        className={`truncate text-base font-semibold ${finished && !won ? 'opacity-70' : ''}`}
        style={{ color: teamInk(team.color, team.colorSecondary) }}
      >
        {team.name}
        {won && <span className="ml-1.5 text-xs font-medium text-win">won</span>}
      </p>
      <div className={`mt-1.5 flex ${align === 'right' ? 'justify-end' : ''}`}>
        <AvatarStack people={people(team)} size={24} ring={team.color} max={5} />
      </div>
    </div>
  );

  return (
    <li>
      <Link
        href={`/t/${slug}/match/${match.id}`}
        className="group block overflow-hidden rounded-lg border border-edge transition hover:border-faint"
        style={{
          background: `linear-gradient(90deg, ${teamWash(match.teamA.color, 0.8)}, transparent 45%, transparent 55%, ${teamWash(match.teamB.color, 0.8)})`,
        }}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-3">
          {side(match.teamA, winner === match.teamA, 'left')}
          <div className="shrink-0 pt-0.5 text-center">
            {started || finished ? (
              <p className="text-lg font-bold tabular leading-none">
                {tally.a}
                <span className="mx-1 text-xs font-medium text-faint">-</span>
                {tally.b}
              </p>
            ) : (
              <p className="text-xs font-medium uppercase tracking-widest text-faint">vs</p>
            )}
          </div>
          {side(match.teamB, winner === match.teamB, 'right')}
        </div>

        <div className="flex min-h-[2.25rem] items-center justify-center px-4 py-2">
          {match.maps.length > 0 ? (
            <CoverStrip
              covers={match.maps.map((m) => m.poolMap.leaderboard.map.coverImage)}
              size={26}
              max={7}
            />
          ) : (
            <span className="text-[11px] text-faint">Maps not picked yet</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-edge/70 bg-panel/60 px-4 py-2 text-xs text-muted">
          <span className="truncate">
            {match.unlisted && <span className="mr-1 text-faint">Unlisted ·</span>}
            {match.name || 'Match'} · {match.pool.name}
          </span>
          {finished ? (
            <Badge tone="win">
              {winner ? `${winner.name} won ${Math.max(tally.a, tally.b)}-${Math.min(tally.a, tally.b)}` : 'Draw'}
            </Badge>
          ) : (
            <MatchState state={match.state} />
          )}
        </div>
      </Link>
    </li>
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
