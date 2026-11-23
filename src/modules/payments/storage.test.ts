import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../common/httpError.js';
import { LocalPaymentReceiptStorage, MAX_RECEIPT_BYTES, validateReceiptContent, validateReceiptFile } from './storage.js';

describe('bank transfer receipt validation', () => {
  it('accepts only matching PDF/JPEG/PNG file metadata within the five-megabyte limit', () => {
    expect(validateReceiptFile({ fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 1024 })).toBe('.pdf');
    expect(validateReceiptFile({ fileName: 'receipt.jpeg', mimeType: 'image/jpeg', sizeBytes: MAX_RECEIPT_BYTES })).toBe('.jpg');
    expect(validateReceiptFile({ fileName: 'receipt.png', mimeType: 'image/png', sizeBytes: 1024 })).toBe('.png');
  });

  it('rejects unsupported file types, oversized files and mismatched extensions', () => {
    expect(() => validateReceiptFile({ fileName: 'receipt.exe', mimeType: 'application/pdf', sizeBytes: 1024 })).toThrowError(HttpError);
    expect(() => validateReceiptFile({ fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: MAX_RECEIPT_BYTES + 1 })).toThrowError(HttpError);
    expect(() => validateReceiptFile({ fileName: 'receipt.png', mimeType: 'image/jpeg', sizeBytes: 1024 })).toThrowError(HttpError);
  });

  it('stores multipart receipts privately and reads or deletes them by their scoped object path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'playspot-receipts-'));
    const storage = new LocalPaymentReceiptStorage(directory);
    const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    try {
      const stored = await storage.storeUploadedFile({
        payerUserId: '11111111-1111-4111-8111-111111111111',
        paymentId: '22222222-2222-4222-8222-222222222222',
        fileName: 'receipt.png', mimeType: 'image/png', sizeBytes: buffer.length, buffer,
      });

      expect(await storage.getObjectInfo(stored.storagePath)).toEqual({ exists: true, sizeBytes: buffer.length, mimeType: 'image/png' });
      expect(await storage.readObject(stored.storagePath)).toEqual(buffer);
      expect(await storage.createSignedDownload(stored.storagePath, 300)).toBe('/payments/22222222-2222-4222-8222-222222222222/receipt/file');
      await storage.deleteObject(stored.storagePath);
      expect(await storage.getObjectInfo(stored.storagePath)).toEqual({ exists: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects receipt bytes that do not match the claimed image type', () => {
    expect(() => validateReceiptContent(Buffer.from('not a png'), 'image/png')).toThrowError(HttpError);
  });
});
