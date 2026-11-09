import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, PageHeader, StatusBadge, useToast,
} from '../../components/ui';

const SCOPES = ['appointments', 'prescriptions', 'labResults', 'bills', 'messages', 'demographics'];

export default function PortalGuardians() {
  const { me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', relationship: 'Spouse', scopes: ['appointments', 'bills', 'labResults'] });

  const patients = useQuery({
    queryKey: ['portal-patients'],
    queryFn: () => api.get<{ data: any[] }>('/portal/patients'),
  });
  const primary = patients.data?.data?.[0];

  const guardians = useQuery({
    queryKey: ['portal-guardians', primary?.id],
    queryFn: () => api.get<{ data: any[] }>(`/patients/${primary.id}/guardians`),
    enabled: Boolean(primary) && me?.user.role === 'PATIENT',
  });

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (!primary) return;
    try {
      const res = await api.post<any>(`/patients/${primary.id}/guardians`, form);
      toast.push(
        res.devInviteToken
          ? 'Guardian invited. Development invite token was returned to the server console.'
          : 'Guardian invited. Grant consent once you are ready.',
        'success',
      );
      setForm({ email: '', relationship: 'Spouse', scopes: ['appointments', 'bills', 'labResults'] });
      queryClient.invalidateQueries({ queryKey: ['portal-guardians', primary.id] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not invite guardian', 'danger');
    }
  }

  async function grantConsent(linkId: string) {
    if (!primary) return;
    try {
      await api.post(`/patients/${primary.id}/guardians/${linkId}/consent`, { scopes: form.scopes });
      toast.push('Consent granted', 'success');
      queryClient.invalidateQueries({ queryKey: ['portal-guardians', primary.id] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not grant consent', 'danger');
    }
  }

  async function revoke(linkId: string) {
    if (!primary) return;
    if (!window.confirm('Revoke this guardian immediately? They will lose access at once.')) return;
    try {
      await api.del(`/patients/${primary.id}/guardians/${linkId}`);
      toast.push('Access revoked', 'success');
      queryClient.invalidateQueries({ queryKey: ['portal-guardians', primary.id] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not revoke access', 'danger');
    }
  }

  if (me?.user.role === 'GUARDIAN') {
    const scopes = me.guardianLinks?.[0]?.scopes ?? '';
    return (
      <div>
        <PageHeader title="Your guardian access" description="You can only see what each patient has consented to." />
        <Card>
          <CardHeader title="Consented patients" />
          {(me.guardianLinks ?? []).length === 0 ? (
            <EmptyState title="No active consent" description="Ask the patient to invite you from their portal." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {me.guardianLinks!.map((link) => (
                <li key={link.id} className="px-4 py-3 text-sm">
                  <p className="font-medium">
                    {link.patient.firstName} {link.patient.lastName}
                  </p>
                  <p className="text-xs text-slate-500">{link.relationship}</p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {link.scopes.split(',').filter(Boolean).map((scope) => (
                      <Badge key={scope} tone="brand">
                        {scope}
                      </Badge>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="p-4 text-xs text-slate-500">
            <Alert tone="info">
              Withdrawal of consent takes effect immediately. If you need more access, ask the patient to update their
              consent settings.
            </Alert>
            <p className="mt-2">Scopes currently granted: {scopes || 'none'}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Guardian access"
        description="Let a family member or carer see parts of your record. You stay in control and can revoke access at any time."
      />

      {patients.isLoading ? (
        <Loading />
      ) : !primary ? (
        <EmptyState title="No patient record linked" description="Ask reception to link your account to your medical record." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="People with access" subtitle="All guardian access is logged and time-stamped" />
            {guardians.isLoading ? (
              <Loading />
            ) : (guardians.data?.data ?? []).length === 0 ? (
              <EmptyState title="No guardians" description="Invite someone you trust below." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {guardians.data!.data.map((link) => (
                  <li key={link.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{link.guardianEmail}</p>
                        <p className="text-xs text-slate-500">{link.relationship}</p>
                        <p className="mt-1 flex flex-wrap gap-1">
                          {link.scopes.map((scope: string) => (
                            <Badge key={scope} tone="brand">
                              {scope}
                            </Badge>
                          ))}
                          <StatusBadge status={link.status} />
                        </p>
                      </div>
                      <div className="flex flex-col gap-1">
                        {link.status === 'PENDING' && (
                          <Button size="sm" onClick={() => grantConsent(link.id)}>
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
          </Card>

          <Card>
            <CardHeader title="Invite a guardian" subtitle="They must sign in and can only see the areas you tick" />
            <form className="space-y-3 p-4" onSubmit={invite}>
              <Field label="Their email address" htmlFor="pg-email" required>
                <Input id="pg-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
              </Field>
              <Field label="Relationship" htmlFor="pg-rel">
                <Input id="pg-rel" value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} />
              </Field>
              <fieldset>
                <legend className="label">What can they see?</legend>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-brand-700"
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
              </fieldset>
              <Alert tone="warning">
                Share only what is needed. Sensitive clinical notes are never shared with guardians.
              </Alert>
              <Button type="submit" disabled={!form.scopes.length}>
                Send invitation
              </Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
