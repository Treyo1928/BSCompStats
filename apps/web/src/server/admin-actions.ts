'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@bscs/db';
import { realUser, VIEW_AS_COOKIE } from './session';

/**
 * Site-admin tooling. Everything here checks the *real* signed-in user, never
 * the viewed-as one - otherwise viewing as an ordinary user would lock the
 * admin out of the button that ends it.
 */

export async function startViewAs(formData: FormData): Promise<void> {
  const admin = await realUser();
  if (admin?.role !== 'ADMIN') throw new Error('Site admins only.');

  const userId = String(formData.get('userId') ?? '');
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });
  if (!target || target.id === admin.id) redirect('/admin/users');

  (await cookies()).set(VIEW_AS_COOKIE, target.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Short-lived on purpose: a forgotten view-as should end by itself.
    maxAge: 60 * 60,
  });

  // Anything done while viewing as someone is attributed to them in the match
  // record, so leave a trace of who was really at the keyboard.
  console.info(`[view-as] ${admin.name ?? admin.id} (${admin.id}) started viewing as ${target.name ?? target.id} (${target.id})`);

  revalidatePath('/', 'layout');
  redirect('/');
}

export async function stopViewAs(): Promise<void> {
  const admin = await realUser();
  (await cookies()).delete(VIEW_AS_COOKIE);
  if (admin) console.info(`[view-as] ${admin.name ?? admin.id} (${admin.id}) stopped viewing as another user`);

  revalidatePath('/', 'layout');
  redirect('/admin/users');
}
