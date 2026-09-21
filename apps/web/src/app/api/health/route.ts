import { prisma } from '@bscs/db';

export const dynamic = 'force-dynamic';

/** Used by the container healthcheck, so it must be cheap and honest. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, database: 'up' });
  } catch (err) {
    return Response.json(
      { ok: false, database: 'down', error: (err as Error).message },
      { status: 503 },
    );
  }
}
