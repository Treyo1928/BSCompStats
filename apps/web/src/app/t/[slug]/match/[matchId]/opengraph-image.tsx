import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, loadImage, readable } from '@/lib/og';
import { getMatchSummary } from '@/server/summaries';
import SiteImage from '../../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Match scoreboard';

type Params = { slug: string; matchId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { slug, matchId } = await params;
  const match = await getMatchSummary(slug, matchId);
  if (!match) return SiteImage();

  const maps = match.maps.slice(0, 7);
  const covers = await Promise.all(maps.map((m) => loadImage(m.cover)));
  const started = match.tally.a + match.tally.b > 0 || match.state === 'COMPLETE';

  const side = (team: typeof match.teamA, won: boolean, align: 'flex-start' | 'flex-end') => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, alignItems: align }}>
      <div style={{ display: 'flex', fontSize: 58, fontWeight: 800, letterSpacing: -1, color: readable(team.color) }}>
        {team.name}
      </div>
      <div style={{ display: 'flex', fontSize: 22, color: OG_COLORS.muted, marginTop: 4, textAlign: align === 'flex-end' ? 'right' : 'left' }}>
        {team.players.slice(0, 5).join(', ')}
      </div>
      {won ? (
        <div style={{ display: 'flex', marginTop: 10, padding: '4px 14px', borderRadius: 999, fontSize: 22, fontWeight: 700, color: '#052e16', backgroundColor: OG_COLORS.win }}>
          WINNER
        </div>
      ) : null}
    </div>
  );

  return new ImageResponse(
    (
      <OgFrame eyebrow={match.tournamentName} bandColors={[match.teamA.color, match.teamB.color]}>
        <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 8 }}>
          {side(match.teamA, match.winnerName === match.teamA.name, 'flex-start')}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 28px' }}>
            <div style={{ display: 'flex', fontSize: started ? 104 : 56, fontWeight: 800, letterSpacing: -2, color: started ? OG_COLORS.ink : OG_COLORS.muted }}>
              {started ? `${match.tally.a} - ${match.tally.b}` : 'vs'}
            </div>
            <div style={{ display: 'flex', fontSize: 22, color: OG_COLORS.muted }}>{started ? 'maps won' : match.poolName}</div>
          </div>
          {side(match.teamB, match.winnerName === match.teamB.name, 'flex-end')}
        </div>

        <div style={{ display: 'flex', flex: 1, alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex' }}>
            {maps.map((map, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  width: 132,
                  height: 132,
                  marginRight: 12,
                  borderRadius: 18,
                  overflow: 'hidden',
                  border: `2px solid ${map.isTiebreaker ? '#fbbf24' : OG_COLORS.edge}`,
                  backgroundColor: OG_COLORS.raised,
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  color: OG_COLORS.muted,
                  textAlign: 'center',
                  padding: covers[i] ? 0 : 6,
                }}
              >
                {covers[i] ? <img src={covers[i]!} width={132} height={132} style={{ objectFit: 'cover' }} /> : map.name.slice(0, 20)}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, color: match.state === 'COMPLETE' ? OG_COLORS.win : OG_COLORS.accent }}>
            {match.state === 'COMPLETE' ? 'Final' : match.state === 'PLAYING' ? 'In play' : 'Pick / ban'}
          </div>
        </div>
      </OgFrame>
    ),
    size,
  );
}
