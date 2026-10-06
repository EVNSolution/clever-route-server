import type { TokenEncryptionKey } from '../security/token-encryption.js';
import { decryptSecret, encryptSecret } from '../security/token-encryption.js';
import type {
  EncryptedShopTokenInput,
  LockedShopTokenContext,
  PrismaShopTokenRepository,
  ShopTokenRow
} from './shop-token.repository.js';
import { ShopTokenInstallSupersededError } from './shop-token.repository.js';
import { ShopifyTokenRefreshRejectedError } from './token-exchange.client.js';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const OFFLINE_TOKEN_BROKER_MINIMUM_VALIDITY_MS = 330_000;

export type StoreAdminApiTokenInput = {
  appId?: string | undefined;
  accessToken: string;
  accessTokenExpiresAt?: Date | null;
  apiVersion: string;
  installedAt?: Date;
  refreshToken?: string | null;
  refreshTokenExpiresAt?: Date | null;
  shopDomain: string;
  shopifyShopGid?: string | null;
  tokenIssuedAt?: Date | null;
  tokenScopes: string[];
};

export type ShopifyOfflineTokenRefreshResult = {
  accessToken: string;
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
  scope: string;
};

export type OfflineShopToken = {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  appId: string;
  refreshTokenExpiresAt: Date | null;
  shopDomain: string;
  tokenScopes: string[];
};

export type GetOfflineTokenInput = {
  apiVersion?: string | undefined;
  appId?: string | undefined;
  installedAt?: Date | undefined;
  sessionToken?: string | undefined;
  shopDomain: string;
};

type ShopTokenServiceOptions = {
  encryptionKey: TokenEncryptionKey;
  repository: Pick<
    PrismaShopTokenRepository,
    'findByShopDomain' | 'updateRefreshedShopToken' | 'upsertShopToken' | 'withLockedShopToken'
  >;
  tokenExchangeClient?: {
    exchangeSessionTokenForOfflineToken(input: {
      appId?: string | undefined;
      sessionToken: string;
      shopDomain: string;
    }): Promise<ShopifyOfflineTokenRefreshResult>;
  } | undefined;
  tokenRefreshClient?: {
    refreshOfflineToken(input: {
      appId?: string | undefined;
      refreshToken: string;
      shopDomain: string;
    }): Promise<ShopifyOfflineTokenRefreshResult>;
  } | undefined;
  now?: () => Date;
};

export class ShopTokenService {
  constructor(private readonly options: ShopTokenServiceOptions) {}

  async storeAdminApiToken(input: StoreAdminApiTokenInput): Promise<ShopTokenRow> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    assertNonEmpty(input.accessToken, 'accessToken');
    assertNonEmpty(input.apiVersion, 'apiVersion');

    const tokenScopes = normalizeScopes(input.tokenScopes);
    const adminAccessTokenCiphertext = encryptSecret(input.accessToken, {
      aad: tokenAad(shopDomain, 'access'),
      key: this.options.encryptionKey
    });
    const adminRefreshTokenCiphertext = input.refreshToken
      ? encryptSecret(input.refreshToken, {
          aad: tokenAad(shopDomain, 'refresh'),
          key: this.options.encryptionKey
        })
      : null;

    const encryptedInput: EncryptedShopTokenInput = {
      appId: input.appId,
      adminAccessTokenCiphertext,
      adminAccessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      adminRefreshTokenCiphertext,
      adminRefreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
      apiVersion: input.apiVersion.trim(),
      shopDomain,
      shopifyShopGid: input.shopifyShopGid ?? null,
      tokenIssuedAt: input.tokenIssuedAt ?? null,
      tokenScopes
    };

    if (input.installedAt !== undefined) {
      encryptedInput.installedAt = input.installedAt;
    }

