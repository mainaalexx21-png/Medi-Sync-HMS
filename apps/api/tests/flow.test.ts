import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { nextWeekdaySlot, signIn } from './helpers';

let doctorStaffId = '';
let graceId = '';
let peterId = '';
let invoiceId = '';
let generalDeptId = '';

async function paracetamolStock() {
  const drug = await prisma.drug.findFirst({ where: { name: 'Paracetamol' } });
  const batches = await prisma.stockBatch.findMany({ where: { drugId: drug!.id, quantity: { gt: 0 } } });
  return batches.reduce((sum, b) => sum + b.quantity, 0);
}

beforeAll(async () => {
  const doctor = await prisma.staff.findFirst({ where: { user: { email: 'doctor.amina@medisync.test' } } });
  const grace = await prisma.patient.findUnique({ where: { mrn: 'MS-01001' } });
  const peter = await prisma.patient.findUnique({ where: { mrn: 'MS-01002' } });
  const dept = await prisma.department.findUnique({ where: { code: 'GEN' } });
  const invoice = await prisma.invoice.findFirst({ where: { number: 'INV-SEED-0001' } });
  doctorStaffId = doctor!.id;
  graceId = grace!.id;
  peterId = peter!.id;
  invoiceId = invoice!.id;
  generalDeptId = dept!.id;
});

