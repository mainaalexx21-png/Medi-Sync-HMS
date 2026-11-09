import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { Permission } from '../lib/enums';
import { audit } from '../lib/audit';
import { forbidden, unauthorized } from '../lib/errors';
import { Actor, actorFromUser, hasPermission } from '../lib/rbac';
import { ACCESS_COOKIE, verifyAccessToken } from '../services/session';

function readToken(req: Request): string | null {
  const cookieToken = req.cookies?.[ACCESS_COOKIE];
  if (cookieToken) return cookieToken;
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Resolves the session on every request (not just JWT validity) so that role
 * changes, revocations and the idle timeout take effect immediately.
 */
export async function attachActor(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    const session = await prisma.session.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          select: {
            id: true, email: true, role: true, status: true,
            staff: { select: { id: true, departmentId: true } },
            patient: { select: { id: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt || session.user.status !== 'ACTIVE') {
      return next(unauthorized('Session is no longer valid'));
    }
    if (session.userId !== payload.sub) return next(unauthorized('Session mismatch'));

    const idleMs = env.idleTimeoutMinutes * 60 * 1000;
    if (Date.now() - session.lastUsedAt.getTime() > idleMs) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return next(unauthorized('Session timed out due to inactivity'));
    }

    // Touch at most once a minute to limit writes.
    if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
      await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    }

    let grantScope: string[] | undefined;
    if (session.user.role === 'VENDOR' || session.user.role === 'AUDITOR') {
      const grant = await prisma.externalAccessGrant.findFirst({
        where: { userId: session.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!grant) {
        return next(forbidden('External access grant has expired'));
      }
      grantScope = grant.scope.split(',').map((s) => s.trim()).filter(Boolean);
    }

    req.actor = actorFromUser(session.user, session.id, grantScope);
    req.sessionExpiresAt = session.expiresAt;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor) return next(unauthorized());
  return next();
}

export function requirePermission(...permissions: Permission[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    const missing = permissions.filter((p) => !hasPermission(req.actor as Actor, p));
    if (missing.length) {
      // Awaited so the denial is on disk before the client sees the response.
      await audit({
        actorId: req.actor.id,
        actorRole: req.actor.role,
        action: 'rbac.denied',
        resource: req.path,
        outcome: 'DENIED',
        req,
        meta: { missing },
      });
      return next(forbidden(`Missing permission: ${missing.join(', ')}`));
    }
    return next();
  };
}

/** Any-of semantics, for endpoints shared by several roles. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    if (permissions.some((p) => hasPermission(req.actor as Actor, p))) return next();
    return next(forbidden(`Requires one of: ${permissions.join(', ')}`));
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    if (!roles.includes(req.actor.role)) return next(forbidden('Role not allowed for this resource'));
    return next();
  };
}
