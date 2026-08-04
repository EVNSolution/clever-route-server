import type { PrismaClient } from '@prisma/client';

export type UvisPollKind = 'location' | 'temperature';

export type UvisDeviceMapping = {
  deviceId: string;
  serialNumber: string;
  vehicleId: string;
  vehiclePlate: string | null;
};

export type UvisPollLease = {
  lastLocationStartedAt: Date | null;
  lastTemperatureStartedAt: Date | null;
  shopId: string;
};

type UvisPollPrisma = Pick<PrismaClient, '$transaction' | 'shop' | 'uvisTelemetryPollState'>;

export class PrismaUvisPollRepository {
  constructor(private readonly prisma: UvisPollPrisma) {}

  async findShopAndDevices(input: { appId: string; shopDomain: string }): Promise<{
    devices: UvisDeviceMapping[];
    shopId: string;
  } | null> {
    const shop = await this.prisma.shop.findUnique({
      select: {
        dsvVehicleTelematicsDevices: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            serialNumber: true,
            vehicleId: true,
            vehicle: { select: { licensePlate: true } },
          },
        },
        id: true,
      },
      where: {
        appId_shopDomain: {
          appId: input.appId,
          shopDomain: input.shopDomain,
        },
      },
    });
    if (shop === null) return null;
    return {
      devices: shop.dsvVehicleTelematicsDevices.map((device) => ({
        deviceId: device.id,
        serialNumber: device.serialNumber,
        vehicleId: device.vehicleId,
        vehiclePlate: device.vehicle.licensePlate,
      })),
      shopId: shop.id,
    };
  }

  async claimLease(input: {
    leaseDurationMs: number;
    leaseToken: string;
    now: Date;
    shopId: string;
  }): Promise<UvisPollLease | null> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.uvisTelemetryPollState.upsert({
        create: { shopId: input.shopId },
        update: {},
        where: { shopId: input.shopId },
      });
      const claimed = await transaction.uvisTelemetryPollState.updateMany({
        data: {
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseDurationMs),
          leaseToken: input.leaseToken,
        },
        where: {
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: input.now } },
            { leaseToken: input.leaseToken },
          ],
          shopId: input.shopId,
        },
      });
      if (claimed.count === 0) return null;
      return transaction.uvisTelemetryPollState.findUniqueOrThrow({
        select: {
          lastLocationStartedAt: true,
          lastTemperatureStartedAt: true,
          shopId: true,
        },
        where: { shopId: input.shopId },
      });
    });
  }

  async markStarted(input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }): Promise<boolean> {
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: input.kind === 'location'
        ? { lastLocationStartedAt: input.now }
        : { lastTemperatureStartedAt: input.now },
      where: { leaseToken: input.leaseToken, shopId: input.shopId },
    });
    return updated.count > 0;
  }

  async markSucceeded(input: { kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }): Promise<boolean> {
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: input.kind === 'location'
        ? { lastLocationErrorCode: null, lastLocationSucceededAt: input.now }
        : { lastTemperatureErrorCode: null, lastTemperatureSucceededAt: input.now },
      where: { leaseToken: input.leaseToken, shopId: input.shopId },
    });
    return updated.count > 0;
  }

  async markFailed(input: { errorCode: string; kind: UvisPollKind; leaseToken: string; now: Date; shopId: string }): Promise<boolean> {
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: input.kind === 'location'
        ? { lastLocationErrorCode: input.errorCode, lastLocationFailedAt: input.now }
        : { lastTemperatureErrorCode: input.errorCode, lastTemperatureFailedAt: input.now },
      where: { leaseToken: input.leaseToken, shopId: input.shopId },
    });
    return updated.count > 0;
  }

  async releaseLease(input: { leaseToken: string; shopId: string }): Promise<void> {
    await this.prisma.uvisTelemetryPollState.updateMany({
      data: { leaseExpiresAt: null, leaseToken: null },
      where: { leaseToken: input.leaseToken, shopId: input.shopId },
    });
  }
}
