import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db';
import { env } from '../env';
import { GUARDIAN_SCOPES } from '../lib/enums';
import { audit } from '../lib/audit';
import {
  decryptField, encryptField, hashPassword, hmac, randomToken, sha256,
} from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { nextMrn } from '../lib/ids';
import {
  AccessScope, Actor, assertPatientAccess, deidentify, resolvePatientAccess,
} from '../lib/rbac';
import { requireAnyPermission, requireAuth, requirePermission } from '../middleware/auth';
import { notifyUser } from '../services/notifications';

export const patientsRouter = Router();
patientsRouter.use(requireAuth);

/** Field-level projection: the same row is redacted differently per scope. */
function projectPatient(patient: any, scope: AccessScope | null) {
  const age = (() => {
    const dob = new Date(patient.dateOfBirth);
    const diff = Date.now() - dob.getTime();
    return Math.max(0, Math.floor(diff / (365.25 * 24 * 3600 * 1000)));
  })();

  if (scope === 'DEIDENTIFIED') return deidentify(patient);

  const base = {
    id: patient.id,
    mrn: patient.mrn,
    firstName: patient.firstName,
    lastName: patient.lastName,
    dateOfBirth: patient.dateOfBirth,
    age,
    sex: patient.sex,
    bloodGroup: patient.bloodGroup,
    allergies: patient.allergies,
    chronicConditions: patient.chronicConditions,
  };

  if (scope === 'LIMITED') {
    return {
      ...base,
      phone: patient.phone ? `${patient.phone.slice(0, 4)}****${patient.phone.slice(-2)}` : null,
      email: null,
      address: null,
      nationalId: null,
      emergencyContact: null,
    };
  }

  if (scope === 'BILLING') {
    return {
      id: patient.id, mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth, age, sex: patient.sex,
      phone: patient.phone, email: patient.email,
      allergies: null, chronicConditions: null, bloodGroup: null,
    };
  }

  return {
    ...base,
    phone: patient.phone,
    email: patient.email,
    address: patient.address,
    county: patient.county,
    nationalId: decryptField(patient.nationalIdEnc),
    emergencyContact: patient.emergencyContactName
      ? { name: patient.emergencyContactName, phone: patient.emergencyContactPhone }
      : null,
    deceased: patient.deceased,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  };
}

async function listScope(actor: Actor) {
  switch (actor.role) {
    case 'PATIENT':
      return { userId: actor.id };
    case 'GUARDIAN':
      return { guardianLinks: { some: { guardianUserId: actor.id, status: 'ACTIVE', revokedAt: null } } };
    case 'CLINICAL':
      // Doctors: patients they are treating. Nurses: their ward and the shared
      // department queue. One role, two care relationships.
      if (actor.clinicalRole === 'DOCTOR') {
        return {
          OR: [
            { appointments: { some: { doctorStaffId: actor.staffId ?? '' } } },
            { encounters: { some: { doctorStaffId: actor.staffId ?? '' } } },
            { queueEntries: { some: { doctorStaffId: actor.staffId ?? '', status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } } } },
          ],
        };
      }
      if (actor.clinicalRole === 'NURSE') {
        return {
          OR: [
            { admissions: { some: { status: 'ADMITTED' } } },
            {
              queueEntries: {
                some: {
                  createdAt: { gte: new Date(Date.now() - 24 * 3600_000) },
                  ...(actor.staffDepartmentId ? { departmentId: actor.staffDepartmentId } : {}),
                },
              },
            },
          ],
        };
      }
      return { id: 'none' };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Search / create / read / correct
// ---------------------------------------------------------------------------

patientsRouter.get(
  '/patients',
  requireAnyPermission('patient.read', 'deidentified.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const p = parsePagination(req.query);
    const search = String(req.query.search ?? '').trim();
    const scope = await listScope(actor);
    const where: any = { AND: [scope] };
    if (search) {
      where.AND.push({
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { mrn: { contains: search } },
          { phone: { contains: search } },
        ],
      });
    }
    const [rows, total] = await Promise.all([
      prisma.patient.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: p.skip, take: p.take }),
      prisma.patient.count({ where }),
    ]);
    const deidentified = actor.role === 'AUDITOR';
    const items = rows.map((row) => projectPatient(row, deidentified ? 'DEIDENTIFIED' : 'LIMITED'));
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.search', resource: 'patient',
      req, meta: { resultCount: total, hadQuery: Boolean(search) },
    });
    res.json(paginated(items, total, p));
  }),
);

const patientCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.coerce.date(),
  sex: z.enum(['FEMALE', 'MALE', 'OTHER']),
  phone: z.string().trim().min(7).max(20).optional(),
  email: z.string().trim().email().max(200).optional(),
  address: z.string().max(300).optional(),
  county: z.string().max(80).optional(),
  nationalId: z.string().trim().min(4).max(30).optional(),
  bloodGroup: z.string().max(5).optional(),
  allergies: z.string().max(2000).optional(),
  chronicConditions: z.string().max(2000).optional(),
  emergencyContactName: z.string().max(120).optional(),
  emergencyContactPhone: z.string().max(20).optional(),
  consentToProcessing: z.boolean().default(true),
});

patientsRouter.post(
  '/patients',
  requirePermission('patient.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(patientCreateSchema, req.body);
    if (body.dateOfBirth.getTime() > Date.now()) throw badRequest('Date of birth cannot be in the future');
    if (!body.consentToProcessing) throw badRequest('Patient consent must be recorded before creating the record');

    const nationalIdHash = body.nationalId ? hmac(body.nationalId) : null;
    if (nationalIdHash) {
      const dupe = await prisma.patient.findFirst({ where: { nationalIdHash } });
      if (dupe) throw conflict(`A patient with this national ID already exists (${dupe.mrn})`);
    }

    const mrn = await nextMrn();
    const patient = await prisma.patient.create({
      data: {
        mrn,
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth,
        sex: body.sex,
        phone: body.phone ?? null,
        email: body.email ?? null,
        address: body.address ?? null,
        county: body.county ?? null,
        nationalIdEnc: body.nationalId ? encryptField(body.nationalId) : null,
        nationalIdHash,
        bloodGroup: body.bloodGroup ?? null,
        allergies: body.allergies ?? null,
        chronicConditions: body.chronicConditions ?? null,
        emergencyContactName: body.emergencyContactName ?? null,
        emergencyContactPhone: body.emergencyContactPhone ?? null,
        createdById: actor.id,
      },
    });
    await prisma.patientVersion.create({
      data: {
        patientId: patient.id, version: 1, editedById: actor.id,
        reason: 'Initial registration',
        snapshot: JSON.stringify({ mrn, createdBy: actor.role, consent: body.consentToProcessing }),
      },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.create', resource: 'patient',
      resourceId: patient.id, req, meta: { mrn, consent: body.consentToProcessing },
    });
    res.status(201).json({ patient: projectPatient(patient, 'BILLING') });
  }),
);

patientsRouter.get(
  '/patients/:id',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const access = await assertPatientAccess(actor, req.params.id, 'DEMOGRAPHICS');
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw notFound('Patient not found');
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.read', resource: 'patient',
      resourceId: patient.id, req, meta: { scope: access.scope, breakGlass: access.viaBreakGlass },
    });
    res.json({ patient: projectPatient(patient, access.scope), access });
  }),
);

patientsRouter.patch(
  '/patients/:id',
  requirePermission('patient.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      patientCreateSchema.partial().extend({ reason: z.string().max(300).optional() }),
      req.body,
    );
    const existing = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Patient not found');

    const data: any = {};
    for (const key of [
      'firstName', 'lastName', 'sex', 'phone', 'email', 'address', 'county', 'bloodGroup',
      'allergies', 'chronicConditions', 'emergencyContactName', 'emergencyContactPhone',
    ] as const) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    if (body.dateOfBirth) data.dateOfBirth = body.dateOfBirth;
    if (body.nationalId) {
      data.nationalIdEnc = encryptField(body.nationalId);
      data.nationalIdHash = hmac(body.nationalId);
    }

    const updated = await prisma.patient.update({ where: { id: existing.id }, data });
    const versionCount = await prisma.patientVersion.count({ where: { patientId: existing.id } });
    await prisma.patientVersion.create({
      data: {
        patientId: existing.id,
        version: versionCount + 1,
        editedById: actor.id,
        reason: body.reason ?? 'Record correction',
        snapshot: JSON.stringify({ changed: Object.keys(data) }),
      },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.update', resource: 'patient',
      resourceId: existing.id, req,
      meta: { fields: Object.keys(data), reason: body.reason ?? null },
    });
    res.json({ patient: projectPatient(updated, 'BILLING') });
  }),
);

