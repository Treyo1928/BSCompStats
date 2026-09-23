import { Button, Empty, Field, Panel, inputClass } from './ui';
import { createMatch } from '@/server/match-actions';

/** Create a match. Lives on both the tournament page and the teams page. */
export function NewMatchForm({
  tournamentId,
  teams,
  pools,
  from,
  scoring,
  ownTeamIds,
}: {
  tournamentId: string;
  teams: Array<{ id: string; name: string }>;
  pools: Array<{ id: string; name: string }>;
  /** Which page to come back to if the form is rejected. */
  from: 'tournament' | 'teams';
  /** The tournament's default scoring, and whether every match must use it. */
  scoring: { mode: string; locked: boolean };
  /** For a captain setting up their own match: the teams they may put down as Team A. Everyone else: absent. */
  ownTeamIds?: string[];
}) {
  const sideA = ownTeamIds ? teams.filter((t) => ownTeamIds.includes(t.id)) : teams;
  const sideB = ownTeamIds ? teams.filter((t) => !ownTeamIds.includes(t.id) || sideA.length > 1) : teams;
  if (teams.length < 2 || pools.length === 0 || sideA.length === 0 || sideB.length === 0) {
    return (
      <Panel title="New match">
        <Empty>A match needs two teams and a map pool. Add those first.</Empty>
      </Panel>
    );
  }

  return (
    <Panel title="New match" subtitle="Two teams and a pool is all it takes">
      <form action={createMatch} className="space-y-3">
        <input type="hidden" name="tournamentId" value={tournamentId} />
        <input type="hidden" name="from" value={from} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={ownTeamIds ? 'Your team' : 'Team A'}>
            <select name="teamAId" className={inputClass} defaultValue={sideA[0]!.id}>
              {sideA.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={ownTeamIds ? 'Against' : 'Team B'}>
            <select name="teamBId" className={inputClass} defaultValue={(sideB.find((t) => t.id !== sideA[0]!.id) ?? sideB[0]!).id}>
              {sideB.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Map pool">
          <select name="poolId" className={inputClass}>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Coin flip winner"
          hint="They take the first step in the pick/ban order."
        >
          <select name="coinFlip" className={inputClass} defaultValue="A">
            <option value="A">Team A</option>
            <option value="B">Team B</option>
          </select>
        </Field>
        {scoring.locked ? (
          <p className="text-xs text-muted">
            Scored on {scoring.mode === 'MATCH_POINTS' ? 'match points' : 'average accuracy'}, as every match in
            this tournament is.
          </p>
        ) : (
          <Field
            label="Scoring"
            hint="Match points curve each player's accuracy before averaging, which evens out a strong player duoing with a newer one."
          >
            <select name="scoring" className={inputClass} defaultValue={scoring.mode}>
              <option value="ACCURACY">Average accuracy</option>
              <option value="MATCH_POINTS">Match points</option>
            </select>
          </Field>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="blindLineups" className="mt-1" />
          <span>
            Hide lineups until both teams are done
            <span className="block text-xs text-faint">
              Each team sees only its own player choices until every map has been set by both sides.
              Left off, lineups appear for everyone as they are saved.
            </span>
          </span>
        </label>
        <Button type="submit">Create match</Button>
      </form>
    </Panel>
  );
}
