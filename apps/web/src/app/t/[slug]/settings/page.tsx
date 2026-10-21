import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can, DEFAULT_POINTS_CURVE, DEFAULT_TOLERANCE_SECONDS, parsePointsCurve } from '@bscs/core/match';
import { displayDifficulty } from '@bscs/core/beatleader';
import { Avatar, Badge, Button, Field, FieldAction, FormError, PageHeader, Panel, inputClass } from '@/components/ui';
import { AddPersonForm } from '@/components/add-person-form';
import { CurveEditor, type CurvePool } from '@/components/curve-editor';
import { perfectAccOf } from '@/server/match-summary';
import { getActorOrAnonymous } from '@/server/session';
import {
  deleteTournament,
  removeTournamentMember,
  setMatchRules,
  setScoringSettings,
  setTournamentVisibility,
} from '@/server/actions';
import { updateTournamentDetails } from '@/server/rename-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tournament settings' };

/**
 * Everything about running the tournament rather than playing in it: its name,
 * who can see it, the match rules, and who else runs it. Staff only.
 *
 * Each form comes back here with `?saved=<section>`, so the page is drawn
 * afresh from what was stored and says so beside the form that saved.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { slug } = await params;
  const { error, saved } = await searchParams;

  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isPublic: true,
      unlisted: true,
      captainsEnterScores: true,
      captainsPullScores: true,
      captainsCreateMatches: true,
      matchScoring: true,
      scoringLocked: true,
      replayCounting: true,
      doubleFailedRuns: true,
      perfectFromBeatLeader: true,
      pointsCurve: true,
      scorePull: true,
      pools: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          maps: {
            orderBy: { order: 'asc' },
            select: {
              id: true,
              label: true,
              perfectAcc: true,
              leaderboard: {
                select: {
                  predictedAcc: true,
                  difficultyValue: true,
                  customName: true,
                  map: { select: { name: true } },
                },
              },
            },
          },
        },
      },
      members: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, user: { select: { name: true, image: true } } },
      },
    },
  });
  if (!tournament) notFound();

  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'MANAGE_TOURNAMENT')) notFound();
  const grantsAdmin = actor.globalRole === 'ADMIN' || actor.tournamentRole === 'OWNER';
  const visibility = !tournament.isPublic ? 'PRIVATE' : tournament.unlisted ? 'UNLISTED' : 'PUBLIC';

  const curve = parsePointsCurve(tournament.pointsCurve);
  const toleranceSeconds = (tournament.scorePull as { toleranceSeconds?: number } | null)?.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const curvePools: CurvePool[] = tournament.pools
    .filter((p) => p.maps.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      maps: p.maps.map((m) => {
        const perfect = perfectAccOf(m, tournament.perfectFromBeatLeader);
        return {
          id: m.id,
          name: m.leaderboard.map.name,
          difficulty: m.label ?? displayDifficulty(m.leaderboard.difficultyValue, m.leaderboard.customName),
          perfectAcc: perfect.value,
          source: perfect.source,
        };
      }),
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Tournament settings"
        meta="How it runs and who runs it. Only tournament admins see this page."
      />

      <FormError message={error} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Name" actions={saved === 'details' ? <Saved /> : undefined}>
          <form action={updateTournamentDetails} className="space-y-3" key={`${tournament.name}|${tournament.description}`}>
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <Field label="Tournament name" hint={`Its link stays /t/${tournament.slug}, so links already shared keep working.`}>
              <input name="name" defaultValue={tournament.name} maxLength={80} required className={inputClass} />
            </Field>
            <Field label="Description" hint="Shown under the name on its overview and in link previews.">
              <textarea
                name="description"
                defaultValue={tournament.description ?? ''}
                maxLength={500}
                rows={2}
                className={`${inputClass} h-auto py-2`}
              />
            </Field>
            <Button type="submit">Save</Button>
          </form>
        </Panel>

        <Panel title="Who can see it" actions={saved === 'visibility' ? <Saved /> : undefined}>
          <form action={setTournamentVisibility} className="space-y-2 text-sm" key={visibility}>
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <Choice name="visibility" value="PUBLIC" checked={visibility === 'PUBLIC'}>
              Public
              <Note>Listed on the front page for everyone.</Note>
            </Choice>
            <Choice name="visibility" value="UNLISTED" checked={visibility === 'UNLISTED'}>
              Unlisted
              <Note>Anyone with the link can open it, but it is not on the front page.</Note>
            </Choice>
            <Choice name="visibility" value="PRIVATE" checked={visibility === 'PRIVATE'}>
              Private
              <Note>Only the people below and the players on its rosters can open it.</Note>
            </Choice>
            <p className="text-xs text-faint">
              Single matches can be unlisted too, from the match&apos;s own page.
            </p>
            <Button type="submit">Save</Button>
          </form>
        </Panel>
      </div>

      <Panel
        title="Match rules"
        subtitle="Who may do what on match night, and how maps are scored. These are the defaults new matches start from."
        actions={saved === 'rules' ? <Saved /> : undefined}
      >
        <form
          action={setMatchRules}
          className="space-y-3 text-sm"
          key={[
            tournament.captainsCreateMatches,
            tournament.captainsPullScores,
            tournament.captainsEnterScores,
            tournament.matchScoring,
            tournament.scoringLocked,
            tournament.replayCounting,
            tournament.doubleFailedRuns,
            tournament.perfectFromBeatLeader,
          ].join('|')}
        >
          <input type="hidden" name="tournamentId" value={tournament.id} />
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Captains may</legend>
            <RuleBox name="captainsCreateMatches" checked={tournament.captainsCreateMatches}>
              Set up matches for their own team
              <Note>Otherwise only tournament admins can.</Note>
            </RuleBox>
            <RuleBox name="captainsPullScores" checked={tournament.captainsPullScores}>
              Pull their match&apos;s scores from BeatLeader
              <Note>Fills both teams&apos; scores for a map in from everyone&apos;s latest run.</Note>
            </RuleBox>
            <RuleBox name="captainsEnterScores" checked={tournament.captainsEnterScores}>
              Type their own team&apos;s scores in by hand
              <Note>The override for when BeatLeader cannot say. Admins always can.</Note>
            </RuleBox>
          </fieldset>
          <fieldset className="space-y-2 border-t border-edge pt-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Scoring</legend>
            <Field label="New matches are scored on">
              <select name="matchScoring" className={inputClass} defaultValue={tournament.matchScoring}>
                <option value="ACCURACY">Average accuracy</option>
                <option value="MATCH_POINTS">Match points (the curve)</option>
              </select>
            </Field>
            <RuleBox name="scoringLocked" checked={tournament.scoringLocked}>
              Every match uses this
              <Note>Otherwise whoever sets a match up can choose.</Note>
            </RuleBox>
            <Field label="When a map is replayed, count">
              <select name="replayCounting" className={inputClass} defaultValue={tournament.replayCounting}>
                <option value="BEST_PAIR">Each team&apos;s best run as a pair</option>
                <option value="BEST_EACH">Each player&apos;s own best run</option>
              </select>
            </Field>
            <p className="-mt-1 text-xs text-faint">
              Best pair: both players&apos; scores come from the same go, never one&apos;s first run beside the other&apos;s replay.
              This and the failed-run rule below apply to every match not yet finished.
            </p>
            <RuleBox name="doubleFailedRuns" checked={tournament.doubleFailedRuns}>
              Count a failed run double
              <Note>No Fail halves a score once a player dies. On: it counts doubled back. Off: it counts as scored.</Note>
            </RuleBox>
            <RuleBox name="perfectFromBeatLeader" checked={tournament.perfectFromBeatLeader}>
              Use BeatLeader&apos;s predicted accuracy as a map&apos;s perfect % until one is set
              <Note>Perfect % only sizes a map&apos;s points; it never decides who wins it. Set it per map on the pool page.</Note>
            </RuleBox>
          </fieldset>
          <Button type="submit">Save rules</Button>
        </form>
      </Panel>

      <div id="curve" className="scroll-mt-20">
        <Panel
          title="Match points curve"
          subtitle="points = perfect points × raw(accuracy) / raw(perfect %), where raw(a) = 1 / (1 + padding − a) + slope × a. Each player's accuracy goes through it before the team averages."
          actions={saved === 'curve' ? <Saved /> : undefined}
        >
          <form action={setScoringSettings} key={JSON.stringify(curve)}>
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <CurveEditor pools={curvePools} saved={curve} defaults={DEFAULT_POINTS_CURVE} />
          </form>
          <p className="mt-3 text-xs text-faint">
            Changes apply to matches made from now on; a match keeps the curve it was made with. Whether matches use
            match points at all is under Match rules above.
          </p>
        </Panel>
      </div>

      <div id="pull" className="scroll-mt-20">
        <Panel
          title="Pulling scores from BeatLeader"
          subtitle="What counts as the run a map was just played with"
          actions={saved === 'pull' ? <Saved /> : undefined}
        >
          <form action={setScoringSettings} className="space-y-3" key={toleranceSeconds}>
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <div className="max-w-xs">
              <Field label="Start tolerance (seconds)" hint="How far apart players' starts may be and still count as the same go.">
                <input name="toleranceSeconds" inputMode="numeric" defaultValue={toleranceSeconds} className={`${inputClass} tabular`} />
              </Field>
            </div>
            <p className="text-xs text-faint">
              Everyone on a map starts it off the same countdown, so their runs start together - and that is what picks
              them out, however long after the song the button is pressed, and even if someone has played the map again
              since. Only runs since the map was picked (or its replay called) count.
            </p>
            <Button type="submit">Save</Button>
          </form>
        </Panel>
      </div>

      <Panel
        title="Tournament staff and viewers"
        subtitle="People who help run the tournament, or may look at it while it is private. Not team members: players go on rosters on the teams page."
      >
        <ul className="divide-y divide-edge text-sm">
          {tournament.members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 py-2">
              <Avatar src={member.user.image} name={member.user.name ?? '?'} size={28} />
              <span className="min-w-0 flex-1 truncate font-medium">{member.user.name ?? 'Unnamed user'}</span>
              <Badge tone={member.role === 'VIEWER' ? 'neutral' : 'accent'}>
                {member.role === 'OWNER'
                  ? 'Owner'
                  : member.role === 'ORGANIZER'
                    ? 'Tournament admin'
                    : member.role === 'VIEWER'
                      ? 'Viewer'
                      : member.role.toLowerCase()}
              </Badge>
              {member.role !== 'OWNER' && (member.role !== 'ORGANIZER' || grantsAdmin) && (
                <form action={removeTournamentMember}>
                  <input type="hidden" name="memberId" value={member.id} />
                  <button
                    type="submit"
                    className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
                  >
                    Remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <AddPersonForm tournamentId={tournament.id} grantsAdmin={grantsAdmin} />
        <p className="mt-2 text-xs text-faint">
          Tournament admins can do everything inside this tournament. Viewers only matter while it is private.
          Being on a roster does not let anyone see a private tournament - only the people listed here can.
        </p>
      </Panel>

      {grantsAdmin && (
        <details className="rounded-xl border border-red-400/20 bg-red-500/5 p-4 text-sm">
          <summary className="cursor-pointer font-medium text-red-200">Delete this tournament</summary>
          <form action={deleteTournament} className="mt-3 flex flex-wrap items-start gap-3">
            <input type="hidden" name="tournamentId" value={tournament.id} />
            <div className="min-w-[14rem] flex-1">
              <Field
                label={`Type "${tournament.name}" to confirm`}
                hint="Deletes its teams, rosters, pools and every match. Players and their scores are kept. This cannot be undone."
              >
                <input name="confirmName" className={inputClass} autoComplete="off" required />
              </Field>
            </div>
            <FieldAction>
              <Button type="submit" variant="danger">
                Delete forever
              </Button>
            </FieldAction>
          </form>
        </details>
      )}
    </div>
  );
}

function Saved() {
  return (
    <span role="status" className="text-xs font-medium text-win">
      ✓ Saved
    </span>
  );
}

function RuleBox({ name, checked, children }: { name: string; checked: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1" />
      <span>{children}</span>
    </label>
  );
}

function Choice({
  name,
  value,
  checked,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2">
      <input type="radio" name={name} value={value} defaultChecked={checked} className="mt-1" />
      <span>{children}</span>
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs text-faint">{children}</span>;
}
