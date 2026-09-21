import Link from 'next/link';
import { prisma } from '@bscs/db';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
  inputClass,
  Badge,
  CoverStrip,
} from '@/components/ui';
import { currentUser } from '@/server/session';
import { createTournament } from '@/server/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await currentUser();

  const tournaments = await prisma.tournament.findMany({
    where: user ? { OR: [{ isPublic: true }, { members: { some: { userId: user.id } } }] } : { isPublic: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      isPublic: true,
      _count: { select: { matches: true, pools: true, divisions: true } },
      pools: {
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: {
          maps: {
            orderBy: { order: 'asc' },
            select: { leaderboard: { select: { map: { select: { coverImage: true } } } } },
          },
        },
      },
      divisions: { select: { teams: { select: { color: true } } } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tournaments"
        meta="Beat Saber competitive stats, map pools and match management."
      />

      {tournaments.length === 0 ? (
        <Panel>
          <Empty>
            Nothing here yet.{' '}
            {user ? 'Create one below to get started.' : 'Sign in to create one.'}
          </Empty>
        </Panel>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {tournaments.map((t) => {
            const colors = t.divisions.flatMap((d) => d.teams.map((team) => team.color));
            const covers = t.pools[0]?.maps.map((m) => m.leaderboard.map.coverImage) ?? [];
            return (
              <li key={t.id}>
                <Link
                  href={`/t/${t.slug}`}
                  className="group block overflow-hidden rounded-xl border border-edge bg-panel/90 transition hover:border-faint"
                >
                  {/* The teams' colours, as a band - a tournament's own flag. */}
                  <div className="flex h-1.5">
                    {(colors.length ? colors : ['var(--color-accent)']).map((c, i) => (
                      <span key={i} className="flex-1" style={{ background: c }} />
                    ))}
                  </div>
                  <div className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold tracking-tight group-hover:underline">
                          {t.name}
                        </h2>
                        {t.description && (
                          <p className="line-clamp-2 text-sm text-muted">{t.description}</p>
                        )}
                      </div>
                      {!t.isPublic && <Badge>Private</Badge>}
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex gap-3 text-xs text-muted">
                        <span>{colors.length} teams</span>
                        <span>{t._count.pools} pools</span>
                        <span>{t._count.matches} matches</span>
                      </p>
                      {covers.length > 0 && <CoverStrip covers={covers} size={30} max={6} />}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {user && (
        <Panel title="New tournament">
          <form action={createTournament} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <Field label="Name" hint="For example: MSU Beat Saber - Fall 2026">
                <input name="name" className={inputClass} required />
              </Field>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="isPublic" defaultChecked />
              Publicly visible
            </label>
            <Button type="submit">Create</Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
