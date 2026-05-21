import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export type RecordDriverEventInput = {
  clientEventId: string | null;
  deliveryStopId: string | null;
  driverId: string;
  eventType: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  payload: unknown;
  routePlanId: string | null;
  shopDomain: string;
};

export type RecordDriverEventResult = {
  duplicate: boolean;
  eventId: string;
};

type DriverEventPrismaClient = Pick<PrismaClient, 'driver' | 'driverEvent' | 'shop'>;

export class PrismaDriverEventRepository {
  constructor(private readonly prisma: DriverEventPrismaClient) {}

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new Error(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: input.driverId } });
    if (driver === null || driver.shopId !== shop.id) {
      throw new Error(`Driver not found for shop: ${input.driverId}`);
    }

    try {
      const event = await this.prisma.driverEvent.create({
        data: {
          clientEventId: input.clientEventId,
          deliveryStopId: input.deliveryStopId,
          driverId: input.driverId,
          eventType: input.eventType as never,
          latitude: input.latitude,
          longitude: input.longitude,
          occurredAt: input.occurredAt,
          payload: JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue,
          routePlanId: input.routePlanId,
          shopId: shop.id
        }
      });

      return { duplicate: false, eventId: event.id };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { duplicate: true, eventId: input.clientEventId ?? 'duplicate' };
      }

      throw error;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
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
