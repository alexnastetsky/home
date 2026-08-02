#!/usr/bin/env node
// Put the PRODUCTION schemas under a shared owner role that both you and the
// Databricks App can act as.
//
//   node scripts/grant-app-role.mjs <service-principal-client-id>
//
// Why a shared role instead of just granting privileges:
//
//   Postgres has no grantable ALTER or DROP privilege — the full set of table
//   privileges is INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/
//   MAINTAIN, and structural DDL is reserved to the object's owner. Both app
//   modules run `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations at
//   startup (IF NOT EXISTS does not skip the ownership check), so without
//   ownership those throw, get swallowed by a console.warn, and every future
//   migration silently never applies.
//
//   Ownership can't be granted piecemeal, but it can be shared: Postgres lets
//   members of the owning role act as owner. So a NOLOGIN group role owns the
//   objects and both parties are members.
//
// Why not just make the app's service principal the owner: recreating the app
// mints a new service principal, and neither the new one nor you could take
// ownership back from the old one — you have no ADMIN OPTION on either role,
// and you are not a superuser. Anchoring ownership to a role you created keeps
// recreation to a single GRANT.
//
// Safe to re-run. After recreating the app, this is the only step needed.
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
const OWNER = 'app_owner';

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

// pg has no placeholders for identifiers; role is regex-checked, the rest are
// constants or come from the catalog.
const q = (s) => `"${s.replace(/"/g, '""')}"`;

const deferred = [];

try {
  await client.connect();

  // 1. The shared owner role. Created by us, so we get ADMIN OPTION on it and
  //    can hand membership to any future service principal.
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER}') THEN
      CREATE ROLE ${OWNER} NOLOGIN;
    END IF;
  END $$;`);
  console.log(`✓ role ${OWNER} exists`);

  // 2. Both parties become members, so both can act as owner.
  await client.query(`GRANT ${OWNER} TO CURRENT_USER`);
  await client.query(`GRANT ${OWNER} TO ${q(role)}`);
  console.log(`✓ ${USER} and ${role} are members of ${OWNER}`);

  for (const schema of SCHEMAS) {
    // 3. The owner role needs CREATE on the schema to hold objects in it, and
    //    the app keeps explicit grants so it can read/write even before
    //    membership is considered.
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${q(schema)} TO ${OWNER}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${q(schema)} TO ${q(role)}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL PRIVILEGES ON TABLES TO ${q(role)}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(schema)} GRANT ALL PRIVILEGES ON SEQUENCES TO ${q(role)}`
    );

    // 4. Hand every object to the shared owner. Anything the app itself created
    //    is owned by the service principal, which we cannot alter — the app
    //    reassigns those itself on its next boot.
    const { rows } = await client.query(
      `SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'S')
          AND pg_get_userbyid(c.relowner) <> $2
        -- Tables first: an identity sequence cannot be reassigned on its own,
        -- but it follows its table automatically, so doing tables first leaves
        -- nothing to warn about.
        ORDER BY (c.relkind = 'S'), c.relname`,
      [schema, OWNER]
    );
    let moved = 0;
    for (const t of rows) {
      const kind = t.relkind === 'S' ? 'SEQUENCE' : 'TABLE';
      try {
        await client.query(`ALTER ${kind} ${q(schema)}.${q(t.relname)} OWNER TO ${OWNER}`);
        moved++;
      } catch {
        deferred.push(`${schema}.${t.relname} (owned by ${t.owner})`);
      }
    }
    console.log(`✓ ${schema}: ${moved} object(s) now owned by ${OWNER}`);
  }

  const { rows } = await client.query(
    `SELECT n.nspname AS schema,
            count(*) FILTER (WHERE pg_get_userbyid(c.relowner) = $1) AS owned_by_app_owner,
            count(*) FILTER (WHERE pg_get_userbyid(c.relowner) <> $1) AS other
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($2) AND c.relkind = 'r'
      GROUP BY 1 ORDER BY 1`,
    [OWNER, SCHEMAS]
  );
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await client.end();
}

if (deferred.length > 0) {
  console.log(
    `\nDeferred to the app (it owns these, we cannot alter them):\n  ${deferred.join('\n  ')}\n` +
      `Each module reassigns objects it owns to ${OWNER} at startup, so these resolve on the next deploy.`
  );
}
console.log(`\nDone. After recreating the app, re-run this with the new service principal id.`);
