import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { addMinutes } from '../lib/ids';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { assertPatientAccess, resolvePatientAccess } from '../lib/rbac';
import { requireAuth, requirePermission } from '../middleware/auth';
import { addInvoiceItem, ensureEncounterInvoice } from '../services/invoice';
import { notifyUser } from '../services/notifications';

export const clinicalRouter = Router();
clinicalRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Doctor workspace
// ---------------------------------------------------------------------------

clinicalRouter.get(
  '/doctor/today',
  requirePermission('encounter.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    if (!actor.staffId) throw badRequest('No staff profile linked to this account');
    if (actor.clinicalRole !== 'DOCTOR') throw forbidden('The doctor workspace is for doctors');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 3600_000);

    const [appointments, queue, openEncounters] = await Promise.all([
      prisma.appointment.findMany({
        where: { doctorStaffId: actor.staffId, startAt: { gte: start, lt: end } },
        orderBy: { startAt: 'asc' },
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true } },
          queueEntry: { select: { id: true, ticketNo: true, status: true } },
          encounter: { select: { id: true, status: true } },
        },
      }),
      prisma.queueEntry.findMany({
        where: { doctorStaffId: actor.staffId, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
        orderBy: [{ priority: 'desc' }, { checkedInAt: 'asc' }],
        include: { patient: { select: { id: true, mrn: true, firstName: true, lastName: true } } },
      }),
      prisma.encounter.findMany({
        where: { doctorStaffId: actor.staffId, status: 'OPEN' },
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: { patient: { select: { id: true, mrn: true, firstName: true, lastName: true } } },
      }),
    ]);
    res.json({ date: start.toISOString(), appointments, queue, openEncounters });
  }),
);

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

clinicalRouter.get(
  '/encounters',
  requirePermission('encounter.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const p = parsePagination(req.query);
    const where: any = {};
    if (req.query.patientId) where.patientId = String(req.query.patientId);
    if (actor.role === 'CLINICAL' && actor.clinicalRole === 'DOCTOR') where.doctorStaffId = actor.staffId ?? 'none';
    if (req.query.from || req.query.to) {
      where.startedAt = {};
      if (req.query.from) where.startedAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.startedAt.lte = new Date(String(req.query.to));
    }
    if (req.query.patientId) await assertPatientAccess(actor, String(req.query.patientId), 'CLINICAL');
    const [rows, total] = await Promise.all([
      prisma.encounter.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: p.skip,
        take: p.take,
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
          doctor: { select: { firstName: true, lastName: true } },
          diagnoses: { select: { id: true, description: true, code: true, type: true } },
        },
      }),
      prisma.encounter.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

clinicalRouter.post(
  '/encounters',
  requirePermission('encounter.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        patientId: z.string(),
        appointmentId: z.string().optional(),
        chiefComplaint: z.string().max(1000).optional(),
        type: z.enum(['OPD', 'IPD', 'EMERGENCY']).default('OPD'),
      }),
      req.body,
    );
    if (!actor.staffId) throw badRequest('Only clinical staff can open an encounter');
    const access = await assertPatientAccess(actor, body.patientId, 'CLINICAL');
    if (access.viaBreakGlass) {
      throw forbidden('Break-glass access is for emergency viewing only. Register the patient to a clinician first.');
    }
    const staff = await prisma.staff.findUnique({ where: { id: actor.staffId } });
    if (!staff) throw badRequest('Staff profile missing');

    const existing = await prisma.encounter.findFirst({
      where: { patientId: body.patientId, doctorStaffId: actor.staffId, status: 'OPEN' },
    });
    if (existing) return res.status(200).json({ encounter: existing, reused: true });

    const encounter = await prisma.encounter.create({
      data: {
        patientId: body.patientId,
        doctorStaffId: actor.staffId,
        appointmentId: body.appointmentId ?? null,
        chiefComplaint: body.chiefComplaint ?? null,
        type: body.type,
        breakGlass: access.viaBreakGlass,
      },
    });

    if (body.appointmentId) {
      await prisma.appointment.updateMany({
        where: { id: body.appointmentId, status: { in: ['BOOKED', 'CHECKED_IN'] } },
        data: { status: 'IN_CONSULTATION' },
      });
    }
    await prisma.queueEntry.updateMany({
      where: { patientId: body.patientId, status: { in: ['WAITING', 'CALLED'] }, doctorStaffId: actor.staffId },
      data: { status: 'IN_CONSULTATION', startedAt: new Date() },
    });

    const invoice = await ensureEncounterInvoice({
      encounterId: encounter.id,
      patientId: body.patientId,
      doctorName: `Dr ${staff.firstName} ${staff.lastName}`,
      actorId: actor.id,
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'encounter.create', resource: 'encounter',
      resourceId: encounter.id, req, meta: { patientId: body.patientId, invoiceId: invoice.id },
    });
    res.status(201).json({ encounter, invoice });
  }),
);

