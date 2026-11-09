import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime, timeOnly, todayInput } from '../lib/format';
import { useDepartments, useDoctors, usePatients } from '../lib/hooks';
import {
  Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select,
  StatusBadge, Table, useToast,
} from '../components/ui';

export function BookingModal({
  open,
  onClose,
  presetPatientId,
}: {
  open: boolean;
  onClose: () => void;
  presetPatientId?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const [patientId, setPatientId] = useState(presetPatientId ?? '');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [doctorStaffId, setDoctorStaffId] = useState('');
  const [date, setDate] = useState(todayInput());
  const [slot, setSlot] = useState('');
  const [type, setType] = useState('CONSULTATION');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const departments = useDepartments();
  const doctors = useDoctors(departmentId || undefined);
  const patients = usePatients(search);
  const availability = useQuery({
    queryKey: ['availability', doctorStaffId, date],
    queryFn: () => api.get<{ slots: any[] }>('/availability', { doctorStaffId, date }),
    enabled: Boolean(doctorStaffId && date),
  });

  const isPatientUser = me?.portal === 'patient';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/appointments', {
        patientId: patientId || undefined,
        doctorStaffId,
        startAt: slot,
        type,
        reason: reason || undefined,
      });
      toast.push('Appointment booked', 'success');
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['availability'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not book this appointment');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Book an appointment" wide>
      <form className="space-y-4" onSubmit={submit}>
        {!isPatientUser && !presetPatientId && (
          <div>
            <Field label="Find the patient" htmlFor="p-search" hint="Search by name, MRN or phone">
              <Input id="p-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Start typing…" />
            </Field>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-slate-200">
              {(patients.data?.data ?? []).map((patient) => (
                <button
                  type="button"
                  key={patient.id}
                  onClick={() => setPatientId(patient.id)}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${patientId === patient.id ? 'bg-brand-50' : ''}`}
                >
                  <span>
                    {patient.firstName} {patient.lastName}
                  </span>
                  <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
                </button>
              ))}
              {(patients.data?.data ?? []).length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No matches.</p>}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Department" htmlFor="dept">
            <Select
              id="dept"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setDoctorStaffId('');
                setSlot('');
              }}
            >
              <option value="">All departments</option>
              {(departments.data?.data ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Doctor" htmlFor="doctor" required>
            <Select
              id="doctor"
              required
              value={doctorStaffId}
              onChange={(e) => {
                setDoctorStaffId(e.target.value);
                setSlot('');
              }}
            >
              <option value="">Select a doctor</option>
              {(doctors.data?.data ?? []).map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  Dr {doctor.firstName} {doctor.lastName} — {doctor.jobTitle}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" htmlFor="date" required>
            <Input
              id="date"
              type="date"
              required
              min={todayInput()}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setSlot('');
              }}
            />
          </Field>
          <Field label="Visit type" htmlFor="type">
            <Select id="type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="CONSULTATION">Consultation</option>
              <option value="FOLLOW_UP">Follow-up</option>
              <option value="PROCEDURE">Procedure</option>
              <option value="TELEHEALTH">Telehealth</option>
            </Select>
          </Field>
        </div>

        <div>
          <p className="label">Available slots</p>
          {availability.isLoading && <Loading label="Checking the doctor's rota…" />}
          {availability.data && availability.data.slots.length === 0 && (
            <Alert tone="info">No clinics scheduled for that day. Try another date.</Alert>
          )}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {(availability.data?.slots ?? []).map((option) => (
              <button
                type="button"
                key={option.startAt}
                disabled={!option.available}
                onClick={() => setSlot(option.startAt)}
                className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                  slot === option.startAt
                    ? 'border-brand-700 bg-brand-700 text-white'
                    : option.available
                      ? 'border-slate-200 text-slate-700 hover:border-brand-400'
                      : 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300 line-through'
                }`}
              >
                {timeOnly(option.startAt)}
              </button>
            ))}
          </div>
        </div>

        <Field label="Reason for visit" htmlFor="reason">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Persistent cough" />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!doctorStaffId || !slot}>
            Confirm booking
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Appointments() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState('');
  const [booking, setBooking] = useState(false);

  const query = useQuery({
    queryKey: ['appointments', status, from, to],
    queryFn: () => api.get<{ data: any[]; pagination: any }>('/appointments', { status, from, to, pageSize: 50 }),
  });

  const rows = query.data?.data ?? [];

  async function checkIn(id: string) {
    try {
      const res = await api.post<any>(`/appointments/${id}/check-in`, { priority: 'NORMAL' });
      toast.push(`Checked in · ticket ${res.queueEntry.ticketNo}`, 'success');
      query.refetch();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Check-in failed', 'danger');
    }
  }

  async function cancel(id: string) {
    const reason = window.prompt('Reason for cancelling this appointment?');
    if (!reason) return;
    try {
      await api.post(`/appointments/${id}/cancel`, { reason });
      toast.push('Appointment cancelled', 'success');
      query.refetch();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not cancel', 'danger');
    }
  }

  return (
    <div>
      <PageHeader
        title="Appointments"
        description="Book, reschedule and check patients in. Slots follow each doctor's rota."
        actions={can('appointment.write') && <Button onClick={() => setBooking(true)}>Book appointment</Button>}
      />

      <Card>
        <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-4">
          <Field label="From" htmlFor="from">
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="to">
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {['BOOKED', 'CHECKED_IN', 'IN_CONSULTATION', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map((option) => (
                <option key={option} value={option}>
                  {option.toLowerCase().replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => query.refetch()} loading={query.isFetching}>
              Refresh
            </Button>
          </div>
        </div>

        {query.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No appointments" description="Try widening the date range or book a new appointment." />
        ) : (
          <Table head={['When', 'Patient', 'Doctor', 'Type', 'Status', 'Actions']}>
            {rows.map((appointment) => (
              <tr key={appointment.id} className="hover:bg-slate-50">
                <td className="table-cell whitespace-nowrap">
                  <p className="font-medium">{timeOnly(appointment.startAt)}</p>
                  <p className="text-xs text-slate-500">{dateOnly(appointment.startAt)}</p>
                </td>
                <td className="table-cell">
                  <p className="font-medium text-slate-800">
                    {appointment.patient.firstName} {appointment.patient.lastName}
                  </p>
                  <p className="font-mono text-xs text-slate-500">{appointment.patient.mrn}</p>
                </td>
                <td className="table-cell">Dr {appointment.doctor.lastName}</td>
                <td className="table-cell text-xs">{appointment.type.toLowerCase().replace('_', ' ')}</td>
                <td className="table-cell">
                  <StatusBadge status={appointment.status} />
                  {appointment.queueEntry && <p className="mt-1 text-xs text-slate-500">Ticket {appointment.queueEntry.ticketNo}</p>}
                </td>
                <td className="table-cell">
                  <div className="flex flex-wrap gap-1.5">
                    {can('queue.write') && ['BOOKED'].includes(appointment.status) && (
                      <Button size="sm" onClick={() => checkIn(appointment.id)}>
                        Check in
                      </Button>
                    )}
                    {can('appointment.write') && ['BOOKED', 'CHECKED_IN'].includes(appointment.status) && (
                      <Button size="sm" variant="outline" onClick={() => cancel(appointment.id)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <BookingModal open={booking} onClose={() => setBooking(false)} />
    </div>
  );
}
