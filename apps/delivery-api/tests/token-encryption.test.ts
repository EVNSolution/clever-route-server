import { describe, expect, test } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  loadTokenEncryptionKey
} from '../src/modules/security/token-encryption.js';

const encryptionKey = loadTokenEncryptionKey(
  'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
);

describe('token encryption', () => {
  test('round-trips token plaintext with associated shop context', () => {
    const plaintext = 'shpat_test_admin_token';
    const aad = 'shopify-admin-token:example.myshopify.com';

    const ciphertext = encryptSecret(plaintext, { aad, key: encryptionKey });

    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptSecret(ciphertext, { aad, key: encryptionKey })).toBe(plaintext);
  });

  test('rejects tampered ciphertext', () => {
    const aad = 'shopify-admin-token:example.myshopify.com';
    const ciphertext = encryptSecret('shpat_test_admin_token', { aad, key: encryptionKey });
    const parts = ciphertext.split(':');
    const authTag = parts[2] ?? '';
    const replacement = authTag.startsWith('A') ? 'B' : 'A';
    parts[2] = `${replacement}${authTag.slice(1)}`;
    const tampered = parts.join(':');

    expect(() => decryptSecret(tampered, { aad, key: encryptionKey })).toThrow(
      'Failed to decrypt secret'
    );
  });

  test('binds ciphertext to associated shop context', () => {
    const ciphertext = encryptSecret('shpat_test_admin_token', {
      aad: 'shopify-admin-token:example.myshopify.com',
      key: encryptionKey
    });

    expect(() =>
      decryptSecret(ciphertext, {
        aad: 'shopify-admin-token:other.myshopify.com',
        key: encryptionKey
      })
    ).toThrow('Failed to decrypt secret');
  });

  test('requires exactly 32 bytes of key material', () => {
    expect(() => loadTokenEncryptionKey('base64:AA==')).toThrow(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes'
    );
  });
});
