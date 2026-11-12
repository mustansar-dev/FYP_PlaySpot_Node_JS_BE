import { createServer } from 'node:http';
import { loadConfig } from './config/env.js';
import { disconnectPrismaClient, getPrismaClient } from './database/prisma.js';
import { createApp } from './app.js';
import { SupabaseVenueStorage } from './modules/venues/storage.js';
import { createPaymentGateway } from './integrations/payments/provider.js';
import { SupabasePaymentReceiptStorage } from './modules/payments/storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrismaClient(config.DATABASE_URL);
  const gateway = createPaymentGateway({
    paymentProvider: config.PAYMENT_PROVIDER,
    nodeEnv: config.NODE_ENV,
    safepay: {
      environment: 'sandbox',
      ...(config.SAFEPAY_API_KEY ? { apiKey: config.SAFEPAY_API_KEY } : {}),
      ...(config.SAFEPAY_SECRET_KEY ? { secretKey: config.SAFEPAY_SECRET_KEY } : {}),
      ...(config.SAFEPAY_WEBHOOK_SECRET ? { webhookSecret: config.SAFEPAY_WEBHOOK_SECRET } : {}),
      ...(config.SAFEPAY_RETURN_URL ? { returnUrl: config.SAFEPAY_RETURN_URL } : {}),
      ...(config.SAFEPAY_CANCEL_URL ? { cancelUrl: config.SAFEPAY_CANCEL_URL } : {}),
    },
  });
  const app = createApp({
    apiPrefix: config.API_PREFIX,
    allowedOrigins: config.allowedOrigins,
    checkDatabase: async () => { await prisma.$queryRaw`SELECT 1`; },
    auth: {
      prisma,
      accessSecret: config.JWT_ACCESS_SECRET!,
      refreshSecret: config.JWT_REFRESH_SECRET!,
    },
    venues: {
      prisma,
      accessSecret: config.JWT_ACCESS_SECRET!,
      ...(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY ? {
        storage: new SupabaseVenueStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, config.SUPABASE_STORAGE_BUCKET),
      } : {}),
    },
    bookings: {
      prisma,
      accessSecret: config.JWT_ACCESS_SECRET!,
      onlineProvider: { provider: gateway.provider, environment: gateway.environment },
    },
    payments: {
      prisma,
      accessSecret: config.JWT_ACCESS_SECRET!,
      gateway,
      nodeEnv: config.NODE_ENV,
      ...(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY ? {
        storage: new SupabasePaymentReceiptStorage(
          config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, config.PAYMENT_RECEIPTS_BUCKET,
        ),
      } : {}),
    },
  });
  const server = createServer(app);

  server.listen(config.PORT, () => {
    console.info(`PlaySpot API listening on port ${config.PORT} (${config.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    console.info(`Received ${signal}; closing the HTTP server.`);
    server.close(() => {
      void disconnectPrismaClient().finally(() => process.exit(0));
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`PlaySpot API startup failed: ${message}`);
  process.exitCode = 1;
});
