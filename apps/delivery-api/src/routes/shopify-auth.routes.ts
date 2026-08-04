import type { FastifyInstance } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';
import { redactTelemetry } from '../modules/security/safe-telemetry-redaction.js';

export type ShopifyAuthDependencies = {
  apiVersion: string;
  orderReconciliationService?: {
    enqueueIfIdle(input: {
      appId?: string | undefined;
      mode: 'INCREMENTAL';
      requestedBy: string;
      shopDomain: string;
    }): Promise<unknown>;
  };
  sessionTokenVerifier: AdminSessionTokenVerifier;
  shopTokenService: {
    storeAdminApiToken(input: {
      appId?: string | undefined;
      accessToken: string;
      accessTokenExpiresAt?: Date | null;
      apiVersion: string;
      refreshToken?: string | null;
      refreshTokenExpiresAt?: Date | null;
      shopDomain: string;
      tokenIssuedAt?: Date | null;
      tokenScopes: string[];
    }): Promise<{ appId: string; shopDomain: string; tokenScopes: string[] }>;
  };
  tokenExchangeClient: {
    exchangeSessionTokenForOfflineToken(input: {
      appId?: string | undefined;
      sessionToken: string;
      shopDomain: string;
    }): Promise<{
      accessToken: string;
      expiresIn: number | null;
      refreshToken: string | null;
      refreshTokenExpiresIn: number | null;
      scope: string;
    }>;
  };
  now?: () => Date;
};

type TokenExchangeRequestBody = {
  shopDomain?: unknown;
};

export function registerShopifyAuthRoutes(
  app: FastifyInstance,
  dependencies: ShopifyAuthDependencies
): void {
  app.post<{ Body: TokenExchangeRequestBody }>('/shopify/auth/token-exchange', async (request, reply) => {
    const sessionToken = extractBearerToken(request.headers.authorization);
    if (sessionToken === null) {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Missing bearer session token'));
    }

    let expectedShopDomain: string | undefined;
    try {
      expectedShopDomain = readOptionalShopDomain(request.body);
    } catch {
      return reply
        .code(400)
        .send(errorResponse('BAD_REQUEST', 'shopDomain must be a non-empty string'));
    }

    let verified: { appId?: string | undefined; shopDomain: string; subject: string };
    try {
      const verifyOptions =
        expectedShopDomain === undefined ? {} : { expectedShopDomain };
      verified = dependencies.sessionTokenVerifier.verify(sessionToken, verifyOptions);
    } catch (error) {
      logRejectedAdminSessionToken({
        error,
        log: request.log,
        surface: 'shopify_auth_token_exchange'
      });
      return reply.code(401).send(errorResponse('UNAUTHORIZED', 'Invalid Shopify session token'));
    }

    try {
      const exchanged = await dependencies.tokenExchangeClient.exchangeSessionTokenForOfflineToken({
        appId: verified.appId,
        sessionToken,
        shopDomain: verified.shopDomain
      });
      const now = dependencies.now?.() ?? new Date();
      const stored = await dependencies.shopTokenService.storeAdminApiToken({
        appId: verified.appId,
        accessToken: exchanged.accessToken,
        accessTokenExpiresAt: secondsFromNow(now, exchanged.expiresIn),
        apiVersion: dependencies.apiVersion,
        refreshToken: exchanged.refreshToken,
        refreshTokenExpiresAt: secondsFromNow(now, exchanged.refreshTokenExpiresIn),
        shopDomain: verified.shopDomain,
        tokenIssuedAt: now,
        tokenScopes: splitScopes(exchanged.scope)
      });

      if (
        dependencies.orderReconciliationService !== undefined
        && stored.tokenScopes.includes('read_orders')
      ) {
        try {
          await dependencies.orderReconciliationService.enqueueIfIdle({
            appId: stored.appId,
            mode: 'INCREMENTAL',
            requestedBy: 'system:token-exchange',
            shopDomain: stored.shopDomain
          });
        } catch (error) {
          request.log.warn({
            error: redactTelemetry(error),
            event: 'shopify_order_reconciliation_enqueue_failed',
            shopDomain: stored.shopDomain
          }, 'Shopify token stored but order reconciliation could not be queued');
        }
      }

      return reply.code(200).send({
        data: {
          appId: stored.appId,
          shopDomain: stored.shopDomain,
          tokenScopes: stored.tokenScopes,
          tokenStored: true
        },
        error: null
      });
    } catch {
      return reply
        .code(502)
        .send(errorResponse('SHOPIFY_TOKEN_EXCHANGE_FAILED', 'Shopify token exchange failed'));
    }
  });
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    return null;
  }

  return match[1].trim();
}

function readOptionalShopDomain(body: TokenExchangeRequestBody | undefined): string | undefined {
  if (body?.shopDomain === undefined) {
    return undefined;
  }

  if (typeof body.shopDomain !== 'string' || body.shopDomain.trim() === '') {
    throw new Error('shopDomain must be a non-empty string');
  }

  return body.shopDomain;
}

function secondsFromNow(now: Date, seconds: number | null): Date | null {
  if (seconds === null) {
    return null;
  }

  return new Date(now.getTime() + seconds * 1000);
}

function splitScopes(scope: string): string[] {
  return scope
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return {
    data: null,
    error: { code, message }
  };
}
