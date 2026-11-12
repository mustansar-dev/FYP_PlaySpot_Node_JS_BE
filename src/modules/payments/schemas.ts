import { z } from 'zod';

export const paymentMethodSchema = z.enum(['ONLINE', 'PAY_AT_VENUE', 'BANK_TRANSFER']);

export const contributionCreateSchema = z.object({
  method: paymentMethodSchema,
});

export const receiptUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().toLowerCase().max(120),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
});

export const receiptConfirmSchema = receiptUploadSchema.extend({
  storagePath: z.string().trim().min(1).max(500),
});

export const paymentInstructionsSchema = z.object({
  accountTitle: z.string().trim().min(2).max(160),
  bankName: z.string().trim().min(2).max(120),
  iban: z.string().trim().min(15).max(34).optional(),
  accountNumber: z.string().trim().min(5).max(64).optional(),
  instructions: z.string().trim().max(1000).optional(),
  active: z.boolean().default(true),
}).refine(value => Boolean(value.iban || value.accountNumber), {
  path: ['iban'], message: 'Provide an IBAN or account number.',
});

export const cashReceiptSchema = z.object({
  amountPaisa: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
});

export const rejectTransferSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export const mockPaymentResultSchema = z.object({
  result: z.enum(['succeeded', 'failed', 'cancelled']),
});

export const transferListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
