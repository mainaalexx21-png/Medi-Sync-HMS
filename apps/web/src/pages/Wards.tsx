import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { age, dateTime } from '../lib/format';
import { usePatients } from '../lib/hooks';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Stat, StatusBadge, Table, Tabs, Textarea, useToast,
} from '../components/ui';

export default function Wards() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('beds');
  const [admitting, setAdmitting] = useState<{ wardId: string; bedId: string } | null>(null);
  const [admission, setAdmission] = useState({ patientId: '', reason: '', doctorStaffId: '', dailyRate: '0' });
  const [search, setSearch] = useState('');
  const patients = usePatients(search);
  const [discharging, setDischarging] = useState<any | null>(null);
  const [summary, setSummary] = useState('');

  const wards = useQuery({
    queryKey: ['wards'],
    queryFn: () => api.get<{ data: any[] }>('/wards'),
  });
  const admissions = useQuery({
    queryKey: ['admissions'],
    queryFn: () => api.get<{ data: any[] }>('/admissions', { status: 'ADMITTED' }),
  });

  const beds = (wards.data?.data ?? []).flatMap((ward) => ward.beds.map((bed: any) => ({ ...bed, ward })));
  const occupied = beds.filter((bed) => bed.status === 'OCCUPIED').length;

  async function admit(event: React.FormEvent) {
    event.preventDefault();
    if (!admitting) return;
    try {
      await api.post('/admissions', {
        patientId: admission.patientId,
        wardId: admitting.wardId,
        bedId: admitting.bedId,
        reason: admission.reason,
        doctorStaffId: admission.doctorStaffId || undefined,
        dailyRate: Number(admission.dailyRate || 0),
      });
      toast.push('Patient admitted', 'success');
      setAdmitting(null);
      setAdmission({ patientId: '', reason: '', doctorStaffId: '', dailyRate: '0' });
      queryClient.invalidateQueries({ queryKey: ['wards'] });
      queryClient.invalidateQueries({ queryKey: ['admissions'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not admit the patient', 'danger');
    }
  }

  async function discharge(event: React.FormEvent) {
    event.preventDefault();
    if (!discharging) return;
    try {
      await api.post(`/admissions/${discharging.id}/discharge`, { dischargeSummary: summary });
      toast.push('Patient discharged; bed marked for cleaning', 'success');
      setDischarging(null);
      setSummary('');
      queryClient.invalidateQueries({ queryKey: ['wards'] });
      queryClient.invalidateQueries({ queryKey: ['admissions'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not discharge', 'danger');
    }
  }

  return (
    <div>
      <PageHeader title="Wards & beds" description="Live bed board, admissions and discharges." />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Beds" value={beds.length} />
        <Stat label="Occupied" value={occupied} tone="brand" />
        <Stat label="Available" value={beds.filter((b) => b.status === 'AVAILABLE').length} tone="success" />
        <Stat label="Cleaning / maintenance" value={beds.filter((b) => ['CLEANING', 'MAINTENANCE'].includes(b.status)).length} tone="warning" />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'beds', label: 'Bed board' }, { id: 'admissions', label: 'Inpatients' }]} />

      <div className="mt-3">
        {tab === 'beds' && (
          wards.isLoading ? (
            <Loading />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {(wards.data?.data ?? []).map((ward) => (
                <Card key={ward.id}>
                  <CardHeader
                    title={ward.name}
                    subtitle={`${ward.occupied} of ${ward.beds.length} beds occupied · ${ward.floor ?? ''}`}
                  />
                  <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
                    {ward.beds.map((bed: any) => (
                      <div
                        key={bed.id}
                        className={`rounded-lg border p-2.5 text-xs ${
                          bed.status === 'OCCUPIED'
                            ? 'border-brand-200 bg-brand-50'
                            : bed.status === 'AVAILABLE'
                              ? 'border-slate-200 bg-white'
                              : 'border-amber-200 bg-amber-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-slate-800">{bed.label}</p>
                          <StatusBadge status={bed.status} />
                        </div>
                        {bed.patient ? (
                          <div className="mt-1">
                            <p className="font-medium text-slate-800">
                              {bed.patient.firstName} {bed.patient.lastName}
                            </p>
                            <p className="text-slate-500">
                              {bed.patient.mrn} · {age(bed.patient.dateOfBirth)} yrs
                            </p>
                            {bed.admissionId && (
                              <button
                                className="mt-1 text-brand-700 hover:underline"
                                onClick={() => {
                                  const record = (admissions.data?.data ?? []).find((a) => a.id === bed.admissionId);
                                  setDischarging(record ?? { id: bed.admissionId });
                                }}
                              >
                                Discharge
                              </button>
                            )}
                          </div>
                        ) : bed.status === 'AVAILABLE' ? (
                          <button
                            className="mt-1 text-brand-700 hover:underline"
                            onClick={() => setAdmitting({ wardId: ward.id, bedId: bed.id })}
                          >
                            Admit patient
                          </button>
                        ) : (
                          <p className="mt-1 text-slate-500">Not available</p>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )
        )}

        {tab === 'admissions' && (
          <Card>
            <CardHeader title="Current inpatients" subtitle={`${admissions.data?.data?.length ?? 0} admitted`} />
            {admissions.isLoading ? (
              <Loading />
            ) : (admissions.data?.data ?? []).length === 0 ? (
              <EmptyState title="No inpatients" />
            ) : (
              <Table head={['Patient', 'Ward', 'Bed', 'Doctor', 'Admitted', 'Reason', '']}>
                {admissions.data!.data.map((admission: any) => (
                  <tr key={admission.id}>
                    <td className="table-cell">
                      <p className="font-medium">
                        {admission.patient.firstName} {admission.patient.lastName}
                      </p>
                      <p className="font-mono text-xs text-slate-500">{admission.patient.mrn}</p>
                    </td>
                    <td className="table-cell">{admission.ward.name}</td>
                    <td className="table-cell">{admission.bed.label}</td>
                    <td className="table-cell text-xs">
                      {admission.doctor ? `Dr ${admission.doctor.firstName} ${admission.doctor.lastName}` : '—'}
                    </td>
                    <td className="table-cell text-xs">{dateTime(admission.admittedAt)}</td>
                    <td className="table-cell text-xs text-slate-600">{admission.reason}</td>
                    <td className="table-cell text-right">
                      <Button size="sm" variant="outline" onClick={() => setDischarging(admission)}>
                        Discharge
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </div>

      <Modal open={Boolean(admitting)} onClose={() => setAdmitting(null)} title="Admit a patient">
        <form className="space-y-3" onSubmit={admit}>
          <Field label="Search patient" htmlFor="adm-search">
            <Input id="adm-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, MRN or phone" />
          </Field>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200">
            {(patients.data?.data ?? []).map((patient) => (
              <button
                type="button"
                key={patient.id}
                onClick={() => setAdmission({ ...admission, patientId: patient.id })}
                className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${admission.patientId === patient.id ? 'bg-brand-50' : ''}`}
              >
                <span>
                  {patient.firstName} {patient.lastName}
                </span>
                <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
              </button>
            ))}
          </div>
          <Field label="Reason for admission" htmlFor="adm-reason" required>
            <Textarea id="adm-reason" required value={admission.reason} onChange={(e) => setAdmission({ ...admission, reason: e.target.value })} />
          </Field>
          <Field label="Daily bed rate (KES, optional)" htmlFor="adm-rate">
            <Input id="adm-rate" type="number" min="0" value={admission.dailyRate} onChange={(e) => setAdmission({ ...admission, dailyRate: e.target.value })} />
          </Field>
          <Alert tone="info">The bed is claimed atomically, so two staff cannot admit to the same bed.</Alert>
          <Button type="submit" disabled={!admission.patientId}>
            Admit patient
          </Button>
        </form>
      </Modal>

      <Modal open={Boolean(discharging)} onClose={() => setDischarging(null)} title="Discharge patient">
        <form className="space-y-3" onSubmit={discharge}>
          <p className="text-sm text-slate-600">
            {discharging?.patient
              ? `${discharging.patient.firstName} ${discharging.patient.lastName}`
              : 'Patient'}{' '}
            will be discharged. The bed moves to cleaning.
          </p>
          <Field label="Discharge summary" htmlFor="discharge-summary" required>
            <Textarea id="discharge-summary" required value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <Button type="submit" variant="danger">
            Confirm discharge
          </Button>
        </form>
      </Modal>
    </div>
  );
}
