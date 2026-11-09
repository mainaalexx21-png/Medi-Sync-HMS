import { Router } from 'express';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { renderReportPdf } from '../lib/pdf';
import { asyncHandler, sendCsv, toCsv } from '../lib/http';
import { requireAuth, requirePermission } from '../middleware/auth';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function range(req: any) {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 30 * 24 * 3600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const error = new Error('Invalid date range');
    (error as any).status = 400;
    throw error;
  }
  return { from, to, label: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}` };
}

async function overview(from: Date, to: Date) {
  const [
    newPatients, appointments, completedAppointments, cancelledAppointments, noShows,
    completedQueue, revenue, outstanding, stockTotal, expiringCount,
    doctorCounts, paymentsByMethod,
  ] = await Promise.all([
    prisma.patient.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.appointment.count({ where: { startAt: { gte: from, lte: to } } }),
    prisma.appointment.count({ where: { startAt: { gte: from, lte: to }, status: 'COMPLETED' } }),
    prisma.appointment.count({ where: { startAt: { gte: from, lte: to }, status: 'CANCELLED' } }),
    prisma.appointment.count({ where: { startAt: { gte: from, lte: to }, status: 'NO_SHOW' } }),
    prisma.queueEntry.findMany({
      where: { checkedInAt: { gte: from, lte: to }, status: 'COMPLETED' },
      select: { checkedInAt: true, startedAt: true, completedAt: true },
    }),
    prisma.payment.aggregate({
      where: { paidAt: { gte: from, lte: to }, status: 'COMPLETED' },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({ where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } }),
    prisma.drug.count({ where: { active: true } }),
    prisma.stockBatch.count({
      where: { quantity: { gt: 0 }, expiryDate: { lte: new Date(Date.now() + 60 * 24 * 3600_000) } },
    }),
    prisma.appointment.groupBy({
      by: ['doctorStaffId'],
      where: { startAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { paidAt: { gte: from, lte: to }, status: 'COMPLETED' },
      _sum: { amount: true },
    }),
  ]);

  const waits = completedQueue
    .filter((q) => q.startedAt)
    .map((q) => (q.startedAt!.getTime() - q.checkedInAt.getTime()) / 60000)
    .filter((m) => m >= 0);
  const consults = completedQueue
    .filter((q) => q.startedAt && q.completedAt)
    .map((q) => (q.completedAt!.getTime() - q.startedAt!.getTime()) / 60000)
    .filter((m) => m >= 0);

  const avg = (list: number[]) =>
    list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(1)) : 0;

  // Low stock needs a per-drug sum; SQLite lacks FILTER, so compute in JS.
  const drugs = await prisma.drug.findMany({ where: { active: true }, select: { id: true, reorderLevel: true } });
  const batches = await prisma.stockBatch.groupBy({ by: ['drugId'], where: { quantity: { gt: 0 } }, _sum: { quantity: true } });
  const stockMap = new Map(batches.map((b) => [b.drugId, b._sum.quantity ?? 0]));
  const lowStock = drugs.filter((d) => (stockMap.get(d.id) ?? 0) <= d.reorderLevel).length;

  return {
    range: { from, to },
    patients: { new: newPatients },
    appointments: {
      total: appointments,
      completed: completedAppointments,
      cancelled: cancelledAppointments,
      noShow: noShows,
      noShowRate: appointments ? Number(((noShows / appointments) * 100).toFixed(1)) : 0,
    },
    queue: {
      completedToday: completedQueue.length,
      avgWaitMinutes: avg(waits),
      avgConsultMinutes: avg(consults),
    },
    revenue: {
      collected: Number((revenue._sum.amount ?? 0).toFixed(2)),
      outstanding: Number((outstanding._sum.balance ?? 0).toFixed(2)),
      unpaidInvoices: outstanding._count._all,
      byMethod: paymentsByMethod.map((p) => ({ method: p.method, amount: Number((p._sum.amount ?? 0).toFixed(2)) })),
      currency: 'KES',
    },
    stock: { catalogSize: stockTotal, lowStock, expiringSoon: expiringCount },
    doctors: { activeWithAppointments: doctorCounts.length },
  };
}

reportsRouter.get(
  '/reports/overview',
  requirePermission('report.read'),
  asyncHandler(async (req, res) => {
    const { from, to, label } = range(req);
    const data = await overview(from, to);
    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'report.overview.read',
      resource: 'report', req, meta: { from: from.toISOString(), to: to.toISOString(), label },
    });
    res.json(data);
  }),
);

reportsRouter.get(
  '/reports/wait-times',
  requirePermission('report.read'),
  asyncHandler(async (req, res) => {
    const { from, to } = range(req);
    const departments = await prisma.department.findMany({ select: { id: true, name: true } });
    const rows = await prisma.queueEntry.findMany({
      where: { checkedInAt: { gte: from, lte: to }, status: 'COMPLETED' },
      select: { departmentId: true, checkedInAt: true, startedAt: true, priority: true },
    });
    const data = departments.map((dept) => {
      const items = rows.filter((r) => r.departmentId === dept.id && r.startedAt);
      const waits = items.map((r) => (r.startedAt!.getTime() - r.checkedInAt.getTime()) / 60000);
      return {
        departmentId: dept.id,
        department: dept.name,
        completed: items.length,
        avgWaitMinutes: waits.length ? Number((waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1)) : 0,
        maxWaitMinutes: waits.length ? Number(Math.max(...waits).toFixed(1)) : 0,
      };
    });
    res.json({ range: { from, to }, data });
  }),
);

reportsRouter.get(
  '/reports/revenue',
  requirePermission('report.financial'),
  asyncHandler(async (req, res) => {
    const { from, to } = range(req);
    const [payments, invoices, byCategory] = await Promise.all([
      prisma.payment.findMany({
        where: { paidAt: { gte: from, lte: to }, status: 'COMPLETED' },
        select: { amount: true, method: true, paidAt: true },
        orderBy: { paidAt: 'asc' },
      }),
      prisma.invoice.findMany({
        where: { issuedAt: { gte: from, lte: to } },
        select: { total: true, balance: true, status: true },
      }),
      prisma.invoiceItem.groupBy({
        by: ['category'],
        where: { invoice: { issuedAt: { gte: from, lte: to } } },
        _sum: { amount: true },
      }),
    ]);
    const byDay = new Map<string, number>();
    for (const payment of payments) {
      const key = payment.paidAt.toISOString().slice(0, 10);
      byDay.set(key, Number(((byDay.get(key) ?? 0) + payment.amount).toFixed(2)));
    }
    const byMethod = new Map<string, number>();
    for (const payment of payments) {
      byMethod.set(payment.method, Number(((byMethod.get(payment.method) ?? 0) + payment.amount).toFixed(2)));
    }
    res.json({
      range: { from, to },
      totals: {
        collected: Number(payments.reduce((a, b) => a + b.amount, 0).toFixed(2)),
        invoiced: Number(invoices.reduce((a, b) => a + b.total, 0).toFixed(2)),
        outstanding: Number(invoices.reduce((a, b) => a + b.balance, 0).toFixed(2)),
        currency: 'KES',
      },
      byDay: [...byDay.entries()].map(([date, amount]) => ({ date, amount })),
      byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, amount })),
      byCategory: byCategory.map((c) => ({ category: c.category, amount: Number((c._sum.amount ?? 0).toFixed(2)) })),
    });
  }),
);

reportsRouter.get(
  '/reports/appointments',
  requirePermission('report.read'),
  asyncHandler(async (req, res) => {
    const { from, to } = range(req);
    const rows = await prisma.appointment.findMany({
      where: { startAt: { gte: from, lte: to } },
      select: {
        doctorStaffId: true, status: true,
        doctor: { select: { firstName: true, lastName: true } },
      },
    });
    const byDoctor = new Map<string, { doctor: string; total: number; completed: number; noShow: number; cancelled: number }>();
    for (const row of rows) {
      const key = row.doctorStaffId;
      const entry = byDoctor.get(key) ?? {
        doctor: `Dr ${row.doctor.firstName} ${row.doctor.lastName}`,
        total: 0, completed: 0, noShow: 0, cancelled: 0,
      };
      entry.total += 1;
      if (row.status === 'COMPLETED') entry.completed += 1;
      if (row.status === 'NO_SHOW') entry.noShow += 1;
      if (row.status === 'CANCELLED') entry.cancelled += 1;
      byDoctor.set(key, entry);
    }
    const data = [...byDoctor.values()].map((d) => ({
      ...d,
      noShowRate: d.total ? Number(((d.noShow / d.total) * 100).toFixed(1)) : 0,
      utilisation: d.total ? Number(((d.completed / d.total) * 100).toFixed(1)) : 0,
    }));
    res.json({ range: { from, to }, data });
  }),
);

reportsRouter.get(
  '/reports/stock',
  requirePermission('report.read'),
  asyncHandler(async (_req, res) => {
    const drugs = await prisma.drug.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    const batches = await prisma.stockBatch.findMany({ where: { quantity: { gt: 0 } } });
    const data = drugs.map((drug) => {
      const drugBatches = batches.filter((b) => b.drugId === drug.id);
      const onHand = drugBatches.reduce((sum, b) => sum + b.quantity, 0);
      return {
        drug: drug.name,
        strength: drug.strength,
        onHand,
        reorderLevel: drug.reorderLevel,
        nearestExpiry: drugBatches.sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime())[0]?.expiryDate ?? null,
        low: onHand <= drug.reorderLevel,
      };
    });
    res.json({ data });
  }),
);

// ---------------------------------------------------------------------------
// Exports (CSV for spreadsheets, PDF for management meetings)
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/reports/export',
  requirePermission('report.read'),
  asyncHandler(async (req, res) => {
    const type = String(req.query.type ?? 'overview');
    const format = String(req.query.format ?? 'csv');
    const { from, to, label } = range(req);

    let headers: string[] = [];
    let rows: (string | number | null)[][] = [];
    let title = 'MEDI SYNC report';
    let columns: { key: string; label: string; width: number; align?: 'left' | 'right' }[] = [];
    let summary: { label: string; value: string }[] = [];

    if (type === 'revenue') {
      if (!req.actor!.permissions.includes('report.financial')) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Financial reports require finance access' } });
      }
      const payments = await prisma.payment.findMany({
        where: { paidAt: { gte: from, lte: to }, status: 'COMPLETED' },
        orderBy: { paidAt: 'asc' },
        include: { invoice: { select: { number: true } } },
      });
      title = 'Revenue report';
      headers = ['Receipt', 'Invoice', 'Date', 'Method', 'Amount (KES)'];
      rows = payments.map((p) => [p.receiptNo, p.invoice.number, p.paidAt.toISOString().slice(0, 10), p.method, p.amount]);
      columns = [
        { key: 'receipt', label: 'Receipt', width: 110 },
        { key: 'invoice', label: 'Invoice', width: 120 },
        { key: 'date', label: 'Date', width: 80 },
        { key: 'method', label: 'Method', width: 80 },
        { key: 'amount', label: 'Amount', width: 90, align: 'right' },
      ];
      summary = [{ label: 'Total collected', value: `KES ${payments.reduce((a, b) => a + b.amount, 0).toFixed(2)}` }];
    } else if (type === 'appointments') {
      const data = await prisma.appointment.findMany({
        where: { startAt: { gte: from, lte: to } },
        orderBy: { startAt: 'asc' },
        include: { patient: { select: { mrn: true } }, doctor: { select: { firstName: true, lastName: true } } },
      });
      title = 'Appointments report';
      headers = ['Date', 'Patient MRN', 'Doctor', 'Status', 'Type'];
      rows = data.map((a) => [
        a.startAt.toISOString().slice(0, 16).replace('T', ' '),
        a.patient.mrn,
        `Dr ${a.doctor.firstName} ${a.doctor.lastName}`,
        a.status,
        a.type,
      ]);
      columns = [
        { key: 'date', label: 'Date', width: 120 },
        { key: 'mrn', label: 'MRN', width: 80 },
        { key: 'doctor', label: 'Doctor', width: 140 },
        { key: 'status', label: 'Status', width: 90 },
        { key: 'type', label: 'Type', width: 90 },
      ];
    } else if (type === 'wait-times') {
      const departments = await prisma.department.findMany({ select: { id: true, name: true } });
      const queue = await prisma.queueEntry.findMany({
        where: { checkedInAt: { gte: from, lte: to }, status: 'COMPLETED' },
        select: { departmentId: true, checkedInAt: true, startedAt: true },
      });
      title = 'Average wait time by department';
      headers = ['Department', 'Completed visits', 'Average wait (min)'];
      const computed = departments.map((dept) => {
        const items = queue.filter((q) => q.departmentId === dept.id && q.startedAt);
        const waits = items.map((q) => (q.startedAt!.getTime() - q.checkedInAt.getTime()) / 60000);
        const avg = waits.length ? Number((waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1)) : 0;
        return { dept: dept.name, completed: items.length, avg };
      });
      rows = computed.map((c) => [c.dept, c.completed, c.avg]);
      columns = [
        { key: 'dept', label: 'Department', width: 180 },
        { key: 'completed', label: 'Visits', width: 80, align: 'right' },
        { key: 'avg', label: 'Avg wait (min)', width: 110, align: 'right' },
      ];
    } else {
      const data = await overview(from, to);
      title = 'Hospital overview';
      headers = ['Metric', 'Value'];
      rows = [
        ['New patients', data.patients.new],
        ['Appointments', data.appointments.total],
        ['Completed appointments', data.appointments.completed],
        ['No-show rate (%)', data.appointments.noShowRate],
        ['Average wait (min)', data.queue.avgWaitMinutes],
        ['Average consult (min)', data.queue.avgConsultMinutes],
        ['Revenue collected (KES)', data.revenue.collected],
        ['Outstanding (KES)', data.revenue.outstanding],
        ['Low stock items', data.stock.lowStock],
        ['Expiring batches', data.stock.expiringSoon],
      ];
      columns = [
        { key: 'metric', label: 'Metric', width: 240 },
        { key: 'value', label: 'Value', width: 120, align: 'right' },
      ];
    }

    await audit({
      actorId: req.actor!.id, actorRole: req.actor!.role, action: 'report.export', resource: 'report',
      req, meta: { type, format, from: from.toISOString(), to: to.toISOString(), rows: rows.length },
    });

    const filename = `medisync-${type}-${from.toISOString().slice(0, 10)}.${format}`;
    if (format === 'pdf') {
      const buffer = await renderReportPdf({
        title,
        subtitle: `${label} · generated by ${req.actor!.role}`,
        columns,
        rows: rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.key, row[i]]))),
        summary,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }
    return sendCsv(res, filename, toCsv(headers, rows));
  }),
);
