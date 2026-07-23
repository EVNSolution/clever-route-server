import type { Prisma, DeliveryCustomerProfile, DestinationTip, PrismaClient } from '@prisma/client';

import { PrismaDeliveryCustomerProfileService } from '../delivery-customer/delivery-customer-profile.service.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export const destinationTipCategories = ['access', 'parking', 'handoff', 'proof', 'temperature', 'safety', 'other'] as const;
export const destinationTipSeverities = ['info', 'warning'] as const;
export const destinationTipStatuses = ['active', 'archived'] as const;

export type DestinationTipCategory = typeof destinationTipCategories[number];
export type DestinationTipSeverity = typeof destinationTipSeverities[number];
export type DestinationTipStatus = typeof destinationTipStatuses[number];

export type DestinationTipView = {
  body: string;
  category: DestinationTipCategory;
  createdAt: string;
  destinationId: string;
  revision: number;
  severity: DestinationTipSeverity;
  source: {
    deliveryStopId: string | null;
    kind: 'delivery_record' | 'manual';
    recordedAt: string | null;
  };
  status: DestinationTipStatus;
  tipId: string;
  title: string;
  updatedAt: string;
};

export type DeliveryStopContext = {
  deliveryStopId: string;
  destination: {
    address: string;
    destinationId: string;
    name: string;
  };
  items: Array<{
    name: string;
    orderItemId: string;
    quantity: number;
    sku: string | null;
    temperatureBand: null;
  }>;
  tips: DestinationTipView[];
};

export type DsvControlRepository = {
  createDestinationTip(input: {
    actor: string;
    body: string;
    category: DestinationTipCategory;
    destinationId: string;
    severity: DestinationTipSeverity;
    shopDomain: string;
    sourceDeliveryStopId: string | null;
    title: string;
  }): Promise<DestinationTipView | null>;
  getDeliveryStopContext(input: { deliveryStopId: string; shopDomain: string }): Promise<DeliveryStopContext | null>;
  hasShop(shopDomain: string): Promise<boolean>;
  listDestinationTips(input: {
    destinationId: string;
    shopDomain: string;
    status: DestinationTipStatus;
  }): Promise<DestinationTipView[] | null>;
  updateDestinationTip(input: {
    actor: string;
    body?: string;
    category?: DestinationTipCategory;
    destinationId: string;
    revision: number;
    severity?: DestinationTipSeverity;
    shopDomain: string;
    status?: DestinationTipStatus;
    tipId: string;
    title?: string;
  }): Promise<DestinationTipView | null>;
  resolveShopId(shopDomain: string): Promise<string | null>;
};

export class DestinationTipConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('Destination tip was changed by another operator');
    this.name = 'DestinationTipConflictError';
  }
}

export class DestinationTipSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationTipSourceError';
  }
}

export class PrismaDsvControlRepository implements DsvControlRepository {
  private readonly customerProfiles: PrismaDeliveryCustomerProfileService;

  constructor(private readonly prisma: PrismaClient) {
    this.customerProfiles = new PrismaDeliveryCustomerProfileService(prisma);
  }

  async hasShop(shopDomain: string): Promise<boolean> {
    return (await this.resolveShopId(shopDomain)) !== null;
  }

  async resolveShopId(shopDomain: string): Promise<string | null> {
    return (await this.findShop(shopDomain))?.id ?? null;
  }

  async getDeliveryStopContext(input: {
    deliveryStopId: string;
    shopDomain: string;
  }): Promise<DeliveryStopContext | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const stop = await this.prisma.deliveryStop.findFirst({
      select: {
        address1: true,
        address2: true,
        city: true,
        countryCode: true,
        id: true,
        order: {
          select: {
            id: true,
            orderItems: {
              orderBy: { lineIndex: 'asc' },
              select: { id: true, name: true, quantity: true, sku: true },
            },
          },
        },
        postalCode: true,
        province: true,
        recipientName: true,
      },
      where: { id: input.deliveryStopId, shopId: shop.id },
    });
    if (stop === null) return null;

