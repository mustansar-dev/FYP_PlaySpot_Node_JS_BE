import { describe, expect, it } from 'vitest';
import { HttpError } from '../../common/httpError.js';
import { UnconfiguredVenueStorage, validateMedia, type VenueStorage } from './storage.js';

describe('venue media validation', () => {
  it('allows supported image and video types with matching extensions', () => {
    expect(validateMedia({ kind: 'PHOTO', fileName: 'court.webp', mimeType: 'image/webp', sizeBytes: 1024 })).toBe('.webp');
    expect(validateMedia({ kind: 'VIDEO', fileName: 'tour.mp4', mimeType: 'video/mp4', sizeBytes: 1024 })).toBe('.mp4');
  });

  it('rejects an extension that does not match the declared content type', () => {
    expect(() => validateMedia({ kind: 'PHOTO', fileName: 'court.png', mimeType: 'image/jpeg', sizeBytes: 1024 }))
      .toThrowError(new HttpError(400, 'MEDIA_EXTENSION_MISMATCH', 'The file extension does not match its media type.'));
  });

  it('rejects oversized or unsupported media rather than accepting a fake URL', () => {
    expect(() => validateMedia({ kind: 'PHOTO', fileName: 'court.jpg', mimeType: 'image/jpeg', sizeBytes: 10 * 1024 * 1024 + 1 }))
      .toThrowError(expect.objectContaining({ code: 'MEDIA_TOO_LARGE' }));
    expect(() => validateMedia({ kind: 'PHOTO', fileName: 'court.gif', mimeType: 'image/gif', sizeBytes: 1024 }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }));
  });

  it('returns a clear unavailable error when storage is not configured', async () => {
    const storage: VenueStorage = new UnconfiguredVenueStorage();
    await expect(storage.createSignedUpload({
      vendorProfileId: 'vendor', venueId: 'venue', kind: 'PHOTO', fileName: 'court.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
    })).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_NOT_CONFIGURED' });
  });
});
