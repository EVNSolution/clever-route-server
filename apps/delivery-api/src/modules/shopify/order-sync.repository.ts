import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  CanonicalOrderReadiness,
  CanonicalOrderRow,
  DeliveryServiceType,
  DeliveryWeekday,
  PlanningStatus,
  SyncedOrderWithDeliveryStopInput
} from './order-sync.mapper.js';

export type UpsertOrderWithDeliveryStopInput = {
  shopDomain: string;
  synced: SyncedOrderWithDeliveryStopInput;
};

export type UpsertOrderWithDeliveryStopResult = {
  orderId: string;
  status: 'created' | 'updated' | 'unchanged' | 'skipped';
  stopId: string | null;
};

export type ListCanonicalOrdersFilters = {
  deliveryBatchEndDate?: string;
  deliveryBatchStartDate?: string;
  deliveryDate?: string;
  deliverySession?: 'DAY' | 'EVENING' | 'PICKUP';
  deliveryWeekday?: DeliveryWeekday;
  geocodeStatus?: 'PENDING' | 'RESOLVED' | 'FAILED' | 'NOT_REQUIRED';
  planned?: boolean;
  planningGroupKey?: string;
  readiness?: CanonicalOrderReadiness;
  routeScopeKey?: string;
  search?: string;
  serviceType?: DeliveryServiceType;
};

export type ListCanonicalOrdersInput = {
  filters?: ListCanonicalOrdersFilters;
  shopDomain: string;
};

type OrderSyncPrismaClient = Pick<PrismaClient, 'deliveryStop' | 'order' | 'shop'>;

type ExistingOrder = {
  id: string;
  updatedAtShopify: Date | null;
};

type CanonicalOrderRecord = {
  cancelledAt: Date | null;
  currencyCode: string | null;
  deliveryStops: DeliveryStopRecord[];
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  id: string;
  name: string;
  phone: string | null;
  processedAt: Date | null;
  rawPayload: unknown;
  shippingAddress: unknown;
  shopifyOrderGid: string;
  shopifyOrderLegacyId: bigint | number | string | null;
  totalPriceAmount: unknown;
  updatedAtShopify: Date | null;
};

type DeliveryStopRecord = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  deliveryDate: Date | null;
  countryCode: string | null;
  geocodeStatus: string;
  id: string;
  latitude: unknown;
  longitude: unknown;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
  routePlanStops?: unknown[];
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
};

export class PrismaOrderSyncRepository {
  constructor(private readonly prisma: OrderSyncPrismaClient) {}

  async upsertOrderWithDeliveryStop(
    input: UpsertOrderWithDeliveryStopInput
  ): Promise<UpsertOrderWithDeliveryStopResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new Error(`Shop not installed: ${shopDomain}`);
    }

    const existing = await this.prisma.order.findFirst({
      select: { id: true, updatedAtShopify: true },
      where: {
        shopId: shop.id,
        shopifyOrderGid: input.synced.order.shopifyOrderGid
      }
    });

    if (existing !== null && isExistingNewerThanSnapshot(existing, input.synced.order.updatedAtShopify)) {
      return { orderId: existing.id, status: 'unchanged', stopId: null };
    }

    const orderWrite = toOrderWrite(input.synced.order);
    const order = await this.prisma.order.upsert({
      create: { ...orderWrite, shopId: shop.id },
      update: orderWrite,
      where: {
        shopId_shopifyOrderGid: {
          shopId: shop.id,
          shopifyOrderGid: input.synced.order.shopifyOrderGid
        }
      }
    });

    if (input.synced.deliveryStop === null) {
      await this.prisma.deliveryStop.updateMany({
        data: clearedDeliveryStopWrite(),
        where: { orderId: order.id, shopId: shop.id }
      });
      return { orderId: order.id, status: existing === null ? 'created' : 'updated', stopId: null };
    }

    const deliveryStopWrite = toDeliveryStopWrite(input.synced.deliveryStop);
    const stop = await this.prisma.deliveryStop.upsert({
      create: {
        ...deliveryStopWrite,
        orderId: order.id,
        shopId: shop.id
      },
      update: deliveryStopWrite,
      where: {
        shopId_orderId: {
          orderId: order.id,
          shopId: shop.id
        }
      }
    });

    return { orderId: order.id, status: existing === null ? 'created' : 'updated', stopId: stop.id };
  }

  async findCanonicalOrderById(input: {
    orderId: string;
    shopDomain: string;
  }): Promise<CanonicalOrderRow | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) {
      return null;
    }

    const order = await this.prisma.order.findFirst({
      include: canonicalOrderInclude(),
      where: { id: input.orderId, shopId: shop.id }
    });

    return order === null ? null : toCanonicalOrderRow(order);
  }

  async listCanonicalOrders(input: ListCanonicalOrdersInput): Promise<CanonicalOrderRow[]> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) {
      return [];
    }

    const orders = (await this.prisma.order.findMany({
      include: canonicalOrderInclude(),
      orderBy: { updatedAtShopify: 'desc' },
      where: toOrderWhere(shop.id, input.filters ?? {})
    })) as CanonicalOrderRecord[];

    return orders.map((order) => toCanonicalOrderRow(order)).filter((row) => matchesDerivedFilters(row, input.filters ?? {}));
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: normalizeShopDomain(shopDomain) }
    });
  }
}

