import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, OgStat, readable } from '@/lib/og';
import { getTournamentSummary } from '@/server/summaries';
import SiteImage from '../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Tournament overview';

export default async function Image({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await params;
  const t = await getTournamentSummary(slug);
  if (!t) return SiteImage();

  return new ImageResponse(
    (
      <OgFrame bandColors={t.teams.map((team) => team.color)}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: 72, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>
            {t.name}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 24 }}>
            {t.teams.slice(0, 8).map((team) => (
              <div
                key={team.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  marginRight: 14,
                  marginBottom: 12,
                  padding: '8px 18px',
                  borderRadius: 999,
                  border: `2px solid ${OG_COLORS.edge}`,
                  backgroundColor: OG_COLORS.panel,
                  fontSize: 28,
                  color: readable(team.color),
                }}
              >
                <div style={{ display: 'flex', width: 16, height: 16, borderRadius: 8, marginRight: 10, backgroundColor: team.color }} />
                {team.name}
              </div>
            ))}
          </div>
          {t.results[0] ? (
            <div style={{ display: 'flex', marginTop: 8, fontSize: 28, color: OG_COLORS.muted }}>
              Latest: {t.results[0]}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex' }}>
          <OgStat label="teams" value={String(t.teams.length)} />
          <OgStat label="players" value={String(t.players)} />
          <OgStat label="map pools" value={String(t.pools.length)} />
          <OgStat label={t.liveCount ? `matches, ${t.liveCount} live` : 'matches'} value={String(t.liveCount + t.finishedCount)} />
        </div>
      </OgFrame>
    ),
    size,
  );
}
