'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bscs/db';
import { generateApiKey } from '@bscs/core';
import { signInKey, signInOrigin } from './connect';
import { failBack } from './form-errors';
import { realUser } from './session';

export interface CreatedKey {
  key?: string;
  name?: string;
  error?: string;
}

/**
 * Make an API key for the signed-in user. The whole key is returned this once;
 * only its hash is kept. Keys are made by the real user, never while an admin
 * is viewing as someone: a key would otherwise outlive the view-as.
 */
export async function createApiKey(_prev: CreatedKey, formData: FormData): Promise<CreatedKey> {
  const user = await realUser();
  if (!user) return { error: 'Sign in first.' };
  const name = String(formData.get('name') ?? '').trim().slice(0, 60) || 'Overlay';
  const days = Number(formData.get('expiresInDays') ?? 0);
  const scope = await readScope(formData);
  if ('error' in scope) return { error: scope.error };
  if ((await prisma.apiKey.count({ where: { userId: user.id, revokedAt: null } })) >= 25) {
    return { error: 'You have 25 keys. Revoke one you no longer use first.' };
  }
  const made = generateApiKey();
  await prisma.apiKey.create({
    data: {
      userId: user.id,
      name,
      prefix: made.prefix,
      hash: made.hash,
      tournaments: { create: scope.tournamentIds.map((tournamentId) => ({ tournamentId })) },
      tournamentId: scope.tournamentIds[0] ?? null,
      signInUrl: scope.signInUrl,
      canWrite: formData.get('readOnly') !== 'on',
      expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
    },
  });
  revalidatePath('/account/api-keys');
  return { key: made.key, name };
}

/** What a key form says about where the key works and where it signs people in. */
async function readScope(formData: FormData): Promise<{ tournamentIds: string[]; signInUrl: string | null } | { error: string }> {
  // "all" (every tournament I can act in) wins over any boxes left ticked beside it
  const everywhere = formData.get('everywhere') === 'on';
  const asked = everywhere ? [] : [...new Set(formData.getAll('tournamentIds').map(String).filter(Boolean))].slice(0, 100);
  if (!everywhere && asked.length === 0) return { error: 'Choose at least one tournament, or tick "Every tournament I can act in".' };
  const found = await prisma.tournament.findMany({ where: { id: { in: asked } }, select: { id: true } });
  if (found.length !== asked.length) return { error: 'One of those tournaments no longer exists.' };
  const address = String(formData.get('signInUrl') ?? '').trim();
  const signInUrl = address ? signInOrigin(address) : null;
  if (address && !signInUrl) return { error: 'The sign-in address must be the app\'s address, like https://overlay.example.' };
  return { tournamentIds: asked, signInUrl };
}

/** Change where a key works and where it signs people in. The key itself, and what it may do, stay as they are. */
export async function updateApiKey(formData: FormData): Promise<void> {
  const user = await realUser();
  if (!user) throw new Error('Sign in first.');
  const keyId = String(formData.get('keyId'));
  const key = await prisma.apiKey.findFirst({ where: { id: keyId, userId: user.id, revokedAt: null }, select: { id: true } });
  if (!key) failBack('/account/api-keys', 'No such key.');
  const scope = await readScope(formData);
  if ('error' in scope) failBack('/account/api-keys', scope.error);
  await prisma.$transaction([
    prisma.apiKeyTournament.deleteMany({ where: { keyId } }),
    prisma.apiKey.update({
      where: { id: keyId },
      data: {
        tournaments: { create: scope.tournamentIds.map((tournamentId) => ({ tournamentId })) },
        tournamentId: scope.tournamentIds[0] ?? null,
        signInUrl: scope.signInUrl,
      },
    }),
  ]);
  revalidatePath('/account/api-keys');
}

/** Let someone who asked sign in to a key's app, or (approve off) take that away again. Only the key's user may. */
export async function setKeyPerson(formData: FormData): Promise<void> {
  const user = await realUser();
  if (!user) throw new Error('Sign in first.');
  const keyId = String(formData.get('keyId'));
  const userId = String(formData.get('userId'));
  // The owner in every filter: nobody approves themselves onto someone else's key by guessing ids.
  const where = { keyId, userId, key: { userId: user.id } };
  if (formData.get('approve') === 'on') await prisma.apiKeyPerson.updateMany({ where, data: { approvedAt: new Date() } });
  else await prisma.apiKeyPerson.deleteMany({ where });
  revalidatePath('/account/api-keys');
}

/** Ask a key's user to be let into the key's app. Shown to them on their API keys page. */
export async function askForAccess(formData: FormData): Promise<void> {
  const user = await realUser();
  if (!user) throw new Error('Sign in first.');
  const key = await signInKey(String(formData.get('keyId')));
  if (!key) throw new Error('That sign-in link is no longer valid.');
  if (key.owner.id !== user.id) {
    // At most 50 people waiting on one key: a link passed around cannot fill someone's page without end.
    const waiting = await prisma.apiKeyPerson.count({ where: { keyId: key.id, approvedAt: null } });
    if (waiting < 50) {
      await prisma.apiKeyPerson.upsert({ where: { keyId_userId: { keyId: key.id, userId: user.id } }, create: { keyId: key.id, userId: user.id }, update: {} });
    }
  }
  revalidatePath('/connect/authorize');
}

export async function revokeApiKey(formData: FormData): Promise<void> {
  const user = await realUser();
  if (!user) throw new Error('Sign in first.');
  // updateMany with the owner in the filter: nobody revokes someone else's key by guessing an id.
  await prisma.apiKey.updateMany({
    where: { id: String(formData.get('keyId')), userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revalidatePath('/account/api-keys');
}
