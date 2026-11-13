import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { BRACKET_FORMAT_NAMES } from '@bscs/core/bracket';
import { Badge, Empty, FormError, PageHeader, Panel, teamInk } from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { finishingOrder, loadBracket } from '@/server/brackets';
import { NewBracketForm } from '@/components/new-bracket-form';

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
            select: {
              id: true, name: true, color: true, colorSecondary: true, _count: { select: { members: true } },
              members: { where: { available: true }, select: { player: { select: { pp: true } } } },
            },
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
  // Where a new bracket could take its teams from: each bracket's finishing order, once it has one.
  const finished = staff ? await Promise.all(brackets.map((b) => finishingOrder(b.id))) : [];

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
            <NewBracketForm
              tournamentId={tournament.id}
              pools={tournament.pools}
              teams={teams.map((t) => ({
                id: t.id,
                name: t.name,
                color: t.color,
                colorSecondary: t.colorSecondary,
                members: t._count.members,
                pp: t.members.length ? t.members.reduce((sum, m) => sum + m.player.pp, 0) / t.members.length : 0,
              }))}
              brackets={brackets.map((b, i) => ({ id: b.id, name: b.name, order: finished[i]?.order ?? null }))}
              namePlaceholder={brackets.length ? 'Finals' : 'Qualifiers'}
            />
          )}
        </Panel>
      )}
    </div>
  );
}
