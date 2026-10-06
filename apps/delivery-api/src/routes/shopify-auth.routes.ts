import type { FastifyInstance } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';
import { hashTelemetryShop, redactTelemetry } from '../modules/security/safe-telemetry-redaction.js';
import type { ShopTokenService } from '../modules/shopify/shop-token.service.js';
import {
  SHOPIFY_TOKEN_BROKER_PATH,
  SHOPIFY_TOKEN_BROKER_REFRESH_MARKER,
  type ShopifyTokenBrokerVerifier
} from '../modules/shopify/token-broker-auth.js';

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
  shopTokenService: Pick<ShopTokenService, 'getOfflineToken'>;
  tokenBrokerVerifier?: Pick<ShopifyTokenBrokerVerifier, 'verify'>;
  now?: () => Date;
};

type TokenExchangeRequestBody = {
  shopDomain?: unknown;
};

export function registerShopifyAuthRoutes(
  app: FastifyInstance,
  dependencies: ShopifyAuthDependencies
): void {
  registerTokenBrokerRoute(app, dependencies);
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

    let verified: ReturnType<AdminSessionTokenVerifier['verify']>;
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
      const stored = await dependencies.shopTokenService.getOfflineToken({
        appId: verified.appId,
        apiVersion: dependencies.apiVersion,
        installedAt: verified.issuedAt ?? dependencies.now?.() ?? new Date(),
        sessionToken,
        shopDomain: verified.shopDomain
      });
      if (stored === null) throw new Error('Shopify token unavailable');
      const requestCorrelation = readCorrelationId(request.headers['x-correlation-id']);
      request.log.info({
        appId: stored.appId,
        event: 'shopify_admin_token_available',
        requestCorrelationHash: requestCorrelation === null
          ? null
          : hashTelemetryShop(`shopify-auth-correlation:${requestCorrelation}`),
        requestCorrelationProvided: requestCorrelation !== null,
        requestId: request.id,
        scopes: stored.tokenScopes,
        shopHash: hashTelemetryShop(`${stored.appId}:${stored.shopDomain}`),
        tokenAccessExpiresAt: stored.accessTokenExpiresAt?.toISOString() ?? null,
        tokenRefreshExpiresAt: stored.refreshTokenExpiresAt?.toISOString() ?? null
      }, 'Shopify Admin token available');

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
            shopHash: hashTelemetryShop(`${stored.appId}:${stored.shopDomain}`)
          }, 'Shopify token available but order reconciliation could not be queued');
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
    } catch (error) {
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : error instanceof Error ? error.name : 'UNKNOWN';
      request.log.warn({
        appId: verified.appId,
        error: redactTelemetry(error),
        errorCode,
        event: 'shopify_admin_token_exchange_failed',
        shopHash: hashTelemetryShop(`${verified.appId ?? 'clever'}:${verified.shopDomain}`),
        stage: 'exchange_or_persist'
      }, 'Shopify Admin token exchange or persistence failed');
      if (errorCode === 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT') {
        return reply.code(504).send(errorResponse(
          'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT',
          'Shopify token exchange timed out'
        ));
      }
      if (error instanceof Error && error.name === 'ShopTokenInstallSupersededError') {
        return reply.code(409).send(errorResponse(
          'SHOP_INSTALL_SUPERSEDED',
          'Shopify installation was superseded'
        ));
      }
      return reply
        .code(502)
        .send(errorResponse('SHOPIFY_TOKEN_EXCHANGE_FAILED', 'Shopify token exchange failed'));
    }
  });
}

function registerTokenBrokerRoute(app: FastifyInstance, dependencies: ShopifyAuthDependencies): void {
  const verifier = dependencies.tokenBrokerVerifier;
  if (verifier === undefined) return;

  app.post(SHOPIFY_TOKEN_BROKER_PATH, {
    bodyLimit: 16_384,
    config: { rateLimit: { max: 300, timeWindow: 60_000 } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let verified: ReturnType<ShopifyTokenBrokerVerifier['verify']>;
    let installedAt: Date | undefined;
    try {
      verified = verifier.verify({
        body: request.body,
        signature: singleHeader(request.headers['x-clever-token-signature']),
        timestamp: singleHeader(request.headers['x-clever-token-timestamp'])
      });
      if (verified.operation === 'exchange') {
        const session = dependencies.sessionTokenVerifier.verify(verified.sessionToken ?? '', {
          expectedAppId: verified.appId,
          expectedShopDomain: verified.shopDomain
        });
        // Check again even with injected verifiers: a signed request must never
        // grant another app's or another shop's browser session authority.
        if (session.appId !== verified.appId || session.shopDomain !== verified.shopDomain) {
          throw new Error('Shopify session identity mismatch');
        }
        installedAt = session.issuedAt ?? dependencies.now?.() ?? new Date();
      }
    } catch {
      return reply.code(401).send({ error: 'invalid_grant', error_description: 'Invalid token authority request' });
    }

    try {
      const token = await dependencies.shopTokenService.getOfflineToken({
        appId: verified.appId,
        apiVersion: dependencies.apiVersion,
        ...(installedAt === undefined ? {} : { installedAt }),
        ...(verified.sessionToken === undefined ? {} : { sessionToken: verified.sessionToken }),
        shopDomain: verified.shopDomain
      });
      if (token === null) {
        return reply.code(401).send({ error: 'invalid_grant', error_description: 'Shopify reauthorization required' });
      }
      const now = dependencies.now?.() ?? new Date();
      const expiresIn = remainingSeconds(token.accessTokenExpiresAt, now);
      const refreshExpiresIn = remainingSeconds(token.refreshTokenExpiresAt, now);
      return reply.send({
        access_token: token.accessToken,
        scope: token.tokenScopes.join(','),
        ...(expiresIn === null ? {} : { expires_in: expiresIn }),
        // This is a routing marker, never a Shopify refresh credential. Legacy
        // app caches may retain old refresh tokens; the broker ignores them.
        refresh_token: SHOPIFY_TOKEN_BROKER_REFRESH_MARKER,
        ...(refreshExpiresIn === null ? {} : { refresh_token_expires_in: refreshExpiresIn })
      });
    } catch (error) {
      const superseded = error instanceof Error && error.name === 'ShopTokenInstallSupersededError';
      request.log.warn({
        event: 'shopify_token_authority_failed',
        appId: verified.appId,
        shopHash: hashTelemetryShop(`${verified.appId}:${verified.shopDomain}`)
      }, 'Shopify token authority request failed');
      return reply.code(superseded ? 401 : 502).send({
        error: superseded ? 'invalid_grant' : 'temporarily_unavailable',
        error_description: superseded ? 'Shopify reauthorization required' : 'Shopify token authority unavailable'
      });
    }
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function remainingSeconds(expiresAt: Date | null, now: Date): number | null {
  return expiresAt === null ? null : Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1_000));
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

function readCorrelationId(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,120}$/u.test(candidate) ? candidate : null;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return {
    data: null,
    error: { code, message }
  };
}