    return this.options.repository.upsertShopToken(encryptedInput);
  }

  async getAdminAccessToken(input: { appId?: string | undefined; shopDomain: string } | string): Promise<string | null> {
    const shopDomain = normalizeShopDomain(typeof input === 'string' ? input : input.shopDomain);
    const token = await this.resolveOfflineToken({
      ...(typeof input === 'string' ? {} : { appId: input.appId }),
      minimumValidityMs: ACCESS_TOKEN_REFRESH_SKEW_MS,
      shopDomain
    });
    return token?.accessToken ?? null;
  }

  async getOfflineToken(input: GetOfflineTokenInput): Promise<OfflineShopToken | null> {
    return this.resolveOfflineToken({
      ...input,
      minimumValidityMs: OFFLINE_TOKEN_BROKER_MINIMUM_VALIDITY_MS,
      shopDomain: normalizeShopDomain(input.shopDomain)
    });
  }

  private async resolveOfflineToken(
    input: GetOfflineTokenInput & { minimumValidityMs: number }
  ): Promise<OfflineShopToken | null> {
    const sessionToken = normalizeOptional(input.sessionToken);
    const installIntentAt = sessionToken === undefined
      ? undefined
      : input.installedAt ?? (this.options.now?.() ?? new Date());

    return this.options.repository.withLockedShopToken(
      { appId: input.appId, shopDomain: input.shopDomain },
      async (locked) => {
        this.assertInstallIntentIsCurrent(locked, installIntentAt);
        const row = this.canUseStoredToken(locked, installIntentAt) ? locked.row : null;
        const now = this.options.now?.() ?? new Date();

        if (row?.adminAccessTokenCiphertext != null && !this.shouldRefreshAccessToken(
          row,
          now,
          input.minimumValidityMs
        )) {
          return this.toOfflineShopToken(row);
        }

        if (row !== null && this.canRefreshAccessToken(row, now)) {
          try {
            const refreshed = await this.refreshAccessTokenWithinLock(locked, row);
            if (refreshed !== null) return refreshed;
          } catch (error) {
            if (!(error instanceof ShopifyTokenRefreshRejectedError)) throw error;
            if (sessionToken === undefined) return null;
          }
        }

        if (sessionToken === undefined) return null;
        return this.exchangeAccessTokenWithinLock(locked, {
          apiVersion: normalizeOptional(input.apiVersion) ?? row?.apiVersion,
          appId: input.appId ?? row?.appId,
          installedAt: installIntentAt as Date,
          sessionToken,
          shopDomain: input.shopDomain
        });
      }
    );
  }

  private shouldRefreshAccessToken(row: ShopTokenRow, now: Date, minimumValidityMs: number): boolean {
    if (row.adminAccessTokenExpiresAt === null) return false;
    return row.adminAccessTokenExpiresAt.getTime() - now.getTime() <= minimumValidityMs;
  }

  private canRefreshAccessToken(row: ShopTokenRow, now: Date): boolean {
    return this.options.tokenRefreshClient !== undefined
      && row.adminRefreshTokenCiphertext !== null
      && (row.adminRefreshTokenExpiresAt === null || row.adminRefreshTokenExpiresAt.getTime() > now.getTime());
  }

  private async refreshAccessTokenWithinLock(
    locked: LockedShopTokenContext,
    row: ShopTokenRow
  ): Promise<OfflineShopToken | null> {
    const refreshClient = this.options.tokenRefreshClient;
    if (refreshClient === undefined || row.adminRefreshTokenCiphertext === null) return null;
    const refreshToken = decryptSecret(row.adminRefreshTokenCiphertext, {
      aad: tokenAad(row.shopDomain, 'refresh'),
      key: this.options.encryptionKey
    });
    const requestedAt = this.options.now?.() ?? new Date();
    const refreshed = await refreshClient.refreshOfflineToken({
      appId: row.appId,
      refreshToken,
      shopDomain: row.shopDomain
    });
    assertCompleteExpiringOfflineTokenPair(refreshed, 'refresh');

    const encryptedAccessToken = encryptSecret(refreshed.accessToken, {
      aad: tokenAad(row.shopDomain, 'access'),
      key: this.options.encryptionKey
    });
    const persisted = await locked.updateRefreshedShopToken({
      appId: row.appId,
      adminAccessTokenCiphertext: encryptedAccessToken,
      adminAccessTokenExpiresAt: secondsFromNow(requestedAt, refreshed.expiresIn),
      adminRefreshTokenCiphertext: encryptSecret(refreshed.refreshToken, {
        aad: tokenAad(row.shopDomain, 'refresh'),
        key: this.options.encryptionKey
      }),
      adminRefreshTokenExpiresAt: secondsFromNow(requestedAt, refreshed.refreshTokenExpiresIn) ?? row.adminRefreshTokenExpiresAt,
      apiVersion: row.apiVersion,
      shopDomain: row.shopDomain,
      shopifyShopGid: row.shopifyShopGid,
      tokenIssuedAt: requestedAt,
      tokenScopes: normalizeScopes(refreshed.scope.split(','))
    }, row);

    return persisted?.adminAccessTokenCiphertext == null ? null : this.toOfflineShopToken(persisted);
  }

  private async exchangeAccessTokenWithinLock(
    locked: LockedShopTokenContext,
    input: {
      apiVersion?: string | undefined;
      appId?: string | undefined;
      installedAt: Date;
      sessionToken: string;
      shopDomain: string;
    }
  ): Promise<OfflineShopToken | null> {
    const exchangeClient = this.options.tokenExchangeClient;
    if (exchangeClient === undefined) return null;
    if (input.apiVersion === undefined) {
      throw new Error('apiVersion is required to acquire a Shopify offline token');
    }
    const requestedAt = this.options.now?.() ?? new Date();
    const exchanged = await exchangeClient.exchangeSessionTokenForOfflineToken({
      appId: input.appId,
      sessionToken: input.sessionToken,
      shopDomain: input.shopDomain
    });
    assertCompleteExpiringOfflineTokenPair(exchanged, 'exchange');
    const persisted = await locked.upsertShopToken(this.encryptTokenResult({
      apiVersion: input.apiVersion,
      appId: input.appId,
      installedAt: input.installedAt,
      result: exchanged,
      shopDomain: input.shopDomain,
      shopifyShopGid: locked.row?.shopifyShopGid ?? null,
      tokenIssuedAt: requestedAt
    }));
    return this.toOfflineShopToken(persisted);
  }

  private encryptTokenResult(input: {
    apiVersion: string;
    appId?: string | undefined;
    installedAt?: Date | undefined;
    result: ShopifyOfflineTokenRefreshResult;
    shopDomain: string;
    shopifyShopGid: string | null;
    tokenIssuedAt: Date;
  }): EncryptedShopTokenInput {
    const encrypted: EncryptedShopTokenInput = {
      appId: input.appId,
      adminAccessTokenCiphertext: encryptSecret(input.result.accessToken, {
        aad: tokenAad(input.shopDomain, 'access'),
        key: this.options.encryptionKey
      }),
      adminAccessTokenExpiresAt: secondsFromNow(input.tokenIssuedAt, input.result.expiresIn),
      adminRefreshTokenCiphertext: input.result.refreshToken === null
        ? null
        : encryptSecret(input.result.refreshToken, {
            aad: tokenAad(input.shopDomain, 'refresh'),
            key: this.options.encryptionKey
          }),
      adminRefreshTokenExpiresAt: secondsFromNow(input.tokenIssuedAt, input.result.refreshTokenExpiresIn),
      apiVersion: input.apiVersion,
      shopDomain: input.shopDomain,
      shopifyShopGid: input.shopifyShopGid,
      tokenIssuedAt: input.tokenIssuedAt,
      tokenScopes: normalizeScopes(input.result.scope.split(','))
    };
    if (input.installedAt !== undefined) encrypted.installedAt = input.installedAt;
    return encrypted;
  }

  private assertInstallIntentIsCurrent(
    locked: LockedShopTokenContext,
    installedAt: Date | undefined
  ): void {
    if (installedAt === undefined) return;
    if (
      locked.tombstone?.reinstalledAt === null
      && installedAt.getTime() <= locked.tombstone.redactedAt.getTime()
    ) {
      throw new ShopTokenInstallSupersededError();
    }
    if (
      locked.tombstone?.reinstalledAt !== undefined
      && locked.tombstone.reinstalledAt !== null
      && installedAt.getTime() < locked.tombstone.reinstalledAt.getTime()
    ) {
      throw new ShopTokenInstallSupersededError();
    }
    if (
      locked.row?.uninstalledAt != null
      && installedAt.getTime() <= locked.row.uninstalledAt.getTime()
    ) {
      throw new ShopTokenInstallSupersededError();
    }
  }

  private canUseStoredToken(
    locked: LockedShopTokenContext,
    installedAt: Date | undefined
  ): boolean {
    if (locked.row === null || locked.row.uninstalledAt !== null) return false;
    if (locked.tombstone?.reinstalledAt === null) return false;
    if (installedAt === undefined) return true;
    return locked.tombstone?.reinstalledAt === undefined
      || installedAt.getTime() >= locked.tombstone.reinstalledAt.getTime();
  }

  private toOfflineShopToken(row: ShopTokenRow): OfflineShopToken | null {
    if (row.adminAccessTokenCiphertext === null) return null;
    return {
      accessToken: decryptSecret(row.adminAccessTokenCiphertext, {
        aad: tokenAad(row.shopDomain, 'access'),
        key: this.options.encryptionKey
      }),
      accessTokenExpiresAt: row.adminAccessTokenExpiresAt,
      appId: row.appId,
      refreshTokenExpiresAt: row.adminRefreshTokenExpiresAt,
      shopDomain: row.shopDomain,
      tokenScopes: row.tokenScopes
    };
  }
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

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function assertCompleteExpiringOfflineTokenPair(
  result: ShopifyOfflineTokenRefreshResult,
  operation: 'exchange' | 'refresh'
): asserts result is ShopifyOfflineTokenRefreshResult & {
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
} {
  if (
    result.accessToken.trim() === ''
    || result.refreshToken === null
    || result.refreshToken.trim() === ''
    || result.scope.trim() === ''
    || result.expiresIn === null
    || !Number.isFinite(result.expiresIn)
    || result.expiresIn <= 0
    || result.refreshTokenExpiresIn === null
    || !Number.isFinite(result.refreshTokenExpiresIn)
    || result.refreshTokenExpiresIn <= 0
  ) {
    throw new Error(`Shopify token ${operation} returned an incomplete rotating token pair`);
  }
}

function tokenAad(shopDomain: string, tokenKind: 'access' | 'refresh'): string {
  return `shopify-admin-token:${tokenKind}:${shopDomain}`;
}

function secondsFromNow(now: Date, seconds: number | null): Date | null {
  if (seconds === null) return null;
  return new Date(now.getTime() + seconds * 1000);
}
