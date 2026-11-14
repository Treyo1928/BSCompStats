import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@bscs/db';
import { getPublisher } from '@/lib/redis';

/**
 * Signing in to another app (the stream overlay) with an account here.
 *
 * The app holds an API key whose owner gave it a sign-in address. It sends a visitor to /connect/authorize with the
 * key's id; if that visitor is signed in here and may use the app, they are sent back to the app's address with a
 * code. The app's server trades the code for who it is, proving itself with the key (POST /api/v1/connect/token).
 *
 * What keeps it honest:
 *   - the visitor is only ever sent to the address the key's owner wrote down, so a link made by someone else
 *     cannot carry a code off to another site;
 *   - a code is worth nothing without the key itself, works once, for one key, for a minute;
 *   - the app learns a name and a picture, and nothing it could not already read with its key.
 */

const CODE_TTL_S = 60;
const codeKey = (code: string) => `bscs:connect:${createHash('sha256').update(code).digest('hex')}`;

/** "https://overlay.example/" -> "https://overlay.example": the scheme and host of an app, nothing else. Null if it is not one. */
export function signInOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether `returnTo` is an address inside the app at `origin` (and so may be sent a code). */
export function returnsTo(origin: string, returnTo: string): boolean {
  try {
    return new URL(returnTo).origin === origin;
  } catch {
    return false;
  }
}

export interface SignInKey {
  id: string;
  name: string;
  signInUrl: string;
  owner: { id: string; name: string | null };
}

/** The key behind an id, if it is alive and signs people in. */
export async function signInKey(keyId: string): Promise<SignInKey | null> {
  if (!keyId) return null;
  const key = await prisma.apiKey.findUnique({
    where: { id: keyId },
    select: { id: true, name: true, signInUrl: true, revokedAt: true, expiresAt: true, user: { select: { id: true, name: true } } },
  });
  if (!key || !key.signInUrl || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;
  return { id: key.id, name: key.name, signInUrl: key.signInUrl, owner: key.user };
}

/** 'yes': may sign in. 'asked': has asked, not approved yet. 'no': has not asked. */
export async function accessTo(key: SignInKey, userId: string): Promise<'yes' | 'asked' | 'no'> {
  if (key.owner.id === userId) return 'yes';
  const row = await prisma.apiKeyPerson.findUnique({ where: { keyId_userId: { keyId: key.id, userId } }, select: { approvedAt: true } });
  return !row ? 'no' : row.approvedAt ? 'yes' : 'asked';
}

/** Everyone who may sign in with a key: its user, and those they approved. */
export async function peopleOf(keyId: string): Promise<Array<{ id: string; name: string | null; image: string | null }>> {
  const key = await prisma.apiKey.findUnique({
    where: { id: keyId },
    select: {
      user: { select: { id: true, name: true, image: true } },
      people: { where: { approvedAt: { not: null } }, select: { user: { select: { id: true, name: true, image: true } } } },
    },
  });
  if (!key) return [];
  return [key.user, ...key.people.map((p) => p.user).filter((u) => u.id !== key.user.id)];
}

/** A code that names `userId` to the app holding `keyId`, once, for a minute. */
export async function mintCode(keyId: string, userId: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await getPublisher().set(codeKey(code), JSON.stringify({ keyId, userId }), 'EX', CODE_TTL_S);
  return code;
}

/** The user a code names, if it was made for this key and has not been used. It cannot be used again. */
export async function redeemCode(code: string, keyId: string): Promise<string | null> {
  if (!code || code.length > 200) return null;
  const raw = await getPublisher().getdel(codeKey(code));
  if (!raw) return null;
  try {
    const made = JSON.parse(raw) as { keyId?: string; userId?: string };
    return made.keyId === keyId && typeof made.userId === 'string' ? made.userId : null;
  } catch {
    return null;
  }
}
