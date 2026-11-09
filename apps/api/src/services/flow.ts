import { prisma } from '../db';
import { audit } from '../lib/audit';
import { publish } from '../lib/events';
import { nextTicketNo } from '../lib/ids';

/**
 * Shared patient-flow helper used by reception check-in, the queue module and
 * the doctor workspace. Keeping it in one place guarantees the appointment,
 * queue entry and audit trail never drift apart.
 */
export async function checkInPatient(params: {
  patientId: string;
  departmentId: string;
  doctorStaffId?: string | null;
  appointmentId?: string | null;
  priority?: 'EMERGENCY' | 'URGENT' | 'NORMAL';
  actorId: string;
  actorRole: string;
  req?: any;
}) {
  const ticketNo = await nextTicketNo(params.departmentId);
  const entry = await prisma.$transaction(async (tx) => {
    if (params.appointmentId) {
      const appointment = await tx.appointment.findUnique({ where: { id: params.appointmentId } });
      if (!appointment) throw new Error('Appointment not found');
      if (appointment.status === 'CANCELLED') throw new Error('Cannot check in a cancelled appointment');
    }
    const existing = await tx.queueEntry.findFirst({
      where: { patientId: params.patientId, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
    });
    if (existing) return existing;

    const created = await tx.queueEntry.create({
      data: {
        ticketNo,
        patientId: params.patientId,
        departmentId: params.departmentId,
        doctorStaffId: params.doctorStaffId ?? null,
        appointmentId: params.appointmentId ?? null,
        priority: params.priority ?? 'NORMAL',
        checkedInById: params.actorId,
      },
    });
    if (params.appointmentId) {
      await tx.appointment.update({
        where: { id: params.appointmentId },
        data: { status: 'CHECKED_IN', checkedInAt: new Date() },
      });
    }
    return created;
  });

  publish(`queue:${params.departmentId}`, 'queue.updated', { queueEntryId: entry.id, status: entry.status });
  await audit({
    actorId: params.actorId, actorRole: params.actorRole, action: 'queue.check_in',
    resource: 'queue_entry', resourceId: entry.id, req: params.req,
    meta: { departmentId: params.departmentId, ticketNo: entry.ticketNo, priority: entry.priority },
  });
  return entry;
}

export const QUEUE_PRIORITY_ORDER: Record<string, number> = { EMERGENCY: 0, URGENT: 1, NORMAL: 2 };

/** Position + estimated wait for every waiting patient in a department. */
export async function queueSnapshot(departmentId: string) {
  const entries = await prisma.queueEntry.findMany({
    where: { departmentId, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, sex: true } },
      doctor: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { checkedInAt: 'asc' },
  });

  const waiting = entries
    .filter((e) => e.status === 'WAITING')
    .sort((a, b) => {
      const pr = (QUEUE_PRIORITY_ORDER[a.priority] ?? 3) - (QUEUE_PRIORITY_ORDER[b.priority] ?? 3);
      return pr !== 0 ? pr : a.checkedInAt.getTime() - b.checkedInAt.getTime();
    });

  // Average consultation length today, fall back to 15 minutes.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const completed = await prisma.queueEntry.findMany({
    where: { departmentId, status: 'COMPLETED', completedAt: { gte: startOfDay } },
    select: { startedAt: true, completedAt: true },
  });
  const durations = completed
    .filter((c) => c.startedAt && c.completedAt)
    .map((c) => (c.completedAt!.getTime() - c.startedAt!.getTime()) / 60000);
  const avgConsultMinutes = durations.length
    ? Math.max(5, Math.round(durations.reduce((a, b) => a + b, 0) / durations.length))
    : 15;

  return {
    departmentId,
    generatedAt: new Date().toISOString(),
    avgConsultMinutes,
    inProgress: entries
      .filter((e) => e.status === 'IN_CONSULTATION' || e.status === 'CALLED')
      .map((e) => ({ ...e, patient: e.patient, estimatedWaitMinutes: 0 })),
    waiting: waiting.map((entry, index) => ({
      ...entry,
      position: index + 1,
      estimatedWaitMinutes: (index + 1) * avgConsultMinutes,
    })),
  };
}
