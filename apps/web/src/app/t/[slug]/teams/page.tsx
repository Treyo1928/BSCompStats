import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can, isCaptainOf } from '@/server/match-helpers';
import {
  Panel,
  PageHeader,
  Empty,
  Button,
  Field,
  FormError,
  FieldAction,
  inputClass,
  Avatar,
  Badge,
  teamInk,
  teamWash,
  TeamScopeTabs,
} from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { createTeam, deleteTeam, setTaPlatformId, updateTeam } from '@/server/actions';
import { AddPlayerForm, ConfirmSubmit, LinkScoreSaber, MemberControls, RemoveFromPool } from '@/components/roster-controls';
import { NewMatchForm } from '@/components/new-match-form';
import { createPlayerPool } from '@/server/pool-actions';
import { DuoMaker } from '@/components/duo-maker';
import { RosterBoard } from '@/components/roster-board';
import { RunsVisibilityPanel } from '@/components/runs-visibility';
import { PlayerLink } from '@/components/player-card';
import { getTournamentSummary } from '@/server/summaries';
import { buildPoolBoard } from '@/server/board';
import { tournamentAliases } from '@/server/aliases';
import { setPlayerReplays, setPlayerShown, setTeamLogo } from '@/server/team-media-actions';
import { TeamLogo } from '@/components/team-logo';
import { SaberColors } from '@/components/saber-colors';
import { viewerBase } from '@/lib/replay-viewer';
import { SHOWCASE_REPLAYS_MAX, SHOWCASE_REPLAYS_PER_PLAYER } from '@bscs/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const t = await getTournamentSummary((await params).slug);
  if (!t) return {};

  const title = `Teams - ${t.name}`;
  const description =
    t.teams.length === 0
      ? 'No teams yet.'
      : t.teams
          .map((team) => `${team.name}: ${team.members.map((m) => m.player.name).join(', ') || 'no players yet'}`)
          .join(' | ');
  return { title, description, openGraph: { title, description } };
}

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; show?: string; seedBy?: string }>;
}) {
  const { slug } = await params;
  const { error, show, seedBy } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      isPublic: true,
      pools: { select: { id: true, name: true } },
      captainsCreateMatches: true,
      matchScoring: true,
      scoringLocked: true,
      taModeDefault: true,
      divisions: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          teams: {
            // Match-only sides after the teams entered in the tournament.
            orderBy: [{ adHoc: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              color: true,
              colorSecondary: true,
              logo: true,
              adHoc: true,
              playerPool: true,
              members: {
                orderBy: { order: 'asc' },
                select: {
                  id: true,
                  role: true,
                  isSub: true,
                  available: true,
                  player: {
                    select: {
                      id: true,
                      name: true,
                      beatLeaderId: true,
                      pp: true,
                      avatar: true,
                      userId: true,
                      scoreSaberId: true,
                      taPlatformId: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();

  const canManage = can(actor, 'MANAGE_TEAMS');
  const aliases = await tournamentAliases(tournament.id);
  const teams = tournament.divisions.flatMap((d) => d.teams);
  const entered = teams.filter((t) => !t.adHoc && !t.playerPool);
  const playerPool = teams.find((t) => t.playerPool) ?? null;
  const matchOnly = teams.filter((t) => t.adHoc);
  // Match-only sides have a tab of their own, and only when there are any.
  const showing = show === 'match-only' && matchOnly.length > 0 ? 'adHoc' : 'entered';
  const listed = showing === 'adHoc' ? matchOnly : entered;

  // The pool's seeds start in BeatLeader pp order, or in order of accuracy on
  // one of the map pools: each player's mean over the maps they have played
  // there. Nobody with a score there goes after everyone who has one.
  // What a saber colour preview can play: each player's own BeatLeader replays of this tournament's pool maps.
  const viewer = viewerBase();
  const poolReplays = new Map<string, Array<{ scoreId: number; label: string }>>();
  if (actor.userId && viewer) {
    const scores = await prisma.score.findMany({
      where: {
        beatLeaderScoreId: { not: null },
        playerId: { in: teams.flatMap((t) => t.members.map((m) => m.player.id)) },
        leaderboard: { poolMaps: { some: { pool: { tournamentId: tournament.id } } } },
      },
      orderBy: { accuracy: 'desc' },
      select: {
        playerId: true,
        beatLeaderScoreId: true,
        accuracy: true,
        leaderboard: { select: { difficultyName: true, map: { select: { name: true } } } },
      },
    });
    for (const s of scores) {
      const list = poolReplays.get(s.playerId) ?? [];
      list.push({
        scoreId: s.beatLeaderScoreId!,
        label: `${s.leaderboard.map.name} · ${s.leaderboard.difficultyName.replace('ExpertPlus', 'Expert+')} · ${(s.accuracy * 100).toFixed(2)}%`,
      });
      poolReplays.set(s.playerId, list);
    }
  }

  const seedPool = tournament.pools.find((p) => p.id === seedBy) ?? null;
  const seedBoard = seedPool && playerPool && playerPool.members.length > 0 ? await buildPoolBoard(seedPool.id) : null;
  const poolAcc = new Map(
    (seedBoard?.teams ?? [])
      .flatMap((t) => t.rows)
      .filter((r) => r.teamId === playerPool?.id && r.meanAcc != null)
      .map((r) => [r.playerId, { acc: r.meanAcc!, played: r.played }]),
  );
  const poolMapCount = seedBoard?.maps.length ?? 0;
  const seededPool = playerPool
    ? [...playerPool.members].sort((a, b) => {
        if (seedPool) {
          const x = poolAcc.get(a.player.id)?.acc ?? -1;
          const y = poolAcc.get(b.player.id)?.acc ?? -1;
          if (x !== y) return y - x;
        }
        return b.player.pp - a.player.pp;
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Teams and rosters"
        meta={`${entered.length} teams · ${new Set(entered.flatMap((t) => t.members.map((m) => m.player.id))).size} players · tap a player for their overview and stats`}
      />

      <FormError message={error} />

      <TeamScopeTabs
        hrefs={{ entered: `/t/${slug}/teams`, adHoc: `/t/${slug}/teams?show=match-only` }}
        showing={showing}
        counts={{ entered: entered.length, adHoc: matchOnly.length }}
      />
      {showing === 'adHoc' && (
        <p className="text-sm text-muted">
          Sides put together for a custom match or a captains&apos; draft. They are not entered in the tournament,
          and each is removed when its last match is deleted.
        </p>
      )}

      {showing === 'entered' && (playerPool || canManage) && (
        <Panel
          title="Player pool"
          subtitle="Players signed up but not in a team yet"
        >
          {!playerPool ? (
            <form action={createPlayerPool} className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <span>For a tournament where teams are made from individual sign-ups.</span>
              <Button type="submit" variant="ghost">
                Start a player pool
              </Button>
            </form>
          ) : (
            <>
              {playerPool.members.length === 0 ? (
                <Empty>Nobody in the pool.</Empty>
              ) : (
                <div className="space-y-3">
                  {canManage && playerPool.members.length >= 2 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="mr-1 text-faint">Seed by</span>
                      {[{ id: null, label: 'BeatLeader pp' }, ...tournament.pools.map((p) => ({ id: p.id, label: `Accuracy on ${p.name}` }))].map(
                        (option) => {
                          const active = (seedPool?.id ?? null) === option.id;
                          return (
                            <Link
                              key={option.id ?? 'pp'}
                              href={option.id ? `/t/${slug}/teams?seedBy=${option.id}` : `/t/${slug}/teams`}
                              scroll={false}
                              aria-current={active ? 'true' : undefined}
                              className={`inline-flex h-8 max-w-full items-center truncate rounded-full border px-3 font-medium transition ${
                                active
                                  ? 'border-accent bg-accent/15 text-ink'
                                  : 'border-edge-strong text-muted hover:border-faint hover:text-ink'
                              }`}
                            >
                              {option.label}
                            </Link>
                          );
                        },
                      )}
                    </div>
                  )}
                  <ul className="grid gap-1 sm:grid-cols-2 sm:gap-x-4">
                    {seededPool.map((member, i) => {
                      const acc = poolAcc.get(member.player.id);
                      return (
                        <li key={member.id} className="flex min-w-0 items-center gap-2 text-sm">
                          {canManage && <span className="w-5 shrink-0 text-right text-xs tabular text-faint">{i + 1}</span>}
                          <PlayerLink
                            playerId={member.player.id}
                            name={member.player.name}
                            className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                          >
                            <Avatar src={member.player.avatar} name={member.player.name} size={24} />
                            <span className="truncate" title={member.player.name}>
                              {member.player.name}
                            </span>
                          </PlayerLink>
                          <span
                            className="shrink-0 text-right text-xs tabular text-muted"
                            title={acc ? `Mean accuracy over the ${acc.played} of ${poolMapCount} maps they have played in ${seedPool!.name}` : undefined}
                          >
                            {seedPool
                              ? acc
                                ? `${(acc.acc * 100).toFixed(2)}% · ${acc.played}/${poolMapCount}`
                                : 'no scores'
                              : member.player.pp > 0
                                ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp`
                                : '—'}
                          </span>
                          {canManage && (
                            // In the pool the only thing to do to a player is take them out of it.
                            <RemoveFromPool memberId={member.id} playerName={member.player.name} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {canManage && playerPool.members.length >= 2 && (
                    <DuoMaker
                      // drawn afresh when the pool or what seeds it changes
                      key={`${seedPool?.id ?? 'pp'}:${seededPool.map((m) => m.id).join()}`}
                      tournamentId={tournament.id}
                      format={seedPool ? 'acc' : 'pp'}
                      players={seededPool.map((member) => {
                        const acc = poolAcc.get(member.player.id);
                        return {
                          memberId: member.id,
                          name: member.player.name,
                          avatar: member.player.avatar,
                          stat: seedPool
                            ? acc
                              ? `${(acc.acc * 100).toFixed(2)}%`
                              : 'no scores'
                            : member.player.pp > 0
                              ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp`
                              : '—',
                          value: seedPool ? (acc?.acc ?? null) : member.player.pp > 0 ? member.player.pp : null,
                        };
                      })}
                    />
                  )}
                </div>
              )}
              {canManage && <AddPlayerForm teamId={playerPool.id} teamName="the player pool" />}
            </>
          )}
        </Panel>
      )}

      {showing === 'entered' && canManage && entered.length + (playerPool ? 1 : 0) >= 2 && (
        <Panel title="Arrange rosters" subtitle="Swap two players, or move one to another team">
          <RosterBoard
            // drawn afresh once a change is saved
            key={[...entered, ...(playerPool ? [playerPool] : [])].map((t) => `${t.id}:${t.members.map((m) => m.id).join()}`).join('|')}
            tournamentId={tournament.id}
            teams={[...entered, ...(playerPool ? [playerPool] : [])].map((t) => ({
              id: t.id,
              name: t.name,
              color: t.color,
              colorSecondary: t.colorSecondary,
              pool: t.playerPool,
              members: t.members.map((m) => ({ id: m.id, name: aliases.get(m.player.id)?.nickname || m.player.name, avatar: m.player.avatar })),
              captainPlaces: t.members.map((m) => m.role === 'CAPTAIN'),
            }))}
          />
        </Panel>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {listed.map((team) => (
          <Panel key={team.id} flush>
            <div
              className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3"
              style={{
                background: `linear-gradient(90deg, ${teamWash(team.color)}, transparent 70%)`,
                borderLeft: `3px solid ${team.color}`,
              }}
            >
              <h2
                className="flex min-w-0 items-center gap-2 truncate text-base font-semibold tracking-tight"
                style={{ color: teamInk(team.color, team.colorSecondary) }}
              >
                <TeamLogo logo={team.logo} size={22} />
                <span className="truncate">{team.name}</span>
                {team.adHoc && (
                  <Badge title="Put together for a particular match. It is removed when its last match is deleted.">
                    Match-only
                  </Badge>
                )}
              </h2>
              <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                <span className="hidden sm:inline">
                  {team.members.filter((m) => m.available).length} of {team.members.length} available
                </span>
              </span>
            </div>

            <div className="p-4">
              {team.members.length === 0 ? (
                <Empty>No players yet.</Empty>
              ) : (
                <ul className="-my-1.5 text-sm">
                  {team.members.map((member) => {
                    const alias = aliases.get(member.player.id);
                    const shownName = alias?.nickname || member.player.name;
                    const replays = alias?.replays ?? [];
                    const isSelf = !!actor.userId && member.player.userId === actor.userId;
                    const maySetReplays = canManage || isSelf || isCaptainOf(actor, team.id);
                    return (
                    // On a phone the controls drop to their own line rather than squeezing the name out.
                    <li key={member.id} className="flex flex-wrap items-center justify-end gap-x-1">
                      <PlayerLink
                        playerId={member.player.id}
                        name={member.player.name}
                        className="-ml-2 flex min-w-0 flex-1 basis-full items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-raised sm:basis-0"
                      >
                        <Avatar
                          src={alias?.avatar || member.player.avatar}
                          name={shownName}
                          size={32}
                          ring={team.color}
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-medium ${member.available ? '' : 'text-muted line-through decoration-faint'}`}
                          title={alias?.nickname ? `${alias.nickname} (${member.player.name} on BeatLeader)` : undefined}
                        >
                          {shownName}
                        </span>
                        {member.isSub && (
                          <Badge title="Substitute - only counted when switched in">
                            {member.available ? 'Sub · in' : 'Sub'}
                          </Badge>
                        )}
                        {!member.isSub && !member.available && (
                          <Badge tone="warn" title="Left out of lineups">
                            Absent
                          </Badge>
                        )}
                        {member.role === 'CAPTAIN' &&
                          (member.player.userId ? (
                            <Badge tone="accent">Captain</Badge>
                          ) : (
                            <Badge
                              tone="warn"
                              title="Has not signed in yet. They get control of picks, bans and lineups once they sign in with BeatLeader."
                            >
                              Captain · no account
                            </Badge>
                          ))}
                        <span className="w-14 shrink-0 text-right text-xs tabular text-muted sm:w-16">
                          {member.player.pp > 0 ? `${Math.round(member.player.pp).toLocaleString('en-US')}pp` : '—'}
                        </span>
                      </PlayerLink>
                      {member.player.scoreSaberId ? (
                        <Badge title="ScoreSaber is linked, so their scores and pp there count too">SS</Badge>
                      ) : (
                        canManage && <LinkScoreSaber memberId={member.id} playerName={member.player.name} />
                      )}
                      {(canManage || isCaptainOf(actor, team.id)) && (
                        <MemberControls
                          memberId={member.id}
                          playerName={member.player.name}
                          teamName={team.name}
                          isCaptain={member.role === 'CAPTAIN'}
                          isSub={member.isSub}
                          available={member.available}
                          canManage={canManage}
                        />
                      )}
                      {canManage && (
                        // TournamentAssistant finds players by platform id: Steam64 is the BeatLeader id, a Quest player's is not.
                        <details className="basis-full pb-1 pl-11 text-xs sm:pl-12">
                          <summary className="cursor-pointer text-faint hover:text-ink">
                            TA id: {member.player.taPlatformId ?? `${member.player.beatLeaderId} (BeatLeader)`}
                          </summary>
                          <form action={setTaPlatformId} className="mt-1.5 flex flex-wrap items-center gap-2">
                            <input type="hidden" name="memberId" value={member.id} />
                            <input
                              name="taPlatformId"
                              defaultValue={member.player.taPlatformId ?? ''}
                              placeholder={member.player.beatLeaderId}
                              aria-label={`${member.player.name}'s TournamentAssistant platform id`}
                              autoComplete="off"
                              className={`${inputClass} h-8 w-52 tabular`}
                            />
                            <Button type="submit" variant="ghost" className="h-8 text-xs">
                              Save
                            </Button>
                            <span className="text-faint">
                              The id TournamentAssistant shows for them. Leave blank to use their BeatLeader id, which is right for
                              Steam players.
                            </span>
                          </form>
                        </details>
                      )}
                      {(maySetReplays || replays.length > 0) && (
                        <details className="basis-full pb-1 pl-11 text-xs sm:pl-12">
                          <summary className="cursor-pointer text-faint hover:text-ink">
                            On stream: {replays.length === 0 ? 'no replays yet' : `${replays.length} replay${replays.length === 1 ? '' : 's'}`}
                            {alias?.nickname ? ` · shown as ${alias.nickname}` : ''}
                            {alias?.avatar ? ' · own picture' : ''}
                            {alias?.sabers && (
                              <span className="ml-1.5 inline-flex translate-y-px gap-0.5" title="Their saber colours">
                                <span className="h-2.5 w-4 rounded-sm" style={{ background: alias.sabers.left }} />
                                <span className="h-2.5 w-4 rounded-sm" style={{ background: alias.sabers.right }} />
                              </span>
                            )}
                          </summary>
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
                                    {r.player && r.player !== member.player.name ? ` · played by ${r.player}` : ''}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {maySetReplays && (
                            <form action={setPlayerReplays} className="mt-1.5 space-y-1.5">
                              <input type="hidden" name="memberId" value={member.id} />
                              <textarea
                                name="replays"
                                rows={Math.max(2, replays.length + 1)}
                                defaultValue={replays.map((r) => r.ref).join('\n')}
                                placeholder="https://replay.beatleader.com/?scoreId=..."
                                aria-label={`${shownName}'s replays to show on stream, one link per line`}
                                className={`${inputClass} h-auto py-1.5 font-mono text-xs`}
                              />
                              <div className="flex flex-wrap items-center gap-2">
                                <Button type="submit" variant="ghost" className="h-8 text-xs">
                                  Save replays
                                </Button>
                                <span className="text-faint">
                                  Replays to play on stream while this team is up next. One BeatLeader replay link per line,{' '}
                                  {canManage
                                    ? `up to ${SHOWCASE_REPLAYS_MAX} (players and captains can add ${SHOWCASE_REPLAYS_PER_PLAYER} of their own).`
                                    : `up to ${SHOWCASE_REPLAYS_PER_PLAYER}, played by ${isSelf ? 'you' : member.player.name}.`}
                                </span>
                              </div>
                            </form>
                          )}
                          {maySetReplays && (
                            <SaberColors
                              key={`${alias?.sabers?.left}:${alias?.sabers?.right}`}
                              memberId={member.id}
                              playerName={shownName}
                              sabers={alias?.sabers ?? null}
                              replays={poolReplays.get(member.player.id) ?? []}
                              viewer={viewer}
                            />
                          )}
                          {canManage && (
                            <form action={setPlayerShown} className="mt-3 flex flex-wrap items-end gap-2 border-t border-edge pt-2">
                              <input type="hidden" name="memberId" value={member.id} />
                              <label className="space-y-1">
                                <span className="block text-faint">Nickname in this tournament</span>
                                <input
                                  name="nickname"
                                  defaultValue={alias?.nickname ?? ''}
                                  placeholder={member.player.name}
                                  maxLength={40}
                                  autoComplete="off"
                                  className={`${inputClass} h-8 w-48`}
                                />
                              </label>
                              <label className="space-y-1">
                                <span className="block text-faint">Picture (PNG, JPEG, WebP, GIF or SVG, 1 MB at most)</span>
                                <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="block max-w-[15rem] text-xs" />
                              </label>
                              {alias?.avatar && (
                                <label className="flex h-8 items-center gap-1.5">
                                  <input type="checkbox" name="removeAvatar" /> Back to their BeatLeader picture
                                </label>
                              )}
                              <Button type="submit" variant="ghost" className="h-8 text-xs">
                                Save
                              </Button>
                              <span className="basis-full text-faint">
                                Leave the nickname blank to use their BeatLeader name. Both apply to this tournament only: its match pages, boards and the stream overlay.
                              </span>
                            </form>
                          )}
                        </details>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}

              {canManage && <AddPlayerForm teamId={team.id} teamName={team.name} />}

              {canManage && (
                <details className="mt-3 border-t border-edge pt-3 text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
                    Edit team
                  </summary>
                  <form action={updateTeam} className="mt-3 flex flex-wrap items-start gap-3">
                    <input type="hidden" name="teamId" value={team.id} />
                    <div className="min-w-[10rem] flex-1">
                      <Field label="Name">
                        <input name="name" defaultValue={team.name} className={inputClass} required />
                      </Field>
                    </div>
                    <Field label="Colour">
                      <input
                        type="color"
                        name="color"
                        defaultValue={team.color}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                    <Field label="Second colour">
                      <input
                        type="color"
                        name="colorSecondary"
                        defaultValue={team.colorSecondary}
                        className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                      />
                    </Field>
                    <FieldAction>
                      <Button type="submit">Save</Button>
                    </FieldAction>
                  </form>
                  <form action={setTeamLogo} className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-edge pt-3 text-xs">
                    <input type="hidden" name="teamId" value={team.id} />
                    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <legend className="mb-1 font-medium text-muted">Logo</legend>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name="logo" value="star" defaultChecked={!team.logo} />
                        <TeamLogo logo={null} size={18} /> Star
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name="logo" value="msu" defaultChecked={team.logo === 'msu'} />
                        <TeamLogo logo="msu" size={18} /> MSU Esports
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name="logo" value="upload" defaultChecked={!!team.logo && team.logo !== 'msu'} />
                        {team.logo && team.logo !== 'msu' && <TeamLogo logo={team.logo} size={18} />} Own picture
                      </label>
                    </fieldset>
                    <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" aria-label={`A logo for ${team.name}`} className="block max-w-[15rem] text-xs" />
                    <Button type="submit" variant="ghost" className="h-8 text-xs">
                      Save logo
                    </Button>
                    <span className="basis-full text-faint">
                      Shown beside the team&apos;s name here and on the stream overlay. A square PNG or SVG with a see-through background works best; 1 MB at most.
                    </span>
                  </form>
                  <form action={deleteTeam} className="mt-3">
                    <input type="hidden" name="teamId" value={team.id} />
                    <ConfirmSubmit
                      question={`Delete ${team.name} and its roster? This cannot be undone.`}
                    >
                      Delete team
                    </ConfirmSubmit>
                  </form>
                </details>
              )}
            </div>
          </Panel>
        ))}
      </div>

      {canManage && showing === 'entered' && (
        <div className="grid gap-6 md:grid-cols-2">
          <Panel title="New team">
            <form action={createTeam} className="flex flex-wrap items-start gap-3">
              <input type="hidden" name="tournamentId" value={tournament.id} />
              <input type="hidden" name="from" value="teams" />
              <div className="min-w-[10rem] flex-1">
                <Field label="Name">
                  <input name="name" className={inputClass} required />
                </Field>
              </div>
              <Field label="Colour">
                <input
                  type="color"
                  name="color"
                  defaultValue="#7c3aed"
                  className="h-9 w-14 rounded-lg border border-edge-strong bg-transparent"
                />
              </Field>
              <FieldAction>
                <Button type="submit">Create</Button>
              </FieldAction>
            </form>
          </Panel>

          {can(actor, 'CREATE_MATCH', { captainsCreateMatches: tournament.captainsCreateMatches }) && (
            <NewMatchForm
              tournamentId={tournament.id}
              teams={entered}
              pools={tournament.pools}
              from="teams"
              scoring={{ mode: tournament.matchScoring, locked: tournament.scoringLocked }}
              taModeDefault={tournament.taModeDefault}
              ownTeamIds={can(actor, 'CREATE_MATCH') ? undefined : [...(actor.captainOfTeamIds ?? [])]}
            />
          )}
        </div>
      )}

      <RunsVisibilityPanel
        tournamentId={tournament.id}
        canCheck={canManage}
        myPlayerIds={
          actor.userId
            ? teams.flatMap((t) => t.members.filter((m) => m.player.userId === actor.userId).map((m) => m.player.id))
            : []
        }
      />
    </div>
  );
}
