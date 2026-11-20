import 'dotenv/config';
import { Pool } from 'pg';
import { URL } from 'node:url';

const adminUrl = process.env.PLAYSPOT_POSTGRES_ADMIN_URL;
const runtimePassword = process.env.PLAYSPOT_USER_PASSWORD;
const migratorPassword = process.env.PLAYSPOT_MIGRATOR_PASSWORD;
const databaseName = process.env.PLAYSPOT_DB_NAME || 'playspot_db';
const shadowDatabaseName = process.env.PLAYSPOT_SHADOW_DB_NAME || 'playspot_shadow';

function quoteIdentifier(value, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${name} must contain only letters, digits and underscores.`);
  return `"${value}"`;
}

function quoteLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

function requiredPassword(value, name) {
  if (!value || value.length < 24) throw new Error(`${name} must be at least 24 characters; let setup generate a local value or set one in .env.`);
  return value;
}

async function ensureRole(admin, roleName, password, extra = '') {
  const result = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
  const role = quoteIdentifier(roleName, 'Database role');
  if (result.rowCount) await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} ${extra}`);
  else await admin.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} ${extra}`);
}

async function ensureDatabase(admin, database, owner) {
  const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (!result.rowCount) await admin.query(`CREATE DATABASE ${quoteIdentifier(database, 'Database name')} OWNER ${quoteIdentifier(owner, 'Database owner')}`);
}

async function prepareDatabase(adminUrlValue, database, runtimeRole, migratorRole) {
  const url = new URL(adminUrlValue);
  url.pathname = `/${database}`;
  url.search = '';
  url.hash = '';
  const connection = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000, max: 1 });
  try {
    await connection.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await connection.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    const runtime = quoteIdentifier(runtimeRole, 'Runtime role');
    const migrator = quoteIdentifier(migratorRole, 'Migrator role');
    await connection.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database, 'Database name')} TO ${runtime}, ${migrator}`);
    await connection.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
    await connection.query(`GRANT CREATE ON SCHEMA public TO ${migrator}`);
    await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO ${runtime}`);
    await connection.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
    await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO ${runtime}`);
    await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime}`);
  } finally {
    await connection.end();
  }
}

try {
  if (!adminUrl) throw new Error('PLAYSPOT_POSTGRES_ADMIN_URL is missing. Set it to a local PostgreSQL administrator connection in .env.');
  const admin = new URL(adminUrl);
  if (!['postgres:', 'postgresql:'].includes(admin.protocol)) throw new Error('PLAYSPOT_POSTGRES_ADMIN_URL must be a PostgreSQL connection URL.');
  const runtimeRole = 'playspot_user';
  const migratorRole = 'playspot_migrator';
  const appPassword = requiredPassword(runtimePassword, 'PLAYSPOT_USER_PASSWORD');
  const ddlPassword = requiredPassword(migratorPassword, 'PLAYSPOT_MIGRATOR_PASSWORD');
  if (databaseName === shadowDatabaseName) throw new Error('PLAYSPOT_DB_NAME and PLAYSPOT_SHADOW_DB_NAME must differ.');

  const maintenanceUrl = new URL(admin.toString());
  maintenanceUrl.pathname = '/postgres';
  maintenanceUrl.search = '';
  maintenanceUrl.hash = '';
  const pool = new Pool({ connectionString: maintenanceUrl.toString(), connectionTimeoutMillis: 5000, max: 1 });
  try {
    await ensureRole(pool, runtimeRole, appPassword);
    await ensureRole(pool, migratorRole, ddlPassword, 'CREATEDB');
    await ensureDatabase(pool, databaseName, migratorRole);
    await ensureDatabase(pool, shadowDatabaseName, migratorRole);
  } finally {
    await pool.end();
  }
  await Promise.all([
    prepareDatabase(adminUrl, databaseName, runtimeRole, migratorRole),
    prepareDatabase(adminUrl, shadowDatabaseName, runtimeRole, migratorRole),
  ]);
  console.info(`Provisioned PostgreSQL roles ${runtimeRole} and ${migratorRole}, databases ${databaseName} and ${shadowDatabaseName}, and PostGIS extensions.`);
  console.info('Connection URLs and passwords were not printed. Check the ignored .env file for the generated local configuration.');
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? ` (${error.code})` : '';
  console.error(`Local database provisioning failed${code}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
}
