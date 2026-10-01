import { appScopedShopWhere, normalizeShopifyAppId } from './shopify-app-scope.js';
import { lockShopifyShopPrivacyIdentity } from './order-privacy-redaction.js';

export type ShopTokenRow = {
  adminAccessTokenCiphertext: string | null;
  adminAccessTokenExpiresAt: Date | null;
  adminRefreshTokenCiphertext: string | null;
  adminRefreshTokenExpiresAt: Date | null;
  apiVersion: string;
  createdAt: Date;
  installedAt: Date;
  appId: string;
  shopDomain: string;
  shopifyShopGid: string | null;
  tokenIssuedAt: Date | null;
  tokenScopes: string[];
  uninstalledAt: Date | null;
  updatedAt: Date;
};

export type EncryptedShopTokenInput = {
  appId?: string | undefined;
  adminAccessTokenCiphertext: string;
  adminAccessTokenExpiresAt: Date | null;
  adminRefreshTokenCiphertext: string | null;
  adminRefreshTokenExpiresAt: Date | null;
  apiVersion: string;
  installedAt?: Date;
  shopDomain: string;
  shopifyShopGid: string | null;
  tokenIssuedAt: Date | null;
  tokenScopes: string[];
};

type ShopTokenUpsertArgs = {
  create: ShopTokenRow;
  update: Partial<ShopTokenRow>;
  where: {
    appId_shopDomain: { appId: string; shopDomain: string };
  };
};

type ShopTokenFindUniqueArgs = {
  select: Record<keyof ShopTokenRow, true>;
  where: {
    appId_shopDomain: { appId: string; shopDomain: string };
  };
};

type ShopDelegate = {
  findUnique(args: ShopTokenFindUniqueArgs): Promise<ShopTokenRow | null>;
  updateMany(args: { data: Partial<ShopTokenRow>; where: Record<string, unknown> }): Promise<{ count: number }>;
  upsert(args: ShopTokenUpsertArgs): Promise<ShopTokenRow>;
};

