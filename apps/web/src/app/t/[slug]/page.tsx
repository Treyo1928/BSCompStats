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
import { PlayerAvatarStack } from '@/components/player-card';
import { tallyMaps } from '@/server/match-summary';
import { getTournamentSummary } from '@/server/summaries';
import {
  importPoolAction,
  createTeam,
  triggerRefresh,
  setTournamentVisibility,
  setMatchRules,
  addTournamentMember,
  removeTournamentMember,
  deleteTournament,
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
      captainsEnterScores: true,
      captainsPullScores: true,
      captainsCreateMatches: true,
      matchScoring: true,
      scoringLocked: true,
      perfectFromBeatLeader: true,
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
          scoring: true,
          pointsCurve: true,
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
              attempts: { select: { teamId: true, playerId: true, score: true, accuracy: true } },
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
  const grantsAdmin = actor.globalRole === 'ADMIN' || actor.tournamentRole === 'OWNER';
  const teams = tournament.divisions.flatMap((d) => d.teams);
  const currentMatches = tournament.matches.filter((m) => m.state !== 'COMPLETE');
  const finishedMatches = tournament.matches
    .filter((m) => m.state === 'COMPLETE')
    .sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0));

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

      {can(actor, 'MANAGE_TOURNAMENT') && (
        <Panel title="Match rules" subtitle="Who may do what on match night, and how maps are scored">
          <form action={setMatchRules} className="space-y-3 text-sm">
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Captains may</legend>
              <RuleBox name="captainsCreateMatches" checked={tournament.captainsCreateMatches}>
                Set up matches for their own team
                <RuleNote>Otherwise only tournament admins can.</RuleNote>
              </RuleBox>
              <RuleBox name="captainsPullScores" checked={tournament.captainsPullScores}>
                Pull their match&apos;s scores from BeatLeader
                <RuleNote>Fills both teams&apos; scores for a map in from everyone&apos;s latest run.</RuleNote>
              </RuleBox>
              <RuleBox name="captainsEnterScores" checked={tournament.captainsEnterScores}>
                Type their own team&apos;s scores in by hand
                <RuleNote>The override for when BeatLeader cannot say. Admins always can.</RuleNote>
              </RuleBox>
            </fieldset>
            <fieldset className="space-y-2 border-t border-edge pt-3">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Scoring</legend>
              <Field label="New matches are scored on">
                <select name="matchScoring" className={inputClass} defaultValue={tournament.matchScoring}>
                  <option value="ACCURACY">Average accuracy</option>
                  <option value="MATCH_POINTS">Match points (the curve)</option>
                </select>
              </Field>
              <RuleBox name="scoringLocked" checked={tournament.scoringLocked}>
                Every match uses this
                <RuleNote>Otherwise whoever sets a match up can choose.</RuleNote>
              </RuleBox>
              <RuleBox name="perfectFromBeatLeader" checked={tournament.perfectFromBeatLeader}>
                Use BeatLeader&apos;s predicted accuracy as a map&apos;s perfect % until one is set
                <RuleNote>Perfect % only sizes a map&apos;s points; it never decides who wins it. Set it per map on the pool page.</RuleNote>
              </RuleBox>
            </fieldset>
            <Button type="submit">Save rules</Button>
          </form>
        </Panel>
      )}

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

interface MatchCardData {
  id: string;
  name: string;
  state: string;
  winnerId: string | null;
  scoring: string;
  pointsCurve: unknown;
  teamAId: string;
  teamBId: string;
  teamA: MatchCardTeam;
  teamB: MatchCardTeam;
  pool: { name: string };
  maps: Array<{
    isTiebreaker: boolean;
    poolMap: { leaderboard: { map: { coverImage: string | null } } };
    attempts: Array<{ teamId: string; playerId: string; score: number; accuracy: number }>;
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

function RuleBox({ name, checked, children }: { name: string; checked: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1" />
      <span>{children}</span>
    </label>
  );
}

function RuleNote({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs text-faint">{children}</span>;
}
