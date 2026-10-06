import { describe, expect, test } from 'vitest';

import {
  normalizeDsvDriverLoginId,
  normalizeDsvDriverPhone,
} from '../src/modules/dsv/dsv-driver-identity.js';

describe('DSV driver identity helpers', () => {
  test('normalizes login identifiers and Korean mobile numbers at the server boundary', () => {
    expect(normalizeDsvDriverLoginId(' Driver.One ')).toBe('driver.one');
    expect(normalizeDsvDriverPhone('010-9000-0001')).toBe('01090000001');
  });
});
