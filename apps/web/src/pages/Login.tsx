import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ApiError } from '../lib/api';
import { landingFor, useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input } from '../components/ui';

const DEMO_ACCOUNTS = [
  { role: 'Front desk · receptionist', email: 'reception@medisync.test' },
  { role: 'Front desk · records', email: 'records@medisync.test' },
  { role: 'Clinical · doctor', email: 'doctor.amina@medisync.test' },
  { role: 'Clinical · nurse', email: 'nurse@medisync.test' },
  { role: 'Diagnostics · lab', email: 'lab@medisync.test' },
  { role: 'Diagnostics · imaging', email: 'radiology@medisync.test' },
  { role: 'Diagnostics · pharmacy', email: 'pharmacist@medisync.test' },
  { role: 'Finance · billing', email: 'billing@medisync.test' },
  { role: 'Finance · HR & rota', email: 'hr@medisync.test' },
  { role: 'System admin', email: 'admin.it@medisync.test' },
  { role: 'Patient', email: 'grace@example.test' },
  { role: 'Guardian', email: 'guardian@example.test' },
];

export default function Login() {
  const { me, login, verifyMfa, loading } = useAuth();
  const navigate = useNavigate();
  const [portal, setPortal] = useState<'staff' | 'patient'>('staff');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<{ token: string; hint: string; method: string } | null>(null);
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState<'TOTP' | 'RECOVERY' | 'EMAIL'>('TOTP');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && me) return <Navigate to={landingFor(me)} replace />;

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim(), password, portal);
      if (result) {
        setChallenge({ token: result.mfaToken, hint: result.emailHint, method: result.method });
        setChannel('TOTP');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      await verifyMfa(challenge.token, code.trim(), channel);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/mfa/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken: challenge.token, channel: 'EMAIL' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? 'Could not send a code');
      setChannel('EMAIL');
      setInfo(
        body.devCode
          ? `Development mode: your email code is ${body.devCode}`
          : `A one-time code was sent to ${body.hint}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between bg-brand-950 p-10 text-white lg:flex">
        <div>
          <p className="text-lg font-semibold tracking-tight">MEDI SYNC</p>
          <p className="mt-1 text-sm text-brand-300">Hospital Management System</p>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight text-white">
            One system for every part of the hospital.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-brand-100/80">
            Appointments, records, queues, pharmacy, laboratory and billing — coordinated in real time so patients
            spend less time waiting and clinicians spend more time caring.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-brand-100/90">
            {[
              'Role-based access with mandatory two-factor authentication',
              'Live queue positions and estimated wait times',
              'Every record view and change written to an immutable audit trail',
              'Patient portal for appointments, results, prescriptions and bills',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-0.5 text-brand-300" aria-hidden="true">
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-brand-400">Aligned with the Kenya Data Protection Act, 2019.</p>
      </section>

      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 lg:hidden">
            <p className="text-lg font-semibold text-brand-900">MEDI SYNC</p>
            <p className="text-xs text-slate-500">Hospital Management System</p>
          </div>

          {!challenge ? (
            <Card className="p-6">
              <h2 className="text-xl font-semibold">Sign in</h2>
              <p className="mt-1 text-sm text-slate-500">Choose your portal, then enter your credentials.</p>

              <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="Portal">
                {(['staff', 'patient'] as const).map((option) => (
                  <button
                    key={option}
                    role="tab"
                    aria-selected={portal === option}
                    onClick={() => setPortal(option)}
                    className={clsx(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition',
                      portal === option ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-600 hover:text-slate-900',
                    )}
                  >
                    {option === 'staff' ? 'Hospital staff' : 'Patient portal'}
                  </button>
                ))}
              </div>

              <form className="mt-5 space-y-4" onSubmit={submitPassword}>
                <Field label={portal === 'staff' ? 'Work email' : 'Email address'} htmlFor="email" required>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={portal === 'staff' ? 'you@hospital.ke' : 'you@example.com'}
                  />
                </Field>
                <Field label="Password" htmlFor="password" required>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                  />
                </Field>
                {error && <Alert tone="danger">{error}</Alert>}
                <Button type="submit" loading={busy} className="w-full">
                  Continue
                </Button>
              </form>

              <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                <Link to="/register" className="font-medium text-brand-700 hover:underline">
                  Create a patient account
                </Link>
                <span>Forgot password? Ask reception.</span>
              </div>

              <details className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <summary className="cursor-pointer font-medium text-slate-700">Demo accounts (development)</summary>
                <p className="mt-2">
                  Password for all demo users: <code className="rounded bg-white px-1 py-0.5">MediSync#2026</code>
                </p>
                <p className="mt-1">
                  Staff MFA code: use the authenticator secret <code className="rounded bg-white px-1 py-0.5">JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP</code>,
                  or fetch the current code with <code className="rounded bg-white px-1 py-0.5">GET /api/v1/auth/dev/totp/&lt;email&gt;</code> (disabled in production).
                </p>
                <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {DEMO_ACCOUNTS.map((account) => (
                    <li key={account.email} className="flex flex-col">
                      <span className="font-medium text-slate-700">{account.role}</span>
                      <button
                        type="button"
                        className="truncate text-left text-brand-700 hover:underline"
                        onClick={() => {
                          setEmail(account.email);
                          setPassword('MediSync#2026');
                          setPortal(account.role === 'Patient' || account.role === 'Guardian' ? 'patient' : 'staff');
                        }}
                      >
                        {account.email}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          ) : (
            <Card className="p-6">
              <h2 className="text-xl font-semibold">Two-factor verification</h2>
              <p className="mt-1 text-sm text-slate-500">
                Enter the 6-digit code from your authenticator app for <strong>{challenge.hint}</strong>.
              </p>

              <form className="mt-5 space-y-4" onSubmit={submitCode}>
                <Field label={channel === 'RECOVERY' ? 'Recovery code' : 'Verification code'} htmlFor="code" required>
                  <Input
                    id="code"
                    inputMode={channel === 'RECOVERY' ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={channel === 'RECOVERY' ? 'ABCD-EFGH-IJKL' : '123456'}
                  />
                </Field>
                {info && <Alert tone="info">{info}</Alert>}
                {error && <Alert tone="danger">{error}</Alert>}
                <Button type="submit" loading={busy} className="w-full">
                  Verify and sign in
                </Button>
              </form>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                <button
                  className="font-medium text-brand-700 hover:underline"
                  onClick={() => {
                    setChannel(channel === 'RECOVERY' ? 'TOTP' : 'RECOVERY');
                    setCode('');
                    setError(null);
                  }}
                >
                  {channel === 'RECOVERY' ? 'Use authenticator code' : 'Use a recovery code'}
                </button>
                <button className="font-medium text-brand-700 hover:underline" onClick={sendEmailCode} disabled={busy}>
                  Email me a one-time code
                </button>
                <button
                  className="text-slate-500 hover:underline"
                  onClick={() => {
                    setChallenge(null);
                    setCode('');
                    setError(null);
                    setInfo(null);
                  }}
                >
                  Start over
                </button>
              </div>
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}
