/**
 * Canonical roles, permissions and the role -> permission matrix.
 *
 * This file is the single source of truth. It is imported by the API guards
 * (server-side enforcement) and exposed at GET /api/v1/auth/me so the UI can
 * hide what a user cannot do. The UI is *never* the security boundary.
 */

export const ROLES = [
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'LAB_TECH',
  'RECEPTIONIST',
  'BILLING',
  'HR_MANAGER',
  'MEDICAL_RECORDS',
  'IT_ADMIN',
  'DEVICE',
  'AUDITOR',
  'VENDOR',
  'PATIENT',
  'GUARDIAN',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'patient.read',
  'patient.write',
  'patient.export',
  'appointment.read',
  'appointment.write',
  'schedule.manage',
  'queue.read',
  'queue.write',
  'encounter.read',
  'encounter.write',
  'vitals.write',
  'prescription.read',
  'prescription.write',
  'prescription.dispense',
  'drug.read',
  'drug.write',
  'stock.write',
  'lab.read',
  'lab.order',
  'lab.result',
  'invoice.read',
  'invoice.write',
  'payment.record',
  'insurance.manage',
  'ward.read',
  'ward.write',
  'message.read',
  'message.write',
  'report.read',
  'report.financial',
  'user.read',
  'user.write',
  'audit.read',
  'settings.write',
  'external.manage',
  'guardian.manage',
  'breakglass.use',
  'own.read',
  'deidentified.read',
  'device.api',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const P = (list: Permission[]): Permission[] => list;

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  DOCTOR: P([
    'patient.read', 'patient.write', 'appointment.read', 'appointment.write',
    'queue.read', 'queue.write', 'encounter.read', 'encounter.write', 'vitals.write',
    'prescription.read', 'prescription.write', 'lab.read', 'lab.order',
    'invoice.read', 'ward.read', 'message.read', 'message.write',
    'report.read', 'breakglass.use', 'schedule.manage',
  ]),
  NURSE: P([
    'patient.read', 'appointment.read', 'queue.read', 'queue.write',
    'encounter.read', 'vitals.write', 'prescription.read', 'lab.read',
    'ward.read', 'ward.write', 'message.read', 'message.write', 'report.read',
  ]),
  PHARMACIST: P([
    'patient.read', 'prescription.read', 'prescription.dispense',
    'drug.read', 'drug.write', 'stock.write', 'invoice.read',
    'message.read', 'report.read',
  ]),
  LAB_TECH: P([
    'patient.read', 'lab.read', 'lab.result', 'lab.order',
    'message.read', 'report.read',
  ]),
  RECEPTIONIST: P([
    'patient.read', 'patient.write', 'appointment.read', 'appointment.write',
    'queue.read', 'queue.write', 'invoice.read', 'ward.read',
    'message.read', 'message.write', 'report.read', 'guardian.manage',
  ]),
  BILLING: P([
    'patient.read', 'invoice.read', 'invoice.write', 'payment.record',
    'insurance.manage', 'report.read', 'report.financial', 'message.read',
  ]),
  HR_MANAGER: P([
    'user.read', 'user.write', 'schedule.manage', 'appointment.read',
    'report.read', 'audit.read', 'message.read',
  ]),
  MEDICAL_RECORDS: P([
    'patient.read', 'patient.write', 'patient.export', 'encounter.read',
    'prescription.read', 'lab.read', 'invoice.read', 'message.read',
    'report.read', 'audit.read', 'guardian.manage',
  ]),
  // Least privilege by default: IT can administer accounts but cannot read
  // clinical content (no patient.read / encounter.read).
  IT_ADMIN: P([
    'user.read', 'user.write', 'audit.read', 'settings.write',
    'external.manage', 'report.read',
  ]),
  DEVICE: P(['device.api']),
  // Time-limited read-only auditors: audit trail + de-identified aggregates.
  AUDITOR: P(['audit.read', 'deidentified.read', 'report.read']),
  VENDOR: P([]), // scope comes from ExternalAccessGrant
  PATIENT: P(['own.read', 'message.read', 'message.write']),
  GUARDIAN: P(['own.read']),
};

export const STAFF_ROLES: Role[] = ROLES.filter(
  (r) => !['PATIENT', 'GUARDIAN', 'AUDITOR', 'VENDOR'].includes(r),
);

/** Roles whose patient access is limited to specific records. */
export const SCOPED_STAFF_ROLES: Role[] = ['DOCTOR', 'NURSE'];

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Consent scopes a patient can grant a guardian. */
export const GUARDIAN_SCOPES = [
  'appointments',
  'prescriptions',
  'labResults',
  'bills',
  'messages',
  'demographics',
] as const;
export type GuardianScope = (typeof GUARDIAN_SCOPES)[number];

export const PATIENT_PORTAL_ROLES: Role[] = ['PATIENT', 'GUARDIAN'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
