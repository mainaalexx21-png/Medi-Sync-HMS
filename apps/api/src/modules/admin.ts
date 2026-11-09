import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit, verifyAuditChain } from '../lib/audit';
import { assertPasswordPolicy, hashPassword, randomToken, sha256, timingSafeEqualStr } from '../lib/crypto';
import { ROLES, Role, permissionsForRole } from '../lib/enums';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';
import { notifyUser } from '../services/notifications';

export const adminRouter = Router();
adminRouter.use(requireAuth);

const roleEnum = z.enum(ROLES);

// ---------------------------------------------------------------------------
// User & role administration
// ---------------------------------------------------------------------------

adminRouter.get(
  '/users',
  requirePermission('user.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query);
    const where: any = {};
    if (req.query.role) where.role = String(req.query.role);
    if (req.query.status) where.status = String(req.query.status);
    const search = String(req.query.search ?? '').trim();
    if (search) where.email = { contains: search };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        select: {
          id: true, email: true, role: true, status: true, mfaEnabled: true,
          lastLoginAt: true, createdAt: true, lockedUntil: true, mustChangePassword: true,
          staff: { select: { firstName: true, lastName: true, jobTitle: true, employeeNo: true, departmentId: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

adminRouter.post(
  '/users',
  requirePermission('user.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        email: z.string().email().max(200),
        role: roleEnum,
        firstName: z.string().trim().min(1).max(80).optional(),
        lastName: z.string().trim().min(1).max(80).optional(),
        jobTitle: z.string().max(120).optional(),
        departmentId: z.string().optional(),
        licenseNo: z.string().max(60).optional(),
        phone: z.string().max(20).optional(),
      }),
      req.body,
    );
    const email = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict('An account with this email already exists');

    // IT admins may only create non-clinical accounts; HR can create staff.
    if (actor.role === 'IT_ADMIN' && ['DOCTOR', 'NURSE', 'PHARMACIST', 'LAB_TECH'].includes(body.role)) {
      throw forbidden('IT administrators cannot create clinical accounts');
    }
    if (body.role === 'IT_ADMIN' && actor.role !== 'IT_ADMIN') {
      throw forbidden('Only IT administrators can create IT administrator accounts');
    }

    const tempPassword = `Ms-${randomToken(9)}!4`;
    assertPasswordPolicy(tempPassword, email);
    const isStaff = !['PATIENT', 'GUARDIAN'].includes(body.role);
    if (isStaff && (!body.firstName || !body.lastName)) {
      throw badRequest('First and last name are required for staff accounts');
    }

    const employeeNo = isStaff ? `EMP-${Date.now().toString(36).toUpperCase()}` : null;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(tempPassword),
        role: body.role,
        mustChangePassword: true,
        ...(isStaff
          ? {
              staff: {
                create: {
                  employeeNo: employeeNo!,
                  firstName: body.firstName!,
                  lastName: body.lastName!,
                  jobTitle: body.jobTitle ?? body.role.replace('_', ' ').toLowerCase(),
                  licenseNo: body.licenseNo ?? null,
                  phone: body.phone ?? null,
                  departmentId: body.departmentId ?? null,
                },
              },
            }
          : {}),
      },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'user.create', resource: 'user',
      resourceId: user.id, req, meta: { role: body.role },
    });
    // The temporary password is returned once, over the authenticated channel.
    res.status(201).json({ user: { id: user.id, email: user.email, role: user.role }, tempPassword });
  }),
);

adminRouter.patch(
  '/users/:id',
  requirePermission('user.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        status: z.enum(['ACTIVE', 'LOCKED', 'DISABLED']).optional(),
        role: roleEnum.optional(),
      }),
      req.body,
    );
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('User not found');
    if (user.id === actor.id && body.role && body.role !== user.role) {
      throw forbidden('You cannot change your own role');
    }
    if (user.role === 'IT_ADMIN' && actor.role !== 'IT_ADMIN') throw forbidden('Only IT can modify IT administrators');
    if (body.role === 'IT_ADMIN' && actor.role !== 'IT_ADMIN') throw forbidden('Only IT can grant IT administrator');

    const updated = await prisma.user.update({ where: { id: user.id }, data: body });
    if (body.status && body.status !== 'ACTIVE') {
      await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'user.update', resource: 'user',
      resourceId: user.id, req, meta: { fields: Object.keys(body), previousRole: user.role },
    });
    res.json({ user: { id: updated.id, email: updated.email, role: updated.role, status: updated.status } });
  }),
);

adminRouter.post(
  '/users/:id/unlock',
  requirePermission('user.write'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('User not found');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', lockedUntil: null, failedLoginCount: 0 },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'user.unlock', resource: 'user',
      resourceId: user.id, req,
    });
    res.json({ ok: true });
  }),
);

