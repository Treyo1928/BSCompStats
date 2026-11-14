import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { Avatar, Badge, Button, Empty, FormError, PageHeader, Panel } from '@/components/ui';
import { ApiKeyForm, KeyPersonPicker, KeyScopeFields } from '@/components/api-key-form';
import { addKeyUser } from '@/server/actions';
import { revokeApiKey, setKeyPerson, updateApiKey } from '@/server/api-key-actions';
import { realUser } from '@/server/session';

export const dynamic = 'force-dynamic';

const when = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await realUser();
  if (!user) redirect('/signin');
  const [keys, memberships, owned] = await Promise.all([
    prisma.apiKey.findMany({
      where: { userId: user.id },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      select: {
        id: true, name: true, prefix: true, canWrite: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true, signInUrl: true,
        tournaments: { select: { tournament: { select: { id: true, name: true } } }, orderBy: { tournament: { name: 'asc' } } },
        people: { orderBy: { requestedAt: 'asc' }, select: { approvedAt: true, user: { select: { id: true, name: true, image: true } } } },
      },
    }),
    prisma.tournamentMember.findMany({ where: { userId: user.id }, select: { tournament: { select: { id: true, name: true } } } }),
    prisma.tournament.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } }),
  ]);
  // A site admin has the list of everyone who has signed in (Users page), so may pick from it here too.
  const everyone = user.role === 'ADMIN' ? await prisma.user.findMany({ where: { id: { not: user.id } }, orderBy: { name: 'asc' }, select: { id: true, name: true } }) : [];
  const tournaments = [...new Map([...owned, ...memberships.map((m) => m.tournament)].map((t) => [t.id, t])).values()];
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="API keys" meta="For overlays and control apps that run matches for you" />
      <FormError message={error} />
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
                <li key={k.id} className={`py-2 ${dead ? 'opacity-50' : ''}`}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="font-medium">{k.name}</span>
                    <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                    <span className="text-xs text-muted">{k.tournaments.length ? k.tournaments.map((t) => t.tournament.name).join(', ') : 'all tournaments'}</span>
                    <span className="text-xs text-muted">{k.canWrite ? 'can run matches' : 'read-only'}</span>
                    {k.signInUrl && <span className="text-xs text-muted">signs in to {new URL(k.signInUrl).host}</span>}
                    {!dead && k.people.some((p) => !p.approvedAt) && <Badge tone="warn">{k.people.filter((p) => !p.approvedAt).length} waiting to be let in</Badge>}
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
                  </div>
                  {!dead && (
                    <details className="mt-1 text-sm" open={k.people.some((p) => !p.approvedAt)}>
                      <summary className="cursor-pointer text-xs text-muted hover:text-ink">Tournaments, sign-in and people</summary>
                      <form action={updateApiKey} className="mt-2 space-y-2">
                        <input type="hidden" name="keyId" value={k.id} />
                        <KeyScopeFields
                          tournaments={[...new Map([...tournaments, ...k.tournaments.map((t) => t.tournament)].map((t) => [t.id, t])).values()]}
                          chosen={k.tournaments.map((t) => t.tournament.id)}
                          everywhere={k.tournaments.length === 0}
                          signInUrl={k.signInUrl ?? ''}
                        />
                        <Button type="submit" variant="ghost" className="h-8">
                          Save
                        </Button>
                      </form>
                      {(
                        <div className="mt-3 border-t border-edge pt-2">
                          <p className="text-xs font-medium text-muted">
                            {k.signInUrl ? `Who may sign in to ${new URL(k.signInUrl).host}` : 'Who may sign in to its app (once the key has a sign-in address)'}
                          </p>
                          <ul className="mt-1 space-y-1">
                            <li className="flex items-center gap-2 text-xs">
                              <Avatar src={user.image} name={user.name ?? 'You'} size={20} /> {user.name ?? 'You'} <span className="text-faint">(you: it is your key)</span>
                            </li>
                            {k.people.map((p) => (
                              <li key={p.user.id} className="flex flex-wrap items-center gap-2 text-xs">
                                <Avatar src={p.user.image} name={p.user.name ?? 'Someone'} size={20} /> {p.user.name ?? 'Someone without a name'}
                                {!p.approvedAt && <Badge tone="warn">asked to be let in</Badge>}
                                <span className="ml-auto flex gap-2">
                                  {!p.approvedAt && (
                                    <form action={setKeyPerson}>
                                      <input type="hidden" name="keyId" value={k.id} />
                                      <input type="hidden" name="userId" value={p.user.id} />
                                      <input type="hidden" name="approve" value="on" />
                                      <Button type="submit" className="h-7 text-xs">
                                        Let in
                                      </Button>
                                    </form>
                                  )}
                                  <form action={setKeyPerson}>
                                    <input type="hidden" name="keyId" value={k.id} />
                                    <input type="hidden" name="userId" value={p.user.id} />
                                    <Button type="submit" variant="ghost" className="h-7 text-xs">
                                      {p.approvedAt ? 'Remove' : 'Turn down'}
                                    </Button>
                                  </form>
                                </span>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-2 flex flex-wrap items-end gap-3">
                            <div className="min-w-[12rem] flex-1">
                              <KeyPersonPicker keyId={k.id} />
                            </div>
                            {everyone.length > 0 && (
                              <form action={addKeyUser} className="flex items-end gap-2">
                                <input type="hidden" name="keyId" value={k.id} />
                                <label className="flex flex-col gap-1 text-xs text-muted">
                                  Or from everyone who has signed in
                                  <select name="userId" className="h-9 rounded-lg border border-edge bg-surface px-2 text-sm text-ink" defaultValue="">
                                    <option value="" disabled>
                                      Choose an account
                                    </option>
                                    {everyone
                                      .filter((u) => !k.people.some((p) => p.user.id === u.id && p.approvedAt))
                                      .map((u) => (
                                        <option key={u.id} value={u.id}>
                                          {u.name ?? `No name (${u.id.slice(-6)})`}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                                <Button type="submit" variant="ghost" className="h-9">
                                  Let in
                                </Button>
                              </form>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-faint">
                            Add people here before they ever open the app, by their BeatLeader name or profile. Someone you have not added can still ask from
                            the app&apos;s sign-in page; they appear above for you to let in or turn down. Removing someone signs them out of the app within a
                            minute.
                          </p>
                        </div>
                      )}
                    </details>
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
