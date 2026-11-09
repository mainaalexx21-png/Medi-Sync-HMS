import type { Actor } from './lib/rbac';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      requestId?: string;
      /** Populated by the auth middleware when the session is near expiry. */
      sessionExpiresAt?: Date;
    }
  }
}

export {};