/** Admin-assisted MFA reset, always with a reason and always audited. */
adminRouter.post(
  '/users/:id/mfa-reset',
  requirePermission('user.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('User not found');
    if (user.id === actor.id) throw badRequest('Use your own security settings to re-enrol MFA');
    if (user.role === 'IT_ADMIN' && actor.role !== 'IT_ADMIN') throw forbidden('Only IT can reset IT administrator MFA');

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { mfaEnabled: false, mfaSecretEnc: null, mfaEnrolledAt: null },
      }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'auth.mfa.admin_reset', resource: 'user',
      resourceId: user.id, req, meta: { reason },
    });
    await notifyUser({
      userId: user.id,
      title: 'Two-factor authentication reset',
      body: 'An administrator reset your MFA. You will be asked to enrol again at next sign-in.',
      type: 'INFO',
      link: '/security',
    });
    res.json({ ok: true, message: 'MFA reset. The user must enrol again at next sign-in.' });
  }),
);

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

adminRouter.get(
  '/audit',
  requirePermission('audit.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query, 200);
    const where: any = {};
    if (req.query.actorId) where.actorId = String(req.query.actorId);
    if (req.query.resource) where.resource = String(req.query.resource);
    if (req.query.action) where.action = { contains: String(req.query.action) };
    if (req.query.outcome) where.outcome = String(req.query.outcome);
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.createdAt.lte = new Date(String(req.query.to));
    }
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        include: { actor: { select: { email: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

adminRouter.get(
  '/audit/verify',
  requirePermission('audit.read'),
  asyncHandler(async (_req, res) => {
    res.json(await verifyAuditChain());
  }),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

adminRouter.get(
  '/settings',
  requirePermission('settings.write'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
    res.json({ data: rows });
  }),
);

adminRouter.put(
  '/settings/:key',
  requirePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const { value } = parseBody(z.object({ value: z.string().max(2000) }), req.body);
    const setting = await prisma.systemSetting.upsert({
      where: { key: req.params.key },
      update: { value, updatedById: req.actor!.id },
      create: { key: req.params.key, value, updatedById: req.actor!.id },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'settings.update',
      resource: 'system_setting', resourceId: setting.key, req,
    });
    res.json({ setting });
  }),
);

adminRouter.get(
  '/admin/backup-guide',
  requirePermission('settings.write'),
  asyncHandler(async (_req, res) => {
    res.json({
      database: [
        'Production runs PostgreSQL (see docker-compose.yml).',
        'Nightly logical backup: pg_dump --format=custom --no-owner --file=medisync-$(date +%F).dump "$DATABASE_URL"',
        'Restore drill: createdb medisync_restore && pg_restore --clean --no-owner -d medisync_restore medisync-YYYY-MM-DD.dump',
        'Encrypt backups at rest and store off-site; retention 7 daily, 4 weekly, 12 monthly.',
      ],
      documents: [
        'Patient attachments live in UPLOADS_DIR. Back up with restic or rclone to object storage.',
        'Backups contain PHI: restrict access, log every restore, and record it in the audit trail.',
      ],
      auditIntegrity: [
        'GET /api/v1/audit/verify recomputes the SHA-256 hash chain.',
        'Run it after every restore and monthly as part of compliance checks.',
      ],
      continuity: [
        'Keep a read-only replica for reporting so analytics cannot degrade clinical performance.',
        'Test restore quarterly and record recovery time against the RTO.',
      ],
    });
  }),
);

// ---------------------------------------------------------------------------
// External access grants (auditors / vendors)
// ---------------------------------------------------------------------------

adminRouter.get(
  '/external-grants',
  requirePermission('external.manage'),
  asyncHandler(async (_req, res) => {
    const grants = await prisma.externalAccessGrant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, role: true, status: true } } },
    });
    res.json({ data: grants });
  }),
);

adminRouter.post(
  '/external-grants',
  requirePermission('external.manage'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        email: z.string().email(),
        type: z.enum(['AUDITOR', 'VENDOR']),
        scope: z.array(z.string()).default([]),
        reason: z.string().trim().min(10).max(500),
        expiresInHours: z.number().int().min(1).max(720).default(72),
      }),
      req.body,
    );
    const allowedScopes =
      body.type === 'AUDITOR'
        ? ['audit.read', 'deidentified.read', 'report.read']
        : ['patient.read', 'lab.read', 'report.read'];
    const invalid = body.scope.filter((s) => !allowedScopes.includes(s));
    if (invalid.length) throw badRequest(`Scopes not allowed for ${body.type}: ${invalid.join(', ')}`);

    const email = body.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    let tempPassword: string | undefined;
    if (!user) {
      tempPassword = `Ms-${randomToken(9)}!4`;
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(tempPassword),
          role: body.type,
          mustChangePassword: true,
          mfaEnabled: false,
        },
      });
    }
    const grant = await prisma.externalAccessGrant.create({
      data: {
        userId: user.id,
        type: body.type,
        scope: body.scope.join(','),
        reason: body.reason,
        expiresAt: new Date(Date.now() + body.expiresInHours * 3600_000),
        createdById: actor.id,
      },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'external_grant.create', resource: 'external_grant',
      resourceId: grant.id, req, meta: { type: body.type, scope: body.scope, expiresAt: grant.expiresAt.toISOString() },
    });
    res.status(201).json({ grant, ...(tempPassword ? { tempPassword } : {}) });
  }),
);

