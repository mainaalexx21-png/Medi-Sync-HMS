import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, dateOnly, dateTime, money } from '../lib/format';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader,
  StatusBadge, Table, Tabs, Textarea, useToast,
} from '../components/ui';

export default function PatientDetail() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState('summary');
  const [breakGlassOpen, setBreakGlassOpen] = useState(false);
  const [reason, setReason] = useState('');

  const summary = useQuery({
    queryKey: ['patient-summary', id],
    queryFn: () => api.get<any>(`/patients/${id}/summary`),
    enabled: Boolean(id),
    retry: false,
  });

  const versions = useQuery({
    queryKey: ['patient-versions', id],
    queryFn: () => api.get<{ data: any[] }>(`/patients/${id}/versions`),
    enabled: Boolean(id) && tab === 'summary',
    retry: false,
  });

  if (summary.isLoading) return <Loading label="Opening patient record…" />;
  if (summary.error) {
    const error = summary.error as ApiError;
    return (
      <div className="mx-auto max-w-xl">
        <Alert tone="danger" title="Record not available">
          {error.message}
          {error.status === 403 && can('breakglass.use') && (
            <div className="mt-3">
              <Button size="sm" variant="danger" onClick={() => setBreakGlassOpen(true)}>
                Use emergency break-glass access
              </Button>
            </div>
          )}
        </Alert>
        <div className="mt-4">
          <Link to="/patients" className="text-sm font-medium text-brand-700 hover:underline">
            ← Back to patients
          </Link>
        </div>
        <Modal
          open={breakGlassOpen}
          onClose={() => setBreakGlassOpen(false)}
          title="Emergency access (break-glass)"
          footer={
            <>
              <Button variant="outline" onClick={() => setBreakGlassOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await api.post(`/patients/${id}/break-glass`, { reason });
                    toast.push('Emergency access granted for 15 minutes and flagged for review.', 'warning');
                    setBreakGlassOpen(false);
                    queryClient.invalidateQueries({ queryKey: ['patient-summary', id] });
                  } catch (err) {
                    toast.push(err instanceof ApiError ? err.message : 'Could not record break-glass access', 'danger');
                  }
                }}
              >
                Grant emergency access
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600">
            Use only when a patient's life is at risk and normal consent cannot be obtained. Your reason and access are
            recorded and reviewed.
          </p>
          <div className="mt-3">
            <Field label="Clinical reason" htmlFor="reason" required hint="At least 15 characters">
              <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Emergency resuscitation in A&E…" />
            </Field>
          </div>
        </Modal>
      </div>
    );
  }

  const data = summary.data!;
  const patient = data.patient;

  return (
    <div>
      <PageHeader
        title={`${patient.firstName} ${patient.lastName}`}
        description={`${patient.mrn} · ${age(patient.dateOfBirth)} years · ${patient.sex?.toLowerCase()}`}
        actions={
          <>
            {can('encounter.write') && (
              <Button onClick={() => navigate(`/consultation/new?patientId=${id}`)}>Start consultation</Button>
            )}
            <Link to="/patients">
              <Button variant="outline">All patients</Button>
            </Link>
          </>
        }
      />

      {patient.allergies && (
        <div className="mb-4">
          <Alert tone="danger" title="Allergies">
            {patient.allergies}
          </Alert>
        </div>
      )}
      {data.access?.viaBreakGlass && (
        <div className="mb-4">
          <Alert tone="warning" title="Break-glass session">
            This access was granted in an emergency and is flagged for review.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader title="Patient details" />
          <dl className="divide-y divide-slate-100 text-sm">
            {[
              ['MRN', patient.mrn],
              ['Date of birth', dateOnly(patient.dateOfBirth)],
              ['Sex', patient.sex],
              ['Blood group', patient.bloodGroup ?? '—'],
              ['Phone', patient.phone ?? '—'],
              ['Email', patient.email ?? '—'],
              ['County', patient.county ?? '—'],
              ['Address', patient.address ?? '—'],
              ['National ID', patient.nationalId ?? '—'],
              ['Chronic conditions', patient.chronicConditions ?? 'None recorded'],
              [
                'Emergency contact',
                patient.emergencyContact ? `${patient.emergencyContact.name} · ${patient.emergencyContact.phone}` : '—',
              ],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between gap-3 px-4 py-2">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-right font-medium text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'summary', label: 'Clinical summary' },
              { id: 'vitals', label: 'Vitals' },
              { id: 'billing', label: 'Billing' },
              { id: 'guardians', label: 'Guardians' },
              { id: 'attachments', label: 'Files' },
            ]}
          />

          <div className="mt-3 space-y-3">
            {tab === 'summary' && (
              <>
                <Card>
                  <CardHeader title="Recent visits" subtitle="Most recent 10 encounters" />
                  {(data.encounters ?? []).length === 0 ? (
                    <EmptyState title="No encounters yet" />
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {data.encounters.map((encounter: any) => (
                        <li key={encounter.id} className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-slate-800">
                                {dateTime(encounter.startedAt)} · Dr {encounter.doctor.firstName} {encounter.doctor.lastName}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500">{encounter.chiefComplaint ?? 'No chief complaint recorded'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <StatusBadge status={encounter.status} />
                              <Link to={`/consultation/${encounter.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                                Open
                              </Link>
                            </div>
                          </div>
                          {encounter.diagnoses?.length > 0 && (
                            <p className="mt-1 text-xs text-slate-600">
                              {encounter.diagnoses.map((d: any) => `${d.code ?? ''} ${d.description}`).join(' · ')}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card>
                  <CardHeader title="Prescriptions" />
                  {(data.prescriptions ?? []).length === 0 ? (
                    <EmptyState title="No prescriptions" />
                  ) : (
                    <Table head={['Date', 'Medicine', 'Dose', 'Status']}>
                      {data.prescriptions.map((script: any) => (
                        <tr key={script.id}>
                          <td className="table-cell whitespace-nowrap">{dateOnly(script.createdAt)}</td>
                          <td className="table-cell">
                            {script.items.map((item: any) => `${item.drug.name} ${item.drug.strength ?? ''} ×${item.quantity}`).join(', ')}
                          </td>
                          <td className="table-cell">{script.items[0]?.dose}</td>
                          <td className="table-cell">
                            <StatusBadge status={script.status} />
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>

                <Card>
                  <CardHeader title="Laboratory results" />
                  {(data.labOrders ?? []).length === 0 ? (
                    <EmptyState title="No lab orders" />
                  ) : (
                    <Table head={['Test', 'Ordered', 'Status', 'Result']}>
                      {data.labOrders.map((order: any) => (
                        <tr key={order.id}>
                          <td className="table-cell font-medium">{order.test.name}</td>
                          <td className="table-cell">{dateOnly(order.orderedAt)}</td>
                          <td className="table-cell">
                            <StatusBadge status={order.status} />
                          </td>
                          <td className="table-cell">
                            {order.result ? (
                              <span>
                                {order.result.resultValue} {order.result.unit ?? ''}{' '}
                                <Badge tone={order.result.flag === 'NORMAL' ? 'success' : order.result.flag === 'CRITICAL' ? 'danger' : 'warning'}>
                                  {order.result.flag}
                                </Badge>
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </Card>

                <Card>
                  <CardHeader title="Record history" subtitle="Versioned, audited corrections" />
                  {(versions.data?.data ?? []).length === 0 ? (
                    <EmptyState title="No edits recorded" />
                  ) : (
                    <ul className="divide-y divide-slate-100 text-sm">
                      {(versions.data?.data ?? []).map((version) => (
                        <li key={version.id} className="flex items-center justify-between px-4 py-2">
                          <span className="text-slate-600">
                            v{version.version} · {version.reason ?? 'Edit'}
                          </span>
                          <span className="text-xs text-slate-400">{dateTime(version.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )}

            {tab === 'vitals' && <VitalsPanel patientId={id} vitals={data.vitals ?? []} onChange={() => summary.refetch()} />}
            {tab === 'billing' && <BillingPanel patientId={id} invoices={data.invoices ?? []} />}
            {tab === 'guardians' && <GuardiansPanel patientId={id} isPatient={me?.portal === 'patient'} />}
            {tab === 'attachments' && <AttachmentsPanel patientId={id} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function VitalsPanel({ patientId, vitals, onChange }: { patientId: string; vitals: any[]; onChange: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ temperatureC: '', pulse: '', systolic: '', diastolic: '', spo2: '', weightKg: '' });
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post(`/patients/${patientId}/vitals`, {
        temperatureC: form.temperatureC ? Number(form.temperatureC) : undefined,
        pulse: form.pulse ? Number(form.pulse) : undefined,
        systolic: form.systolic ? Number(form.systolic) : undefined,
        diastolic: form.diastolic ? Number(form.diastolic) : undefined,
        spo2: form.spo2 ? Number(form.spo2) : undefined,
        weightKg: form.weightKg ? Number(form.weightKg) : undefined,
      });
      toast.push('Vitals recorded', 'success');
      setForm({ temperatureC: '', pulse: '', systolic: '', diastolic: '', spo2: '', weightKg: '' });
      onChange();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save vitals', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Vitals" subtitle="Latest 50 readings" />
      {can('vitals.write') && (
        <form className="grid grid-cols-2 gap-2 border-b border-slate-100 p-4 sm:grid-cols-6" onSubmit={submit}>
          {[
            ['temperatureC', 'Temp °C'],
            ['pulse', 'Pulse'],
            ['systolic', 'Systolic'],
            ['diastolic', 'Diastolic'],
            ['spo2', 'SpO₂ %'],
            ['weightKg', 'Weight kg'],
          ].map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`v-${key}`}>
              <Input
                id={`v-${key}`}
                type="number"
                step="0.1"
                value={(form as any)[key]}
                onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))}
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
      {vitals.length === 0 ? (
        <EmptyState title="No vitals recorded" />
      ) : (
        <Table head={['Recorded', 'Temp', 'Pulse', 'BP', 'SpO₂', 'Weight']}>
          {vitals.map((vital) => (
            <tr key={vital.id}>
              <td className="table-cell">{dateTime(vital.recordedAt)}</td>
              <td className="table-cell">{vital.temperatureC ?? '—'}</td>
              <td className="table-cell">{vital.pulse ?? '—'}</td>
              <td className="table-cell">{vital.systolic ? `${vital.systolic}/${vital.diastolic}` : '—'}</td>
              <td className="table-cell">{vital.spo2 ?? '—'}</td>
              <td className="table-cell">{vital.weightKg ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function BillingPanel({ patientId, invoices }: { patientId: string; invoices: any[] }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState<any | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('MPESA');

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    if (!paying) return;
    try {
      await api.post(`/invoices/${paying.id}/payments`, { amount: Number(amount), method });
      toast.push('Payment recorded', 'success');
      setPaying(null);
      setAmount('');
      queryClient.invalidateQueries({ queryKey: ['patient-summary', patientId] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Payment failed', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader title="Invoices" subtitle="Invoices are generated automatically from consultations, labs and medicines" />
      {invoices.length === 0 ? (
        <EmptyState title="No invoices" />
      ) : (
        <Table head={['Invoice', 'Issued', 'Items', 'Total', 'Balance', 'Status', '']}>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td className="table-cell font-mono text-xs">{invoice.number}</td>
              <td className="table-cell">{dateOnly(invoice.issuedAt)}</td>
              <td className="table-cell">{invoice.items?.length ?? 0}</td>
              <td className="table-cell">{money(invoice.total)}</td>
              <td className="table-cell font-medium">{money(invoice.balance)}</td>
              <td className="table-cell">
                <StatusBadge status={invoice.status} />
              </td>
              <td className="table-cell text-right">
                {can('payment.record') && invoice.balance > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPaying(invoice);
                      setAmount(String(invoice.balance));
                    }}
                  >
                    Record payment
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={Boolean(paying)} onClose={() => setPaying(null)} title="Record payment">
        <form className="space-y-3" onSubmit={pay}>
          <p className="text-sm text-slate-600">
            Invoice {paying?.number} · balance {money(paying?.balance)}
          </p>
          <Field label="Amount (KES)" htmlFor="pay-amount" required>
            <Input id="pay-amount" type="number" min="1" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Method" htmlFor="pay-method">
            <select id="pay-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>MPESA</option>
              <option>CASH</option>
              <option>CARD</option>
              <option>INSURANCE</option>
              <option>BANK</option>
            </select>
          </Field>
          <Button type="submit">Record payment</Button>
        </form>
      </Modal>
    </Card>
  );
}

function GuardiansPanel({ patientId, isPatient }: { patientId: string; isPatient: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', relationship: 'Spouse', scopes: ['appointments', 'bills'] as string[] });
  const { data, isLoading } = useQuery({
    queryKey: ['guardians', patientId],
    queryFn: () => api.get<any>(`/patients/${patientId}/guardians`),
  });

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    try {
      const res = await api.post<any>(`/patients/${patientId}/guardians`, form);
      toast.push(res.devInviteToken ? 'Guardian invited. Dev invite token shown in API response.' : 'Guardian invited; awaiting consent.', 'success');
      setForm({ email: '', relationship: 'Spouse', scopes: ['appointments', 'bills'] });
      queryClient.invalidateQueries({ queryKey: ['guardians', patientId] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not invite guardian', 'danger');
    }
  }

  async function consent(linkId: string) {
    await api.post(`/patients/${patientId}/guardians/${linkId}/consent`, {});
    toast.push('Guardian access granted', 'success');
    queryClient.invalidateQueries({ queryKey: ['guardians', patientId] });
  }

  async function revoke(linkId: string) {
    await api.del(`/patients/${patientId}/guardians/${linkId}`);
    toast.push('Guardian access revoked immediately', 'success');
    queryClient.invalidateQueries({ queryKey: ['guardians', patientId] });
  }

  return (
    <Card>
      <CardHeader title="Guardian access" subtitle="Consent-scoped, revocable at any time" />
      {isLoading ? (
        <Loading />
      ) : (data?.data ?? []).length === 0 ? (
        <EmptyState title="No guardians linked" description="Invite a family member to help manage appointments and bills." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.data.map((link: any) => (
            <li key={link.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-slate-800">
                    {link.guardianEmail} · <span className="text-slate-500">{link.relationship}</span>
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {link.scopes.map((scope: string) => (
                      <Badge key={scope} tone="brand">
                        {scope}
                      </Badge>
                    ))}
                    <StatusBadge status={link.status} />
                  </p>
                </div>
                <div className="flex gap-2">
                  {link.status === 'PENDING' && (
                    <Button size="sm" onClick={() => consent(link.id)}>
                      Grant consent
                    </Button>
                  )}
                  {link.status === 'ACTIVE' && (
                    <Button size="sm" variant="outline" onClick={() => revoke(link.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-2 border-t border-slate-100 p-4 sm:grid-cols-[1fr_150px_auto]" onSubmit={invite}>
        <Field label="Guardian email" htmlFor="g-email" required>
          <Input id="g-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Relationship" htmlFor="g-rel">
          <Input id="g-rel" value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Invite</Button>
        </div>
        <div className="sm:col-span-3 flex flex-wrap gap-3 text-xs text-slate-600">
          {['appointments', 'prescriptions', 'labResults', 'bills', 'messages', 'demographics'].map((scope) => (
            <label key={scope} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-700"
                checked={form.scopes.includes(scope)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope),
                  })
                }
              />
              {scope}
            </label>
          ))}
        </div>
      </form>
    </Card>
  );
}

function AttachmentsPanel({ patientId }: { patientId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['attachments', patientId],
    queryFn: () => api.get<any>(`/patients/${patientId}/attachments`),
  });

  async function upload(file: File) {
    try {
      await api.upload(`/patients/${patientId}/attachments`, file, { category: 'LAB_RESULT' });
      toast.push('File attached', 'success');
      queryClient.invalidateQueries({ queryKey: ['attachments', patientId] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Upload failed', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader title="Documents" subtitle="PDF or images, stored privately and served only to authorised staff" />
      {isLoading ? (
        <Loading />
      ) : (data?.data ?? []).length === 0 ? (
        <EmptyState title="No documents" description="Upload a lab PDF or scanned consent form." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.data.map((file: any) => (
            <li key={file.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <div>
                <p className="font-medium text-slate-800">{file.filename}</p>
                <p className="text-xs text-slate-500">
                  {(file.sizeBytes / 1024).toFixed(0)} KB · {file.category} · {dateTime(file.createdAt)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => window.open(`/api/v1/attachments/${file.id}/download`, '_blank')}>
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-slate-100 p-4">
        <label className="text-xs font-medium text-slate-600">
          Attach a document
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="mt-1 block w-full text-xs"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
    </Card>
  );
}
