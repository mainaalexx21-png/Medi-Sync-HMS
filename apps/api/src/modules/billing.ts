import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { invoiceNumber } from '../lib/ids';
import { renderReceiptPdf } from '../lib/pdf';
import { assertPatientAccess, resolvePatientAccess } from '../lib/rbac';
import { requireAuth, requirePermission } from '../middleware/auth';
import { addInvoiceItem, recalcInvoice, recordPayment } from '../services/invoice';
import { gatewayFor } from '../services/payments';

export const billingRouter = Router();
billingRouter.use(requireAuth);

billingRouter.get(
  '/invoices',
  requirePermission('invoice.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query);
    const where: any = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.patientId) where.patientId = String(req.query.patientId);
    if (req.query.from || req.query.to) {
      where.issuedAt = {};
      if (req.query.from) where.issuedAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.issuedAt.lte = new Date(String(req.query.to));
    }
    if (req.query.unpaid === 'true') where.balance = { gt: 0 };
    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: p.skip,
        take: p.take,
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
          items: true,
          payments: { select: { id: true, amount: true, method: true, receiptNo: true, paidAt: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

billingRouter.post(
  '/invoices',
  requirePermission('invoice.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        patientId: z.string(),
        encounterId: z.string().optional(),
        discount: z.number().min(0).default(0),
        notes: z.string().max(500).optional(),
        items: z
          .array(
            z.object({
              description: z.string().trim().min(2).max(200),
              category: z.enum(['CONSULTATION', 'MEDICATION', 'LAB', 'PROCEDURE', 'BED', 'OTHER']).default('OTHER'),
              quantity: z.number().min(0.01).max(10000).default(1),
              unitPrice: z.number().min(0).max(10_000_000),
            }),
          )
          .min(1),
      }),
      req.body,
    );
    const patient = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!patient) throw notFound('Patient not found');

    const invoice = await prisma.invoice.create({
      data: {
        number: invoiceNumber(),
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        discount: body.discount,
        notes: body.notes ?? null,
        createdById: actor.id,
        status: 'ISSUED',
        items: {
          create: body.items.map((i) => ({
            description: i.description,
            category: i.category,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            amount: Number((i.quantity * i.unitPrice).toFixed(2)),
          })),
        },
      },
    });
    const recalculated = await recalcInvoice(invoice.id);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'invoice.create', resource: 'invoice',
      resourceId: invoice.id, req, meta: { patientId: body.patientId, total: recalculated.total },
    });
    res.status(201).json({ invoice: recalculated });
  }),
);

billingRouter.get(
  '/invoices/:id',
  requirePermission('invoice.read'),
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, email: true } },
        items: true,
        payments: true,
        claims: true,
        encounter: { select: { id: true, startedAt: true } },
      },
    });
    if (!invoice) throw notFound('Invoice not found');
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'invoice.read', resource: 'invoice',
      resourceId: invoice.id, req, meta: { patientId: invoice.patientId },
    });
    res.json({ invoice });
  }),
);

billingRouter.post(
  '/invoices/:id/items',
  requirePermission('invoice.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        description: z.string().trim().min(2).max(200),
        category: z.enum(['CONSULTATION', 'MEDICATION', 'LAB', 'PROCEDURE', 'BED', 'OTHER']).default('OTHER'),
        quantity: z.number().min(0.01).max(10000).default(1),
        unitPrice: z.number().min(0).max(10_000_000),
      }),
      req.body,
    );
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'VOID' || invoice.status === 'PAID') throw badRequest('This invoice can no longer be amended');
    const updated = await addInvoiceItem({ invoiceId: invoice.id, ...body });
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'invoice.item.add', resource: 'invoice',
      resourceId: invoice.id, req, meta: { category: body.category, amount: body.quantity * body.unitPrice },
    });
    res.status(201).json({ invoice: updated });
  }),
);

billingRouter.post(
  '/invoices/:id/payments',
  requirePermission('payment.record'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        amount: z.number().positive().max(10_000_000),
        method: z.enum(['CASH', 'CARD', 'MPESA', 'INSURANCE', 'BANK']),
        reference: z.string().max(80).optional(),
        notes: z.string().max(300).optional(),
      }),
      req.body,
    );
    const result = await recordPayment({
      invoiceId: req.params.id,
      amount: body.amount,
      method: body.method,
      reference: body.reference,
      receivedById: actor.id,
      req,
    });
    res.status(201).json(result);
  }),
);

billingRouter.post(
  '/payments/:id/refund',
  requirePermission('payment.record'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { invoice: true } });
    if (!payment) throw notFound('Payment not found');
    if (payment.status === 'REFUNDED') throw badRequest('Payment is already refunded');
    if (!['BILLING'].includes(actor.role)) throw forbidden('Refunds must be processed by the billing desk');

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED', refundedAt: new Date(), notes: reason },
    });
    const invoice = await recalcInvoice(payment.invoiceId);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'payment.refund', resource: 'payment',
      resourceId: payment.id, req, meta: { invoiceId: payment.invoiceId, amount: payment.amount, reason },
    });
    res.json({ payment: updated, invoice });
  }),
);

