import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
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
  storeUploadedFile?(input: ReceiptUploadRequest & { buffer: Buffer }): Promise<{ storagePath: string }>;
  getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }>;
  createSignedDownload(storagePath: string, expiresInSeconds: number): Promise<string>;
  readObject?(storagePath: string): Promise<Buffer>;
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

export function validateReceiptContent(buffer: Buffer, mimeType: string): void {
  const isPdf = mimeType === 'application/pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  const isJpeg = mimeType === 'image/jpeg' && buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPdf && !isJpeg && !isPng) {
    throw new HttpError(400, 'INVALID_RECEIPT_CONTENT', 'The receipt file content does not match its PDF, JPEG or PNG type.');
  }
}

export class LocalPaymentReceiptStorage implements PaymentReceiptStorage {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async createSignedUpload(): Promise<SignedReceiptUpload> {
    throw new HttpError(409, 'MULTIPART_UPLOAD_REQUIRED', 'Upload payment receipts with the authenticated multipart receipt endpoint.');
  }

  async storeUploadedFile(input: ReceiptUploadRequest & { buffer: Buffer }): Promise<{ storagePath: string }> {
    const extension = validateReceiptFile(input);
    if (input.buffer.length !== input.sizeBytes) throw new HttpError(400, 'RECEIPT_SIZE_MISMATCH', 'The uploaded receipt size does not match its metadata.');
    validateReceiptContent(input.buffer, input.mimeType);
    const storagePath = `${input.payerUserId}/${input.paymentId}/${randomUUID()}${extension}`;
    const filePath = this.filePath(storagePath);
    await mkdir(resolve(filePath, '..'), { recursive: true, mode: 0o700 });
    await writeFile(filePath, input.buffer, { flag: 'wx', mode: 0o600 });
    return { storagePath };
  }

  async getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
    try {
      const file = await stat(this.filePath(storagePath));
      if (!file.isFile()) return { exists: false };
      const mimeType = mimeTypeForExtension(extname(storagePath).toLowerCase());
      return { exists: true, sizeBytes: file.size, ...(mimeType ? { mimeType } : {}) };
    } catch (error) {
      if (isMissingFile(error)) return { exists: false };
      throw error;
    }
  }

  async createSignedDownload(storagePath: string, expiresInSeconds: number): Promise<string> {
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < 1) {
      throw new HttpError(400, 'INVALID_RECEIPT_LINK_EXPIRY', 'A positive receipt link duration is required.');
    }
    const [, paymentId] = this.checkedSegments(storagePath);
    return `/payments/${paymentId}/receipt/file`;
  }

  async readObject(storagePath: string): Promise<Buffer> {
    try { return await readFile(this.filePath(storagePath)); }
    catch (error) {
      if (isMissingFile(error)) throw new HttpError(404, 'RECEIPT_NOT_FOUND', 'The payment receipt file was not found.');
      throw error;
    }
  }

  async deleteObject(storagePath: string): Promise<void> {
    try { await unlink(this.filePath(storagePath)); }
    catch (error) { if (!isMissingFile(error)) throw error; }
  }

  private filePath(storagePath: string): string {
    const result = resolve(this.root, ...this.checkedSegments(storagePath));
    const pathFromRoot = relative(this.root, result);
    if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..' || resolve(this.root, pathFromRoot) !== result) {
      throw new HttpError(400, 'INVALID_RECEIPT_PATH', 'The receipt object path is not valid.');
    }
    return result;
  }

  private checkedSegments(storagePath: string): [string, string, string] {
    const segments = storagePath.split('/');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (segments.length !== 3 || !uuid.test(segments[0]!) || !uuid.test(segments[1]!)
      || !/^[0-9a-f-]{36}\.(?:pdf|jpg|png)$/i.test(segments[2]!)) {
      throw new HttpError(400, 'INVALID_RECEIPT_PATH', 'The receipt object path is not valid.');
    }
    return segments as [string, string, string];
  }
}

function mimeTypeForExtension(extension: string): string | undefined {
  return { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png' }[extension];
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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

  async storeUploadedFile(input: ReceiptUploadRequest & { buffer: Buffer }): Promise<{ storagePath: string }> {
    const upload = await this.createSignedUpload(input);
    const response = await fetch(upload.signedUrl, {
      method: 'PUT', headers: { 'Content-Type': input.mimeType }, body: input.buffer,
      signal: AbortSignal.timeout(8000),
    }).catch(() => { throw this.providerError(); });
    if (!response.ok) throw this.providerError();
    return { storagePath: upload.storagePath };
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
  async storeUploadedFile(): Promise<{ storagePath: string }> {
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
