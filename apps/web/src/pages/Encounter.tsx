import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { age, dateTime, money } from '../lib/format';
import { useDrugs, useLabTests } from '../lib/hooks';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, PageHeader, Select,
  StatusBadge, Table, Textarea, useToast,
} from '../components/ui';

export default function Encounter() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (id) return;
    const patientId = params.get('patientId');
    const appointmentId = params.get('appointmentId') ?? undefined;
    if (!patientId) {
      toast.push('Open a patient record to start a consultation', 'danger');
      navigate('/patients');
      return;
    }
    setCreating(true);
    api
      .post<any>('/encounters', { patientId, appointmentId, chiefComplaint: 'Walk-in consultation' })
      .then((res) => {
        queryClient.invalidateQueries({ queryKey: ['doctor-today'] });
        navigate(`/consultation/${res.encounter.id}`, { replace: true });
      })
      .catch((err) => {
        toast.push(err instanceof ApiError ? err.message : 'Could not start the consultation', 'danger');
        navigate(`/patients/${patientId}`);
      })
      .finally(() => setCreating(false));
  }, [id, params, navigate, queryClient, toast]);

  if (!id) return <Loading label={creating ? 'Opening a new consultation…' : 'Preparing…'} />;
  return <Workspace encounterId={id} />;
}

