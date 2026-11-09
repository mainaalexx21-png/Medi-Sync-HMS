import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { randomToken, hashRefreshToken } from '../lib/crypto';
import { unauthorized } from '../lib/errors';

export const ACCESS_COOKIE = 'ms_at';
export const REFRESH_COOKIE = 'ms_rt';
export const CSRF_COOKIE = 'ms_csrf';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: string;
  typ: 'access';
}

export interface MfaTokenPayload {
  sub: string;
  typ: 'mfa';
}

const secureCookie = env.isProd || env.appOrigin.startsWith('https://');

function baseCookie() {
  return {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function signAccessToken(userId: string, sessionId: string, role: string): string {
  return jwt.sign({ sub: userId, sid: sessionId, role, typ: 'access' }, env.jwtAccessSecret, {
    expiresIn: env.accessTokenTtl,
    issuer: 'medisync',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret, { issuer: 'medisync' });
    if (typeof payload === 'string' || payload.typ !== 'access') throw new Error('bad token');
    return payload as AccessTokenPayload;
  } catch {
    throw unauthorized('Session expired or invalid');
  }
}

/** Short-lived ticket proving password success, required before MFA verify. */
export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'mfa' }, env.jwtAccessSecret, {
    expiresIn: 300,
    issuer: 'medisync',
  });
}

export function verifyMfaToken(token: string): MfaTokenPayload {
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret, { issuer: 'medisync' });
    if (typeof payload === 'string' || payload.typ !== 'mfa') throw new Error('bad token');
    return payload as MfaTokenPayload;
  } catch {
    throw unauthorized('MFA challenge expired, please sign in again');
  }
}

function setCookies(res: Response, accessToken: string, refreshToken: string, csrfToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), maxAge: env.accessTokenTtl * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth',
  });
  // Readable by JS on purpose: double-submit CSRF pattern.
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: secureCookie,
    sameSite: 'lax',
    path: '/',
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
  res.setHeader('Cache-Control', 'no-store');
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, secure: secureCookie, sameSite: 'lax', path: '/' });
}

export async function createSession(userId: string, req: Request, res: Response) {
  const refreshToken = randomToken(48);
  const csrfToken = randomToken(24);
  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 250) ?? null,
      expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
    },
  });
  const accessToken = signAccessToken(userId, session.id, '');
  setCookies(res, accessToken, refreshToken, csrfToken);
  return { session, accessToken };
}

/**
 * Rotating refresh: the presented token is invalidated and replaced. A replayed
 * (already rotated) token revokes the whole family - classic reuse detection.
 */
export async function rotateSession(rawToken: string, req: Request, res: Response) {
  const hash = hashRefreshToken(rawToken);
  const existing = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    include: { user: { select: { id: true, role: true, status: true } } },
  });
  if (!existing) throw unauthorized('Invalid session');
  if (existing.revokedAt) {
    // Reuse of a rotated token: assume theft, kill every session for the user.
    await prisma.session.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Session reuse detected, please sign in again');
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw unauthorized('Session expired, please sign in again');
  }
  if (existing.user.status !== 'ACTIVE') throw unauthorized('Account is not active');

  const newRefresh = randomToken(48);
  const csrfToken = randomToken(24);
  const now = new Date();
  const [session] = await prisma.$transaction([
    prisma.session.create({
      data: {
        userId: existing.userId,
        refreshTokenHash: hashRefreshToken(newRefresh),
        ip: req.ip ?? null,
        userAgent: req.get('user-agent')?.slice(0, 250) ?? null,
        expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
      },
    }),
    prisma.session.update({
      where: { id: existing.id },
      data: { revokedAt: now, replacedByHash: hashRefreshToken(newRefresh) },
    }),
  ]);
  const accessToken = signAccessToken(existing.userId, session.id, existing.user.role);
  setCookies(res, accessToken, newRefresh, csrfToken);
  return { session, accessToken };
}

export async function revokeSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

export function publicUser(user: {
  id: string;
  email: string;
  username: string | null;
  role: string;
  mfaEnabled: boolean;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    mfaEnabled: user.mfaEnabled,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}
