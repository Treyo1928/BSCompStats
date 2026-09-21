import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { Avatar, Badge, Button, Empty, PageHeader, Panel } from '@/components/ui';
import { realUser } from '@/server/session';
import { startViewAs } from '@/server/admin-actions';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  // The real user, not the viewed-as one: this page is how view-as is ended.
  const admin = await realUser();
  if (admin?.role !== 'ADMIN') notFound();

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      image: true,
      role: true,
      accounts: { select: { provider: true } },
      players: {
        select: {
          id: true,
          name: true,
          beatLeaderId: true,
          teamMembers: {
            select: {
              role: true,
              team: {
                select: {
                  name: true,
                  division: { select: { tournament: { select: { name: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: 'Tournaments', href: '/' }]}
        title="Users"
        meta="Everyone who has signed in. View the site as any of them to see exactly what they see and can do."
      />

      <Panel flush>
        {users.length === 0 ? (
          <div className="p-4">
            <Empty>Nobody has signed in yet.</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-edge">
            {users.map((user) => {
              const spots = user.players.flatMap((p) => p.teamMembers);
              return (
                <li key={user.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Avatar src={user.image} name={user.name ?? '?'} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{user.name ?? 'Unnamed user'}</span>
                      {user.role === 'ADMIN' && <Badge tone="accent">Site admin</Badge>}
                      {user.accounts.map((a) => (
                        <Badge key={a.provider}>{a.provider === 'beatleader' ? 'BeatLeader' : 'Discord'}</Badge>
                      ))}
                    </p>
                    <p className="text-xs text-muted">
                      {user.players.length === 0
                        ? 'No BeatLeader profile linked'
                        : user.players.map((p) => `${p.name} (${p.beatLeaderId})`).join(', ')}
                      {spots.length > 0 &&
                        ' · ' +
                          spots
                            .map(
                              (s) =>
                                `${s.role === 'CAPTAIN' ? 'captain of' : 'on'} ${s.team.name} in ${s.team.division.tournament.name}`,
                            )
                            .join('; ')}
                    </p>
                  </div>
                  {user.id === admin.id ? (
                    <span className="text-xs text-muted">This is you</span>
                  ) : (
                    <form action={startViewAs}>
                      <input type="hidden" name="userId" value={user.id} />
                      <Button variant="ghost" type="submit">
                        View as
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <p className="text-xs text-muted">
        While viewing as someone, the whole site treats you as them, including what you are allowed
        to change. Anything you do is recorded under their name, and the start and end of each
        view-as session is written to the server log. It ends by itself after an hour.
      </p>
    </div>
  );
}