billingRouter.get(
  '/invoices/:id/receipt',
  requirePermission('invoice.read'),
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { patient: true, items: true, payments: { orderBy: { paidAt: 'desc' } } },
    });
    if (!invoice) throw notFound('Invoice not found');
    const payment = invoice.payments[0];
    if (!payment) throw badRequest('This invoice has no payments yet');
    const buffer = await renderReceiptPdf({
      receiptNo: payment.receiptNo,
      invoiceNumber: invoice.number,
      patientName: `${invoice.patient.firstName} ${invoice.patient.lastName}`,
      mrn: invoice.patient.mrn,
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference,
      paidAt: payment.paidAt,
      currency: invoice.currency,
      items: invoice.items.map((i) => ({ description: i.description, quantity: i.quantity, amount: i.amount })),
      total: invoice.total,
      balance: invoice.balance,
      receivedBy: payment.receivedById,
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'invoice.receipt_download',
      resource: 'invoice', resourceId: invoice.id, req,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${payment.receiptNo}.pdf"`);
    res.send(buffer);
  }),
);

billingRouter.post(
  '/invoices/:id/claims',
  requirePermission('insurance.manage'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        provider: z.string().trim().min(2).max(120),
        policyNo: z.string().trim().min(2).max(60),
        memberNo: z.string().max(60).optional(),
        claimedAmount: z.number().positive(),
      }),
      req.body,
    );
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) throw notFound('Invoice not found');
    const claim = await prisma.insuranceClaim.create({
      data: { invoiceId: invoice.id, ...body },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'insurance_claim.create',
      resource: 'insurance_claim', resourceId: claim.id, req, meta: { invoiceId: invoice.id, provider: body.provider },
    });
    res.status(201).json({ claim });
  }),
);

// ---------------------------------------------------------------------------
// Patient portal billing
// ---------------------------------------------------------------------------

async function portalPatientIds(actor: { id: string; role: string; patientId?: string | null }, scope: string) {
  if (actor.role === 'PATIENT' && actor.patientId) return [actor.patientId];
  if (actor.role === 'GUARDIAN') {
    const links = await prisma.guardianLink.findMany({
      where: { guardianUserId: actor.id, status: 'ACTIVE' },
      select: { patientId: true, scopes: true },
    });
    return links.filter((l) => l.scopes.split(',').includes(scope)).map((l) => l.patientId);
  }
  return [];
}

billingRouter.get(
  '/me/invoices',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const ids = await portalPatientIds(req.actor!, 'bills');
    if (!ids.length) return res.json({ data: [] });
    const invoices = await prisma.invoice.findMany({
      where: { patientId: { in: ids } },
      orderBy: { issuedAt: 'desc' },
      include: { items: true, payments: { select: { id: true, amount: true, method: true, receiptNo: true, paidAt: true } } },
    });
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'portal.invoices.read',
      resource: 'invoice', req, meta: { count: invoices.length },
    });
    res.json({ data: invoices });
  }),
);

billingRouter.post(
  '/me/invoices/:id/pay',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({ method: z.enum(['MPESA', 'CARD']).default('MPESA'), phone: z.string().max(20).optional() }),
      req.body,
    );
    const ids = await portalPatientIds(actor, 'bills');
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, patientId: { in: ids } } });
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.balance <= 0) throw badRequest('This invoice is already settled');

    const gateway = gatewayFor(body.method);
    const initiation = await gateway.initiate({
      amount: invoice.balance,
      currency: invoice.currency,
      phone: body.phone,
      reference: invoice.number,
      description: 'Hospital services',
    });

    if (initiation.status === 'COMPLETED') {
      const result = await recordPayment({
        invoiceId: invoice.id,
        amount: invoice.balance,
        method: body.method,
        reference: initiation.providerReference,
        receivedById: actor.id,
        req,
      });
      return res.status(201).json({ status: 'COMPLETED', payment: result.payment, invoice: result.invoice, message: initiation.message });
    }
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'portal.payment.initiated', resource: 'invoice',
      resourceId: invoice.id, req, meta: { providerReference: initiation.providerReference, method: body.method },
    });
    return res.status(202).json({ status: 'PENDING', message: initiation.message, providerReference: initiation.providerReference });
  }),
);

billingRouter.get(
  '/me/invoices/:id/receipt',
  requirePermission('own.read'),
  asyncHandler(async (req, res) => {
    const ids = await portalPatientIds(req.actor!, 'bills');
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, patientId: { in: ids } },
      include: { patient: true, items: true, payments: { orderBy: { paidAt: 'desc' } } },
    });
    if (!invoice) throw notFound('Invoice not found');
    const payment = invoice.payments[0];
    if (!payment) throw badRequest('No payment recorded for this invoice');
    const buffer = await renderReceiptPdf({
      receiptNo: payment.receiptNo,
      invoiceNumber: invoice.number,
      patientName: `${invoice.patient.firstName} ${invoice.patient.lastName}`,
      mrn: invoice.patient.mrn,
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference,
      paidAt: payment.paidAt,
      currency: invoice.currency,
      items: invoice.items.map((i) => ({ description: i.description, quantity: i.quantity, amount: i.amount })),
      total: invoice.total,
      balance: invoice.balance,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${payment.receiptNo}.pdf"`);
    res.send(buffer);
  }),
);

/** M-Pesa Daraja callback endpoint (validated by shared secret header). */
billingRouter.post(
  '/payments/mpesa/callback',
  asyncHandler(async (req, res) => {
    const secret = process.env.MPESA_CALLBACK_SECRET;
    if (!secret || req.get('x-callback-secret') !== secret) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid callback signature' } });
    }
    // Stub: in production look up the pending payment by CheckoutRequestID,
    // verify the receipt, then finalise it inside a transaction.
    await audit({ action: 'payment.callback', resource: 'payment', req, meta: { provider: 'MPESA' } });
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }),
);

void assertPatientAccess;
void resolvePatientAccess;
