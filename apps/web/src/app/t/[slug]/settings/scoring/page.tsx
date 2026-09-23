import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import {
  can,
  DEFAULT_POINTS_CURVE,
  DEFAULT_TOLERANCE_SECONDS,
  matchPoints,
  parsePointsCurve,
} from '@bscs/core/match';
import { Button, Field, FormError, PageHeader, Panel, inputClass } from '@/components/ui';
import { getActorOrAnonymous } from '@/server/session';
import { setScoringSettings } from '@/server/actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Scoring settings', robots: { index: false } };

/**
 * The match points curve and how scores are pulled from BeatLeader. Set once
 * and left alone, so the page is not in the tournament's navigation - it is
 * reached by its address, by tournament admins only.
 */
export default async function ScoringSettingsPage({
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
    select: { id: true, name: true, pointsCurve: true, scorePull: true, matchScoring: true },
  });
  if (!tournament) notFound();
  const actor = await getActorOrAnonymous(tournament.id);
  // Not "forbidden": for anyone who may not change it, there is no such page.
  if (!can(actor, 'MANAGE_TOURNAMENT')) notFound();

  const curve = parsePointsCurve(tournament.pointsCurve);
  const pull = (tournament.scorePull ?? {}) as { toleranceSeconds?: number };
  const toleranceSeconds = pull.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  // What the curve does, on a map whose perfect score is 98%.
  const examples = [0.7, 0.8, 0.9, 0.95, 0.97, 0.98, 0.99, 1];

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
        title="Scoring settings"
        meta="The match points curve, and how scores are taken from BeatLeader. Changes apply to matches made from now on; a match keeps the curve it was made with."
      />
      <FormError message={error} />
      {saved && <p className="rounded-lg border border-win/40 bg-win/10 px-4 py-2 text-sm text-win">Saved.</p>}

      <form action={setScoringSettings} className="grid gap-6 lg:grid-cols-2">
        <input type="hidden" name="tournamentId" value={tournament.id} />
        <Panel
          title="Match points curve"
          subtitle="points = perfect points × raw(accuracy) / raw(perfect %), where raw(a) = 1 / (1 + padding − a) + slope × a"
        >
          <div className="grid grid-cols-3 gap-3">
            <Field label="Padding" hint={`Smaller is steeper near 100%. Default ${DEFAULT_POINTS_CURVE.padding}.`}>
              <input name="padding" inputMode="decimal" defaultValue={curve.padding} className={`${inputClass} tabular`} />
            </Field>
            <Field label="Slope" hint={`How much lower accuracies still climb. Default ${DEFAULT_POINTS_CURVE.slope}.`}>
              <input name="slope" inputMode="decimal" defaultValue={curve.slope} className={`${inputClass} tabular`} />
            </Field>
            <Field label="Perfect points" hint={`What a score at the map's perfect % is worth. Default ${DEFAULT_POINTS_CURVE.perfectPoints}.`}>
              <input name="perfectPoints" inputMode="decimal" defaultValue={curve.perfectPoints} className={`${inputClass} tabular`} />
            </Field>
          </div>
          <table className="mt-4 w-full text-sm">
            <caption className="mb-1 text-left text-xs text-faint">As saved, on a map whose perfect score is 98%</caption>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
                <th className="py-1 font-medium">Accuracy</th>
                <th className="py-1 text-right font-medium">Points</th>
                <th className="py-1 text-right font-medium">Next 1% is worth</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {examples.map((acc) => (
                <tr key={acc} className="border-t border-edge/60">
                  <td className="py-1">{(acc * 100).toFixed(0)}%</td>
                  <td className="py-1 text-right">{matchPoints(acc, 0.98, curve).toFixed(2)}</td>
                  <td className="py-1 text-right text-muted">
                    {acc < 1 ? `+${(matchPoints(Math.min(1, acc + 0.01), 0.98, curve) - matchPoints(acc, 0.98, curve)).toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-faint">
            Each player&apos;s accuracy goes through the curve before the team&apos;s points are averaged.
            New matches are scored on {tournament.matchScoring === 'MATCH_POINTS' ? 'match points' : 'average accuracy'} -
            that, and whether every match must use it, is set under Match rules on the tournament page.
          </p>
        </Panel>

        <Panel title="Pulling scores from BeatLeader" subtitle="What counts as the run a map was just played with">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start tolerance (seconds)" hint="How far apart players' starts may be and still count as the same go.">
              <input name="toleranceSeconds" inputMode="numeric" defaultValue={toleranceSeconds} className={`${inputClass} tabular`} />
            </Field>
          </div>
          <p className="mt-3 text-xs text-faint">
            Everyone on a map starts it off the same countdown, so their runs start together - and that is
            what picks them out, however long after the song the button is pressed, and even if someone has
            played the map again since. Only runs since the map was picked (or its replay called) count.
            Anyone not finished yet is shown as waiting; pressing again picks them up.
          </p>
        </Panel>

        <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
          <Button type="submit">Save settings</Button>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="reset" />
            Put everything back to the defaults
          </label>
        </div>
      </form>
    </div>
  );
}
