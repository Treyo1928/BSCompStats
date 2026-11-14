'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addTournamentPerson, addTournamentUser, searchPeopleCandidates } from '@/server/actions';
import { PlayerPicker } from './roster-controls';
import { Button, Field, inputClass } from './ui';

/**
 * Give someone a role in the tournament: search the way rosters do, pick them
 * from the list. Only people who have signed in here can be picked.
 *
 * `everyone` (given to site admins only) is every account not yet in the tournament: the way to add someone who
 * signed in with Discord alone and so has no BeatLeader profile for the search to find.
 */
export function AddPersonForm({
  tournamentId,
  grantsAdmin,
  everyone = [],
}: {
  tournamentId: string;
  grantsAdmin: boolean;
  everyone?: { id: string; label: string }[];
}) {
  const [role, setRole] = useState(grantsAdmin ? 'ORGANIZER' : 'VIEWER');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [busy, start] = useTransition();
  const router = useRouter();
  const roleName = role === 'ORGANIZER' ? 'tournament admin' : 'viewer';
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
      {everyone.length > 0 && (
        <div className="flex basis-full flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1 sm:max-w-xl">
            <Field label="Or any account that has signed in (also those with no BeatLeader profile)">
              <select value={userId} onChange={(e) => { setUserId(e.target.value); setError(''); }} className={inputClass}>
                <option value="">Choose an account</option>
                {everyone.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button
            type="button"
            variant="ghost"
            disabled={!userId || busy}
            onClick={() =>
              start(async () => {
                const result = await addTournamentUser(tournamentId, userId, role);
                if (result.error) setError(result.error);
                else { setUserId(''); router.refresh(); }
              })
            }
          >
            Add as {roleName}
          </Button>
          {error && <p className="basis-full text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