patientsRouter.get(
  '/patients/:id/versions',
  asyncHandler(async (req, res) => {
    const access = await assertPatientAccess(req.actor!, req.params.id, 'DEMOGRAPHICS');
    if (!['OWN', 'GUARDIAN', 'CLINICAL'].includes(access.scope ?? '')) {
      throw forbidden('Version history is restricted to clinical and record staff');
    }
    const versions = await prisma.patientVersion.findMany({
      where: { patientId: req.params.id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, reason: true, createdAt: true, editedById: true, snapshot: true },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'patient.versions.read',
      resource: 'patient', resourceId: req.params.id, req,
    });
    res.json({ data: versions });
  }),
);

// ---------------------------------------------------------------------------
// Clinical timeline (used by the doctor workspace and patient portal)
// ---------------------------------------------------------------------------

patientsRouter.get(
  '/patients/:id/summary',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const access = await assertPatientAccess(actor, req.params.id, 'CLINICAL');
    // Guardians use the portal endpoints, which enforce per-scope consent.
    if (access.scope === 'GUARDIAN') throw forbidden('Use the patient portal to view this record');
    const patientId = req.params.id;
    const [patient, encounters, prescriptions, labOrders, invoices, appointments, vitals] =
      await Promise.all([
        prisma.patient.findUnique({ where: { id: patientId } }),
        prisma.encounter.findMany({
          where: { patientId }, orderBy: { startedAt: 'desc' }, take: 10,
          include: { diagnoses: true, doctor: { select: { firstName: true, lastName: true } } },
        }),
        prisma.prescription.findMany({
          where: { patientId }, orderBy: { createdAt: 'desc' }, take: 10,
          include: { items: { include: { drug: { select: { name: true, strength: true, form: true } } } } },
        }),
        prisma.labOrder.findMany({
          where: { patientId }, orderBy: { orderedAt: 'desc' }, take: 10,
          include: { test: { select: { name: true, code: true } }, result: true },
        }),
        prisma.invoice.findMany({
          where: { patientId }, orderBy: { issuedAt: 'desc' }, take: 10,
          include: { items: true },
        }),
        prisma.appointment.findMany({
          where: { patientId }, orderBy: { startAt: 'desc' }, take: 10,
          include: { doctor: { select: { firstName: true, lastName: true } } },
        }),
        prisma.vitals.findMany({ where: { patientId }, orderBy: { recordedAt: 'desc' }, take: 5 }),
      ]);
    if (!patient) throw notFound('Patient not found');

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.summary.read', resource: 'patient',
      resourceId: patientId, req, meta: { scope: access.scope },
    });

    const maySeeClinical = ['CLINICAL', 'OWN'].includes(access.scope ?? '');
    const maySeeBilling = ['CLINICAL', 'OWN', 'BILLING', 'LIMITED'].includes(access.scope ?? '');
    res.json({
      patient: projectPatient(patient, access.scope),
      encounters: maySeeClinical ? encounters : undefined,
      prescriptions: maySeeClinical ? prescriptions : undefined,
      labOrders: maySeeClinical ? labOrders : undefined,
      vitals: maySeeClinical ? vitals : undefined,
      appointments,
      invoices: maySeeBilling ? invoices : undefined,
      access,
    });
  }),
);

// ---------------------------------------------------------------------------
// Break-glass emergency access
// ---------------------------------------------------------------------------

patientsRouter.post(
  '/patients/:id/break-glass',
  requirePermission('breakglass.use'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(15).max(500) }), req.body);
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw notFound('Patient not found');

    const event = await prisma.breakGlassEvent.create({
      data: { userId: actor.id, patientId: patient.id, reason, ip: req.ip ?? null },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'patient.break_glass', resource: 'patient',
      resourceId: patient.id, req, meta: { eventId: event.id, flagged: true },
    });
    // Flag for review: everyone with audit access sees it in the review queue.
    const reviewers = await prisma.user.findMany({
      where: { role: { in: ['SYSTEM_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.all(
      reviewers.map((r) =>
        notifyUser({
          userId: r.id,
          title: 'Break-glass access used',
          body: 'Emergency record access was used and needs review in Administration → Access reviews.',
          type: 'INFO',
          link: '/admin/break-glass',
        }),
      ),
    );
    res.status(201).json({ event, note: 'Access granted for 15 minutes and flagged for review.' });
  }),
);

// ---------------------------------------------------------------------------
// Attachments (lab PDFs, imaging) - stored on disk, never publicly served
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(env.uploadsDir, { recursive: true });
      cb(null, env.uploadsDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Only PDF, PNG or JPEG files are allowed'));
    return cb(null, true);
  },
});