function isExistingNewerThanSnapshot(existing: ExistingOrder, incomingUpdatedAt: Date): boolean {
  return existing.updatedAtShopify !== null && existing.updatedAtShopify.getTime() > incomingUpdatedAt.getTime();
}

function canonicalOrderInclude(): {
  deliveryStops: {
    include: {
      routePlanStops: true;
    };
    take: 1;
  };
} {
  return {
    deliveryStops: {
      include: { routePlanStops: true },
      take: 1
    }
  };
}

function toOrderWhere(shopId: string, filters: ListCanonicalOrdersFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { shopId };
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const search = filters.search.trim();
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } }
    ];
  }
  return where;
}

function clearedDeliveryStopWrite(): {
  address1: null;
  address2: null;
  city: null;
  countryCode: null;
  deliveryDate: null;
  geocodeStatus: 'PENDING';
  instructions: null;
  latitude: null;
  longitude: null;
  phone: null;
  postalCode: null;
  province: null;
  recipientName: null;
  timeWindowEnd: null;
  timeWindowStart: null;
} {
  return {
    address1: null,
    address2: null,
    city: null,
    countryCode: null,
    deliveryDate: null,
    geocodeStatus: 'PENDING',
    instructions: null,
    latitude: null,
    longitude: null,
    phone: null,
    postalCode: null,
    province: null,
    recipientName: null,
    timeWindowEnd: null,
    timeWindowStart: null
  };
}

function matchesDerivedFilters(row: CanonicalOrderRow, filters: ListCanonicalOrdersFilters): boolean {
  if (filters.readiness !== undefined && row.readiness !== filters.readiness) return false;
  if (filters.planned !== undefined && (row.planningStatus === 'PLANNED') !== filters.planned) return false;
  if (filters.deliveryWeekday !== undefined && row.deliveryWeekday !== filters.deliveryWeekday) return false;
  if (filters.serviceType !== undefined && row.serviceType !== filters.serviceType) return false;
  if (filters.geocodeStatus !== undefined && row.geocodeStatus !== filters.geocodeStatus) return false;
  if (filters.deliveryDate !== undefined && row.deliveryDate !== filters.deliveryDate) return false;
  if (filters.deliveryBatchStartDate !== undefined && row.deliveryBatchStartDate !== filters.deliveryBatchStartDate) return false;
  if (filters.deliveryBatchEndDate !== undefined && row.deliveryBatchEndDate !== filters.deliveryBatchEndDate) return false;
  if (filters.deliverySession !== undefined && row.deliverySession !== filters.deliverySession) return false;
  if (filters.routeScopeKey !== undefined && row.routeScopeKey !== filters.routeScopeKey) return false;
  if (filters.planningGroupKey !== undefined && row.planningGroupKey !== filters.planningGroupKey) return false;
  return true;
}


function toDeliveryStopWrite(input: SyncedOrderWithDeliveryStopInput['deliveryStop']): {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: Date | null;
  geocodeStatus: 'PENDING' | 'RESOLVED';
  instructions: string | null;
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
} {
  if (input === null) {
    throw new Error('delivery stop input required');
  }
  return {
    address1: input.address1,
    address2: input.address2,
    city: input.city,
    countryCode: input.countryCode,
    deliveryDate: parseDateOnly(input.deliveryDate),
    geocodeStatus: input.geocodeStatus,
    instructions: input.instructions,
    latitude: input.latitude,
    longitude: input.longitude,
    phone: input.phone,
    postalCode: input.postalCode,
    province: input.province,
    recipientName: input.recipientName,
    timeWindowEnd: parseTorontoTimeWindow(input.deliveryDate, input.timeWindowEnd),
    timeWindowStart: parseTorontoTimeWindow(input.deliveryDate, input.timeWindowStart)
  };
}

