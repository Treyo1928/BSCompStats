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
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { createTeam, deleteTeam, updateTeam } from '@/server/actions';
import { AddPlayerForm, ConfirmSubmit, MemberControls } from '@/components/roster-controls';
import { createMatch } from '@/server/match-actions';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({
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
      isPublic: true,
      pools: { select: { id: true, name: true } },
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

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Teams and rosters"
        meta={`${teams.length} teams · ${teams.reduce((n, t) => n + t.members.length, 0)} players`}
      />

      <FormError message={error} />

      <div className="grid gap-6 md:grid-cols-2">
        {teams.map((team) => (
          <Panel key={team.id} flush>
            <div
              className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3"
              style={{
                background: `linear-gradient(90deg, ${teamWash(team.color)}, transparent 70%)`,
                borderLeft: `3px solid ${team.color}`,
              }}
            >
              <h2
                className="min-w-0 truncate text-base font-semibold tracking-tight"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                {team.name}
              </h2>
              <span className="shrink-0 text-xs text-muted">
                {team.members.filter((m) => m.available).length} of {team.members.length} available
              </span>
            </div>

            <div className="p-4">
            {team.members.length === 0 ? (
              <Empty>No players yet.</Empty>
            ) : (
              <ul className="-my-1.5 text-sm">
                {team.members.map((member) => (
                  <li key={member.id} className="flex items-center gap-1">
                    <a
                      href={`https://beatleader.com/u/${member.player.beatLeaderId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-raised"
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
                        <Badge tone="warn" title="Left out of lineups and predictions">
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
                      <span className="w-16 text-right text-xs tabular text-muted">
                        {member.player.pp > 0 ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp` : '—'}
                      </span>
                    </a>
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

      {canManage && (
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

          {teams.length >= 2 && tournament.pools.length > 0 && (
            <Panel title="New match" subtitle="Two teams and a pool is all it takes">
              <form action={createMatch} className="space-y-3">
                <input type="hidden" name="tournamentId" value={tournament.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Team A">
                    <select name="teamAId" className={inputClass} defaultValue={teams[0]!.id}>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Team B">
                    <select name="teamBId" className={inputClass} defaultValue={teams[1]!.id}>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Map pool">
                  <select name="poolId" className={inputClass}>
                    {tournament.pools.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Coin flip winner"
                  hint="They take the first step in the pick/ban order. Choose one of the two teams above; anything else falls back to Team A."
                >
                  <select name="coinFlipWinnerId" className={inputClass}>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit">Create match</Button>
              </form>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
