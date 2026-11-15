import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fresh SQLite database for every test run: drop, push the schema, seed.
 *
 * The committed schema targets PostgreSQL, so a SQLite copy is derived here
 * (same models, provider sqlite, no directUrl) and the Prisma client is
 * generated from it. `npm run db:sqlite` writes the same file for manual use,
 * so the suite runs from a clean checkout with no database server.
 */
export default function globalSetup() {
  const apiDir = path.join(__dirname, '..');
  const prismaDir = path.join(apiDir, 'prisma');
  for (const file of ['test.db', 'test.db-journal']) {
    const target = path.join(prismaDir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }

  const source = fs.readFileSync(path.join(prismaDir, 'schema.prisma'), 'utf8');
  const sqliteSource = source
    .replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"')
    .replace(/^\s*directUrl\s*=\s*env\("DIRECT_URL"\)\s*\r?\n/m, '');
  if (!sqliteSource.includes('provider = "sqlite"')) {
    throw new Error('Could not derive the SQLite schema - check the datasource block in prisma/schema.prisma');
  }
  fs.writeFileSync(path.join(prismaDir, 'schema.sqlite.prisma'), sqliteSource, 'utf8');

  const env = {
    ...process.env,
    DATABASE_URL: 'file:./test.db',
    NODE_ENV: 'test',
    FIELD_ENCRYPTION_KEY: 'dGVzdC1maWVsZC1rZXktMzItYnl0ZXMtbG9uZy0hIQ==',
    REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-0123456789',
    SEED_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  };

  // The client must match the schema it is pushed with, hence generate first.
  execSync('npx prisma generate --schema prisma/schema.sqlite.prisma', {
    cwd: apiDir,
    env,
    stdio: 'pipe',
  });
  execSync('npx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate --force-reset', {
    cwd: apiDir,
    env,
    stdio: 'pipe',
  });
  execSync('npx tsx prisma/seed.ts', { cwd: apiDir, env, stdio: 'pipe' });

  fs.writeFileSync(path.join(prismaDir, '.db-target'), 'sqlite\n');
}
