import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { age, dateOnly, timeOnly } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, StatusBadge, useToast } from '../components/ui';

export default function DoctorToday() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const today = useQuery({
    queryKey: ['doctor-today'],
    queryFn: () => api.get<any>('/doctor/today'),
  });

  async function callNext(id: string) {
    try {
      await api.post(`/queue/${id}/start`);
      toast.push('Patient called in', 'success');
      queryClient.invalidateQueries({ queryKey: ['doctor-today'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not call the patient', 'danger');
    }
  }

  if (today.isLoading) return <Loading label="Loading your clinic…" />;
  const data = today.data;

  return (
    <div>
      <PageHeader
        title="My day"
        description={`${dateOnly(new Date())} · your schedule, your waiting room, your open consultations`}
        actions={
          <Button variant="outline" onClick={() => today.refetch()} loading={today.isFetching}>
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Schedule" subtitle={`${data?.appointments?.length ?? 0} appointments today`} />
          {(data?.appointments ?? []).length === 0 ? (
            <EmptyState title="No appointments today" description="Enjoy the quiet — or open a walk-in consultation." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.appointments.map((appointment: any) => (
                <li key={appointment.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {timeOnly(appointment.startAt)} · {appointment.patient.firstName} {appointment.patient.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {appointment.patient.mrn} · {age(appointment.patient.dateOfBirth)} yrs · {appointment.reason ?? appointment.type.toLowerCase()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={appointment.status} />
                      {appointment.encounter ? (
                        <Link to={`/consultation/${appointment.encounter.id}`}>
                          <Button size="sm" variant="outline">
                            Open note
                          </Button>
                        </Link>
                      ) : (
                        <Link to={`/consultation/new?appointmentId=${appointment.id}&patientId=${appointment.patient.id}`}>
                          <Button size="sm">Start consult</Button>
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="My waiting room" subtitle="Patients checked in for you" />
            {(data?.queue ?? []).length === 0 ? (
              <EmptyState title="Nobody waiting" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.queue.map((entry: any) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">
                        {entry.patient.firstName} {entry.patient.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {entry.ticketNo} · <StatusBadge status={entry.priority} /> · checked in {timeOnly(entry.checkedInAt)}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {entry.status === 'WAITING' && (
                        <Button size="sm" variant="outline" onClick={() => callNext(entry.id)}>
                          Call
                        </Button>
                      )}
                      <Link to={`/consultation/new?patientId=${entry.patient.id}`}>
                        <Button size="sm">Consult</Button>
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Open consultations" subtitle="Notes you have not closed yet" />
            {(data?.openEncounters ?? []).length === 0 ? (
              <EmptyState title="All notes closed" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.openEncounters.map((encounter: any) => (
                  <li key={encounter.id} className="flex items-center justify-between px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium">
                        {encounter.patient.firstName} {encounter.patient.lastName}
                      </p>
                      <p className="text-xs text-slate-500">{encounter.chiefComplaint ?? 'No complaint recorded'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="brand">Open</Badge>
                      <Link to={`/consultation/${encounter.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                        Continue
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
