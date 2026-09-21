import { Button, Empty, Field, Panel, inputClass } from './ui';
import { createMatch } from '@/server/match-actions';

/** Create a match. Lives on both the tournament page and the teams page. */
export function NewMatchForm({
  tournamentId,
  teams,
  pools,
  from,
}: {
  tournamentId: string;
  teams: Array<{ id: string; name: string }>;
  pools: Array<{ id: string; name: string }>;
  /** Which page to come back to if the form is rejected. */
  from: 'tournament' | 'teams';
}) {
  if (teams.length < 2 || pools.length === 0) {
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
          <Field label="Team A">
            <select name="teamAId" className={inputClass} defaultValue={teams[0]!.id}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Team B">
            <select name="teamBId" className={inputClass} defaultValue={teams[1]!.id}>
              {teams.map((t) => (
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
