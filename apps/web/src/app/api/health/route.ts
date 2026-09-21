import { prisma } from '@bscs/db';

export const dynamic = 'force-dynamic';

/** Used by the container healthcheck, so it must be cheap and honest. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, database: 'up' });
  } catch (err) {
    // The message stays in the log: Prisma's connection errors name the host,
    // port and database, and this endpoint is open to anyone.
    console.error('[health] database check failed:', (err as Error).message);
    return Response.json({ ok: false, database: 'down' }, { status: 503 });
  }
}
