import type { FastifyBaseLogger } from 'fastify';

export type AdminSessionTokenVerifier = {
  verify(sessionToken: string, options?: object): { shopDomain: string; subject: string };
};

type AdminSessionAuthSurface =
  | 'admin_drivers'
  | 'admin_orders'
  | 'admin_route_plans'
  | 'shopify_auth_token_exchange';

export type AdminSessionAuthLogContext = {
  log: FastifyBaseLogger;
  surface: AdminSessionAuthSurface;
};

export type RejectedAdminSessionTokenLogInput = AdminSessionAuthLogContext & {
  error: unknown;
};

export function logRejectedAdminSessionToken(input: RejectedAdminSessionTokenLogInput): void {
  input.log.warn(
    {
      event: 'shopify_admin_session_token_rejected',
      reason: classifyShopifySessionTokenFailure(input.error),
      surface: input.surface
    },
    'shopify admin session token rejected'
  );
}

export function classifyShopifySessionTokenFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';

  if (message.includes('must be a JWT')) return 'malformed_jwt';
  if (message.includes('algorithm mismatch')) return 'algorithm_mismatch';
  if (message.includes('Invalid Shopify session token signature')) return 'signature_mismatch';
  if (message.includes('Invalid Shopify session token header')) return 'invalid_header';
  if (message.includes('Invalid Shopify session token payload')) return 'invalid_payload';
  if (message.includes('claim is required')) return 'missing_claim';
  if (message.includes('has expired')) return 'expired';
  if (message.includes('not active yet')) return 'not_active_yet';
  if (message.includes('audience mismatch')) return 'audience_mismatch';
  if (message.includes('issuer mismatch')) return 'issuer_mismatch';
  if (message.includes('shop mismatch')) return 'shop_mismatch';
  if (message.includes('Shop domain must end with .myshopify.com')) return 'invalid_shop_domain';
  if (message.includes('Shop domain is not a valid myshopify.com domain')) return 'invalid_shop_domain';

  return 'verification_failed';
}
