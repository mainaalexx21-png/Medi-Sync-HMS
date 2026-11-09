import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { addMinutes } from '../lib/ids';
import { Actor, resolvePatientAccess } from '../lib/rbac';
import { requireAuth, requirePermission } from '../middleware/auth';
import { checkInPatient } from '../services/flow';
import { notifyUser, sendAppointmentReminder } from '../services/notifications';

export const schedulingRouter = Router();
schedulingRouter.use(requireAuth);

const ACTIVE_STATUSES = ['BOOKED', 'CHECKED_IN', 'IN_CONSULTATION'];

async function departments() {
  return prisma.department.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, code: true, type: true } });
}

schedulingRouter.get(
  '/departments',
  asyncHandler(async (_req, res) => {
    res.json({ data: await departments() });
  }),
);

schedulingRouter.get(
  '/doctors',
  asyncHandler(async (req, res) => {
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;
    const staff = await prisma.staff.findMany({
      where: {
        ...(departmentId ? { departmentId } : {}),
        user: { role: 'DOCTOR', status: 'ACTIVE' },
      },
      select: {
        id: true, firstName: true, lastName: true, jobTitle: true, departmentId: true,
        department: { select: { name: true } },
      },
      orderBy: { lastName: 'asc' },
    });
    res.json({ data: staff });
  }),
);

// ---------------------------------------------------------------------------
// Availability templates + slots
// ---------------------------------------------------------------------------

schedulingRouter.get(
  '/schedule/templates',
  requirePermission('appointment.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const doctorStaffId = req.query.doctorStaffId
      ? String(req.query.doctorStaffId)
      : actor.role === 'DOCTOR'
        ? actor.staffId
        : undefined;
    const rows = await prisma.doctorSchedule.findMany({
      where: doctorStaffId && actor.role !== 'HR_MANAGER' ? { staffId: doctorStaffId } : {},
      include: { staff: { select: { firstName: true, lastName: true } }, department: { select: { name: true } } },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
    res.json({ data: rows });
  }),
);

schedulingRouter.post(
  '/schedule/templates',
  requirePermission('schedule.manage'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        staffId: z.string().optional(),
        departmentId: z.string(),
        weekday: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        slotMinutes: z.number().int().min(5).max(120).default(20),
        room: z.string().max(60).optional(),
      }),
      req.body,
    );
    if (body.endTime <= body.startTime) throw badRequest('End time must be after the start time');
    const staffId = body.staffId ?? actor.staffId;
    if (!staffId) throw badRequest('A doctor is required');
    if (actor.role === 'DOCTOR' && staffId !== actor.staffId) {
      throw forbidden('Doctors can only manage their own rota');
    }
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, include: { user: true } });
    if (!staff || staff.user.role !== 'DOCTOR') throw badRequest('Selected staff member is not a doctor');

    const clash = await prisma.doctorSchedule.findFirst({
      where: { staffId, weekday: body.weekday, startTime: { lt: body.endTime }, endTime: { gt: body.startTime } },
    });
    if (clash) throw conflict('This overlaps an existing availability block');

    const template = await prisma.doctorSchedule.create({
      data: { ...body, staffId },
    });
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'schedule.create', resource: 'doctor_schedule', resourceId: template.id, req });
    res.status(201).json({ template });
  }),
);

schedulingRouter.delete(
  '/schedule/templates/:id',
  requirePermission('schedule.manage'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const template = await prisma.doctorSchedule.findUnique({ where: { id: req.params.id } });
    if (!template) throw notFound('Availability block not found');
    if (actor.role === 'DOCTOR' && template.staffId !== actor.staffId) throw forbidden('Not your rota');
    const upcoming = await prisma.appointment.count({
      where: { doctorStaffId: template.staffId, status: { in: ACTIVE_STATUSES }, startAt: { gt: new Date() } },
    });
    if (upcoming > 0) throw conflict('Cancel or reschedule future appointments before removing this block');
    await prisma.doctorSchedule.delete({ where: { id: template.id } });
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'schedule.delete', resource: 'doctor_schedule', resourceId: template.id, req });
    res.json({ ok: true });
  }),
);

