import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { subscribe } from '../lib/events';
import { asyncHandler, parseBody } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';
import { checkInPatient, queueSnapshot } from '../services/flow';

export const queueRouter = Router();
queueRouter.use(requireAuth);

queueRouter.get(
  '/queue',
  requirePermission('queue.read'),
  asyncHandler(async (req, res) => {
    const departmentId = String(req.query.departmentId ?? '');
    if (!departmentId) throw badRequest('departmentId is required');
    const snapshot = await queueSnapshot(departmentId);
    res.json(snapshot);
  }),
);

/**
 * Display-board projection: no names, no clinical data. A screen in the waiting
 * area can show this without exposing patient identities.
 */
queueRouter.get(
  '/queue/board',
  requirePermission('queue.read'),
  asyncHandler(async (req, res) => {
    const departmentId = String(req.query.departmentId ?? '');
    if (!departmentId) throw badRequest('departmentId is required');
    const snapshot = await queueSnapshot(departmentId);
    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { name: true } });
    res.json({
      department: department?.name ?? 'Clinic',
      updatedAt: snapshot.generatedAt,
      nowServing: snapshot.inProgress.map((e) => ({
        ticketNo: e.ticketNo,
        room: null,
        doctor: e.doctor ? `Dr ${e.doctor.lastName}` : 'Next available',
      })),
      waiting: snapshot.waiting.map((e) => ({
        ticketNo: e.ticketNo,
        estimatedWaitMinutes: e.estimatedWaitMinutes,
        priority: e.priority,
      })),
      averageConsultMinutes: snapshot.avgConsultMinutes,
    });
  }),
);

queueRouter.post(
  '/queue',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        patientId: z.string(),
        departmentId: z.string(),
        doctorStaffId: z.string().optional(),
        appointmentId: z.string().optional(),
        priority: z.enum(['EMERGENCY', 'URGENT', 'NORMAL']).default('NORMAL'),
      }),
      req.body,
    );
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');
    const entry = await checkInPatient({ ...body, actorId: actor.id, actorRole: actor.role, req });
    res.status(201).json({ queueEntry: entry });
  }),
);

async function transition(
  id: string,
  actorId: string,
  actorRole: string,
  next: 'CALLED' | 'IN_CONSULTATION' | 'COMPLETED' | 'SKIPPED',
  req: any,
) {
  const entry = await prisma.queueEntry.findUnique({ where: { id } });
  if (!entry) throw notFound('Queue entry not found');
  const allowedFrom: Record<string, string[]> = {
    CALLED: ['WAITING'],
    IN_CONSULTATION: ['WAITING', 'CALLED'],
    COMPLETED: ['IN_CONSULTATION', 'CALLED'],
    SKIPPED: ['WAITING', 'CALLED'],
  };
  if (!allowedFrom[next].includes(entry.status)) {
    throw badRequest(`Cannot move a ${entry.status.toLowerCase()} patient to ${next.toLowerCase()}`);
  }
  const now = new Date();
  const data: any = { status: next };
  if (next === 'CALLED') data.calledAt = now;
  if (next === 'IN_CONSULTATION') data.startedAt = now;
  if (next === 'COMPLETED') data.completedAt = now;
  const updated = await prisma.queueEntry.update({ where: { id }, data });
  const { publish } = await import('../lib/events');
  publish(`queue:${entry.departmentId}`, 'queue.updated', { queueEntryId: id, status: next });
  await audit({
    actorId, actorRole, action: `queue.${next.toLowerCase()}`, resource: 'queue_entry',
    resourceId: id, req, meta: { departmentId: entry.departmentId },
  });
  return updated;
}

queueRouter.post(
  '/queue/:id/call',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    res.json({ queueEntry: await transition(req.params.id, req.actor!.id, req.actor!.role, 'CALLED', req) });
  }),
);

queueRouter.post(
  '/queue/:id/start',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    res.json({ queueEntry: await transition(req.params.id, req.actor!.id, req.actor!.role, 'IN_CONSULTATION', req) });
  }),
);

queueRouter.post(
  '/queue/:id/complete',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    res.json({ queueEntry: await transition(req.params.id, req.actor!.id, req.actor!.role, 'COMPLETED', req) });
  }),
);

queueRouter.post(
  '/queue/:id/skip',
  requirePermission('queue.write'),
  asyncHandler(async (req, res) => {
    res.json({ queueEntry: await transition(req.params.id, req.actor!.id, req.actor!.role, 'SKIPPED', req) });
  }),
);

queueRouter.get(
  '/queue/stats',
  requirePermission('queue.read'),
  asyncHandler(async (req, res) => {
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const where = { createdAt: { gte: startOfDay }, ...(departmentId ? { departmentId } : {}) };
    const [waiting, inProgress, completed, byPriority] = await Promise.all([
      prisma.queueEntry.count({ where: { ...where, status: 'WAITING' } }),
      prisma.queueEntry.count({ where: { ...where, status: { in: ['CALLED', 'IN_CONSULTATION'] } } }),
      prisma.queueEntry.count({ where: { ...where, status: 'COMPLETED' } }),
      prisma.queueEntry.groupBy({ by: ['priority'], where, _count: { _all: true } }),
    ]);
    const snapshot = departmentId ? await queueSnapshot(departmentId) : null;
    res.json({
      today: { waiting, inProgress, completed, byPriority },
      avgWaitMinutes: snapshot?.avgConsultMinutes ?? 15,
    });
  }),
);

/** Live queue over Server-Sent Events (works everywhere, unlike WS proxies). */
queueRouter.get(
  '/queue/stream',
  requirePermission('queue.read'),
  asyncHandler(async (req, res) => {
    const departmentId = String(req.query.departmentId ?? '');
    if (!departmentId) throw badRequest('departmentId is required');
    if (req.actor!.role === 'PATIENT' || req.actor!.role === 'GUARDIAN') {
      throw forbidden('Use the patient portal for queue position');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ departmentId })}\n\n`);

    const send = async () => {
      try {
        const snapshot = await queueSnapshot(departmentId);
        res.write(`event: queue\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        /* ignore transient errors, next tick retries */
      }
    };
    await send();

    const unsubscribe = subscribe(`queue:${departmentId}`, () => void send());
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);

/** Patient-facing queue position (only their own entry). */
queueRouter.get(
  '/me/queue',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    let patientIds: string[] = [];
    if (actor.role === 'PATIENT' && actor.patientId) patientIds = [actor.patientId];
    else if (actor.role === 'GUARDIAN') {
      const links = await prisma.guardianLink.findMany({
        where: { guardianUserId: actor.id, status: 'ACTIVE' },
        select: { patientId: true, scopes: true },
      });
      patientIds = links.filter((l) => l.scopes.split(',').includes('appointments')).map((l) => l.patientId);
    }
    const entry = await prisma.queueEntry.findFirst({
      where: { patientId: { in: patientIds }, status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] } },
      orderBy: { createdAt: 'desc' },
      include: { department: { select: { name: true } }, doctor: { select: { lastName: true } } },
    });
    if (!entry) return res.json({ queueEntry: null });
    const snapshot = await queueSnapshot(entry.departmentId);
    const position = snapshot.waiting.find((w) => w.id === entry.id)?.position ?? 0;
    res.json({
      queueEntry: {
        id: entry.id,
        ticketNo: entry.ticketNo,
        status: entry.status,
        department: entry.department.name,
        doctor: entry.doctor ? `Dr ${entry.doctor.lastName}` : null,
        position,
        estimatedWaitMinutes: position ? position * snapshot.avgConsultMinutes : 0,
        checkedInAt: entry.checkedInAt,
      },
    });
  }),
);
