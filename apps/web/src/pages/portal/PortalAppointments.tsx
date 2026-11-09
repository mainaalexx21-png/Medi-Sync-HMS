import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { dateOnly, timeOnly } from '../../lib/format';
import { BookingModal } from '../Appointments';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, StatusBadge, useToast } from '../../components/ui';

export default function PortalAppointments() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [booking, setBooking] = useState(false);

  const appointments = useQuery({
    queryKey: ['portal-appointments'],
    queryFn: () => api.get<{ data: any[] }>('/portal/appointments'),
    refetchInterval: 60_000,
  });

  async function cancel(id: string) {
    const reason = window.prompt('Why are you cancelling? (optional)') ?? 'Cancelled by patient';
    try {
      await api.post(`/appointments/${id}/cancel`, { reason });
      toast.push('Appointment cancelled', 'success');
      queryClient.invalidateQueries({ queryKey: ['portal-appointments'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not cancel', 'danger');
    }
  }

  const now = Date.now();
  const upcoming = (appointments.data?.data ?? []).filter(
    (a) => new Date(a.startAt).getTime() >= now && !['CANCELLED', 'COMPLETED'].includes(a.status),
  );
  const past = (appointments.data?.data ?? []).filter(
    (a) => new Date(a.startAt).getTime() < now || ['CANCELLED', 'COMPLETED'].includes(a.status),
  );

  return (
    <div>
      <PageHeader
        title="Appointments"
        description="Book, review and cancel your visits. Reminders are sent by email and SMS."
        actions={<Button onClick={() => setBooking(true)}>Book appointment</Button>}
      />

      <div className="space-y-4">
        <Card>
          <CardHeader title="Upcoming" subtitle={`${upcoming.length} appointment(s)`} />
          {appointments.isLoading ? (
            <Loading />
          ) : upcoming.length === 0 ? (
            <EmptyState
              title="No upcoming appointments"
              description="Pick a doctor and a time that works for you."
              action={<Button className="mt-2" onClick={() => setBooking(true)}>Book an appointment</Button>}
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {upcoming.map((appointment) => (
                <li key={appointment.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {dateOnly(appointment.startAt)} · {timeOnly(appointment.startAt)}
                      </p>
                      <p className="text-sm text-slate-600">
                        Dr {appointment.doctor.firstName} {appointment.doctor.lastName} · {appointment.department.name}
                      </p>
                      <p className="text-xs text-slate-500">{appointment.reason ?? appointment.type.toLowerCase()}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge status={appointment.status} />
                      {appointment.queueEntry && <Badge tone="warning">Ticket {appointment.queueEntry.ticketNo}</Badge>}
                      {['BOOKED'].includes(appointment.status) && (
                        <Button size="sm" variant="outline" onClick={() => cancel(appointment.id)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Past appointments" />
          {past.length === 0 ? (
            <EmptyState title="No past appointments" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {past.slice(0, 15).map((appointment) => (
                <li key={appointment.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div>
                    <p className="text-slate-700">
                      {dateOnly(appointment.startAt)} · Dr {appointment.doctor.lastName}
                    </p>
                    <p className="text-xs text-slate-500">{appointment.department.name}</p>
                  </div>
                  <StatusBadge status={appointment.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Alert tone="info">
        Arrive 10 minutes early and check in at reception. You'll receive a queue ticket with an estimated wait.
      </Alert>

      <BookingModal open={booking} onClose={() => setBooking(false)} />
    </div>
  );
}
