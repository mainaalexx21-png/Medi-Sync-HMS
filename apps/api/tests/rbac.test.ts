import { describe, expect, it, beforeAll } from 'vitest';
import { prisma } from '../src/db';
import { signIn } from './helpers';

let graceId = '';
let peterId = '';
let generalDeptId = '';

beforeAll(async () => {
  const grace = await prisma.patient.findUnique({ where: { mrn: 'MS-01001' } });
  const peter = await prisma.patient.findUnique({ where: { mrn: 'MS-01002' } });
  const dept = await prisma.department.findUnique({ where: { code: 'GEN' } });
  graceId = grace!.id;
  peterId = peter!.id;
  generalDeptId = dept!.id;
});

describe('role-based access control (server side)', () => {
  it('denies a pharmacist access to the audit trail', async () => {
    const pharmacist = await signIn('pharmacist@medisync.test');
    const res = await pharmacist.get('/api/v1/audit');
    expect(res.status).toBe(403);

    const denied = await prisma.auditLog.findFirst({
      where: { action: 'rbac.denied', outcome: 'DENIED', resource: '/audit' },
      orderBy: { createdAt: 'desc' },
    });
    expect(denied).toBeTruthy();
    expect(denied?.actorRole).toBe('PHARMACIST');
  });

  it('gives IT administrators no clinical data access', async () => {
    const it = await signIn('admin.it@medisync.test');
    expect((await it.get('/api/v1/patients')).status).toBe(403);
    expect((await it.get(`/api/v1/patients/${graceId}`)).status).toBe(403);
    // ...but they can administer users and read the audit trail.
    expect((await it.get('/api/v1/users')).status).toBe(200);
    expect((await it.get('/api/v1/audit')).status).toBe(200);
  });

  it('scopes a doctor to patients with a care relationship', async () => {
    const amina = await signIn('doctor.amina@medisync.test');
    expect((await amina.get(`/api/v1/patients/${graceId}`)).status).toBe(200);

    const brian = await signIn('doctor.brian@medisync.test');
    const denied = await brian.get(`/api/v1/patients/${graceId}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/care relationship/i);
  });

  it('stops billing staff from opening clinical notes but allows invoices', async () => {
    const billing = await signIn('billing@medisync.test');
    expect((await billing.get(`/api/v1/patients/${graceId}/summary`)).status).toBe(403);
    expect((await billing.get(`/api/v1/invoices?patientId=${graceId}`)).status).toBe(200);
    expect((await billing.get('/api/v1/encounters')).status).toBe(403);
  });

  it('serves auditors only de-identified patient data', async () => {
    const auditor = await signIn('auditor@medisync.test');
    const list = await auditor.get('/api/v1/patients');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    const row = list.body.data[0];
    expect(row.firstName).toBeUndefined();
    expect(row.lastName).toBeUndefined();
    expect(row.phone).toBeUndefined();
    expect(row.pseudonym).toMatch(/^PT-/);
  });

  it('holds an expired external grant closed', async () => {
    const grant = await prisma.externalAccessGrant.findFirst({
      where: { user: { email: 'vendor@medisync.test' } },
    });
    expect(grant).toBeTruthy();
    await prisma.externalAccessGrant.update({
      where: { id: grant!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const vendor = await signIn('vendor@medisync.test', 'staff').catch(() => null);
    if (vendor) {
      const res = await vendor.get('/api/v1/patients');
      expect([401, 403]).toContain(res.status);
    }
    await prisma.externalAccessGrant.update({
      where: { id: grant!.id },
      data: { expiresAt: new Date(Date.now() + 24 * 3600_000) },
    });
  });

  it('rejects state-changing requests without a CSRF token', async () => {
    const reception = await signIn('reception@medisync.test');
    const res = await reception.agent.post('/api/v1/notifications/read-all');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/CSRF/i);
  });

  it('lets reception register a patient but not open the audit trail', async () => {
    const reception = await signIn('reception@medisync.test');
    const created = await reception
      .post('/api/v1/patients')
      .send({
        firstName: 'Test',
        lastName: 'Walkin',
        dateOfBirth: '1990-01-01',
        sex: 'MALE',
        phone: '+254700111222',
        consentToProcessing: true,
      })
      .expect(201);
    expect(created.body.patient.mrn).toMatch(/^MS-/);
    expect((await reception.get('/api/v1/audit')).status).toBe(403);
    expect(peterId).toBeTruthy();
    expect(generalDeptId).toBeTruthy();
  });
});
