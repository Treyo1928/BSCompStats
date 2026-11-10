import { prisma } from '@bscs/db';

/**
 * An uploaded picture (a team logo, a player's avatar). Public: the address is
 * an unguessable id, and overlays and Discord embeds have no sign-in to send.
 * A picture never changes once stored - a new upload gets a new id - so
 * browsers may keep it for good.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upload = /^[a-z0-9]{10,40}$/.test(id) ? await prisma.upload.findUnique({ where: { id }, select: { mime: true, bytes: true } }) : null;
  if (!upload) return new Response('Not found', { status: 404 });
  return new Response(Buffer.from(upload.bytes), {
    headers: {
      'content-type': upload.mime,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // An SVG opened by itself is a document: nothing in it may run or load.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    },
  });
}
