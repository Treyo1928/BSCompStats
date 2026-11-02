'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bscs/db';
import { generateApiKey } from '@bscs/core';
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
  const tournamentId = String(formData.get('tournamentId') ?? '') || null;
  const days = Number(formData.get('expiresInDays') ?? 0);
  if (tournamentId && !(await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { id: true } }))) {
    return { error: 'No such tournament.' };
  }
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
      tournamentId,
      canWrite: formData.get('readOnly') !== 'on',
      expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
    },
  });
  revalidatePath('/account/api-keys');
  return { key: made.key, name };
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