schedulingRouter.post(
  '/schedule/time-off',
  requirePermission('schedule.manage'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({ staffId: z.string().optional(), startAt: z.coerce.date(), endAt: z.coerce.date(), reason: z.string().max(200).optional() }),
      req.body,
    );
    const staffId = body.staffId ?? actor.staffId;
    if (!staffId) throw badRequest('A doctor is required');
    if (body.endAt <= body.startAt) throw badRequest('End must be after start');
    const record = await prisma.timeOff.create({
      data: { staffId, startAt: body.startAt, endAt: body.endAt, reason: body.reason ?? null },
    });
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'schedule.time_off', resource: 'time_off', resourceId: record.id, req });
    res.status(201).json({ timeOff: record });
  }),
);

/** Slot generation for a doctor/day, marking already-booked slots. */
schedulingRouter.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const doctorStaffId = String(req.query.doctorStaffId ?? '');
    const dateRaw = String(req.query.date ?? new Date().toISOString().slice(0, 10));
    if (!doctorStaffId) throw badRequest('doctorStaffId is required');
    const day = new Date(`${dateRaw}T00:00:00`);
    if (Number.isNaN(day.getTime())) throw badRequest('Invalid date');

    const templates = await prisma.doctorSchedule.findMany({
      where: { staffId: doctorStaffId, weekday: day.getDay() },
    });
    if (!templates.length) return res.json({ date: dateRaw, slots: [] });

    const dayStart = new Date(day);
    const dayEnd = new Date(day.getTime() + 24 * 3600_000);
    const [booked, timeOff] = await Promise.all([
      prisma.appointment.findMany({
        where: { doctorStaffId, startAt: { gte: dayStart, lt: dayEnd }, status: { in: [...ACTIVE_STATUSES, 'COMPLETED'] } },
        select: { startAt: true, status: true },
      }),
      prisma.timeOff.findMany({ where: { staffId: doctorStaffId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } } }),
    ]);

    const slots: { startAt: string; endAt: string; available: boolean; room: string | null }[] = [];
    for (const template of templates) {
      const [sh, sm] = template.startTime.split(':').map(Number);
      const [eh, em] = template.endTime.split(':').map(Number);
      const cursor = new Date(day);
      cursor.setHours(sh, sm, 0, 0);
      const end = new Date(day);
      end.setHours(eh, em, 0, 0);
      while (cursor < end) {
        const slotEnd = addMinutes(cursor, template.slotMinutes);
        if (slotEnd > end) break;
        const isBooked = booked.some((b) => b.startAt.getTime() === cursor.getTime());
        const isOff = timeOff.some((t) => cursor < t.endAt && slotEnd > t.startAt);
        slots.push({
          startAt: cursor.toISOString(),
          endAt: slotEnd.toISOString(),
          available: !isBooked && !isOff && cursor.getTime() > Date.now(),
          room: template.room,
        });
        cursor.setTime(slotEnd.getTime());
      }
    }
    res.json({ date: dateRaw, slots });
  }),
);

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

schedulingRouter.get(
  '/appointments',
  requirePermission('appointment.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const p = parsePagination(req.query);
    const where: any = {};
    if (req.query.from || req.query.to) {
      where.startAt = {};
      if (req.query.from) where.startAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.startAt.lte = new Date(String(req.query.to));
    }
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.departmentId) where.departmentId = String(req.query.departmentId);
    if (req.query.patientId) where.patientId = String(req.query.patientId);
    if (req.query.doctorStaffId) where.doctorStaffId = String(req.query.doctorStaffId);
    if (actor.role === 'DOCTOR') where.doctorStaffId = actor.staffId ?? 'none';

    const [rows, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        orderBy: { startAt: 'desc' },
        skip: p.skip,
        take: p.take,
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
          doctor: { select: { id: true, firstName: true, lastName: true } },
          department: { select: { name: true } },
          queueEntry: { select: { ticketNo: true, status: true } },
        },
      }),
      prisma.appointment.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

