export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details: unknown[] };
}

export function apiSuccess<T>(data: T, meta?: ApiMeta): ApiSuccess<T> {
  return meta ? { success: true, data, meta } : { success: true, data };
}

export function apiError(code: string, message: string, details: unknown[] = []): ApiFailure {
  return { success: false, error: { code, message, details } };
}
