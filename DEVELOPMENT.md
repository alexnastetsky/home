# Development Workflow

## Environments

|              | Production                                          | Local dev & tests                     |
| ------------ | --------------------------------------------------- | ------------------------------------- |
| App          | Databricks App `home`                      | `npm run dev` on localhost:8000       |
| Database     | Lakebase `production` branch, `databricks_postgres` | Lakebase `dev` branch, `worldcup_dev` |
| Schema owner | `app_owner` role — you and the app are both members | Your user (`seashelf@gmail.com`)      |
| Connection   | Injected by the platform at deploy                  | `.env` (gitignored, never deployed)   |

Postgres has no grantable ALTER, so the startup `ADD COLUMN IF NOT EXISTS`
migrations only run if the app *owns* its tables. Production objects therefore
belong to a shared `app_owner` role that both you and the app's service
principal are members of. **Recreating the Databricks App mints a new service
principal — re-run `node scripts/grant-app-role.mjs <new-sp-client-id>` after
any such flip**, or schema setup fails silently and `npm run ship` stops at
`verify:deploy`.

The `dev` branch database is fully isolated: tests can save picks, lock, enter
results, and reset without touching the real pool. Because your user owns the
`pool` schema there, schema migrations in `apps/worldcup/server/index.ts` also
run locally — so they are exercised by tests _before_ a deploy, not after.

## The loop

```bash
npm run dev                                    # local app on the dev branch DB
npm test                                       # vitest + Playwright smoke (uses system Chrome)
databricks apps validate --profile DEFAULT     # typecheck, lint, build, tests
databricks apps deploy --profile DEFAULT       # ship to production
```

`npm run dev` serves the built client bundles, so run `npm run build` first (or
`npm run build:worldcup` / `npm run build:todolist`) after changing client code.
For HMR on one app, run its own Vite server alongside: `npm run dev:worldcup` or
`npm run dev:todolist` — both proxy their `/…/api` calls back to port 8000.

## The apps are submodules

`apps/worldcup` and `apps/todolist` are separate git repos. To change one:

```bash
cd apps/todolist && git add -A && git commit && git push   # in the submodule
cd ../.. && git add apps/todolist && git commit            # move the pointer here
```

A fresh clone needs `git submodule update --init` before anything will build.

Identity locally comes from `DEV_USER_EMAIL` in `.env` (the Apps proxy header
`x-forwarded-email` replaces it in production).

## Resetting the dev database

The admin **Reset pool** button (or `POST /worldcup/api/admin/reset`) returns it to
seeded-fixtures state. For a truly fresh start, drop and recreate:

```bash
databricks postgres delete-database projects/worldcup-pool/branches/dev/databases/worldcup-dev --profile DEFAULT
databricks postgres create-database projects/worldcup-pool/branches/dev \
  --database-id worldcup-dev \
  --json '{"spec": {"postgres_database": "worldcup_dev", "role": "projects/worldcup-pool/branches/dev/roles/seashelf"}}' \
  --profile DEFAULT
```

The app recreates and seeds the schema on next startup.

## Production data — handle with care

The deployed app's database is the `production` branch. Don't point `.env` at
it; anything the local app writes there is real. If you need a copy of current
production data to debug against, create a fresh branch from `production`
(copy-on-write, seconds):

```bash
databricks postgres create-branch projects/worldcup-pool snapshot-$(date +%m%d) \
  --json '{"spec": {"source_branch": "projects/worldcup-pool/branches/production", "ttl": "172800s"}}' \
  --profile DEFAULT
```
