import type { TokenEncryptionKey } from '../security/token-encryption.js';
import {
  decryptSecret,
  encryptSecret,
  loadTokenEncryptionKey
} from '../security/token-encryption.js';

export type CommerceCredentialKind = 'consumer-key' | 'consumer-secret' | 'webhook-secret';

export function loadCredentialEncryptionKey(rawValue: string | undefined): TokenEncryptionKey {
  return loadTokenEncryptionKey(rawValue, 'CREDENTIAL_ENCRYPTION_KEY');
}

export function encryptCommerceCredential(input: {
  connectionId: string;
  key: TokenEncryptionKey;
  kind: CommerceCredentialKind;
  plaintext: string;
}): string {
  return encryptSecret(input.plaintext, {
    aad: commerceCredentialAad(input.kind, input.connectionId),
    key: input.key
  });
}

export function decryptCommerceCredential(input: {
  ciphertext: string;
  connectionId: string;
  key: TokenEncryptionKey;
  kind: CommerceCredentialKind;
}): string {
  return decryptSecret(input.ciphertext, {
    aad: commerceCredentialAad(input.kind, input.connectionId),
    key: input.key
  });
}

export function commerceCredentialAad(kind: CommerceCredentialKind, connectionId: string): string {
  return `woocommerce:${kind}:${connectionId}`;
}
