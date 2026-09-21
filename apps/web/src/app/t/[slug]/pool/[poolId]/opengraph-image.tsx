import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, loadImage, readable } from '@/lib/og';
import { getPoolSummary } from '@/server/summaries';
import SiteImage from '../../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Map pool leaderboard';

type Params = { slug: string; poolId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { slug, poolId } = await params;
  const pool = await getPoolSummary(slug, poolId);
  if (!pool) return SiteImage();

  const maps = pool.maps.slice(0, 8);
  const covers = await Promise.all(maps.map((m) => loadImage(m.cover)));

  return new ImageResponse(
    (
      <OgFrame eyebrow={pool.tournamentName} bandColors={pool.teamColors}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 64, fontWeight: 800, letterSpacing: -2 }}>{pool.name}</div>
          <div style={{ display: 'flex', fontSize: 26, color: OG_COLORS.muted, paddingBottom: 10 }}>{pool.facts}</div>
        </div>

        <div style={{ display: 'flex', marginTop: 20 }}>
          {maps.map((map, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                width: 118,
                height: 118,
                marginRight: 14,
                borderRadius: 16,
                overflow: 'hidden',
                border: `2px solid ${OG_COLORS.edge}`,
                backgroundColor: OG_COLORS.raised,
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 18,
                color: OG_COLORS.muted,
                textAlign: 'center',
                padding: covers[i] ? 0 : 8,
              }}
            >
              {covers[i] ? <img src={covers[i]!} width={118} height={118} style={{ objectFit: 'cover' }} /> : map.name.slice(0, 22)}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26 }}>
          {pool.leaders.length === 0 ? (
            <div style={{ display: 'flex', fontSize: 30, color: OG_COLORS.muted }}>No scores yet - be the first on the board.</div>
          ) : (
            pool.leaders.slice(0, 4).map((leader, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', fontSize: 32, marginBottom: 8 }}>
                <div style={{ display: 'flex', width: 44, color: OG_COLORS.muted }}>{i + 1}</div>
                <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, marginRight: 14, backgroundColor: leader.color }} />
                <div style={{ display: 'flex', flex: 1, fontWeight: 600, color: readable(leader.color) }}>{leader.name}</div>
                <div style={{ display: 'flex', color: OG_COLORS.muted, marginRight: 24, fontSize: 24 }}>
                  {leader.played}/{pool.maps.length} maps
                </div>
                <div style={{ display: 'flex', fontWeight: 700 }}>{(leader.average * 100).toFixed(2)}%</div>
              </div>
            ))
          )}
        </div>
      </OgFrame>
    ),
    size,
  );
}