function toOrderWrite(input: SyncedOrderWithDeliveryStopInput['order']): {
  cancelledAt: Date | null;
  currencyCode: string | null;
  email: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  name: string;
  phone: string | null;
  processedAt: Date | null;
  rawPayload: Prisma.InputJsonValue;
  shippingAddress: Prisma.InputJsonValue;
  shopifyOrderGid: string;
  shopifyOrderLegacyId: bigint | null;
  totalPriceAmount: string | null;
  updatedAtShopify: Date;
} {
  return {
    cancelledAt: input.cancelledAt,
    currencyCode: input.currencyCode,
    email: input.email,
    financialStatus: input.financialStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    name: input.name,
    phone: input.phone,
    processedAt: input.processedAt,
    rawPayload: toJson(input.rawPayload),
    shippingAddress: toJson(readShippingAddressFromRawPayload(input.rawPayload)),
    shopifyOrderGid: input.shopifyOrderGid,
    shopifyOrderLegacyId: input.shopifyOrderLegacyId,
    totalPriceAmount: input.totalPriceAmount,
    updatedAtShopify: input.updatedAtShopify
  };
}

function readShippingAddressFromRawPayload(rawPayload: SyncedOrderWithDeliveryStopInput['order']['rawPayload']): {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
} {
  const shippingAddress = objectOrNull(rawPayload.shippingAddress);
  return {
    address1: readString(shippingAddress?.address1),
    address2: readString(shippingAddress?.address2),
    city: readString(shippingAddress?.city),
    countryCode: readString(shippingAddress?.countryCodeV2),
    postalCode: readString(shippingAddress?.zip),
    province: readString(shippingAddress?.province)
  };
}

function toCanonicalOrderRow(order: CanonicalOrderRecord): CanonicalOrderRow {
  const stop = order.deliveryStops[0] ?? null;
  const raw = objectOrNull(order.rawPayload);
  const shippingAddress = readShippingAddress(order.shippingAddress, stop);
  const latitude = decimalNumber(stop?.latitude);
  const longitude = decimalNumber(stop?.longitude);
  const hasCoordinates = latitude !== null && longitude !== null;
  const reviewReasons = readStringArray(raw?.reviewReasons) ?? [];
  const readiness = readReadiness(raw?.readiness, order.cancelledAt, reviewReasons);
  const planningStatus: PlanningStatus = (stop?.routePlanStops?.length ?? 0) > 0 ? 'PLANNED' : 'UNPLANNED';

  return {
    cancelledAt: formatDateTime(order.cancelledAt),
    currencyCode: order.currencyCode,
    deliveryArea: readString(raw?.deliveryArea),
    deliveryBatchEndDate: readString(raw?.deliveryBatchEndDate),
    deliveryBatchStartDate: readString(raw?.deliveryBatchStartDate),
    deliveryDate: readString(raw?.deliveryDate) ?? formatDateOnlyNullable(stop?.deliveryDate ?? null),
    deliveryDateSource: readDeliveryDateSource(raw?.deliveryDateSource),
    deliveryDayRaw: readString(raw?.deliveryDayRaw) ?? readString(raw?.deliveryDay),
    deliverySession: readDeliverySession(raw?.deliverySession),
    deliveryStopId: stop?.id ?? null,
    deliveryWeekday: readDeliveryWeekday(raw?.deliveryWeekday),
    email: order.email,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    geocodeStatus: readGeocodeStatus(stop?.geocodeStatus),
    hasCoordinates,
    latitude,
    longitude,
    name: order.name,
    orderCreatedAt: readString(raw?.orderCreatedAt),
    orderDateLocal: readString(raw?.orderDateLocal),
    orderId: order.id,
    phone: order.phone,
    pickup: readBoolean(raw?.pickup) ?? false,
    planningGroupKey: readString(raw?.planningGroupKey),
    planningStatus,
    processedAt: formatDateTime(order.processedAt),
    readiness,
    recipientName: stop?.recipientName ?? readString(raw?.recipientName),
    reviewReasons,
    routeScopeKey: readString(raw?.routeScopeKey),
    serviceType: readServiceType(raw?.serviceType),
    shippingAddress,
    shopifyOrderGid: order.shopifyOrderGid,
    shopifyOrderLegacyId: order.shopifyOrderLegacyId === null ? null : String(order.shopifyOrderLegacyId),
    timeWindowEnd: readString(raw?.timeWindowEnd),
    timeWindowStart: readString(raw?.timeWindowStart),
    totalPriceAmount: decimalLikeString(order.totalPriceAmount),
    updatedAtShopify: formatDateTime(order.updatedAtShopify)
  };
}

