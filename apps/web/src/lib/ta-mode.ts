/**
 * Whether a new match runs through TournamentAssistant, from a form: the
 * checkbox's answer where the form showed one (TaModeToggle marks that it
 * did), else null for "use the tournament's default".
 */
export function parseTaMode(formData: FormData): boolean | null {
  if (formData.get('taModeShown') !== '1') return null;
  return formData.get('taMode') === 'on';
}
