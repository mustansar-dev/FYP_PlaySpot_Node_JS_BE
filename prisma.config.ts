import 'dotenv/config';
import process from 'node:process';
import { defineConfig, env } from 'prisma/config';

const migrationDatabaseUrl = process.env.MIGRATOR_DATABASE_URL?.trim() || env('DATABASE_URL');
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL?.trim();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma CLI uses the DDL-capable role; the app process always uses DATABASE_URL.
    url: migrationDatabaseUrl,
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
