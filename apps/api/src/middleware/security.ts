import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../env';
import { forbidden, tooMany } from '../lib/errors';
import { CSRF_COOKIE } from '../services/session';

/** Request correlation id, echoed in responses and audit rows. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const id = incoming && incoming.length < 80 ? incoming : crypto.randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

/**
 * Same-origin enforcement for mutations. Browsers always send Origin on
 * cross-origin writes; an absent Origin means a non-browser client (tests,
 * mobile app) which CSRF does not protect against anyway.
 */
export function sameOriginGuard(req: Request, _res: Response, next: NextFunction) {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!mutating) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  if (env.corsOrigins.includes(origin) || origin === env.appOrigin) return next();
  return next(forbidden('Request origin is not allowed'));
}

/** Double-submit CSRF token for authenticated browsers. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!mutating) return next();
  // Pre-session endpoints cannot carry a CSRF token yet; the refresh token is
  // itself a SameSite=Lax cookie and the M-Pesa callback is authenticated by
  // its shared secret instead.
  const csrfExempt = [
    '/auth/login',
    '/auth/register',
    '/auth/mfa',
    '/auth/password/forgot',
    '/auth/password/reset',
    '/auth/refresh',
    '/payments/mpesa/callback',
  ];
  if (csrfExempt.some((prefix) => req.path.startsWith(prefix))) return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  if (!cookieToken) {
    // No CSRF cookie: either unauthenticated (handled by requireAuth) or a
    // non-browser client. Reject mutations that carry auth cookies only.
    if (req.cookies?.ms_at || req.cookies?.ms_rt) {
      return next(forbidden('Missing CSRF token'));
    }
    return next();
  }
  const headerToken = req.get('x-csrf-token');
  if (!headerToken) return next(forbidden('Missing CSRF token'));
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(headerToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(forbidden('Invalid CSRF token'));
  }
  return next();
}

export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isTest ? 10_000 : 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(tooMany()),
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.isTest ? 10_000 : 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, _res, next) => next(tooMany('Too many sign-in attempts, try again later')),
});

export const mfaLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.isTest ? 10_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(tooMany('Too many verification attempts')),
});

export const resetLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: env.isTest ? 10_000 : 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(tooMany('Too many reset requests')),
});