async function loadEncounter(req: any) {
  const encounter = await prisma.encounter.findUnique({
    where: { id: req.params.id },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true,
          bloodGroup: true, allergies: true, chronicConditions: true, phone: true,
        },
      },
      doctor: { select: { id: true, firstName: true, lastName: true } },
      vitals: { orderBy: { recordedAt: 'desc' }, take: 5 },
      diagnoses: { orderBy: { createdAt: 'desc' } },
      prescriptions: { include: { items: { include: { drug: true } } }, orderBy: { createdAt: 'desc' } },
      labOrders: { include: { test: true, result: true }, orderBy: { orderedAt: 'desc' } },
      invoices: { include: { items: true, payments: true } },
    },
  });
  if (!encounter) throw notFound('Encounter not found');
  await assertPatientAccess(req.actor, encounter.patientId, 'CLINICAL');
  return encounter;
}

clinicalRouter.get(
  '/encounters/:id',
  requirePermission('encounter.read'),
  asyncHandler(async (req, res) => {
    const encounter = await loadEncounter(req);
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'encounter.read',
      resource: 'encounter', resourceId: encounter.id, req, meta: { patientId: encounter.patientId },
    });
    res.json({ encounter });
  }),
);

clinicalRouter.patch(
  '/encounters/:id',
  requirePermission('encounter.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    if (encounter.status === 'CLOSED') throw badRequest('Encounter is closed and cannot be edited');
    if (actor.clinicalRole === 'DOCTOR' && encounter.doctorStaffId !== actor.staffId) {
      throw forbidden('Only the treating doctor can edit this encounter');
    }
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');
    const body = parseBody(
      z.object({
        chiefComplaint: z.string().max(1000).optional(),
        notes: z.string().max(20000).optional(),
        plan: z.string().max(10000).optional(),
      }),
      req.body,
    );
    const updated = await prisma.encounter.update({ where: { id: encounter.id }, data: body });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'encounter.update', resource: 'encounter',
      resourceId: encounter.id, req, meta: { fields: Object.keys(body) },
    });
    res.json({ encounter: updated });
  }),
);

clinicalRouter.post(
  '/encounters/:id/close',
  requirePermission('encounter.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    if (encounter.status === 'CLOSED') throw badRequest('Encounter is already closed');
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');
    const now = new Date();
    const closed = await prisma.encounter.update({
      where: { id: encounter.id },
      data: { status: 'CLOSED', closedAt: now },
    });
    if (encounter.appointmentId) {
      await prisma.appointment.update({
        where: { id: encounter.appointmentId },
        data: { status: 'COMPLETED' },
      });
    }
    await prisma.queueEntry.updateMany({
      where: { patientId: encounter.patientId, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
      data: { status: 'COMPLETED', completedAt: now },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'encounter.close', resource: 'encounter',
      resourceId: encounter.id, req,
    });
    res.json({ encounter: closed });
  }),
);

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

const vitalsSchema = z.object({
  temperatureC: z.number().min(25).max(45).optional(),
  pulse: z.number().int().min(20).max(250).optional(),
  respRate: z.number().int().min(5).max(80).optional(),
  systolic: z.number().int().min(50).max(300).optional(),
  diastolic: z.number().int().min(30).max(200).optional(),
  spo2: z.number().int().min(50).max(100).optional(),
  weightKg: z.number().min(0.5).max(400).optional(),
  heightCm: z.number().min(20).max(260).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  notes: z.string().max(1000).optional(),
});

clinicalRouter.post(
  '/encounters/:id/vitals',
  requirePermission('vitals.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');
    const body = parseBody(vitalsSchema, req.body);
    const vitals = await prisma.vitals.create({
      data: { ...body, patientId: encounter.patientId, encounterId: encounter.id, recordedById: actor.id },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'vitals.record', resource: 'vitals',
      resourceId: vitals.id, req, meta: { patientId: encounter.patientId },
    });
    res.status(201).json({ vitals });
  }),
);

clinicalRouter.get(
  '/patients/:id/vitals',
  requirePermission('vitals.write'),
  asyncHandler(async (req, res) => {
    await assertPatientAccess(req.actor!, req.params.id, 'CLINICAL');
    const rows = await prisma.vitals.findMany({
      where: { patientId: req.params.id },
      orderBy: { recordedAt: 'desc' },
      take: 50,
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'vitals.read',
      resource: 'vitals', resourceId: req.params.id, req,
    });
    res.json({ data: rows });
  }),
);

clinicalRouter.post(
  '/patients/:id/vitals',
  requirePermission('vitals.write'),
  asyncHandler(async (req, res) => {
    await assertPatientAccess(req.actor!, req.params.id, 'CLINICAL');
    const body = parseBody(vitalsSchema.extend({ encounterId: z.string().optional() }), req.body);
    const vitals = await prisma.vitals.create({
      data: { ...body, patientId: req.params.id, recordedById: req.actor!.id },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'vitals.record',
      resource: 'vitals', resourceId: vitals.id, req, meta: { patientId: req.params.id },
    });
    res.status(201).json({ vitals });
  }),
);

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

