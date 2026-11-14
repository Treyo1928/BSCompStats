import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { parseShowcaseReplays, SHOWCASE_REPLAYS_MAX, SHOWCASE_REPLAYS_PER_PLAYER } from '@bscs/core';
import { Avatar, Button, Empty, FormError, PageHeader, Panel, inputClass } from '@/components/ui';
import { SaberColors } from '@/components/saber-colors';
import { viewerBase } from '@/lib/replay-viewer';
import { setProfileReplays } from '@/server/profile-actions';
import { realUser } from '@/server/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your profile' };

/**
 * A player's own page: the saber colours and the replays that go with them into every tournament. Organisers can
 * set others for one tournament; where they have, this page says so. A site admin can open anyone's
 * (?player=<id>, from the Users page).
 */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ error?: string; player?: string }> }) {
  const user = await realUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent('/account')}`);
  const { error, player: asked } = await searchParams;
  const others = user.role === 'ADMIN' && asked ? asked : null;

  const players = await prisma.player.findMany({
    where: others ? { id: others } : { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, avatar: true, beatLeaderId: true, userId: true, replays: true, saberLeft: true, saberRight: true,
      // where a tournament has its own for them, so they know why it looks different there
      tournamentEntries: {
        where: { OR: [{ saberLeft: { not: null } }, { NOT: { replays: { equals: [] } } }, { tournament: { replaysLockedAt: { not: null } } }] },
        select: { saberLeft: true, replays: true, lockedReplays: true, tournament: { select: { name: true, slug: true, replaysLockedAt: true } } },
      },
      // something to try the colours on: their best scores this site has a replay for
      scores: {
        where: { beatLeaderScoreId: { not: null } },
        orderBy: { accuracy: 'desc' },
        take: 15,
        select: { beatLeaderScoreId: true, accuracy: true, leaderboard: { select: { difficultyName: true, map: { select: { name: true } } } } },
      },
    },
  });
  const viewer = viewerBase();

  return (
    <div className="space-y-6">
      <PageHeader
        title={others ? `${players[0]?.name ?? 'Player'}'s profile` : 'Your profile'}
        meta="Your saber colours and the replays shown on stream. Set them once here; every tournament you play in uses them."
      />
      <FormError message={error} />
      {players.length === 0 ? (
        <Panel>
          <Empty>
            {others ? (
              'No such player.'
            ) : (
              <>
                Your account is not linked to a BeatLeader profile yet, so there is no player to set these for.{' '}
                <Link href="/signin?next=%2Faccount" className="text-ink underline decoration-faint underline-offset-2">
                  Continue with BeatLeader
                </Link>{' '}
                to link it; your scores and rosters are then yours too.
              </>
            )}
          </Empty>
        </Panel>
      ) : (
        players.map((player) => {
          const mine = player.userId === user.id;
          const who = mine ? 'you' : player.name;
          const replays = parseShowcaseReplays(player.replays);
          const sabers = player.saberLeft && player.saberRight ? { left: player.saberLeft, right: player.saberRight } : null;
          const limit = mine ? SHOWCASE_REPLAYS_PER_PLAYER : SHOWCASE_REPLAYS_MAX;
          const preview = [
            ...replays.flatMap((r) => (r.scoreId ? [{ scoreId: Number(r.scoreId), label: `${r.song ?? 'Replay'}${r.difficulty ? ` · ${r.difficulty}` : ''}` }] : [])),
            ...player.scores.map((s) => ({
              scoreId: Number(s.beatLeaderScoreId),
              label: `${s.leaderboard.map.name} · ${s.leaderboard.difficultyName} · ${(s.accuracy * 100).toFixed(2)}%`,
            })),
          ].filter((r, i, all) => all.findIndex((x) => x.scoreId === r.scoreId) === i);
          const overridden = player.tournamentEntries
            .map((t) => ({
              name: t.tournament.name,
              slug: t.tournament.slug,
              what: [t.saberLeft ? 'colours' : '', parseShowcaseReplays(t.replays).length ? 'replays' : ''].filter(Boolean).join(' and '),
            }))
            .filter((t) => t.what);
          // where the stream has started: what is shown there was fixed then
          const lockedIn = player.tournamentEntries.filter((t) => t.tournament.replaysLockedAt).map((t) => t.tournament);
          return (
            <Panel
              key={player.id}
              title={
                <span className="flex items-center gap-2">
                  <Avatar src={player.avatar} name={player.name} size={28} /> {player.name}
                </span>
              }
              subtitle={`BeatLeader ${player.beatLeaderId}`}
            >
              <div className="text-xs">
                <SaberColors
                  key={`${sabers?.left}:${sabers?.right}`}
                  profilePlayerId={player.id}
                  playerName={who}
                  sabers={sabers}
                  replays={preview}
                  viewer={viewer}
                />

                <p className="mt-5 text-sm font-medium text-ink">Replays on stream</p>
                {replays.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {replays.map((r) => (
                      <li key={r.ref} className="truncate">
                        <a href={r.ref} target="_blank" rel="noreferrer" className="text-ink hover:underline">
                          {r.song ?? r.ref}
                        </a>
                        <span className="text-faint">
                          {r.difficulty ? ` · ${r.difficulty}` : ''}
                          {r.accuracy != null ? ` · ${(r.accuracy * 100).toFixed(2)}%` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <form action={setProfileReplays} className="mt-1.5 space-y-1.5">
                  <input type="hidden" name="playerId" value={player.id} />
                  <textarea
                    name="replays"
                    rows={Math.max(2, replays.length + 1)}
                    defaultValue={replays.map((r) => r.ref).join('\n')}
                    placeholder="https://replay.beatleader.com/?scoreId=..."
                    aria-label="Replays to show on stream, one link per line"
                    className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" variant="ghost" className="h-8 text-xs">
                      Save replays
                    </Button>
                    <span className="text-faint">
                      Played on stream in breaks and when {mine ? 'you are' : 'they are'} about to play. One BeatLeader replay link per line, up to {limit}
                      {mine ? ', of your own plays' : ''}. On BeatLeader, open a score and copy the address of its replay.
                    </span>
                  </div>
                </form>

                {lockedIn.length > 0 && (
                  <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-ink">
                    Replays are locked for the stream in{' '}
                    {lockedIn.map((t, i) => (
                      <span key={t.slug}>
                        {i > 0 && ', '}
                        <Link href={`/t/${t.slug}/teams`} className="underline decoration-faint underline-offset-2">
                          {t.name}
                        </Link>
                      </span>
                    ))}
                    : what {mine ? 'you' : 'they'} had when it was locked is what is shown there. Replays changed here reach {lockedIn.length === 1 ? 'it' : 'them'} once the organisers
                    unlock.
                  </p>
                )}
                {overridden.length > 0 && (
                  <p className="mt-4 border-t border-edge pt-2 text-faint">
                    Set differently by the organisers of:{' '}
                    {overridden.map((t, i) => (
                      <span key={t.slug}>
                        {i > 0 && ', '}
                        <Link href={`/t/${t.slug}/teams`} className="text-ink hover:underline">
                          {t.name}
                        </Link>{' '}
                        ({t.what})
                      </span>
                    ))}
                    . Those tournaments show what was set there.
                  </p>
                )}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}
