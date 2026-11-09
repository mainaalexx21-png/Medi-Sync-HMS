import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui';

export default function Register() {
  const { reload } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    sex: 'FEMALE',
    password: '',
    county: '',
    address: '',
    consentToProcessing: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(key: keyof typeof form, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/register', form);
      await reload();
      navigate('/portal');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
      <div className="mb-6">
        <p className="text-lg font-semibold text-brand-900">MEDI SYNC</p>
        <h1 className="mt-2 text-2xl font-semibold">Create your patient account</h1>
        <p className="mt-1 text-sm text-slate-500">
          Book appointments, view results and pay bills from any device. You can add two-factor authentication after signing in.
        </p>
      </div>

      <Card className="p-6">
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label="First name" htmlFor="firstName" required>
            <Input id="firstName" required value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
          </Field>
          <Field label="Last name" htmlFor="lastName" required>
            <Input id="lastName" required value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
          </Field>
          <Field label="Email address" htmlFor="email" required>
            <Input id="email" type="email" required autoComplete="email" value={form.email} onChange={(e) => update('email', e.target.value)} />
          </Field>
          <Field label="Phone number" htmlFor="phone" required hint="Used for appointment reminders">
            <Input id="phone" required value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+254712345678" />
          </Field>
          <Field label="Date of birth" htmlFor="dob" required>
            <Input id="dob" type="date" required value={form.dateOfBirth} onChange={(e) => update('dateOfBirth', e.target.value)} />
          </Field>
          <Field label="Sex" htmlFor="sex" required>
            <Select id="sex" value={form.sex} onChange={(e) => update('sex', e.target.value)}>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="County" htmlFor="county">
            <Input id="county" value={form.county} onChange={(e) => update('county', e.target.value)} />
          </Field>
          <Field label="Address" htmlFor="address">
            <Input id="address" value={form.address} onChange={(e) => update('address', e.target.value)} />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            required
            hint="At least 12 characters with upper case, lower case, a number and a symbol."
            className="sm:col-span-2"
          >
            <Input id="password" type="password" required autoComplete="new-password" value={form.password} onChange={(e) => update('password', e.target.value)} />
          </Field>

          <label className="flex items-start gap-2 sm:col-span-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
              checked={form.consentToProcessing}
              onChange={(e) => update('consentToProcessing', e.target.checked)}
              required
            />
            <span>
              I consent to MEDI SYNC processing my health data for care, billing and record-keeping, in line with the Kenya
              Data Protection Act, 2019. I understand I can access, correct and request deletion of my data where legally permitted.
            </span>
          </label>

          {error && (
            <div className="sm:col-span-2">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          <Button type="submit" loading={busy} className="sm:col-span-2">
            Create account
          </Button>
        </form>
      </Card>

      <p className="mt-4 text-center text-sm text-slate-500">
        Already registered?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