describe('appointment booking, queueing and clinical flow', () => {
  it('lets a patient book an available slot and blocks a double booking', async () => {
    const slot = nextWeekdaySlot(11, 0);
    const peter = await signIn('peter@example.test', 'patient');
    const booked = await peter
      .post('/api/v1/appointments')
      .send({ doctorStaffId, startAt: slot.toISOString(), reason: 'Blood pressure review' });
    expect(booked.status).toBe(201);
    expect(booked.body.appointment.patientId).toBe(peterId);
    expect(booked.body.appointment.bookedVia).toBe('PATIENT_PORTAL');

    const grace = await signIn('grace@example.test', 'patient');
    const clash = await grace
      .post('/api/v1/appointments')
      .send({ doctorStaffId, startAt: slot.toISOString() });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/taken|not available|already/i);
  });

  it('rejects bookings outside the doctor rota', async () => {
    const grace = await signIn('grace@example.test', 'patient');
    const sunday = nextWeekdaySlot(11, 0);
    while (sunday.getDay() !== 0) sunday.setDate(sunday.getDate() + 1);
    const res = await grace
      .post('/api/v1/appointments')
      .send({ doctorStaffId, startAt: sunday.toISOString() });
    expect(res.status).toBe(400);
  });

  it('checks a patient in, issues a ticket and reports their queue position', async () => {
    const appointment = await prisma.appointment.findFirst({
      where: { patientId: peterId, doctorStaffId, status: 'BOOKED' },
    });
    expect(appointment).toBeTruthy();

    const reception = await signIn('reception@medisync.test');
    const checkedIn = await reception.post(`/api/v1/appointments/${appointment!.id}/check-in`).send({ priority: 'URGENT' });
    expect(checkedIn.status).toBe(201);
    expect(checkedIn.body.queueEntry.ticketNo).toMatch(/^GE-\d{3}$/);

    const snapshot = await reception.get(`/api/v1/queue?departmentId=${generalDeptId}`).expect(200);
    expect(snapshot.body.waiting.length).toBeGreaterThan(0);
    expect(snapshot.body.waiting[0].priority).toBe('URGENT');

    const peter = await signIn('peter@example.test', 'patient');
    const mine = await peter.get('/api/v1/me/queue').expect(200);
    expect(mine.body.queueEntry.ticketNo).toBe(checkedIn.body.queueEntry.ticketNo);
    expect(mine.body.queueEntry.position).toBeGreaterThan(0);
  });

  it('does not expose the queue to patients as a full list', async () => {
    const peter = await signIn('peter@example.test', 'patient');
    expect((await peter.get(`/api/v1/queue?departmentId=${generalDeptId}`)).status).toBe(403);
  });

  it('lets the doctor open a consultation and auto-generates the bill', async () => {
    const doctor = await signIn('doctor.amina@medisync.test');
    const appointment = await prisma.appointment.findFirst({
      where: { patientId: peterId, doctorStaffId },
      orderBy: { startAt: 'desc' },
    });
    const res = await doctor
      .post('/api/v1/encounters')
      .send({ patientId: peterId, appointmentId: appointment!.id, chiefComplaint: 'Headache and dizziness' })
      .expect(201);
    expect(res.body.encounter.status).toBe('OPEN');
    expect(res.body.invoice.id).toBeTruthy();

    const invoice = await prisma.invoice.findUnique({
      where: { id: res.body.invoice.id },
      include: { items: true },
    });
    expect(invoice?.items.some((i) => i.category === 'CONSULTATION')).toBe(true);
    expect(invoice!.total).toBeGreaterThan(0);
  });

  it('writes a prescription and dispenses it, decrementing stock and charging the bill', async () => {
    const doctor = await signIn('doctor.amina@medisync.test');
    const paracetamol = await prisma.drug.findFirst({ where: { name: 'Paracetamol' } });
    const encounter = await prisma.encounter.findFirst({
      where: { patientId: graceId, status: 'OPEN' },
      orderBy: { startedAt: 'desc' },
    });
    const prescription = await doctor
      .post(`/api/v1/encounters/${encounter!.id}/prescriptions`)
      .send({
        notes: 'Short course for headache',
        items: [{ drugId: paracetamol!.id, dose: '1g', frequency: 'Three times daily', durationDays: 3, quantity: 10 }],
      })
      .expect(201);
    expect(prescription.body.prescription.status).toBe('PENDING');

    const before = await paracetamolStock();
    const pharmacist = await signIn('pharmacist@medisync.test');
    const dispensed = await pharmacist
      .post(`/api/v1/prescriptions/${prescription.body.prescription.id}/dispense`)
      .send({})
      .expect(200);
    expect(dispensed.body.prescription.status).toBe('DISPENSED');
    expect(dispensed.body.dispensed[0].quantity).toBe(10);

    const after = await paracetamolStock();
    expect(before - after).toBe(10);

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: true },
    });
    const medicationLines = invoice!.items.filter((i) => i.category === 'MEDICATION');
    expect(medicationLines.length).toBeGreaterThan(0);

    const movements = await prisma.stockMovement.findMany({
      where: { type: 'DISPENSE', drugId: paracetamol!.id },
    });
    expect(movements.length).toBeGreaterThan(0);
    expect(movements[0].quantity).toBeLessThan(0);
  });

  it('refuses to dispense more than is in stock', async () => {
    const pharmacist = await signIn('pharmacist@medisync.test');
    const ceftriaxone = await prisma.drug.findFirst({ where: { name: 'Ceftriaxone' } });
    const prescription = await prisma.prescription.findFirst({ where: { status: 'PENDING' }, include: { items: true } });
    // A new prescription for 500 units cannot be satisfied from ~12 in stock.
    const doctor = await signIn('doctor.amina@medisync.test');
    const encounter = await prisma.encounter.findFirst({ where: { patientId: graceId, status: 'OPEN' } });
    const created = await doctor
      .post(`/api/v1/encounters/${encounter!.id}/prescriptions`)
      .send({ items: [{ drugId: ceftriaxone!.id, dose: '1g', frequency: 'Daily', durationDays: 1, quantity: 500 }] })
      .expect(201);
    const res = await pharmacist.post(`/api/v1/prescriptions/${created.body.prescription.id}/dispense`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Insufficient stock/i);
    expect(prescription).toBeTruthy();
  });

  it('orders a lab test, records the result and notifies the portal', async () => {
    const doctor = await signIn('doctor.amina@medisync.test');
    const encounter = await prisma.encounter.findFirst({ where: { patientId: graceId, status: 'OPEN' } });
    const test = await prisma.labTest.findFirst({ where: { code: 'MRDT' } });
    const order = await doctor
      .post(`/api/v1/encounters/${encounter!.id}/lab-orders`)
      .send({ testIds: [test!.id], priority: 'URGENT' })
      .expect(201);
    const orderId = order.body.orders[0].id;

    const lab = await signIn('lab@medisync.test');
    await lab.post(`/api/v1/lab-orders/${orderId}/collect`).send({}).expect(200);
    const result = await lab
      .post(`/api/v1/lab-orders/${orderId}/result`)
      .send({ resultValue: 'Negative', flag: 'NORMAL', interpretation: 'No malaria parasites seen' })
      .expect(201);
    expect(result.body.result.flag).toBe('NORMAL');

    const grace = await signIn('grace@example.test', 'patient');
    const myResults = await grace.get('/api/v1/me/lab-results').expect(200);
    expect(myResults.body.data.some((r: any) => r.test === 'Malaria Rapid Test')).toBe(true);
  });

  it('records a payment, updates the balance and renders a PDF receipt', async () => {
    const billing = await signIn('billing@medisync.test');
    const before = await billing.get(`/api/v1/invoices/${invoiceId}`).expect(200);
    const balance = before.body.invoice.balance;
    expect(balance).toBeGreaterThan(0);

    const amount = Math.min(1000, balance);
    const payment = await billing
      .post(`/api/v1/invoices/${invoiceId}/payments`)
      .send({ amount, method: 'MPESA', reference: 'QK47HJ2L9P' })
      .expect(201);
    expect(payment.body.payment.receiptNo).toMatch(/^RCT-/);
    expect(payment.body.invoice.balance).toBeCloseTo(balance - amount, 2);

    const receipt = await billing.get(`/api/v1/invoices/${invoiceId}/receipt`).expect(200);
    expect(receipt.headers['content-type']).toContain('application/pdf');
    expect(receipt.body.length).toBeGreaterThan(800);

    const auditRows = await prisma.auditLog.findMany({ where: { action: 'payment.recorded' } });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0].resource).toBe('payment');
  });

  it('rejects an overpayment', async () => {
    const billing = await signIn('billing@medisync.test');
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    const res = await billing
      .post(`/api/v1/invoices/${invoiceId}/payments`)
      .send({ amount: (invoice?.balance ?? 0) + 10_000, method: 'CASH' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERPAYMENT');
  });

  it('shows the doctor their day schedule', async () => {
    const doctor = await signIn('doctor.amina@medisync.test');
    const today = await doctor.get('/api/v1/doctor/today').expect(200);
    expect(Array.isArray(today.body.appointments)).toBe(true);
    expect(today.body.appointments.length).toBeGreaterThan(0);
    expect(today.body.appointments[0].patient.mrn).toBeTruthy();
  });
});
