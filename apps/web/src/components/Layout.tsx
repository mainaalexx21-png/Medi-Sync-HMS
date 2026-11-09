import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../lib/api';
import { ROLE_LABELS, useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Button, Spinner } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission?: string;
  anyOf?: string[];
  portal?: 'staff' | 'patient';
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: 'M3 12l9-8 9 8M5 10v10h14V10', portal: 'staff' },
  { to: '/doctor', label: 'My day', icon: 'M8 3v4M16 3v4M3 9h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', anyOf: ['encounter.write'] },
  { to: '/reception', label: 'Front desk', icon: 'M4 21V8l8-5 8 5v13M9 21v-6h6v6', anyOf: ['queue.write'] },
  { to: '/patients', label: 'Patients', icon: 'M16 21v-2a4 4 0 00-8 0v2M12 11a4 4 0 100-8 4 4 0 000 8z', anyOf: ['patient.read', 'deidentified.read'] },
  { to: '/appointments', label: 'Appointments', icon: 'M8 3v4M16 3v4M3 9h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', permission: 'appointment.read' },
  { to: '/queue', label: 'Live queue', icon: 'M4 6h16M4 12h10M4 18h7', permission: 'queue.read' },
  { to: '/board', label: 'Waiting board', icon: 'M4 4h16v12H4zM8 20h8M12 16v4', permission: 'queue.read' },
  { to: '/wards', label: 'Wards & beds', icon: 'M3 20V9m0 5h18v6M8 13V9m4 4V9m4 4V9', permission: 'ward.read' },
  { to: '/pharmacy', label: 'Pharmacy', icon: 'M9 3h6l1 6H8l1-6zM6 9h12l-1 12H7L6 9z', anyOf: ['prescription.read', 'drug.read'] },
  { to: '/lab', label: 'Laboratory', icon: 'M9 3v6l-4 8a3 3 0 002.6 4h8.8A3 3 0 0019 17l-4-8V3M9 3h6', permission: 'lab.read' },
  { to: '/billing', label: 'Billing', icon: 'M3 7h18v10H3zM3 11h18M7 15h2', permission: 'invoice.read' },
  { to: '/messages', label: 'Messages', icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z', anyOf: ['message.read', 'own.read'] },
  { to: '/reports', label: 'Reports', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2', permission: 'report.read' },
  { to: '/admin', label: 'Administration', icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z', anyOf: ['user.read', 'audit.read', 'settings.write'] },
  { to: '/security', label: 'Security', icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z', portal: 'staff' },
  { to: '/portal', label: 'Overview', icon: 'M3 12l9-8 9 8M5 10v10h14V10', portal: 'patient', to2: '' } as NavItem,
  { to: '/portal/appointments', label: 'Appointments', icon: 'M8 3v4M16 3v4M3 9h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', portal: 'patient' },
  { to: '/portal/records', label: 'Health records', icon: 'M7 3h10a2 2 0 012 2v16H5V5a2 2 0 012-2zM9 8h6M9 12h6M9 16h3', portal: 'patient' },
  { to: '/portal/bills', label: 'Bills', icon: 'M3 7h18v10H3zM3 11h18M7 15h2', portal: 'patient' },
  { to: '/portal/guardians', label: 'Guardian access', icon: 'M16 21v-2a4 4 0 00-8 0v2M12 11a4 4 0 100-8 4 4 0 000 8z', portal: 'patient' },
  { to: '/security', label: 'Security', icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z', portal: 'patient' },
];

function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx('h-[18px] w-[18px] shrink-0', className)} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: any[]; unread: number }>('/notifications'),
    refetchInterval: 30_000,
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}
        aria-expanded={open}
      >
        <Icon path="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
        {Boolean(data?.unread) && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
            {data!.unread > 9 ? '9+' : data!.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            <button className="text-xs text-brand-700 hover:underline" onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
            {(data?.data ?? []).length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">You're all caught up.</li>}
            {(data?.data ?? []).map((item) => (
              <li key={item.id} className={clsx('px-3 py-2.5', !item.readAt && 'bg-brand-50/50')}>
                <p className="text-sm font-medium text-slate-800">{item.title}</p>
                <p className="mt-0.5 text-xs text-slate-600">{item.body}</p>
                <p className="mt-1 text-[11px] text-slate-400">{dateTime(item.createdAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { me, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  if (!me) return null;

  const items = NAV.filter((item) => {
    if (item.portal && item.portal !== me.portal) return false;
    if (!item.portal && me.portal === 'patient') return false;
    if (item.permission && !can(item.permission)) return false;
    if (item.anyOf && !item.anyOf.some((p) => can(p))) return false;
    return true;
  });

  const displayName = me.profile?.name ?? me.user.email;
  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Mobile header */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <button onClick={() => setMenuOpen(true)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Open menu">
            <Icon path="M4 6h16M4 12h16M4 18h16" className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-brand-900">MEDI SYNC</span>
        </div>
        <NotificationBell />
      </header>

      {/* Sidebar */}
      <aside
        className={clsx(
          'no-print fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-brand-950 text-brand-50 transition-transform lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 py-5">
          <div>
            <p className="text-base font-semibold tracking-tight text-white">MEDI SYNC</p>
            <p className="text-[11px] text-brand-300">{me.portal === 'staff' ? 'Hospital staff portal' : 'Patient portal'}</p>
          </div>
          <button onClick={() => setMenuOpen(false)} className="rounded p-1 text-brand-300 hover:text-white lg:hidden" aria-label="Close menu">
            <Icon path="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4" aria-label="Main navigation">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/portal'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
                  isActive ? 'bg-white/12 font-medium text-white' : 'text-brand-100/80 hover:bg-white/5 hover:text-white',
                )
              }
            >
              <Icon path={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-3 py-3">
          <p className="truncate text-sm font-medium text-white">{displayName}</p>
          <p className="text-[11px] text-brand-300">{roleLabel}</p>
          <button
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
            className="mt-2 w-full rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15"
          >
            Sign out
          </button>
        </div>
      </aside>

      {menuOpen && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 hidden items-center justify-between border-b border-slate-200 bg-white/90 px-6 py-3 backdrop-blur lg:flex">
          <div>
            <p className="text-xs text-slate-500">{me.portal === 'staff' ? 'Staff workspace' : 'Your health, in one place'}</p>
            <p className="text-sm font-medium text-slate-800">{displayName}</p>
          </div>
          <div className="flex items-center gap-3">
            {me.mfaSetupRequired && (
              <NavLink to="/security" className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                Enable two-factor authentication
              </NavLink>
            )}
            <NotificationBell />
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200">{roleLabel}</span>
          </div>
        </header>

        {me.mfaSetupRequired && (
          <div className="no-print border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 lg:hidden">
            Two-factor authentication is required for staff.{' '}
            <NavLink to="/security" className="font-semibold underline">
              Set it up now
            </NavLink>
          </div>
        )}

        <main id="main" className="flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
        <footer className="no-print px-6 py-4 text-xs text-slate-400">
          MEDI SYNC · Data processed under the Kenya Data Protection Act, 2019. Every access to patient records is logged.
        </footer>
      </div>
    </div>
  );
}

export function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-slate-500">
      <Spinner /> Loading your workspace…
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-5xl font-semibold text-brand-800">404</p>
      <p className="text-sm text-slate-600">That page does not exist.</p>
      <Button onClick={() => (window.location.href = '/')}>Back to your dashboard</Button>
    </div>
  );
}