const bookingSchema = z.object({
  patientId: z.string().optional(),
  doctorStaffId: z.string(),
  startAt: z.coerce.date(),
  type: z.enum(['CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'TELEHEALTH']).default('CONSULTATION'),
  reason: z.string().max(500).optional(),
});

schedulingRouter.post(
  '/appointments',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(bookingSchema, req.body);

    // Who is this booking for?
    let patientId = body.patientId;
    let bookedVia = 'STAFF';
    if (actor.role === 'PATIENT') {
      if (!actor.patientId) throw badRequest('No patient profile linked to this account');
      patientId = actor.patientId;
      bookedVia = 'PATIENT_PORTAL';
    } else if (actor.role === 'GUARDIAN') {
      if (!body.patientId) throw badRequest('patientId is required');
      const access = await resolvePatientAccess(actor, body.patientId);
      if (!access.allowed) throw forbidden('You do not have guardian access to this patient');
      if (!access.guardianScopes.includes('appointments')) throw forbidden('The patient has not granted consent for appointments');
      bookedVia = 'PATIENT_PORTAL';
    } else if (!actor.permissions.includes('appointment.write')) {
      throw forbidden('Missing permission: appointment.write');
    }
    if (!patientId) throw badRequest('patientId is required');

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) throw notFound('Patient not found');
    const doctor = await prisma.staff.findUnique({
      where: { id: body.doctorStaffId },
      include: { user: { select: { role: true, status: true } } },
    });
    if (!doctor || doctor.user.role !== 'DOCTOR' || doctor.user.status !== 'ACTIVE') {
      throw badRequest('Selected doctor is not available');
    }
    if (body.startAt.getTime() < Date.now() - 60_000) throw badRequest('Appointment time must be in the future');

    const template = await prisma.doctorSchedule.findFirst({
      where: { staffId: doctor.id, weekday: body.startAt.getDay() },
    });
    if (!template) throw badRequest('The doctor does not work on this day');
    const [sh, sm] = template.startTime.split(':').map(Number);
    const [eh, em] = template.endTime.split(':').map(Number);
    const slotStart = new Date(body.startAt);
    slotStart.setHours(sh, sm, 0, 0);
    const dayEnd = new Date(body.startAt);
    dayEnd.setHours(eh, em, 0, 0);
    if (body.startAt < slotStart || body.startAt >= dayEnd) throw badRequest('Requested time is outside the doctor rota');
    if ((body.startAt.getTime() - slotStart.getTime()) % (template.slotMinutes * 60_000) !== 0) {
      throw badRequest('Requested time does not align with a consultation slot');
    }
    const endAt = addMinutes(body.startAt, template.slotMinutes);
    const off = await prisma.timeOff.findFirst({
      where: { staffId: doctor.id, startAt: { lt: endAt }, endAt: { gt: body.startAt } },
    });
    if (off) throw conflict('The doctor is on leave at that time');

    const clash = await prisma.appointment.findFirst({
      where: {
        doctorStaffId: doctor.id,
        status: { in: ACTIVE_STATUSES },
        startAt: { lt: endAt },
        endAt: { gt: body.startAt },
      },
    });
    if (clash) throw conflict('That slot has just been taken. Please pick another time.');

    const patientClash = await prisma.appointment.findFirst({
      where: { patientId, status: { in: ACTIVE_STATUSES }, startAt: { lt: endAt }, endAt: { gt: body.startAt } },
    });
    if (patientClash) throw conflict('The patient already has an appointment at that time');

    let appointment;
    try {
      appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorStaffId: doctor.id,
          departmentId: doctor.departmentId ?? template.departmentId,
          startAt: body.startAt,
          endAt,
          type: body.type,
          reason: body.reason ?? null,
          createdById: actor.id,
          bookedVia,
          room: template.room,
        },
      });
    } catch (error: any) {
      // Unique index is the final arbiter under concurrency.
      if (error?.code === 'P2002') throw conflict('That slot has just been taken. Please pick another time.');
      throw error;
    }

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'appointment.create', resource: 'appointment',
      resourceId: appointment.id, req, meta: { doctorStaffId: doctor.id, patientId, bookedVia },
    });
    if (patient.userId) {
      await notifyUser({
        userId: patient.userId,
        title: 'Appointment confirmed',
        body: `Your appointment with Dr ${doctor.firstName} ${doctor.lastName} is confirmed for ${body.startAt.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.`,
        type: 'APPOINTMENT',
        link: '/portal/appointments',
      });
    }
    await sendAppointmentReminder({
      email: patient.email, phone: patient.phone, when: body.startAt, reference: appointment.id.slice(-6).toUpperCase(),
    });
    res.status(201).json({ appointment });
  }),
);

