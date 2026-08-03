import { describe, expect, test } from 'vitest';

import {
  fingerprintResidentNumberFront,
  normalizeDsvDriverLoginId,
  normalizeDsvDriverPhone,
} from '../src/modules/dsv/dsv-driver-identity.js';

describe('DSV driver identity helpers', () => {
  test('normalizes login identifiers and Korean mobile numbers at the server boundary', () => {
    expect(normalizeDsvDriverLoginId(' Driver.One ')).toBe('driver.one');
    expect(normalizeDsvDriverPhone('010-9000-0001')).toBe('01090000001');
  });

  test('creates a deterministic keyed fingerprint without retaining the seven digits', () => {
    const first = fingerprintResidentNumberFront('9001011', 'identity-secret-a-that-is-long-enough');
    const same = fingerprintResidentNumberFront('9001011', 'identity-secret-a-that-is-long-enough');
    const otherSecret = fingerprintResidentNumberFront('9001011', 'identity-secret-b-that-is-long-enough');

    expect(first).toBe(same);
    expect(first).not.toBe(otherSecret);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain('9001011');
  });
});
