import type { RequestHandler } from 'express';
import { apiError } from '../common/apiResponse.js';

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json(apiError('NOT_FOUND', 'The requested endpoint was not found.'));
};
