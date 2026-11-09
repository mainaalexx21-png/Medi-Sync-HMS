import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { dateOnly, timeOnly } from '../lib/format';
import { useDepartments, usePatients } from '../lib/hooks';
import {
  Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select,
  StatusBadge, Table, useToast,
} from '../components/ui';
import { BookingModal } from './Appointments';

export default function Reception() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [booking, setBooking] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [search, setSearch] = useState('');

  const today = new Date().toISOString().slice(0, 10);
  const appointments = useQuery({
    queryKey: ['reception-appointments', today],
    queryFn: () => api.get<{ data: any[] }>('/appointments', { from: today, pageSize: 100 }),
  });
  const departments = useDepartments();
  const queue = useQuery({
    queryKey: ['reception-queue'],
    queryFn: () => api.get<any>('/queue/stats'),
  });

  const rows = (appointments.data?.data ?? [])
    .filter((a) => a.status !== 'CANCELLED')
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  async function checkIn(id: string, priority = 'NORMAL') {
    try {
      const res = await api.post<any>(`/appointments/${id}/check-in`, { priority });
      toast.push(`Checked in · ticket ${res.queueEntry.ticketNo}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['reception-appointments'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Check-in failed', 'danger');
    }
  }

  const nextUp = rows.filter((a) => ['BOOKED', 'CHECKED_IN'].includes(a.status));

  return (
    <div>
      <PageHeader
        title="Front desk"
        description="Register, book, check in and keep the queue moving."
        actions={
          <>
            <Button onClick={() => setBooking(true)}>Book appointment</Button>
            <Button variant="outline" onClick={() => setWalkIn(true)}>
              Walk-in check-in
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          ['Waiting now', queue.data?.today.waiting ?? 0, 'warning'],
          ['In consultation', queue.data?.today.inProgress ?? 0, 'brand'],
          ['Completed today', queue.data?.today.completed ?? 0, 'success'],
          ['Left to arrive', nextUp.filter((a) => a.status === 'BOOKED').length, 'info'],
        ].map(([label, value, tone]) => (
          <div key={String(label)} className="card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
            <span className="sr-only">{tone}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Today's clinic"
            subtitle={dateOnly(new Date())}
            actions={
              <Button size="sm" variant="outline" onClick={() => appointments.refetch()} loading={appointments.isFetching}>
                Refresh
              </Button>
            }
          />
          {appointments.isLoading ? (
            <Loading />
          ) : rows.length === 0 ? (
            <EmptyState title="No appointments today" description="Book a patient in or register a walk-in." />
          ) : (
            <Table head={['Time', 'Patient', 'Doctor', 'Status', '']}>
              {rows.map((appointment) => (
                <tr key={appointment.id} className="hover:bg-slate-50">
                  <td className="table-cell whitespace-nowrap font-medium">{timeOnly(appointment.startAt)}</td>
                  <td className="table-cell">
                    <Link to={`/patients/${appointment.patient.id}`} className="font-medium text-brand-800 hover:underline">
                      {appointment.patient.firstName} {appointment.patient.lastName}
                    </Link>
                    <p className="font-mono text-xs text-slate-500">{appointment.patient.mrn}</p>
                  </td>
                  <td className="table-cell">Dr {appointment.doctor.lastName}</td>
                  <td className="table-cell">
                    <StatusBadge status={appointment.status} />
                    {appointment.queueEntry && <p className="mt-1 text-xs text-slate-500">Ticket {appointment.queueEntry.ticketNo}</p>}
                  </td>
                  <td className="table-cell text-right">
                    {appointment.status === 'BOOKED' && (
                      <Button size="sm" onClick={() => checkIn(appointment.id)}>
                        Check in
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Fast lookup" subtitle="Find a patient record" />
          <div className="space-y-2 p-4">
            <Input placeholder="Name, MRN or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <PatientLookup search={search} />}
            <div className="pt-2">
              <Link to="/queue" className="text-xs font-medium text-brand-700 hover:underline">
                Open the live queue →
              </Link>
            </div>
          </div>
        </Card>
      </div>

      <BookingModal open={booking} onClose={() => setBooking(false)} />
      <WalkInModal open={walkIn} onClose={() => setWalkIn(false)} departments={departments.data?.data ?? []} />
    </div>
  );
}

function PatientLookup({ search }: { search: string }) {
  const patients = usePatients(search);
  if (patients.isLoading) return <Loading label="Searching…" />;
  const rows = patients.data?.data ?? [];
  if (rows.length === 0) return <p className="text-sm text-slate-500">No matches.</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {rows.slice(0, 6).map((patient) => (
        <li key={patient.id}>
          <Link to={`/patients/${patient.id}`} className="flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-50">
            <span>
              {patient.firstName} {patient.lastName}
            </span>
            <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function WalkInModal({ open, onClose, departments }: { open: boolean; onClose: () => void; departments: any[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [patientId, setPatientId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const patients = usePatients(search);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const res = await api.post<any>('/queue', { patientId, departmentId, priority });
      toast.push(`Added to queue · ticket ${res.queueEntry.ticketNo}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      onClose();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not check in', 'danger');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Walk-in check-in">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Search patient" htmlFor="walk-search">
          <Input id="walk-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, MRN or phone" />
        </Field>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
          {(patients.data?.data ?? []).map((patient) => (
            <button
              type="button"
              key={patient.id}
              onClick={() => setPatientId(patient.id)}
              className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${patientId === patient.id ? 'bg-brand-50' : ''}`}
            >
              <span>
                {patient.firstName} {patient.lastName}
              </span>
              <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
            </button>
          ))}
        </div>
        <Field label="Clinic" htmlFor="walk-dept" required>
          <Select id="walk-dept" required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Select clinic</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Triage priority" htmlFor="walk-priority">
          <Select id="walk-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="NORMAL">Normal</option>
            <option value="URGENT">Urgent</option>
            <option value="EMERGENCY">Emergency</option>
          </Select>
        </Field>
        <Alert tone="info">The patient receives the next available ticket and appears on the clinic's live queue.</Alert>
        <Button type="submit" disabled={!patientId || !departmentId}>
          Issue ticket
        </Button>
      </form>
    </Modal>
  );
}
