import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { asyncHandler, paginated, parseBody, parsePagination } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';
import { assertDepartmentType } from '../lib/rbac';
import { addInvoiceItem, ensureEncounterInvoice, recalcInvoice } from '../services/invoice';
import { notifyUser } from '../services/notifications';

export const pharmacyRouter = Router();
pharmacyRouter.use(requireAuth);

async function stockByDrug(drugIds?: string[]) {
  const batches = await prisma.stockBatch.groupBy({
    by: ['drugId'],
    where: { ...(drugIds ? { drugId: { in: drugIds } } : {}), quantity: { gt: 0 } },
    _sum: { quantity: true },
  });
  const map = new Map<string, number>();
  for (const row of batches) map.set(row.drugId, row._sum.quantity ?? 0);
  return map;
}

// ---------------------------------------------------------------------------
// Drug catalog & stock
// ---------------------------------------------------------------------------

pharmacyRouter.get(
  '/drugs',
  requirePermission('drug.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query, 200);
    const search = String(req.query.search ?? '').trim();
    const where: any = {};
    if (search) where.OR = [{ name: { contains: search } }, { genericName: { contains: search } }];
    if (req.query.active !== undefined) where.active = req.query.active === 'true';
    const [rows, total] = await Promise.all([
      prisma.drug.findMany({ where, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      prisma.drug.count({ where }),
    ]);
    const stock = await stockByDrug(rows.map((r) => r.id));
    const items = rows.map((drug) => {
      const onHand = stock.get(drug.id) ?? 0;
      return { ...drug, stockOnHand: onHand, lowStock: onHand <= drug.reorderLevel };
    });
    res.json(paginated(items, total, p));
  }),
);

pharmacyRouter.post(
  '/drugs',
  requirePermission('drug.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120),
        genericName: z.string().max(120).optional(),
        form: z.enum(['TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'CREAM', 'DROPS', 'INHALER', 'SACHET']).default('TABLET'),
        strength: z.string().max(40).optional(),
        unitPrice: z.number().min(0).max(1_000_000),
        reorderLevel: z.number().int().min(0).max(100_000).default(20),
      }),
      req.body,
    );
    const drug = await prisma.drug.create({ data: body });
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'drug.create', resource: 'drug', resourceId: drug.id, req });
    res.status(201).json({ drug });
  }),
);

pharmacyRouter.patch(
  '/drugs/:id',
  requirePermission('drug.write'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        unitPrice: z.number().min(0).optional(),
        reorderLevel: z.number().int().min(0).optional(),
        active: z.boolean().optional(),
        strength: z.string().max(40).optional(),
      }),
      req.body,
    );
    const existing = await prisma.drug.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Drug not found');
    const drug = await prisma.drug.update({ where: { id: existing.id }, data: body });
    await audit({ actorId: req.actor!.id, actorRole: req.actor!.role, action: 'drug.update', resource: 'drug', resourceId: drug.id, req, meta: { fields: Object.keys(body) } });
    res.json({ drug });
  }),
);

pharmacyRouter.get(
  '/drugs/:id/batches',
  requirePermission('drug.read'),
  asyncHandler(async (req, res) => {
    const batches = await prisma.stockBatch.findMany({
      where: { drugId: req.params.id },
      orderBy: { expiryDate: 'asc' },
    });
    const movements = await prisma.stockMovement.findMany({
      where: { drugId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ batches, movements });
  }),
);

pharmacyRouter.post(
  '/drugs/:id/batches',
  requirePermission('stock.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        batchNo: z.string().trim().min(1).max(60),
        expiryDate: z.coerce.date(),
        quantity: z.number().int().min(1).max(1_000_000),
        unitCost: z.number().min(0).default(0),
      }),
      req.body,
    );
    if (body.expiryDate.getTime() < Date.now()) throw badRequest('Cannot receive stock that is already expired');
    const drug = await prisma.drug.findUnique({ where: { id: req.params.id } });
    if (!drug) throw notFound('Drug not found');

    const existing = await prisma.stockBatch.findUnique({
      where: { drugId_batchNo: { drugId: drug.id, batchNo: body.batchNo } },
    });
    if (existing) throw conflict('That batch number already exists for this medicine');

    const [batch] = await prisma.$transaction([
      prisma.stockBatch.create({ data: { drugId: drug.id, ...body } }),
      prisma.stockMovement.create({
        data: {
          drugId: drug.id,
          type: 'RECEIPT',
          quantity: body.quantity,
          reference: body.batchNo,
          performedById: actor.staffId ?? null,
          reason: 'Stock received',
        },
      }),
    ]);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'stock.receipt', resource: 'stock_batch',
      resourceId: batch.id, req, meta: { drugId: drug.id, quantity: body.quantity },
    });
    res.status(201).json({ batch });
  }),
);

