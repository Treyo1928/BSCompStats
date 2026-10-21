'use client';

import { useState } from 'react';
import { addTournamentPerson, searchPeopleCandidates } from '@/server/actions';
import { PlayerPicker } from './roster-controls';
import { Field, inputClass } from './ui';

/**
 * Give someone a role in the tournament: search the way rosters do, pick them
 * from the list. Only people who have signed in here can be picked.
 */
export function AddPersonForm({ tournamentId, grantsAdmin }: { tournamentId: string; grantsAdmin: boolean }) {
  const [role, setRole] = useState(grantsAdmin ? 'ORGANIZER' : 'VIEWER');
  return (
    <div className="mt-3 flex flex-wrap items-start gap-3 border-t border-edge pt-3">
      <div className="w-full sm:w-44">
        <Field label="As">
          <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>
            {grantsAdmin && <option value="ORGANIZER">Tournament admin</option>}
            <option value="VIEWER">Viewer</option>
          </select>
        </Field>
      </div>
      <div className="min-w-[12rem] flex-1">
        <PlayerPicker
          title={role === 'ORGANIZER' ? 'Add a tournament admin' : 'Add a viewer'}
          label="Add someone"
          takenLabel="Added"
          search={(query) => searchPeopleCandidates(tournamentId, query)}
          add={(candidate) => addTournamentPerson(tournamentId, candidate.beatLeaderId, role)}
        />
      </div>
    </div>
  );
}
