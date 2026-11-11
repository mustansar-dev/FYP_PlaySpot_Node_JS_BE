import 'dotenv/config';
import { z } from 'zod';

const optionalUrl = z.preprocess(
  value => value === '' ? undefined : value,
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  APP_ORIGINS: z.string().default('http://localhost:8081'),
  DATABASE_URL: z.string().url().refine(
    value => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'DATABASE_URL must be a PostgreSQL connection URL',
  ),
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('venue-media'),
  GEOAPIFY_API_KEY: z.string().optional(),
  SAFEPAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  SAFEPAY_SECRET_KEY: z.string().optional(),
  SAFEPAY_API_KEY: z.string().optional(),
  SAFEPAY_WEBHOOK_SECRET: z.string().optional(),
  SAFEPAY_RETURN_URL: optionalUrl,
  SAFEPAY_CANCEL_URL: optionalUrl,
});

export type AppConfig = z.infer<typeof envSchema> & { allowedOrigins: string[] };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map(issue => issue.path.join('.') || 'environment');
    throw new Error(`Invalid environment configuration: ${[...new Set(fields)].join(', ')}`);
  }

  const allowedOrigins = result.data.APP_ORIGINS.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (result.data.NODE_ENV !== 'test') {
    const missing = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const).filter(key =>
      !result.data[key] || result.data[key]!.length < 32,
    );
    if (missing.length) throw new Error(`Invalid environment configuration: ${missing.join(', ')} must each contain at least 32 characters`);
  }

  return { ...result.data, allowedOrigins };
}
