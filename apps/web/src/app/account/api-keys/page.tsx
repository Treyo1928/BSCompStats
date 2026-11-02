import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { Button, Empty, PageHeader, Panel } from '@/components/ui';
import { ApiKeyForm } from '@/components/api-key-form';
import { revokeApiKey } from '@/server/api-key-actions';
import { realUser } from '@/server/session';

export const dynamic = 'force-dynamic';

const when = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

export default async function ApiKeysPage() {
  const user = await realUser();
  if (!user) redirect('/signin');
  const [keys, memberships, owned] = await Promise.all([
    prisma.apiKey.findMany({
      where: { userId: user.id },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      select: { id: true, name: true, prefix: true, canWrite: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true, tournament: { select: { name: true } } },
    }),
    prisma.tournamentMember.findMany({ where: { userId: user.id }, select: { tournament: { select: { id: true, name: true } } } }),
    prisma.tournament.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } }),
  ]);
  const tournaments = [...new Map([...owned, ...memberships.map((m) => m.tournament)].map((t) => [t.id, t])).values()];
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="API keys" meta="For overlays and control apps that run matches for you" />
      <Panel
        title="New key"
        subtitle="A key acts as you: it can do exactly what you can do on the site, in the tournaments you choose, and nothing else."
      >
        <ApiKeyForm tournaments={tournaments} />
      </Panel>
      <Panel title="Your keys">
        {keys.length === 0 ? (
          <Empty>No keys yet.</Empty>
        ) : (
          <ul className="divide-y divide-edge text-sm">
            {keys.map((k) => {
              const dead = k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt < now ? 'expired' : null;
              return (
                <li key={k.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-2 ${dead ? 'opacity-50' : ''}`}>
                  <span className="font-medium">{k.name}</span>
                  <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                  <span className="text-xs text-muted">{k.tournament?.name ?? 'all tournaments'}</span>
                  <span className="text-xs text-muted">{k.canWrite ? 'can run matches' : 'read-only'}</span>
                  <span className="text-xs text-faint">
                    made {when(k.createdAt)} · last used {when(k.lastUsedAt)} · {dead ?? `expires ${k.expiresAt ? when(k.expiresAt) : 'never'}`}
                  </span>
                  {!dead && (
                    <form action={revokeApiKey} className="ml-auto">
                      <input type="hidden" name="keyId" value={k.id} />
                      <Button type="submit" variant="ghost" className="h-8">
                        Revoke
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