pharmacyRouter.post(
  '/drugs/:id/adjust',
  requirePermission('stock.write'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    const body = parseBody(
      z.object({
        batchId: z.string().optional(),
        quantity: z.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'),
        reason: z.string().trim().min(3).max(300),
      }),
      req.body,
    );
    const drug = await prisma.drug.findUnique({ where: { id: req.params.id } });
    if (!drug) throw notFound('Drug not found');
    const batch = body.batchId
      ? await prisma.stockBatch.findFirst({ where: { id: body.batchId, drugId: drug.id } })
      : await prisma.stockBatch.findFirst({
          where: { drugId: drug.id, quantity: { gt: 0 } },
          orderBy: { expiryDate: 'asc' },
        });
    if (!batch) throw badRequest('No stock batch available for this adjustment');
    if (batch.quantity + body.quantity < 0) throw badRequest('Adjustment would make stock negative');

    await prisma.$transaction([
      prisma.stockBatch.update({ where: { id: batch.id }, data: { quantity: { increment: body.quantity } } }),
      prisma.stockMovement.create({
        data: {
          drugId: drug.id, batchId: batch.id, type: 'ADJUSTMENT', quantity: body.quantity,
          reason: body.reason, performedById: actor.staffId ?? null,
        },
      }),
    ]);
    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'stock.adjustment', resource: 'stock_batch',
      resourceId: batch.id, req, meta: { drugId: drug.id, quantity: body.quantity, reason: body.reason },
    });
    res.json({ ok: true, batchId: batch.id, quantity: batch.quantity + body.quantity });
  }),
);

pharmacyRouter.get(
  '/stock/alerts',
  requirePermission('drug.read'),
  asyncHandler(async (_req, res) => {
    const in60Days = new Date(Date.now() + 60 * 24 * 3600_000);
    const [expiring, expired, drugs, stock] = await Promise.all([
      prisma.stockBatch.findMany({
        where: { quantity: { gt: 0 }, expiryDate: { lte: in60Days, gt: new Date() } },
        include: { drug: { select: { name: true, strength: true } } },
        orderBy: { expiryDate: 'asc' },
      }),
      prisma.stockBatch.findMany({
        where: { quantity: { gt: 0 }, expiryDate: { lte: new Date() } },
        include: { drug: { select: { name: true, strength: true } } },
        orderBy: { expiryDate: 'asc' },
      }),
      prisma.drug.findMany({ where: { active: true } }),
      stockByDrug(),
    ]);
    const low = drugs
      .map((d) => ({ ...d, stockOnHand: stock.get(d.id) ?? 0 }))
      .filter((d) => d.stockOnHand <= d.reorderLevel)
      .sort((a, b) => a.stockOnHand - b.stockOnHand);
    res.json({
      expiringSoon: expiring,
      expired,
      lowStock: low,
      counts: { expiringSoon: expiring.length, expired: expired.length, lowStock: low.length },
    });
  }),
);

// ---------------------------------------------------------------------------
// Prescription queue + dispensing
// ---------------------------------------------------------------------------

pharmacyRouter.get(
  '/prescriptions',
  requirePermission('prescription.read'),
  asyncHandler(async (req, res) => {
    const p = parsePagination(req.query);
    const status = req.query.status ? String(req.query.status) : undefined;
    const where: any = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.prescription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        include: {
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, allergies: true } },
          doctor: { select: { firstName: true, lastName: true } },
          items: { include: { drug: true } },
        },
      }),
      prisma.prescription.count({ where }),
    ]);
    res.json(paginated(rows, total, p));
  }),
);

pharmacyRouter.get(
  '/prescriptions/:id',
  requirePermission('prescription.read'),
  asyncHandler(async (req, res) => {
    const prescription = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, allergies: true } },
        doctor: { select: { firstName: true, lastName: true } },
        items: { include: { drug: true } },
        encounter: { select: { id: true, chiefComplaint: true, diagnoses: true } },
      },
    });
    if (!prescription) throw notFound('Prescription not found');
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'prescription.read',
      resource: 'prescription', resourceId: prescription.id, req, meta: { patientId: prescription.patientId },
    });
    res.json({ prescription });
  }),
);

/**
 * Dispense with FEFO (first-expiry-first-out) batch allocation. Stock changes,
 * movements and prescription state all happen in one transaction, and batch
 * updates are conditional on sufficient stock, so concurrent dispenses cannot
 * oversell inventory.
 */
