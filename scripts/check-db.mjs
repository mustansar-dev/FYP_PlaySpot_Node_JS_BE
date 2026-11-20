import 'dotenv/config';
import { URL } from 'node:url';
import { Pool } from 'pg';

const appUrl = process.env.DATABASE_URL;
const migratorUrl = process.env.MIGRATOR_DATABASE_URL;

function requireUrl(value, name) {
  if (!value) throw new Error(`${name} is missing. Set it in the ignored backend .env file.`);
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    return url;
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL connection URL.`);
  }
}

async function inspectConnection(label, url) {
  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, max: 1 });
  try {
    const result = await pool.query(`
      SELECT current_user AS role,
        current_database() AS database,
        has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
        has_table_privilege(current_user, 'public.users', 'INSERT') AS can_create_users,
        has_table_privilege(current_user, 'public.sports', 'SELECT') AS can_read_sports,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist,
        to_regclass('public.sports') IS NOT NULL AS sports_table,
        to_regclass('public._prisma_migrations') IS NOT NULL AS migrations_table
    `);
    const row = result.rows[0];
    const sportsResult = row.sports_table ? await pool.query('SELECT COUNT(*)::int AS count FROM public.sports WHERE is_active') : { rows: [{ count: 0 }] };
    return {
      label,
      role: row.role,
      database: row.database,
      publicUsage: row.public_usage,
      publicCreate: row.public_create,
      canCreateUsers: row.can_create_users,
      canReadSports: row.can_read_sports,
      postgis: row.postgis,
      btreeGist: row.btree_gist,
      sportsTable: row.sports_table,
      activeSports: sportsResult.rows[0].count,
      migrationsTable: row.migrations_table,
    };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : error?.name || 'connection error';
    throw new Error(`${label} database connection failed (${code}); verify its role and connection URL.`);
  } finally {
    await pool.end();
  }
}

try {
  const runtimeUrl = requireUrl(appUrl, 'DATABASE_URL');
  const migratorConnection = requireUrl(migratorUrl, 'MIGRATOR_DATABASE_URL');
  if (runtimeUrl.username === migratorConnection.username) {
    throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must use different roles (playspot runtime and playspot_migrator).');
  }
  if (runtimeUrl.hostname !== migratorConnection.hostname || runtimeUrl.port !== migratorConnection.port
    || runtimeUrl.pathname !== migratorConnection.pathname) {
    throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must target the same server and database.');
  }

  const [app, migrator] = await Promise.all([
    inspectConnection('Runtime', runtimeUrl),
    inspectConnection('Migrator', migratorConnection),
  ]);
  if (app.database !== migrator.database) throw new Error('The runtime and migrator roles are connected to different databases.');
  if (app.role !== decodeURIComponent(runtimeUrl.username) || migrator.role !== decodeURIComponent(migratorConnection.username)) {
    throw new Error('The connected PostgreSQL roles do not match the roles in the configured URLs.');
  }
  if (!app.publicUsage) throw new Error('The runtime role needs USAGE on the public schema.');
  if (!app.canCreateUsers || !app.canReadSports) throw new Error('The runtime role needs account-write and sports-catalog read privileges.');
  if (!migrator.publicCreate) throw new Error('The migrator role needs CREATE on the public schema to apply Prisma migrations.');
  if (!app.postgis || !app.btreeGist) throw new Error('PostGIS and btree_gist extensions are required; run the approved database migrations.');
  if (!app.sportsTable || !app.migrationsTable) throw new Error('The database schema is not initialized; run `npm run db:setup`.');
  if (!app.activeSports) throw new Error('The sports catalog is empty; run `npm run prisma:seed` or `npm run db:setup`.');

  console.info(`Runtime role ${app.role}: connected to ${app.database}; schema read access is available.`);
  console.info(`Migrator role ${migrator.role}: connected to ${migrator.database}; schema create access is available.`);
  console.info('PostGIS, btree_gist, the Prisma migrations table and sports catalog table are present.');
} catch (error) {
  console.error(`Database check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
}
