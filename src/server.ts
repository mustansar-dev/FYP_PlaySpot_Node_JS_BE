import { createServer } from 'node:http';
import { loadConfig } from './config/env.js';
import { disconnectPrismaClient, getPrismaClient } from './database/prisma.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrismaClient(config.DATABASE_URL);
  const app = createApp({
    apiPrefix: config.API_PREFIX,
    allowedOrigins: config.allowedOrigins,
    checkDatabase: async () => { await prisma.$queryRaw`SELECT 1`; },
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
