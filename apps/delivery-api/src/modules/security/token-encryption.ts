import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;
const KEY_BYTE_LENGTH = 32;

export type TokenEncryptionKey = Buffer;

type CipherOptions = {
  aad: string;
  key: TokenEncryptionKey;
};

export function loadTokenEncryptionKey(
  rawValue: string | undefined,
  variableName = 'SHOPIFY_TOKEN_ENCRYPTION_KEY'
): TokenEncryptionKey {
  if (rawValue === undefined || rawValue.trim() === '') {
    throw new Error(`${variableName} is required`);
  }

  const value = rawValue.trim();
  const key = decodeKey(value);

  if (key.byteLength !== KEY_BYTE_LENGTH) {
    throw new Error(`${variableName} must decode to 32 bytes`);
  }

  return key;
}

export function encryptSecret(plaintext: string, options: CipherOptions): string {
  if (plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty secret');
  }

  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, options.key, iv, {
    authTagLength: AUTH_TAG_BYTE_LENGTH
  });
  cipher.setAAD(Buffer.from(options.aad, 'utf8'));

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [VERSION, encode(iv), encode(authTag), encode(encrypted)].join(':');
}

export function decryptSecret(ciphertext: string, options: CipherOptions): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Invalid ciphertext format');
    }

    const [, encodedIv, encodedAuthTag, encodedEncrypted] = parts;
    if (
      encodedIv === undefined ||
      encodedAuthTag === undefined ||
      encodedEncrypted === undefined
    ) {
      throw new Error('Invalid ciphertext format');
    }

    const iv = decode(encodedIv);
    const authTag = decode(encodedAuthTag);
    const encrypted = decode(encodedEncrypted);

    if (iv.byteLength !== IV_BYTE_LENGTH || authTag.byteLength !== AUTH_TAG_BYTE_LENGTH) {
      throw new Error('Invalid ciphertext metadata');
    }

    const decipher = createDecipheriv(ALGORITHM, options.key, iv, {
      authTagLength: AUTH_TAG_BYTE_LENGTH
    });
    decipher.setAAD(Buffer.from(options.aad, 'utf8'));
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('Failed to decrypt secret', { cause: error });
  }
}

function decodeKey(value: string): Buffer {
  if (value.startsWith('base64:')) {
    return Buffer.from(value.slice('base64:'.length), 'base64');
  }

  if (/^[a-f0-9]{64}$/iu.test(value)) {
    return Buffer.from(value, 'hex');
  }

  return Buffer.from(value, 'base64');
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
