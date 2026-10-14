import type { Prisma } from '@prisma/client';

import { computeCurrentProgressSequence, resolveCustomerEmailTimezone } from '../customer-email/customer-email.service.js';
import {
  customerEmailEtaWindowRange,
  defaultCustomerEmailSettings,
  normalizeCustomerEmailSettings,
  type CustomerEmailSettings,
} from '../customer-email/customer-email-settings.js';
import { normalizeRouteOpsUiSettings } from '../route-ops/route-ops-ui-settings.js';

export type CustomerTrackingStage = 'CANCELLED' | 'DELIVERED' | 'MISSED' | 'ON_THE_WAY' | 'PREPARING';

export type CustomerTrackingStatus = {
  address: string;
  destination: { latitude: number; longitude: number } | null;
  // Shown only while the driver is within the shop's nearby-stops threshold of this stop.
  driver: { latitude: number; longitude: number; updatedAt: string } | null;
  etaWindow: { end: string; start: string } | null;
  items: Array<{ name: string; quantity: number }>;
  orderName: string;
  recipientName: string;
  stage: CustomerTrackingStage;
  stopsAway: number | null;
  storeName: string;
  timezone: string | null;
};

type CustomerTrackingPrismaClient = {
  deliveryStop: Pick<Prisma.TransactionClient['deliveryStop'], 'findUnique'>;
  driverEvent: Pick<Prisma.TransactionClient['driverEvent'], 'findFirst'>;
};

const LINK_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const DRIVER_LOCATION_MAX_AGE_MS = 10 * 60 * 1000;

export class CustomerTrackingService {
  constructor(private readonly prisma: CustomerTrackingPrismaClient) {}

  async getStatus(deliveryStopId: string, now: Date = new Date()): Promise<CustomerTrackingStatus | null> {
    const stop = await this.prisma.deliveryStop.findUnique({
      select: {
        address1: true,
        address2: true,
        city: true,
        deliveryDate: true,
        latitude: true,
        longitude: true,
        order: {
          select: {
            name: true,
            orderItems: { orderBy: { lineIndex: 'asc' }, select: { name: true, quantity: true } },
          },
        },
        postalCode: true,
        province: true,
        recipientName: true,
        routePlanStops: {
          orderBy: [{ routePlan: { planDate: 'desc' } }, { createdAt: 'desc' }],
          select: {
            estimatedArrivalAt: true,
            routePlan: {
              select: {
                constraints: true,
                id: true,
                planDate: true,
                routeStops: { select: { deliveryStop: { select: { status: true } }, sequence: true } },
                status: true,
              },
            },
            sequence: true,
          },
          take: 1,
          where: { routePlan: { status: { not: 'CANCELLED' } } },
        },
        shop: {
          select: {
            commerceConnections: { select: { timezone: true } },
            customerEmailSettings: true,
            routeOpsUiSettings: true,
          },
        },
        shopId: true,
        status: true,
      },
      where: { id: deliveryStopId },
    });
    if (stop === null) return null;

    const routeStop = stop.routePlanStops[0] ?? null;
    const routePlan = routeStop?.routePlan ?? null;
    const serviceDate = routePlan?.planDate ?? stop.deliveryDate;
    if (serviceDate !== null && now.getTime() > serviceDate.getTime() + LINK_LIFETIME_MS) return null;

    const settings = readSettings(stop.shop.customerEmailSettings);
    const stage = trackingStage(stop.status, routePlan?.status ?? null);
    const timezone = routePlan === null ? null : resolveCustomerEmailTimezone({ constraints: routePlan.constraints, shop: stop.shop });
    const eta = routeStop?.estimatedArrivalAt ?? null;
    const etaRange = eta === null || stage === 'DELIVERED' || stage === 'MISSED' || stage === 'CANCELLED'
      ? null
      : customerEmailEtaWindowRange(eta, settings.etaWindow);
    const stopsAway = stage === 'ON_THE_WAY' && routeStop !== null && routePlan !== null
      ? Math.max(0, routeStop.sequence - computeCurrentProgressSequence(routePlan.routeStops))
      : null;
    const showDriver = stopsAway !== null
      && stopsAway <= normalizeRouteOpsUiSettings(stop.shop.routeOpsUiSettings).nearbyStopsThreshold;

    return {
      address: [stop.address1, stop.address2, stop.city, stop.province, stop.postalCode]
        .map((part) => part?.trim() ?? '')
        .filter((part) => part !== '')
        .join(', '),
      destination: stop.latitude === null || stop.longitude === null
        ? null
        : { latitude: Number(stop.latitude), longitude: Number(stop.longitude) },
      driver: showDriver && routePlan !== null ? await this.readDriverLocation(stop.shopId, routePlan.id, now) : null,
      etaWindow: etaRange === null ? null : { end: etaRange.end.toISOString(), start: etaRange.start.toISOString() },
      items: stop.order.orderItems.map((item) => ({ name: item.name, quantity: item.quantity })),
      orderName: stop.order.name,
      recipientName: stop.recipientName?.trim() ?? '',
      stage,
      stopsAway,
      storeName: settings.branding.businessName !== '' ? settings.branding.businessName : settings.senderName,
      timezone,
    };
  }

  private async readDriverLocation(
    shopId: string,
    routePlanId: string,
    now: Date,
  ): Promise<CustomerTrackingStatus['driver']> {
    const event = await this.prisma.driverEvent.findFirst({
      orderBy: { occurredAt: 'desc' },
      select: { latitude: true, longitude: true, occurredAt: true },
      where: {
        latitude: { not: null },
        longitude: { not: null },
        occurredAt: { gte: new Date(now.getTime() - DRIVER_LOCATION_MAX_AGE_MS) },
        routePlanId,
        shopId,
      },
    });
    if (event?.latitude == null || event.longitude == null) return null;
    return {
      latitude: Number(event.latitude),
      longitude: Number(event.longitude),
      updatedAt: event.occurredAt.toISOString(),
    };
  }
}

function trackingStage(stopStatus: string, routeStatus: string | null): CustomerTrackingStage {
  if (stopStatus === 'DELIVERED') return 'DELIVERED';
  if (stopStatus === 'FAILED' || stopStatus === 'SKIPPED') return 'MISSED';
  if (stopStatus === 'CANCELLED') return 'CANCELLED';
  if (stopStatus === 'EN_ROUTE' || stopStatus === 'ARRIVED' || routeStatus === 'IN_PROGRESS') return 'ON_THE_WAY';
  return 'PREPARING';
}

function readSettings(value: unknown): CustomerEmailSettings {
  try {
    return normalizeCustomerEmailSettings(value);
  } catch {
    return defaultCustomerEmailSettings();
  }
}
