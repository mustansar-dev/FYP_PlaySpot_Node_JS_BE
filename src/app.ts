import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { apiSuccess } from './common/apiResponse.js';
import { HttpError } from './common/httpError.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createHealthRouter, type DatabaseHealthCheck } from './routes/health.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { createAuthRouter } from './modules/auth/router.js';
import { createVenueRouter } from './modules/venues/router.js';
import type { VenueStorage } from './modules/venues/storage.js';
import { createBookingRouter } from './modules/bookings/router.js';
import { createPaymentRouter } from './modules/payments/router.js';
import type { PaymentGateway } from './integrations/payments/provider.js';
import type { PaymentReceiptStorage } from './modules/payments/storage.js';
import { RealtimeHub } from './realtime/hub.js';
import { createCommunityRouter } from './modules/community/router.js';
import { createAnalyticsRouter } from './modules/analytics/router.js';

export interface AppOptions {
  apiPrefix: string;
  allowedOrigins: string[];
  checkDatabase: DatabaseHealthCheck;
  auth?: { prisma: PrismaClient; accessSecret: string; refreshSecret: string };
  venues?: { prisma: PrismaClient; accessSecret: string; storage?: VenueStorage };
  bookings?: {
    prisma: PrismaClient; accessSecret: string;
    onlineProvider: { provider: 'SAFEPAY' | 'DEVELOPMENT_MOCK'; environment: 'SANDBOX' | 'DEVELOPMENT' };
  };
  payments?: { prisma: PrismaClient; accessSecret: string; gateway: PaymentGateway; storage?: PaymentReceiptStorage; nodeEnv: 'development' | 'test' | 'production' };
  community?: { prisma: PrismaClient; accessSecret: string; realtime: RealtimeHub };
  analytics?: { prisma: PrismaClient; accessSecret: string };
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      // Native React Native requests commonly omit Origin; web development is allowlisted.
      if (!origin || options.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This application origin is not allowed.'));
    },
  }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request, response) => {
    response.status(200).json(apiSuccess({ status: 'ok' }));
  });
  app.use(options.apiPrefix, createHealthRouter(options.checkDatabase));
  if (options.auth) app.use(`${options.apiPrefix}`, createAuthRouter(options.auth));
  if (options.venues) app.use(`${options.apiPrefix}`, createVenueRouter(options.venues));
  if (options.bookings) app.use(`${options.apiPrefix}`, createBookingRouter(options.bookings));
  if (options.payments) app.use(`${options.apiPrefix}`, createPaymentRouter(options.payments));
  if (options.community) app.use(`${options.apiPrefix}`, createCommunityRouter(options.community));
  if (options.analytics) app.use(`${options.apiPrefix}`, createAnalyticsRouter(options.analytics));
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
