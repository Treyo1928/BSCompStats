import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, OgStat, loadImage, readable } from '@/lib/og';
import { getPlayerStatsSummary } from '@/server/summaries';
import SiteImage from '../../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Player stats';

type Params = { slug: string; playerId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { slug, playerId } = await params;
  const player = await getPlayerStatsSummary(slug, playerId);
  if (!player) return SiteImage();

  const avatar = await loadImage(player.avatar);
  const gap = player.overall.vsTeam.gap;

  return new ImageResponse(
    (
      <OgFrame eyebrow={player.tournamentName} bandColors={[player.team.color]}>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
          <div
            style={{
              display: 'flex',
              width: 148,
              height: 148,
              borderRadius: 999,
              overflow: 'hidden',
              border: `6px solid ${player.team.color}`,
              backgroundColor: OG_COLORS.raised,
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 64,
              fontWeight: 800,
              color: OG_COLORS.muted,
            }}
          >
            {avatar ? <img src={avatar} width={148} height={148} style={{ objectFit: 'cover' }} /> : player.name.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 32, flex: 1 }}>
            <div style={{ display: 'flex', fontSize: 68, fontWeight: 800, letterSpacing: -1.5 }}>{player.name.slice(0, 22)}</div>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
              <div style={{ display: 'flex', fontSize: 32, fontWeight: 700, color: readable(player.team.color) }}>
                {player.team.name}
              </div>
              {player.style ? (
                <div
                  style={{
                    display: 'flex',
                    marginLeft: 20,
                    padding: '4px 16px',
                    borderRadius: 999,
                    fontSize: 24,
                    fontWeight: 600,
                    color: OG_COLORS.ink,
                    backgroundColor: OG_COLORS.raised,
                    border: `2px solid ${OG_COLORS.edge}`,
                  }}
                >
                  {player.style.label}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {player.style ? (
          <div style={{ display: 'flex', marginTop: 24, fontSize: 26, lineHeight: 1.35, color: OG_COLORS.muted }}>
            {player.style.summary.length > 150 ? `${player.style.summary.slice(0, 147)}…` : player.style.summary}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'flex-end' }}>
          {/* Their place on the team for each kind of map, best first. A row of its own: beside the stats it ran off the card. */}
          {player.ranks.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 26 }}>
              <div style={{ display: 'flex', marginRight: 16, fontSize: 22, color: OG_COLORS.muted }}>On the team by kind of map</div>
              {player.ranks.slice(0, 5).map((r) => (
                <div
                  key={r.label}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    marginRight: 10,
                    padding: '6px 16px',
                    borderRadius: 999,
                    border: `2px solid ${OG_COLORS.edge}`,
                    backgroundColor: OG_COLORS.panel,
                    fontSize: 22,
                  }}
                >
                  <div style={{ display: 'flex', fontWeight: 700, marginRight: 8 }}>#{r.rank}</div>
                  <div style={{ display: 'flex', color: OG_COLORS.muted }}>{r.label}</div>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: 'flex' }}>
            <OgStat
              label={`on ${player.team.name}`}
              value={player.overall.teamRank ? `#${player.overall.teamRank} of ${player.overall.teamRanked}` : '—'}
            />
            <OgStat
              label="in the field"
              value={player.overall.fieldRank ? `#${player.overall.fieldRank} of ${player.overall.fieldRanked}` : '—'}
            />
            {player.meanAcc != null ? (
              <OgStat label={`avg · ${player.played}/${player.mapCount} maps`} value={`${(player.meanAcc * 100).toFixed(2)}%`} />
            ) : null}
            {gap != null ? (
              <OgStat label="vs team, same maps" value={`${gap >= 0 ? '+' : '−'}${Math.abs(gap * 100).toFixed(1)}`} />
            ) : null}
          </div>
        </div>
      </OgFrame>
    ),
    size,
  );
}
