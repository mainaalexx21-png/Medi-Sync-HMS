# Database: Supabase (PostgreSQL) and the SQLite test target

`apps/api/prisma/schema.prisma` targets **PostgreSQL** - Supabase or any
PostgreSQL 14+ server. The SQLite database is only for the automated tests and
offline work.

| Command | What it does |
| --- | --- |
| `npm run db:supabase` | generate the PostgreSQL client, apply migrations (`migrate deploy`, falling back to `db push`), seed the demo data |
| `npm run db:sqlite` | derive `prisma/schema.sqlite.prisma`, generate the SQLite client, push, seed - for `npm test` or offline work |
| `npm run db:reset` | **destructive**: drop and recreate the PostgreSQL schema, then seed |
| `npm test` | prepares the SQLite test database itself, no server needed |

Prisma bakes the datasource provider into the generated client, and `provider`
cannot come from an environment variable. That is why the SQLite target is a
derived schema file rather than an `.env` switch, and why a mismatch is reported
at startup instead of failing inside Prisma:

> DATABASE_URL points at PostgreSQL but the Prisma client is generated for SQLite
> (the test target). Run "npm run db:supabase" ...

After running `npm test`, run `npm run db:supabase` before starting the API
against Supabase again.

## Supabase setup

1. Create a project at supabase.com.
2. **Project Settings → Database → Connection string → Session pooler** (URI):

   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

   Use the pooler host: `db.<ref>.supabase.co` is IPv6-only on most projects.
   Port `5432` is session mode and works for migrations and the API. Port `6543`
   is the transaction pooler and needs `?pgbouncer=true&connection_limit=1`.
3. Put it in `apps/api/.env` as **both** `DATABASE_URL` and `DIRECT_URL` (the
   init migration uses `directUrl`; the API falls back to `DATABASE_URL` if it
   is missing). Percent-encode the password:

   | character | encoded |
   | --------- | ------- |
   | `@`       | `%40`   |
   | `#`       | `%23`   |
   | `?`       | `%3F`   |
   | `/`       | `%2F`   |
   | space     | `%20`   |

   ```bash
   node -e "console.log(encodeURIComponent(process.argv[1]))" 'my#pa@ss word'
   ```

   An un-encoded `#` truncates the URL and an un-encoded `@` makes the host
   unparseable; both show up later as `The provided database string is invalid`.
4. Apply the schema and load the demo users:

   ```bash
   npm run db:supabase
   ```

   Success ends with `Seed complete.` and prints the current TOTP code.
5. Start the stack and sign in:

   ```bash
   npm run dev
   ```

   Five role logins, all with password `MediSync#2026`:

   | Role | Email |
   | --- | --- |
   | `FRONT_DESK` | `reception@medisync.test` |
   | `CLINICAL` | `doctor.amina@medisync.test` |
   | `DIAGNOSTICS` | `pharmacist@medisync.test` |
   | `FINANCE` | `billing@medisync.test` |
   | `SYSTEM_ADMIN` | `admin.it@medisync.test` |

   Staff accounts require TOTP: secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`, or
   `GET /api/v1/auth/dev/totp/<email>` with `DEV_MFA_HELPER=true`.

## Troubleshooting

**"Invalid credentials" on a brand-new database.** The schema exists but the
users do not: seeding creates them. Run `npm run db:supabase`.
`Seed complete.` must appear.

**`The provided database string is invalid ... arguments are not supported`.**
Either the password has un-encoded reserved characters, or the Prisma client was
generated for SQLite by a test run. The API now refuses to start with a specific
message for both. Fix with `npm run db:supabase` (after checking the URL).

**`Environment variable not found: DIRECT_URL`.** `prisma migrate` needs it;
copy the same connection string from `DATABASE_URL`.

**`P3005: The database schema is not empty`.** The tables were created before
the migration history existed. Either apply the schema without migrations:

```bash
cd apps/api && npx prisma db push
```

or mark the init migration as already applied:

```bash
cd apps/api && npx prisma migrate resolve --applied 20261115180132_init
```

**Tests fail with a provider/URL error.** Run `npm test` again - the global test
setup derives and generates the SQLite client itself. If a manual step got in
the way, `npm run db:sqlite` then `npm test` fixes it.