patientsRouter.post(
  '/patients/:id/attachments',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const access = await assertPatientAccess(req.actor!, req.params.id, 'CLINICAL');
    if (access.scope === 'OWN' || access.scope === 'GUARDIAN') {
      throw forbidden('Patients cannot upload clinical attachments directly');
    }
    if (!req.file) throw badRequest('No file uploaded');
    const attachment = await prisma.attachment.create({
      data: {
        patientId: req.params.id,
        encounterId: (req.body.encounterId as string) || null,
        filename: path.basename(req.file.originalname).slice(0, 200),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storedPath: req.file.filename,
        category: (req.body.category as string) || 'OTHER',
        uploadedById: req.actor!.id,
      },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'patient.attachment.upload',
      resource: 'attachment', resourceId: attachment.id, req,
      meta: { patientId: req.params.id, mime: attachment.mimeType },
    });
    res.status(201).json({ attachment: { id: attachment.id, filename: attachment.filename, category: attachment.category } });
  }),
);

patientsRouter.get(
  '/patients/:id/attachments',
  asyncHandler(async (req, res) => {
    const access = await assertPatientAccess(req.actor!, req.params.id, 'CLINICAL');
    const rows = await prisma.attachment.findMany({
      where: { patientId: req.params.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, category: true, createdAt: true },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'patient.attachments.list',
      resource: 'attachment', resourceId: req.params.id, req,
    });
    res.json({ data: rows, access: access.scope });
  }),
);

patientsRouter.get(
  '/attachments/:attachmentId/download',
  asyncHandler(async (req, res) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.attachmentId } });
    if (!attachment) throw notFound('Attachment not found');
    await assertPatientAccess(req.actor!, attachment.patientId, 'CLINICAL');
    const absolute = path.join(env.uploadsDir, path.basename(attachment.storedPath));
    if (!fs.existsSync(absolute)) throw notFound('File is missing from storage');
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'patient.attachment.download',
      resource: 'attachment', resourceId: attachment.id, req, meta: { patientId: attachment.patientId },
    });
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(absolute).pipe(res);
  }),
);

// ---------------------------------------------------------------------------
// Guardian links & consent
// ---------------------------------------------------------------------------

patientsRouter.get(
  '/patients/:id/guardians',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const access = await resolvePatientAccess(actor, req.params.id, 'DEMOGRAPHICS');
    const canManage = actor.permissions.includes('guardian.manage');
    if (!access.allowed && !canManage) throw forbidden('Not allowed');
    if (access.allowed && access.scope === 'LIMITED' && !canManage) throw forbidden('Not allowed');
    const links = await prisma.guardianLink.findMany({
      where: { patientId: req.params.id },
      include: { guardian: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'guardian.list', resource: 'guardian',
      resourceId: req.params.id, req,
    });
    res.json({
      data: links.map((l) => ({
        id: l.id, relationship: l.relationship, status: l.status,
        scopes: l.scopes.split(',').filter(Boolean),
        guardianEmail: l.guardian.email,
        consentedAt: l.consentedAt, revokedAt: l.revokedAt, createdAt: l.createdAt,
      })),
      availableScopes: GUARDIAN_SCOPES,
    });
  }),
);

