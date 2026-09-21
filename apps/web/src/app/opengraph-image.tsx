import { ImageResponse } from 'next/og';
import { prisma } from '@bscs/db';
import { OG_COLORS, OG_SIZE, OgFrame, OgStat } from '@/lib/og';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'BSCompStats - Beat Saber tournaments, map pools and live matches';

/** The site's own card. Also what any private or missing page falls back to. */
export default async function Image() {
  const [tournaments, matches] = await Promise.all([
    prisma.tournament.count({ where: { isPublic: true } }),
    prisma.match.count({ where: { tournament: { isPublic: true } } }),
  ]);

  return new ImageResponse(
    (
      <OgFrame>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: 76, fontWeight: 800, letterSpacing: -2 }}>
            Beat Saber tournaments, live
          </div>
          <div style={{ display: 'flex', marginTop: 16, fontSize: 32, color: OG_COLORS.muted }}>
            Map pools, team rosters, pick and ban, lineup advice and win predictions.
          </div>
        </div>
        <div style={{ display: 'flex' }}>
          <OgStat label={tournaments === 1 ? 'tournament' : 'tournaments'} value={String(tournaments)} />
          <OgStat label={matches === 1 ? 'match' : 'matches'} value={String(matches)} />
        </div>
      </OgFrame>
    ),
    size,
  );
}
