import request from 'supertest';
import { authenticator } from 'otplib';
import { createApp, finalizeApp, registerRouters } from '../src/app';
import { apiRouters } from '../src/routes';

export const DEMO_PASSWORD = 'MediSync#2026';
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const app = createApp();
registerRouters(app, apiRouters);
finalizeApp(app);

export interface Api {
  agent: any;
  csrf: string;
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  del: (url: string) => request.Test;
  put: (url: string) => request.Test;
}

/**
 * Signs in through the real endpoints (password + TOTP), keeps the cookie jar
 * and wires the double-submit CSRF header for mutating calls.
 */
export async function signIn(email: string, portal: 'staff' | 'patient' = 'staff'): Promise<Api> {
  const agent: any = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD, portal });
  if (login.status !== 200) {
    throw new Error(`Login failed for ${email}: ${login.status} ${JSON.stringify(login.body)}`);
  }
  if (login.body.mfaRequired) {
    const verify = await agent.post('/api/v1/auth/mfa/verify').send({
      mfaToken: login.body.mfaToken,
      code: authenticator.generate(DEMO_TOTP_SECRET),
      channel: 'TOTP',
    });
    if (verify.status !== 200) {
      throw new Error(`MFA verify failed for ${email}: ${verify.status} ${JSON.stringify(verify.body)}`);
    }
  }
  const csrfRes = await agent.get('/api/v1/auth/csrf');
  const csrf = csrfRes.body.csrfToken as string;
  const withCsrf = (test: request.Test) => test.set('x-csrf-token', csrf);

  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url) => withCsrf(agent.post(url)),
    patch: (url) => withCsrf(agent.patch(url)),
    put: (url) => withCsrf(agent.put(url)),
    del: (url) => withCsrf(agent.delete(url)),
  };
}

/** Next business-day slot aligned to a 20-minute grid. */
export function nextWeekdaySlot(hour: number, minute = 0, daysAhead = 1): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  date.setHours(hour, minute, 0, 0);
  return date;
}
