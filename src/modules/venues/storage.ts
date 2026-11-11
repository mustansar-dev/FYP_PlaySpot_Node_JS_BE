import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { HttpError } from '../../common/httpError.js';

export interface StorageUploadRequest {
  vendorProfileId: string;
  venueId: string;
  kind: 'PHOTO' | 'VIDEO';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface SignedUpload {
  storagePath: string;
  signedUrl: string;
  token: string;
  expiresInSeconds: number;
}

export interface VenueStorage {
  createSignedUpload(input: StorageUploadRequest): Promise<SignedUpload>;
  getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }>;
  publicUrl(storagePath: string): string | null;
  deleteObject(storagePath: string): Promise<void>;
}

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const VIDEO_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/quicktime': '.mov' };
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export function validateMedia(input: Pick<StorageUploadRequest, 'kind' | 'fileName' | 'mimeType' | 'sizeBytes'>): string {
  const allowed = input.kind === 'PHOTO' ? IMAGE_TYPES : VIDEO_TYPES;
  const maxBytes = input.kind === 'PHOTO' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
  if (!allowed[input.mimeType]) throw new HttpError(400, 'UNSUPPORTED_MEDIA_TYPE', 'This media type is not supported.');
  if (input.sizeBytes > maxBytes) throw new HttpError(413, 'MEDIA_TOO_LARGE', `This ${input.kind.toLowerCase()} exceeds the allowed file size.`);
  const extension = extname(basename(input.fileName)).toLowerCase();
  if (extension && extension !== allowed[input.mimeType]) {
    throw new HttpError(400, 'MEDIA_EXTENSION_MISMATCH', 'The file extension does not match its media type.');
  }
  return allowed[input.mimeType]!;
}

export class SupabaseVenueStorage implements VenueStorage {
  private readonly baseUrl: string;
  constructor(private readonly projectUrl: string, private readonly serviceRoleKey: string, private readonly bucket: string) {
    this.baseUrl = `${projectUrl.replace(/\/$/, '')}/storage/v1`;
  }

  async createSignedUpload(input: StorageUploadRequest): Promise<SignedUpload> {
    const extension = validateMedia(input);
    const path = `${input.vendorProfileId}/${input.venueId}/${randomUUID()}${extension}`;
    const endpoint = `${this.baseUrl}/object/upload/sign/${encodeURIComponent(this.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.request(endpoint, { method: 'POST', body: JSON.stringify({}) });
    const data = await response.json() as { url?: string; signedURL?: string; token?: string; path?: string };
    const relativeUrl = data.url ?? data.signedURL;
    if (!response.ok || !relativeUrl || !data.token) throw this.providerError();
    const signedUrl = /^https?:\/\//i.test(relativeUrl)
      ? relativeUrl : `${this.baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
    const uploadUrl = new URL(signedUrl);
    uploadUrl.searchParams.set('token', data.token);
    return { storagePath: path, signedUrl: uploadUrl.toString(), token: data.token, expiresInSeconds: 7200 };
  }

  async getObjectInfo(storagePath: string): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
    const endpoint = `${this.baseUrl}/object/info/${encodeURIComponent(this.bucket)}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.request(endpoint, { method: 'GET', headers: {} });
    if (response.status === 404) return { exists: false };
    if (!response.ok) throw this.providerError();
    const data = await response.json() as { size?: number | string; metadata?: { size?: number | string; mimetype?: string; contentType?: string }; contentType?: string };
    const size = Number(data.size ?? data.metadata?.size);
    const mimeType = data.contentType ?? data.metadata?.mimetype ?? data.metadata?.contentType;
    return {
      exists: true,
      ...(Number.isFinite(size) ? { sizeBytes: size } : {}),
      ...(mimeType ? { mimeType } : {}),
    };
  }

  publicUrl(storagePath: string): string {
    const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/object/public/${encodeURIComponent(this.bucket)}/${encodedPath}`;
  }

  async deleteObject(storagePath: string): Promise<void> {
    const endpoint = `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.request(endpoint, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw this.providerError();
  }

  private request(url: string, init: RequestInit): Promise<globalThis.Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(8000),
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    }).catch(() => { throw this.providerError(); });
  }

  private providerError(): HttpError {
    return new HttpError(502, 'STORAGE_PROVIDER_ERROR', 'Media storage is temporarily unavailable.');
  }
}

export class UnconfiguredVenueStorage implements VenueStorage {
  async createSignedUpload(): Promise<SignedUpload> {
    throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Venue media uploads are not configured. Set the server-side Supabase Storage settings.');
  }
  async getObjectInfo(): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> {
    throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Venue media storage is not configured.');
  }
  publicUrl(): null {
    return null;
  }
  async deleteObject(): Promise<void> {
    throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Venue media storage is not configured.');
  }
}
