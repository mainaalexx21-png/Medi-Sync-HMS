import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, dateTime } from '../lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, PageHeader, Select, Table, useToast } from '../components/ui';

export default function Patients() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);

  const query = useQuery({
    queryKey: ['patients', search, page],
    queryFn: () => api.get<{ data: any[]; pagination: any }>('/patients', { search, page, pageSize: 20 }),
  });

  const rows = query.data?.data ?? [];
  const pagination = query.data?.pagination;
  const deidentified = useMemo(() => rows.length > 0 && rows[0].pseudonym !== undefined, [rows]);

  return (
    <div>
      <PageHeader
        title="Patient records"
        description={
          deidentified
            ? 'External auditor view — patients are pseudonymised.'
            : 'Search by name, MRN or phone. Every record view is written to the audit trail.'
        }
        actions={
          can('patient.write') && (
            <Button onClick={() => setShowNew((v) => !v)}>{showNew ? 'Close form' : 'Register patient'}</Button>
          )
        }
      />

      {showNew && <NewPatientForm onDone={() => { setShowNew(false); query.refetch(); }} />}

      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="search" className="sr-only">
              Search patients
            </label>
            <Input
              id="search"
              placeholder="Search name, MRN or phone…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button variant="outline" onClick={() => query.refetch()} loading={query.isFetching}>
            Refresh
          </Button>
        </div>

        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <div className="p-4">
            <Alert tone="danger">{query.error instanceof ApiError ? query.error.message : 'Could not load patients'}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No patients found"
            description={search ? 'Try a different spelling or the medical record number.' : 'Register the first patient to get started.'}
          />
        ) : (
          <Table head={deidentified ? ['Pseudonym', 'Sex', 'Age'] : ['Patient', 'MRN', 'Age / sex', 'Phone', 'Last updated', '']}>
            {rows.map((patient) => (
              <tr key={patient.id} className="hover:bg-slate-50">
                {deidentified ? (
                  <>
                    <td className="table-cell font-medium">{patient.pseudonym}</td>
                    <td className="table-cell">{patient.sex}</td>
                    <td className="table-cell">{age(patient.dateOfBirth)} yrs</td>
                  </>
                ) : (
                  <>
                    <td className="table-cell">
                      <Link to={`/patients/${patient.id}`} className="font-medium text-brand-800 hover:underline">
                        {patient.firstName} {patient.lastName}
                      </Link>
                      {patient.allergies && <p className="text-xs text-rose-600">Allergy: {patient.allergies}</p>}
                    </td>
                    <td className="table-cell font-mono text-xs">{patient.mrn}</td>
                    <td className="table-cell">
                      {age(patient.dateOfBirth)} yrs · {patient.sex?.toLowerCase()}
                    </td>
                    <td className="table-cell">{patient.phone ?? '—'}</td>
                    <td className="table-cell text-xs text-slate-500">{dateTime(patient.createdAt)}</td>
                    <td className="table-cell text-right">
                      <Link to={`/patients/${patient.id}`}>
                        <Button size="sm" variant="outline">
                          Open
                        </Button>
                      </Link>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </Table>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            <span>
              Page {pagination.page} of {pagination.totalPages} · {pagination.total} patients
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  sex: 'FEMALE',
  phone: '',
  email: '',
  county: '',
  address: '',
  nationalId: '',
  bloodGroup: '',
  allergies: '',
  chronicConditions: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  consentToProcessing: true,
};

function NewPatientForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(key: keyof typeof EMPTY_FORM, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ patient: any }>('/patients', form);
      toast.push(`Record created · ${res.patient.mrn}`, 'success');
      setForm(EMPTY_FORM);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the record');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <form className="grid gap-3 p-4 sm:grid-cols-3" onSubmit={submit}>
        <div className="sm:col-span-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">New patient record</h2>
          <Badge tone="info">Consent is recorded with the registration</Badge>
        </div>
        <Field label="First name" htmlFor="n-first" required>
          <Input id="n-first" required value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
        </Field>
        <Field label="Last name" htmlFor="n-last" required>
          <Input id="n-last" required value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
        </Field>
        <Field label="Date of birth" htmlFor="n-dob" required>
          <Input id="n-dob" type="date" required value={form.dateOfBirth} onChange={(e) => update('dateOfBirth', e.target.value)} />
        </Field>
        <Field label="Sex" htmlFor="n-sex">
          <Select id="n-sex" value={form.sex} onChange={(e) => update('sex', e.target.value)}>
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Phone" htmlFor="n-phone">
          <Input id="n-phone" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="n-email">
          <Input id="n-email" type="email" value={form.email} onChange={(e) => update('email', e.target.value)} />
        </Field>
        <Field label="National ID" htmlFor="n-nid" hint="Encrypted at rest">
          <Input id="n-nid" value={form.nationalId} onChange={(e) => update('nationalId', e.target.value)} />
        </Field>
        <Field label="Blood group" htmlFor="n-blood">
          <Input id="n-blood" value={form.bloodGroup} onChange={(e) => update('bloodGroup', e.target.value)} placeholder="O+" />
        </Field>
        <Field label="County" htmlFor="n-county">
          <Input id="n-county" value={form.county} onChange={(e) => update('county', e.target.value)} />
        </Field>
        <Field label="Allergies" htmlFor="n-allergies" className="sm:col-span-2">
          <Input id="n-allergies" value={form.allergies} onChange={(e) => update('allergies', e.target.value)} placeholder="e.g. Penicillin - rash" />
        </Field>
        <Field label="Chronic conditions" htmlFor="n-chronic">
          <Input id="n-chronic" value={form.chronicConditions} onChange={(e) => update('chronicConditions', e.target.value)} />
        </Field>
        <Field label="Emergency contact" htmlFor="n-ec">
          <Input id="n-ec" value={form.emergencyContactName} onChange={(e) => update('emergencyContactName', e.target.value)} />
        </Field>
        <Field label="Emergency phone" htmlFor="n-ecp">
          <Input id="n-ecp" value={form.emergencyContactPhone} onChange={(e) => update('emergencyContactPhone', e.target.value)} />
        </Field>
        {error && (
          <div className="sm:col-span-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
        <div className="sm:col-span-3">
          <Button type="submit" loading={busy}>
            Create record
          </Button>
        </div>
      </form>
    </Card>
  );
}
