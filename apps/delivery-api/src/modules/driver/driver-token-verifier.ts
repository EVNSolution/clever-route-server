import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

const DRIVER_AUDIENCE = 'clever-delivery-driver';
const DRIVER_ACCOUNT_AUDIENCE = 'clever-driver-account';
const DRIVER_ROUTE_AUDIENCE = 'clever-delivery-driver-route';
const MIN_DRIVER_JWT_SECRET_CHARACTERS = 32;

export function readDriverJwtSecret(value: string | undefined): string | undefined {
  const secret = value?.trim();
  if (!secret) return undefined;
  if (secret.length < MIN_DRIVER_JWT_SECRET_CHARACTERS) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  return secret;
}

export type VerifiedDriverAccountToken = {
  accountId: string;
  issuedAt: Date;
  subject: string;
  tokenVersion: number;
};

export type VerifiedDriverToken = {
  driverId: string;
  issuedAt: Date;
  shopDomain: string;
  subject: string;
  tokenVersion: number;
};

export type VerifiedDriverRouteToken = {
  accountId: string;
  issuedAt: Date;
  routePlanId: string;
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

export type SignDriverAccountTokenInput = {
  accountId: string;
  expiresInSeconds: number;
  subject: string;
  tokenVersion?: number;
};

export type SignDriverRouteTokenInput = {
  accountId: string;
  expiresInSeconds: number;
  routePlanId: string;
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
  accountId?: unknown;
  aud?: unknown;
  driverId?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  routePlanId?: unknown;
  shopDomain?: unknown;
  sub?: unknown;
  tokenVersion?: unknown;
};

export function verifyDriverAccountToken(
  token: string,
  options: VerifyDriverTokenOptions
): VerifiedDriverAccountToken {
  const claims = verifyTokenEnvelope(token, options.secret);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const audience = requireStringClaim(claims.aud, 'aud');
  const accountId = requireStringClaim(claims.accountId, 'accountId');
  const expiresAt = requireNumberClaim(claims.exp, 'exp');
  const issuedAtSeconds = requireNumberClaim(claims.iat, 'iat');
  const subject = requireStringClaim(claims.sub, 'sub');
  const tokenVersion = readTokenVersionClaim(claims.tokenVersion);

  if (audience !== DRIVER_ACCOUNT_AUDIENCE) {
    throw new Error('Driver account token audience mismatch');
  }
  verifyTokenTimes(claims, expiresAt, nowSeconds);

  return {
    accountId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    subject,
    tokenVersion
  };
}

export function verifyDriverToken(
  token: string,
  options: VerifyDriverTokenOptions
): VerifiedDriverToken {
  const claims = verifyTokenEnvelope(token, options.secret);
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

  verifyTokenTimes(claims, expiresAt, nowSeconds);

  return {
    driverId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    shopDomain,
    subject,
    tokenVersion
  };
}

export function verifyDriverRouteToken(
  token: string,
  options: VerifyDriverTokenOptions
): VerifiedDriverRouteToken {
  const claims = verifyTokenEnvelope(token, options.secret);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const audience = requireStringClaim(claims.aud, 'aud');
  const accountId = requireStringClaim(claims.accountId, 'accountId');
  const expiresAt = requireNumberClaim(claims.exp, 'exp');
  const issuedAtSeconds = requireNumberClaim(claims.iat, 'iat');
  const routePlanId = requireStringClaim(claims.routePlanId, 'routePlanId');
  const subject = requireStringClaim(claims.sub, 'sub');
  const tokenVersion = readTokenVersionClaim(claims.tokenVersion);

  if (audience !== DRIVER_ROUTE_AUDIENCE) {
    throw new Error('Driver route token audience mismatch');
  }
  verifyTokenTimes(claims, expiresAt, nowSeconds);

  return {
    accountId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    routePlanId,
    subject,
    tokenVersion
  };
}

export function signDriverAccountToken(
  input: SignDriverAccountTokenInput,
  options: VerifyDriverTokenOptions
): SignDriverTokenResult {
  return signToken({
    accountId: requireStringClaim(input.accountId, 'accountId'),
    aud: DRIVER_ACCOUNT_AUDIENCE,
    sub: requireStringClaim(input.subject, 'sub'),
    tokenVersion: readTokenVersionClaim(input.tokenVersion)
  }, input.expiresInSeconds, options);
}

export function signDriverToken(
  input: SignDriverTokenInput,
  options: VerifyDriverTokenOptions
): SignDriverTokenResult {
  return signToken({
    aud: DRIVER_AUDIENCE,
    driverId: requireStringClaim(input.driverId, 'driverId'),
    shopDomain: normalizeDriverCommerceDomain(input.shopDomain),
    sub: requireStringClaim(input.subject, 'sub'),
    tokenVersion: readTokenVersionClaim(input.tokenVersion)
  }, input.expiresInSeconds, options);
}

export function signDriverRouteToken(
  input: SignDriverRouteTokenInput,
  options: VerifyDriverTokenOptions
): SignDriverTokenResult {
  return signToken({
    accountId: requireStringClaim(input.accountId, 'accountId'),
    aud: DRIVER_ROUTE_AUDIENCE,
    routePlanId: requireStringClaim(input.routePlanId, 'routePlanId'),
    sub: requireStringClaim(input.subject, 'sub'),
    tokenVersion: readTokenVersionClaim(input.tokenVersion)
  }, input.expiresInSeconds, options);
}

function signToken(
  claims: Record<string, unknown>,
  expiresInSeconds: number,
  options: VerifyDriverTokenOptions
): SignDriverTokenResult {
  const now = options.now ?? new Date();
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + readPositiveTtl(expiresInSeconds);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    ...claims,
    exp: expiresAtSeconds,
    iat: issuedAtSeconds,
    nbf: issuedAtSeconds
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', options.secret).update(signingInput).digest('base64url');

  return {
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    token: `${signingInput}.${signature}`,
    tokenType: 'Bearer'
  };
}

function verifyTokenEnvelope(token: string, secret: string): DriverTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Driver token must be a JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new Error('Driver token must be a JWT');
  }

  verifyHeader(encodedHeader);
  verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, secret);
  return parseClaims(encodedPayload);
}

function verifyTokenTimes(claims: DriverTokenClaims, expiresAt: number, nowSeconds: number): void {
  if (expiresAt <= nowSeconds) {
    throw new Error('Driver token has expired');
  }
  if (claims.nbf !== undefined && requireNumberClaim(claims.nbf, 'nbf') > nowSeconds) {
    throw new Error('Driver token is not active yet');
  }
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
