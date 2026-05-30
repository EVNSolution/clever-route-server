import type { PrismaClient } from '@prisma/client';

import {
  normalizeRouteScopeConfig,
  validateRouteScopeConfigPayload,
  type RouteScopeConfigDto
} from '../route-ops/route-scope-config.js';

export type AdminStoreSettings = {
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: string;
  routeScopeConfig: RouteScopeConfigDto;
  shopDomain: string;
};

export type SaveAdminStoreSettingsInput = {
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: string;
  routeScopeConfig?: RouteScopeConfigDto;
  shopDomain: string;
};

type AdminStoreSettingsPrismaClient = Pick<PrismaClient, 'shop'>;

export class PrismaAdminStoreSettingsService {
  constructor(private readonly prisma: AdminStoreSettingsPrismaClient) {}

  async getSettings(input: { shopDomain: string }): Promise<AdminStoreSettings | null> {
    const shop = await this.prisma.shop.findUnique({
      select: {
        defaultDepotAddress: true,
        defaultDepotLatitude: true,
        defaultDepotLongitude: true,
        locale: true,
        routeScopeConfig: true,
        shopDomain: true
      },
      where: { shopDomain: input.shopDomain }
    });
    return shop === null ? null : toAdminStoreSettings(shop);
  }

  async saveSettings(input: SaveAdminStoreSettingsInput): Promise<AdminStoreSettings> {
    const routeScopeConfig =
      input.routeScopeConfig === undefined
        ? undefined
        : validateRouteScopeConfigPayload(input.routeScopeConfig);
    const shop = await this.prisma.shop.upsert({
      create: {
        defaultDepotAddress: input.defaultDepotAddress,
        defaultDepotLatitude: input.defaultDepotLatitude,
        defaultDepotLongitude: input.defaultDepotLongitude,
        locale: input.locale,
        ...(routeScopeConfig === undefined ? {} : { routeScopeConfig }),
        shopDomain: input.shopDomain
      },
      select: {
        defaultDepotAddress: true,
        defaultDepotLatitude: true,
        defaultDepotLongitude: true,
        locale: true,
        routeScopeConfig: true,
        shopDomain: true
      },
      update: {
        defaultDepotAddress: input.defaultDepotAddress,
        defaultDepotLatitude: input.defaultDepotLatitude,
        defaultDepotLongitude: input.defaultDepotLongitude,
        locale: input.locale,
        ...(routeScopeConfig === undefined ? {} : { routeScopeConfig })
      },
      where: { shopDomain: input.shopDomain }
    });
    return toAdminStoreSettings(shop);
  }
}

function toAdminStoreSettings(input: {
  defaultDepotAddress: unknown;
  defaultDepotLatitude: unknown;
  defaultDepotLongitude: unknown;
  locale: string | null;
  routeScopeConfig: unknown;
  shopDomain: string;
}): AdminStoreSettings {
  return {
    defaultDepotAddress: typeof input.defaultDepotAddress === 'string' ? input.defaultDepotAddress : null,
    defaultDepotLatitude: decimalToNumber(input.defaultDepotLatitude),
    defaultDepotLongitude: decimalToNumber(input.defaultDepotLongitude),
    locale: input.locale ?? 'en-CA',
    routeScopeConfig: normalizeRouteScopeConfig(input.routeScopeConfig),
    shopDomain: input.shopDomain
  };
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const decimalLike = value as { toNumber?: () => unknown };
    if (typeof decimalLike.toNumber !== 'function') return null;
    const numeric = decimalLike.toNumber();
    return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
