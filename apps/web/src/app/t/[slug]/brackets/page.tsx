import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { BRACKET_FORMAT_NAMES, parseBracketFormat } from '@bscs/core/bracket';
import { Badge, Button, Empty, Field, FormError, PageHeader, Panel, inputClass, teamInk } from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { createBracket } from '@/server/bracket-actions';
import { loadBracket } from '@/server/brackets';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const t = await prisma.tournament.findUnique({ where: { slug: (await params).slug }, select: { name: true, isPublic: true } });
  return t?.isPublic ? { title: `Brackets - ${t.name}` } : {};
}

/**
 * A tournament's brackets. Optional: a tournament can run on matches alone.
 * Several are fine - qualifiers on one pool, then finals for the top teams on
 * another.
 */
export default async function BracketsPage({
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
      isPublic: true,
      pools: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
      brackets: { orderBy: { order: 'asc' }, select: { id: true } },
      divisions: {
        select: {
          teams: {
            where: { adHoc: false, playerPool: false },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, color: true, colorSecondary: true, _count: { select: { members: true } } },
          },
        },
      },
    },
  });
  if (!tournament) notFound();
  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();
  const staff = can(actor, 'MANAGE_TOURNAMENT');

  const brackets = (await Promise.all(tournament.brackets.map((b) => loadBracket(b.id)))).filter((b) => b != null);
  const teams = tournament.divisions.flatMap((d) => d.teams);

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Brackets"
        meta="Round robin, single or double elimination - each on its own pool, played through ordinary matches."
      />
      <FormError message={error} />

      {brackets.length === 0 ? (
        <Panel>
          <Empty>No brackets yet. A tournament does not need one: matches can be set up on their own.</Empty>
        </Panel>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {brackets.map((b) => {
            const played = b.slots.filter((s) => s.state === 'DONE').length;
            const playable = b.slots.filter((s) => !s.passThrough && s.state !== 'BYE' && s.state !== 'VOID').length;
            const champ = b.teams.find((t) => t.id === b.championId);
            return (
              <li key={b.id}>
                <Link
                  href={`/t/${slug}/bracket/${b.id}`}
                  className="flex h-full flex-col gap-1 rounded-xl border border-edge bg-panel/90 p-4 transition hover:border-faint"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{b.name}</span>
                    <Badge tone={champ || (b.format === 'ROUND_ROBIN' && played === playable) ? 'win' : 'accent'}>
                      {played}/{playable} played
                    </Badge>
                  </span>
                  <span className="text-xs text-muted">
                    {BRACKET_FORMAT_NAMES[b.format]} · {b.teams.length} teams · {b.pool ? b.pool.name : 'no pool set'}
                  </span>
                  {champ && (
                    <span className="text-sm">
                      Won by{' '}
                      <span className="font-semibold" style={{ color: teamInk(champ.color, champ.colorSecondary) }}>
                        {champ.name}
                      </span>
                    </span>
                  )}
                  {b.format === 'ROUND_ROBIN' && b.standings[0] && played > 0 && (
                    <span className="text-sm text-muted">
                      Leading: <span className="text-ink">{b.standings[0].team.name}</span> ({b.standings[0].wins}–
                      {b.standings[0].losses})
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {staff && (
        <Panel title="New bracket" subtitle="Seed teams here, or take the top of another bracket">
          {teams.length < 2 && brackets.length === 0 ? (
            <Empty>A bracket needs at least two teams. Add them on the teams page first.</Empty>
          ) : (
            <form action={createBracket} className="space-y-4">
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <input name="name" className={inputClass} placeholder={brackets.length ? 'Finals' : 'Qualifiers'} />
                </Field>
                <Field label="Format">
                  <select name="format" className={inputClass} defaultValue="SINGLE_ELIM">
                    {(['ROUND_ROBIN', 'SINGLE_ELIM', 'DOUBLE_ELIM'] as const).map((f) => (
                      <option key={f} value={f}>
                        {BRACKET_FORMAT_NAMES[parseBracketFormat(f)]}
                        {f === 'DOUBLE_ELIM' ? ' (with a losers bracket)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Map pool" hint="Its matches are played on this.">
                  <select name="poolId" className={inputClass} defaultValue={tournament.pools[0]?.id ?? ''}>
                    <option value="">Choose later</option>
                    {tournament.pools.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <fieldset className="space-y-3 rounded-lg border border-edge p-3">
                <legend className="px-1 text-xs font-medium uppercase tracking-wider text-faint">Who plays</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="entrants" value="TEAMS" defaultChecked className="mt-1" />
                  <span>
                    These teams
                    <span className="block text-xs text-faint">Untick anyone not in it. Duos can be made from a player pool on the teams page.</span>
                  </span>
                </label>
                <div className="ml-6 space-y-2">
                  <Field label="Seeding">
                    <select name="seeding" className={inputClass} defaultValue="MANUAL">
                      <option value="MANUAL">By the numbers below (1 is the top seed)</option>
                      <option value="RANDOM">At random</option>
                      <option value="PP">By their players&apos; average BeatLeader pp</option>
                    </select>
                  </Field>
                  <div className="max-w-xl overflow-hidden rounded-lg border border-edge">
                    <div className="grid grid-cols-[2.5rem_4rem_minmax(0,1fr)_5rem] items-center gap-3 border-b border-edge bg-surface/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
                      <span>In</span>
                      <span>Seed</span>
                      <span>Team</span>
                      <span className="text-right">Players</span>
                    </div>
                    <ul className="divide-y divide-edge">
                      {teams.map((team, i) => (
                        <li key={team.id}>
                          {/* The whole row is the checkbox's label: tap anywhere on a team to include or drop it. */}
                          <label
                            className="grid cursor-pointer grid-cols-[2.5rem_4rem_minmax(0,1fr)_5rem] items-center gap-3 px-3 py-2 text-sm transition hover:bg-raised/70 has-[:checked]:bg-raised/30"
                            style={{ borderLeft: `3px solid ${team.color}` }}
                          >
                            <input type="checkbox" name="teamId" value={team.id} defaultChecked className="h-4 w-4" />
                            <input
                              name={`seed:${team.id}`}
                              inputMode="numeric"
                              defaultValue={i + 1}
                              aria-label={`${team.name}'s seed`}
                              className="h-8 w-14 rounded-md border border-edge-strong bg-surface px-1 text-center text-sm tabular text-ink focus:border-accent focus:outline-none"
                            />
                            <span
                              className="truncate font-medium"
                              style={{ color: teamInk(team.color, team.colorSecondary) }}
                              title={team.name}
                            >
                              {team.name}
                            </span>
                            <span className="text-right text-xs tabular text-muted">{team._count.members}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-xs text-faint">Seed numbers are used when seeding is &ldquo;by the numbers&rdquo;.</p>
                </div>

                {brackets.length > 0 && (
                  <>
                    <label className="flex items-start gap-2 border-t border-edge pt-3 text-sm">
                      <input type="radio" name="entrants" value="FROM_BRACKET" className="mt-1" />
                      <span>
                        The top of another bracket, seeded in the order they finished
                        <span className="block text-xs text-faint">
                          Round robin: its standings as they are. Elimination: once it has a winner.
                        </span>
                      </span>
                    </label>
                    <div className="ml-6 grid gap-3 sm:grid-cols-2">
                      <Field label="From">
                        <select name="fromBracketId" className={inputClass}>
                          {brackets.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Top">
                        <input name="top" inputMode="numeric" defaultValue={4} className={`${inputClass} tabular`} />
                      </Field>
                    </div>
                  </>
                )}
              </fieldset>
              <Button type="submit">Create bracket</Button>
            </form>
          )}
        </Panel>
      )}
    </div>
  );
}
