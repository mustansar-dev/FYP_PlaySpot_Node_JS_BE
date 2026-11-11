import { z } from 'zod';

const email = z.string().trim().email().max(320).transform(value => value.toLowerCase());
const normalizedPhone = z.string().trim().min(7).max(32).transform(value => value.replace(/[\s().-]/g, ''));
const phone = normalizedPhone.optional().nullable();
const password = z.string().min(8).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, {
  message: 'Password must be no more than 72 bytes.',
});
const sports = z.array(z.string().trim().min(1).max(60)).max(12).default([]);

export const playerRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120), email, phone, password,
  confirmPassword: z.string(), preferredSports: sports,
}).refine(value => value.password === value.confirmPassword, {
  path: ['confirmPassword'], message: 'Passwords do not match.',
});

export const vendorRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120), email, phone: normalizedPhone, password,
  confirmPassword: z.string(), businessName: z.string().trim().min(1).max(160),
  contactPhone: normalizedPhone.optional(),
}).refine(value => value.password === value.confirmPassword, {
  path: ['confirmPassword'], message: 'Passwords do not match.',
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(320).transform(value => value.includes('@') ? value.toLowerCase() : value.replace(/[\s().-]/g, '')).optional(),
  email: email.optional(),
  password: z.string().min(1).max(72),
}).refine(value => value.identifier !== undefined || value.email !== undefined, {
  path: ['identifier'], message: 'Email or phone identifier is required.',
});
export const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) });
export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), phone,
  preferredSports: sports.optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one profile field is required.');
export const updateVendorSchema = z.object({
  businessName: z.string().trim().min(1).max(160).optional(),
  contactPhone: z.string().trim().min(7).max(32).optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one vendor profile field is required.');

export type PlayerRegistration = z.infer<typeof playerRegistrationSchema>;
export type VendorRegistration = z.infer<typeof vendorRegistrationSchema>;
