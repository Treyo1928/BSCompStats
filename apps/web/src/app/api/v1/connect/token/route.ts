import { prisma } from '@bscs/db';
import { ApiError, apiRoute, json } from '@/server/api';
import { peopleOf, redeemCode } from '@/server/connect';

export const dynamic = 'force-dynamic';

/**
 * The app's half of "sign in with BSCompStats": trade the code a visitor came back with for who they are.
 * The key proves which app is asking; a code made for another key, used before, or older than a minute is refused.
 * Whether the person may still sign in is checked again here, at the moment it matters.
 */
export async function POST(request: Request) {
  return apiRoute(request, {}, async ({ holder }) => {
    if (!holder.key.signInUrl) throw new ApiError(400, 'This key has no sign-in address: set one on the API keys page.');
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const userId = typeof body?.code === 'string' ? await redeemCode(body.code, holder.key.id) : null;
    if (!userId) throw new ApiError(400, 'That sign-in code is not valid (it works once, for a minute). Start the sign-in again.');
    if (!(await peopleOf(holder.key.id)).some((p) => p.id === userId)) throw new ApiError(403, 'This person may not sign in with this key.');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, image: true } });
    if (!user) throw new ApiError(400, 'That account no longer exists.');
    return json({ user });
  });
}
