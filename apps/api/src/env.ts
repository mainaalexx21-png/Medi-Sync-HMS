import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment configuration. Secrets come from the environment only; there is
 * no hardcoded fallback in production (the process refuses to boot instead).
 */
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

// Prisma's `directUrl` is used by `prisma migrate`; the runtime client only
// needs `url`. Defaulting it here means one connection string is enough to boot.
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

/**
 * Locate apps/api/prisma from both `src` (tsx dev) and `dist/src` (compiled),
 * where __dirname differs by one level.
 */
function resolvePrismaDir(): string | null {
  const candidates: string[] = [];
  let dir = __dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(path.join(dir, 'prisma'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(process.cwd(), 'prisma'));
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'schema.prisma'))) ?? null;
}

/** Which datasource the Prisma client was last generated for (see scripts/db-target.mjs). */
function readDbTarget(): 'postgres' | 'sqlite' | null {
  const prismaDir = resolvePrismaDir();
  if (!prismaDir) return null;
  try {
    const marker = fs.readFileSync(path.join(prismaDir, '.db-target'), 'utf8').trim();
    return marker === 'postgres' || marker === 'sqlite' ? marker : null;
  } catch {
    return null;
  }
}

/**
 * Fail fast, with an actionable message, on the two mistakes that otherwise
 * surface as an opaque Prisma error on the first request:
 *   1. a password with unescaped reserved characters in the connection string;
 *   2. a URL that does not match the datasource the client was generated for
 *      (SQLite for the test suite, PostgreSQL for Supabase).
 */
function assertDatabaseUrl() {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env first ' +
        '(Supabase PostgreSQL URL, or file:./dev.db for the test suite).',
    );
  }

  const generated = readDbTarget();

  if (raw.startsWith('file:')) {
    if (generated === 'postgres') {
      throw new Error(
        'DATABASE_URL is a SQLite file but the Prisma client is generated for PostgreSQL. ' +
          'Run "npm run db:sqlite" for the test suite, or point DATABASE_URL at PostgreSQL and run "npm run db:supabase".',
      );
    }
    return;
  }

  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    throw new Error(
      'Unsupported DATABASE_URL. Use a postgresql:// URL (e.g. Supabase) or "file:./dev.db" for the test suite.',
    );
  }

  if (raw.includes('#')) {
    throw new Error(
      'DATABASE_URL contains "#", which truncates everything after it. ' +
        'Percent-encode reserved characters in the password: # -> %23, @ -> %40, ? -> %3F, / -> %2F, space -> %20.',
    );
  }
  const afterScheme = raw.slice(raw.indexOf('://') + 3);
  if ((afterScheme.match(/@/g) ?? []).length > 1) {
    throw new Error(
      'DATABASE_URL contains more than one "@": the password has an unescaped @. Encode it as %40, e.g. ' +
        'postgresql://postgres.abcdef:pa%40ssword@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
    );
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(
      'DATABASE_URL is not a valid URL. Percent-encode reserved characters in the password ' +
        '(# -> %23, @ -> %40, ? -> %3F, / -> %2F, space -> %20).',
    );
  }

  if (generated === 'sqlite') {
    throw new Error(
      'DATABASE_URL points at PostgreSQL but the Prisma client is generated for SQLite (the test target). ' +
        'Run "npm run db:supabase" to generate for PostgreSQL, apply the schema and seed the demo data.',
    );
  }
}

assertDatabaseUrl();

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

function required(name: string, devFallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  if (isProd) {
    throw new Error(`Missing required environment variable ${name}. Refusing to start in production.`);
  }
  // Development/test only: an ephemeral secret keeps local runs frictionless.
  // Restarting invalidates sessions in dev, which is acceptable and obvious.
  return devFallback ?? crypto.randomBytes(48).toString('base64url');
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const encryptionKeyRaw = required('FIELD_ENCRYPTION_KEY');
// Accept base64 (32 bytes) or any sufficiently long passphrase (derived).
const encryptionKey = (() => {
  const base64 = Buffer.from(encryptionKeyRaw, 'base64');
  if (base64.length === 32) return base64;
  return crypto.createHash('sha256').update(encryptionKeyRaw).digest();
})();

export const env = {
  nodeEnv,
  isProd,
  isTest,
  port: num('PORT', 4000),
  appOrigin: process.env.APP_ORIGIN ?? `http://localhost:${num('PORT', 4000)}`,
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  accessTokenTtl: num('ACCESS_TOKEN_TTL_SECONDS', 900),
  refreshTokenTtlDays: num('REFRESH_TOKEN_TTL_DAYS', 14),
  idleTimeoutMinutes: num('IDLE_TIMEOUT_MINUTES', 30),
  maxFailedLogins: num('MAX_FAILED_LOGINS', 5),
  lockoutMinutes: num('LOCKOUT_MINUTES', 15),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  refreshPepper: required('REFRESH_TOKEN_PEPPER'),
  encryptionKey,
  emailProvider: process.env.EMAIL_PROVIDER ?? 'console',
  smsProvider: process.env.SMS_PROVIDER ?? 'console',
  mpesa: {
    consumerKey: process.env.MPESA_CONSUMER_KEY ?? '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET ?? '',
    shortcode: process.env.MPESA_SHORTCODE ?? '',
    passkey: process.env.MPESA_PASSKEY ?? '',
    sandbox: (process.env.MPESA_ENV ?? 'sandbox') !== 'production',
  },
  devMfaHelper: !isProd && process.env.DEV_MFA_HELPER === 'true',
  devShowResetTokens: !isProd && process.env.DEV_SHOW_RESET_TOKENS === 'true',
  uploadsDir: process.env.UPLOADS_DIR ?? path.join(__dirname, '..', 'uploads'),
  /** In dev/test the app trusts a fixed TOTP secret so demo logins are scriptable. */
  seedTotpSecret: process.env.SEED_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

if (isProd && env.corsOrigins.some((o) => o === '*')) {
  throw new Error('Wildcard CORS origin is not allowed in production.');
}