pharmacyRouter.post(
  '/prescriptions/:id/dispense',
  requirePermission('prescription.dispense'),
  asyncHandler(async (req, res) => {
    const actor = req.actor!;
    assertDepartmentType(actor, 'PHARMACY');
    const body = parseBody(
      z.object({
        items: z
          .array(z.object({ itemId: z.string(), quantity: z.number().int().min(1) }))
          .optional(),
      }),
      req.body ?? {},
    );
    const prescription = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { drug: true } }, patient: true },
    });
    if (!prescription) throw notFound('Prescription not found');
    if (!['PENDING', 'PARTIAL'].includes(prescription.status)) {
      throw badRequest(`Prescription is already ${prescription.status.toLowerCase()}`);
    }

    const requests = body.items?.length
      ? body.items
      : prescription.items
          .filter((i) => i.quantity - i.dispensedQty > 0)
          .map((i) => ({ itemId: i.id, quantity: i.quantity - i.dispensedQty }));

    const invoice = await ensureEncounterInvoice({
      encounterId: prescription.encounterId,
      patientId: prescription.patientId,
      doctorName: 'Consultation',
      actorId: actor.id,
    });

    const dispensedSummary: { itemId: string; drug: string; quantity: number }[] = [];

    await prisma.$transaction(async (tx) => {
      for (const request of requests) {
        const item = prescription.items.find((i) => i.id === request.itemId);
        if (!item) throw badRequest('Prescription item not found on this prescription');
        const remaining = item.quantity - item.dispensedQty;
        if (request.quantity > remaining) throw badRequest(`Cannot dispense more than ${remaining} of ${item.drug.name}`);

        let toAllocate = request.quantity;
        const batches = await tx.stockBatch.findMany({
          where: { drugId: item.drugId, quantity: { gt: 0 }, expiryDate: { gt: new Date() } },
          orderBy: { expiryDate: 'asc' },
        });
        for (const batch of batches) {
          if (toAllocate === 0) break;
          const take = Math.min(batch.quantity, toAllocate);
          const updated = await tx.stockBatch.updateMany({
            where: { id: batch.id, quantity: { gte: take } },
            data: { quantity: { decrement: take } },
          });
          if (updated.count === 0) continue; // someone else took it; try the next batch
          await tx.stockMovement.create({
            data: {
              drugId: item.drugId,
              batchId: batch.id,
              type: 'DISPENSE',
              quantity: -take,
              reference: prescription.id,
              performedById: actor.staffId ?? null,
            },
          });
          toAllocate -= take;
        }
        if (toAllocate > 0) {
          throw conflict(`Insufficient stock for ${item.drug.name}. Short by ${toAllocate}.`);
        }
        await tx.prescriptionItem.update({
          where: { id: item.id },
          data: { dispensedQty: { increment: request.quantity } },
        });
        dispensedSummary.push({ itemId: item.id, drug: item.drug.name, quantity: request.quantity });
      }

      const refreshed = await tx.prescriptionItem.findMany({ where: { prescriptionId: prescription.id } });
      const fullyDispensed = refreshed.every((i) => i.dispensedQty >= i.quantity);
      await tx.prescription.update({
        where: { id: prescription.id },
        data: {
          status: fullyDispensed ? 'DISPENSED' : 'PARTIAL',
          dispensedById: actor.id,
          dispensedAt: new Date(),
        },
      });
    });

    for (const line of dispensedSummary) {
      const item = prescription.items.find((i) => i.id === line.itemId)!;
      if (item.drug.unitPrice > 0) {
        await addInvoiceItem({
          invoiceId: invoice.id,
          description: `${item.drug.name} ${item.drug.strength ?? ''} x${line.quantity}`.trim(),
          category: 'MEDICATION',
          quantity: line.quantity,
          unitPrice: item.drug.unitPrice,
          referenceId: item.id,
        });
      }
    }
    await recalcInvoice(invoice.id);

    await audit({
      actorId: actor.id, actorRole: actor.role, action: 'prescription.dispense', resource: 'prescription',
      resourceId: prescription.id, req,
      meta: { lines: dispensedSummary.length, patientId: prescription.patientId, invoiceId: invoice.id },
    });
    if (prescription.patient.userId) {
      await notifyUser({
        userId: prescription.patient.userId,
        title: 'Prescription dispensed',
        body: 'Your medicines are ready. Your updated bill is available in the portal.',
        type: 'BILL',
        link: '/portal/bills',
      });
    }
    const updated = await prisma.prescription.findUnique({
      where: { id: prescription.id },
      include: { items: { include: { drug: true } } },
    });
    res.json({ prescription: updated, dispensed: dispensedSummary, invoiceId: invoice.id });
  }),
);
