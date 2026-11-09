import { prisma } from '../db';
import { Permission, Role, permissionsForRole } from './enums';
import { forbidden } from './errors';

/** Authenticated principal attached to every request. */
export interface Actor {
  id: string;
  email: string;
  role: Role;
  permissions: Permission[];
  sessionId: string;
  staffId?: string | null;
  staffDepartmentId?: string | null;
  patientId?: string | null;
  /** Scopes granted through an ExternalAccessGrant (vendors / auditors). */
  grantScope?: string[];
  grantExpiresAt?: Date | null;
}

export type AccessScope = 'OWN' | 'GUARDIAN' | 'CLINICAL' | 'LIMITED' | 'BILLING' | 'DEIDENTIFIED';

export interface PatientAccess {
  allowed: boolean;
  scope: AccessScope | null;
  guardianScopes: string[];
  viaBreakGlass: boolean;
  reason?: string;
}

export function actorFromUser(user: {
  id: string;
  email: string;
  role: string;
  staff?: { id: string; departmentId: string | null } | null;
  patient?: { id: string } | null;
}, sessionId: string, grantScope?: string[]): Actor {
  const role = user.role as Role;
  const permissions = permissionsForRole(role);
  if (grantScope?.length) {
    for (const raw of grantScope) {
      if ((permissions as string[]).includes(raw)) continue;
      permissions.push(raw as Permission);
    }
  }
  return {
    id: user.id,
    email: user.email,
    role,
    permissions,
    sessionId,
    staffId: user.staff?.id ?? null,
    staffDepartmentId: user.staff?.departmentId ?? null,
    patientId: user.patient?.id ?? null,
    grantScope,
  };
}

export function hasPermission(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/**
 * Per-record authorization. Holding `patient.read` is not enough for a doctor:
 * they must have a care relationship (appointment or encounter) with the
 * patient, or an unexpired break-glass event. This is the core of "deny by
 * default" and is exercised by the automated RBAC tests.
 */
export async function resolvePatientAccess(
  actor: Actor,
  patientId: string,
  need: 'CLINICAL' | 'DEMOGRAPHICS' | 'BILLING' | 'AUDIT' = 'DEMOGRAPHICS',
): Promise<PatientAccess> {
  const deny = (reason: string): PatientAccess => ({
    allowed: false, scope: null, guardianScopes: [], viaBreakGlass: false, reason,
  });

  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { id: true, user: { select: { id: true } } },
  });
  if (!patient) return deny('Patient not found');

  if (actor.role === 'PATIENT') {
    if (actor.patientId === patientId || patient.user?.id === actor.id) {
      return { allowed: true, scope: 'OWN', guardianScopes: [], viaBreakGlass: false };
    }
    return deny('Patients may only access their own record');
  }

  if (actor.role === 'GUARDIAN') {
    const link = await prisma.guardianLink.findFirst({
      where: { patientId, guardianUserId: actor.id, status: 'ACTIVE', revokedAt: null },
    });
    if (!link) return deny('No active guardian consent for this patient');
    return {
      allowed: true,
      scope: 'GUARDIAN',
      guardianScopes: link.scopes.split(',').map((s) => s.trim()).filter(Boolean),
      viaBreakGlass: false,
    };
  }

  if (actor.role === 'AUDITOR') {
    return hasPermission(actor, 'deidentified.read')
      ? { allowed: true, scope: 'DEIDENTIFIED', guardianScopes: [], viaBreakGlass: false }
      : deny('Auditor access is limited to de-identified data');
  }

  if (actor.role === 'VENDOR') {
    const scope = actor.grantScope ?? [];
    if (!scope.includes('patient.read')) return deny('Vendor grant does not include patient data');
    return { allowed: true, scope: 'LIMITED', guardianScopes: [], viaBreakGlass: false };
  }

  // IT administrators deliberately have no clinical access by default.
  if (actor.role === 'IT_ADMIN' || !hasPermission(actor, 'patient.read')) {
    return deny('Role has no patient data permission');
  }

  const clinicalNeed = need === 'CLINICAL';

  if (actor.role === 'DOCTOR') {
    if (!actor.staffId) return deny('No staff profile linked to this account');
    const [appointment, encounter, inMyQueue] = await Promise.all([
      prisma.appointment.findFirst({
        where: { patientId, doctorStaffId: actor.staffId },
        select: { id: true },
      }),
      prisma.encounter.findFirst({
        where: { patientId, doctorStaffId: actor.staffId },
        select: { id: true },
      }),
      prisma.queueEntry.findFirst({
        where: {
          patientId,
          doctorStaffId: actor.staffId,
          status: { in: ['WAITING', 'CALLED', 'IN_CONSULTATION'] },
        },
        select: { id: true },
      }),
    ]);
    if (appointment || encounter || inMyQueue) {
      return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: false };
    }
    if (hasPermission(actor, 'breakglass.use')) {
      const bg = await prisma.breakGlassEvent.findFirst({
        where: {
          userId: actor.id,
          patientId,
          createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
        },
        select: { id: true },
      });
      if (bg) {
        return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: true };
      }
    }
    return deny('No care relationship with this patient');
  }

  if (actor.role === 'NURSE') {
    if (!actor.staffId) return deny('No staff profile linked to this account');
    const table = await prisma.admission.findFirst({
      where: { patientId, status: 'ADMITTED' },
      select: { id: true },
    });
    if (table) return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: false };
    const inQueue = await prisma.queueEntry.findFirst({
      where: {
        patientId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (inQueue) return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: false };
    return deny('Patient is not in your ward or queue');
  }

  if (actor.role === 'BILLING') {
    return need === 'CLINICAL'
      ? deny('Billing staff cannot open clinical notes')
      : { allowed: true, scope: 'BILLING', guardianScopes: [], viaBreakGlass: false };
  }

  // Reception, medical records, pharmacy, lab: demographic/administrative view.
  return {
    allowed: true,
    scope: clinicalNeed && ['MEDICAL_RECORDS', 'PHARMACIST', 'LAB_TECH'].includes(actor.role)
      ? 'LIMITED'
      : clinicalNeed
        ? 'CLINICAL'
        : 'LIMITED',
    guardianScopes: [],
    viaBreakGlass: false,
  };
}

export async function assertPatientAccess(
  actor: Actor,
  patientId: string,
  need: 'CLINICAL' | 'DEMOGRAPHICS' | 'BILLING' | 'AUDIT' = 'DEMOGRAPHICS',
): Promise<PatientAccess> {
  const access = await resolvePatientAccess(actor, patientId, need);
  if (!access.allowed) throw forbidden(access.reason ?? 'No access to this patient record');
  return access;
}

/** Requires a guardian consent scope for portal reads. */
export function assertGuardianScope(access: PatientAccess, scope: string) {
  if (access.scope === 'GUARDIAN' && !access.guardianScopes.includes(scope)) {
    throw forbidden(`The patient has not granted consent for "${scope}"`);
  }
}

/** De-identified projection for auditors and aggregate reports. */
export function deidentify<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...row, pseudonym: `PT-${String(row.id).slice(-6)}` };
  for (const key of [
    'firstName', 'lastName', 'phone', 'email', 'nationalIdEnc', 'nationalIdHash',
    'address', 'emergencyContactName', 'emergencyContactPhone', 'mrn',
  ]) {
    delete clone[key];
  }
  return clone;
}
