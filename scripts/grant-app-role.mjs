#!/usr/bin/env node
// Grant the app's service principal access to the PRODUCTION schemas.
//
//   node scripts/grant-app-role.mjs <service-principal-client-id>
//
// Both schemas are owned by seashelf@gmail.com, not by the app, so a newly
// created app gets a fresh Postgres role with no privileges on them and every
// query fails. Deleting and recreating the Databricks App mints a new service
// principal, so this has to be re-run after any such flip — the symptom is an
// app that starts fine but never writes (e.g. pool.sync_state stops advancing).
//
// Find the client id with:
//   databricks apps get <app> -o json | jq -r .service_principal_client_id
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ENDPOINT = 'projects/worldcup-pool/branches/production/endpoints/primary';
const DATABASE = 'databricks_postgres';
const USER = 'seashelf@gmail.com';
const SCHEMAS = ['pool', 'todolist'];

const role = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(role ?? '')) {
  console.error('Usage: node scripts/grant-app-role.mjs <service-principal-client-id>');
  process.exit(2);
}

const endpoint = JSON.parse(
  execFileSync('databricks', ['postgres', 'get-endpoint', ENDPOINT, '--profile', 'DEFAULT', '-o', 'json'], {
    encoding: 'utf8',
  })
);
const cred = JSON.parse(
  execFileSync(
    'databricks',
    ['postgres', 'generate-database-credential', ENDPOINT, '--profile', 'DEFAULT', '-o', 'json'],
    { encoding: 'utf8' }
  )
);

const client = new Client({
  host: endpoint.status.hosts.host,
  port: 5432,
  database: DATABASE,
  user: USER,
  password: cred.token,
  ssl: { rejectUnauthorized: false },
});

// pg has no placeholders for identifiers; the role is regex-checked above.
const q = (s) => `"${s.replace(/"/g, '""')}"`;

try {
  await client.connect();
  for (const schema of SCHEMAS) {
    // CREATE is needed too: both modules run CREATE TABLE IF NOT EXISTS and
    // one-shot migrations on every startup.
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${q(schema)} TO ${q(role)}`);
    // Tables created later (by either party) should be reachable too.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL PRIVILEGES ON TABLES TO ${q(role)}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL PRIVILEGES ON SEQUENCES TO ${q(role)}`
    );
    console.log(`granted ${role} on schema ${schema}`);
  }

  const { rows } = await client.query(
    `SELECT n.nspname AS schema,
            has_schema_privilege($1, n.nspname, 'USAGE')  AS usage_ok,
            has_schema_privilege($1, n.nspname, 'CREATE') AS create_ok
       FROM pg_namespace n WHERE n.nspname = ANY($2)`,
    [role, SCHEMAS]
  );
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await client.end();
}
