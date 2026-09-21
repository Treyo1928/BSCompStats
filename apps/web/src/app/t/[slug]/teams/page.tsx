import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
  inputClass,
  Avatar,
  Badge,
  teamInk,
  teamWash,
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { addPlayer, createTeam } from '@/server/actions';
import { createMatch } from '@/server/match-actions';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({
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
                  player: {
                    select: { id: true, name: true, beatLeaderId: true, pp: true, avatar: true },
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
                className="text-base font-semibold tracking-tight"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                {team.name}
              </h2>
              <span className="text-xs text-muted">{team.members.length} players</span>
            </div>

            <div className="p-4">
            {team.members.length === 0 ? (
              <Empty>No players yet.</Empty>
            ) : (
              <ul className="-my-1 text-sm">
                {team.members.map((member) => (
                  <li key={member.id}>
                    <a
                      href={`https://beatleader.com/u/${member.player.beatLeaderId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-raised"
                    >
                      <Avatar
                        src={member.player.avatar}
                        name={member.player.name}
                        size={32}
                        ring={team.color}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {member.player.name}
                      </span>
                      {member.role === 'CAPTAIN' && <Badge tone="accent">Captain</Badge>}
                      <span className="w-16 text-right text-xs tabular text-muted">
                        {member.player.pp > 0 ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp` : '—'}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {canManage && (
              <form
                action={addPlayer}
                className="mt-3 flex items-end gap-2 border-t border-[var(--color-edge)] pt-3"
              >
                <input type="hidden" name="teamId" value={team.id} />
                <div className="flex-1">
                  <Field
                    label="Add player"
                    hint="BeatLeader ID, profile link, or name to search"
                  >
                    <input name="player" className={inputClass} required />
                  </Field>
                </div>
                <Button type="submit">Add</Button>
              </form>
            )}
            </div>
          </Panel>
        ))}
      </div>

      {canManage && (
        <div className="grid gap-6 md:grid-cols-2">
          <Panel title="New team">
            <form action={createTeam} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="tournamentId" value={tournament.id} />
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
                  className="h-9 w-14 rounded-lg border border-edge bg-transparent"
                />
              </Field>
              <Button type="submit">Create</Button>
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
                  hint="They take the first step in the pick/ban order."
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
