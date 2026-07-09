import type { TokenEncryptionKey } from '../security/token-encryption.js';
import { decryptSecret, encryptSecret } from '../security/token-encryption.js';
import type {
  EncryptedShopTokenInput,
  PrismaShopTokenRepository,
  ShopTokenRow
} from './shop-token.repository.js';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

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

type ShopTokenServiceOptions = {
  encryptionKey: TokenEncryptionKey;
  repository: Pick<PrismaShopTokenRepository, 'findByShopDomain' | 'upsertShopToken'>;
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
    const row = await this.options.repository.findByShopDomain(
      typeof input === 'string' ? shopDomain : { appId: input.appId, shopDomain }
    );

    if (row?.adminAccessTokenCiphertext == null) {
      return null;
    }

    if (this.shouldRefreshAccessToken(row)) {
      const refreshed = await this.refreshAccessToken(row);
      if (refreshed !== null) return refreshed;
    }

    return decryptSecret(row.adminAccessTokenCiphertext, {
      aad: tokenAad(shopDomain, 'access'),
      key: this.options.encryptionKey
    });
  }

  private shouldRefreshAccessToken(row: ShopTokenRow): boolean {
    if (row.adminAccessTokenExpiresAt === null) return false;
    const now = this.options.now?.() ?? new Date();
    return row.adminAccessTokenExpiresAt.getTime() - now.getTime() <= ACCESS_TOKEN_REFRESH_SKEW_MS;
  }

  private async refreshAccessToken(row: ShopTokenRow): Promise<string | null> {
    if (this.options.tokenRefreshClient === undefined || row.adminRefreshTokenCiphertext === null) {
      return null;
    }
    if (row.adminRefreshTokenExpiresAt !== null) {
      const now = this.options.now?.() ?? new Date();
      if (row.adminRefreshTokenExpiresAt.getTime() <= now.getTime()) return null;
    }

    const refreshToken = decryptSecret(row.adminRefreshTokenCiphertext, {
      aad: tokenAad(row.shopDomain, 'refresh'),
      key: this.options.encryptionKey
    });
    const refreshed = await this.options.tokenRefreshClient.refreshOfflineToken({
      appId: row.appId,
      refreshToken,
      shopDomain: row.shopDomain
    });
    const now = this.options.now?.() ?? new Date();

    await this.storeAdminApiToken({
      appId: row.appId,
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: secondsFromNow(now, refreshed.expiresIn),
      apiVersion: row.apiVersion,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      refreshTokenExpiresAt: secondsFromNow(now, refreshed.refreshTokenExpiresIn) ?? row.adminRefreshTokenExpiresAt,
      shopDomain: row.shopDomain,
      shopifyShopGid: row.shopifyShopGid,
      tokenIssuedAt: now,
      tokenScopes: normalizeScopes(refreshed.scope.split(','))
    });

    return refreshed.accessToken;
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

function tokenAad(shopDomain: string, tokenKind: 'access' | 'refresh'): string {
  return `shopify-admin-token:${tokenKind}:${shopDomain}`;
}

function secondsFromNow(now: Date, seconds: number | null): Date | null {
  if (seconds === null) return null;
  return new Date(now.getTime() + seconds * 1000);
}
