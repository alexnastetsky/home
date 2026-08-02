#!/usr/bin/env node
// Post-deploy assertion: did the app that just started actually reach Postgres?
//
//   node scripts/verify-deploy.mjs [maxAgeSeconds]      (default 600)
//
// Why this exists: a Databricks App reports "started successfully" as soon as it
// serves HTTP, which says nothing about the database. When the app is deleted and
// recreated it gets a new service principal, and with it a new Postgres role that
// holds no privileges on the pool/todolist schemas — every query then fails while
// the app looks perfectly healthy. That happened during the August 2026 flip and
// went unnoticed for ~20 minutes. Both modules now write a heartbeat row as the
// last step of schema setup; this fails the deploy if either one is stale.
//
// Each schema is checked separately on purpose: grants are per-schema, so one
// module can be fine while the other is locked out.
//
// Fix a failure with: node scripts/grant-app-role.mjs <service_principal_client_id>
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ENDPOINT = 'projects/worldcup-pool/branches/production/endpoints/primary';
const DATABASE = 'databricks_postgres';
const USER = 'seashelf@gmail.com';
const APP = 'home';
const SCHEMAS = ['pool', 'todolist'];

const maxAge = Number(process.argv[2] ?? 600);
if (!Number.isFinite(maxAge) || maxAge <= 0) {
  console.error('Usage: node scripts/verify-deploy.mjs [maxAgeSeconds]');
  process.exit(2);
}

const cli = (args) => JSON.parse(execFileSync('databricks', [...args, '--profile', 'DEFAULT', '-o', 'json'], {
  encoding: 'utf8',
}));

const app = cli(['apps', 'get', APP]);
const expectedSp = app.service_principal_client_id ?? null;

const endpoint = cli(['postgres', 'get-endpoint', ENDPOINT]);
const cred = cli(['postgres', 'generate-database-credential', ENDPOINT]);

const client = new Client({
  host: endpoint.status.hosts.host,
  port: 5432,
  database: DATABASE,
  user: USER,
  password: cred.token,
  ssl: { rejectUnauthorized: false },
  options: '-c default_transaction_read_only=on',
});

let failed = false;
try {
  await client.connect();
  console.log(`app ${APP}: ${app.app_status?.state} / ${app.compute_status?.state}`);
  console.log(`service principal: ${expectedSp}`);

  for (const schema of SCHEMAS) {
    let row;
    try {
      // Age is computed by the database, so a skewed local clock can't
      // produce a false pass or fail.
      const { rows } = await client.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - beat_at))::int AS age_s,
                beat_at, service_principal
           FROM ${schema}.app_heartbeat WHERE id = 1`
      );
      row = rows[0];
    } catch (err) {
      // Missing table = this module has never once completed schema setup.
      console.error(`✗ ${schema}: cannot read ${schema}.app_heartbeat — ${err.message}`);
      failed = true;
      continue;
    }

    if (!row) {
      console.error(`✗ ${schema}: no heartbeat row; the module never finished schema setup`);
      failed = true;
    } else if (row.age_s > maxAge) {
      console.error(
        `✗ ${schema}: heartbeat is ${row.age_s}s old (limit ${maxAge}s), last written ${row.beat_at.toISOString()}` +
          ` by ${row.service_principal ?? 'unknown'} — the running app is NOT reaching this schema`
      );
      failed = true;
    } else if (expectedSp && row.service_principal && row.service_principal !== expectedSp) {
      console.error(
        `✗ ${schema}: heartbeat written by ${row.service_principal}, but the app now runs as ${expectedSp}`
      );
      failed = true;
    } else {
      console.log(`✓ ${schema}: heartbeat ${row.age_s}s old`);
    }
  }
} finally {
  await client.end();
}

if (failed) {
  console.error(
    '\nDeploy verification FAILED. If the app was recreated, its new service principal ' +
      'needs schema grants:\n  node scripts/grant-app-role.mjs ' +
      (expectedSp ?? '<service_principal_client_id>')
  );
  process.exit(1);
}
console.log('\nDeploy verified: both schemas reachable by the running app.');
