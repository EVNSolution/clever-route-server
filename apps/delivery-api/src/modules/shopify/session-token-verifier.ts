import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SHOPIFY_APP_ID, normalizeShopifyAppId } from './shopify-app-scope.js';

export type VerifiedShopifySession = {
  appId: string;
  shopDomain: string;
  subject: string;
};

export type ShopifySessionTokenAppCredential = {
  appId: string;
  clientId: string;
  clientSecret: string;
};

export type ShopifySessionTokenVerifierOptions = {
  appCredentials?: ShopifySessionTokenAppCredential[];
  appId?: string | undefined;
  clientId?: string;
  clientSecret?: string;
  expectedAppId?: string;
  expectedShopDomain?: string;
  now?: Date;
};

type ShopifySessionClaims = {
  aud?: unknown;
  dest?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
};

type ShopifySessionHeader = {
  alg?: unknown;
  typ?: unknown;
};

export class ShopifySessionTokenVerifier {
  private readonly appCredentials: ShopifySessionTokenAppCredential[];

  constructor(options: Pick<ShopifySessionTokenVerifierOptions, 'appCredentials' | 'appId' | 'clientId' | 'clientSecret'>) {
    this.appCredentials = normalizeCredentials(options);
  }

  verify(
    sessionToken: string,
    options: Pick<ShopifySessionTokenVerifierOptions, 'expectedAppId' | 'expectedShopDomain' | 'now'> = {}
  ): VerifiedShopifySession {
    const verifierOptions: ShopifySessionTokenVerifierOptions = {
      appCredentials: this.appCredentials
    };

    if (options.expectedAppId !== undefined) {
      verifierOptions.expectedAppId = options.expectedAppId;
    }

    if (options.expectedShopDomain !== undefined) {
      verifierOptions.expectedShopDomain = options.expectedShopDomain;
    }

    if (options.now !== undefined) {
      verifierOptions.now = options.now;
    }

    return verifyShopifySessionToken(sessionToken, verifierOptions);
  }
}

export function verifyShopifySessionToken(
  sessionToken: string,
  options: ShopifySessionTokenVerifierOptions
): VerifiedShopifySession {
  const parts = sessionToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Shopify session token must be a JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new Error('Shopify session token must be a JWT');
  }

  verifyHeader(encodedHeader);

  const claims = parseClaims(encodedPayload);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const audience = requireStringClaim(claims.aud, 'aud');
  const credential = findCredentialForAudience(normalizeCredentials(options), audience);
  if (credential === null) {
    throw new Error('Shopify session token audience mismatch');
  }
  verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, credential.clientSecret);

  const dest = requireStringClaim(claims.dest, 'dest');
  const expiresAt = requireNumberClaim(claims.exp, 'exp');
  const issuer = requireStringClaim(claims.iss, 'iss');
  const notBefore = requireNumberClaim(claims.nbf, 'nbf');
  const subject = requireStringClaim(claims.sub, 'sub');

  if (expiresAt <= nowSeconds) {
    throw new Error('Shopify session token has expired');
  }

  if (notBefore > nowSeconds) {
    throw new Error('Shopify session token is not active yet');
  }

  const shopDomain = normalizeShopDomain(dest);
  const issuerShopDomain = normalizeIssuerShopDomain(issuer);

  if (shopDomain !== issuerShopDomain) {
    throw new Error('Shopify session token issuer mismatch');
  }

  if (options.expectedShopDomain !== undefined) {
    const expected = normalizeShopDomain(options.expectedShopDomain);
    if (expected !== shopDomain) {
      throw new Error('Shopify session token shop mismatch');
    }
  }

  if (options.expectedAppId !== undefined) {
    const expectedAppId = normalizeShopifyAppId(options.expectedAppId);
    if (expectedAppId !== credential.appId) {
      throw new Error('Shopify session token app mismatch');
    }
  }

  return { appId: credential.appId, shopDomain, subject };
}

function normalizeCredentials(
  options: Pick<ShopifySessionTokenVerifierOptions, 'appCredentials' | 'appId' | 'clientId' | 'clientSecret'>
): ShopifySessionTokenAppCredential[] {
  if (options.appCredentials !== undefined) {
    if (options.appCredentials.length === 0) {
      throw new Error('At least one Shopify app credential is required');
    }
    return options.appCredentials.map((credential) => ({
      appId: normalizeShopifyAppId(credential.appId),
      clientId: requireNonEmptyConfig(credential.clientId, 'clientId'),
      clientSecret: requireNonEmptyConfig(credential.clientSecret, 'clientSecret')
    }));
  }

  return [
    {
      appId: normalizeShopifyAppId(options.appId ?? DEFAULT_SHOPIFY_APP_ID),
      clientId: requireNonEmptyConfig(options.clientId, 'clientId'),
      clientSecret: requireNonEmptyConfig(options.clientSecret, 'clientSecret')
    }
  ];
}

function findCredentialForAudience(
  credentials: ShopifySessionTokenAppCredential[],
  audience: string
): ShopifySessionTokenAppCredential | null {
  return credentials.find((credential) => credential.clientId === audience) ?? null;
}

function requireNonEmptyConfig(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Shopify session token verifier ${name} is required`);
  }
  return value.trim();
}

function verifyHeader(encodedHeader: string): void {
  const header = parseHeader(encodedHeader);
  const algorithm = requireStringClaim(header.alg, 'header alg');
  const tokenType = requireStringClaim(header.typ, 'header typ');

  if (algorithm !== 'HS256' || tokenType !== 'JWT') {
    throw new Error('Shopify session token algorithm mismatch');
  }
}

function verifySignature(signingInput: string, signature: string, clientSecret: string): void {
  const expected = createHmac('sha256', clientSecret).update(signingInput).digest('base64url');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (
    expectedBuffer.byteLength !== actualBuffer.byteLength ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error('Invalid Shopify session token signature');
  }
}

function parseHeader(encodedHeader: string): ShopifySessionHeader {
  try {
    return JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as ShopifySessionHeader;
  } catch (error) {
    throw new Error('Invalid Shopify session token header', { cause: error });
  }
}

function parseClaims(encodedPayload: string): ShopifySessionClaims {
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as ShopifySessionClaims;
  } catch (error) {
    throw new Error('Invalid Shopify session token payload', { cause: error });
  }
}

function requireStringClaim(value: unknown, claimName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Shopify session token ${claimName} claim is required`);
  }

  return value;
}

function requireNumberClaim(value: unknown, claimName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Shopify session token ${claimName} claim is required`);
  }

  return value;
}

function normalizeIssuerShopDomain(value: string): string {
  const normalized = normalizeShopDomain(value.replace(/\/admin\/?$/u, ''));
  return normalized;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
