#!/usr/bin/env node
/**
 * Prepare a database for MEDI SYNC.
 *
 * The committed schema targets PostgreSQL, which is what Supabase runs.
 *
 *   npm run db:supabase   generate + migrate/push + seed against DATABASE_URL
 *   npm run db:sqlite     local SQLite client + schema, used by `npm test`
 *
 * Why the SQLite command exists: the test suite runs on SQLite so it needs no
 * server. Prisma bakes the datasource provider into the generated client and
 * `provider` cannot come from an environment variable, so the SQLite client is
 * generated from a derived `prisma/schema.sqlite.prisma` (identical models,
 * provider sqlite, no directUrl). `npm test` derives it too, so the suite stays
 * runnable from a clean checkout.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..', 'apps', 'api');
const schemaFile = path.join(apiDir, 'prisma', 'schema.prisma');
const sqliteSchemaFile = path.join(apiDir, 'prisma', 'schema.sqlite.prisma');
const markerFile = path.join(apiDir, 'prisma', '.db-target');

const target = (process.argv[2] ?? 'postgres').toLowerCase();
const databaseUrl = (process.env.DATABASE_URL ?? '').trim();

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Runs a command and prints its output once it finishes (piped stdio is what
 *  keeps `tsx` from holding the terminal open on Windows). */
function run(label, args, extraEnv = {}) {
  console.log(`\n› ${label}`);
  const result = spawnSync('npx', args, {
    cwd: apiDir,
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0;
}

function writeSqliteSchema() {
  const source = fs.readFileSync(schemaFile, 'utf8');
  const swapped = source
    .replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"')
    .replace(/^\s*directUrl\s*=\s*env\("DIRECT_URL"\)\s*\r?\n/m, '');
  if (!swapped.includes('provider = "sqlite"')) {
    fail('Could not find `provider = "postgresql"` in prisma/schema.prisma - has the datasource block changed?');
  }
  fs.writeFileSync(sqliteSchemaFile, swapped, 'utf8');
}

if (!['postgres', 'supabase', 'sqlite'].includes(target)) {
  fail('Usage: node scripts/db-target.mjs [postgres|sqlite]  (npm run db:supabase / db:sqlite)');
}

if (target !== 'sqlite') {
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    fail(
      'DATABASE_URL must be a PostgreSQL URL for this target, e.g.\n' +
        '  DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"\n' +
        `Currently: ${databaseUrl ? databaseUrl.replace(/:\/\/[^@]*@/, '://***@') : '(not set)'}`,
    );
  }
  if (databaseUrl.includes('#')) {
    fail('DATABASE_URL contains "#", which silently truncates the URL. Encode it as %23 in the password.');
  }
  // `prisma migrate` reads directUrl; a single connection string is enough.
  const directUrl = process.env.DIRECT_URL?.trim() || databaseUrl;

  if (!run('prisma generate (PostgreSQL)', ['prisma', 'generate'])) fail('prisma generate failed');

  const migrated = run('prisma migrate deploy', ['prisma', 'migrate', 'deploy'], { DIRECT_URL: directUrl });
  if (!migrated) {
    console.log('\n! migrate deploy did not apply cleanly (the database may already hold these tables).');
    console.log('  Falling back to `prisma db push`, which reconciles the schema without dropping data.');
    if (!run('prisma db push', ['prisma', 'db', 'push', '--skip-generate'], { DIRECT_URL: directUrl })) {
      fail(
        'Could not apply the schema. If the database was created before the migration history existed, ' +
          'run: npx prisma migrate resolve --applied 20261115180132_init',
      );
    }
  }

  if (!run('seed demo data', ['tsx', 'prisma/seed.ts'], { DIRECT_URL: directUrl })) {
    fail('Seeding failed - see the error above.');
  }
  fs.writeFileSync(markerFile, 'postgres\n', 'utf8');
  console.log('\n✔ PostgreSQL is ready and the demo data is loaded. Start with: npm run dev');
  process.exit(0);
}

// SQLite: only for the automated tests / offline work.
if (databaseUrl && !databaseUrl.startsWith('file:')) {
  fail(
    'DATABASE_URL still points at a server. Set it to a SQLite file first:\n' +
      '  DATABASE_URL="file:./dev.db"',
  );
}
writeSqliteSchema();
if (!run('prisma generate (SQLite)', ['prisma', 'generate', '--schema', 'prisma/schema.sqlite.prisma'])) {
  fail('prisma generate failed');
}
if (!run('prisma db push (SQLite)', ['prisma', 'db', 'push', '--schema', 'prisma/schema.sqlite.prisma', '--skip-generate'])) {
  fail('prisma db push failed');
}
if (!run('seed demo data', ['tsx', 'prisma/seed.ts'])) fail('Seeding failed - see the error above.');
fs.writeFileSync(markerFile, 'sqlite\n', 'utf8');
console.log('\n✔ SQLite is ready (schema.sqlite.prisma). Run `npm run db:supabase` before using Supabase again.');
