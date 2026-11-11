import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, StatusBadge, Table, Tabs, Textarea, useToast,
} from '../components/ui';

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'users';
  return (
    <div>
      <PageHeader title="Administration" description="Accounts, access reviews, audit trail and system settings." />
      <Tabs
        value={tab}
        onChange={(next) => setParams(next === 'users' ? {} : { tab: next })}
        tabs={[
          { id: 'users', label: 'Users & roles' },
          { id: 'audit', label: 'Audit trail' },
          { id: 'break-glass', label: 'Access reviews' },
          { id: 'grants', label: 'External access' },
          { id: 'settings', label: 'Settings' },
        ]}
      />
      <div className="mt-3">
        {tab === 'users' && <Users />}
        {tab === 'audit' && <Audit />}
        {tab === 'break-glass' && <BreakGlass />}
        {tab === 'grants' && <Grants />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  );
}

function Users() {
  const { me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    email: '', role: 'FRONT_DESK', clinicalRole: 'DOCTOR', firstName: '', lastName: '', jobTitle: '',
  });
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['users', search, role],
    queryFn: () => api.get<{ data: any[] }>('/users', { search, role, pageSize: 100 }),
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    try {
      const res = await api.post<any>('/users', form);
      setTempPassword(res.tempPassword);
      toast.push('Account created. Share the temporary password securely.', 'success');
      queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not create the account', 'danger');
    }
  }

  async function update(id: string, payload: any) {
    try {
      await api.patch(`/users/${id}`, payload);
      toast.push('Account updated', 'success');
      queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Update failed', 'danger');
    }
  }

  async function resetMfa(id: string) {
    const reason = window.prompt('Reason for resetting MFA (recorded in the audit trail)?');
    if (!reason) return;
    try {
      await api.post(`/users/${id}/mfa-reset`, { reason });
      toast.push('MFA reset. The user must enrol again.', 'success');
      queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'MFA reset failed', 'danger');
    }
  }

  async function unlock(id: string) {
    await api.post(`/users/${id}/unlock`);
    toast.push('Account unlocked', 'success');
    queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  return (
    <Card>
      <CardHeader
        title="Staff & external accounts"
        subtitle="Five staff roles, enforced server-side. System administrators cannot read clinical data."
        actions={<Button size="sm" onClick={() => setCreating(true)}>New account</Button>}
      />
      <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3">
        <Input placeholder="Search email" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {[
            'FRONT_DESK', 'CLINICAL', 'DIAGNOSTICS', 'FINANCE', 'SYSTEM_ADMIN',
            'AUDITOR', 'VENDOR', 'PATIENT', 'GUARDIAN',
          ].map((option) => (
            <option key={option} value={option}>
              {option.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => users.refetch()} loading={users.isFetching}>
          Refresh
        </Button>
      </div>

      {users.isLoading ? (
        <Loading />
      ) : (
        <Table head={['Account', 'Role', 'MFA', 'Status', 'Last sign-in', '']}>
          {(users.data?.data ?? []).map((user) => (
            <tr key={user.id}>
              <td className="table-cell">
                <p className="font-medium">{user.staff ? `${user.staff.firstName} ${user.staff.lastName}` : user.email}</p>
                <p className="text-xs text-slate-500">{user.email}</p>
              </td>
              <td className="table-cell text-xs">
                {user.role.replace(/_/g, ' ')}
                {user.staff?.clinicalRole ? ` · ${user.staff.clinicalRole.toLowerCase()}` : ''}
              </td>
              <td className="table-cell">
                <Badge tone={user.mfaEnabled ? 'success' : 'warning'}>{user.mfaEnabled ? 'On' : 'Off'}</Badge>
              </td>
              <td className="table-cell">
                <StatusBadge status={user.status} />
              </td>
              <td className="table-cell text-xs">{dateTime(user.lastLoginAt)}</td>
              <td className="table-cell">
                <div className="flex flex-wrap justify-end gap-1">
                  {user.status !== 'ACTIVE' ? (
                    <Button size="sm" variant="outline" onClick={() => update(user.id, { status: 'ACTIVE' })}>
                      Enable
                    </Button>
                  ) : (
                    user.id !== me?.user.id && (
                      <Button size="sm" variant="ghost" onClick={() => update(user.id, { status: 'DISABLED' })}>
                        Disable
                      </Button>
                    )
                  )}
                  {user.lockedUntil && (
                    <Button size="sm" variant="outline" onClick={() => unlock(user.id)}>
                      Unlock
                    </Button>
                  )}
                  {user.mfaEnabled && user.id !== me?.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => resetMfa(user.id)}>
                      Reset MFA
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={creating} onClose={() => { setCreating(false); setTempPassword(null); }} title="Create account">
        {tempPassword ? (
          <div className="space-y-3">
            <Alert tone="success" title="Account created">
              Temporary password (shown once): <code className="mt-1 block rounded bg-white/60 px-2 py-1 font-mono text-sm">{tempPassword}</code>
            </Alert>
            <p className="text-sm text-slate-600">The user must change it at first sign-in and enrol two-factor authentication.</p>
            <Button onClick={() => { setCreating(false); setTempPassword(null); }}>Done</Button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={create}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="First name" htmlFor="u-first" required>
                <Input id="u-first" required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
              </Field>
              <Field label="Last name" htmlFor="u-last" required>
                <Input id="u-last" required value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
              </Field>
            </div>
            <Field label="Work email" htmlFor="u-email" required>
              <Input id="u-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Role" htmlFor="u-role" required>
                <Select id="u-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                  {['FRONT_DESK', 'CLINICAL', 'DIAGNOSTICS', 'FINANCE', 'SYSTEM_ADMIN'].map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Job title" htmlFor="u-job">
                <Input id="u-job" value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} />
              </Field>
            </div>
            {form.role === 'CLINICAL' && (
              <Field label="Clinical job function" htmlFor="u-clinical-role" required>
                <Select
                  id="u-clinical-role"
                  value={form.clinicalRole}
                  onChange={(event) => setForm({ ...form, clinicalRole: event.target.value })}
                >
                  <option value="DOCTOR">Doctor - diagnose, prescribe, order, admit</option>
                  <option value="NURSE">Nurse - triage, vitals, ward care</option>
                </Select>
              </Field>
            )}
            <Button type="submit">Create account</Button>
          </form>
        )}
      </Modal>
    </Card>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [verify, setVerify] = useState<any>(null);
  const audit = useQuery({
    queryKey: ['audit', action, outcome],
    queryFn: () => api.get<{ data: any[]; pagination: any }>('/audit', { action, outcome, pageSize: 100 }),
  });

  async function verifyChain() {
    try {
      setVerify(await api.get('/audit/verify'));
    } catch (err) {
      setVerify({ valid: false, error: err instanceof ApiError ? err.message : 'Check failed' });
    }
  }

  return (
    <Card>
      <CardHeader
        title="Immutable audit trail"
        subtitle="Hash-chained: editing or deleting a row breaks verification"
        actions={<Button size="sm" variant="outline" onClick={verifyChain}>Verify chain</Button>}
      />
      {verify && (
        <div className="px-4 pt-3">
          <Alert tone={verify.valid ? 'success' : 'danger'}>
            {verify.valid ? `Chain intact across ${verify.checked} records.` : `Chain broken at ${verify.brokenAt ?? 'unknown record'}.`}
          </Alert>
        </div>
      )}
      <div className="grid gap-2 border-b border-slate-100 p-3 sm:grid-cols-3">
        <Input placeholder="Filter by action (e.g. patient.read)" value={action} onChange={(event) => setAction(event.target.value)} />
        <Select value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Outcome">
          <option value="">Any outcome</option>
          <option value="SUCCESS">Success</option>
          <option value="DENIED">Denied</option>
          <option value="FAILURE">Failure</option>
        </Select>
        <Button variant="outline" onClick={() => audit.refetch()} loading={audit.isFetching}>
          Refresh
        </Button>
      </div>
      {audit.isLoading ? (
        <Loading />
      ) : (
        <Table head={['When', 'Actor', 'Action', 'Resource', 'Outcome', 'IP']}>
          {(audit.data?.data ?? []).map((row) => (
            <tr key={row.id}>
              <td className="table-cell whitespace-nowrap text-xs">{dateTime(row.createdAt)}</td>
              <td className="table-cell text-xs">
                {row.actor?.email ?? 'system'}
                <p className="text-slate-400">{row.actorRole}</p>
              </td>
              <td className="table-cell font-mono text-xs">{row.action}</td>
              <td className="table-cell text-xs">
                {row.resource}
                {row.resourceId && <p className="truncate font-mono text-[10px] text-slate-400">{row.resourceId.slice(0, 12)}…</p>}
              </td>
              <td className="table-cell">
                <StatusBadge status={row.outcome} />
              </td>
              <td className="table-cell text-xs text-slate-500">{row.ip}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function BreakGlass() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const events = useQuery({
    queryKey: ['break-glass'],
    queryFn: () => api.get<{ data: any[]; pending: number }>('/break-glass'),
  });

  async function review(id: string, outcome: 'JUSTIFIED' | 'ESCALATED') {
    const note = window.prompt(`Note for "${outcome.toLowerCase()}" (optional)?`) ?? undefined;
    try {
      await api.post(`/break-glass/${id}/review`, { outcome, note });
      toast.push('Review recorded', 'success');
      queryClient.invalidateQueries({ queryKey: ['break-glass'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not record review', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Break-glass access reviews"
        subtitle={`${events.data?.pending ?? 0} awaiting review`}
        actions={<Badge tone={events.data?.pending ? 'danger' : 'success'}>{events.data?.pending ?? 0} pending</Badge>}
      />
      {events.isLoading ? (
        <Loading />
      ) : (events.data?.data ?? []).length === 0 ? (
        <EmptyState title="No emergency access recorded" />
      ) : (
        <Table head={['When', 'Clinician', 'Patient', 'Reason', 'Status', '']}>
          {events.data!.data.map((event) => (
            <tr key={event.id}>
              <td className="table-cell whitespace-nowrap text-xs">{dateTime(event.createdAt)}</td>
              <td className="table-cell text-xs">{event.user.email}</td>
              <td className="table-cell">
                {event.patient.firstName} {event.patient.lastName}
                <p className="font-mono text-[10px] text-slate-500">{event.patient.mrn}</p>
              </td>
              <td className="table-cell max-w-xs text-xs text-slate-600">{event.reason}</td>
              <td className="table-cell">
                <Badge tone={event.reviewedAt ? 'success' : 'warning'}>{event.reviewedAt ? 'Reviewed' : 'Pending'}</Badge>
              </td>
              <td className="table-cell">
                {!event.reviewedAt && (
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => review(event.id, 'JUSTIFIED')}>
                      Justified
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => review(event.id, 'ESCALATED')}>
                      Escalate
                    </Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Grants() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', type: 'AUDITOR', scopes: ['audit.read', 'deidentified.read', 'report.read'], reason: '', expiresInHours: '72' });
  const grants = useQuery({
    queryKey: ['grants'],
    queryFn: () => api.get<{ data: any[] }>('/external-grants'),
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    try {
      const res = await api.post<any>('/external-grants', {
        email: form.email,
        type: form.type,
        scope: form.scopes,
        reason: form.reason,
        expiresInHours: Number(form.expiresInHours),
      });
      toast.push(res.tempPassword ? 'Access granted. Temporary password shown in the API response.' : 'Access granted', 'success');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['grants'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not create grant', 'danger');
    }
  }

  async function revoke(id: string) {
    await api.del(`/external-grants/${id}`);
    toast.push('Grant revoked; sessions terminated.', 'success');
    queryClient.invalidateQueries({ queryKey: ['grants'] });
  }

  return (
    <Card>
      <CardHeader
        title="External access grants"
        subtitle="Auditors and vendors: scoped permissions, automatic expiry, full audit"
        actions={<Button size="sm" onClick={() => setCreating(true)}>New grant</Button>}
      />
      {grants.isLoading ? (
        <Loading />
      ) : (grants.data?.data ?? []).length === 0 ? (
        <EmptyState title="No external grants" />
      ) : (
        <Table head={['Account', 'Type', 'Scope', 'Expires', 'Status', '']}>
          {grants.data!.data.map((grant) => {
            const expired = new Date(grant.expiresAt).getTime() < Date.now();
            return (
              <tr key={grant.id}>
                <td className="table-cell text-xs">{grant.user.email}</td>
                <td className="table-cell text-xs">{grant.type}</td>
                <td className="table-cell text-xs">{grant.scope}</td>
                <td className="table-cell text-xs">{dateTime(grant.expiresAt)}</td>
                <td className="table-cell">
                  <Badge tone={grant.revokedAt ? 'neutral' : expired ? 'danger' : 'success'}>
                    {grant.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active'}
                  </Badge>
                </td>
                <td className="table-cell text-right">
                  {!grant.revokedAt && (
                    <Button size="sm" variant="ghost" onClick={() => revoke(grant.id)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Grant external access">
        <form className="space-y-3" onSubmit={create}>
          <Field label="Email" htmlFor="g-email" required>
            <Input id="g-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type" htmlFor="g-type">
              <Select id="g-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value, scopes: event.target.value === 'AUDITOR' ? ['audit.read', 'deidentified.read', 'report.read'] : ['patient.read', 'lab.read', 'report.read'] })}>
                <option value="AUDITOR">Auditor</option>
                <option value="VENDOR">Vendor</option>
              </Select>
            </Field>
            <Field label="Expires in (hours)" htmlFor="g-hours">
              <Input id="g-hours" type="number" min="1" max="720" value={form.expiresInHours} onChange={(event) => setForm({ ...form, expiresInHours: event.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            {['audit.read', 'deidentified.read', 'report.read', 'patient.read', 'lab.read'].map((scope) => (
              <label key={scope} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300 text-brand-700"
                  checked={form.scopes.includes(scope)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      scopes: event.target.checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope),
                    })
                  }
                />
                {scope}
              </label>
            ))}
          </div>
          <Field label="Reason" htmlFor="g-reason" required>
            <Textarea id="g-reason" required value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
          </Field>
          <Button type="submit">Grant access</Button>
        </form>
      </Modal>
    </Card>
  );
}

function Settings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ data: any[] }>('/settings'),
  });
  const guide = useQuery({
    queryKey: ['backup-guide'],
    queryFn: () => api.get<Record<string, string[]>>('/admin/backup-guide'),
  });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!edit) return;
    await api.put(`/settings/${edit.key}`, { value: edit.value });
    toast.push('Setting saved', 'success');
    setEdit(null);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="System settings" subtitle="Consultation fee drives automatic billing" />
        {settings.isLoading ? (
          <Loading />
        ) : (
          <Table head={['Key', 'Value', 'Updated', '']}>
            {(settings.data?.data ?? []).map((setting) => (
              <tr key={setting.key}>
                <td className="table-cell font-mono text-xs">{setting.key}</td>
                <td className="table-cell">
                  {edit && edit.key === setting.key ? (
                    <Input
                      aria-label={`Value for ${setting.key}`}
                      value={edit.value}
                      onChange={(event) => setEdit({ key: setting.key, value: event.target.value })}
                    />
                  ) : (
                    setting.value
                  )}
                </td>
                <td className="table-cell text-xs">{dateTime(setting.updatedAt)}</td>
                <td className="table-cell text-right">
                  {edit && edit.key === setting.key ? (
                    <form onSubmit={save} className="flex justify-end gap-1">
                      <Button size="sm" type="submit">Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setEdit({ key: setting.key, value: setting.value })}>
                      Edit
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Backup & continuity guidance" subtitle="Operational runbook for administrators" />
        <div className="space-y-4 p-4 text-sm">
          {guide.isLoading && <Loading />}
          {guide.data &&
            Object.entries(guide.data).map(([section, lines]) => (
              <div key={section}>
                <p className="font-semibold capitalize text-slate-800">{section}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-600">
                  {lines.map((line) => (
                    <li key={line} className="font-mono text-xs leading-relaxed">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}
