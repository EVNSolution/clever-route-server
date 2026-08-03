import { createHmac } from 'node:crypto';

const RESIDENT_NUMBER_FRONT_PATTERN = /^\d{7}$/u;

export function normalizeDsvDriverLoginId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDsvDriverPhone(value: string): string {
  return value.replace(/\D/gu, '');
}

export function fingerprintResidentNumberFront(
  residentNumberFront: string,
  secret: string,
): string {
  if (!RESIDENT_NUMBER_FRONT_PATTERN.test(residentNumberFront)) {
    throw new Error('residentNumberFront must contain exactly seven digits');
  }
  if (secret.length < 32) {
    throw new Error('DSV driver identity secret must contain at least 32 characters');
  }

  return createHmac('sha256', secret)
    .update('clever-dsv-driver-resident-front-v1\0', 'utf8')
    .update(residentNumberFront, 'utf8')
    .digest('hex');
}