type PrismaLikeClient = {
  $transaction<T>(
    callback: (tx: ShopTokenWriteClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>;
  shop: ShopDelegate;
};

type ShopTokenWriteClient = {
  $queryRaw(query: unknown, ...values: unknown[]): Promise<unknown>;
  shop: ShopDelegate;
  shopifyShopRedactionTombstone: {
    findUnique(args: {
      where: { appId_shopDomain: { appId: string; shopDomain: string } };
    }): Promise<{ redactedAt: Date; reinstalledAt: Date | null } | null>;
    updateMany(args: {
      data: { reinstalledAt: Date };
      where: { appId: string; redactedAt: { lt: Date }; reinstalledAt: null; shopDomain: string };
    }): Promise<{ count: number }>;
  };
};

export type LockedShopTokenContext = {
  row: ShopTokenRow | null;
  tombstone: { redactedAt: Date; reinstalledAt: Date | null } | null;
  updateRefreshedShopToken(
    input: EncryptedShopTokenInput,
    expected: Pick<ShopTokenRow, 'adminAccessTokenCiphertext' | 'installedAt' | 'tokenIssuedAt'>
  ): Promise<ShopTokenRow | null>;
  upsertShopToken(input: EncryptedShopTokenInput): Promise<ShopTokenRow>;
};

const SHOP_TOKEN_SELECT: Record<keyof ShopTokenRow, true> = {
  appId: true,
  adminAccessTokenCiphertext: true,
  adminAccessTokenExpiresAt: true,
  adminRefreshTokenCiphertext: true,
  adminRefreshTokenExpiresAt: true,
  apiVersion: true,
  createdAt: true,
  installedAt: true,
  shopDomain: true,
  shopifyShopGid: true,
  tokenIssuedAt: true,
  tokenScopes: true,
  uninstalledAt: true,
  updatedAt: true
};

const SHOP_TOKEN_AUTHORITY_TRANSACTION_OPTIONS = {
  maxWait: 135_000,
  timeout: 255_000
} as const;

export class PrismaShopTokenRepository {
  constructor(private readonly prisma: PrismaLikeClient) {
    if (typeof prisma.$transaction !== 'function') {
      throw new Error('Shop token repository requires transactional privacy fencing');
    }
  }

  async findByShopDomain(input: { appId?: string | undefined; shopDomain: string } | string): Promise<ShopTokenRow | null> {
    const shopDomain = typeof input === 'string' ? input : input.shopDomain;
    const appId = typeof input === 'string' ? undefined : input.appId;
    return this.prisma.shop.findUnique({
      select: SHOP_TOKEN_SELECT,
      where: appScopedShopWhere({ appId, shopDomain })
    });
  }

  async upsertShopToken(input: EncryptedShopTokenInput): Promise<ShopTokenRow> {
    return this.withLockedShopToken(input, (locked) => locked.upsertShopToken(input));
  }

  async withLockedShopToken<T>(
    input: { appId?: string | undefined; shopDomain: string },
    work: (context: LockedShopTokenContext) => Promise<T>
  ): Promise<T> {
    const appId = normalizeShopifyAppId(input.appId);
    return this.prisma.$transaction(async (tx) => {
      await lockShopifyShopPrivacyIdentity(tx as never, { appId, shopDomain: input.shopDomain });
      const row = await tx.shop.findUnique({
        select: SHOP_TOKEN_SELECT,
        where: { appId_shopDomain: { appId, shopDomain: input.shopDomain } }
      });
      const tombstone = await tx.shopifyShopRedactionTombstone.findUnique({
        where: { appId_shopDomain: { appId, shopDomain: input.shopDomain } }
      });

      return work({
        row,
        tombstone,
        updateRefreshedShopToken: (tokenInput, expected) =>
          this.updateRefreshedShopTokenWithinLock(tx, tokenInput, expected),
        upsertShopToken: (tokenInput) =>
          this.upsertShopTokenWithinLock(tx, tokenInput, row, tombstone)
      });
    }, SHOP_TOKEN_AUTHORITY_TRANSACTION_OPTIONS);
  }

  private async upsertShopTokenWithinLock(
    tx: ShopTokenWriteClient,
    input: EncryptedShopTokenInput,
    existing: ShopTokenRow | null,
    tombstone: { redactedAt: Date; reinstalledAt: Date | null } | null
  ): Promise<ShopTokenRow> {
    const now = new Date();
    const create: ShopTokenRow = {
      adminAccessTokenCiphertext: input.adminAccessTokenCiphertext,
      adminAccessTokenExpiresAt: input.adminAccessTokenExpiresAt,
      adminRefreshTokenCiphertext: input.adminRefreshTokenCiphertext,
      adminRefreshTokenExpiresAt: input.adminRefreshTokenExpiresAt,
      apiVersion: input.apiVersion,
      createdAt: now,
      installedAt: input.installedAt ?? now,
      appId: normalizeShopifyAppId(input.appId),
      shopDomain: input.shopDomain,
      shopifyShopGid: input.shopifyShopGid,
      tokenIssuedAt: input.tokenIssuedAt,
      tokenScopes: input.tokenScopes,
      uninstalledAt: null,
      updatedAt: now
    };

    const update: Partial<ShopTokenRow> = {
      adminAccessTokenCiphertext: create.adminAccessTokenCiphertext,
      adminAccessTokenExpiresAt: create.adminAccessTokenExpiresAt,
      adminRefreshTokenCiphertext: create.adminRefreshTokenCiphertext,
      adminRefreshTokenExpiresAt: create.adminRefreshTokenExpiresAt,
      apiVersion: create.apiVersion,
      shopifyShopGid: create.shopifyShopGid,
      tokenIssuedAt: create.tokenIssuedAt,
      tokenScopes: create.tokenScopes,
      uninstalledAt: null,
      updatedAt: now
    };

    if (existing !== null && existing.uninstalledAt !== null && input.installedAt !== undefined) {
      update.installedAt = input.installedAt;
    }

    const upsert = () => tx.shop.upsert({
      create,
      update,
      where: appScopedShopWhere({ appId: input.appId, shopDomain: input.shopDomain })
    });
    if (tombstone?.reinstalledAt === null) {
      if (create.installedAt.getTime() <= tombstone.redactedAt.getTime()) {
        throw new ShopTokenInstallSupersededError();
      }
      const reactivated = await tx.shopifyShopRedactionTombstone.updateMany({
        data: { reinstalledAt: create.installedAt },
        where: {
          appId: create.appId,
          redactedAt: { lt: create.installedAt },
          reinstalledAt: null,
          shopDomain: create.shopDomain
        }
      });
      if (reactivated.count !== 1) throw new ShopTokenInstallSupersededError();
    } else if (
      tombstone?.reinstalledAt !== undefined
      && create.installedAt.getTime() < tombstone.reinstalledAt.getTime()
    ) {
      throw new ShopTokenInstallSupersededError();
    }
    return upsert();
  }

  async updateRefreshedShopToken(
    input: EncryptedShopTokenInput,
    expected: Pick<ShopTokenRow, 'adminAccessTokenCiphertext' | 'installedAt' | 'tokenIssuedAt'>
  ): Promise<ShopTokenRow | null> {
    return this.withLockedShopToken(input, (locked) =>
      locked.updateRefreshedShopToken(input, expected));
  }

  private async updateRefreshedShopTokenWithinLock(
    tx: ShopTokenWriteClient,
    input: EncryptedShopTokenInput,
    expected: Pick<ShopTokenRow, 'adminAccessTokenCiphertext' | 'installedAt' | 'tokenIssuedAt'>
  ): Promise<ShopTokenRow | null> {
    const appId = normalizeShopifyAppId(input.appId);
    await tx.shop.updateMany({
      data: {
        adminAccessTokenCiphertext: input.adminAccessTokenCiphertext,
        adminAccessTokenExpiresAt: input.adminAccessTokenExpiresAt,
        adminRefreshTokenCiphertext: input.adminRefreshTokenCiphertext,
        adminRefreshTokenExpiresAt: input.adminRefreshTokenExpiresAt,
        apiVersion: input.apiVersion,
        shopifyShopGid: input.shopifyShopGid,
        tokenIssuedAt: input.tokenIssuedAt,
        tokenScopes: input.tokenScopes,
        updatedAt: new Date()
      },
      where: {
        adminAccessTokenCiphertext: expected.adminAccessTokenCiphertext,
        appId,
        installedAt: expected.installedAt,
        shopDomain: input.shopDomain,
        tokenIssuedAt: expected.tokenIssuedAt,
        uninstalledAt: null
      }
    });
    return tx.shop.findUnique({
      select: SHOP_TOKEN_SELECT,
      where: { appId_shopDomain: { appId, shopDomain: input.shopDomain } }
    });
  }
}

export class ShopTokenInstallSupersededError extends Error {
  constructor() {
    super('Shop token exchange intent predates the latest shop redaction');
    this.name = 'ShopTokenInstallSupersededError';
  }
}
