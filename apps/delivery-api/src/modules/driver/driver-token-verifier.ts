import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

const DRIVER_AUDIENCE = 'clever-delivery-driver';

export type VerifiedDriverToken = {
  driverId: string;
  issuedAt: Date;
  shopDomain: string;
  subject: string;
  tokenVersion: number;
};

export type VerifyDriverTokenOptions = {
  now?: Date;
  secret: string;
};

export type SignDriverTokenInput = {
  driverId: string;
  expiresInSeconds: number;
  shopDomain: string;
  subject: string;
  tokenVersion?: number;
};

export type SignDriverTokenResult = {
  expiresAt: string;
  token: string;
  tokenType: 'Bearer';
};

type DriverTokenHeader = {
  alg?: unknown;
  typ?: unknown;
};

type DriverTokenClaims = {
  aud?: unknown;
  driverId?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  shopDomain?: unknown;
  sub?: unknown;
  tokenVersion?: unknown;
};

export function verifyDriverToken(
  token: string,
  options: VerifyDriverTokenOptions
): VerifiedDriverToken {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Driver token must be a JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new Error('Driver token must be a JWT');
  }

  verifyHeader(encodedHeader);
  verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, options.secret);

  const claims = parseClaims(encodedPayload);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const audience = requireStringClaim(claims.aud, 'aud');
  const driverId = requireStringClaim(claims.driverId, 'driverId');
  const expiresAt = requireNumberClaim(claims.exp, 'exp');
  const issuedAtSeconds = requireNumberClaim(claims.iat, 'iat');
  const shopDomain = normalizeDriverCommerceDomain(requireStringClaim(claims.shopDomain, 'shopDomain'));
  const subject = requireStringClaim(claims.sub, 'sub');
  const tokenVersion = readTokenVersionClaim(claims.tokenVersion);

  if (audience !== DRIVER_AUDIENCE) {
    throw new Error('Driver token audience mismatch');
  }

  if (expiresAt <= nowSeconds) {
    throw new Error('Driver token has expired');
  }

  if (claims.nbf !== undefined && requireNumberClaim(claims.nbf, 'nbf') > nowSeconds) {
    throw new Error('Driver token is not active yet');
  }

  return {
    driverId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    shopDomain,
    subject,
    tokenVersion
  };
}

export function signDriverToken(
  input: SignDriverTokenInput,
  options: VerifyDriverTokenOptions
): SignDriverTokenResult {
  const now = options.now ?? new Date();
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + readPositiveTtl(input.expiresInSeconds);
  const shopDomain = normalizeDriverCommerceDomain(input.shopDomain);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    aud: DRIVER_AUDIENCE,
    driverId: requireStringClaim(input.driverId, 'driverId'),
    exp: expiresAtSeconds,
    iat: issuedAtSeconds,
    nbf: issuedAtSeconds,
    shopDomain,
    sub: requireStringClaim(input.subject, 'sub'),
    tokenVersion: readTokenVersionClaim(input.tokenVersion)
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', options.secret).update(signingInput).digest('base64url');

  return {
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    token: `${signingInput}.${signature}`,
    tokenType: 'Bearer'
  };
}

function verifyHeader(encodedHeader: string): void {
  const header = parseHeader(encodedHeader);
  const algorithm = requireStringClaim(header.alg, 'header alg');
  const tokenType = requireStringClaim(header.typ, 'header typ');

  if (algorithm !== 'HS256' || tokenType !== 'JWT') {
    throw new Error('Driver token algorithm mismatch');
  }
}

function verifySignature(signingInput: string, signature: string, secret: string): void {
  const expected = createHmac('sha256', secret).update(signingInput).digest('base64url');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (
    expectedBuffer.byteLength !== actualBuffer.byteLength ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error('Invalid driver token signature');
  }
}

function parseHeader(encodedHeader: string): DriverTokenHeader {
  try {
    return JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as DriverTokenHeader;
  } catch (error) {
    throw new Error('Invalid driver token header', { cause: error });
  }
}

function parseClaims(encodedPayload: string): DriverTokenClaims {
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as DriverTokenClaims;
  } catch (error) {
    throw new Error('Invalid driver token payload', { cause: error });
  }
}

function requireStringClaim(value: unknown, claimName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Driver token ${claimName} claim is required`);
  }

  return value;
}

function requireNumberClaim(value: unknown, claimName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Driver token ${claimName} claim is required`);
  }

  return value;
}


function readTokenVersionClaim(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('Driver token tokenVersion claim must be a non-negative integer');
  }

  return value;
}

function readPositiveTtl(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Driver token TTL must be a positive integer');
  }

  return value;
}
