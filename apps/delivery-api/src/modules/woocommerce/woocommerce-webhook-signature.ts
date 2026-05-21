import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyWooCommerceWebhookSignatureInput = {
  rawBody: string;
  secret: string;
  signature: string;
};

export function verifyWooCommerceWebhookSignature(input: VerifyWooCommerceWebhookSignatureInput): boolean {
  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest();
  const actual = decodeBase64(input.signature);
  if (actual === null || actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(expected, actual);
}

function decodeBase64(value: string): Buffer | null {
  if (!/^[a-z0-9+/]+={0,2}$/iu.test(value.trim())) return null;
  return Buffer.from(value, 'base64');
}
