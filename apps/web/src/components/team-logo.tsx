/**
 * A team's mark. `logo` is as stored on the team: null is the default star,
 * "msu" the MSU Esports shield, anything else the address of an uploaded
 * picture. The two built-in marks take the colour given.
 */
const SHIELD =
  'M-0.5,-0.5 L-0.5,408.5 L232,539 L464.5,408.5 L464.5,-0.5 L422,-0.5 L422,383.5 L232,490 L42,383.5 L42,-0.5 Z M68,-0.5 L68,206.5 L305.5,340.5 L232,381.5 L152,337 L152,288.5 L68,241.5 L68,373.5 L232,465 L396,374 L396,304.5 L152,168.5 L152,135 L232,179 L309,136.5 L309,222.5 L396,271 L396,-0.5 L232,90.5 Z';
const STAR = 'M12,1.5 L15.1,8.6 L22.8,9.3 L17,14.4 L18.7,22 L12,18 L5.3,22 L7,14.4 L1.2,9.3 L8.9,8.6 Z';

export function TeamLogo({ logo, color, size = 20, title }: { logo: string | null | undefined; color?: string; size?: number; title?: string }) {
  if (logo && logo !== 'msu') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logo} alt="" title={title} width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} />
    );
  }
  return (
    <svg
      viewBox={logo === 'msu' ? '-1 -1 466 541' : '0 0 24 24'}
      width={size}
      height={size}
      className="shrink-0"
      style={{ color }}
      role="img"
      aria-label={title ?? (logo === 'msu' ? 'MSU Esports' : 'Team')}
    >
      <path d={logo === 'msu' ? SHIELD : STAR} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
