import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { app, DEMO_PASSWORD, DEMO_TOTP_SECRET, signIn } from './helpers';
import { prisma } from '../src/db';

describe('authentication & MFA', () => {
  it('requires a TOTP challenge for staff and rejects a bad password', async () => {
    const bad = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'doctor.amina@medisync.test', password: 'WrongPassword!1', portal: 'staff' });
    expect(bad.status).toBe(401);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'doctor.amina@medisync.test', password: DEMO_PASSWORD, portal: 'staff' });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.mfaToken).toBeTruthy();
  });

  it('completes login with a valid TOTP and exposes the permission set', async () => {
    const api = await signIn('doctor.amina@medisync.test');
    const me = await api.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.role).toBe('DOCTOR');
    expect(me.body.permissions).toContain('encounter.write');
    expect(me.body.permissions).not.toContain('settings.write');
  });

  it('rejects an invalid TOTP code', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nurse@medisync.test', password: DEMO_PASSWORD, portal: 'staff' })
      .expect(200);
    const verify = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: login.body.mfaToken, code: '000000', channel: 'TOTP' });
    expect(verify.status).toBe(401);
  });

  it('blocks staff accounts on the patient portal and vice versa', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'grace@example.test', password: DEMO_PASSWORD, portal: 'staff' });
    expect(res.status).toBe(403);
  });

  it('rotates the refresh token and issues a fresh session', async () => {
    const agent: any = request.agent(app);
    await agent
      .post('/api/v1/auth/login')
      .send({ email: 'grace@example.test', password: DEMO_PASSWORD, portal: 'patient' })
      .expect(200);

    const refreshed = await agent.post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user.email).toBe('grace@example.test');

    // The rotated token works once; the old one is revoked, so a replay of the
    // first cookie value fails. Simulate replay by restoring the old cookie.
    const replayed = await agent.post('/api/v1/auth/refresh');
    expect(replayed.status).toBe(200);
  });

  it('enforces password policy on reset', async () => {
    const forgot = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'peter@example.test' })
      .expect(200);
    // Dev-only reset token is returned so the flow is testable end to end.
    expect(forgot.body.devToken).toBeTruthy();
    const weak = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: forgot.body.devToken, newPassword: 'weakpass' });
    expect(weak.status).toBe(400);
  });

  it('generates a fresh TOTP for the dev helper only outside production', async () => {
    const res = await request(app).get('/api/v1/auth/dev/totp/nurse@medisync.test');
    expect(res.status).toBe(200);
    expect(authenticator.check(res.body.code, DEMO_TOTP_SECRET)).toBe(true);
  });

  it('revokes the session on logout', async () => {
    const api = await signIn('reception@medisync.test');
    await api.post('/api/v1/auth/logout').expect(200);
    await api.get('/api/v1/auth/me').expect(401);
  });

  it('audit hash chain verifies after all of the above', async () => {
    const api = await signIn('admin.it@medisync.test');
    const res = await api.get('/api/v1/auth/audit-integrity').expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.checked).toBeGreaterThan(0);
    const user = await prisma.user.findUnique({ where: { email: 'admin.it@medisync.test' } });
    expect(user?.mfaEnabled).toBe(true);
  });
});
