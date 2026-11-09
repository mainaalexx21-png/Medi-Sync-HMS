import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fresh SQLite database for every test run: drop, push the schema, seed.
 * Uses the same schema as production, just a different connection string.
 */
export default function globalSetup() {
  const prismaDir = path.join(__dirname, '..', 'prisma');
  for (const file of ['test.db', 'test.db-journal']) {
    const target = path.join(prismaDir, file);
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  const env = {
    ...process.env,
    DATABASE_URL: 'file:./test.db',
    NODE_ENV: 'test',
    FIELD_ENCRYPTION_KEY: 'dGVzdC1maWVsZC1rZXktMzItYnl0ZXMtbG9uZy0hIQ==',
    REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-0123456789',
    SEED_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  };
  execSync('npx prisma db push --skip-generate --force-reset', {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'pipe',
  });
  execSync('npx tsx prisma/seed.ts', {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'pipe',
  });
}
