import type { PrismaClient } from '@prisma/client';

import { normalizeRouteOpsUiSettings } from '../route-ops/route-ops-ui-settings.js';

export type UvisTelemetryActivity = 'ACTIVE' | 'DORMANT';
export type UvisPollKind = 'location' | 'temperature';

export type UvisDeviceMapping = {
  deviceId: string;
  serialNumber: string;
  vehicleId: string;
  vehiclePlate: string | null;
};

export type UvisPollLease = {
  activeProtectionEndedAt: Date | null;
  activity: UvisTelemetryActivity;
  lastLocationStartedAt: Date | null;
  lastTemperatureStartedAt: Date | null;
  shopId: string;
};

export type UvisPollTarget = {
  activeProtectionStartsAt: Date;
  devices: UvisDeviceMapping[];
  latestFinalEstimatedArrivalAt: Date | null;
  loadingStartsAt: Date;
  loadingStartTime: string;
  shopId: string;
};

type UvisPollPrisma = Pick<PrismaClient, '$transaction' | 'routePlan' | 'shop' | 'uvisTelemetryPollState'>;

export class PrismaUvisPollRepository {
  constructor(private readonly prisma: UvisPollPrisma) {}

  async findShopAndDevices(input: { appId: string; now: Date; shopDomain: string }): Promise<UvisPollTarget | null> {
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
        routeOpsUiSettings: true,
      },
      where: {
        appId_shopDomain: {
          appId: input.appId,
          shopDomain: input.shopDomain,
        },
      },
    });
    if (shop === null) return null;
    const devices = shop.dsvVehicleTelematicsDevices.map((device) => ({
      deviceId: device.id,
      serialNumber: device.serialNumber,
      vehicleId: device.vehicleId,
      vehiclePlate: device.vehicle.licensePlate,
    }));
    const loadingStartTime = normalizeRouteOpsUiSettings(shop.routeOpsUiSettings).loadingStartTime;
    const serviceDate = serviceDateForLoadingCycle(input.now, loadingStartTime);
    const loadingStartsAt = loadingStartUtc(serviceDate, loadingStartTime);
    return {
      activeProtectionStartsAt: new Date(loadingStartsAt.getTime() - 60 * 60 * 1000),
      devices,
      latestFinalEstimatedArrivalAt: await this.findLatestFinalEstimatedArrivalAt({
        serviceDate,
        shopId: shop.id,
        vehicleIds: devices.map((device) => device.vehicleId),
      }),
      loadingStartsAt,
      loadingStartTime,
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
          activeProtectionEndedAt: true,
          activity: true,
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

  async forceActiveForPreparationWindow(input: { leaseToken: string; shopId: string }): Promise<boolean> {
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: {
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
      },
      where: { leaseToken: input.leaseToken, shopId: input.shopId },
    });
    return updated.count > 0;
  }

  async markActiveProtectionEnded(input: { leaseToken: string; protectionEndedAt: Date; shopId: string }): Promise<boolean> {
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: {
        activeProtectionEndedAt: input.protectionEndedAt,
        activity: 'ACTIVE',
        allVehiclesStoppedSince: null,
      },
      where: {
        leaseToken: input.leaseToken,
        shopId: input.shopId,
        OR: [
          { activeProtectionEndedAt: null },
          { activeProtectionEndedAt: { not: input.protectionEndedAt } },
        ],
      },
    });
    if (updated.count > 0) return true;
    const current = await this.prisma.uvisTelemetryPollState.findUnique({
      select: { activeProtectionEndedAt: true, leaseToken: true },
      where: { shopId: input.shopId },
    });
    return current?.leaseToken === input.leaseToken
      && current.activeProtectionEndedAt?.getTime() === input.protectionEndedAt.getTime();
  }

  async recordLocationActivitySignal(input: {
    allConfiguredVehiclesStopped: boolean;
    gracePeriodMs: number;
    hasMappedSignal: boolean;
    leaseToken: string;
    now: Date;
    shopId: string;
  }): Promise<boolean> {
    const current = await this.prisma.uvisTelemetryPollState.findUnique({
      select: {
        allVehiclesStoppedSince: true,
        leaseToken: true,
      },
      where: { shopId: input.shopId },
    });
    if (current === null || current.leaseToken !== input.leaseToken) return false;

    const allVehiclesStoppedSince = input.allConfiguredVehiclesStopped
      ? current.allVehiclesStoppedSince ?? input.now
      : null;
    const activity: UvisTelemetryActivity = allVehiclesStoppedSince !== null
      && input.now.getTime() - allVehiclesStoppedSince.getTime() >= input.gracePeriodMs
      ? 'DORMANT'
      : 'ACTIVE';
    const updated = await this.prisma.uvisTelemetryPollState.updateMany({
      data: {
        activity,
        allVehiclesStoppedSince,
        ...(input.hasMappedSignal ? { lastActivitySignalAt: input.now } : {}),
      },
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

  private async findLatestFinalEstimatedArrivalAt(input: {
    serviceDate: string;
    shopId: string;
    vehicleIds: string[];
  }): Promise<Date | null> {
    const uniqueVehicleIds = [...new Set(input.vehicleIds)];
    if (uniqueVehicleIds.length === 0) return null;
    const routePlans = await this.prisma.routePlan.findMany({
      select: {
        routeStops: {
          orderBy: { sequence: 'desc' },
          select: { estimatedArrivalAt: true },
          take: 1,
        },
      },
      where: {
        planDate: serviceDateAsDbDate(input.serviceDate),
        routeGroupingChildVersions: {
          some: {
            groupingVersion: { status: 'CURRENT' },
            status: 'CURRENT',
            supersededAt: null,
          },
        },
        shopId: input.shopId,
        status: { not: 'CANCELLED' },
        vehicleId: { in: uniqueVehicleIds },
      },
    });
    return routePlans.reduce<Date | null>((latest, routePlan) => {
      const finalEta = routePlan.routeStops[0]?.estimatedArrivalAt ?? null;
      if (finalEta === null) return latest;
      return latest === null || finalEta.getTime() > latest.getTime() ? finalEta : latest;
    }, null);
  }
}

function serviceDateForLoadingCycle(now: Date, loadingStartTime: string): string {
  const loadingMinute = timeOfDayToMinute(loadingStartTime);
  const windowStartMinute = (loadingMinute + 24 * 60 - 60) % (24 * 60);
  const currentMinute = seoulMinuteOfDay(now);
  const date = seoulDateParts(now);
  if (windowStartMinute > loadingMinute && currentMinute >= windowStartMinute) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function serviceDateAsDbDate(serviceDate: string): Date {
  return new Date(`${serviceDate}T00:00:00.000Z`);
}

function loadingStartUtc(serviceDate: string, loadingStartTime: string): Date {
  const [hour, minute] = loadingStartTime.split(':').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(
    Number.parseInt(serviceDate.slice(0, 4), 10),
    Number.parseInt(serviceDate.slice(5, 7), 10) - 1,
    Number.parseInt(serviceDate.slice(8, 10), 10),
    (hour ?? 0) - 9,
    minute ?? 0,
  ));
}

function timeOfDayToMinute(value: string): number {
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  return ((hour ?? 0) * 60) + (minute ?? 0);
}

function seoulMinuteOfDay(value: Date): number {
  const parts = seoulDateTimeParts(value);
  return (parts.hour * 60) + parts.minute;
}

function seoulDateParts(value: Date): Date {
  const parts = seoulDateTimeParts(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function seoulDateTimeParts(value: Date): { day: number; hour: number; minute: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).formatToParts(value);
  const read = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return {
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    month: read('month'),
    year: read('year'),
  };
}
