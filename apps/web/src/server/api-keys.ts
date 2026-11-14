import { prisma } from '@bscs/db';
import { apiKeyFromHeaders, hashApiKey } from '@bscs/core';
import type { SiteUser } from './session';

export interface KeyHolder {
  user: SiteUser;
  key: {
    id: string;
    /** The tournaments the key works in; none: every tournament its user can act in. */
    tournamentIds: string[];
    /** The first of them (what a key had before it could have several); null where it has none. */
    tournamentId: string | null;
    canWrite: boolean;
    /** Where people may sign in with this key's help; null: nowhere. */
    signInUrl: string | null;
  };
}

/**
 * The user behind a request's API key, or null when there is no key, it is
 * unknown, revoked or expired, or its owner no longer exists.
 */
export async function keyHolder(request: Request): Promise<KeyHolder | null> {
  const raw = apiKeyFromHeaders(request.headers);
  if (!raw) return null;
  const key = await prisma.apiKey.findUnique({
    where: { hash: hashApiKey(raw) },
    select: {
      id: true,
      tournaments: { select: { tournamentId: true }, orderBy: { tournamentId: 'asc' } },
      signInUrl: true,
      canWrite: true,
      revokedAt: true,
      expiresAt: true,
      lastUsedAt: true,
      user: { select: { id: true, name: true, image: true, role: true } },
    },
  });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;
  // At most one write a minute per key: an overlay polls far more often than that.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return {
    user: { id: key.user.id, name: key.user.name, image: key.user.image, role: key.user.role },
    key: {
      id: key.id,
      tournamentIds: key.tournaments.map((t) => t.tournamentId),
      tournamentId: key.tournaments[0]?.tournamentId ?? null,
      canWrite: key.canWrite,
      signInUrl: key.signInUrl,
    },
  };
}
