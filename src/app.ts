import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { apiSuccess } from './common/apiResponse.js';
import { HttpError } from './common/httpError.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createHealthRouter, type DatabaseHealthCheck } from './routes/health.js';

export interface AppOptions {
  apiPrefix: string;
  allowedOrigins: string[];
  checkDatabase: DatabaseHealthCheck;
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
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
