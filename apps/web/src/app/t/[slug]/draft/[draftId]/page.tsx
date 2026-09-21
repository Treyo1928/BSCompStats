import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { draftSequence, parseDraftSettings } from '@bscs/core/match';
import { can } from '@/server/match-helpers';
import {
  Avatar,
  Badge,
  Button,
  Empty,
  FormError,
  PageHeader,
  Panel,
  pct,
  teamInk,
  teamWash,
} from '@/components/ui';
import { ConfirmButton } from '@/components/confirm-button';
import { MatchLive } from '@/components/match-live';
import { MatchOptions } from '@/components/custom-match-builder';
import { getActorOrAnonymous } from '@/server/session';
import { buildTournamentModel } from '@/server/stats';
import { deleteDraft, draftPick, startDraftMatch, undoDraftPick } from '@/server/draft-actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: "Captains' draft" };

const teamSelect = {
  id: true,
  name: true,
  color: true,
  colorSecondary: true,
  members: {
    orderBy: { order: 'asc' },
    select: { role: true, player: { select: { id: true, name: true, avatar: true, userId: true } } },
  },
} as const;

export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; draftId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug, draftId } = await params;
  const { error } = await searchParams;

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: {
      tournament: {
        select: {
          id: true,
          slug: true,
          name: true,
          isPublic: true,
          pools: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
        },
      },
      teamA: { select: teamSelect },
      teamB: { select: teamSelect },
      players: {
        select: {
          pickNumber: true,
          side: true,
          player: { select: { id: true, name: true, avatar: true, pp: true } },
        },
      },
    },
  });
  if (!draft || draft.tournament.slug !== slug) notFound();

  const actor = await getActorOrAnonymous(draft.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: draft.tournament.isPublic })) notFound();

  const model = await buildTournamentModel(draft.tournament.id);
  const settings = parseDraftSettings(draft);
  const sequence = draftSequence(settings, draft.players.length);
  const picked = draft.players
    .filter((p) => p.pickNumber != null)
    .sort((a, b) => a.pickNumber! - b.pickNumber!);
  const slot = draft.matchId ? null : (sequence[picked.length] ?? null);
  const onTheClock = slot === 'A' ? draft.teamA : slot === 'B' ? draft.teamB : null;
  const canPick = onTheClock ? can(actor, 'MAKE_PICK_BAN', { teamId: onTheClock.id }) : false;
  const complete = picked.length >= draft.players.length;

  // Strongest first: it is what a captain is scanning for.
  const skillOf = (playerId: string) => model.profiles[playerId]?.skill ?? -Infinity;
  const available = draft.players
    .filter((p) => p.pickNumber == null)
    .sort((a, b) => skillOf(b.player.id) - skillOf(a.player.id) || b.player.pp - a.player.pp);

  const teams = [
    { side: 'A' as const, team: draft.teamA },
    { side: 'B' as const, team: draft.teamB },
  ];
  const captainOf = (team: typeof draft.teamA) => team.members.find((m) => m.role === 'CAPTAIN')?.player;

  return (
    <div className="space-y-6">
      <MatchLive draftId={draft.id} />
      <PageHeader
        crumbs={[{ label: draft.tournament.name, href: `/t/${slug}` }]}
        title={draft.name}
        meta={
          <>
            {settings.order === 'SNAKE' ? 'Snake draft' : 'Alternating draft'} ·{' '}
            {(settings.firstPick === 'A' ? draft.teamA : draft.teamB).name} picks first
            {sequence.includes('BOTH') && ' · last player plays for both'}
          </>
        }
        actions={
          <>
            {can(actor, 'UNDO_ACTION') && picked.length > 0 && !draft.matchId && (
              <form action={undoDraftPick}>
                <input type="hidden" name="draftId" value={draft.id} />
                <Button variant="ghost" type="submit">
                  Undo last pick
                </Button>
              </form>
            )}
            {can(actor, 'CREATE_MATCH') && (
              <form action={deleteDraft}>
                <input type="hidden" name="draftId" value={draft.id} />
                <ConfirmButton
                  question={
                    draft.matchId
                      ? 'Remove this draft record? The match and its teams are kept.'
                      : `Abandon ${draft.name}? Both teams go with it.`
                  }
                  className="inline-flex h-9 items-center rounded-lg border border-edge px-3 text-sm font-medium text-muted transition hover:border-red-400/50 hover:text-lose"
                >
                  {draft.matchId ? 'Remove draft' : 'Abandon draft'}
                </ConfirmButton>
              </form>
            )}
          </>
        }
      />

      <FormError message={error} />

      {/* On the clock */}
      <section
        className="overflow-hidden rounded-2xl border border-edge px-4 py-4 sm:px-6"
        style={
          onTheClock
            ? { background: `linear-gradient(90deg, ${teamWash(onTheClock.color)}, var(--color-panel) 75%)` }
            : { background: 'var(--color-panel)' }
        }
      >
        {onTheClock ? (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">
              Pick {picked.length + 1} of {sequence.length}
            </p>
            <p className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
              <span style={{ color: teamInk(onTheClock.color, onTheClock.colorSecondary) }}>
                {captainOf(onTheClock)?.name ?? onTheClock.name}
              </span>{' '}
              to pick
            </p>
            <p className="mt-1 text-sm text-muted">
              {canPick
                ? 'Your pick - choose from the players below.'
                : captainOf(onTheClock)?.userId
                  ? 'Waiting for them to choose. This page updates by itself.'
                  : 'This captain has no account here, so an organiser picks on their say-so.'}
            </p>
          </>
        ) : draft.matchId ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-lg font-semibold">The match is under way.</p>
            <Link
              href={`/t/${slug}/match/${draft.matchId}`}
              className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-surface hover:brightness-110"
            >
              Open the match
            </Link>
          </div>
        ) : (
          <p className="text-lg font-semibold">
            Draft complete.{' '}
            <span className="font-normal text-muted">
              {can(actor, 'CREATE_MATCH')
                ? 'Open the match below when both sides are ready.'
                : 'An organiser opens the match from here.'}
            </span>
          </p>
        )}

        <ol className="mt-3 flex flex-wrap gap-1" aria-label="Pick order">
          {sequence.map((s, i) => {
            const team = s === 'A' ? draft.teamA : s === 'B' ? draft.teamB : null;
            const done = i < picked.length;
            return (
              <li
                key={i}
                aria-current={i === picked.length && !draft.matchId ? 'step' : undefined}
                title={team ? `Pick ${i + 1}: ${team.name}` : 'Shared by both teams'}
                className={`h-2 w-6 rounded-full ${i === picked.length && !draft.matchId ? 'ring-2 ring-ink/80 ring-offset-2 ring-offset-panel' : ''} ${done ? 'opacity-35' : ''}`}
                style={{
                  background: team
                    ? team.color
                    : `linear-gradient(90deg, ${draft.teamA.color} 50%, ${draft.teamB.color} 50%)`,
                }}
              />
            );
          })}
        </ol>
      </section>

      {/* The two sides. Side by side even on a phone: the comparison is the point. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-6">
        {teams.map(({ side, team }) => (
          <Panel key={team.id} flush>
            <div
              className="border-b border-edge px-3 py-2.5 sm:px-4"
              style={{
                background: `linear-gradient(90deg, ${teamWash(team.color)}, transparent 80%)`,
                borderLeft: `3px solid ${team.color}`,
              }}
            >
              <h2
                className="truncate text-sm font-semibold tracking-tight sm:text-base"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                {team.name}
              </h2>
              <p className="text-xs text-muted">{team.members.length} players</p>
            </div>
            <ul className="divide-y divide-edge/60 text-sm">
              {team.members.map((member) => {
                const pick = picked.find(
                  (p) => p.player.id === member.player.id && (p.side === side || p.side === 'BOTH'),
                );
                return (
                  <li key={member.player.id} className="flex items-center gap-2 px-3 py-2 sm:px-4">
                    <Avatar src={member.player.avatar} name={member.player.name} size={26} ring={team.color} />
                    <span className="min-w-0 flex-1 truncate font-medium">{member.player.name}</span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-faint">
                      {member.role === 'CAPTAIN'
                        ? 'Capt'
                        : pick?.side === 'BOTH'
                          ? 'Shared'
                          : pick
                            ? `#${pick.pickNumber! + 1}`
                            : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ))}
      </div>

      {!complete && (
        <Panel
          title="Still available"
          subtitle="Strongest first, by this tournament's model"
          flush
        >
          {available.length === 0 ? (
            <div className="p-4">
              <Empty>Nobody left.</Empty>
            </div>
          ) : (
            <ul className="divide-y divide-edge/60">
              {available.map(({ player }) => {
                const profile = model.profiles[player.id];
                const style = model.styles[player.id];
                return (
                  <li key={player.id} className="flex items-center gap-3 px-4 py-2">
                    <Avatar src={player.avatar} name={player.name} size={34} />
                    <Link href={`/t/${slug}/stats/${player.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium hover:underline">{player.name}</span>
                      <span className="block truncate text-xs text-faint">
                        {[
                          profile?.meanAcc ? `${pct(profile.meanAcc)} avg` : 'no scores yet',
                          style && !style.thin ? style.label : null,
                          player.pp > 0 ? `${Math.round(player.pp).toLocaleString('en-US')}pp` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </Link>
                    {canPick && onTheClock && (
                      <form action={draftPick}>
                        <input type="hidden" name="draftId" value={draft.id} />
                        <input type="hidden" name="playerId" value={player.id} />
                        <Button type="submit">Pick</Button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}

      {complete && !draft.matchId && can(actor, 'CREATE_MATCH') && (
        <Panel title="Open the match" subtitle={`${draft.teamA.name} against ${draft.teamB.name}`}>
          {draft.tournament.pools.length === 0 ? (
            <Empty>A match needs a map pool. Import one on the tournament page first.</Empty>
          ) : (
            <form action={startDraftMatch} className="space-y-3">
              <input type="hidden" name="draftId" value={draft.id} />
              <MatchOptions
                pools={draft.tournament.pools}
                sideNames={[draft.teamA.name, draft.teamB.name]}
              />
              <Button type="submit">Create match</Button>
            </form>
          )}
        </Panel>
      )}

      {picked.length > 0 && (
        <Panel title="Picks so far">
          <ol className="flex flex-wrap gap-2 text-sm">
            {picked.map((p) => {
              const team = p.side === 'A' ? draft.teamA : p.side === 'B' ? draft.teamB : null;
              return (
                <li
                  key={p.player.id}
                  className="flex items-center gap-2 rounded-lg border border-edge bg-raised/40 py-1 pl-1.5 pr-3"
                  style={{ borderBottom: `2px solid ${team?.color ?? 'var(--color-edge-strong)'}` }}
                >
                  <Avatar src={p.player.avatar} name={p.player.name} size={24} />
                  <span className="font-medium">{p.player.name}</span>
                  <Badge>{team ? `${p.pickNumber! + 1} · ${team.name}` : 'shared'}</Badge>
                </li>
              );
            })}
          </ol>
        </Panel>
      )}
    </div>
  );
}
