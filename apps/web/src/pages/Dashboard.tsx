import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { jobFunctionLabel, landingFor, ROLE_LABELS, useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { Card, CardHeader, EmptyState, Loading, PageHeader, Stat, StatusBadge } from '../components/ui';

const QUICK_LINKS: Record<string, { to: string; label: string; hint: string }[]> = {
  CLINICAL: [
    { to: '/doctor', label: 'My day', hint: 'Schedule and waiting patients' },
    { to: '/patients', label: 'Find a patient', hint: 'Search records by name or MRN' },
    { to: '/queue', label: 'Queue', hint: 'Triage and call the next patient' },
    { to: '/wards', label: 'Wards', hint: 'Admitted patients and beds' },
  ],
  FRONT_DESK: [
    { to: '/reception', label: 'Check in a patient', hint: 'Issue a queue ticket' },
    { to: '/appointments', label: 'Book an appointment', hint: 'Find a free slot' },
    { to: '/patients/new', label: 'Register a patient', hint: 'Create a medical record' },
  ],
  DIAGNOSTICS: [
    { to: '/lab', label: 'Diagnostics worklist', hint: 'Collect samples, imaging and results' },
    { to: '/pharmacy', label: 'Prescriptions', hint: 'Dispense and check stock' },
  ],
  FINANCE: [
    { to: '/billing', label: 'Invoices', hint: 'Outstanding balances and payments' },
    { to: '/pharmacy?tab=stock', label: 'Stock & suppliers', hint: 'Levels, receipts and expiries' },
    { to: '/reports', label: 'Management reports', hint: 'Volume, waits, revenue' },
    { to: '/admin?tab=users', label: 'Staff records & rota', hint: 'Accounts and availability' },
  ],
  SYSTEM_ADMIN: [
    { to: '/admin?tab=users', label: 'Users & roles', hint: 'Accounts and MFA resets' },
    { to: '/admin?tab=audit', label: 'Audit trail', hint: 'Immutable access log' },
    { to: '/admin?tab=settings', label: 'Configuration & backups', hint: 'System settings and runbooks' },
  ],
  AUDITOR: [
    { to: '/reports', label: 'Aggregated reports', hint: 'De-identified metrics' },
    { to: '/admin?tab=audit', label: 'Audit trail', hint: 'Read-only review' },
  ],
  VENDOR: [{ to: '/patients', label: 'Scoped patient lookup', hint: 'Limited fields per grant' }],
};

export default function Dashboard() {
  const { me, can } = useAuth();
  if (!me) return null;

  const overview = useQuery({
    queryKey: ['reports', 'overview'],
    queryFn: () => api.get<any>('/reports/overview'),
    enabled: can('report.read'),
  });

  const queueStats = useQuery({
    queryKey: ['queue-stats'],
    queryFn: () => api.get<any>('/queue/stats'),
    enabled: can('queue.read'),
  });

  const doctorDay = useQuery({
    queryKey: ['doctor-today-cards'],
    queryFn: () => api.get<any>('/doctor/today'),
    enabled: me.clinicalRole === 'DOCTOR',
  });

  const links = QUICK_LINKS[me.user.role] ?? [{ to: landingFor(me), label: 'Your workspace', hint: 'Continue where you left off' }];
  const data = overview.data;

  return (
    <div>
      <PageHeader
        title={`Good day, ${me.profile?.name?.split(' ')[0] ?? 'there'}`}
        description={`${ROLE_LABELS[me.user.role] ?? me.user.role}${jobFunctionLabel(me) ? ` · ${jobFunctionLabel(me)}` : ''} dashboard · MEDI SYNC`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {me.clinicalRole === 'DOCTOR' && doctorDay.data ? (
          <>
            <Stat label="Appointments today" value={doctorDay.data.appointments.length} tone="brand" />
            <Stat label="Waiting now" value={doctorDay.data.queue.filter((q: any) => q.status === 'WAITING').length} tone="warning" />
            <Stat label="Open consultations" value={doctorDay.data.openEncounters.length} tone="info" />
            <Stat label="Completed today" value={doctorDay.data.appointments.filter((a: any) => a.status === 'COMPLETED').length} tone="success" />
          </>
        ) : data ? (
          <>
            <Stat label="New patients (30d)" value={data.patients.new} tone="brand" />
            <Stat label="Average wait" value={`${data.queue.avgWaitMinutes} min`} hint="Check-in to consultation" tone={data.queue.avgWaitMinutes > 30 ? 'warning' : 'success'} />
            <Stat label="Revenue collected" value={money(data.revenue.collected)} hint="Last 30 days" tone="success" />
            <Stat label="Outstanding bills" value={money(data.revenue.outstanding)} hint={`${data.revenue.unpaidInvoices} invoices`} tone={data.revenue.outstanding > 0 ? 'danger' : 'neutral'} />
          </>
        ) : can('queue.read') && queueStats.data ? (
          <>
            <Stat label="Waiting now" value={queueStats.data.today.waiting} tone="warning" />
            <Stat label="In consultation" value={queueStats.data.today.inProgress} tone="brand" />
            <Stat label="Completed today" value={queueStats.data.today.completed} tone="success" />
            <Stat label="Average wait" value={`${queueStats.data.avgWaitMinutes} min`} tone="info" />
          </>
        ) : (
          <div className="sm:col-span-2 xl:col-span-4">
            <Card className="p-4 text-sm text-slate-600">
              Your dashboard shows the tools your role can use. Use the menu to get started.
            </Card>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Quick actions" subtitle="The tasks your role does most often" />
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            {links.map((link) => (
              <Link key={link.to} to={link.to} className="rounded-xl border border-slate-200 p-3 transition hover:border-brand-300 hover:bg-brand-50/40">
                <p className="text-sm font-medium text-slate-900">{link.label}</p>
                <p className="mt-0.5 text-xs text-slate-500">{link.hint}</p>
              </Link>
            ))}
          </div>
          {me.clinicalRole === 'DOCTOR' && doctorDay.data && (
            <div className="border-t border-slate-100 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next patients</p>
              <ul className="mt-2 divide-y divide-slate-100">
                {doctorDay.data.appointments.slice(0, 4).map((appointment: any) => (
                  <li key={appointment.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div>
                      <p className="font-medium text-slate-800">
                        {appointment.patient.firstName} {appointment.patient.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {appointment.patient.mrn} · {new Date(appointment.startAt).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={appointment.status} />
                      {appointment.encounter ? (
                        <Link to={`/consultation/${appointment.encounter.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                          Open
                        </Link>
                      ) : (
                        <Link to={`/consultation/new?appointmentId=${appointment.id}&patientId=${appointment.patient.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                          Start
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Stock alerts" subtitle="Live from the pharmacy" />
          {!can('drug.read') ? (
            <EmptyState title="Not available" description="Pharmacy stock is visible to pharmacy and management roles." />
          ) : (
            <StockAlerts />
          )}
        </Card>
      </div>
    </div>
  );
}

function StockAlerts() {
  const { data, isLoading } = useQuery({
    queryKey: ['stock-alerts', 'dashboard'],
    queryFn: () => api.get<any>('/stock/alerts'),
  });
  if (isLoading) return <Loading />;
  const counts = data?.counts ?? { lowStock: 0, expiringSoon: 0, expired: 0 };
  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-slate-600">Low stock items</span>
        <span className="font-semibold text-amber-700">{counts.lowStock}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-slate-600">Expiring within 60 days</span>
        <span className="font-semibold text-brand-700">{counts.expiringSoon}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-slate-600">Already expired</span>
        <span className="font-semibold text-rose-700">{counts.expired}</span>
      </div>
      <Link to="/pharmacy?tab=stock" className="inline-block pt-1 text-xs font-medium text-brand-700 hover:underline">
        Review stock →
      </Link>
    </div>
  );
}
