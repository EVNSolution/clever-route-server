import type { TokenEncryptionKey } from '../security/token-encryption.js';
import { decryptSecret, encryptSecret } from '../security/token-encryption.js';
import type {
  EncryptedShopTokenInput,
  PrismaShopTokenRepository,
  ShopTokenRow
} from './shop-token.repository.js';

export type StoreAdminApiTokenInput = {
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

type ShopTokenServiceOptions = {
  encryptionKey: TokenEncryptionKey;
  repository: Pick<PrismaShopTokenRepository, 'findByShopDomain' | 'upsertShopToken'>;
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

  async getAdminAccessToken(shopDomainInput: string): Promise<string | null> {
    const shopDomain = normalizeShopDomain(shopDomainInput);
    const row = await this.options.repository.findByShopDomain(shopDomain);

    if (row?.adminAccessTokenCiphertext == null) {
      return null;
    }

    return decryptSecret(row.adminAccessTokenCiphertext, {
      aad: tokenAad(shopDomain, 'access'),
      key: this.options.encryptionKey
    });
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
