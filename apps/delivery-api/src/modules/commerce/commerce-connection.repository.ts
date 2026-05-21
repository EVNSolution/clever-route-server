import type { CommerceConnectionStatus, CommerceSourcePlatform, PrismaClient } from '@prisma/client';

type CommerceConnectionPrismaClient = Pick<PrismaClient, 'commerceConnection' | 'shop'>;

export type CommerceConnectionRecord = {
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  id: string;
  label: string | null;
  platform: CommerceSourcePlatform;
  shopDomain: string;
  shopId: string;
  siteUrl: string;
  status: CommerceConnectionStatus;
  timezone: string | null;
  webhookSecretCiphertext: string;
};

export type WooCommerceConnectionWriteInput = {
  connectionId: string;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecretCiphertext: string;
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
        id: input.connectionId,
        label: input.label,
        platform: 'WOOCOMMERCE',
        shopDomain: normalizeShopDomain(input.shopDomain),
        shopId: shop.id,
        siteUrl: normalizeCommerceSiteUrl(input.siteUrl),
        timezone: input.timezone,
        webhookSecretCiphertext: input.webhookSecretCiphertext
      },
      select: commerceConnectionSelect()
    });
  }

  async updateWooCommerceConnection(input: WooCommerceConnectionWriteInput): Promise<CommerceConnectionRecord> {
    return this.prisma.commerceConnection.update({
      data: {
        consumerKeyCiphertext: input.consumerKeyCiphertext,
        consumerSecretCiphertext: input.consumerSecretCiphertext,
        label: input.label,
        shopDomain: normalizeShopDomain(input.shopDomain),
        siteUrl: normalizeCommerceSiteUrl(input.siteUrl),
        status: 'ACTIVE',
        timezone: input.timezone,
        webhookSecretCiphertext: input.webhookSecretCiphertext
      },
      select: commerceConnectionSelect(),
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
  consumerKeyCiphertext: true;
  consumerSecretCiphertext: true;
  id: true;
  label: true;
  platform: true;
  shopDomain: true;
  shopId: true;
  siteUrl: true;
  status: true;
  timezone: true;
  webhookSecretCiphertext: true;
} {
  return {
    consumerKeyCiphertext: true,
    consumerSecretCiphertext: true,
    id: true,
    label: true,
    platform: true,
    shopDomain: true,
    shopId: true,
    siteUrl: true,
    status: true,
    timezone: true,
    webhookSecretCiphertext: true
  };
}
