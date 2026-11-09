import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { Badge, Card, CardHeader, EmptyState, Loading, PageHeader, Stat } from '../../components/ui';

export default function PortalHome() {
  const { me } = useAuth();
  const summary = useQuery({
    queryKey: ['portal-summary'],
    queryFn: () => api.get<any>('/portal/summary'),
    refetchInterval: 30_000,
  });

  if (summary.isLoading) return <Loading label="Loading your health summary…" />;
  const data = summary.data;
  const s = data?.summary;
  const isGuardian = me?.user.role === 'GUARDIAN';

  return (
    <div>
      <PageHeader
        title={isGuardian ? 'People you support' : `Welcome, ${me?.profile?.name?.split(' ')[0] ?? 'there'}`}
        description={
          isGuardian
            ? 'You can see the areas each patient has consented to. They can revoke access at any time.'
            : 'Your appointments, results, prescriptions and bills in one place.'
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {(data?.patients ?? []).map((patient: any) => (
          <div key={patient.id} className="card flex items-center gap-3 px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
              {patient.name.split(' ').map((part: string) => part[0]).join('').slice(0, 2)}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-900">{patient.name}</p>
              <p className="font-mono text-xs text-slate-500">{patient.mrn}</p>
            </div>
            {isGuardian && <Badge tone="brand">{patient.relationship}</Badge>}
          </div>
        ))}
      </div>

      {isGuardian && (data?.patients ?? []).length === 0 && (
        <Card>
          <EmptyState
            title="No consented patients yet"
            description="A patient must grant you guardian access from their portal before you can see anything here."
          />
        </Card>
      )}

      {s && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Next appointment"
            value={s.nextAppointment ? dateTime(s.nextAppointment.startAt) : 'None booked'}
            hint={s.nextAppointment ? `Dr ${s.nextAppointment.doctor.lastName} · ${s.nextAppointment.department.name}` : 'Book one in a few clicks'}
            tone="brand"
          />
          <Stat
            label="Outstanding balance"
            value={s.outstandingBalance === null ? 'Hidden' : money(s.outstandingBalance)}
            hint={s.outstandingBalance === null ? 'Not consented' : 'Bills you can settle online'}
            tone={s.outstandingBalance ? 'danger' : 'success'}
          />
          <Stat
            label="Queue ticket"
            value={s.queueTicket ? s.queueTicket.ticketNo : '—'}
            hint={s.queueTicket ? s.queueTicket.status.toLowerCase().replace('_', ' ') : 'Check in at reception'}
            tone={s.queueTicket ? 'warning' : 'neutral'}
          />
          <Stat label="Results pending" value={s.pendingLabs ?? 'Hidden'} hint="Lab tests in progress" tone="info" />
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Quick actions" />
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {[
              { to: '/portal/appointments', label: 'Book an appointment', hint: 'Choose a doctor and slot' },
              { to: '/portal/records', label: 'View results', hint: 'Prescriptions and lab reports' },
              { to: '/portal/bills', label: 'Pay a bill', hint: 'M-Pesa or card' },
              { to: '/messages', label: 'Message your care team', hint: 'Secure and logged' },
            ].map((link) => (
              <Link key={link.to} to={link.to} className="rounded-xl border border-slate-200 p-3 transition hover:border-brand-300 hover:bg-brand-50/40">
                <p className="text-sm font-medium text-slate-900">{link.label}</p>
                <p className="text-xs text-slate-500">{link.hint}</p>
              </Link>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Your next visit" subtitle="Bring your ID and insurance card" />
          {s?.nextAppointment ? (
            <div className="space-y-2 p-4 text-sm">
              <p className="text-base font-semibold text-slate-900">{dateTime(s.nextAppointment.startAt)}</p>
              <p className="text-slate-600">
                Dr {s.nextAppointment.doctor.firstName} {s.nextAppointment.doctor.lastName} · {s.nextAppointment.department.name}
              </p>
              <p className="text-slate-500">{s.nextAppointment.reason ?? 'General consultation'}</p>
              <Badge tone="info">{s.nextAppointment.status.toLowerCase().replace('_', ' ')}</Badge>
              <div className="pt-2">
                <Link to="/portal/appointments" className="text-sm font-medium text-brand-700 hover:underline">
                  Manage this appointment →
                </Link>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No upcoming appointment"
              description="Book a consultation with your doctor."
              action={
                <Link to="/portal/appointments" className="mt-2 text-sm font-medium text-brand-700 hover:underline">
                  Book now
                </Link>
              }
            />
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Tip: turn on two-factor authentication from <Link to="/security" className="font-medium text-brand-700 hover:underline">Security</Link> to
        protect your medical records.
      </p>
    </div>
  );
}