function Workspace({ encounterId }: { encounterId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState({ chiefComplaint: '', notes: '', plan: '' });
  const [loaded, setLoaded] = useState(false);

  const encounter = useQuery({
    queryKey: ['encounter', encounterId],
    queryFn: () => api.get<any>(`/encounters/${encounterId}`),
  });

  useEffect(() => {
    if (encounter.data && !loaded) {
      const e = encounter.data.encounter;
      setNote({ chiefComplaint: e.chiefComplaint ?? '', notes: e.notes ?? '', plan: e.plan ?? '' });
      setLoaded(true);
    }
  }, [encounter.data, loaded]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['encounter', encounterId] });

  if (encounter.isLoading) return <Loading label="Opening the consultation…" />;
  if (encounter.error) {
    return (
      <Alert tone="danger" title="Consultation not available">
        {encounter.error instanceof ApiError ? encounter.error.message : 'Unexpected error'}
      </Alert>
    );
  }

  const e = encounter.data.encounter;
  const closed = e.status === 'CLOSED';

  async function saveNote(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.patch(`/encounters/${encounterId}`, note);
      toast.push('Note saved', 'success');
      refresh();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save', 'danger');
    }
  }

  async function close() {
    if (!window.confirm('Close this consultation? The note becomes read-only and the bill is finalised.')) return;
    try {
      await api.post(`/encounters/${encounterId}/close`);
      toast.push('Consultation closed', 'success');
      queryClient.invalidateQueries({ queryKey: ['doctor-today'] });
      refresh();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not close', 'danger');
    }
  }

  const invoice = e.invoices?.[0];

  return (
    <div>
      <PageHeader
        title={`${e.patient.firstName} ${e.patient.lastName}`}
        description={`${e.patient.mrn} · ${age(e.patient.dateOfBirth)} yrs · ${e.patient.sex?.toLowerCase()} · seen ${dateTime(e.startedAt)}`}
        actions={
          <>
            <StatusBadge status={e.status} />
            <Link to={`/patients/${e.patient.id}`}>
              <Button variant="outline">Patient record</Button>
            </Link>
            {!closed && (
              <Button variant="danger" onClick={close}>
                Close consultation
              </Button>
            )}
          </>
        }
      />

      {e.patient.allergies && (
        <div className="mb-3">
          <Alert tone="danger" title="Allergies">
            {e.patient.allergies}
          </Alert>
        </div>
      )}
      {e.patient.chronicConditions && (
        <p className="mb-3 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Chronic conditions:</span> {e.patient.chronicConditions}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Clinical note" subtitle={closed ? 'Closed — read only' : 'Autosaved on submit; every edit is audited'} />
            <form className="space-y-3 p-4" onSubmit={saveNote}>
              <Field label="Chief complaint" htmlFor="cc">
                <Input id="cc" value={note.chiefComplaint} onChange={(ev) => setNote({ ...note, chiefComplaint: ev.target.value })} disabled={closed} />
              </Field>
              <Field label="Assessment & findings" htmlFor="notes">
                <Textarea id="notes" rows={6} value={note.notes} onChange={(ev) => setNote({ ...note, notes: ev.target.value })} disabled={closed} />
              </Field>
              <Field label="Plan" htmlFor="plan">
                <Textarea id="plan" rows={3} value={note.plan} onChange={(ev) => setNote({ ...note, plan: ev.target.value })} disabled={closed} />
              </Field>
              {!closed && <Button type="submit">Save note</Button>}
            </form>
          </Card>

          <VitalsCard encounterId={encounterId} vitals={e.vitals} closed={closed} onSaved={refresh} />

          {!closed && <PrescribeCard encounterId={encounterId} onSaved={refresh} />}
          {!closed && <LabOrderCard encounterId={encounterId} onSaved={refresh} />}
          {!closed && <DiagnosisCard encounterId={encounterId} diagnoses={e.diagnoses} onSaved={refresh} />}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Prescriptions" subtitle="Sent to the pharmacy queue" />
            {(e.prescriptions ?? []).length === 0 ? (
              <EmptyState title="No prescriptions yet" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {e.prescriptions.map((script: any) => (
                  <li key={script.id} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{dateTime(script.createdAt)}</p>
                      <StatusBadge status={script.status} />
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                      {script.items.map((item: any) => (
                        <li key={item.id}>
                          {item.drug.name} {item.drug.strength} · {item.dose} {item.frequency} × {item.durationDays}d ({item.quantity})
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Laboratory" />
            {(e.labOrders ?? []).length === 0 ? (
              <EmptyState title="No tests ordered" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {e.labOrders.map((order: any) => (
                  <li key={order.id} className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{order.test.name}</span>
                      <StatusBadge status={order.status} />
                    </div>
                    {order.result && (
                      <p className="mt-1 text-xs text-slate-600">
                        {order.result.resultValue} {order.result.unit ?? ''} ({order.result.referenceRange ?? 'no range'}) ·{' '}
                        <strong>{order.result.flag}</strong>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Diagnoses" />
            {(e.diagnoses ?? []).length === 0 ? (
              <EmptyState title="No diagnosis recorded" />
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {e.diagnoses.map((diagnosis: any) => (
                  <li key={diagnosis.id} className="px-4 py-2">
                    {diagnosis.code && <Badge tone="info">{diagnosis.code}</Badge>} {diagnosis.description}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {invoice && (
            <Card>
              <CardHeader title="Bill" subtitle={invoice.number} actions={<StatusBadge status={invoice.status} />} />
              <div className="px-4 py-3 text-sm">
                <ul className="space-y-1">
                  {invoice.items.map((item: any) => (
                    <li key={item.id} className="flex justify-between gap-2 text-xs">
                      <span className="text-slate-600">{item.description}</span>
                      <span className="font-medium">{money(item.amount)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span>{money(invoice.total)}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">Balance {money(invoice.balance)}</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function VitalsCard({ encounterId, vitals, closed, onSaved }: { encounterId: string; vitals: any[]; closed: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ temperatureC: '', pulse: '', systolic: '', diastolic: '', spo2: '', weightKg: '' });
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post(`/encounters/${encounterId}/vitals`, {
        temperatureC: form.temperatureC ? Number(form.temperatureC) : undefined,
        pulse: form.pulse ? Number(form.pulse) : undefined,
        systolic: form.systolic ? Number(form.systolic) : undefined,
        diastolic: form.diastolic ? Number(form.diastolic) : undefined,
        spo2: form.spo2 ? Number(form.spo2) : undefined,
        weightKg: form.weightKg ? Number(form.weightKg) : undefined,
      });
      toast.push('Vitals recorded', 'success');
      setForm({ temperatureC: '', pulse: '', systolic: '', diastolic: '', spo2: '', weightKg: '' });
      onSaved();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save vitals', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const latest = vitals?.[0];

  return (
    <Card>
      <CardHeader
        title="Vitals"
        subtitle={latest ? `Last recorded ${dateTime(latest.recordedAt)}` : 'No vitals recorded for this visit'}
        actions={
          latest && (
            <div className="flex gap-2 text-xs text-slate-600">
              <Badge tone="neutral">{latest.temperatureC ?? '—'} °C</Badge>
              <Badge tone="neutral">{latest.pulse ?? '—'} bpm</Badge>
              <Badge tone="neutral">
                {latest.systolic ?? '—'}/{latest.diastolic ?? '—'}
              </Badge>
              <Badge tone="neutral">SpO₂ {latest.spo2 ?? '—'}%</Badge>
            </div>
          )
        }
      />
      {!closed && (
        <form className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-6" onSubmit={submit}>
          {[
            ['temperatureC', 'Temp °C'],
            ['pulse', 'Pulse'],
            ['systolic', 'Systolic'],
            ['diastolic', 'Diastolic'],
            ['spo2', 'SpO₂ %'],
            ['weightKg', 'Weight kg'],
          ].map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`ev-${key}`}>
              <Input
                id={`ev-${key}`}
                type="number"
                step="0.1"
                value={(form as any)[key]}
                onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
              />
            </Field>
          ))}
          <div className="col-span-2 sm:col-span-6">
            <Button type="submit" size="sm" loading={busy}>
              Record vitals
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function PrescribeCard({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const toast = useToast();
  const drugs = useDrugs();
  const [items, setItems] = useState<any[]>([]);
  const [line, setLine] = useState({ drugId: '', dose: '1 tablet', frequency: 'Twice daily', durationDays: '5', quantity: '10' });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => drugs.data?.data?.find((d) => d.id === line.drugId), [drugs.data, line.drugId]);

  function addLine() {
    if (!line.drugId) return;
    setItems((current) => [
      ...current,
      { ...line, durationDays: Number(line.durationDays), quantity: Number(line.quantity), drug: selected },
    ]);
    setLine({ drugId: '', dose: '1 tablet', frequency: 'Twice daily', durationDays: '5', quantity: '10' });
  }

  async function submit() {
    if (!items.length) return;
    setBusy(true);
    try {
      await api.post(`/encounters/${encounterId}/prescriptions`, {
        notes: notes || undefined,
        items: items.map((item) => ({
          drugId: item.drugId,
          dose: item.dose,
          frequency: item.frequency,
          durationDays: item.durationDays,
          quantity: item.quantity,
        })),
      });
      toast.push('Prescription sent to pharmacy', 'success');
      setItems([]);
      setNotes('');
      onSaved();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not prescribe', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Prescribe" subtitle="Stock is checked when the pharmacy dispenses" />
      <div className="space-y-3 p-4">
        <div className="grid gap-2 sm:grid-cols-5">
          <Field label="Medicine" htmlFor="drug" className="sm:col-span-2">
            <Select id="drug" value={line.drugId} onChange={(event) => setLine({ ...line, drugId: event.target.value })}>
              <option value="">Select medicine</option>
              {(drugs.data?.data ?? []).map((drug) => (
                <option key={drug.id} value={drug.id} disabled={drug.stockOnHand === 0}>
                  {drug.name} {drug.strength ?? ''} {drug.stockOnHand === 0 ? '(out of stock)' : `· ${drug.stockOnHand} left`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dose" htmlFor="dose">
            <Input id="dose" value={line.dose} onChange={(event) => setLine({ ...line, dose: event.target.value })} />
          </Field>
          <Field label="Frequency" htmlFor="freq">
            <Input id="freq" value={line.frequency} onChange={(event) => setLine({ ...line, frequency: event.target.value })} />
          </Field>
          <Field label="Qty" htmlFor="qty">
            <Input id="qty" type="number" min="1" value={line.quantity} onChange={(event) => setLine({ ...line, quantity: event.target.value })} />
          </Field>
        </div>
        <Button size="sm" variant="outline" onClick={addLine} disabled={!line.drugId}>
          Add to prescription
        </Button>

        {items.length > 0 && (
          <Table head={['Medicine', 'Dose', 'Frequency', 'Days', 'Qty', '']}>
            {items.map((item, index) => (
              <tr key={`${item.drugId}-${index}`}>
                <td className="table-cell">{item.drug?.name}</td>
                <td className="table-cell">{item.dose}</td>
                <td className="table-cell">{item.frequency}</td>
                <td className="table-cell">{item.durationDays}</td>
                <td className="table-cell">{item.quantity}</td>
                <td className="table-cell">
                  <button className="text-xs text-rose-600 hover:underline" onClick={() => setItems(items.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}

        <Field label="Instructions for the patient" htmlFor="script-notes">
          <Input id="script-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. Take after meals" />
        </Field>
        <Button onClick={submit} loading={busy} disabled={!items.length}>
          Send prescription
        </Button>
      </div>
    </Card>
  );
}

function LabOrderCard({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const toast = useToast();
  const tests = useLabTests();
  const [selected, setSelected] = useState<string[]>([]);
  const [priority, setPriority] = useState('ROUTINE');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!selected.length) return;
    setBusy(true);
    try {
      await api.post(`/encounters/${encounterId}/lab-orders`, { testIds: selected, priority, clinicalNotes: notes || undefined });
      toast.push('Lab order placed and charged to the bill', 'success');
      setSelected([]);
      setNotes('');
      onSaved();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not order tests', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Order laboratory tests" subtitle="Tests are added to the encounter bill automatically" />
      <div className="space-y-3 p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {(tests.data?.data ?? []).map((test) => (
            <label key={test.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-700"
                  checked={selected.includes(test.id)}
                  onChange={(event) =>
                    setSelected(event.target.checked ? [...selected, test.id] : selected.filter((id) => id !== test.id))
                  }
                />
                {test.name}
              </span>
              <span className="text-xs text-slate-500">{money(test.price)}</span>
            </label>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Priority" htmlFor="lab-priority">
            <Select id="lab-priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="ROUTINE">Routine</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </Field>
          <Field label="Clinical notes" htmlFor="lab-notes" className="sm:col-span-2">
            <Input id="lab-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>
        <Button onClick={submit} loading={busy} disabled={!selected.length}>
          Order tests
        </Button>
      </div>
    </Card>
  );
}

function DiagnosisCard({ encounterId, diagnoses, onSaved }: { encounterId: string; diagnoses: any[]; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ code: '', description: '', type: 'PRIMARY' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post(`/encounters/${encounterId}/diagnoses`, form);
      toast.push('Diagnosis added', 'success');
      setForm({ code: '', description: '', type: 'PRIMARY' });
      onSaved();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not add diagnosis', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader title="Add diagnosis" subtitle={`${diagnoses?.length ?? 0} recorded`} />
      <form className="grid gap-2 p-4 sm:grid-cols-[120px_1fr_140px_auto]" onSubmit={submit}>
        <Field label="ICD-10" htmlFor="icd">
          <Input id="icd" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="E11.9" />
        </Field>
        <Field label="Description" htmlFor="dx">
          <Input id="dx" required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <Field label="Type" htmlFor="dx-type">
          <Select id="dx-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
            <option value="PRIMARY">Primary</option>
            <option value="SECONDARY">Secondary</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit">Add</Button>
        </div>
      </form>
    </Card>
  );
}
