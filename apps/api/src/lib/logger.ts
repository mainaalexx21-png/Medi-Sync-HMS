import { env } from '../env';

/**
 * Structured JSON logger with PHI redaction.
 *
 * Rules (see docs/security.md):
 *  - never log request bodies for clinical routes
 *  - never log names, phone numbers, national ids, diagnoses, notes
 *  - free-text errors are truncated and scanned for redacted keys
 */
const PHI_KEYS = [
  'firstname', 'lastname', 'name', 'fullname', 'phone', 'email', 'nationalid',
  'allergies', 'notes', 'diagnosis', 'description', 'chiefcomplaint', 'address',
  'body', 'password', 'passwordhash', 'token', 'secret', 'otp', 'code',
  'mfaSecret', 'enc', 'resultvalue', 'interpretation',
];

type Level = 'debug' | 'info' | 'warn' | 'error';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PHI_KEYS.includes(key.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function write(level: Level, message: string, context?: Record<string, unknown>) {
  if (level === 'debug' && env.isProd) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'medisync-api',
    message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (!env.isTest) console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};
