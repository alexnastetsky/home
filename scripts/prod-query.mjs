#!/usr/bin/env node
// Read-only query runner for the PRODUCTION pool database.
//
//   node scripts/prod-query.mjs "SELECT ... "
//
// Safety: the session is opened with default_transaction_read_only=on, so
// Postgres itself rejects any write regardless of the SQL text; the SELECT/
// WITH prefix check is just a friendly early error. Auth is a short-lived
// OAuth credential minted via the Databricks CLI for the caller's identity.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ENDPOINT = 'projects/worldcup-pool/branches/production/endpoints/primary';
const DATABASE = 'databricks_postgres';
const USER = 'seashelf@gmail.com';

const sql = process.argv[2];
if (!sql || !/^\s*(select|with)\b/i.test(sql)) {
  console.error('Usage: node scripts/prod-query.mjs "SELECT ..." (read-only)');
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
  options: '-c default_transaction_read_only=on',
});

try {
  await client.connect();
  const { rows } = await client.query(sql);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await client.end();
}
