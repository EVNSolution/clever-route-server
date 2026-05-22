import type { CommerceConnectionStatus, CommerceSourcePlatform, PrismaClient, Prisma } from '@prisma/client';

type CommerceConnectionPrismaClient = Pick<PrismaClient, 'commerceConnection' | 'commerceConnectionAuditLog' | 'shop'>;

export type CommerceConnectionRecord = {
  credentialFingerprint: string | null;
  credentialRotatedAt: Date | null;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  id: string;
  label: string | null;
  lastRestSyncAt: Date | null;
  lastVerifiedAt: Date | null;
  lastVerificationStatus: string | null;
  lastWebhookAt: Date | null;
  platform: CommerceSourcePlatform;
  shopDomain: string;
  shopId: string;
  siteUrl: string;
  status: CommerceConnectionStatus;
  timezone: string | null;
  webhookSecretCiphertext: string;
  webhookSecretRotatedAt: Date | null;
};

export type WooCommerceConnectionWriteInput = {
  connectionId: string;
  credentialFingerprint?: string | null;
  credentialRotatedAt?: Date | null;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  label: string | null;
  lastVerifiedAt?: Date | null;
  lastVerificationStatus?: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecretCiphertext: string;
  webhookSecretRotatedAt?: Date | null;
};

export type CommerceConnectionAuditLogInput = {
  action: string;
  actorSubject: string;
  commerceConnectionId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  shopDomain: string;
  status: string;
};

export class PrismaCommerceConnectionRepository {
  constructor(
    private readonly prisma: CommerceConnectionPrismaClient,
    private readonly options: { createMissingShop?: boolean } = {}
  ) {}

  async findConnectionById(input: { connectionId: string }): Promise<CommerceConnectionRecord | null> {
    const connection = await this.prisma.commerceConnection.findUnique({
      select: commerceConnectionSelect(),
      where: { id: input.connectionId }
    });
    return connection;
  }

  async findWooCommerceConnectionByShopAndSite(input: {
    shopDomain: string;
    siteUrl: string;
  }): Promise<CommerceConnectionRecord | null> {
    const shop = await this.findShop(normalizeShopDomain(input.shopDomain));
    if (shop === null) return null;

    const connection = await this.prisma.commerceConnection.findUnique({
      select: commerceConnectionSelect(),
      where: {
        shopId_platform_siteUrl: {
          platform: 'WOOCOMMERCE',
          shopId: shop.id,
          siteUrl: normalizeCommerceSiteUrl(input.siteUrl)
        }
      }
    });
    return connection;
  }

  async createWooCommerceConnection(input: WooCommerceConnectionWriteInput): Promise<CommerceConnectionRecord> {
    const shop = await this.findOrCreateShop(normalizeShopDomain(input.shopDomain));
    return this.prisma.commerceConnection.create({
      data: {
        consumerKeyCiphertext: input.consumerKeyCiphertext,
        consumerSecretCiphertext: input.consumerSecretCiphertext,
        credentialFingerprint: input.credentialFingerprint ?? null,
        credentialRotatedAt: input.credentialRotatedAt ?? null,
        id: input.connectionId,
        label: input.label,
        lastVerifiedAt: input.lastVerifiedAt ?? null,
        lastVerificationStatus: input.lastVerificationStatus ?? null,
        platform: 'WOOCOMMERCE',
        shopDomain: normalizeShopDomain(input.shopDomain),
        shopId: shop.id,
        siteUrl: normalizeCommerceSiteUrl(input.siteUrl),
        timezone: input.timezone,
        webhookSecretCiphertext: input.webhookSecretCiphertext,
        webhookSecretRotatedAt: input.webhookSecretRotatedAt ?? null
      },
      select: commerceConnectionSelect()
    });
  }

  async updateWooCommerceConnection(input: WooCommerceConnectionWriteInput): Promise<CommerceConnectionRecord> {
    return this.prisma.commerceConnection.update({
      data: {
        consumerKeyCiphertext: input.consumerKeyCiphertext,
        consumerSecretCiphertext: input.consumerSecretCiphertext,
        credentialFingerprint: input.credentialFingerprint ?? null,
        credentialRotatedAt: input.credentialRotatedAt ?? null,
        label: input.label,
        lastVerifiedAt: input.lastVerifiedAt ?? null,
        lastVerificationStatus: input.lastVerificationStatus ?? null,
        shopDomain: normalizeShopDomain(input.shopDomain),
        siteUrl: normalizeCommerceSiteUrl(input.siteUrl),
        status: 'ACTIVE',
        timezone: input.timezone,
        webhookSecretCiphertext: input.webhookSecretCiphertext,
        webhookSecretRotatedAt: input.webhookSecretRotatedAt ?? null
      },
      select: commerceConnectionSelect(),
      where: { id: input.connectionId }
    });
  }

