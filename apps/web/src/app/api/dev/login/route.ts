import { randomBytes } from 'node:crypto';
import { prisma } from '@bscs/db';

export const dynamic = 'force-dynamic';

/**
 * Sign in as any user, for the mock tournament (scripts/mock.sh) only.
 *
 * Real sign-in is Discord / BeatLeader OAuth, which a throwaway local copy
 * doesn't have. This exists only when ALL of these hold, and is a plain 404
 * otherwise:
 *   - DEV_LOGIN=1 in the environment (scripts/mock.sh sets it; nothing else does)
 *   - the app is not a production build (`next dev`)
 *   - the request comes from this machine
 *
 *   GET /api/dev/login              pick a user
 *   GET /api/dev/login?as=<userId>  sign in as them (a normal database session)
 */
function allowed(request: Request) {
  if (process.env.DEV_LOGIN !== '1' || process.env.NODE_ENV === 'production') return false;
  // scripts/mock.sh binds the app to 127.0.0.1, so nothing else can reach it; this is a second check.
  const hostOf = (h: string | null) => (h ?? '').replace(/:\d+$/, '');
  const local = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  return local(hostOf(request.headers.get('host'))) && local(new URL(request.url).hostname);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function GET(request: Request) {
  if (!allowed(request)) return new Response('Not found', { status: 404 });
  const as = new URL(request.url).searchParams.get('as');

  if (!as) {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, name: true, role: true } });
    const rows = users
      .map((u) => `<li><a href="?as=${encodeURIComponent(u.id)}">${esc(u.name ?? u.id)}</a> <small>${u.role}</small></li>`)
      .join('');
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Dev sign-in</title><body style="font:16px system-ui;padding:2rem">` +
        `<h1>Sign in as…</h1><p>Mock tournament only. Real sign-in is Discord / BeatLeader.</p><ul>${rows}</ul>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: as }, select: { id: true } });
  if (!user) return new Response('No such user', { status: 404 });
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 86_400_000);
  await prisma.session.create({ data: { sessionToken, userId: user.id, expires } });
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': `authjs.session-token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`,
    },
  });
}
