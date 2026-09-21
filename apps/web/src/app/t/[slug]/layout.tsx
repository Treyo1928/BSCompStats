import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import { getActorOrAnonymous } from '@/server/session';
import { TournamentNav, type TournamentNavItem } from '@/components/tournament-nav';

/** Every page of a tournament gets the same strip of sections above it. */
export default async function TournamentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      isPublic: true,
      pools: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
    },
  });
  if (!tournament) return children;

  // The page below decides what to do about someone who may not look; this
  // only has to avoid naming a private tournament's pools to them.
  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) return children;

  const items: TournamentNavItem[] = [
    { href: `/t/${slug}`, label: 'Overview' },
    ...tournament.pools.map((pool) => ({ href: `/t/${slug}/pool/${pool.id}`, label: pool.name })),
    { href: `/t/${slug}/teams`, label: 'Teams' },
    { href: `/t/${slug}/stats`, label: 'Player stats', deep: true },
    ...(can(actor, 'CREATE_MATCH') ? [{ href: `/t/${slug}/custom`, label: 'Custom match' }] : []),
  ];

  return (
    <>
      <TournamentNav items={items} />
      {children}
    </>
  );
}
