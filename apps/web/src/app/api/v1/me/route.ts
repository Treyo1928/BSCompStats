import { apiRoute, json } from '@/server/api';

export const dynamic = 'force-dynamic';

/** Who this key acts as, and what it is limited to. Handy for checking a key works. */
export async function GET(request: Request) {
  return apiRoute(request, {}, async ({ holder }) =>
    json({ user: { id: holder.user.id, name: holder.user.name }, key: holder.key }),
  );
}
