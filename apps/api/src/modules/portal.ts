import { Router } from 'express';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';

/**
 * Patient portal aggregates. Every query is scoped to the signed-in patient -
 * or, for guardians, only the patients who granted the relevant consent scope.
 */
export const portalRouter = Router();
portalRouter.use(requireAuth);

async function resolvedPatients(actor: { id: string; role: string; patientId?: string | null }) {
  if (actor.role === 'PATIENT' && actor.patientId) {
    const patient = await prisma.patient.findUnique({ where: { id: actor.patientId } });
    return patient ? [{ patient, scopes: ['appointments', 'prescriptions', 'labResults', 'bills', 'messages', 'demographics'], relationship: 'SELF' }] : [];
  }
  if (actor.role === 'GUARDIAN') {
    const links = await prisma.guardianLink.findMany({
      where: { guardianUserId: actor.id, status: 'ACTIVE', revokedAt: null },
      include: { patient: true },
    });
    return links.map((l) => ({
      patient: l.patient,
      scopes: l.scopes.split(',').map((s) => s.trim()).filter(Boolean),
      relationship: l.relationship,
    }));
  }
  return [];
}

portalRouter.get(
  '/portal/patients',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const rows = await resolvedPatients(req.actor!);
    res.json({
      data: rows.map((r) => ({
        id: r.patient.id,
        mrn: r.patient.mrn,
        firstName: r.patient.firstName,
        lastName: r.patient.lastName,
        dateOfBirth: r.patient.dateOfBirth,
        sex: r.patient.sex,
        relationship: r.relationship,
        scopes: r.scopes,
      })),
    });
  }),
);

portalRouter.get(
  '/portal/summary',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const rows = await resolvedPatients(actor);
    if (!rows.length) return res.json({ patients: [], summary: null });

    const ids = rows.map((r) => r.patient.id);
    const canSee = (scope: string) => rows.some((r) => r.scopes.includes(scope));
    const now = new Date();
    const [nextAppointment, outstanding, pendingLabs, activeScripts, queue] = await Promise.all([
      prisma.appointment.findFirst({
        where: { patientId: { in: ids }, startAt: { gte: now }, status: { in: ['BOOKED', 'CHECKED_IN'] } },
        orderBy: { startAt: 'asc' },
        include: { doctor: { select: { firstName: true, lastName: true } }, department: { select: { name: true } } },
      }),
      prisma.invoice.aggregate({ where: { patientId: { in: ids }, balance: { gt: 0 } }, _sum: { balance: true } }),
      prisma.labOrder.count({ where: { patientId: { in: ids }, status: { not: 'COMPLETED' } } }),
      prisma.prescription.count({ where: { patientId: { in: ids }, status: { in: ['PENDING', 'PARTIAL'] } } }),
      prisma.queueEntry.findFirst({
        where: { patientId: { in: ids }, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
        select: { ticketNo: true, status: true },
      }),
    ]);

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'portal.summary.read', resource: 'patient',
      req, meta: { patientCount: ids.length },
    });

    res.json({
      patients: rows.map((r) => ({ id: r.patient.id, mrn: r.patient.mrn, name: `${r.patient.firstName} ${r.patient.lastName}`, relationship: r.relationship, scopes: r.scopes })),
      summary: {
        nextAppointment: canSee('appointments') ? nextAppointment : null,
        outstandingBalance: canSee('bills') ? outstanding._sum.balance ?? 0 : null,
        currency: 'KES',
        pendingLabs: canSee('labResults') ? pendingLabs : null,
        pendingPrescriptions: canSee('prescriptions') ? activeScripts : null,
        queueTicket: queue,
      },
    });
  }),
);

portalRouter.get(
  '/portal/appointments',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const rows = await resolvedPatients(req.actor!);
    const ids = rows.filter((r) => r.scopes.includes('appointments')).map((r) => r.patient.id);
    if (!ids.length) return res.json({ data: [] });
    const appointments = await prisma.appointment.findMany({
      where: { patientId: { in: ids } },
      orderBy: { startAt: 'desc' },
      take: 50,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        doctor: { select: { firstName: true, lastName: true, jobTitle: true } },
        department: { select: { name: true } },
        queueEntry: { select: { ticketNo: true, status: true } },
      },
    });
    res.json({ data: appointments });
  }),
);

portalRouter.get(
  '/portal/prescriptions',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const rows = await resolvedPatients(req.actor!);
    const ids = rows.filter((r) => r.scopes.includes('prescriptions')).map((r) => r.patient.id);
    if (!ids.length) return res.json({ data: [] });
    const prescriptions = await prisma.prescription.findMany({
      where: { patientId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        doctor: { select: { firstName: true, lastName: true } },
        items: { include: { drug: { select: { name: true, strength: true, form: true } } } },
      },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'portal.prescriptions.read',
      resource: 'prescription', req, meta: { count: prescriptions.length },
    });
    res.json({ data: prescriptions });
  }),
);

portalRouter.get(
  '/portal/profile/:patientId',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const rows = await resolvedPatients(req.actor!);
    const match = rows.find((r) => r.patient.id === req.params.patientId);
    if (!match) throw notFound('Patient not found');
    if (!match.scopes.includes('demographics') && match.relationship !== 'SELF') {
      throw badRequest('The patient has not granted consent to view demographics');
    }
    const patient = match.patient;
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'portal.profile.read',
      resource: 'patient', resourceId: patient.id, req,
    });
    res.json({
      patient: {
        id: patient.id, mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName,
        dateOfBirth: patient.dateOfBirth, sex: patient.sex, phone: patient.phone, email: patient.email,
        address: patient.address, county: patient.county, bloodGroup: patient.bloodGroup,
        allergies: patient.allergies, chronicConditions: patient.chronicConditions,
        emergencyContactName: patient.emergencyContactName, emergencyContactPhone: patient.emergencyContactPhone,
      },
      scopes: match.scopes,
    });
  }),
);
