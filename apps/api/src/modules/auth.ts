import { Router } from 'express';
import QRCode from 'qrcode';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { prisma } from '../db';
import { env } from '../env';
import { audit, verifyAuditChain } from '../lib/audit';
import {
  assertPasswordPolicy,
  decryptField,
  encryptField,
  generateRecoveryCode,
  hashPassword,
  normalizeRecoveryCode,
  randomToken,
  sha256,
  verifyPassword,
} from '../lib/crypto';
import { badRequest, conflict, forbidden, locked, notFound, tooMany, unauthorized } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { logger } from '../lib/logger';
import { Role, permissionsForRole } from '../lib/enums';
import { requireAuth } from '../middleware/auth';
import { loginLimiter, mfaLimiter, resetLimiter } from '../middleware/security';
import { nextMrn } from '../lib/ids';
import {
  clearAuthCookies,
  createSession,
  publicUser,
  revokeSession,
  rotateSession,
  signMfaToken,
  verifyMfaToken,
  REFRESH_COOKIE,
} from '../services/session';
import { notifyUser } from '../services/notifications';

export const authRouter = Router();

authenticator.options = { window: [1, 1] };

const emailOrUsername = z.string().trim().min(3).max(200);

const loginSchema = z.object({
  email: emailOrUsername,
  password: z.string().min(1).max(200),
  portal: z.enum(['staff', 'patient']).optional(),
});

const verifySchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().trim().min(6).max(20),
  channel: z.enum(['TOTP', 'RECOVERY', 'EMAIL']).default('TOTP'),
});

const STAFF_PORTAL_ROLES: Role[] = [
  'DOCTOR', 'NURSE', 'PHARMACIST', 'LAB_TECH', 'RECEPTIONIST', 'BILLING',
  'HR_MANAGER', 'MEDICAL_RECORDS', 'IT_ADMIN', 'AUDITOR', 'VENDOR', 'DEVICE',
];

function portalOf(role: string): 'staff' | 'patient' {
  return ['PATIENT', 'GUARDIAN'].includes(role) ? 'patient' : 'staff';
}

async function finishLogin(userId: string, req: any, res: any) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    include: { staff: true, patient: true },
  });
  const { accessToken } = await createSession(userId, req, res);
  await audit({
    actorId: user.id,
    actorRole: user.role,
    action: 'auth.login',
    resource: 'session',
    resourceId: user.id,
    req,
    meta: { portal: portalOf(user.role), mfa: user.mfaEnabled },
  });
  return res.json({
    mfaRequired: false,
    accessToken,
    user: publicUser(user),
    permissions: permissionsForRole(user.role as Role),
    portal: portalOf(user.role),
    profile: user.staff
      ? { id: user.staff.id, name: `${user.staff.firstName} ${user.staff.lastName}`, jobTitle: user.staff.jobTitle, departmentId: user.staff.departmentId }
      : user.patient
        ? { id: user.patient.id, name: `${user.patient.firstName} ${user.patient.lastName}`, mrn: user.patient.mrn }
        : null,
    mfaSetupRequired: (STAFF_PORTAL_ROLES.includes(user.role as Role)) && !user.mfaEnabled,
  });
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const identifier = body.email.toLowerCase();

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: body.email }] },
    });

    // Uniform failure response - never reveal whether the account exists.
    const invalid = () => unauthorized('Invalid credentials');
    if (!user) {
      await audit({ action: 'auth.login', resource: 'session', outcome: 'FAILURE', req, meta: { reason: 'unknown_user' } });
      throw invalid();
    }
    if (user.status === 'DISABLED') {
      await audit({ actorId: user.id, actorRole: user.role, action: 'auth.login', resource: 'session', outcome: 'DENIED', req, meta: { reason: 'disabled' } });
      throw forbidden('This account has been disabled. Contact hospital administration.');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw locked(`Account temporarily locked after failed attempts. Try again in ${minutes} minute(s).`);
    }
    if (body.portal === 'patient' && portalOf(user.role) !== 'patient') {
      throw forbidden('Use the staff portal to sign in with this account');
    }
    if (body.portal === 'staff' && portalOf(user.role) !== 'staff') {
      throw forbidden('Use the patient portal to sign in with this account');
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const shouldLock = failed >= env.maxFailedLogins;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil: shouldLock ? new Date(Date.now() + env.lockoutMinutes * 60_000) : null,
          status: shouldLock ? 'LOCKED' : user.status,
        },
      });
      await audit({
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.login',
        resource: 'session',
        outcome: 'FAILURE',
        req,
        meta: { reason: 'bad_password', failedCount: failed, locked: shouldLock },
      });
      if (shouldLock) throw locked('Account locked after repeated failed sign-ins. Contact administration.');
      throw invalid();
    }

    if (user.mfaEnabled) {
      await audit({
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.mfa.challenge',
        resource: 'session',
        req,
      });
      return res.json({
        mfaRequired: true,
        mfaToken: signMfaToken(user.id),
        method: user.mfaMethod,
        emailHint: user.email.replace(/^(.).*(@.*)$/, '$1***$2'),
      });
    }

    // A locked-out account that finally authenticates is unlocked here.
    if (user.status === 'LOCKED' && (!user.lockedUntil || user.lockedUntil.getTime() <= Date.now())) {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', lockedUntil: null } });
    }

    return finishLogin(user.id, req, res);
  }),
);