clinicalRouter.post(
  '/encounters/:id/diagnoses',
  requirePermission('encounter.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');
    const body = parseBody(
      z.object({
        code: z.string().max(20).optional(),
        description: z.string().trim().min(2).max(300),
        type: z.enum(['PRIMARY', 'SECONDARY']).default('PRIMARY'),
      }),
      req.body,
    );
    const diagnosis = await prisma.diagnosis.create({
      data: { ...body, patientId: encounter.patientId, encounterId: encounter.id, diagnosedById: actor.id },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'diagnosis.create', resource: 'diagnosis',
      resourceId: diagnosis.id, req, meta: { patientId: encounter.patientId },
    });
    res.status(201).json({ diagnosis });
  }),
);

// ---------------------------------------------------------------------------
// E-prescribing
// ---------------------------------------------------------------------------

clinicalRouter.post(
  '/encounters/:id/prescriptions',
  requirePermission('prescription.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    if (!actor.staffId) throw badRequest('Only clinicians can prescribe');
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    if (encounter.status === 'CLOSED') throw badRequest('Cannot prescribe on a closed encounter');
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');

    const body = parseBody(
      z.object({
        notes: z.string().max(1000).optional(),
        items: z
          .array(
            z.object({
              drugId: z.string(),
              dose: z.string().trim().min(1).max(60),
              frequency: z.string().trim().min(1).max(60),
              durationDays: z.number().int().min(1).max(180).default(1),
              quantity: z.number().int().min(1).max(1000),
              instructions: z.string().max(300).optional(),
            }),
          )
          .min(1),
      }),
      req.body,
    );

    const drugs = await prisma.drug.findMany({ where: { id: { in: body.items.map((i) => i.drugId) }, active: true } });
    if (drugs.length !== new Set(body.items.map((i) => i.drugId)).size) {
      throw badRequest('One or more selected medicines are unavailable');
    }

    const prescription = await prisma.prescription.create({
      data: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        doctorStaffId: actor.staffId,
        notes: body.notes ?? null,
        items: {
          create: body.items.map((item) => ({
            drugId: item.drugId,
            dose: item.dose,
            frequency: item.frequency,
            durationDays: item.durationDays,
            quantity: item.quantity,
            instructions: item.instructions ?? null,
          })),
        },
      },
      include: { items: { include: { drug: true } } },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'prescription.create', resource: 'prescription',
      resourceId: prescription.id, req,
      meta: { patientId: encounter.patientId, itemCount: body.items.length },
    });
    res.status(201).json({ prescription });
  }),
);

// ---------------------------------------------------------------------------
// Lab ordering (creates orders + charges the encounter invoice)
// ---------------------------------------------------------------------------

clinicalRouter.post(
  '/encounters/:id/lab-orders',
  requirePermission('lab.order'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    if (!actor.staffId) throw badRequest('Only clinical staff can order labs');
    const encounter = await prisma.encounter.findUnique({ where: { id: req.params.id } });
    if (!encounter) throw notFound('Encounter not found');
    await assertPatientAccess(actor, encounter.patientId, 'CLINICAL');

    const body = parseBody(
      z.object({
        testIds: z.array(z.string()).min(1),
        priority: z.enum(['ROUTINE', 'URGENT']).default('ROUTINE'),
        clinicalNotes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const tests = await prisma.labTest.findMany({ where: { id: { in: body.testIds }, active: true } });
    if (tests.length !== body.testIds.length) throw badRequest('One or more lab tests are unavailable');

    const invoice = await ensureEncounterInvoice({
      encounterId: encounter.id,
      patientId: encounter.patientId,
      doctorName: 'Consultation',
      actorId: actor.id,
    });

    const orders = [];
    for (const test of tests) {
      const order = await prisma.labOrder.create({
        data: {
          patientId: encounter.patientId,
          encounterId: encounter.id,
          orderedById: actor.staffId,
          testId: test.id,
          priority: body.priority,
          clinicalNotes: body.clinicalNotes ?? null,
          sampleBarcode: `LAB-${Date.now().toString(36).toUpperCase()}-${test.code}`,
        },
        include: { test: true },
      });
      if (test.price > 0) {
        await addInvoiceItem({
          invoiceId: invoice.id,
          description: `Lab: ${test.name}`,
          category: 'LAB',
          unitPrice: test.price,
          referenceId: order.id,
        });
      }
      orders.push(order);
    }

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'lab.order.create', resource: 'lab_order',
      resourceId: orders.map((o) => o.id).join(','), req,
      meta: { patientId: encounter.patientId, count: orders.length, priority: body.priority },
    });
    res.status(201).json({ orders, invoiceId: invoice.id });
  }),
);

// Small helper kept for the UI: list a patient's encounters with summary counts.
clinicalRouter.get(
  '/patients/:id/encounters',
  requirePermission('encounter.read'),
  asyncHandler(async (req, res) => {
    await assertPatientAccess(req.actor!, req.params.id, 'CLINICAL');
    const rows = await prisma.encounter.findMany({
      where: { patientId: req.params.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        doctor: { select: { firstName: true, lastName: true } },
        diagnoses: true,
        prescriptions: { include: { items: true } },
      },
    });
    res.json({ data: rows });
  }),
);

void addMinutes;
void resolvePatientAccess;
void notifyUser;
