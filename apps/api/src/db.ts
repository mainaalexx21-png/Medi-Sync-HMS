import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client. In tests the schema is pushed to a throwaway SQLite
 * file, so the same client works unchanged.
 */
export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