authRouter.post(
  '/mfa/verify',
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(verifySchema, req.body);
    const payload = verifyMfaToken(body.mfaToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status === 'DISABLED') throw unauthorized('Account unavailable');

    let valid = false;
    if (body.channel === 'RECOVERY') {
      const normalized = normalizeRecoveryCode(body.code);
      const codes = await prisma.recoveryCode.findMany({ where: { userId: user.id, usedAt: null } });
      const match = codes.find((c) => c.codeHash === sha256(normalized));
      if (match) {
        await prisma.recoveryCode.update({ where: { id: match.id }, data: { usedAt: new Date() } });
        valid = true;
        await audit({ actorId: user.id, action: 'auth.mfa.recovery_used', resource: 'user', resourceId: user.id, req });
      }
    } else if (body.channel === 'EMAIL') {
      const challenge = await prisma.otpChallenge.findFirst({
        where: { userId: user.id, channel: 'EMAIL', consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (challenge && challenge.attempts < 5) {
        const matches = challenge.codeHash === sha256(`${user.id}:${body.code.trim()}`);
        if (matches) {
          await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
          valid = true;
        } else {
          await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
        }
      }
    } else {
      const secret = decryptField(user.mfaSecretEnc);
      if (!secret) throw badRequest('MFA is not configured for this account');
      valid = authenticator.check(body.code.trim(), secret);
    }

    if (!valid) {
      await audit({ actorId: user.id, action: 'auth.mfa.verify', resource: 'session', outcome: 'FAILURE', req });
      throw unauthorized('Invalid verification code');
    }

    await audit({ actorId: user.id, action: 'auth.mfa.verify', resource: 'session', req, meta: { channel: body.channel } });
    return finishLogin(user.id, req, res);
  }),
);

/** Email/SMS fallback: issues a 6-digit one-time code (hashed at rest). */
authRouter.post(
  '/mfa/otp',
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const { mfaToken, channel } = parseBody(
      z.object({ mfaToken: z.string().min(10), channel: z.enum(['EMAIL', 'SMS']).default('EMAIL') }),
      req.body,
    );
    const payload = verifyMfaToken(mfaToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw unauthorized('Account unavailable');

    const recent = await prisma.otpChallenge.count({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    });
    if (recent >= 5) throw tooMany('Too many codes requested, try again later');

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.otpChallenge.create({
      data: {
        userId: user.id,
        channel,
        codeHash: sha256(`${user.id}:${code}`),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    // Provider is abstracted; console provider prints no PHI and no code.
    logger.info('mfa.otp.issued', { userId: user.id, channel });
    if (!env.isProd) logger.debug('mfa.otp.dev_code', { code });
    return res.json({
      sent: true,
      channel,
      hint: channel === 'EMAIL' ? user.email.replace(/^(.).*(@.*)$/, '$1***$2') : 'phone ending ' + '****',
      ...(env.isProd ? {} : { devCode: code }),
    });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized('No session');
    const { session } = await rotateSession(raw, req, res);
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: { staff: true, patient: true },
    });
    if (!user) throw unauthorized('Account unavailable');
    return res.json({
      user: publicUser(user),
      permissions: permissionsForRole(user.role as Role),
      portal: portalOf(user.role),
      mfaSetupRequired: STAFF_PORTAL_ROLES.includes(user.role as Role) && !user.mfaEnabled,
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.actor) {
      await revokeSession(req.actor.sessionId);
      await audit({ actorId: req.actor.id, actorRole: req.actor.role, action: 'auth.logout', resource: 'session', resourceId: req.actor.sessionId, req });
    }
    clearAuthCookies(res);
    return res.json({ ok: true });
  }),
);

authRouter.get('/csrf', (req, res) => {
  const existing = req.cookies?.ms_csrf;
  const token = existing ?? randomToken(24);
  if (!existing) {
    res.cookie('ms_csrf', token, { httpOnly: false, sameSite: 'lax', secure: env.isProd, path: '/' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken: token });
});

// ---------------------------------------------------------------------------
// Profile, sessions, password
// ---------------------------------------------------------------------------

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const user = await prisma.user.findUnique({
      where: { id: actor.id },
      include: { staff: true, patient: true },
    });
    if (!user) throw unauthorized();
    let guardianLinks: unknown[] = [];
    if (user.role === 'GUARDIAN') {
      guardianLinks = await prisma.guardianLink.findMany({
        where: { guardianUserId: user.id, status: 'ACTIVE' },
        select: {
          id: true, relationship: true, scopes: true,
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true } },
        },
      });
    }
    return res.json({
      user: publicUser(user),
      permissions: actor.permissions,
      portal: portalOf(user.role),
      profile: user.staff
        ? { id: user.staff.id, name: `${user.staff.firstName} ${user.staff.lastName}`, jobTitle: user.staff.jobTitle, departmentId: user.staff.departmentId, employeeNo: user.staff.employeeNo }
        : user.patient
          ? { id: user.patient.id, name: `${user.patient.firstName} ${user.patient.lastName}`, mrn: user.patient.mrn }
          : null,
      guardianLinks,
      mfaSetupRequired: STAFF_PORTAL_ROLES.includes(user.role as Role) && !user.mfaEnabled,
      grantScope: actor.grantScope ?? null,
    });
  }),
);

authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.actor!.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, ip: true, userAgent: true, lastUsedAt: true, createdAt: true, expiresAt: true },
    });
    res.json({ data: sessions.map((s) => ({ ...s, current: s.id === req.actor!.sessionId })) });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await prisma.session.findFirst({
      where: { id: req.params.id, userId: req.actor!.id, revokedAt: null },
    });
    if (!session) throw notFound('Session not found');
    await revokeSession(session.id);
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'auth.session.revoke', resource: 'session', resourceId: session.id, req });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password/change',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }),
      req.body,
    );
    const user = await prisma.user.findUnique({ where: { id: req.actor!.id } });
    if (!user) throw unauthorized();
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await audit({ actorId: user.id, action: 'auth.password.change', resource: 'user', resourceId: user.id, outcome: 'FAILURE', req });
      throw unauthorized('Current password is incorrect');
    }
    assertPasswordPolicy(body.newPassword, user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), mustChangePassword: false },
    });
    // Force re-authentication everywhere else.
    await prisma.session.updateMany({
      where: { userId: user.id, id: { not: req.actor!.sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.password.change', resource: 'user', resourceId: user.id, req });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password/forgot',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const { email } = parseBody(z.object({ email: z.string().min(3) }), req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    let devToken: string | undefined;
    if (user && user.status !== 'DISABLED') {
      const token = randomToken(32);
      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) },
      });
      await audit({ actorId: user.id, actorRole: user.role, action: 'auth.password.reset_requested', resource: 'user', resourceId: user.id, req });
      logger.info('password.reset.requested', { userId: user.id });
      if (env.devShowResetTokens) devToken = token;
    }
    // Always the same response so accounts cannot be enumerated.
    res.json({ ok: true, message: 'If the account exists, reset instructions have been sent.', ...(devToken ? { devToken } : {}) });
  }),
);

authRouter.post(
  '/password/reset',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ token: z.string().min(10), newPassword: z.string().min(8).max(200) }),
      req.body,
    );
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(body.token) },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw badRequest('Reset link is invalid or has expired');
    }
    assertPasswordPolicy(body.newPassword, record.user.email);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await hashPassword(body.newPassword),
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          status: record.user.status === 'LOCKED' ? 'ACTIVE' : record.user.status,
        },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({ actorId: record.userId, actorRole: record.user.role, action: 'auth.password.reset', resource: 'user', resourceId: record.userId, req });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// MFA enrolment
// ---------------------------------------------------------------------------

authRouter.post(
  '/mfa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.actor!.id } });
    if (!user) throw unauthorized();
    if (user.mfaEnabled) throw conflict('MFA is already enabled. Reset it through administration to re-enrol.');
    const secret = authenticator.generateSecret(32);
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecretEnc: encryptField(secret), mfaMethod: 'TOTP' },
    });
    const otpauth = authenticator.keyuri(user.email, 'MEDI SYNC', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.setup_started', resource: 'user', resourceId: user.id, req });
    res.json({ secret, otpauth, qrDataUrl });
  }),
);

authRouter.post(
  '/mfa/enable',
  requireAuth,
  mfaLimiter,
  asyncHandler(async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().min(6).max(8) }), req.body);
    const user = await prisma.user.findUnique({ where: { id: req.actor!.id } });
    if (!user) throw unauthorized();
    const secret = decryptField(user.mfaSecretEnc);
    if (!secret) throw badRequest('Start MFA setup first');
    if (!authenticator.check(code.trim(), secret)) throw badRequest('That code is not valid. Check your authenticator app and try again.');
    const plainCodes = Array.from({ length: 10 }, () => generateRecoveryCode());
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaMethod: 'TOTP' },
      }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      prisma.recoveryCode.createMany({
        data: plainCodes.map((c) => ({ userId: user.id, codeHash: sha256(normalizeRecoveryCode(c)) })),
      }),
    ]);
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.enabled', resource: 'user', resourceId: user.id, req });
    res.json({ ok: true, recoveryCodes: plainCodes });
  }),
);

