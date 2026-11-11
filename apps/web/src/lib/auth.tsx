import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  mustChangePassword?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  jobTitle?: string;
  employeeNo?: string;
  mrn?: string;
  departmentId?: string | null;
  /** CLINICAL | LAB | PHARMACY | ADMIN - scopes the diagnostics role in the UI. */
  departmentType?: string | null;
}

export interface Me {
  user: SessionUser;
  /** Job function inside the CLINICAL role: DOCTOR or NURSE. */
  clinicalRole?: string | null;
  permissions: string[];
  portal: 'staff' | 'patient';
  profile: Profile | null;
  mfaSetupRequired: boolean;
  guardianLinks?: { id: string; relationship: string; scopes: string; patient: { id: string; firstName: string; lastName: string } }[];
  grantScope?: string[] | null;
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  method: string;
  emailHint: string;
}

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string, portal: 'staff' | 'patient') => Promise<MfaChallenge | null>;
  verifyMfa: (mfaToken: string, code: string, channel: 'TOTP' | 'RECOVERY' | 'EMAIL') => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<Me | null>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STAFF_LANDING: Record<string, string> = {
  FRONT_DESK: '/reception',
  CLINICAL: '/dashboard',
  FINANCE: '/billing',
  SYSTEM_ADMIN: '/admin',
  AUDITOR: '/reports',
  VENDOR: '/patients',
};

export function landingFor(me: Me) {
  if (me.portal === 'patient') return '/portal';
  // Diagnostics & Pharmacy work in one role but two different queues.
  if (me.user.role === 'DIAGNOSTICS') {
    return me.profile?.departmentType === 'PHARMACY' ? '/pharmacy' : '/lab';
  }
  return STAFF_LANDING[me.user.role] ?? '/dashboard';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<Me>('/auth/me');
      setMe(data);
      return data;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        // A network/500 problem should not silently log the user out.
        if (error instanceof ApiError && error.status >= 500) console.error(error);
      }
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const login = useCallback(async (email: string, password: string, portal: 'staff' | 'patient') => {
    const res = await api.post<any>('/auth/login', { email, password, portal });
    if (res.mfaRequired) {
      return res as MfaChallenge;
    }
    await reload();
    return null;
  }, [reload]);

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string, channel: 'TOTP' | 'RECOVERY' | 'EMAIL') => {
      await api.post('/auth/mfa/verify', { mfaToken, code, channel });
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setMe(null);
    }
  }, []);

  const can = useCallback((permission: string) => Boolean(me?.permissions.includes(permission)), [me]);

  const value = useMemo(
    () => ({ me, loading, login, verifyMfa, logout, reload, can }),
    [me, loading, login, verifyMfa, logout, reload, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export const ROLE_LABELS: Record<string, string> = {
  FRONT_DESK: 'Front desk & patient services',
  CLINICAL: 'Clinical staff',
  DIAGNOSTICS: 'Diagnostics & pharmacy',
  FINANCE: 'Finance & administration',
  SYSTEM_ADMIN: 'System administration',
  AUDITOR: 'External auditor',
  VENDOR: 'Vendor',
  PATIENT: 'Patient',
  GUARDIAN: 'Guardian',
};

/** Sub-label for the CLINICAL role, e.g. "Clinical staff · Doctor". */
export function jobFunctionLabel(me: Me) {
  if (me.user.role === 'CLINICAL' && me.clinicalRole) {
    return me.clinicalRole === 'DOCTOR' ? 'Doctor' : 'Nurse';
  }
  return null;
}
