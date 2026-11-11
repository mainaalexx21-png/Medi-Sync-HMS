/**
 * Canonical roles, permissions and the permission matrix.
 *
 * This file is the single source of truth. It is imported by the API guards
 * (server-side enforcement) and exposed at GET /api/v1/auth/me so the UI can
 * hide what a user cannot do. The UI is *never* the security boundary.
 *
 * The hospital runs on five staff roles, mirroring how the work is distributed:
 *
 *   FRONT_DESK     Front Desk & Patient Services - get patients in, identified
 *                  and booked (registration, demographics, appointments, queue).
 *   CLINICAL       Clinical Staff - diagnose, treat and record care. Doctors and
 *                  nurses share this role; their job function lives in
 *                  `Staff.clinicalRole` and only adds capabilities, never access.
 *   DIAGNOSTICS    Diagnostics & Pharmacy - fulfil clinical orders (laboratory,
 *                  imaging, dispensing). Department type decides lab vs pharmacy.
 *   FINANCE        Finance & Administration - billing, insurance, inventory,
 *                  staff records and rosters, management reporting.
 *   SYSTEM_ADMIN   Administration & audit - accounts, configuration, backups,
 *                  audit review. Deliberately has no patient clinical content.
 *
 * PATIENT and GUARDIAN are portal identities, not staff roles. AUDITOR and
 * VENDOR are not staff roles either: they are grant-only external accounts that
 * can only sign in while a time-limited ExternalAccessGrant is live.
 */

export const ROLES = [
  'FRONT_DESK',
  'CLINICAL',
  'DIAGNOSTICS',
  'FINANCE',
  'SYSTEM_ADMIN',
  'AUDITOR',
  'VENDOR',
  'PATIENT',
  'GUARDIAN',
] as const;
export type Role = (typeof ROLES)[number];

/** Operational staff roles, i.e. every role that can be assigned to an employee. */
export const STAFF_ROLES: Role[] = ['FRONT_DESK', 'CLINICAL', 'DIAGNOSTICS', 'FINANCE', 'SYSTEM_ADMIN'];

/** Time-limited external accounts; access comes from an ExternalAccessGrant. */
export const EXTERNAL_ROLES: Role[] = ['AUDITOR', 'VENDOR'];

/** Portal identities. */
export const PORTAL_ROLES: Role[] = ['PATIENT', 'GUARDIAN'];
export const PATIENT_PORTAL_ROLES: Role[] = PORTAL_ROLES;

/**
 * Job function inside the CLINICAL role. Nurses triage, record vitals and run
 * the ward; doctors additionally diagnose, prescribe, order and admit. This is
 * a capability switch, not a second access role: both see only patients in
 * their care or department.
 */
export const CLINICAL_FUNCTIONS = ['DOCTOR', 'NURSE'] as const;
export type ClinicalFunction = (typeof CLINICAL_FUNCTIONS)[number];

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

/**
 * Everything a role can do in principle. Per-record scoping (which patients a
 * clinician may open) is enforced separately in lib/rbac.ts.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  FRONT_DESK: P([
    'patient.read', 'patient.write', 'patient.export', 'appointment.read', 'appointment.write',
    'queue.read', 'queue.write', 'invoice.read', 'payment.record', 'ward.read',
    'message.read', 'message.write', 'guardian.manage',
  ]),
  // Base clinical capabilities shared by doctors and nurses.
  CLINICAL: P([
    'patient.read', 'appointment.read', 'queue.read', 'encounter.read', 'vitals.write',
    'prescription.read', 'lab.read', 'ward.read', 'message.read', 'message.write',
  ]),
  // Laboratory, imaging and pharmacy: fulfil orders, never diagnose or bill.
  DIAGNOSTICS: P([
    'patient.read', 'lab.read', 'lab.result', 'prescription.read', 'prescription.dispense',
    'drug.read', 'drug.write', 'stock.write', 'message.read',
  ]),
  FINANCE: P([
    'patient.read', 'appointment.read', 'invoice.read', 'invoice.write', 'payment.record',
    'insurance.manage', 'drug.read', 'drug.write', 'stock.write', 'user.read', 'user.write',
    'schedule.manage', 'report.read', 'report.financial', 'message.read',
  ]),
  // Least privilege by default: no patient.read, encounter.read or billing data.
  SYSTEM_ADMIN: P(['user.read', 'user.write', 'audit.read', 'settings.write', 'external.manage']),
  PATIENT: P(['own.read', 'message.read', 'message.write']),
  GUARDIAN: P(['own.read']),
  // Time-limited, read-only audit access to de-identified data.
  AUDITOR: P(['audit.read', 'deidentified.read', 'report.read']),
  VENDOR: P([]), // scope comes from ExternalAccessGrant
};

/** Extra capabilities granted by the clinical job function. */
export const CLINICAL_FUNCTION_PERMISSIONS: Record<ClinicalFunction, Permission[]> = {
  DOCTOR: P([
    'encounter.write', 'prescription.write', 'lab.order', 'appointment.write',
    'schedule.manage', 'ward.write', 'breakglass.use',
  ]),
  NURSE: P(['queue.write', 'ward.write']),
};

/**
 * Effective permissions for a user. The clinical job function only ever adds
 * to the CLINICAL base set, so a nurse can never prescribe by configuration.
 */
export function permissionsForRole(role: Role, clinicalRole?: string | null): Permission[] {
  const base = ROLE_PERMISSIONS[role] ?? [];
  if (role !== 'CLINICAL') return [...base];
  const extra = CLINICAL_FUNCTION_PERMISSIONS[clinicalRole as ClinicalFunction] ?? [];
  return [...base, ...extra.filter((p) => !base.includes(p))];
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

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isStaffRole(value: unknown): value is Role {
  return typeof value === 'string' && STAFF_ROLES.includes(value as Role);
}

export function isClinicalFunction(value: unknown): value is ClinicalFunction {
  return typeof value === 'string' && (CLINICAL_FUNCTIONS as readonly string[]).includes(value);
}
