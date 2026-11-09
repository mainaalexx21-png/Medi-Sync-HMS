import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { asyncHandler, parseBody } from '../lib/http';
import { assertPatientAccess } from '../lib/rbac';
import { requireAuth, requirePermission } from '../middleware/auth';
import { addInvoiceItem, ensureEncounterInvoice } from '../services/invoice';
import { notifyUser } from '../services/notifications';

export const wardsRouter = Router();
wardsRouter.use(requireAuth);

wardsRouter.get(
  '/wards',
  requirePermission('ward.read'),
  asyncHandler(async (_req, res) => {
    const wards = await prisma.ward.findMany({
      orderBy: { name: 'asc' },
      include: {
        beds: {
          orderBy: { label: 'asc' },
          include: {
            admissions: {
              where: { status: 'ADMITTED' },
              include: {
                patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true } },
              },
              take: 1,
            },
          },
        },
      },
    });
    res.json({
      data: wards.map((ward) => ({
        ...ward,
        beds: ward.beds.map((bed) => ({
          id: bed.id, label: bed.label, status: bed.status,
          patient: bed.admissions[0]?.patient ?? null,
          admissionId: bed.admissions[0]?.id ?? null,
        })),
        occupied: ward.beds.filter((b) => b.status === 'OCCUPIED').length,
      })),
    });
  }),
);

wardsRouter.post(
  '/wards',
  requirePermission('ward.write'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(80),
        code: z.string().trim().min(2).max(10),
        floor: z.string().max(20).optional(),
        capacity: z.number().int().min(0).max(500).default(0),
        beds: z.array(z.string().trim().min(1).max(20)).default([]),
      }),
      req.body,
    );
    const ward = await prisma.ward.create({
      data: {
        name: body.name,
        code: body.code.toUpperCase(),
        floor: body.floor ?? null,
        capacity: body.capacity || body.beds.length,
        beds: { create: body.beds.map((label) => ({ label })) },
      },
      include: { beds: true },
    });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'ward.create', resource: 'ward', resourceId: ward.id, req });
    res.status(201).json({ ward });
  }),
);

wardsRouter.post(
  '/wards/:id/beds',
  requirePermission('ward.write'),
  asyncHandler(async (req, res) => {
    const { label } = parseBody(z.object({ label: z.string().trim().min(1).max(20) }), req.body);
    const ward = await prisma.ward.findUnique({ where: { id: req.params.id } });
    if (!ward) throw notFound('Ward not found');
    const bed = await prisma.bed.create({ data: { wardId: ward.id, label } });
    await prisma.ward.update({ where: { id: ward.id }, data: { capacity: { increment: 1 } } });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'bed.create', resource: 'bed', resourceId: bed.id, req });
    res.status(201).json({ bed });
  }),
);

wardsRouter.get(
  '/admissions',
  requirePermission('ward.read'),
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : 'ADMITTED';
    const rows = await prisma.admission.findMany({
      where: { status },
      orderBy: { admittedAt: 'desc' },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        ward: { select: { name: true } },
        bed: { select: { label: true } },
        doctor: { select: { firstName: true, lastName: true } },
      },
    });
    res.json({ data: rows });
  }),
);

wardsRouter.post(
  '/admissions',
  requirePermission('ward.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        patientId: z.string(),
        wardId: z.string(),
        bedId: z.string(),
        reason: z.string().trim().min(3).max(500),
        doctorStaffId: z.string().optional(),
        dailyRate: z.number().min(0).max(1_000_000).default(0),
      }),
      req.body,
    );
    const access = await assertPatientAccess(actor, body.patientId, 'CLINICAL');
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    const existing = await prisma.admission.findFirst({ where: { patientId: body.patientId, status: 'ADMITTED' } });
    if (existing) throw conflict('Patient is already admitted');

    const result = await prisma.$transaction(async (tx) => {
      // Conditional update prevents two receptionists taking the same bed.
      const claimed = await tx.bed.updateMany({
        where: { id: body.bedId, wardId: body.wardId, status: 'AVAILABLE' },
        data: { status: 'OCCUPIED' },
      });
      if (claimed.count === 0) throw conflict('That bed is no longer available');
      return tx.admission.create({
        data: {
          patientId: body.patientId,
          wardId: body.wardId,
          bedId: body.bedId,
          doctorStaffId: body.doctorStaffId ?? null,
          admittedById: actor.staffId ?? null,
          reason: body.reason,
        },
        include: { ward: true, bed: true },
      });
    });

    if (body.dailyRate > 0) {
      const encounter = await prisma.encounter.findFirst({
        where: { patientId: body.patientId, status: 'OPEN' },
        orderBy: { startedAt: 'desc' },
      });
      if (encounter) {
        const invoice = await ensureEncounterInvoice({
          encounterId: encounter.id,
          patientId: body.patientId,
          doctorName: 'Consultation',
          actorId: actor.id,
        });
        await addInvoiceItem({
          invoiceId: invoice.id,
          description: `Bed ${result.bed.label} (${result.ward.name}) - admission`,
          category: 'BED',
          unitPrice: body.dailyRate,
          referenceId: result.id,
        });
      }
    }

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'admission.create', resource: 'admission',
      resourceId: result.id, req, meta: { patientId: body.patientId, wardId: body.wardId, breakGlass: access.viaBreakGlass },
    });
    if (patient.userId) {
      await notifyUser({
        userId: patient.userId,
        title: 'Admitted to hospital',
        body: `You have been admitted to ${result.ward.name}, bed ${result.bed.label}.`,
        type: 'INFO',
      });
    }
    res.status(201).json({ admission: result });
  }),
);

wardsRouter.post(
  '/admissions/:id/discharge',
  requirePermission('ward.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { dischargeSummary } = parseBody(
      z.object({ dischargeSummary: z.string().trim().min(5).max(5000) }),
      req.body,
    );
    const admission = await prisma.admission.findUnique({ where: { id: req.params.id }, include: { patient: true } });
    if (!admission) throw notFound('Admission not found');
    if (admission.status === 'DISCHARGED') throw badRequest('Patient is already discharged');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.admission.update({
        where: { id: admission.id },
        data: { status: 'DISCHARGED', dischargedAt: new Date(), dischargeSummary },
      });
      await tx.bed.update({ where: { id: admission.bedId }, data: { status: 'CLEANING' } });
      return row;
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'admission.discharge', resource: 'admission',
      resourceId: admission.id, req,
    });
    if (admission.patient.userId) {
      await notifyUser({
        userId: admission.patient.userId,
        title: 'Discharged',
        body: 'Your discharge summary is available. Outstanding charges can be settled in the portal.',
        type: 'BILL',
        link: '/portal/bills',
      });
    }
    res.json({ admission: updated });
  }),
);