  async listWooCommerceConnectionsByShop(input: { shopDomain: string }): Promise<CommerceConnectionRecord[]> {
    const shop = await this.findShop(normalizeShopDomain(input.shopDomain));
    if (shop === null) return [];

    return this.prisma.commerceConnection.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: commerceConnectionSelect(),
      where: {
        platform: 'WOOCOMMERCE',
        shopId: shop.id
      }
    });
  }

  async updateWooCommerceCredentialCiphertexts(input: {
    at: Date;
    connectionId: string;
    consumerKeyCiphertext: string;
    consumerSecretCiphertext: string;
    credentialFingerprint: string;
    lastVerificationStatus: string;
  }): Promise<CommerceConnectionRecord> {
    return this.prisma.commerceConnection.update({
      data: {
        consumerKeyCiphertext: input.consumerKeyCiphertext,
        consumerSecretCiphertext: input.consumerSecretCiphertext,
        credentialFingerprint: input.credentialFingerprint,
        credentialRotatedAt: input.at,
        lastVerifiedAt: input.at,
        lastVerificationStatus: input.lastVerificationStatus
      },
      select: commerceConnectionSelect(),
      where: { id: input.connectionId }
    });
  }

  async updateWooCommerceWebhookSecretCiphertext(input: {
    at: Date;
    connectionId: string;
    webhookSecretCiphertext: string;
  }): Promise<CommerceConnectionRecord> {
    return this.prisma.commerceConnection.update({
      data: {
        webhookSecretCiphertext: input.webhookSecretCiphertext,
        webhookSecretRotatedAt: input.at
      },
      select: commerceConnectionSelect(),
      where: { id: input.connectionId }
    });
  }

  async updateWooCommerceConnectionStatus(input: {
    connectionId: string;
    status: CommerceConnectionStatus;
  }): Promise<CommerceConnectionRecord> {
    return this.prisma.commerceConnection.update({
      data: { status: input.status },
      select: commerceConnectionSelect(),
      where: { id: input.connectionId }
    });
  }

  async recordCommerceConnectionAuditLog(input: CommerceConnectionAuditLogInput): Promise<void> {
    const shop = await this.findOrCreateShop(normalizeShopDomain(input.shopDomain));
    await this.prisma.commerceConnectionAuditLog.create({
      data: {
        action: input.action,
        actorSubject: input.actorSubject,
        ...(input.commerceConnectionId === undefined || input.commerceConnectionId === null
          ? {}
          : { commerceConnectionId: input.commerceConnectionId }),
        ...(input.metadata === undefined || input.metadata === null ? {} : { metadata: input.metadata }),
        shopId: shop.id,
        status: input.status
      }
    });
  }

  async markWooCommerceWebhookAccepted(input: { at: Date; connectionId: string }): Promise<void> {
    await this.prisma.commerceConnection.update({
      data: {
        lastSyncAt: input.at,
        lastSyncStatus: 'webhook',
        lastWebhookAt: input.at
      },
      where: { id: input.connectionId }
    });
  }

  private async findOrCreateShop(shopDomain: string): Promise<{ id: string }> {
    const shop = await this.findShop(shopDomain);
    if (shop !== null) return shop;
    if (this.options.createMissingShop !== true) {
      throw new Error(`Shop not installed: ${shopDomain}`);
    }

    return this.prisma.shop.create({
      data: { shopDomain },
      select: { id: true }
    });
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain }
    });
  }
}

export function normalizeCommerceSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error('WooCommerce site URL is required');
  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') throw new Error('Shop domain is required');
  return trimmed.replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '');
}

function commerceConnectionSelect(): {
  credentialFingerprint: true;
  credentialRotatedAt: true;
  consumerKeyCiphertext: true;
  consumerSecretCiphertext: true;
  id: true;
  label: true;
  lastRestSyncAt: true;
  lastVerifiedAt: true;
  lastVerificationStatus: true;
  lastWebhookAt: true;
  platform: true;
  shopDomain: true;
  shopId: true;
  siteUrl: true;
  status: true;
  timezone: true;
  webhookSecretCiphertext: true;
  webhookSecretRotatedAt: true;
} {
  return {
    credentialFingerprint: true,
    credentialRotatedAt: true,
    consumerKeyCiphertext: true,
    consumerSecretCiphertext: true,
    id: true,
    label: true,
    lastRestSyncAt: true,
    lastVerifiedAt: true,
    lastVerificationStatus: true,
    lastWebhookAt: true,
    platform: true,
    shopDomain: true,
    shopId: true,
    siteUrl: true,
    status: true,
    timezone: true,
    webhookSecretCiphertext: true,
    webhookSecretRotatedAt: true
  };
}
