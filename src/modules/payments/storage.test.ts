import { describe, expect, it } from 'vitest';
import { HttpError } from '../../common/httpError.js';
import { MAX_RECEIPT_BYTES, validateReceiptFile } from './storage.js';

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
});
