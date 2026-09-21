import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, readable } from '@/lib/og';
import { getTournamentSummary } from '@/server/summaries';
import SiteImage from '../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Teams and rosters';

export default async function Image({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await params;
  const t = await getTournamentSummary(slug);
  if (!t) return SiteImage();

  const teams = t.teams.slice(0, 6);
  return new ImageResponse(
    (
      <OgFrame eyebrow={t.name} bandColors={t.teams.map((team) => team.color)}>
        <div style={{ display: 'flex', fontSize: 56, fontWeight: 800, letterSpacing: -1 }}>Teams and rosters</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 20 }}>
          {teams.map((team) => (
            <div
              key={team.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: 344,
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
              <div style={{ display: 'flex', marginTop: 6, fontSize: 22, color: OG_COLORS.muted, lineHeight: 1.3 }}>
                {team.members.slice(0, 6).map((m) => m.player.name).join(', ') || 'No players yet'}
                {team.members.length > 6 ? ` +${team.members.length - 6}` : ''}
              </div>
            </div>
          ))}
        </div>
      </OgFrame>
    ),
    size,
  );
}
