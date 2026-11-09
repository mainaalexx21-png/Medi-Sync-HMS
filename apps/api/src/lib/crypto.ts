import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../env';
import { badRequest } from './errors';

const BCRYPT_ROUNDS = env.isTest ? 8 : 12;

/** Password hashing (bcrypt, cost 12 in prod, 8 in tests for speed). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', 'qwerty123', 'letmein123',
  'welcome123', 'admin123', 'hospital', 'medisync', 'changeme', 'iloveyou',
]);

/**
 * Password policy: >= 12 chars, upper/lower/digit/symbol, not an obvious
 * common password, and not containing the user's email local part.
 * (Breach check hook: set BREACH_CHECK_URL to query a k-anonymity API.
 *  Offline-safe by default so the app has no external dependency.)
 */
export function assertPasswordPolicy(password: string, email?: string) {
  const problems: string[] = [];
  if (password.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('not a commonly used password');
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    problems.push('not contain your email name');
  }
  if (problems.length) {
    throw badRequest(`Password must contain ${problems.join(', ')}.`, { policy: problems });
  }
}

/** AES-256-GCM field encryption for sensitive at-rest columns. */
export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptField(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const [, ivB64, dataB64, tagB64] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      env.encryptionKey,
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

/** Deterministic keyed hash (lookup/duplicate detection without storing PII). */
export function hmac(value: string): string {
  return crypto.createHmac('sha256', env.refreshPepper).update(value.trim().toLowerCase()).digest('hex');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Refresh tokens are stored hashed + peppered, never in plaintext. */
export function hashRefreshToken(token: string): string {
  return crypto.createHmac('sha256', env.refreshPepper).update(token).digest('hex');
}

/** Human-readable single-use recovery code, e.g. MS7K-2Q9F-XT4M. */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