adminRouter.delete(
  '/external-grants/:id',
  requirePermission('external.manage'),
  asyncHandler(async (req, res) => {
    const grant = await prisma.externalAccessGrant.findUnique({ where: { id: req.params.id } });
    if (!grant) throw notFound('Grant not found');
    await prisma.externalAccessGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date() },
    });
    await prisma.session.updateMany({ where: { userId: grant.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'external_grant.revoke',
      resource: 'external_grant', resourceId: grant.id, req,
    });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Break-glass review queue
// ---------------------------------------------------------------------------

adminRouter.get(
  '/break-glass',
  requirePermission('audit.read'),
  asyncHandler(async (req, res) => {
    const events = await prisma.breakGlassEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, email: true, role: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        reviewedBy: { select: { email: true } },
      },
    });
    res.json({
      data: events,
      pending: events.filter((e) => !e.reviewedAt).length,
    });
  }),
);

adminRouter.post(
  '/break-glass/:id/review',
  requirePermission('audit.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({ outcome: z.enum(['JUSTIFIED', 'ESCALATED']), note: z.string().max(500).optional() }),
      req.body,
    );
    const event = await prisma.breakGlassEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw notFound('Break-glass event not found');
    const updated = await prisma.breakGlassEvent.update({
      where: { id: event.id },
      data: { reviewedAt: new Date(), reviewedById: actor.id },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'break_glass.review', resource: 'break_glass',
      resourceId: event.id, req, meta: { outcome: body.outcome, note: body.note ?? null },
    });
    res.json({ event: updated });
  }),
);

// ---------------------------------------------------------------------------
// Departments (shared admin surface) + device ingestion
// ---------------------------------------------------------------------------

adminRouter.post(
  '/departments',
  requirePermission('settings.write'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(80),
        code: z.string().trim().min(2).max(10),
        type: z.enum(['CLINICAL', 'LAB', 'PHARMACY', 'ADMIN']).default('CLINICAL'),
      }),
      req.body,
    );
    const department = await prisma.department.create({
      data: { ...body, code: body.code.toUpperCase() },
    });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'department.create', resource: 'department', resourceId: department.id, req });
    res.status(201).json({ department });
  }),
);

/**
 * Device ingestion endpoint. Service accounts authenticate with
 * `x-device-key` (hash compared in constant time) and can only post vitals.
 */
adminRouter.post(
  '/device/vitals',
  asyncHandler(async (req, res) => {
    const configured = process.env.DEVICE_API_KEY;
    if (!configured) {
      return res.status(503).json({ error: { code: 'DEVICE_API_DISABLED', message: 'Device ingestion is not configured' } });
    }
    const provided = req.get('x-device-key') ?? '';
    if (!timingSafeEqualStr(sha256(provided), sha256(configured))) {
      await audit({ action: 'device.auth', resource: 'device', outcome: 'DENIED', req });
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid device key' } });
    }
    const body = parseBody(
      z.object({
        mrn: z.string(),
        temperatureC: z.number().min(25).max(45).optional(),
        pulse: z.number().int().min(20).max(250).optional(),
        spo2: z.number().int().min(50).max(100).optional(),
        systolic: z.number().int().min(50).max(300).optional(),
        diastolic: z.number().int().min(30).max(200).optional(),
      }),
      req.body,
    );
    const patient = await prisma.patient.findUnique({ where: { mrn: body.mrn } });
    if (!patient) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown MRN' } });
    const { mrn, ...values } = body;
    const vitals = await prisma.vitals.create({
      data: { ...values, patientId: patient.id, recordedById: 'device' },
    });
    await audit({
      action: 'device.vitals.ingest', resource: 'vitals', resourceId: vitals.id,
      req, meta: { mrn, fields: Object.keys(values) },
    });
    return res.status(201).json({ vitals: { id: vitals.id, recordedAt: vitals.recordedAt } });
  }),
);

void permissionsForRole;
void (null as unknown as Role);
