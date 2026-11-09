import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';
import { resolvePatientAccess } from '../lib/rbac';
import { notifyUser } from '../services/notifications';

export const labRouter = Router();
labRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Test catalog
// ---------------------------------------------------------------------------

labRouter.get(
  '/lab-tests',
  requirePermission('lab.read'),
  asyncHandler(async (_req, res) => {
    const tests = await prisma.labTest.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    res.json({ data: tests });
  }),
);

labRouter.post(
  '/lab-tests',
  requirePermission('lab.result'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        code: z.string().trim().min(2).max(30),
        name: z.string().trim().min(2).max(120),
        price: z.number().min(0).default(0),
        sampleType: z.enum(['BLOOD', 'URINE', 'STOOL', 'SWAB', 'TISSUE', 'OTHER']).default('BLOOD'),
        turnaroundHours: z.number().int().min(1).max(720).default(24),
      }),
      req.body,
    );
    const test = await prisma.labTest.create({ data: { ...body, code: body.code.toUpperCase() } });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'lab_test.create', resource: 'lab_test', resourceId: test.id, req });
    res.status(201).json({ test });
  }),
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

labRouter.get(
  '/lab-orders',
  requirePermission('lab.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query);
    const where: any = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.patientId) where.patientId = String(req.query.patientId);
    if (req.query.priority) where.priority = String(req.query.priority);
    const [rows, total] = await Promise.all([
      prisma.labOrder.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { orderedAt: 'asc' }],
        skip: p.skip,
        take: p.take,
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true } },
          test: true,
          result: true,
          orderedBy: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.labOrder.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

labRouter.get(
  '/lab-orders/:id',
  requirePermission('lab.read'),
  asyncHandler(async (req, res) => {
    const order = await prisma.labOrder.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true, allergies: true } },
        test: true,
        result: true,
        orderedBy: { select: { firstName: true, lastName: true } },
        encounter: { select: { id: true, chiefComplaint: true } },
      },
    });
    if (!order) throw notFound('Lab order not found');
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'lab_order.read',
      resource: 'lab_order', resourceId: order.id, req, meta: { patientId: order.patientId },
    });
    res.json({ order });
  }),
);

labRouter.post(
  '/lab-orders/:id/collect',
  requirePermission('lab.result'),
  asyncHandler(async (req, res) => {
    const order = await prisma.labOrder.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Lab order not found');
    if (order.status !== 'ORDERED') throw badRequest('Sample has already been processed');
    const updated = await prisma.labOrder.update({
      where: { id: order.id },
      data: { status: 'SAMPLE_COLLECTED', sampleBarcode: order.sampleBarcode ?? `LAB-${Date.now().toString(36).toUpperCase()}` },
    });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'lab_order.collect', resource: 'lab_order', resourceId: order.id, req });
    res.json({ order: updated });
  }),
);

labRouter.post(
  '/lab-orders/:id/result',
  requirePermission('lab.result'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        resultValue: z.string().trim().min(1).max(500),
        unit: z.string().max(30).optional(),
        referenceRange: z.string().max(60).optional(),
        flag: z.enum(['NORMAL', 'HIGH', 'LOW', 'CRITICAL']).default('NORMAL'),
        interpretation: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const order = await prisma.labOrder.findUnique({
      where: { id: req.params.id },
      include: { test: true, patient: true, orderedBy: { include: { user: true } } },
    });
    if (!order) throw notFound('Lab order not found');
    if (order.status === 'COMPLETED') throw badRequest('A result has already been entered for this order');

    const [result] = await prisma.$transaction([
      prisma.labResult.create({
        data: { ...body, labOrderId: order.id, enteredById: actor.id, verifiedById: actor.id, verifiedAt: new Date() },
      }),
      prisma.labOrder.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      }),
    ]);

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'lab_result.enter', resource: 'lab_result',
      resourceId: result.id, req, meta: { labOrderId: order.id, patientId: order.patientId, flag: body.flag },
    });

    // Notify the ordering doctor and the patient (no result values in the notification).
    if (order.orderedBy?.user?.id) {
      await notifyUser({
        userId: order.orderedBy.user.id,
        title: `Lab result ready: ${order.test.name}`,
        body: `Result for ${order.patient.firstName} ${order.patient.lastName} (${order.patient.mrn}) is available.`,
        type: 'LAB',
        link: `/lab?orderId=${order.id}`,
      });
    }
    if (order.patient.userId) {
      await notifyUser({
        userId: order.patient.userId,
        title: 'Lab result available',
        body: `${order.test.name} results are now available in your portal.`,
        type: 'LAB',
        link: '/portal/records',
      });
    }

    res.status(201).json({ result });
  }),
);

labRouter.post(
  '/lab-orders/:id/cancel',
  requirePermission('lab.order'),
  asyncHandler(async (req, res) => {
    const order = await prisma.labOrder.findUnique({ where: { id: req.params.id } });
    if (!order) throw notFound('Lab order not found');
    if (order.status === 'COMPLETED') throw badRequest('Completed orders cannot be cancelled');
    const updated = await prisma.labOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'lab_order.cancel', resource: 'lab_order', resourceId: order.id, req });
    res.json({ order: updated });
  }),
);

// ---------------------------------------------------------------------------
// Patient / guardian portal view of results
// ---------------------------------------------------------------------------

labRouter.get(
  '/me/lab-results',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const patientIds: string[] = [];
    if (actor.role === 'PATIENT' && actor.patientId) patientIds.push(actor.patientId);
    if (actor.role === 'GUARDIAN') {
      const links = await prisma.guardianLink.findMany({
        where: { guardianUserId: actor.id, status: 'ACTIVE' },
        select: { patientId: true, scopes: true },
      });
      for (const link of links) {
        if (link.scopes.split(',').includes('labResults')) patientIds.push(link.patientId);
      }
    }
    if (!patientIds.length) return res.json({ data: [] });
    const orders = await prisma.labOrder.findMany({
      where: { patientId: { in: patientIds }, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      include: { test: { select: { name: true, code: true } }, result: true },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'portal.lab_results.read', resource: 'lab_result', req,
      meta: { patientId: patientIds.join(',') },
    });
    res.json({
      data: orders.map((o) => ({
        id: o.id,
        test: o.test.name,
        completedAt: o.completedAt,
        result: o.result
          ? {
              value: o.result.resultValue,
              unit: o.result.unit,
              referenceRange: o.result.referenceRange,
              flag: o.result.flag,
              interpretation: o.result.interpretation,
            }
          : null,
      })),
    });
  }),
);

void resolvePatientAccess;
