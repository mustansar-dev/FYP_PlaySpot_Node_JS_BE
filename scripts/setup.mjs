import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const envExamplePath = resolve(root, '.env.example');
const skipInstall = process.argv.includes('--skip-install');
const configureOnly = process.argv.includes('--configure-only');

function readEnvText(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function setEnvLine(text, key, value) {
  const expression = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const line = `${key}=${value}`;
  return expression.test(text) ? text.replace(expression, line) : `${text.trimEnd()}\n${line}\n`;
}

function configuredDatabaseUrl(value) {
  if (!value || /(^|[/:])(?:USER|PASSWORD|HOST|DATABASE)(?:[/:?]|$)/i.test(value)) return null;
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.pathname.length > 1 ? url : null;
  } catch { return null; }
}

function roleDatabaseUrl(baseValue, role, password, database) {
  const url = new URL(baseValue);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function ensureProvisioningUrls(text) {
  let values = { ...readEnvText(text), ...process.env };
  const adminUrl = values.PLAYSPOT_POSTGRES_ADMIN_URL;
  if (!configuredDatabaseUrl(adminUrl)) return { text, values, shouldProvision: false };

  const runtime = configuredDatabaseUrl(values.DATABASE_URL);
  const migrator = configuredDatabaseUrl(values.MIGRATOR_DATABASE_URL);
  const shadow = configuredDatabaseUrl(values.SHADOW_DATABASE_URL);
  if (runtime && runtime.username !== 'playspot_user') throw new Error('PLAYSPOT_POSTGRES_ADMIN_URL provisioning expects DATABASE_URL to use playspot_user.');
  if (migrator && migrator.username !== 'playspot_migrator') throw new Error('PLAYSPOT_POSTGRES_ADMIN_URL provisioning expects MIGRATOR_DATABASE_URL to use playspot_migrator.');
  const runtimePassword = values.PLAYSPOT_USER_PASSWORD || (runtime?.username === 'playspot_user' ? decodeURIComponent(runtime.password) : '') || randomBytes(32).toString('base64url');
  const migratorPassword = values.PLAYSPOT_MIGRATOR_PASSWORD || (migrator?.username === 'playspot_migrator' ? decodeURIComponent(migrator.password) : '') || randomBytes(32).toString('base64url');
  const databaseName = values.PLAYSPOT_DB_NAME || runtime?.pathname.slice(1) || 'playspot_db';
  const shadowDatabaseName = values.PLAYSPOT_SHADOW_DB_NAME || shadow?.pathname.slice(1) || 'playspot_shadow';

  if (!values.DATABASE_URL || !runtime) text = setEnvLine(text, 'DATABASE_URL', roleDatabaseUrl(adminUrl, 'playspot_user', runtimePassword, databaseName));
  if (!values.MIGRATOR_DATABASE_URL || !migrator) {
    const base = runtime?.toString() || adminUrl;
    text = setEnvLine(text, 'MIGRATOR_DATABASE_URL', roleDatabaseUrl(base, 'playspot_migrator', migratorPassword, databaseName));
  }
  if (!values.SHADOW_DATABASE_URL || !shadow) {
    const base = configuredDatabaseUrl(values.MIGRATOR_DATABASE_URL)?.toString()
      || roleDatabaseUrl(runtime?.toString() || adminUrl, 'playspot_migrator', migratorPassword, databaseName);
    text = setEnvLine(text, 'SHADOW_DATABASE_URL', roleDatabaseUrl(base, 'playspot_migrator', migratorPassword, shadowDatabaseName));
  }
  text = setEnvLine(text, 'PLAYSPOT_USER_PASSWORD', runtimePassword);
  text = setEnvLine(text, 'PLAYSPOT_MIGRATOR_PASSWORD', migratorPassword);
  text = setEnvLine(text, 'PLAYSPOT_DB_NAME', databaseName);
  text = setEnvLine(text, 'PLAYSPOT_SHADOW_DB_NAME', shadowDatabaseName);
  values = { ...readEnvText(text), ...process.env };
  return { text, values, shouldProvision: true };
}

function ensureLocalEnv() {
  let text;
  if (existsSync(envPath)) {
    text = readFileSync(envPath, 'utf8');
  } else {
    text = readFileSync(envExamplePath, 'utf8');
    text = setEnvLine(text, 'JWT_ACCESS_SECRET', randomBytes(48).toString('base64url'));
    text = setEnvLine(text, 'JWT_REFRESH_SECRET', randomBytes(48).toString('base64url'));
    writeFileSync(envPath, text, { mode: 0o600 });
    console.info('Created the ignored backend .env file and generated local JWT secrets.');
  }

  let values = readEnvText(text);
  if (!values.JWT_ACCESS_SECRET) {
    text = setEnvLine(text, 'JWT_ACCESS_SECRET', randomBytes(48).toString('base64url'));
    values.JWT_ACCESS_SECRET = readEnvText(text).JWT_ACCESS_SECRET;
  }
  if (!values.JWT_REFRESH_SECRET) {
    text = setEnvLine(text, 'JWT_REFRESH_SECRET', randomBytes(48).toString('base64url'));
    values.JWT_REFRESH_SECRET = readEnvText(text).JWT_REFRESH_SECRET;
  }

  const provisioned = ensureProvisioningUrls(text);
  text = provisioned.text;
  values = provisioned.values;

  const runtimeUrl = process.env.DATABASE_URL || values.DATABASE_URL;
  let migratorUrl = process.env.MIGRATOR_DATABASE_URL || values.MIGRATOR_DATABASE_URL;
  const shadowUrl = process.env.SHADOW_DATABASE_URL || values.SHADOW_DATABASE_URL;
  if (!migratorUrl && runtimeUrl && shadowUrl) {
    try {
      const runtime = new URL(runtimeUrl);
      const shadow = new URL(shadowUrl);
      if (runtime.hostname === shadow.hostname && runtime.port === shadow.port
        && runtime.protocol === shadow.protocol && runtime.username !== shadow.username) {
        shadow.pathname = runtime.pathname;
        shadow.search = runtime.search;
        shadow.hash = '';
        migratorUrl = shadow.toString();
        text = setEnvLine(text, 'MIGRATOR_DATABASE_URL', migratorUrl);
        console.info('Derived MIGRATOR_DATABASE_URL for the runtime database using the configured separate migrator role. The URL is not displayed.');
      }
    } catch {
      // The validation below prints the variable name only; never echo a URL.
    }
  }

  if (text !== readFileSync(envPath, 'utf8')) writeFileSync(envPath, text, { mode: 0o600 });
  values = { ...readEnvText(text), ...process.env };
  if (!values.DATABASE_URL || /(^|[/:])(?:USER|PASSWORD|HOST|DATABASE)(?:[/:?]|$)/i.test(values.DATABASE_URL)) {
    return { values, missingDatabaseConfig: true, shouldProvision: provisioned.shouldProvision };
  }
  if (!values.MIGRATOR_DATABASE_URL || /(^|[/:])(?:USER|PASSWORD|HOST|DATABASE)(?:[/:?]|$)/i.test(values.MIGRATOR_DATABASE_URL)) {
    return { values, missingDatabaseConfig: true, shouldProvision: provisioned.shouldProvision };
  }

  try {
    const app = new URL(values.DATABASE_URL);
    const migrator = new URL(values.MIGRATOR_DATABASE_URL);
    if (app.username === migrator.username) {
      throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must use separate runtime and migration roles.');
    }
    if (app.pathname !== migrator.pathname) {
      throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must target the same database name.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DATABASE_URL')) throw error;
    throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must be valid PostgreSQL URLs.');
  }

  return { values, missingDatabaseConfig: false, shouldProvision: provisioned.shouldProvision };
}

function run(command, args, env) {
  console.info(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  const { values, missingDatabaseConfig, shouldProvision } = ensureLocalEnv();
  if (configureOnly) {
    console.info('Local .env defaults and generated JWT secrets are ready; no database command was run.');
    process.exit(0);
  }
  const env = { ...process.env, ...values };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (!skipInstall) run(npm, ['ci'], env);
  if (missingDatabaseConfig) {
    console.error('\nSetup paused. Edit the ignored backend .env file and set:');
    console.error('  DATABASE_URL=... (runtime role, e.g. playspot_user)');
    console.error('  MIGRATOR_DATABASE_URL=... (DDL role, e.g. playspot_migrator, same database)');
    console.error('Or set PLAYSPOT_POSTGRES_ADMIN_URL to a local PostgreSQL administrator URL; setup can provision both roles and local databases.');
    console.error('Then run `npm run setup` again. SHADOW_DATABASE_URL is needed only for `npm run prisma:migrate:dev`.');
    process.exit(1);
  }

  if (shouldProvision) run(npm, ['run', 'db:provision'], env);
  for (const task of [
    'prisma:validate',
    'prisma:generate',
    'prisma:migrate:deploy',
    'prisma:seed',
    'db:check',
  ]) run(npm, ['run', task], env);

  console.info('\nPlaySpot backend setup is complete. Start the API with `npm run dev`.');
} catch (error) {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
}
