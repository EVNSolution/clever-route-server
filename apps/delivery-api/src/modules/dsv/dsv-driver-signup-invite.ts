import { createHash, randomBytes } from 'node:crypto';

export const DSV_DRIVER_SIGNUP_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const DSV_DRIVER_SIGNUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function createDsvDriverSignupToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDsvDriverSignupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildDsvDriverSignupUrl(token: string): string {
  return `clever-driver://signup?token=${encodeURIComponent(token)}`;
}
