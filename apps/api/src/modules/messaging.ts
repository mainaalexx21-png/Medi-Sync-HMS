import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { subscribe } from '../lib/events';
import { asyncHandler, parseBody, parsePagination } from '../lib/http';
import { assertPatientAccess } from '../lib/rbac';
import { requireAuth } from '../middleware/auth';
import { notifyUser } from '../services/notifications';

export const messagingRouter = Router();
messagingRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

messagingRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    const notifications = await prisma.notification.findMany({
      where: { userId: req.actor!.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const unread = await prisma.notification.count({ where: { userId: req.actor!.id, readAt: null } });
    res.json({ data: notifications, unread });
  }),
);

messagingRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const updated = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.actor!.id },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) throw notFound('Notification not found');
    res.json({ ok: true });
  }),
);

messagingRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.actor!.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  }),
);

/** Live notification stream for the header bell. */
messagingRouter.get(
  '/notifications/stream',
  asyncHandler(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ userId: req.actor!.id })}\n\n`);
    const unsubscribe = subscribe(`user:${req.actor!.id}`, (payload) => {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);

// ---------------------------------------------------------------------------
// Secure patient-provider messaging
// ---------------------------------------------------------------------------

async function loadThreadFor(req: any, threadId: string) {
  const thread = await prisma.messageThread.findUnique({
    where: { id: threadId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, userId: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, role: true } } } },
    },
  });
  if (!thread) throw notFound('Conversation not found');
  const actor = req.actor;
  if (actor.role === 'PATIENT') {
    if (!actor.patientId || thread.patientId !== actor.patientId) throw forbidden('Not your conversation');
  } else if (actor.role === 'GUARDIAN') {
    const link = await prisma.guardianLink.findFirst({
      where: { guardianUserId: actor.id, patientId: thread.patientId, status: 'ACTIVE' },
    });
    if (!link || !link.scopes.split(',').includes('messages')) throw forbidden('No consent for messaging');
  } else {
    if (!actor.permissions.includes('message.read')) throw forbidden('Missing permission: message.read');
    await assertPatientAccess(actor, thread.patientId, 'DEMOGRAPHICS');
  }
  return thread;
}

messagingRouter.get(
  '/messages/threads',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const p = parsePagination(req.query, 50);
    let where: any = {};
    if (actor.role === 'PATIENT' && actor.patientId) where.patientId = actor.patientId;
    else if (actor.role === 'GUARDIAN') {
      const links = await prisma.guardianLink.findMany({
        where: { guardianUserId: actor.id, status: 'ACTIVE' },
        select: { patientId: true, scopes: true },
      });
      where.patientId = { in: links.filter((l) => l.scopes.split(',').includes('messages')).map((l) => l.patientId) };
    } else if (req.query.patientId) {
      await assertPatientAccess(actor, String(req.query.patientId), 'DEMOGRAPHICS');
      where.patientId = String(req.query.patientId);
    }
    const threads = await prisma.messageThread.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: p.skip,
      take: p.take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, createdAt: true } },
      },
    });
    res.json({ data: threads });
  }),
);

messagingRouter.post(
  '/messages/threads',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({ patientId: z.string().optional(), subject: z.string().trim().min(2).max(120), body: z.string().trim().min(1).max(4000) }),
      req.body,
    );
    let patientId = body.patientId;
    if (actor.role === 'PATIENT') {
      patientId = actor.patientId ?? undefined;
    } else if (actor.role === 'GUARDIAN') {
      if (!patientId) throw badRequest('patientId is required');
      const link = await prisma.guardianLink.findFirst({
        where: { guardianUserId: actor.id, patientId, status: 'ACTIVE' },
      });
      if (!link || !link.scopes.split(',').includes('messages')) throw forbidden('No consent for messaging');
    } else {
      if (!actor.permissions.includes('message.write')) throw forbidden('Missing permission: message.write');
      if (!patientId) throw badRequest('patientId is required');
      await assertPatientAccess(actor, patientId, 'DEMOGRAPHICS');
    }
    if (!patientId) throw badRequest('No patient record linked to this account');

    const thread = await prisma.messageThread.create({
      data: {
        patientId,
        subject: body.subject,
        createdById: actor.id,
        messages: { create: { senderId: actor.id, body: body.body } },
      },
    });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'message.thread.create', resource: 'message_thread',
      resourceId: thread.id, req, meta: { patientId },
    });
    res.status(201).json({ thread });
  }),
);

messagingRouter.get(
  '/messages/threads/:id',
  asyncHandler(async (req, res) => {
    const thread = await loadThreadFor(req, req.params.id);
    await prisma.message.updateMany({
      where: { threadId: thread.id, readAt: null, senderId: { not: req.actor!.id } },
      data: { readAt: new Date() },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'message.thread.read',
      resource: 'message_thread', resourceId: thread.id, req,
    });
    res.json({ thread });
  }),
);

messagingRouter.post(
  '/messages/threads/:id/messages',
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { body } = parseBody(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    const thread = await loadThreadFor(req, req.params.id);
    const message = await prisma.message.create({
      data: { threadId: thread.id, senderId: actor.id, body },
    });
    await prisma.messageThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'message.send', resource: 'message_thread',
      resourceId: thread.id, req,
    });

    // Notify everyone else on the thread (care team + patient account).
    const participants = new Set<string>();
    if (thread.patient.userId) participants.add(thread.patient.userId);
    participants.delete(actor.id);
    for (const userId of participants) {
      await notifyUser({
        userId,
        title: 'New secure message',
        body: `New message in "${thread.subject}"`,
        type: 'INFO',
        link: `/messages/${thread.id}`,
      });
    }
    res.status(201).json({ message });
  }),
);
