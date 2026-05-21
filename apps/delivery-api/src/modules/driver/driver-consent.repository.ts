import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import type {
  RecordDriverConsentsInput,
  RecordDriverConsentsResult
} from './driver-consent.types.js';

type DriverConsentPrismaClient = Pick<PrismaClient, 'driver' | 'driverConsentRecord' | 'shop'>;

export class PrismaDriverConsentRepository {
  constructor(private readonly prisma: DriverConsentPrismaClient) {}

  async recordDriverConsents(input: RecordDriverConsentsInput): Promise<RecordDriverConsentsResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new Error(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: input.driverId } });
    if (driver === null || driver.shopId !== shop.id) {
      throw new Error(`Driver not found for shop: ${input.driverId}`);
    }

    const appContext = jsonOrNull(input.appContext);
    const deviceContext = jsonOrNull(input.deviceContext);

    const records = await Promise.all(
      input.consents.map(async (consent) => {
        const record = await this.prisma.driverConsentRecord.upsert({
          create: {
            accepted: consent.accepted,
            appContext,
            consentType: consent.type,
            consentVersion: consent.version,
            deviceContext,
            driverId: input.driverId,
            recordedAt: input.recordedAt,
            routeContext: input.routeContext,
            shopId: shop.id
          },
          update: {
            accepted: consent.accepted,
            appContext,
            deviceContext,
            recordedAt: input.recordedAt,
            routeContext: input.routeContext,
            shopId: shop.id
          },
          where: {
            driverId_consentType_consentVersion: {
              consentType: consent.type,
              consentVersion: consent.version,
              driverId: input.driverId
            }
          }
        });

        return {
          accepted: record.accepted,
          type: record.consentType,
          version: record.consentVersion
        };
      })
    );

    return {
      status: 'CONSENT_RECORDED',
      recordedAt: input.recordedAt.toISOString(),
      records
    };
  }
}

function jsonOrNull(value: Record<string, unknown> | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) {
    return Prisma.JsonNull;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
