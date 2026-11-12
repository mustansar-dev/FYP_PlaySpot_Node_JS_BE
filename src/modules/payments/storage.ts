import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { HttpError } from '../../common/httpError.js';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

export interface ReceiptUploadRequest {
  payerUserId: string;
  paymentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface SignedReceiptUpload {
  storagePath: string;
  signedUrl: string;
  token: string;
  expiresInSeconds: number;
}

export interface PaymentReceiptStorage {
  createSignedUpload(input: ReceiptUploadRequest): Promise<SignedReceiptUpload>;
  getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }>;
  createSignedDownload(storagePath: string, expiresInSeconds: number): Promise<string>;
  deleteObject(storagePath: string): Promise<void>;
}

export function validateReceiptFile(input: Pick<ReceiptUploadRequest, 'fileName' | 'mimeType' | 'sizeBytes'>): string {
  const extension = RECEIPT_TYPES[input.mimeType];
  if (!extension) throw new HttpError(400, 'UNSUPPORTED_RECEIPT_TYPE', 'Only PDF, JPEG and PNG receipts are accepted.');
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new HttpError(400, 'INVALID_RECEIPT_SIZE', 'Receipt file size must be a positive number of bytes.');
  }
  if (input.sizeBytes > MAX_RECEIPT_BYTES) {
    throw new HttpError(413, 'RECEIPT_TOO_LARGE', 'A receipt may not exceed 5 MB.');
  }
  const suppliedExtension = extname(basename(input.fileName)).toLowerCase();
  if (suppliedExtension && suppliedExtension !== extension && !(input.mimeType === 'image/jpeg' && suppliedExtension === '.jpeg')) {
    throw new HttpError(400, 'RECEIPT_EXTENSION_MISMATCH', 'The file extension does not match its content type.');
  }
  return extension;
}

export class SupabasePaymentReceiptStorage implements PaymentReceiptStorage {
  private readonly baseUrl: string;

  constructor(private readonly projectUrl: string, private readonly serviceRoleKey: string, private readonly bucket: string) {
    this.baseUrl = `${projectUrl.replace(/\/$/, '')}/storage/v1`;
  }

  async createSignedUpload(input: ReceiptUploadRequest): Promise<SignedReceiptUpload> {
    const extension = validateReceiptFile(input);
    const storagePath = `${input.payerUserId}/${input.paymentId}/${randomUUID()}${extension}`;
    const endpoint = `${this.baseUrl}/object/upload/sign/${encodeURIComponent(this.bucket)}/${this.encodePath(storagePath)}`;
    const response = await this.request(endpoint, { method: 'POST', body: '{}' });
    const data = await response.json() as { url?: string; signedURL?: string; token?: string };
    const relativeUrl = data.url ?? data.signedURL;
    if (!response.ok || !relativeUrl || !data.token) throw this.providerError();
    const signedUrl = /^https?:\/\//i.test(relativeUrl)
      ? relativeUrl : `${this.baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
    const uploadUrl = new URL(signedUrl);
    uploadUrl.searchParams.set('token', data.token);
    return { storagePath, signedUrl: uploadUrl.toString(), token: data.token, expiresInSeconds: 7200 };
  }

  async getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
    const endpoint = `${this.baseUrl}/object/info/${encodeURIComponent(this.bucket)}/${this.encodePath(storagePath)}`;
    const response = await this.request(endpoint, { method: 'GET' });
    if (response.status === 404) return { exists: false };
    if (!response.ok) throw this.providerError();
    const data = await response.json() as {
      size?: number | string;
      metadata?: { size?: number | string; mimetype?: string; contentType?: string };
      contentType?: string;
    };
    const size = Number(data.size ?? data.metadata?.size);
    const mimeType = data.contentType ?? data.metadata?.mimetype ?? data.metadata?.contentType;
    return { exists: true, ...(Number.isFinite(size) ? { sizeBytes: size } : {}), ...(mimeType ? { mimeType } : {}) };
  }

  async createSignedDownload(storagePath: string, expiresInSeconds: number): Promise<string> {
    const endpoint = `${this.baseUrl}/object/sign/${encodeURIComponent(this.bucket)}/${this.encodePath(storagePath)}`;
    const response = await this.request(endpoint, { method: 'POST', body: JSON.stringify({ expiresIn: expiresInSeconds }) });
    const data = await response.json() as { signedURL?: string; signedUrl?: string };
    const relativeUrl = data.signedURL ?? data.signedUrl;
    if (!response.ok || !relativeUrl) throw this.providerError();
    return /^https?:\/\//i.test(relativeUrl)
      ? relativeUrl : `${this.baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
  }

  async deleteObject(storagePath: string): Promise<void> {
    const endpoint = `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}/${this.encodePath(storagePath)}`;
    const response = await this.request(endpoint, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw this.providerError();
  }

  private encodePath(storagePath: string): string {
    return storagePath.split('/').map(encodeURIComponent).join('/');
  }

  private request(url: string, init: RequestInit): Promise<globalThis.Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(8000),
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    }).catch(() => { throw this.providerError(); });
  }

  private providerError(): HttpError {
    return new HttpError(502, 'PAYMENT_RECEIPT_STORAGE_ERROR', 'Receipt storage is temporarily unavailable.');
  }
}

export class UnconfiguredPaymentReceiptStorage implements PaymentReceiptStorage {
  async createSignedUpload(): Promise<SignedReceiptUpload> {
    throw new HttpError(503, 'PAYMENT_RECEIPT_STORAGE_NOT_CONFIGURED', 'Private payment receipt storage is not configured.');
  }
  async getObjectInfo(): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
    throw new HttpError(503, 'PAYMENT_RECEIPT_STORAGE_NOT_CONFIGURED', 'Private payment receipt storage is not configured.');
  }
  async createSignedDownload(): Promise<string> {
    throw new HttpError(503, 'PAYMENT_RECEIPT_STORAGE_NOT_CONFIGURED', 'Private payment receipt storage is not configured.');
  }
  async deleteObject(): Promise<void> {
    throw new HttpError(503, 'PAYMENT_RECEIPT_STORAGE_NOT_CONFIGURED', 'Private payment receipt storage is not configured.');
  }
}
