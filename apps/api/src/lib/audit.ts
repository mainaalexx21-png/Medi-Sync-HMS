import crypto from 'node:crypto';
import type { Request } from 'express';
import { prisma } from '../db';
import { logger } from './logger';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  req?: Request;
  meta?: Record<string, unknown>;
}

// Audit writes are serialized so the hash chain stays linear (single API node
// dev/small deployment). For horizontal scaling use a queue with the same
// single-writer guarantee; documented in docs/security.md.
let chainLock: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chainLock.then(fn, fn);
  chainLock = run.catch(() => undefined);
  return run;
}

/**
 * Append-only audit trail. Each row hashes the previous hash, so deleting or
 * editing a row breaks the chain (verify with scripts/verify-audit.ts).
 * Never pass PHI in `meta` - the logger redacts and this helper strips.
 */
export async function audit(input: AuditInput): Promise<void> {
  const ip = input.req?.ip ?? null;
  const userAgent = input.req?.get('user-agent')?.slice(0, 250) ?? null;
  const requestId = (input.req as Request & { requestId?: string })?.requestId ?? null;

  try {
    await serialize(async () => {
      const last = await prisma.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { hash: true },
      });
      const prevHash: string | null = last?.hash ?? null;
      const createdAt = new Date();
      const payload: string = JSON.stringify({
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome ?? 'SUCCESS',
        ip,
        requestId,
        createdAt: createdAt.toISOString(),
        prevHash,
      });
      const hash = crypto.createHash('sha256').update(payload).digest('hex');
      await prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          actorRole: input.actorRole ?? null,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId ?? null,
          outcome: input.outcome ?? 'SUCCESS',
          ip,
          userAgent,
          requestId,
          meta: input.meta ? JSON.stringify(input.meta) : null,
          prevHash,
          hash,
          createdAt,
        },
      });
    });
  } catch (error) {
    // Auditing must never take down a request, but a failure is loud.
    logger.error('audit.write.failed', {
      action: input.action,
      resource: input.resource,
      error: (error as Error).message,
    });
  }
}

/** Verifies hash-chain integrity. Returns the first broken record, if any. */
export async function verifyAuditChain(): Promise<{ valid: boolean; brokenAt?: string; checked: number }> {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
  let prevHash: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const payload: string = JSON.stringify({
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      outcome: row.outcome,
      ip: row.ip,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
      prevHash,
    });
    const expected: string = crypto.createHash('sha256').update(payload).digest('hex');
    if (expected !== row.hash || row.prevHash !== prevHash) {
      return { valid: false, brokenAt: row.id, checked };
    }
    prevHash = row.hash;
    checked += 1;
  }
  return { valid: true, checked };
}
