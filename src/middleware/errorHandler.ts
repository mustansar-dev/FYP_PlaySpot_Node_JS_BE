import type { ErrorRequestHandler } from 'express';
import { apiError } from '../common/apiResponse.js';
import { HttpError } from '../common/httpError.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  void _next;
  if (error instanceof HttpError) {
    response.status(error.statusCode).json(apiError(error.code, error.message, error.details));
    return;
  }

  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    response.status(409).json(apiError('DUPLICATE_ACCOUNT', 'An account with those details already exists.'));
    return;
  }

  response.status(500).json(apiError('INTERNAL_ERROR', 'An unexpected server error occurred.'));
};
