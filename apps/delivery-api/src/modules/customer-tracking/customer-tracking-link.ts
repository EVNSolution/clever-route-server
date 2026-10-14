import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// A tracking link is `<deliveryStopId>.<signature>`: no stored token, so no migration,
// and nobody can walk stop ids without the server secret.
export type CustomerTrackingLinks = {
  publicBaseUrl: string;
  signingKey: Buffer;
};

export type CustomerTrackingLinksEnv = Partial<Record<'DELIVERY_API_PUBLIC_URL' | 'JWT_SECRET', string>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SIGNATURE_LENGTH = 22;

export function loadCustomerTrackingLinks(env: CustomerTrackingLinksEnv): CustomerTrackingLinks | undefined {
  const secret = env.JWT_SECRET?.trim() ?? '';
  const rawBaseUrl = env.DELIVERY_API_PUBLIC_URL?.trim() ?? '';
  if (secret === '' || rawBaseUrl === '') return undefined;
  const url = new URL(rawBaseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('DELIVERY_API_PUBLIC_URL must be an http(s) URL for customer tracking links');
  }
  return {
    publicBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/u, '')}`,
    signingKey: createHash('sha256').update(`customer-tracking-link-signing:${secret}`).digest(),
  };
}

export function customerTrackingToken(links: CustomerTrackingLinks, deliveryStopId: string): string {
  return `${deliveryStopId}.${sign(links, deliveryStopId)}`;
}

export function customerTrackingUrl(links: CustomerTrackingLinks, deliveryStopId: string): string {
  return `${links.publicBaseUrl}/t/${customerTrackingToken(links, deliveryStopId)}`;
}

export function readCustomerTrackingToken(links: CustomerTrackingLinks, token: string): string | null {
  const [deliveryStopId, signature, extra] = token.split('.');
  if (deliveryStopId === undefined || signature === undefined || extra !== undefined) return null;
  if (!UUID_PATTERN.test(deliveryStopId) || signature.length !== SIGNATURE_LENGTH) return null;
  const expected = Buffer.from(sign(links, deliveryStopId), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  return timingSafeEqual(expected, actual) ? deliveryStopId : null;
}

function sign(links: CustomerTrackingLinks, deliveryStopId: string): string {
  return createHmac('sha256', links.signingKey).update(deliveryStopId).digest('base64url').slice(0, SIGNATURE_LENGTH);
}
