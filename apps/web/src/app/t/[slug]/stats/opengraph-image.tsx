import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, readable } from '@/lib/og';
import { getStatsSummary } from '@/server/summaries';
import SiteImage from '../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Player rankings within each team';

export default async function Image({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await params;
  const stats = await getStatsSummary(slug);
  if (!stats || stats.teams.length === 0) return SiteImage();

  // Two teams get room for their whole roster; more than that, the top of each.
  const teams = stats.teams.slice(0, 6);
  const wide = teams.length <= 2;
  const shown = wide ? 6 : 3;

  return new ImageResponse(
    (
      <OgFrame eyebrow={stats.tournamentName} bandColors={stats.teams.map((team) => team.color)}>
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <div style={{ display: 'flex', fontSize: 56, fontWeight: 800, letterSpacing: -1 }}>Player stats</div>
          <div style={{ display: 'flex', marginLeft: 20, fontSize: 24, color: OG_COLORS.muted }}>
            ranked on the maps both have played
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 20 }}>
          {teams.map((team) => (
            <div
              key={team.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: wide ? 526 : 344,
                marginRight: 18,
                marginBottom: 18,
                padding: '16px 20px',
                borderRadius: 16,
                border: `2px solid ${OG_COLORS.edge}`,
                borderLeft: `8px solid ${team.color}`,
                backgroundColor: OG_COLORS.panel,
              }}
            >
              <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: readable(team.color) }}>{team.name}</div>
              {team.players.slice(0, shown).map((p) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'baseline', marginTop: 8, fontSize: wide ? 26 : 22 }}>
                  <div style={{ display: 'flex', width: 44, fontWeight: 700, color: OG_COLORS.muted }}>
                    {p.rank ? `#${p.rank}` : '—'}
                  </div>
                  <div style={{ display: 'flex', flex: 1, fontWeight: 600 }}>{p.name.slice(0, 18)}</div>
                  {wide && p.style ? (
                    <div style={{ display: 'flex', marginRight: 16, fontSize: 20, color: OG_COLORS.muted }}>{p.style}</div>
                  ) : null}
                  {p.gap != null ? (
                    <div style={{ display: 'flex', fontWeight: 700, color: p.gap >= 0 ? OG_COLORS.win : '#f87171' }}>
                      {`${p.gap >= 0 ? '+' : '−'}${Math.abs(p.gap * 100).toFixed(1)}`}
                    </div>
                  ) : null}
                </div>
              ))}
              {team.players.length > shown ? (
                <div style={{ display: 'flex', marginTop: 8, fontSize: 20, color: OG_COLORS.muted }}>
                  +{team.players.length - shown} more
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </OgFrame>
    ),
    size,
  );
}
