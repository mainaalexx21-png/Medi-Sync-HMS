import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, PageHeader, useToast } from '../components/ui';

export default function Security() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ data: any[] }>('/auth/sessions'),
  });

  async function startMfa() {
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ qrDataUrl: string; secret: string }>('/auth/mfa/setup');
      setSetup(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start setup');
    } finally {
      setBusy(false);
    }
  }

  async function enableMfa(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code });
      setRecoveryCodes(data.recoveryCodes);
      setSetup(null);
      setCode('');
      await reload();
      toast.push('Two-factor authentication is now on.', 'success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/change', {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      toast.push('Password updated. Other devices were signed out.', 'success');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api.del(`/auth/sessions/${id}`);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    toast.push('Session signed out.', 'success');
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Security"
        description="Manage two-factor authentication, your password and active sessions."
      />

      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <Card>
          <CardHeader
            title="Two-factor authentication"
            subtitle="A second factor is required for all staff and guardians."
            actions={
              <Badge tone={me?.user.mfaEnabled ? 'success' : 'warning'}>{me?.user.mfaEnabled ? 'Enabled' : 'Not enabled'}</Badge>
            }
          />
          <div className="px-4 py-4 text-sm text-slate-600">
            {me?.user.mfaEnabled ? (
              <p>
                Your account is protected with an authenticator app. If you lose access, an administrator can reset MFA —
                every reset is logged.
              </p>
            ) : (
              <p>
                Protect your account with a time-based one-time password (TOTP). You will need an authenticator app such as
                Google Authenticator, Authy or 1Password.
              </p>
            )}

            {setup && (
              <div className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr]">
                <img src={setup.qrDataUrl} alt="QR code to enrol your authenticator app" className="h-44 w-44 rounded-lg border border-slate-200 bg-white p-2" />
                <form onSubmit={enableMfa} className="space-y-3">
                  <p className="text-xs text-slate-500">
                    Scan the code or enter this key manually:
                    <br />
                    <code className="mt-1 inline-block break-all rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">{setup.secret}</code>
                  </p>
                  <Field label="Enter the 6-digit code" htmlFor="totp">
                    <Input id="totp" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" required />
                  </Field>
                  <Button type="submit" loading={busy}>
                    Turn on two-factor
                  </Button>
                </form>
              </div>
            )}

            {recoveryCodes && (
              <Alert tone="warning" title="Save your recovery codes now">
                <p>These single-use codes are shown only once. Store them somewhere safe, offline.</p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-5">
                  {recoveryCodes.map((recovery) => (
                    <li key={recovery}>{recovery}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {!me?.user.mfaEnabled && !setup && (
              <div className="mt-3">
                <Button onClick={startMfa} loading={busy}>
                  Set up two-factor authentication
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Change password" subtitle="Minimum 12 characters with mixed case, a number and a symbol." />
          <form className="grid gap-3 px-4 py-4 sm:grid-cols-3" onSubmit={changePassword}>
            <Field label="Current password" htmlFor="current">
              <Input id="current" type="password" required value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} />
            </Field>
            <Field label="New password" htmlFor="new">
              <Input id="new" type="password" required value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm">
              <Input id="confirm" type="password" required value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
            </Field>
            <div className="sm:col-span-3">
              <Button type="submit" loading={busy}>
                Update password
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title="Active sessions" subtitle="Sessions time out after 30 minutes of inactivity." />
          {sessions.isLoading ? (
            <Loading />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(sessions.data?.data ?? []).map((session) => (
                <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-slate-800">
                      {session.userAgent?.slice(0, 60) ?? 'Unknown device'} {session.current && <Badge tone="brand">This device</Badge>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {session.ip ?? 'unknown IP'} · last active {dateTime(session.lastUsedAt)}
                    </p>
                  </div>
                  {!session.current && (
                    <Button variant="outline" size="sm" onClick={() => revoke(session.id)}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