    const customerContext = await this.customerProfiles.getOrderCustomerNoteContext({
      orderId: stop.order.id,
      shopDomain: input.shopDomain,
    });
    const destinationId = customerContext?.deliveryCustomer?.profileId;
    if (destinationId === undefined) return null;
    const destination = await this.prisma.deliveryCustomerProfile.findFirst({
      where: { id: destinationId, shopId: shop.id },
    });
    if (destination === null) return null;
    const tips = await this.findTips({ destinationId, shopId: shop.id, status: 'active' });

    return {
      deliveryStopId: stop.id,
      destination: {
        address: formatStopAddress(stop),
        destinationId,
        name: destination.canonicalName ?? stop.recipientName ?? formatStopAddress(stop),
      },
      items: stop.order.orderItems.map((item) => ({
        name: item.name,
        orderItemId: item.id,
        quantity: item.quantity,
        sku: item.sku,
        temperatureBand: null,
      })),
      tips: tips.map(toTipView),
    };
  }

  async listDestinationTips(input: {
    destinationId: string;
    shopDomain: string;
    status: DestinationTipStatus;
  }): Promise<DestinationTipView[] | null> {
    const scope = await this.resolveDestination(input.destinationId, input.shopDomain);
    if (scope === null) return null;
    return (await this.findTips({ destinationId: scope.destination.id, shopId: scope.shopId, status: input.status }))
      .map(toTipView);
  }

  async createDestinationTip(input: {
    actor: string;
    body: string;
    category: DestinationTipCategory;
    destinationId: string;
    severity: DestinationTipSeverity;
    shopDomain: string;
    sourceDeliveryStopId: string | null;
    title: string;
  }): Promise<DestinationTipView | null> {
    const scope = await this.resolveDestination(input.destinationId, input.shopDomain);
    if (scope === null) return null;
    if (input.sourceDeliveryStopId !== null) {
      await this.assertCompletedSource({
        destinationId: scope.destination.id,
        shopDomain: input.shopDomain,
        shopId: scope.shopId,
        sourceDeliveryStopId: input.sourceDeliveryStopId,
      });
    }

    const tip = await this.prisma.$transaction(async (tx) => {
      const created = await tx.destinationTip.create({
        data: {
          body: input.body,
          category: input.category,
          createdBy: input.actor,
          destinationId: scope.destination.id,
          severity: input.severity,
          shopId: scope.shopId,
          sourceDeliveryStopId: input.sourceDeliveryStopId,
          title: input.title,
          updatedBy: input.actor,
        },
      });
      await tx.destinationTipAudit.create({
        data: {
          action: 'created',
          actor: input.actor,
          revision: created.revision,
          shopId: scope.shopId,
          snapshot: tipSnapshot(created),
          tipId: created.id,
        },
      });
      return created;
    });
    return toTipView({ ...tip, sourceDeliveryStop: null });
  }

  async updateDestinationTip(input: {
    actor: string;
    body?: string;
    category?: DestinationTipCategory;
    destinationId: string;
    revision: number;
    severity?: DestinationTipSeverity;
    shopDomain: string;
    status?: DestinationTipStatus;
    tipId: string;
    title?: string;
  }): Promise<DestinationTipView | null> {
    const scope = await this.resolveDestination(input.destinationId, input.shopDomain);
    if (scope === null) return null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.destinationTip.updateMany({
        data: {
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.status === undefined ? {} : {
            archivedAt: input.status === 'archived' ? new Date() : null,
            status: input.status,
          }),
          ...(input.title === undefined ? {} : { title: input.title }),
          revision: { increment: 1 },
          updatedBy: input.actor,
        },
        where: {
          destinationId: scope.destination.id,
          id: input.tipId,
          revision: input.revision,
          shopId: scope.shopId,
        },
      });
      if (result.count === 0) {
        const current = await tx.destinationTip.findFirst({
          select: { revision: true },
          where: { destinationId: scope.destination.id, id: input.tipId, shopId: scope.shopId },
        });
        if (current === null) return null;
        throw new DestinationTipConflictError(current.revision);
      }
      const next = await tx.destinationTip.findUniqueOrThrow({ where: { id: input.tipId } });
      await tx.destinationTipAudit.create({
        data: {
          action: next.status === 'archived' ? 'archived' : 'updated',
          actor: input.actor,
          revision: next.revision,
          shopId: scope.shopId,
          snapshot: tipSnapshot(next),
          tipId: next.id,
        },
      });
      return next;
    });
    if (updated === null) return null;
    const [tip] = await this.findTips({
      destinationId: scope.destination.id,
      shopId: scope.shopId,
      status: updated.status as DestinationTipStatus,
      tipId: updated.id,
    });
    return tip === undefined ? null : toTipView(tip);
  }

  private async assertCompletedSource(input: {
    destinationId: string;
    shopDomain: string;
    shopId: string;
    sourceDeliveryStopId: string;
  }): Promise<void> {
    const stop = await this.prisma.deliveryStop.findFirst({
      select: { orderId: true, status: true },
      where: { id: input.sourceDeliveryStopId, shopId: input.shopId },
    });
    if (stop === null || stop.status !== 'DELIVERED') {
      throw new DestinationTipSourceError('Source delivery stop must be delivered');
    }
    const context = await this.customerProfiles.getOrderCustomerNoteContext({
      orderId: stop.orderId,
      shopDomain: input.shopDomain,
    });
    if (context?.deliveryCustomer?.profileId !== input.destinationId) {
      throw new DestinationTipSourceError('Source delivery stop belongs to another destination');
    }
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain }),
    });
  }

  private async resolveDestination(destinationId: string, shopDomain: string): Promise<{
    destination: DeliveryCustomerProfile;
    shopId: string;
  } | null> {
    const shop = await this.findShop(shopDomain);
    if (shop === null) return null;
    const initialDestination = await this.prisma.deliveryCustomerProfile.findFirst({
      where: { id: destinationId, shopId: shop.id },
    });
    if (initialDestination === null) return null;
    let destination: DeliveryCustomerProfile = initialDestination;
    const visited = new Set<string>();
    while (destination.mergedIntoProfileId !== null && !visited.has(destination.id)) {
      visited.add(destination.id);
      const next: DeliveryCustomerProfile | null = await this.prisma.deliveryCustomerProfile.findFirst({
        where: { id: destination.mergedIntoProfileId, shopId: shop.id },
      });
      if (next === null) break;
      destination = next;
    }
    return { destination, shopId: shop.id };
  }

  private findTips(input: {
    destinationId: string;
    shopId: string;
    status: DestinationTipStatus;
    tipId?: string;
  }) {
    return this.prisma.destinationTip.findMany({
      include: {
        sourceDeliveryStop: {
          select: {
            driverEvents: {
              orderBy: { occurredAt: 'desc' },
              select: { occurredAt: true },
              take: 1,
              where: { eventType: 'STOP_DELIVERED' },
            },
            updatedAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      where: {
        destinationId: input.destinationId,
        shopId: input.shopId,
        status: input.status,
        ...(input.tipId === undefined ? {} : { id: input.tipId }),
      },
    });
  }
}

type TipWithSource = DestinationTip & {
  sourceDeliveryStop: {
    driverEvents: Array<{ occurredAt: Date }>;
    updatedAt: Date;
  } | null;
};

function toTipView(tip: TipWithSource): DestinationTipView {
  const sourceRecordedAt = tip.sourceDeliveryStop?.driverEvents[0]?.occurredAt ?? tip.sourceDeliveryStop?.updatedAt ?? null;
  return {
    body: tip.body,
    category: tip.category as DestinationTipCategory,
    createdAt: tip.createdAt.toISOString(),
    destinationId: tip.destinationId,
    revision: tip.revision,
    severity: tip.severity as DestinationTipSeverity,
    source: {
      deliveryStopId: tip.sourceDeliveryStopId,
      kind: tip.sourceDeliveryStopId === null ? 'manual' : 'delivery_record',
      recordedAt: sourceRecordedAt?.toISOString() ?? null,
    },
    status: tip.status as DestinationTipStatus,
    tipId: tip.id,
    title: tip.title,
    updatedAt: tip.updatedAt.toISOString(),
  };
}

function tipSnapshot(tip: DestinationTip): Prisma.InputJsonValue {
  return {
    body: tip.body,
    category: tip.category,
    destinationId: tip.destinationId,
    severity: tip.severity,
    sourceDeliveryStopId: tip.sourceDeliveryStopId,
    status: tip.status,
    title: tip.title,
  };
}

function formatStopAddress(stop: {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
}): string {
  return [stop.address1, stop.address2, stop.city, stop.province, stop.postalCode, stop.countryCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
}
