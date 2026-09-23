import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can, isCaptainOf } from '@/server/match-helpers';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
  FormError,
  FieldAction,
  inputClass,
  Avatar,
  Badge,
  teamInk,
  teamWash,
  TeamScopeTabs,
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { createTeam, deleteTeam, updateTeam } from '@/server/actions';
import { AddPlayerForm, ConfirmSubmit, LinkScoreSaber, MemberControls } from '@/components/roster-controls';
import { NewMatchForm } from '@/components/new-match-form';
import { createPlayerPool, makeDuosFromPool } from '@/server/pool-actions';
import { RunsVisibilityPanel } from '@/components/runs-visibility';
import { PlayerLink } from '@/components/player-card';
import { getTournamentSummary } from '@/server/summaries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const t = await getTournamentSummary((await params).slug);
  if (!t) return {};

  const title = `Teams - ${t.name}`;
  const description =
    t.teams.length === 0
      ? 'No teams yet.'
      : t.teams
          .map((team) => `${team.name}: ${team.members.map((m) => m.player.name).join(', ') || 'no players yet'}`)
          .join(' | ');
  return { title, description, openGraph: { title, description } };
}

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; show?: string }>;
}) {
  const { slug } = await params;
  const { error, show } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      isPublic: true,
      pools: { select: { id: true, name: true } },
      captainsCreateMatches: true,
      matchScoring: true,
      scoringLocked: true,
      divisions: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          teams: {
            // Match-only sides after the teams entered in the tournament.
            orderBy: [{ adHoc: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              color: true,
              colorSecondary: true,
              adHoc: true,
              playerPool: true,
              members: {
                orderBy: { order: 'asc' },
                select: {
                  id: true,
                  role: true,
                  isSub: true,
                  available: true,
                  player: {
                    select: {
                      id: true,
                      name: true,
                      beatLeaderId: true,
                      pp: true,
                      avatar: true,
                      userId: true,
                      scoreSaberId: true,
                    },
                  },
                },
              },
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
  const entered = teams.filter((t) => !t.adHoc && !t.playerPool);
  const playerPool = teams.find((t) => t.playerPool) ?? null;
  const matchOnly = teams.filter((t) => t.adHoc);
  // Match-only sides have a tab of their own, and only when there are any.
  const showing = show === 'match-only' && matchOnly.length > 0 ? 'adHoc' : 'entered';
  const listed = showing === 'adHoc' ? matchOnly : entered;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Teams and rosters"
        meta={`${entered.length} teams · ${new Set(entered.flatMap((t) => t.members.map((m) => m.player.id))).size} players · tap a player for their overview and stats`}
      />

      <FormError message={error} />

      <TeamScopeTabs
        hrefs={{ entered: `/t/${slug}/teams`, adHoc: `/t/${slug}/teams?show=match-only` }}
        showing={showing}
        counts={{ entered: entered.length, adHoc: matchOnly.length }}
      />
      {showing === 'adHoc' && (
        <p className="text-sm text-muted">
          Sides put together for a custom match or a captains&apos; draft. They are not entered in the tournament,
          and each is removed when its last match is deleted.
        </p>
      )}

      {showing === 'entered' && (playerPool || canManage) && (
        <Panel
          title="Player pool"
          subtitle="Players signed up but not in a team yet. Make duos from them, or add them to a team by hand."
        >
          {!playerPool ? (
            <form action={createPlayerPool} className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <span>For a tournament where teams are made from individual sign-ups.</span>
              <Button type="submit" variant="ghost">
                Start a player pool
              </Button>
            </form>
          ) : (
            <>
              {playerPool.members.length === 0 ? (
                <Empty>Nobody in the pool.</Empty>
              ) : (
                <form action={makeDuosFromPool} className="space-y-3">
                  <input type="hidden" name="tournamentId" value={tournament.id} />
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {[...playerPool.members]
                      .sort((a, b) => b.player.pp - a.player.pp)
                      .map((member, i) => (
                        <li key={member.id} className="flex items-center gap-2 text-sm">
                          {canManage && (
                            <input
                              name={`seed:${member.player.id}`}
                              inputMode="numeric"
                              defaultValue={i + 1}
                              aria-label={`${member.player.name}'s seed`}
                              title="Seed: 1 is the strongest. Seeded duos pair 1 with the last seed, 2 with the second-last..."
                              className="h-8 w-[3.25rem] shrink-0 rounded-md border border-edge-strong bg-surface px-1 text-center text-sm tabular text-ink focus:border-accent focus:outline-none"
                            />
                          )}
                          <PlayerLink playerId={member.player.id} name={member.player.name} className="flex min-w-0 flex-1 items-center gap-2 hover:underline">
                            <Avatar src={member.player.avatar} name={member.player.name} size={24} />
                            <span className="truncate">{member.player.name}</span>
                          </PlayerLink>
                          <span className="text-xs tabular text-muted">
                            {member.player.pp > 0 ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp` : '—'}
                          </span>
                          {canManage && (
                            <MemberControls
                              memberId={member.id}
                              playerName={member.player.name}
                              teamName="the player pool"
                              isCaptain={false}
                              isSub={member.isSub}
                              available={member.available}
                              canManage
                            />
                          )}
                        </li>
                      ))}
                  </ul>
                  {canManage && playerPool.members.length >= 2 && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-3">
                      <select name="method" defaultValue="SEEDED" className={`${inputClass} w-auto`}>
                        <option value="SEEDED">Seeded duos: 1 with the last seed, 2 with the second-last…</option>
                        <option value="RANDOM">Random duos</option>
                      </select>
                      <Button type="submit">Make duos</Button>
                      <span className="text-xs text-faint">
                        Seeds start in BeatLeader pp order; change the numbers to seed by hand. An odd player out stays here.
                      </span>
                    </div>
                  )}
                </form>
              )}
              {canManage && <AddPlayerForm teamId={playerPool.id} teamName="the player pool" />}
            </>
          )}
        </Panel>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {listed.map((team) => (
          <Panel key={team.id} flush>
            <div
              className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3"
              style={{
                background: `linear-gradient(90deg, ${teamWash(team.color)}, transparent 70%)`,
                borderLeft: `3px solid ${team.color}`,
              }}
            >
              <h2
                className="flex min-w-0 items-center gap-2 truncate text-base font-semibold tracking-tight"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                <span className="truncate">{team.name}</span>
                {team.adHoc && (
                  <Badge title="Put together for a particular match. It is removed when its last match is deleted.">
                    Match-only
                  </Badge>
                )}
              </h2>
              <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                <span className="hidden sm:inline">
                  {team.members.filter((m) => m.available).length} of {team.members.length} available
                </span>
              </span>
            </div>

            <div className="p-4">
              {team.members.length === 0 ? (
                <Empty>No players yet.</Empty>
              ) : (
                <ul className="-my-1.5 text-sm">
                  {team.members.map((member) => (
                    // On a phone the controls drop to their own line rather than squeezing the name out.
                    <li key={member.id} className="flex flex-wrap items-center justify-end gap-x-1">
                      <PlayerLink
                        playerId={member.player.id}
                        name={member.player.name}
                        className="-ml-2 flex min-w-0 flex-1 basis-full items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-raised sm:basis-0"
                      >
                        <Avatar
                          src={member.player.avatar}
                          name={member.player.name}
                          size={32}
                          ring={team.color}
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-medium ${member.available ? '' : 'text-muted line-through decoration-faint'}`}
                        >
                          {member.player.name}
                        </span>
                        {member.isSub && (
                          <Badge title="Substitute - only counted when switched in">
                            {member.available ? 'Sub · in' : 'Sub'}
                          </Badge>
                        )}
                        {!member.isSub && !member.available && (
                          <Badge tone="warn" title="Left out of lineups">
                            Absent
                          </Badge>
                        )}
                        {member.role === 'CAPTAIN' &&
                          (member.player.userId ? (
                            <Badge tone="accent">Captain</Badge>
                          ) : (
                            <Badge
                              tone="warn"
                              title="Has not signed in yet. They get control of picks, bans and lineups once they sign in with BeatLeader."
                            >
                              Captain · no account
                            </Badge>
                          ))}
                        <span className="w-14 shrink-0 text-right text-xs tabular text-muted sm:w-16">
                          {member.player.pp > 0 ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp` : '—'}
                        </span>
                      </PlayerLink>
                      {member.player.scoreSaberId ? (
                        <Badge title="ScoreSaber is linked, so their scores and pp there count too">SS</Badge>
                      ) : (
                        canManage && <LinkScoreSaber memberId={member.id} playerName={member.player.name} />
                      )}
                      {(canManage || isCaptainOf(actor, team.id)) && (
                        <MemberControls
                          memberId={member.id}
                          playerName={member.player.name}
                          teamName={team.name}
                          isCaptain={member.role === 'CAPTAIN'}
                          isSub={member.isSub}
                          available={member.available}
                          canManage={canManage}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {canManage && <AddPlayerForm teamId={team.id} teamName={team.name} />}

              {canManage && (
                <details className="mt-3 border-t border-edge pt-3 text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
                    Edit team
                  </summary>
                  <form action={updateTeam} className="mt-3 flex flex-wrap items-start gap-3">
                    <input type="hidden" name="teamId" value={team.id} />
                    <div className="min-w-[10rem] flex-1">
                      <Field label="Name">
                        <input name="name" defaultValue={team.name} className={inputClass} required />
                      </Field>
                    </div>
                    <Field label="Colour">
                      <input
                        type="color"
                        name="color"
                        defaultValue={team.color}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                    <Field label="Second colour">
                      <input
                        type="color"
                        name="colorSecondary"
                        defaultValue={team.colorSecondary}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                    <FieldAction>
                      <Button type="submit">Save</Button>
                    </FieldAction>
                  </form>
                  <form action={deleteTeam} className="mt-3">
                    <input type="hidden" name="teamId" value={team.id} />
                    <ConfirmSubmit
                      question={`Delete ${team.name} and its roster? This cannot be undone.`}
                    >
                      Delete team
                    </ConfirmSubmit>
                  </form>
                </details>
              )}
            </div>
          </Panel>
        ))}
      </div>

      {canManage && showing === 'entered' && (
        <div className="grid gap-6 md:grid-cols-2">
          <Panel title="New team">
            <form action={createTeam} className="flex flex-wrap items-start gap-3">
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <input type="hidden" name="from" value="teams" />
              <div className="min-w-[10rem] flex-1">
                <Field label="Name">
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
                <Button type="submit">Create</Button>
              </FieldAction>
            </form>
          </Panel>

          {can(actor, 'CREATE_MATCH', { captainsCreateMatches: tournament.captainsCreateMatches }) && (
            <NewMatchForm
              tournamentId={tournament.id}
              teams={entered}
              pools={tournament.pools}
              from="teams"
              scoring={{ mode: tournament.matchScoring, locked: tournament.scoringLocked }}
              ownTeamIds={can(actor, 'CREATE_MATCH') ? undefined : [...(actor.captainOfTeamIds ?? [])]}
            />
          )}
        </div>
      )}

      <RunsVisibilityPanel tournamentId={tournament.id} />
    </div>
  );
}
