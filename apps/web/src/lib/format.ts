export function money(value: number | null | undefined, currency = 'KES') {
  if (value === null || value === undefined) return '—';
  return `${currency} ${value.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function dateTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeOnly(value: string | Date | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('en-KE', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function dateOnly(value: string | Date | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function humanStatus(status: string | null | undefined) {
  if (!status) return '—';
  return status
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function age(dateOfBirth: string | Date | null | undefined) {
  if (!dateOfBirth) return '—';
  const born = new Date(dateOfBirth);
  const diff = Date.now() - born.getTime();
  return Math.max(0, Math.floor(diff / (365.25 * 24 * 3600 * 1000)));
}

export function initials(first?: string | null, last?: string | null) {
  return `${(first ?? '?')[0] ?? ''}${(last ?? '')[0] ?? ''}`.toUpperCase();
}

export function todayInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function minutesBetween(start?: string | null, end?: string | null) {
  if (!start || !end) return null;
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}
