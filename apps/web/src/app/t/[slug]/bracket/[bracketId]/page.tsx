import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { BRACKET_FORMAT_NAMES } from '@bscs/core/bracket';
import { Button, FormError, PageHeader, Panel, inputClass, teamInk, teamWash } from '@/components/ui';
import { ConfirmButton } from '@/components/confirm-button';
import { getActorOrAnonymous } from '@/server/session';
import { loadBracket, type BracketSlotView, type BracketTeam, type BracketView } from '@/server/brackets';
import { describeSide, layoutBracket, nameSlots } from '@/lib/bracket-layout';
import { deleteBracket, setBracketPool, setBracketResult, startBracketMatch } from '@/server/bracket-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; bracketId: string }>;
}): Promise<Metadata> {
  const { bracketId } = await params;
  const b = await prisma.bracket.findUnique({
    where: { id: bracketId },
    select: { name: true, tournament: { select: { name: true, isPublic: true } } },
  });
  return b?.tournament.isPublic ? { title: `${b.name} - ${b.tournament.name}` } : {};
}

export default async function BracketPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; bracketId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug, bracketId } = await params;
  const { error } = await searchParams;
  const bracket = await loadBracket(bracketId);
  if (!bracket) notFound();
  const tournament = await prisma.tournament.findUnique({
    where: { id: bracket.tournamentId },
    select: {
      slug: true,
      name: true,
      isPublic: true,
      captainsCreateMatches: true,
      pools: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
    },
  });
  if (!tournament || tournament.slug !== slug) notFound();
  const actor = await getActorOrAnonymous(bracket.tournamentId);
  if (!can(actor, 'VIEW', { isPublic: tournament.isPublic })) notFound();
  const staff = can(actor, 'MANAGE_TOURNAMENT');
  const mayStart = (slot: BracketSlotView) =>
    [slot.teamA?.id, slot.teamB?.id].some(
      (teamId) => teamId && can(actor, 'CREATE_MATCH', { teamId, captainsCreateMatches: tournament.captainsCreateMatches }),
    );

  const champion = bracket.teams.find((t) => t.id === bracket.championId);

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[
          { label: tournament.name, href: `/t/${slug}` },
          { label: 'Brackets', href: `/t/${slug}/brackets` },
        ]}
        title={bracket.name}
        meta={
          <>
            {BRACKET_FORMAT_NAMES[bracket.format]} · {bracket.teams.length} teams ·{' '}
            {bracket.pool ? (
              <Link href={`/t/${slug}/pool/${bracket.pool.id}`} className="underline decoration-faint underline-offset-2 hover:text-ink">
                {bracket.pool.name}
              </Link>
            ) : (
              'no pool set'
            )}
          </>
        }
      />
      <FormError message={error} />

      {champion && (
        <section
          className="rounded-2xl border border-edge px-5 py-4"
          style={{ background: `linear-gradient(90deg, ${teamWash(champion.color)}, transparent 70%)` }}
        >
          <p className="text-[10px] uppercase tracking-[0.2em] text-faint">Winner</p>
          <p className="text-2xl font-bold" style={{ color: teamInk(champion.color, champion.colorSecondary) }}>
            {champion.name}
          </p>
        </section>
      )}

      {bracket.format === 'ROUND_ROBIN' && <StandingsTable bracket={bracket} />}

      {bracket.format === 'ROUND_ROBIN' ? (
        <Panel title="Rounds">
          <div className="space-y-4">
            {[...new Set(bracket.slots.map((s) => s.round))].map((round) => (
              <div key={round}>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-faint">Round {round}</p>
                <div className="flex flex-wrap gap-3">
                  {bracket.slots
                    .filter((s) => s.round === round)
                    .map((slot) => (
                      <SlotCard key={slot.key} slug={slug} bracket={bracket} slot={slot} staff={staff} mayStart={mayStart(slot)} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : (
        <>
          <Panel title={bracket.format === 'DOUBLE_ELIM' ? 'Winners bracket' : 'Bracket'} flush>
            <Tree
              slug={slug}
              bracket={bracket}
              sections={bracket.format === 'DOUBLE_ELIM' ? ['W', 'GF'] : ['W']}
              staff={staff}
              mayStart={mayStart}
            />
          </Panel>
          {bracket.format === 'DOUBLE_ELIM' && (
            <Panel
              title="Losers bracket"
              subtitle="Everyone knocked out of the winners bracket drops in here; lose again and you are out. Its winner meets the winners bracket's in the grand final."
              flush
            >
              <Tree slug={slug} bracket={bracket} sections={['L']} staff={staff} mayStart={mayStart} />
            </Panel>
          )}
        </>
      )}

      {bracket.placings.length > 0 && (
        <Panel title="Final placings">
          <ol className="space-y-1 text-sm">
            {bracket.placings.map((p) => (
              <li key={p.team.id} className="flex items-center gap-3">
                <span className="w-8 text-right tabular text-muted">{p.place}.</span>
                <TeamName team={p.team} />
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {staff && (
        <Panel title="Bracket settings">
          <div className="flex flex-wrap items-end gap-4">
            <form action={setBracketPool} className="flex items-end gap-2">
              <input type="hidden" name="bracketId" value={bracket.id} />
              <label className="flex flex-col gap-1 text-xs text-muted">
                Map pool for new matches
                <select name="poolId" defaultValue={bracket.pool?.id ?? ''} className={inputClass}>
                  <option value="">None</option>
                  {tournament.pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="ghost">
                Set
              </Button>
            </form>
            <form action={deleteBracket}>
              <input type="hidden" name="bracketId" value={bracket.id} />
              <ConfirmButton
                question={`Delete ${bracket.name}?\n\nThe matches played in it are kept as ordinary matches. This cannot be undone.`}
                className="inline-flex h-9 items-center rounded-lg border border-edge px-3 text-sm font-medium text-muted transition hover:border-red-400/50 hover:text-lose"
              >
                Delete bracket
              </ConfirmButton>
            </form>
          </div>
        </Panel>
      )}
    </div>
  );
}

function TeamName({ team }: { team: BracketTeam }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: team.color }} />
      <span className="truncate font-medium" style={{ color: teamInk(team.color, team.colorSecondary) }}>
        {team.name}
      </span>
    </span>
  );
}

/** Card and spacing sizes for the drawing: fixed, so the lines can be worked out. */
const CARD_W = 228;
const CARD_H = 76;
const GAP_X = 52;
const GAP_Y = 18;
const HEAD_H = 28;

function Tree({
  slug,
  bracket,
  sections,
  staff,
  mayStart,
}: {
  slug: string;
  bracket: BracketView;
  sections: Array<'W' | 'L' | 'GF'>;
  staff: boolean;
  mayStart: (slot: BracketSlotView) => boolean;
}) {
  const layout = layoutBracket(bracket.slots, sections);
  const x = (column: number) => column * (CARD_W + GAP_X);
  const y = (row: number) => HEAD_H + row * (CARD_H + GAP_Y);
  const width = layout.columns * (CARD_W + GAP_X) - GAP_X;
  const height = y(layout.rows) - GAP_Y;
  return (
    <div className="overflow-x-auto p-3 sm:p-4">
      <div className="relative" style={{ width, height: height + (staff ? 150 : 0) }}>
        {layout.headings.map((heading, i) => (
          <p
            key={i}
            className="absolute top-0 text-[10px] font-semibold uppercase tracking-widest text-faint"
            style={{ left: x(i), width: CARD_W }}
          >
            {heading}
          </p>
        ))}
        <svg className="pointer-events-none absolute left-0 top-0" width={width} height={height} aria-hidden>
          {layout.lines.map(({ from, to }) => {
            const x1 = x(from.column) + CARD_W;
            const y1 = y(from.row) + CARD_H / 2;
            const x2 = x(to.column);
            const y2 = y(to.row) + CARD_H / 2;
            const mid = x1 + (x2 - x1) / 2;
            const decided = from.slot.state === 'DONE';
            return (
              <path
                key={`${from.slot.key}-${to.slot.key}`}
                d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
                fill="none"
                stroke={decided ? 'var(--color-accent)' : 'var(--color-edge-strong)'}
                strokeWidth={decided ? 2 : 1.5}
              />
            );
          })}
        </svg>
        {layout.placed.map(({ slot, column, row }) => (
          <div key={slot.key} className="absolute" style={{ left: x(column), top: y(row), width: CARD_W }}>
            <SlotCard slug={slug} bracket={bracket} slot={slot} staff={staff} mayStart={mayStart(slot)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SlotCard({
  slug,
  bracket,
  slot,
  staff,
  mayStart,
}: {
  slug: string;
  bracket: BracketView;
  slot: BracketSlotView;
  staff: boolean;
  mayStart: boolean;
}) {
  const byKey = new Map(bracket.slots.map((s) => [s.key, s]));
  const seeds = new Set(bracket.teams.map((t) => t.seed));
  const names = nameSlots(bracket.slots);
  const side = (team: BracketTeam | null, source: BracketSlotView['sources']['a'], score: number | undefined) => {
    const won = team != null && slot.winnerId === team.id;
    const lost = team != null && slot.winnerId != null && !won;
    return (
      <div className={`flex h-7 items-center justify-between gap-2 px-2 text-sm ${lost ? 'opacity-45' : ''}`}>
        {team ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="w-4 shrink-0 text-right text-[10px] tabular text-faint">{team.seed}</span>
            <TeamName team={team} />
          </span>
        ) : (
          <span className="truncate text-xs italic text-faint">{describeSide(source, byKey, seeds, names.slots)}</span>
        )}
        <span className={`shrink-0 tabular ${won ? 'font-bold text-win' : 'text-muted'}`}>{score ?? (won ? '✓' : '')}</span>
      </div>
    );
  };
  const canStart = !slot.match && slot.state === 'READY' && mayStart;
  const canSet = staff && slot.teamA && slot.teamB;

  return (
    <div
      className={`relative w-[228px] rounded-lg border bg-raised ${slot.state === 'READY' && !slot.match ? 'border-accent/60' : 'border-edge'}`}
      style={{ height: CARD_H }}
    >
      <div className="flex h-5 items-center justify-between gap-1 border-b border-edge/70 px-2 text-[10px] text-faint">
        <span className="truncate">{names.slots.get(slot.key) ?? ''}</span>
        <span className="flex shrink-0 items-center gap-2">
          {slot.match && (
            <Link href={`/t/${slug}/match/${slot.match.id}`} className="text-accent hover:underline">
              {slot.match.state === 'COMPLETE' ? 'match →' : 'playing →'}
            </Link>
          )}
          {(canStart || canSet) && (
            <details className="relative">
              <summary className="cursor-pointer list-none text-accent hover:underline">{canStart ? 'start ▾' : 'result ▾'}</summary>
              <div className="absolute right-0 top-4 z-20 w-60 space-y-2 rounded-lg border border-edge bg-panel p-2.5 text-xs text-ink shadow-2xl">
                {canStart && (
                  <form action={startBracketMatch} className="space-y-1.5">
                    <input type="hidden" name="bracketId" value={bracket.id} />
                    <input type="hidden" name="key" value={slot.key} />
                    <select name="coinFlip" aria-label="Coin flip winner" className={`${inputClass} h-8 px-2 text-xs`}>
                      <option value="A">{slot.teamA!.name} won the flip</option>
                      <option value="B">{slot.teamB!.name} won the flip</option>
                    </select>
                    <Button type="submit" className="h-8 w-full">
                      Start match
                    </Button>
                  </form>
                )}
                {canSet && (
                  <form action={setBracketResult} className={`space-y-1.5 ${canStart ? 'border-t border-edge pt-2' : ''}`}>
                    <input type="hidden" name="bracketId" value={bracket.id} />
                    <input type="hidden" name="key" value={slot.key} />
                    <select name="winnerId" defaultValue={slot.winnerId ?? ''} className={`${inputClass} h-8 px-2 text-xs`}>
                      <option value="">No result yet</option>
                      <option value={slot.teamA!.id}>{slot.teamA!.name} went through</option>
                      <option value={slot.teamB!.id}>{slot.teamB!.name} went through</option>
                    </select>
                    <Button type="submit" variant="ghost" className="h-8 w-full">
                      Set result by hand
                    </Button>
                    <p className="text-faint">
                      {slot.match
                        ? 'Ends the match with this result - for a walkover, or one settled elsewhere. Clearing it reopens the match.'
                        : 'For a walkover, or a result settled elsewhere.'}
                    </p>
                  </form>
                )}
              </div>
            </details>
          )}
        </span>
      </div>
      {side(slot.teamA, slot.sources.a, slot.match?.a)}
      <div className="border-t border-edge/50" />
      {side(slot.teamB, slot.sources.b, slot.match?.b)}
    </div>
  );
}

function StandingsTable({ bracket }: { bracket: BracketView }) {
  return (
    <Panel title="Standings" subtitle="Wins, then map difference, then maps won" flush>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-left text-[10px] uppercase tracking-wider text-faint">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Team</th>
              <th className="px-2 py-2 text-right font-medium">Played</th>
              <th className="px-2 py-2 text-right font-medium">W</th>
              <th className="px-2 py-2 text-right font-medium">L</th>
              <th className="px-4 py-2 text-right font-medium">Maps</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {bracket.standings.map((s, i) => (
              <tr key={s.teamId} className="border-b border-edge/60 last:border-0">
                <td className="px-4 py-2 text-muted">{i + 1}</td>
                <td className="px-2 py-2">
                  <TeamName team={s.team} />
                </td>
                <td className="px-2 py-2 text-right text-muted">{s.played}</td>
                <td className="px-2 py-2 text-right font-semibold">{s.wins}</td>
                <td className="px-2 py-2 text-right">{s.losses}</td>
                <td className="px-4 py-2 text-right text-muted">
                  {s.mapsWon}–{s.mapsLost}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
