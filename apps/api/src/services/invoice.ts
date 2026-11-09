import { prisma } from '../db';
import { audit } from '../lib/audit';
import { invoiceNumber } from '../lib/ids';
import { AppError, notFound } from '../lib/errors';

/**
 * Billing domain helpers. Every charge path (consultation, lab, medication)
 * funnels through here so invoice totals can never drift.
 */

export async function settingNumber(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function recalcInvoice(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!invoice) throw notFound('Invoice not found');
  const subtotal = Number(invoice.items.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const total = Number(Math.max(0, subtotal - invoice.discount).toFixed(2));
  const payments = await prisma.payment.findMany({
    where: { invoiceId, status: 'COMPLETED' },
    select: { amount: true },
  });
  const amountPaid = Number(payments.reduce((sum, p) => sum + p.amount, 0).toFixed(2));
  const balance = Number(Math.max(0, total - amountPaid).toFixed(2));
  let status = invoice.status;
  if (invoice.status !== 'VOID' && invoice.status !== 'DRAFT') {
    if (amountPaid <= 0) status = 'ISSUED';
    else if (balance > 0) status = 'PARTIALLY_PAID';
    else status = 'PAID';
  }
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { subtotal, total, amountPaid, balance, status },
  });
}

export async function addInvoiceItem(params: {
  invoiceId: string;
  description: string;
  category: 'CONSULTATION' | 'MEDICATION' | 'LAB' | 'PROCEDURE' | 'BED' | 'OTHER';
  quantity?: number;
  unitPrice: number;
  referenceId?: string;
}) {
  const quantity = params.quantity ?? 1;
  await prisma.invoiceItem.create({
    data: {
      invoiceId: params.invoiceId,
      description: params.description,
      category: params.category,
      quantity,
      unitPrice: params.unitPrice,
      amount: Number((quantity * params.unitPrice).toFixed(2)),
      referenceId: params.referenceId ?? null,
    },
  });
  return recalcInvoice(params.invoiceId);
}

/** Idempotent: one invoice per encounter, created with the consultation fee. */
export async function ensureEncounterInvoice(params: {
  encounterId: string;
  patientId: string;
  doctorName: string;
  actorId: string;
}) {
  const existing = await prisma.invoice.findFirst({ where: { encounterId: params.encounterId } });
  if (existing) return existing;

  const fee = await settingNumber('consultation_fee', 1500);
  const invoice = await prisma.invoice.create({
    data: {
      number: invoiceNumber(),
      patientId: params.patientId,
      encounterId: params.encounterId,
      status: 'ISSUED',
      createdById: params.actorId,
      items: {
        create: [
          {
            description: `Consultation - ${params.doctorName}`,
            category: 'CONSULTATION',
            quantity: 1,
            unitPrice: fee,
            amount: fee,
          },
        ],
      },
    },
  });
  await recalcInvoice(invoice.id);
  await audit({
    actorId: params.actorId,
    action: 'invoice.auto_created',
    resource: 'invoice',
    resourceId: invoice.id,
    meta: { encounterId: params.encounterId, amount: fee },
  });
  return invoice;
}

export async function recordPayment(params: {
  invoiceId: string;
  amount: number;
  method: 'CASH' | 'CARD' | 'MPESA' | 'INSURANCE' | 'BANK';
  reference?: string;
  receivedById: string;
  req?: any;
}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: params.invoiceId } });
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status === 'VOID') throw new AppError(400, 'INVOICE_VOID', 'Cannot pay a voided invoice');
  if (params.amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Payment amount must be greater than zero');
  if (params.amount > invoice.balance + 0.01) {
    throw new AppError(400, 'OVERPAYMENT', `Payment exceeds the outstanding balance of KES ${invoice.balance.toFixed(2)}`);
  }

  const receiptNo = (await import('../lib/ids')).receiptNumber();
  const payment = await prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      receiptNo,
      amount: Number(params.amount.toFixed(2)),
      method: params.method,
      reference: params.reference ?? null,
      receivedById: params.receivedById,
    },
  });
  const updated = await recalcInvoice(invoice.id);
  await audit({
    actorId: params.receivedById,
    action: 'payment.recorded',
    resource: 'payment',
    resourceId: payment.id,
    req: params.req,
    meta: { invoiceId: invoice.id, amount: payment.amount, method: payment.method, receiptNo },
  });
  return { payment, invoice: updated };
}
