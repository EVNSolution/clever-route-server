export type ShopTokenRow = {
  adminAccessTokenCiphertext: string | null;
  adminAccessTokenExpiresAt: Date | null;
  adminRefreshTokenCiphertext: string | null;
  adminRefreshTokenExpiresAt: Date | null;
  apiVersion: string;
  createdAt: Date;
  installedAt: Date;
  shopDomain: string;
  shopifyShopGid: string | null;
  tokenIssuedAt: Date | null;
  tokenScopes: string[];
  uninstalledAt: Date | null;
  updatedAt: Date;
};

export type EncryptedShopTokenInput = {
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
    shopDomain: string;
  };
};

type ShopTokenFindUniqueArgs = {
  select: Record<keyof ShopTokenRow, true>;
  where: {
    shopDomain: string;
  };
};

type ShopDelegate = {
  findUnique(args: ShopTokenFindUniqueArgs): Promise<ShopTokenRow | null>;
  upsert(args: ShopTokenUpsertArgs): Promise<ShopTokenRow>;
};

type PrismaLikeClient = {
  shop: ShopDelegate;
};

const SHOP_TOKEN_SELECT: Record<keyof ShopTokenRow, true> = {
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

export class PrismaShopTokenRepository {
  constructor(private readonly prisma: PrismaLikeClient) {}

  async findByShopDomain(shopDomain: string): Promise<ShopTokenRow | null> {
    return this.prisma.shop.findUnique({
      select: SHOP_TOKEN_SELECT,
      where: { shopDomain }
    });
  }

  async upsertShopToken(input: EncryptedShopTokenInput): Promise<ShopTokenRow> {
    const now = new Date();
    const create: ShopTokenRow = {
      adminAccessTokenCiphertext: input.adminAccessTokenCiphertext,
      adminAccessTokenExpiresAt: input.adminAccessTokenExpiresAt,
      adminRefreshTokenCiphertext: input.adminRefreshTokenCiphertext,
      adminRefreshTokenExpiresAt: input.adminRefreshTokenExpiresAt,
      apiVersion: input.apiVersion,
      createdAt: now,
      installedAt: input.installedAt ?? now,
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

    return this.prisma.shop.upsert({
      create,
      update,
      where: { shopDomain: input.shopDomain }
    });
  }
}
