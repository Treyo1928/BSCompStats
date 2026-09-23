import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@/server/match-helpers';
import { Badge, Empty, FormError, PageHeader, Panel } from '@/components/ui';
import { CustomMatchBuilder, type BuilderPlayer } from '@/components/custom-match-builder';
import { getActorOrAnonymous } from '@/server/session';
import { buildTournamentData } from '@/server/stats';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Custom match' };

export default async function CustomMatchPage({
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
      pools: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
      drafts: {
        where: { matchId: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, players: { select: { pickNumber: true } } },
      },
    },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'CREATE_MATCH')) notFound();

  // Everyone the tournament already knows. Entered teams first, so a player who
  // is also on a match-only side is listed under the team they belong to.
  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId: tournament.id } } },
    orderBy: [{ team: { adHoc: 'asc' } }, { team: { name: 'asc' } }, { order: 'asc' }],
    select: {
      player: { select: { id: true, beatLeaderId: true, name: true, avatar: true } },
      team: { select: { name: true, color: true, adHoc: true } },
    },
  });
  const data = await buildTournamentData(tournament.id);

  const players = new Map<string, BuilderPlayer>();
  for (const { player, team } of members) {
    if (players.has(player.id)) continue;
    players.set(player.id, {
      ...player,
      teamName: team.adHoc ? null : team.name,
      teamColor: team.adHoc ? null : team.color,
      meanAcc: data.profiles[player.id]?.meanAcc || null,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Custom match"
        meta="For sides that are not tournament teams: a mixed scrim, a stand-in roster, a captains' draft. The teams exist for the match and are tidied away with it."
      />

      <FormError message={error} />

      {tournament.drafts.length > 0 && (
        <Panel title="Drafts in progress">
          <ul className="space-y-2">
            {tournament.drafts.map((draft) => {
              const left = draft.players.filter((p) => p.pickNumber == null).length;
              return (
                <li key={draft.id}>
                  <Link
                    href={`/t/${slug}/draft/${draft.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-raised/40 px-3 py-2.5 transition hover:border-faint hover:bg-raised"
                  >
                    <span className="min-w-0 truncate font-medium">{draft.name}</span>
                    <Badge tone={left === 0 ? 'win' : 'accent'}>
                      {left === 0 ? 'Ready to play' : `${left} still to pick`}
                    </Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {tournament.pools.length === 0 ? (
        <Panel>
          <Empty>A match needs a map pool. Import one on the tournament page first.</Empty>
        </Panel>
      ) : (
        <CustomMatchBuilder
          tournamentId={tournament.id}
          players={[...players.values()]}
          pools={tournament.pools}
        />
      )}
    </div>
  );
}
