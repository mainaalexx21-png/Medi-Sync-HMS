import type { Router } from 'express';
import { patientsRouter } from './modules/patients';
import { schedulingRouter } from './modules/scheduling';
import { queueRouter } from './modules/queue';
import { clinicalRouter } from './modules/clinical';
import { pharmacyRouter } from './modules/pharmacy';
import { labRouter } from './modules/lab';
import { billingRouter } from './modules/billing';
import { wardsRouter } from './modules/wards';
import { messagingRouter } from './modules/messaging';
import { reportsRouter } from './modules/reports';
import { adminRouter } from './modules/admin';
import { portalRouter } from './modules/portal';

/**
 * Mount points for the versioned API. Kept separate from index.ts so tests can
 * build the same app without opening a listening socket.
 */
export const apiRouters: Router[] = [
  patientsRouter,
  schedulingRouter,
  queueRouter,
  clinicalRouter,
  pharmacyRouter,
  labRouter,
  billingRouter,
  wardsRouter,
  messagingRouter,
  reportsRouter,
  adminRouter,
  portalRouter,
];
