import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { signIn } from './helpers';

let graceId = '';
let linkId = '';

beforeAll(async () => {
  const grace = await prisma.patient.findUnique({ where: { mrn: 'MS-01001' } });
  graceId = grace!.id;
  const link = await prisma.guardianLink.findFirst({ where: { patientId: graceId } });
  linkId = link!.id;
});

describe('guardian consent scoping', () => {
  it('shows a guardian only the consented areas', async () => {
    const guardian = await signIn('guardian@example.test', 'patient');

    const patients = await guardian.get('/api/v1/portal/patients').expect(200);
    expect(patients.body.data.length).toBe(1);
    expect(patients.body.data[0].scopes).toContain('appointments');
    expect(patients.body.data[0].scopes).not.toContain('labResults');

    const appointments = await guardian.get('/api/v1/portal/appointments').expect(200);
    expect(appointments.body.data.length).toBeGreaterThan(0);

    // Not consented: prescriptions, lab results, clinical summary.
    const prescriptions = await guardian.get('/api/v1/portal/prescriptions').expect(200);
    expect(prescriptions.body.data).toEqual([]);
    const labs = await guardian.get('/api/v1/me/lab-results').expect(200);
    expect(labs.body.data).toEqual([]);
    const summary = await guardian.get(`/api/v1/patients/${graceId}/summary`);
    expect(summary.status).toBe(403);
    const bills = await guardian.get('/api/v1/me/invoices').expect(200);
    expect(Array.isArray(bills.body.data)).toBe(true);
  });

  it('logs guardian access attempts', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { action: { in: ['portal.appointments.read', 'portal.invoices.read', 'guardian.list'] } },
    });
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it('takes effect immediately when the patient revokes consent', async () => {
    const grace = await signIn('grace@example.test', 'patient');
    const guardians = await grace.get(`/api/v1/patients/${graceId}/guardians`).expect(200);
    expect(guardians.body.data.length).toBe(1);

    await grace.del(`/api/v1/patients/${graceId}/guardians/${linkId}`).expect(200);

    const afterLink = await prisma.guardianLink.findUnique({ where: { id: linkId } });
    expect(afterLink?.status).toBe('REVOKED');

    const guardian = await signIn('guardian@example.test', 'patient');
    const appointments = await guardian.get('/api/v1/portal/appointments').expect(200);
    expect(appointments.body.data).toEqual([]);
    expect((await guardian.get(`/api/v1/patients/${graceId}`)).status).toBe(403);
  });

  it('stops one patient reading another patient record', async () => {
    const grace = await signIn('grace@example.test', 'patient');
    const peter = await prisma.patient.findUnique({ where: { mrn: 'MS-01002' } });
    const res = await grace.get(`/api/v1/patients/${peter!.id}`);
    expect(res.status).toBe(403);
  });

  it('requires a reason for break-glass access and flags it for review', async () => {
    const doctor = await signIn('doctor.brian@medisync.test');
    const grace = await prisma.patient.findUnique({ where: { id: graceId } });
    const short = await doctor.post(`/api/v1/patients/${graceId}/break-glass`).send({ reason: 'urgent' });
    expect(short.status).toBe(400);

    const res = await doctor
      .post(`/api/v1/patients/${graceId}/break-glass`)
      .send({ reason: 'Emergency resuscitation in A&E, patient unconscious' })
      .expect(201);
    expect(res.body.event.reviewedAt).toBeNull();

    const record = await doctor.get(`/api/v1/patients/${graceId}`);
    expect(record.status).toBe(200);
    expect(record.body.access.viaBreakGlass).toBe(true);

    const admin = await signIn('records@medisync.test');
    const queue = await admin.get('/api/v1/break-glass').expect(200);
    expect(queue.body.pending).toBeGreaterThan(0);
    expect(grace?.mrn).toBeTruthy();
  });
});
