import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_SIZE, OgFrame, readable } from '@/lib/og';
import { getDraftSummary } from '@/server/summaries';
import SiteImage from '../../../../opengraph-image';

export const dynamic = 'force-dynamic';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = "Captains' draft";

type Params = { slug: string; draftId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { slug, draftId } = await params;
  const draft = await getDraftSummary(slug, draftId);
  if (!draft) return SiteImage();

  const side = (team: typeof draft.teamA, align: 'flex-start' | 'flex-end') => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, alignItems: align }}>
      <div style={{ display: 'flex', fontSize: 52, fontWeight: 800, letterSpacing: -1, color: readable(team.color) }}>
        {team.name.slice(0, 18)}
      </div>
      {team.players.slice(0, 6).map((name, i) => (
        <div
          key={name}
          style={{
            display: 'flex',
            marginTop: 6,
            fontSize: 28,
            fontWeight: i === 0 ? 700 : 500,
            color: i === 0 ? OG_COLORS.ink : OG_COLORS.muted,
          }}
        >
          {/* No star: the renderer's font has no glyph for one. */}
          {i === 0 ? `${name} · captain` : name}
        </div>
      ))}
      {team.players.length > 6 ? (
        <div style={{ display: 'flex', marginTop: 6, fontSize: 22, color: OG_COLORS.muted }}>+{team.players.length - 6} more</div>
      ) : null}
    </div>
  );

  return new ImageResponse(
    (
      <OgFrame eyebrow={draft.tournamentName} bandColors={[draft.teamA.color, draft.teamB.color]}>
        <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 8 }}>
          {side(draft.teamA, 'flex-start')}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 28px' }}>
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, letterSpacing: 4, color: OG_COLORS.muted }}>DRAFT</div>
            <div style={{ display: 'flex', fontSize: 56, fontWeight: 800, color: OG_COLORS.muted }}>vs</div>
          </div>
          {side(draft.teamB, 'flex-end')}
        </div>

        <div style={{ display: 'flex', flex: 1, alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 760 }}>
            {draft.available.length > 0 ? (
              <div style={{ display: 'flex', fontSize: 22, color: OG_COLORS.muted, lineHeight: 1.3 }}>
                Still available: {draft.available.slice(0, 8).join(', ')}
                {draft.available.length > 8 ? ` +${draft.available.length - 8}` : ''}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 28,
              fontWeight: 600,
              color: draft.complete ? OG_COLORS.win : readable(draft.onTheClockColor ?? OG_COLORS.accent),
            }}
          >
            {draft.status}
          </div>
        </div>
      </OgFrame>
    ),
    size,
  );
}
