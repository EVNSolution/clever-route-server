import type { Prisma, PrismaClient } from '@prisma/client';

import type { GeocodingCacheRepository } from './geocoding.service.js';
import type { GeocodingResult } from './geocoding.types.js';

type GeocodingCachePrismaClient = Pick<PrismaClient, 'geocodingCache'>;

export class PrismaGeocodingCacheRepository implements GeocodingCacheRepository {
  constructor(private readonly prisma: GeocodingCachePrismaClient) {}

  async findFresh(input: {
    cacheKey: string;
    now: Date;
    shopDomain: string;
  }): Promise<{
    cachedAt: number;
    expiresAt: number;
    result: GeocodingResult;
  } | null> {
    const row = await this.prisma.geocodingCache.findUnique({
      where: {
        shopDomain_cacheKey: {
          cacheKey: input.cacheKey,
          shopDomain: input.shopDomain,
        },
      },
    });
    if (row === null || row.expiresAt <= input.now) return null;
    const result = readCachedGeocodingResult(row.result);
    if (result === null) return null;
    return {
      cachedAt: row.cachedAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      result,
    };
  }

  async upsert(input: {
    cacheKey: string;
    cachedAt: Date;
    expiresAt: Date;
    result: GeocodingResult;
    shopDomain: string;
  }): Promise<void> {
    await this.prisma.geocodingCache.upsert({
      create: {
        cacheKey: input.cacheKey,
        cachedAt: input.cachedAt,
        expiresAt: input.expiresAt,
        result: input.result,
        shopDomain: input.shopDomain,
      },
      update: {
        cachedAt: input.cachedAt,
        expiresAt: input.expiresAt,
        result: input.result,
      },
      where: {
        shopDomain_cacheKey: {
          cacheKey: input.cacheKey,
          shopDomain: input.shopDomain,
        },
      },
    });
  }
}

function readCachedGeocodingResult(value: Prisma.JsonValue): GeocodingResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.ok === true && value.cached === false && typeof value.result === 'object') {
    return value as unknown as GeocodingResult;
  }
  if (value.ok === false && typeof value.code === 'string' && typeof value.message === 'string') {
    return value as unknown as GeocodingResult;
  }
  return null;
}