/** Staff (or the patient) invites a guardian; access stays PENDING until consent. */
patientsRouter.post(
  '/patients/:id/guardians',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        email: z.string().trim().email(),
        relationship: z.string().trim().min(2).max(60),
        scopes: z.array(z.enum(GUARDIAN_SCOPES)).min(1),
      }),
      req.body,
    );
    const access = await resolvePatientAccess(actor, req.params.id, 'DEMOGRAPHICS');
    const isSelf = access.scope === 'OWN';
    if (!isSelf && !actor.permissions.includes('guardian.manage')) {
      throw forbidden('Only the patient or reception staff can invite a guardian');
    }
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) throw notFound('Patient not found');

    const email = body.email.toLowerCase();
    if (email === (await prisma.user.findUnique({ where: { id: patient.userId ?? '' } }))?.email) {
      throw badRequest('A patient cannot be their own guardian');
    }

    let guardian = await prisma.user.findUnique({ where: { email } });
    let inviteToken: string | undefined;
    if (!guardian) {
      const tempPassword = await hashPassword(randomToken(24));
      guardian = await prisma.user.create({
        data: { email, passwordHash: tempPassword, role: 'GUARDIAN', status: 'ACTIVE', mustChangePassword: true },
      });
      const token = randomToken(32);
      await prisma.passwordResetToken.create({
        data: { userId: guardian.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) },
      });
      if (env.devShowResetTokens) inviteToken = token;
    }
    if (guardian.role !== 'GUARDIAN' && guardian.role !== 'PATIENT') {
      throw badRequest('That account belongs to hospital staff and cannot be a guardian');
    }

    const existing = await prisma.guardianLink.findUnique({
      where: { patientId_guardianUserId: { patientId: patient.id, guardianUserId: guardian.id } },
    });
    if (existing && existing.status === 'ACTIVE') throw conflict('This guardian already has access');

    const link = existing
      ? await prisma.guardianLink.update({
          where: { id: existing.id },
          data: { status: 'PENDING', scopes: body.scopes.join(','), relationship: body.relationship, revokedAt: null },
        })
      : await prisma.guardianLink.create({
          data: {
            patientId: patient.id,
            guardianUserId: guardian.id,
            relationship: body.relationship,
            scopes: body.scopes.join(','),
            status: 'PENDING',
            createdById: actor.id,
          },
        });

    await notifyUser({
      userId: guardian.id,
      title: 'Guardian access invitation',
      body: 'You have been invited to view a patient record. Sign in to review and accept the consent request.',
      type: 'INFO',
      link: '/portal/guardians',
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'guardian.invite', resource: 'guardian',
      resourceId: link.id, req, meta: { patientId: patient.id, scopes: body.scopes },
    });
    res.status(201).json({
      link: { id: link.id, status: link.status, scopes: body.scopes },
      ...(inviteToken ? { devInviteToken: inviteToken } : {}),
    });
  }),
);

/** The patient (or staff on their behalf, audited) grants consent. */
patientsRouter.post(
  '/patients/:id/guardians/:linkId/consent',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({ scopes: z.array(z.enum(GUARDIAN_SCOPES)).min(1).optional() }),
      req.body,
    );
    const access = await resolvePatientAccess(actor, req.params.id, 'DEMOGRAPHICS');
    if (access.scope !== 'OWN' && !actor.permissions.includes('guardian.manage')) {
      throw forbidden('Only the patient can grant guardian consent');
    }
    const link = await prisma.guardianLink.findFirst({
      where: { id: req.params.linkId, patientId: req.params.id },
    });
    if (!link) throw notFound('Guardian link not found');
    const scopes = (body.scopes ?? link.scopes.split(',')).join(',');
    const updated = await prisma.guardianLink.update({
      where: { id: link.id },
      data: { status: 'ACTIVE', consentedAt: new Date(), revokedAt: null, scopes },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'guardian.consent_granted', resource: 'guardian',
      resourceId: link.id, req, meta: { patientId: req.params.id, scopes },
    });
    res.json({ link: { id: updated.id, status: updated.status, scopes: updated.scopes.split(',') } });
  }),
);

/** Revocation is immediate: every request re-checks link status server-side. */
patientsRouter.delete(
  '/patients/:id/guardians/:linkId',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const access = await resolvePatientAccess(actor, req.params.id, 'DEMOGRAPHICS');
    if (access.scope !== 'OWN' && !actor.permissions.includes('guardian.manage')) {
      throw forbidden('Only the patient can revoke guardian access');
    }
    const link = await prisma.guardianLink.findFirst({
      where: { id: req.params.linkId, patientId: req.params.id },
    });
    if (!link) throw notFound('Guardian link not found');
    await prisma.guardianLink.update({
      where: { id: link.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'guardian.revoked', resource: 'guardian',
      resourceId: link.id, req, meta: { patientId: req.params.id },
    });
    await notifyUser({
      userId: link.guardianUserId,
      title: 'Guardian access revoked',
      body: 'Access to a patient record has been revoked by the patient.',
      type: 'INFO',
    });
    res.json({ ok: true, revokedAt: new Date() });
  }),
);
