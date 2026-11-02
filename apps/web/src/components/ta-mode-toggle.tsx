/**
 * Run this one match through TournamentAssistant or not. Starts at the
 * tournament's default; an unticked box is an answer too, so the form says it
 * showed one (see parseTaMode).
 */
export function TaModeToggle({ defaultOn, compact = false }: { defaultOn: boolean; compact?: boolean }) {
  return (
    <label className={`flex items-start gap-2 ${compact ? '' : 'text-sm'}`}>
      <input type="hidden" name="taModeShown" value="1" />
      <input type="checkbox" name="taMode" defaultChecked={defaultOn} className={compact ? 'mt-0.5' : 'mt-1'} />
      <span>
        Run through TournamentAssistant
        <span className="block text-xs text-faint">
          Organisers pick, ban and start each map in TA for everyone at once; scores come from TA, not BeatLeader.
        </span>
      </span>
    </label>
  );
}