authRouter.post(
  '/mfa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ password: z.string().min(1), reason: z.string().max(300).optional() }),
      req.body,
    );
    const user = await prisma.user.findUnique({ where: { id: req.actor!.id } });
    if (!user) throw unauthorized();
    if (!(await verifyPassword(body.password, user.passwordHash))) throw unauthorized('Password is incorrect');
    if (user.role !== 'PATIENT') {
      throw forbidden('Staff MFA can only be reset by an administrator (audited)');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecretEnc: null, mfaMethod: 'TOTP' },
    });
    await prisma.recoveryCode.deleteMany({ where: { userId: user.id } });
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.disabled', resource: 'user', resourceId: user.id, req, meta: { reason: body.reason } });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/mfa/recovery-codes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = parseBody(z.object({ password: z.string().min(1) }), req.body);
    const user = await prisma.user.findUnique({ where: { id: req.actor!.id } });
    if (!user || !user.mfaEnabled) throw badRequest('MFA is not enabled');
    if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized('Password is incorrect');
    const plainCodes = Array.from({ length: 10 }, () => generateRecoveryCode());
    await prisma.$transaction([
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      prisma.recoveryCode.createMany({
        data: plainCodes.map((c) => ({ userId: user.id, codeHash: sha256(normalizeRecoveryCode(c)) })),
      }),
    ]);
    await audit({ actorId: user.id, actorRole: user.role, action: 'auth.mfa.recovery_regenerated', resource: 'user', resourceId: user.id, req });
    res.json({ recoveryCodes: plainCodes });
  }),
);

// ---------------------------------------------------------------------------
// Patient self-registration (+ optional guardian sign-up)
// ---------------------------------------------------------------------------

authRouter.post(
  '/register',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        email: z.string().trim().email().max(200),
        password: z.string().min(8).max(200),
        phone: z.string().trim().min(7).max(20),
        dateOfBirth: z.coerce.date(),
        sex: z.enum(['FEMALE', 'MALE', 'OTHER']),
        address: z.string().max(300).optional(),
        county: z.string().max(80).optional(),
        consentToProcessing: z.boolean(),
      }),
      req.body,
    );
    if (!body.consentToProcessing) {
      throw badRequest('Consent to process your health data is required to create an account');
    }
    if (body.dateOfBirth.getTime() > Date.now()) throw badRequest('Date of birth cannot be in the future');

    const email = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict('An account with this email already exists');
    assertPasswordPolicy(body.password, email);

    const mrn = await nextMrn();
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(body.password),
        role: 'PATIENT',
        patient: {
          create: {
            mrn,
            firstName: body.firstName,
            lastName: body.lastName,
            dateOfBirth: body.dateOfBirth,
            sex: body.sex,
            phone: body.phone,
            email,
            address: body.address,
            county: body.county,
          },
        },
      },
      include: { patient: true },
    });

    await prisma.patientVersion.create({
      data: {
        patientId: user.patient!.id,
        version: 1,
        snapshot: JSON.stringify({ source: 'self-registration', mrn }),
        editedById: user.id,
        reason: 'Patient self-registration',
      },
    });
    await audit({
      actorId: user.id,
      actorRole: 'PATIENT',
      action: 'patient.create',
      resource: 'patient',
      resourceId: user.patient!.id,
      req,
      meta: { source: 'self-registration', consent: true },
    });
    await notifyUser({
      userId: user.id,
      title: 'Welcome to MEDI SYNC',
      body: 'Your patient account is ready. Turn on two-factor authentication to protect your records.',
      type: 'INFO',
      link: '/portal/security',
    });
    return finishLogin(user.id, req, res);
  }),
);

// ---------------------------------------------------------------------------
// Dev-only helper + audit chain verification
// ---------------------------------------------------------------------------

if (env.devMfaHelper) {
  authRouter.get(
    '/dev/totp/:email',
    asyncHandler(async (req, res) => {
      const user = await prisma.user.findUnique({ where: { email: req.params.email.toLowerCase() } });
      if (!user?.mfaSecretEnc) throw notFound('No MFA secret for that user');
      const secret = decryptField(user.mfaSecretEnc);
      res.json({ code: authenticator.generate(secret!), note: 'DEV ONLY - disabled when NODE_ENV=production' });
    }),
  );
}

authRouter.get(
  '/audit-integrity',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.actor!.permissions.includes('audit.read')) throw forbidden('Audit access required');
    res.json(await verifyAuditChain());
  }),
);