function readReadiness(
  value: unknown,
  cancelledAt: Date | null,
  reviewReasons: string[]
): CanonicalOrderReadiness {
  const text = readString(value);
  if (text === 'READY_TO_PLAN' || text === 'NEEDS_REVIEW' || text === 'SKIPPED') {
    return text;
  }
  return cancelledAt === null && reviewReasons.length === 0 ? 'READY_TO_PLAN' : 'NEEDS_REVIEW';
}

function readShippingAddress(
  value: unknown,
  fallback: DeliveryStopRecord | null
): CanonicalOrderRow['shippingAddress'] {
  const object = objectOrNull(value);
  return {
    address1: readString(object?.address1) ?? fallback?.address1 ?? null,
    address2: readString(object?.address2) ?? fallback?.address2 ?? null,
    city: readString(object?.city) ?? fallback?.city ?? null,
    countryCode: readString(object?.countryCode) ?? fallback?.countryCode ?? null,
    postalCode: readString(object?.postalCode) ?? fallback?.postalCode ?? null,
    province: readString(object?.province) ?? fallback?.province ?? null
  };
}

function readDeliveryWeekday(value: unknown): DeliveryWeekday | null {
  return value === 'SUNDAY' ||
    value === 'MONDAY' ||
    value === 'TUESDAY' ||
    value === 'WEDNESDAY' ||
    value === 'THURSDAY' ||
    value === 'FRIDAY' ||
    value === 'SATURDAY'
    ? value
    : null;
}

function readServiceType(value: unknown): DeliveryServiceType | null {
  return value === 'DELIVERY' || value === 'EVENING_DELIVERY' || value === 'PICKUP' ? value : null;
}


function readDeliverySession(value: unknown): CanonicalOrderRow['deliverySession'] {
  return value === 'DAY' || value === 'EVENING' || value === 'PICKUP' ? value : null;
}

function readDeliveryDateSource(value: unknown): CanonicalOrderRow['deliveryDateSource'] {
  return value === 'EXPLICIT_ATTRIBUTE' ||
    value === 'LINE_ITEM_DATE_RANGE' ||
    value === 'ORDER_DATE_CYCLE_RULE' ||
    value === 'MISSING'
    ? value
    : null;
}

function parseDateOnly(value: string | null): Date | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function parseTorontoTimeWindow(deliveryDate: string | null, time: string | null): Date | null {
  if (deliveryDate === null || time === null) return null;
  if (!/^\d{2}:\d{2}$/u.test(time)) return null;
  return zonedTimeToUtc(deliveryDate, time, 'America/Toronto');
}

function zonedTimeToUtc(date: string, time: string, timeZone: string): Date | null {
  const dateParts = date.split('-').map(Number);
  const timeParts = time.split(':').map(Number);
  const year = dateParts[0];
  const month = dateParts[1];
  const day = dateParts[2];
  const hour = timeParts[0];
  const minute = timeParts[1];
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) return null;
  if ([year, month, day, hour, minute].some((part) => Number.isNaN(part))) return null;
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric'
    }).formatToParts(utc);
    const localYear = Number(parts.find((part) => part.type === 'year')?.value);
    const localMonth = Number(parts.find((part) => part.type === 'month')?.value);
    const localDay = Number(parts.find((part) => part.type === 'day')?.value);
    const localHour = Number(parts.find((part) => part.type === 'hour')?.value);
    const localMinute = Number(parts.find((part) => part.type === 'minute')?.value);
    const localAsUtc = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0);
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    utc = new Date(utc.getTime() + (targetAsUtc - localAsUtc));
  }
  return utc;
}

function formatDateOnlyNullable(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function readGeocodeStatus(value: unknown): CanonicalOrderRow['geocodeStatus'] {
  return value === 'NOT_REQUIRED' || value === 'RESOLVED' || value === 'FAILED' ? value : 'PENDING';
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function decimalLikeString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Prisma.Decimal) {
    return value.toString();
  }
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
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
