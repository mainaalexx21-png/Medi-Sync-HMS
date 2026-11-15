/**
 * Database diagnostic: which database is the API using, and can the demo
 * accounts actually sign in?
 *
 *   npm run db:check
 *
 * Prints no secrets: the connection string is masked before it is shown.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'MediSync#2026';
const DEMO_ACCOUNTS = [
  { role: 'FRONT_DESK', email: 'reception@medisync.test' },
  { role: 'CLINICAL', email: 'doctor.amina@medisync.test' },
  { role: 'DIAGNOSTICS', email: 'pharmacist@medisync.test' },
  { role: 'FINANCE', email: 'billing@medisync.test' },
  { role: 'SYSTEM_ADMIN', email: 'admin.it@medisync.test' },
];

function maskUrl(raw?: string) {
  if (!raw) return '(not set)';
  return raw.replace(/\/\/([^:/@]+):([^@]*)@/, (_m, user) => `//${user}:***@`);
}

function readTarget(): string {
  for (const candidate of [path.join(process.cwd(), 'prisma', '.db-target'), path.join(__dirname, '.db-target')]) {
    try {
      const marker = fs.readFileSync(candidate, 'utf8').trim();
      if (marker) return marker;
    } catch {
      /* try the next location */
    }
  }
  return 'unknown (no .db-target marker yet)';
}

async function main() {
  const url = process.env.DATABASE_URL;
  console.log(`\nDATABASE_URL      : ${maskUrl(url)}`);
  console.log(`Prisma target     : ${readTarget()}`);
  console.log(`Demo password     : ${DEMO_PASSWORD}\n`);

  const prisma = new PrismaClient();
  try {
    let users: { email: string; role: string; status: string; mfaEnabled: boolean; passwordHash: string }[] = [];
    try {
      users = await prisma.user.findMany({
        select: { email: true, role: true, status: true, mfaEnabled: true, passwordHash: true },
      });
    } catch (error: any) {
      console.log('✖ Could not read the user table.');
      console.log(`  ${String(error?.message ?? error).split('\n')[0]}`);
      console.log('\n  The schema is probably not applied to this database. Run: npm run db:supabase\n');
      process.exitCode = 1;
      return;
    }

    if (!users.length) {
      console.log('✖ The database contains 0 users, so every login is rejected as "invalid credentials".');
      console.log('  Seed it with: npm run db:supabase\n');
      process.exitCode = 1;
      return;
    }

    const byRole = new Map<string, number>();
    for (const user of users) byRole.set(user.role, (byRole.get(user.role) ?? 0) + 1);
    console.log(`Users in this database: ${users.length}`);
    for (const [role, count] of [...byRole.entries()].sort()) console.log(`  ${role.padEnd(13)} ${count}`);
    console.log('');

    let failures = 0;
    for (const account of DEMO_ACCOUNTS) {
      const user = users.find((candidate) => candidate.email === account.email);
      if (!user) {
        console.log(`✖ ${account.role.padEnd(13)} ${account.email} - MISSING (seed this database)`);
        failures += 1;
        continue;
      }
      const passwordOk = await bcrypt.compare(DEMO_PASSWORD, user.passwordHash);
      const notes = [
        passwordOk ? 'password ok' : 'PASSWORD DOES NOT MATCH',
        `status=${user.status}`,
        `mfa=${user.mfaEnabled ? 'on' : 'off'}`,
        user.role === account.role ? `role=${user.role}` : `role=${user.role} (expected ${account.role})`,
      ];
      console.log(`${passwordOk && user.status === 'ACTIVE' ? '✔' : '✖'} ${account.email.padEnd(32)} ${notes.join(' · ')}`);
      if (!passwordOk || user.status !== 'ACTIVE') failures += 1;
    }

    console.log('');
    if (failures) {
      console.log('Fix: npm run db:supabase   (applies the schema when needed and seeds the demo accounts)');
      process.exitCode = 1;
    } else {
      console.log('All five demo logins exist and the shared password verifies. Staff sign-in then asks for TOTP.');
      console.log('TOTP secret: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP, or GET /api/v1/auth/dev/totp/<email> in development.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