schedulingRouter.get(
  '/appointments/:id',
  requirePermission('appointment.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, dateOfBirth: true, sex: true } },
        doctor: { select: { id: true, firstName: true, lastName: true } },
        department: { select: { name: true } },
        queueEntry: true,
        encounter: { select: { id: true, status: true } },
      },
    });
    if (!appointment) throw notFound('Appointment not found');
    if (actor.role === 'DOCTOR' && appointment.doctorStaffId !== actor.staffId) throw forbidden('Not your appointment');
    res.json({ appointment });
  }),
);

schedulingRouter.post(
  '/appointments/:id/cancel',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appointment) throw notFound('Appointment not found');
    const canCancel =
      actor.permissions.includes('appointment.write') ||
      (actor.role === 'DOCTOR' && appointment.doctorStaffId === actor.staffId) ||
      (actor.role === 'PATIENT' && appointment.patientId === actor.patientId);
    if (!canCancel) {
      if (actor.role === 'GUARDIAN') {
        const access = await resolvePatientAccess(actor, appointment.patientId);
        if (!access.allowed || !access.guardianScopes.includes('appointments')) throw forbidden('Not allowed');
      } else {
        throw forbidden('Not allowed');
      }
    }
    if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) throw badRequest('Appointment cannot be cancelled');
    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: reason },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'appointment.cancel', resource: 'appointment',
      resourceId: appointment.id, req, meta: { reason },
    });
    res.json({ appointment: updated });
  }),
);

schedulingRouter.post(
  '/appointments/:id/reschedule',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { startAt, reason } = parseBody(
      z.object({ startAt: z.coerce.date(), reason: z.string().max(300).optional() }),
      req.body,
    );
    const original = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!original) throw notFound('Appointment not found');
    const allowed =
      actor.permissions.includes('appointment.write') ||
      (actor.role === 'DOCTOR' && original.doctorStaffId === actor.staffId) ||
      (actor.role === 'PATIENT' && original.patientId === actor.patientId);
    if (!allowed) throw forbidden('Not allowed');
    if (['COMPLETED', 'CANCELLED'].includes(original.status)) throw badRequest('This appointment can no longer be moved');

    const template = await prisma.doctorSchedule.findFirst({
      where: { staffId: original.doctorStaffId, weekday: startAt.getDay() },
    });
    if (!template) throw badRequest('The doctor does not work on that day');
    const endAt = addMinutes(startAt, template.slotMinutes);
    const clash = await prisma.appointment.findFirst({
      where: {
        doctorStaffId: original.doctorStaffId,
        status: { in: ACTIVE_STATUSES },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
    });
    if (clash) throw conflict('That slot is not available');

    const [, created] = await prisma.$transaction([
      prisma.appointment.update({
        where: { id: original.id },
        data: { status: 'RESCHEDULED', cancelledReason: reason ?? 'Rescheduled' },
      }),
      prisma.appointment.create({
        data: {
          patientId: original.patientId,
          doctorStaffId: original.doctorStaffId,
          departmentId: original.departmentId,
          startAt,
          endAt,
          type: original.type,
          reason: original.reason,
          room: original.room,
          createdById: actor.id,
          bookedVia: original.bookedVia,
          rescheduledFromId: original.id,
        },
      }),
    ]);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'appointment.reschedule', resource: 'appointment',
      resourceId: created.id, req, meta: { from: original.id, startAt: startAt.toISOString() },
    });
    res.status(201).json({ appointment: created });
  }),
);

schedulingRouter.post(
  '/appointments/:id/check-in',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { priority } = parseBody(
      z.object({ priority: z.enum(['EMERGENCY', 'URGENT', 'NORMAL']).default('NORMAL') }),
      req.body ?? {},
    );
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appointment) throw notFound('Appointment not found');
    if (appointment.status === 'CANCELLED') throw badRequest('Cannot check in a cancelled appointment');

    const entry = await checkInPatient({
      patientId: appointment.patientId,
      departmentId: appointment.departmentId,
      doctorStaffId: appointment.doctorStaffId,
      appointmentId: appointment.id,
      priority,
      actorId: actor.id,
      actorRole: actor.role,
      req,
    });
    res.status(201).json({ queueEntry: entry });
  }),
);
