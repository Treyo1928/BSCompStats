import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/**
 * Next.js dev mode re-evaluates modules on every hot reload, which would open a
 * new pool each time. Stashing the client on globalThis keeps it to one.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
