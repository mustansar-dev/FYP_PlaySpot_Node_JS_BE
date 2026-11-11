import { Router } from 'express';
import { apiError, apiSuccess } from '../common/apiResponse.js';

export type DatabaseHealthCheck = () => Promise<void>;

export function createHealthRouter(checkDatabase: DatabaseHealthCheck): Router {
  const router = Router();

  router.get('/health', async (_request, response) => {
    try {
      await checkDatabase();
      response.status(200).json(apiSuccess({ status: 'ok', database: 'connected' }));
    } catch {
      response.status(503).json(apiError('DATABASE_UNAVAILABLE', 'The database is not available.'));
    }
  });

  return router;
}
