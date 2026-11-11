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
  /** Department type (CLINICAL | LAB | PHARMACY | ADMIN) used for in-role scoping. */
  staffDepartmentType?: string | null;
  /** Job function inside the CLINICAL role: DOCTOR or NURSE. */
  clinicalRole?: string | null;
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
  staff?: {
    id: string;
    departmentId: string | null;
    clinicalRole?: string | null;
    department?: { type: string } | null;
  } | null;
  patient?: { id: string } | null;
}, sessionId: string, grantScope?: string[]): Actor {
  const role = user.role as Role;
  const clinicalRole = user.staff?.clinicalRole ?? null;
  const permissions = permissionsForRole(role, clinicalRole);
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
    staffDepartmentType: user.staff?.department?.type ?? null,
    clinicalRole,
    patientId: user.patient?.id ?? null,
    grantScope,
  };
}

export function hasPermission(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/**
 * Diagnostics & Pharmacy is a single role covering laboratory, imaging and
 * pharmacy staff. Which half a user works in is decided by their department, so
 * a pharmacist cannot verify a lab result and a lab technologist cannot dispense.
 */
export function assertDepartmentType(actor: Actor, ...types: string[]) {
  if (!types.includes(actor.staffDepartmentType ?? '')) {
    throw forbidden(`This action is limited to the ${types.join(' / ')} department`);
  }
}

/**
 * Per-record authorization. Holding `patient.read` is not enough for a
 * clinician: they must have a care relationship (appointment, encounter, ward
 * or queue in their department) with the patient, or an unexpired break-glass
 * event. This is the core of "deny by default" and is exercised by the
 * automated RBAC tests.
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

  // System administrators deliberately have no clinical access at all.
  if (actor.role === 'SYSTEM_ADMIN' || !hasPermission(actor, 'patient.read')) {
    return deny('Role has no patient data permission');
  }

  const clinicalNeed = need === 'CLINICAL';

  /**
   * Clinical staff see only patients in their care or department. The job
   * function decides how that relationship is proven - doctors by their own
   * appointments, encounters and queue; nurses by the ward and the shared
   * department queue.
   */
  if (actor.role === 'CLINICAL') {
    if (!actor.staffId) return deny('No staff profile linked to this account');
    if (actor.clinicalRole === 'DOCTOR') {
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

    if (actor.clinicalRole === 'NURSE') {
      const admitted = await prisma.admission.findFirst({
        where: { patientId, status: 'ADMITTED' },
        select: { id: true },
      });
      if (admitted) return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: false };

      const recentInDepartment = await prisma.queueEntry.findFirst({
        where: {
          patientId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          ...(actor.staffDepartmentId ? { departmentId: actor.staffDepartmentId } : {}),
        },
        select: { id: true },
      });
      if (recentInDepartment) {
        return { allowed: true, scope: 'CLINICAL', guardianScopes: [], viaBreakGlass: false };
      }
      return deny('Patient is not in your ward or department queue');
    }

    return deny('Clinical job function is not configured for this account');
  }

  if (actor.role === 'DIAGNOSTICS') {
    // Minimal demographics plus allergies so orders can be fulfilled safely;
    // clinical notes stay closed.
    return { allowed: true, scope: 'LIMITED', guardianScopes: [], viaBreakGlass: false };
  }

  if (actor.role === 'FINANCE') {
    return clinicalNeed
      ? deny('Finance staff cannot open clinical notes')
      : { allowed: true, scope: 'BILLING', guardianScopes: [], viaBreakGlass: false };
  }

  if (actor.role === 'FRONT_DESK') {
    return clinicalNeed
      ? deny('Front desk staff cannot open clinical notes')
      : { allowed: true, scope: 'LIMITED', guardianScopes: [], viaBreakGlass: false };
  }

  return deny('Role has no patient data permission');
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
