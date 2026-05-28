import { Prisma, type PrismaClient } from "@prisma/client";

import type {
  CanonicalOrderReadiness,
  CanonicalOrderRow,
  CommerceSourcePlatform,
  DeliveryServiceType,
  DeliveryWeekday,
  PlanningStatus,
  SyncedOrderDeliveryFactInput,
  SyncedOrderWithDeliveryStopInput,
} from "./order-sync.mapper.js";
import {
  deriveOperateDeliveryStatus,
  deriveOrderHealth,
  type OperateDeliveryStatus,
  type OrderHealth,
} from "./order-operate-status.js";

export type UpsertOrderWithDeliveryStopInput = {
  shopDomain: string;
  synced: SyncedOrderWithDeliveryStopInput;
};

export type UpsertOrderWithDeliveryStopResult = {
  orderId: string;
  status: "created" | "updated" | "unchanged" | "skipped";
  stopId: string | null;
};

export type ListCanonicalOrdersFilters = {
  deliveryBatchEndDate?: string;
  deliveryBatchStartDate?: string;
  deliveryArea?: string;
  deliveryDate?: string;
  deliverySession?: "DAY" | "EVENING" | "PICKUP";
  deliveryWeekday?: DeliveryWeekday;
  geocodeStatus?: "PENDING" | "RESOLVED" | "FAILED" | "NOT_REQUIRED";
  operateDeliveryStatus?: OperateDeliveryStatus;
  orderHealth?: OrderHealth;
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

export type DeliveryBatchCandidate = {
  alreadyPlannedCount: number;
  blockedCount: number;
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  missingCoordinatesCount: number;
  mismatchCount: number;
  orderCount: number;
  planningGroupKey: string | null;
  readyCount: number;
  routeScopeKey: string | null;
  serviceType: string | null;
};

export type ListDeliveryBatchCandidatesInput = {
  deliveryDate?: string;
  shopDomain: string;
};

export type RouteOpsCanonicalMetadataPatch = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  countryCode?: string | null;
  deliveryArea?: string | null;
  deliveryDate?: string | null;
  deliverySession?: "DAY" | "EVENING" | "PICKUP" | null;
  postalCode?: string | null;
  province?: string | null;
  serviceType?: DeliveryServiceType | null;
  timeWindowEnd?: string | null;
  timeWindowStart?: string | null;
};

export type PatchCanonicalOrderInput = {
  actor: string;
  orderId: string;
  patch: RouteOpsCanonicalMetadataPatch;
  shopDomain: string;
};

export type PatchCanonicalOrderCoordinatesInput = {
  actor: string;
  latitude: number;
  longitude: number;
  orderId: string;
  provider?: string | null;
  providerPlaceId?: string | null;
  rawLabel?: string | null;
  shopDomain: string;
  source: "geocoder" | "manual" | "map_click";
};

type OrderSyncPrismaClient = Pick<
  PrismaClient,
  | "$transaction"
  | "commerceConnectionOrderMapping"
  | "deliveryStop"
  | "order"
  | "orderDeliveryFact"
  | "shop"
>;

type OrderSyncWriteClient = Pick<
  PrismaClient,
  "deliveryStop" | "order" | "orderDeliveryFact"
>;

type ExistingOrder = {
  deliveryFacts?: ExistingDeliveryFact[];
  deliveryStops?: ExistingDeliveryStop[];
  id: string;
  sourceUpdatedAt: Date | null;
  updatedAtShopify: Date | null;
};

type ExistingDeliveryFact = {
  batchEligible?: boolean;
  deliveryArea: string | null;
  deliveryDate: Date | null;
  deliveryDateWeekday?: string | null;
  deliveryDateWeekdayMismatch?: boolean;
  deliveryDateWeekdayVerified?: boolean;
  deliverySession: string | null;
  geocodeStatus?: string;
  mappingDiagnostics: unknown;
  planningGroupKey: string | null;
  readiness: string;
  reviewReasons: unknown;
  routeScopeKey: string | null;
  serviceType: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
};

type ExistingDeliveryStop = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: Date | null;
  geocodeStatus: string;
  latitude: unknown;
  longitude: unknown;
  postalCode: string | null;
  province: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
};

type CanonicalOrderRecord = {
  cancelledAt: Date | null;
  currencyCode: string | null;
  deliveryFacts?: DeliveryFactCanonicalRecord[];
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
  sourceOrderId?: string | null;
  sourceOrderNumber?: string | null;
  sourcePlatform?: CommerceSourcePlatform | null;
  sourceSiteUrl?: string | null;
  sourceUpdatedAt?: Date | null;
  totalPriceAmount: unknown;
  updatedAtShopify: Date | null;
};

type DeliveryFactCanonicalRecord = {
  deliveryArea: string | null;
  deliveryDate: Date | null;
  deliveryDateWeekday: string | null;
  deliveryDateWeekdayMismatch?: boolean;
  deliveryDateWeekdayVerified?: boolean;
  deliveryDayParseStatus?: string | null;
  deliverySession: string | null;
  mappingDiagnostics?: unknown;
  matchedMappingPaths?: unknown;
  deliveryWeekday: string | null;
  planningGroupKey: string | null;
  rawDeliveryArea?: string | null;
  rawDeliveryDate?: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow?: string | null;
  readiness: string;
  reviewReasons: unknown;
  routeScopeKey: string | null;
  serviceType: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
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
  routePlanStops?: DeliveryStopRoutePlanStopRecord[];
  status: string;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
};

type DeliveryStopRoutePlanStopRecord = {
  routePlan?: {
    id: string;
    name: string;
    status: string;
  } | null;
};

type DeliveryFactCandidateRecord = {
  deliveryArea: string | null;
  deliveryDate: Date | null;
  deliveryDateWeekdayMismatch: boolean;
  deliverySession: string | null;
  deliveryDayParseStatus: string;
  deliveryDateWeekdayVerified: boolean;
  order: {
    deliveryStops: Array<{
      latitude: unknown;
      longitude: unknown;
      routePlanStops?: Array<{ id: string }>;
    }>;
  };
  planningGroupKey: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  readiness: string;
  reviewReasons: unknown;
  routeScopeKey: string | null;
  serviceType: string | null;
};

export class PrismaOrderSyncRepository {
  constructor(
    private readonly prisma: OrderSyncPrismaClient,
    private readonly options: {
      allowAnyShopDomain?: boolean;
      createMissingShop?: boolean;
    } = {},
  ) {}

  async upsertOrderWithDeliveryStop(
    input: UpsertOrderWithDeliveryStopInput,
  ): Promise<UpsertOrderWithDeliveryStopResult> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) {
      throw new Error(`Shop not installed: ${input.shopDomain}`);
    }

    const sourceIdentity = readSourceIdentity(input.synced.order);
    const existing = await this.prisma.order.findFirst({
      select: {
        deliveryFacts: {
          select: existingDeliveryFactSelect(),
          take: 1,
        },
        deliveryStops: {
          select: existingDeliveryStopSelect(),
          take: 1,
        },
        id: true,
        sourceUpdatedAt: true,
        updatedAtShopify: true,
      },
      where: {
        shopId: shop.id,
        OR: [
          { shopifyOrderGid: input.synced.order.shopifyOrderGid },
          ...(sourceIdentity.sourceOrderId === null
            ? []
            : [
                {
                  sourceOrderId: sourceIdentity.sourceOrderId,
                  sourcePlatform: sourceIdentity.sourcePlatform,
                  sourceSiteUrl: sourceIdentity.sourceSiteUrl,
                },
              ]),
        ],
      },
    });

    if (
      existing !== null &&
      isExistingNewerThanSnapshot(existing, sourceIdentity.sourceUpdatedAt)
    ) {
      return { orderId: existing.id, status: "unchanged", stopId: null };
    }

    return this.prisma.$transaction((tx) =>
      this.writeOrderWithDeliveryStop({
        existing,
        shopId: shop.id,
        synced: input.synced,
        tx,
      }),
    );
  }

  async readOrderMappingConfig(input: {
    commerceConnectionId: string;
  }): Promise<Record<string, unknown> | null> {
    const mapping = await this.prisma.commerceConnectionOrderMapping.findUnique(
      {
        select: { config: true },
        where: { commerceConnectionId: input.commerceConnectionId },
      },
    );
    return objectOrNull(mapping?.config) ?? null;
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
      where: { id: input.orderId, shopId: shop.id },
    });

    return order === null ? null : toCanonicalOrderRow(order);
  }

  async listCanonicalOrders(
    input: ListCanonicalOrdersInput,
  ): Promise<CanonicalOrderRow[]> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) {
      return [];
    }

    const orders = (await this.prisma.order.findMany({
      include: canonicalOrderInclude(),
      orderBy: { updatedAtShopify: "desc" },
      where: toOrderWhere(shop.id, input.filters ?? {}),
    })) as CanonicalOrderRecord[];

    return orders
      .map((order) => toCanonicalOrderRow(order))
      .filter((row) => matchesDerivedFilters(row, input.filters ?? {}));
  }

  async listDeliveryBatchCandidates(
    input: ListDeliveryBatchCandidatesInput,
  ): Promise<DeliveryBatchCandidate[]> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) {
      return [];
    }
    const facts = (await this.prisma.orderDeliveryFact.findMany({
      include: {
        order: {
          include: {
            deliveryStops: {
              include: {
                routePlanStops: {
                  select: { id: true },
                },
              },
              take: 1,
            },
          },
        },
      },
      where: {
        ...(input.deliveryDate === undefined
          ? {}
          : { deliveryDate: parseDateOnly(input.deliveryDate) }),
        shopId: shop.id,
      },
    })) as DeliveryFactCandidateRecord[];
    return summarizeDeliveryBatchCandidates(facts);
  }

  async patchCanonicalOrder(
    input: PatchCanonicalOrderInput,
  ): Promise<CanonicalOrderRow | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const order = await this.findOrderForPatch({
      orderId: input.orderId,
      shopId: shop.id,
    });
    if (order === null) return null;
    await this.prisma.$transaction(async (tx) => {
      const fact = order.deliveryFacts?.[0] ?? null;
      const stop = order.deliveryStops?.[0] ?? null;
      const patch = input.patch;
      const deliveryDate =
        patch.deliveryDate === undefined
          ? formatDateOnlyNullable(
              fact?.deliveryDate ?? stop?.deliveryDate ?? null,
            )
          : patch.deliveryDate;
      const deliverySession =
        patch.deliverySession === undefined
          ? readDeliverySession(fact?.deliverySession)
          : patch.deliverySession;
      const serviceType =
        patch.serviceType === undefined
          ? (serviceTypeForSession(deliverySession) ??
            readServiceType(fact?.serviceType))
          : patch.serviceType;
      const deliveryArea =
        patch.deliveryArea === undefined
          ? (fact?.deliveryArea ?? null)
          : patch.deliveryArea;
      const timeWindowStart =
        patch.timeWindowStart === undefined
          ? (readRouteScopeTime(fact?.routeScopeKey ?? null, "start") ??
            formatTimeOnlyNullable(
              fact?.timeWindowStart ?? stop?.timeWindowStart ?? null,
            ))
          : patch.timeWindowStart;
      const timeWindowEnd =
        patch.timeWindowEnd === undefined
          ? (readRouteScopeTime(fact?.routeScopeKey ?? null, "end") ??
            formatTimeOnlyNullable(
              fact?.timeWindowEnd ?? stop?.timeWindowEnd ?? null,
            ))
          : patch.timeWindowEnd;
      const scope = buildManualScope({
        deliveryArea,
        deliveryDate,
        deliverySession,
        serviceType,
        timeWindowEnd,
        timeWindowStart,
      });
      const currentReasons = readStringArray(fact?.reviewReasons) ?? [];
      const reviewReasons = recomputeReviewReasons(currentReasons, {
        deliveryArea,
        deliveryDate,
        routeScopeKey: scope.routeScopeKey,
        serviceType,
        hasAddress: hasAddressFields({
          address1:
            patch.address1 === undefined
              ? (stop?.address1 ?? null)
              : patch.address1,
          city: patch.city === undefined ? (stop?.city ?? null) : patch.city,
          countryCode:
            patch.countryCode === undefined
              ? (stop?.countryCode ?? null)
              : patch.countryCode,
          postalCode:
            patch.postalCode === undefined
              ? (stop?.postalCode ?? null)
              : patch.postalCode,
        }),
      });
      const readiness: CanonicalOrderReadiness =
        reviewReasons.length === 0 &&
        deliveryDate !== null &&
        scope.routeScopeKey !== null
          ? "READY_TO_PLAN"
          : "NEEDS_REVIEW";
      const correctionFields = expandRouteOpsCorrectionFields(
        Object.keys(patch).filter(
          (field) =>
            patch[field as keyof RouteOpsCanonicalMetadataPatch] !== undefined,
        ),
      );
      const mappingDiagnostics = mergeRouteOpsCorrectionMetadata(
        fact?.mappingDiagnostics,
        correctionFields,
        {
          actor: input.actor,
          source: "operator_metadata_patch",
        },
      );
      await tx.orderDeliveryFact.upsert({
        create: {
          batchEligible: readiness === "READY_TO_PLAN",
          computedAt: new Date(),
          deliveryArea,
          deliveryDate: parseDateOnly(deliveryDate),
          deliveryDateWeekday: weekdayForDate(deliveryDate),
          deliveryDateWeekdayMismatch: false,
          deliveryDateWeekdayVerified: deliveryDate !== null,
          deliveryDayParseStatus:
            deliveryDate === null ? "NOT_PROVIDED" : "PARSED",
          deliveryDayUnparsedReason: null,
          deliverySession,
          deliveryWeekday: weekdayForDate(deliveryDate),
          geocodeStatus:
            stop?.geocodeStatus === "RESOLVED" ? "RESOLVED" : "PENDING",
          mappingDiagnostics: toJson(mappingDiagnostics),
          matchedMappingPaths: toJson({ routeOpsCorrection: true }),
          orderId: order.id,
          planningGroupKey: scope.planningGroupKey,
          rawDeliveryArea: null,
          rawDeliveryDate: null,
          rawDeliveryDay: null,
          rawDeliveryTimeWindow: null,
          rawPickupDay: null,
          readiness,
          reviewReasons: toJson(reviewReasons),
          routeScopeKey: scope.routeScopeKey,
          serviceType,
          shopId: shop.id,
          sourceOrderId: order.sourceOrderId ?? null,
          sourceOrderNumber: order.sourceOrderNumber ?? null,
          sourcePlatform: order.sourcePlatform ?? "SHOPIFY",
          sourceSiteUrl: order.sourceSiteUrl ?? null,
          sourceUpdatedAt: order.sourceUpdatedAt ?? order.updatedAtShopify,
          timeWindowEnd: parseTorontoTimeWindow(deliveryDate, timeWindowEnd),
          timeWindowStart: parseTorontoTimeWindow(
            deliveryDate,
            timeWindowStart,
          ),
        },
        update: {
          batchEligible: readiness === "READY_TO_PLAN",
          computedAt: new Date(),
          deliveryArea,
          deliveryDate: parseDateOnly(deliveryDate),
          deliveryDateWeekday: weekdayForDate(deliveryDate),
          deliveryDateWeekdayMismatch: false,
          deliveryDateWeekdayVerified: deliveryDate !== null,
          deliveryDayParseStatus:
            deliveryDate === null ? "NOT_PROVIDED" : "PARSED",
          deliverySession,
          deliveryWeekday: weekdayForDate(deliveryDate),
          mappingDiagnostics: toJson(mappingDiagnostics),
          planningGroupKey: scope.planningGroupKey,
          readiness,
          reviewReasons: toJson(reviewReasons),
          routeScopeKey: scope.routeScopeKey,
          serviceType,
          timeWindowEnd: parseTorontoTimeWindow(deliveryDate, timeWindowEnd),
          timeWindowStart: parseTorontoTimeWindow(
            deliveryDate,
            timeWindowStart,
          ),
        },
        where: { shopId_orderId: { orderId: order.id, shopId: shop.id } },
      });
      const stopWrite = {
        address1:
          patch.address1 === undefined
            ? (stop?.address1 ?? null)
            : patch.address1,
        address2:
          patch.address2 === undefined
            ? (stop?.address2 ?? null)
            : patch.address2,
        city: patch.city === undefined ? (stop?.city ?? null) : patch.city,
        countryCode:
          patch.countryCode === undefined
            ? (stop?.countryCode ?? null)
            : patch.countryCode,
        deliveryDate: parseDateOnly(deliveryDate),
        geocodeStatus:
          stop?.geocodeStatus === "RESOLVED"
            ? ("RESOLVED" as const)
            : ("PENDING" as const),
        postalCode:
          patch.postalCode === undefined
            ? (stop?.postalCode ?? null)
            : patch.postalCode,
        province:
          patch.province === undefined
            ? (stop?.province ?? null)
            : patch.province,
        timeWindowEnd: parseTorontoTimeWindow(deliveryDate, timeWindowEnd),
        timeWindowStart: parseTorontoTimeWindow(deliveryDate, timeWindowStart),
      };
      await tx.deliveryStop.upsert({
        create: { ...stopWrite, orderId: order.id, shopId: shop.id },
        update: stopWrite,
        where: { shopId_orderId: { orderId: order.id, shopId: shop.id } },
      });
    });
    return this.findCanonicalOrderById({
      orderId: order.id,
      shopDomain: input.shopDomain,
    });
  }

  async patchCanonicalOrderCoordinates(
    input: PatchCanonicalOrderCoordinatesInput,
  ): Promise<CanonicalOrderRow | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const order = await this.findOrderForPatch({
      orderId: input.orderId,
      shopId: shop.id,
    });
    if (order === null) return null;
    await this.prisma.$transaction(async (tx) => {
      const fact = order.deliveryFacts?.[0] ?? null;
      const shippingAddress = readShippingAddress(
        order.shippingAddress,
        order.deliveryStops?.[0] ?? null,
      );
      const existingReasons = readStringArray(fact?.reviewReasons) ?? [];
      const reviewReasons = recomputeCoordinateReviewReasons(existingReasons, {
        deliveryArea: fact?.deliveryArea ?? null,
        deliveryDate: formatDateOnlyNullable(fact?.deliveryDate ?? null),
        hasAddress: hasAddressFields(shippingAddress),
        routeScopeKey: fact?.routeScopeKey ?? null,
        serviceType: readServiceType(fact?.serviceType),
      });
      const readiness: CanonicalOrderReadiness =
        reviewReasons.length === 0 &&
        fact !== null &&
        fact.deliveryDate !== null &&
        fact.routeScopeKey !== null
          ? "READY_TO_PLAN"
          : "NEEDS_REVIEW";
      const mappingDiagnostics = mergeRouteOpsCorrectionMetadata(
        fact?.mappingDiagnostics,
        ["latitude", "longitude", "geocodeStatus"],
        {
          actor: input.actor,
          geocode: {
            provider: input.provider ?? null,
            providerPlaceId: input.providerPlaceId ?? null,
            rawLabel: input.rawLabel ?? null,
          },
          source: input.source,
        },
      );
      await tx.deliveryStop.upsert({
        create: {
          address1: shippingAddress.address1,
          address2: shippingAddress.address2,
          city: shippingAddress.city,
          countryCode: shippingAddress.countryCode,
          deliveryDate: fact?.deliveryDate ?? null,
          geocodeStatus: "RESOLVED",
          latitude: input.latitude.toFixed(7),
          longitude: input.longitude.toFixed(7),
          orderId: order.id,
          postalCode: shippingAddress.postalCode,
          province: shippingAddress.province,
          shopId: shop.id,
          timeWindowEnd: fact?.timeWindowEnd ?? null,
          timeWindowStart: fact?.timeWindowStart ?? null,
        },
        update: {
          geocodeStatus: "RESOLVED",
          latitude: input.latitude.toFixed(7),
          longitude: input.longitude.toFixed(7),
        },
        where: { shopId_orderId: { orderId: order.id, shopId: shop.id } },
      });
      await tx.orderDeliveryFact.upsert({
        create: {
          batchEligible: readiness === "READY_TO_PLAN",
          computedAt: new Date(),
          deliveryArea: fact?.deliveryArea ?? null,
          deliveryDate: fact?.deliveryDate ?? null,
          deliveryDateWeekday: readDeliveryWeekday(fact?.deliveryDateWeekday),
          deliveryDateWeekdayMismatch:
            fact?.deliveryDateWeekdayMismatch ?? false,
          deliveryDateWeekdayVerified:
            fact?.deliveryDateWeekdayVerified ?? false,
          deliveryDayParseStatus:
            fact?.deliveryDate === null || fact === null
              ? "NOT_PROVIDED"
              : "PARSED",
          deliveryDayUnparsedReason: null,
          deliverySession: readDeliverySession(fact?.deliverySession),
          deliveryWeekday: readDeliveryWeekday(fact?.deliveryDateWeekday),
          geocodeStatus: "RESOLVED",
          mappingDiagnostics: toJson(mappingDiagnostics),
          matchedMappingPaths: toJson({ routeOpsCorrection: true }),
          orderId: order.id,
          planningGroupKey: fact?.planningGroupKey ?? null,
          rawDeliveryArea: null,
          rawDeliveryDate: null,
          rawDeliveryDay: null,
          rawDeliveryTimeWindow: null,
          rawPickupDay: null,
          readiness,
          reviewReasons: toJson(reviewReasons),
          routeScopeKey: fact?.routeScopeKey ?? null,
          serviceType: readServiceType(fact?.serviceType),
          shopId: shop.id,
          sourceOrderId: order.sourceOrderId ?? null,
          sourceOrderNumber: order.sourceOrderNumber ?? null,
          sourcePlatform: order.sourcePlatform ?? "SHOPIFY",
          sourceSiteUrl: order.sourceSiteUrl ?? null,
          sourceUpdatedAt: order.sourceUpdatedAt ?? order.updatedAtShopify,
          timeWindowEnd: fact?.timeWindowEnd ?? null,
          timeWindowStart: fact?.timeWindowStart ?? null,
        },
        update: {
          batchEligible: readiness === "READY_TO_PLAN",
          geocodeStatus: "RESOLVED",
          mappingDiagnostics: toJson(mappingDiagnostics),
          readiness,
          reviewReasons: toJson(reviewReasons),
        },
        where: { shopId_orderId: { orderId: order.id, shopId: shop.id } },
      });
    });
    return this.findCanonicalOrderById({
      orderId: order.id,
      shopDomain: input.shopDomain,
    });
  }

  private async findOrderForPatch(input: {
    orderId: string;
    shopId: string;
  }): Promise<
    | (CanonicalOrderRecord & {
        sourceOrderId?: string | null;
        sourceOrderNumber?: string | null;
        sourcePlatform?: CommerceSourcePlatform | null;
        sourceSiteUrl?: string | null;
        sourceUpdatedAt?: Date | null;
      })
    | null
  > {
    return await this.prisma.order.findFirst({
      include: canonicalOrderInclude(),
      where: {
        shopId: input.shopId,
        OR: [
          { id: input.orderId },
          { shopifyOrderGid: input.orderId },
          { sourceOrderId: input.orderId },
          { sourceOrderNumber: input.orderId },
        ],
      },
    });
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    const normalized = normalizeShopDomain(shopDomain, {
      allowAnyDomain: this.options.allowAnyShopDomain === true,
    });
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: normalized },
    });
    if (shop !== null || this.options.createMissingShop !== true) {
      return shop;
    }

    return this.prisma.shop.create({
      data: { shopDomain: normalized },
      select: { id: true },
    });
  }

  private async writeOrderWithDeliveryStop(input: {
    existing: ExistingOrder | null;
    shopId: string;
    synced: SyncedOrderWithDeliveryStopInput;
    tx: OrderSyncWriteClient;
  }): Promise<UpsertOrderWithDeliveryStopResult> {
    const orderWrite = toOrderWrite(input.synced.order);
    const order = await input.tx.order.upsert({
      create: { ...orderWrite, shopId: input.shopId },
      update: orderWrite,
      where: {
        shopId_shopifyOrderGid: {
          shopId: input.shopId,
          shopifyOrderGid: input.synced.order.shopifyOrderGid,
        },
      },
    });

    const existingFact = input.existing?.deliveryFacts?.[0] ?? null;
    const existingStop = input.existing?.deliveryStops?.[0] ?? null;
    const correctedFields = readRouteOpsCorrectedFields(
      existingFact?.mappingDiagnostics,
    );

    let stopId: string | null = null;
    if (input.synced.deliveryStop === null) {
      if (!hasCorrectedStopFields(correctedFields)) {
        await input.tx.deliveryStop.updateMany({
          data: clearedDeliveryStopWrite(),
          where: { orderId: order.id, shopId: input.shopId },
        });
      }
    } else {
      const deliveryStopWrite = applyCorrectedStopFields(
        toDeliveryStopWrite(input.synced.deliveryStop),
        existingStop,
        correctedFields,
      );
      const stop = await input.tx.deliveryStop.upsert({
        create: {
          ...deliveryStopWrite,
          orderId: order.id,
          shopId: input.shopId,
        },
        update: deliveryStopWrite,
        where: {
          shopId_orderId: {
            orderId: order.id,
            shopId: input.shopId,
          },
        },
      });
      stopId = stop.id;
    }

    if (
      input.synced.deliveryFact !== undefined &&
      input.synced.deliveryFact !== null
    ) {
      const factWrite = applyCorrectedFactFields(
        toOrderDeliveryFactWrite(input.synced.deliveryFact),
        existingFact,
        correctedFields,
      );
      await input.tx.orderDeliveryFact.upsert({
        create: {
          ...factWrite,
          orderId: order.id,
          shopId: input.shopId,
        },
        update: factWrite,
        where: {
          shopId_orderId: {
            orderId: order.id,
            shopId: input.shopId,
          },
        },
      });
    }

    return {
      orderId: order.id,
      status: input.existing === null ? "created" : "updated",
      stopId,
    };
  }
}

function isExistingNewerThanSnapshot(
  existing: ExistingOrder,
  incomingUpdatedAt: Date,
): boolean {
  const existingUpdatedAt =
    existing.sourceUpdatedAt ?? existing.updatedAtShopify;
  return (
    existingUpdatedAt !== null &&
    existingUpdatedAt.getTime() > incomingUpdatedAt.getTime()
  );
}

function canonicalOrderInclude(): Prisma.OrderInclude {
  return {
    deliveryFacts: {
      take: 1,
    },
    deliveryStops: {
      include: {
        routePlanStops: {
          include: {
            routePlan: {
              select: { id: true, name: true, status: true },
            },
          },
        },
      },
      take: 1,
    },
  };
}

function toOrderWhere(
  shopId: string,
  filters: ListCanonicalOrdersFilters,
): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { shopId };
  if (filters.search !== undefined && filters.search.trim() !== "") {
    const search = filters.search.trim();
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
      { sourceOrderNumber: { contains: search, mode: "insensitive" } },
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
  geocodeStatus: "PENDING";
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
    geocodeStatus: "PENDING",
    instructions: null,
    latitude: null,
    longitude: null,
    phone: null,
    postalCode: null,
    province: null,
    recipientName: null,
    timeWindowEnd: null,
    timeWindowStart: null,
  };
}

function matchesDerivedFilters(
  row: CanonicalOrderRow,
  filters: ListCanonicalOrdersFilters,
): boolean {
  if (filters.readiness !== undefined && row.readiness !== filters.readiness)
    return false;
  if (
    filters.planned !== undefined &&
    (row.planningStatus === "PLANNED") !== filters.planned
  )
    return false;
  if (
    filters.deliveryWeekday !== undefined &&
    row.deliveryWeekday !== filters.deliveryWeekday
  )
    return false;
  if (
    filters.serviceType !== undefined &&
    row.serviceType !== filters.serviceType
  )
    return false;
  if (
    filters.geocodeStatus !== undefined &&
    row.geocodeStatus !== filters.geocodeStatus
  )
    return false;
  if (
    filters.deliveryDate !== undefined &&
    row.deliveryDate !== filters.deliveryDate
  )
    return false;
  if (
    filters.deliveryArea !== undefined &&
    row.deliveryArea?.toLowerCase() !==
      filters.deliveryArea.trim().toLowerCase()
  ) {
    return false;
  }
  if (
    filters.deliveryBatchStartDate !== undefined &&
    row.deliveryBatchStartDate !== filters.deliveryBatchStartDate
  )
    return false;
  if (
    filters.deliveryBatchEndDate !== undefined &&
    row.deliveryBatchEndDate !== filters.deliveryBatchEndDate
  )
    return false;
  if (
    filters.deliverySession !== undefined &&
    row.deliverySession !== filters.deliverySession
  )
    return false;
  if (
    filters.routeScopeKey !== undefined &&
    row.routeScopeKey !== filters.routeScopeKey
  )
    return false;
  if (
    filters.planningGroupKey !== undefined &&
    row.planningGroupKey !== filters.planningGroupKey
  )
    return false;
  if (
    filters.operateDeliveryStatus !== undefined &&
    deriveOperateDeliveryStatus(row) !== filters.operateDeliveryStatus
  ) {
    return false;
  }
  if (
    filters.orderHealth !== undefined &&
    deriveOrderHealth(row) !== filters.orderHealth
  )
    return false;
  return true;
}

function summarizeDeliveryBatchCandidates(
  facts: DeliveryFactCandidateRecord[],
): DeliveryBatchCandidate[] {
  const groups = new Map<string, DeliveryBatchCandidate>();
  for (const fact of facts) {
    const key = [
      formatDateOnlyNullable(fact.deliveryDate),
      fact.routeScopeKey ?? "",
      fact.planningGroupKey ?? "",
      fact.deliverySession ?? "",
      fact.serviceType ?? "",
      fact.deliveryArea ?? "",
    ].join("|");
    const candidate = groups.get(key) ?? {
      alreadyPlannedCount: 0,
      blockedCount: 0,
      deliveryArea: fact.deliveryArea,
      deliveryDate: formatDateOnlyNullable(fact.deliveryDate),
      deliverySession: fact.deliverySession,
      missingCoordinatesCount: 0,
      mismatchCount: 0,
      orderCount: 0,
      planningGroupKey: fact.planningGroupKey,
      readyCount: 0,
      routeScopeKey: fact.routeScopeKey,
      serviceType: fact.serviceType,
    };
    const stop = fact.order.deliveryStops[0] ?? null;
    const hasCoordinates =
      decimalNumber(stop?.latitude) !== null &&
      decimalNumber(stop?.longitude) !== null;
    const alreadyPlanned = (stop?.routePlanStops?.length ?? 0) > 0;
    const reviewReasons = readStringArray(fact.reviewReasons) ?? [];
    const mismatch =
      fact.deliveryDateWeekdayMismatch ||
      reviewReasons.includes("delivery_date_weekday_mismatch");
    const unverifiedDay =
      (fact.rawDeliveryDay !== null || fact.rawDeliveryTimeWindow !== null) &&
      (!fact.deliveryDateWeekdayVerified ||
        fact.deliveryDayParseStatus === "UNPARSED" ||
        fact.deliveryDayParseStatus === "UNVERIFIED" ||
        reviewReasons.includes("delivery_day_unparsed") ||
        reviewReasons.includes("delivery_date_weekday_unverified"));
    const operationalReviewReasons = discountLiveOperationalReviewReasons(
      reviewReasons,
      { hasCoordinates, alreadyPlanned },
    );
    const factReady =
      fact.readiness === "READY_TO_PLAN" ||
      operationalReviewReasons.length === 0;
    const ready =
      factReady &&
      fact.routeScopeKey !== null &&
      fact.deliveryDate !== null &&
      hasCoordinates &&
      !alreadyPlanned &&
      !mismatch &&
      !unverifiedDay;

    candidate.orderCount += 1;
    if (ready) candidate.readyCount += 1;
    else candidate.blockedCount += 1;
    if (!hasCoordinates) candidate.missingCoordinatesCount += 1;
    if (alreadyPlanned) candidate.alreadyPlannedCount += 1;
    if (mismatch) candidate.mismatchCount += 1;
    groups.set(key, candidate);
  }
  return [...groups.values()].sort(
    (left, right) =>
      (left.deliveryDate ?? "").localeCompare(right.deliveryDate ?? "") ||
      (left.routeScopeKey ?? "").localeCompare(right.routeScopeKey ?? "") ||
      (left.planningGroupKey ?? "").localeCompare(right.planningGroupKey ?? ""),
  );
}

function discountLiveOperationalReviewReasons(
  reviewReasons: string[],
  input: { alreadyPlanned: boolean; hasCoordinates: boolean },
): string[] {
  return reviewReasons.filter((reason) => {
    if (reason === "missing_coordinates" && input.hasCoordinates) return false;
    if (reason === "already_planned" && !input.alreadyPlanned) return false;
    return true;
  });
}

function expandRouteOpsCorrectionFields(fields: string[]): string[] {
  const expanded = new Set(fields);
  if (
    fields.some((field) =>
      [
        "deliveryArea",
        "deliveryDate",
        "deliverySession",
        "serviceType",
        "timeWindowEnd",
        "timeWindowStart",
      ].includes(field),
    )
  ) {
    expanded.add("planningGroupKey");
    expanded.add("routeScopeKey");
  }
  if (fields.includes("deliveryDate")) {
    expanded.add("deliveryDateWeekday");
  }
  return [...expanded];
}

function existingDeliveryFactSelect(): Prisma.OrderDeliveryFactSelect {
  return {
    batchEligible: true,
    deliveryArea: true,
    deliveryDate: true,
    deliveryDateWeekday: true,
    deliveryDateWeekdayMismatch: true,
    deliveryDateWeekdayVerified: true,
    deliveryDayParseStatus: true,
    deliverySession: true,
    geocodeStatus: true,
    mappingDiagnostics: true,
    matchedMappingPaths: true,
    planningGroupKey: true,
    rawDeliveryArea: true,
    rawDeliveryDate: true,
    rawDeliveryDay: true,
    rawDeliveryTimeWindow: true,
    readiness: true,
    reviewReasons: true,
    routeScopeKey: true,
    serviceType: true,
    timeWindowEnd: true,
    timeWindowStart: true,
  };
}

function existingDeliveryStopSelect(): Prisma.DeliveryStopSelect {
  return {
    address1: true,
    address2: true,
    city: true,
    countryCode: true,
    deliveryDate: true,
    geocodeStatus: true,
    latitude: true,
    longitude: true,
    postalCode: true,
    province: true,
    timeWindowEnd: true,
    timeWindowStart: true,
  };
}

type RouteOpsCorrectionMeta = {
  fields?: Record<
    string,
    { actor?: string; correctedAt?: string; source?: string }
  >;
  geocode?: unknown;
  lastUpdatedAt?: string;
  version?: number;
};

function readRouteOpsCorrectedFields(value: unknown): Set<string> {
  const diagnostics = objectOrNull(value);
  const corrections = objectOrNull(diagnostics?.routeOpsCorrections);
  const fields = objectOrNull(corrections?.fields);
  return new Set(Object.keys(fields ?? {}));
}

function mergeRouteOpsCorrectionMetadata(
  value: unknown,
  fields: string[],
  input: { actor: string; geocode?: unknown; source: string },
): Record<string, unknown> {
  const diagnostics = { ...(objectOrNull(value) ?? {}) };
  const existing = objectOrNull(
    diagnostics.routeOpsCorrections,
  ) as RouteOpsCorrectionMeta | null;
  const fieldMap = { ...(objectOrNull(existing?.fields) ?? {}) } as Record<
    string,
    unknown
  >;
  const now = new Date().toISOString();
  for (const field of fields) {
    fieldMap[field] = {
      actor: input.actor,
      correctedAt: now,
      source: input.source,
    };
  }
  diagnostics.routeOpsCorrections = {
    ...(existing ?? {}),
    fields: fieldMap,
    ...(input.geocode === undefined ? {} : { geocode: input.geocode }),
    lastUpdatedAt: now,
    version: 1,
  };
  return diagnostics;
}

function hasCorrectedStopFields(fields: Set<string>): boolean {
  return [
    "address1",
    "address2",
    "city",
    "countryCode",
    "postalCode",
    "province",
    "latitude",
    "longitude",
    "geocodeStatus",
  ].some((field) => fields.has(field));
}

function applyCorrectedStopFields<
  T extends {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    deliveryDate: Date | null;
    geocodeStatus: "PENDING" | "RESOLVED";
    latitude: string | null;
    longitude: string | null;
    postalCode: string | null;
    province: string | null;
    timeWindowEnd: Date | null;
    timeWindowStart: Date | null;
  },
>(write: T, existing: ExistingDeliveryStop | null, fields: Set<string>): T {
  if (existing === null || fields.size === 0) return write;
  return {
    ...write,
    ...(fields.has("address1") ? { address1: existing.address1 } : {}),
    ...(fields.has("address2") ? { address2: existing.address2 } : {}),
    ...(fields.has("city") ? { city: existing.city } : {}),
    ...(fields.has("countryCode") ? { countryCode: existing.countryCode } : {}),
    ...(fields.has("deliveryDate")
      ? { deliveryDate: existing.deliveryDate }
      : {}),
    ...(fields.has("geocodeStatus")
      ? { geocodeStatus: readResolvedPending(existing.geocodeStatus) }
      : {}),
    ...(fields.has("latitude")
      ? { latitude: decimalLikeString(existing.latitude) }
      : {}),
    ...(fields.has("longitude")
      ? { longitude: decimalLikeString(existing.longitude) }
      : {}),
    ...(fields.has("postalCode") ? { postalCode: existing.postalCode } : {}),
    ...(fields.has("province") ? { province: existing.province } : {}),
    ...(fields.has("timeWindowEnd")
      ? { timeWindowEnd: existing.timeWindowEnd }
      : {}),
    ...(fields.has("timeWindowStart")
      ? { timeWindowStart: existing.timeWindowStart }
      : {}),
  };
}

function applyCorrectedFactFields<
  T extends ReturnType<typeof toOrderDeliveryFactWrite>,
>(write: T, existing: ExistingDeliveryFact | null, fields: Set<string>): T {
  if (existing === null || fields.size === 0) return write;
  const mergedDiagnostics = {
    ...objectOrNull(write.mappingDiagnostics),
    ...(objectOrNull(existing.mappingDiagnostics)?.routeOpsCorrections ===
    undefined
      ? {}
      : {
          routeOpsCorrections: objectOrNull(existing.mappingDiagnostics)
            ?.routeOpsCorrections,
        }),
  };
  return {
    ...write,
    mappingDiagnostics: toJson(mergedDiagnostics),
    ...(fields.has("deliveryArea")
      ? { deliveryArea: existing.deliveryArea }
      : {}),
    ...(fields.has("deliveryDate")
      ? { deliveryDate: existing.deliveryDate }
      : {}),
    ...(fields.has("deliveryDate")
      ? {
          deliveryDateWeekday: readDeliveryWeekday(
            existing.deliveryDateWeekday,
          ),
        }
      : {}),
    ...(fields.has("deliveryDate")
      ? {
          deliveryDateWeekdayMismatch:
            existing.deliveryDateWeekdayMismatch ?? false,
        }
      : {}),
    ...(fields.has("deliveryDate")
      ? {
          deliveryDateWeekdayVerified:
            existing.deliveryDateWeekdayVerified ?? true,
        }
      : {}),
    ...(fields.has("deliverySession")
      ? { deliverySession: readDeliverySession(existing.deliverySession) }
      : {}),
    ...(fields.has("geocodeStatus")
      ? { geocodeStatus: readGeocodeStatus(existing.geocodeStatus) }
      : {}),
    ...(fields.has("planningGroupKey") || fields.has("routeScopeKey")
      ? { planningGroupKey: existing.planningGroupKey }
      : {}),
    ...(fields.has("routeScopeKey")
      ? { routeScopeKey: existing.routeScopeKey }
      : {}),
    ...(fields.has("serviceType")
      ? { serviceType: readServiceType(existing.serviceType) }
      : {}),
    ...(fields.has("timeWindowEnd")
      ? { timeWindowEnd: existing.timeWindowEnd }
      : {}),
    ...(fields.has("timeWindowStart")
      ? { timeWindowStart: existing.timeWindowStart }
      : {}),
  };
}

function readResolvedPending(value: unknown): "PENDING" | "RESOLVED" {
  return value === "RESOLVED" ? "RESOLVED" : "PENDING";
}

function serviceTypeForSession(
  value: CanonicalOrderRow["deliverySession"],
): DeliveryServiceType | null {
  if (value === "DAY") return "DELIVERY";
  if (value === "EVENING") return "EVENING_DELIVERY";
  if (value === "PICKUP") return "PICKUP";
  return null;
}

function buildManualScope(input: {
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: CanonicalOrderRow["deliverySession"];
  serviceType: DeliveryServiceType | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
}): { planningGroupKey: string | null; routeScopeKey: string | null } {
  if (input.deliveryDate === null || input.serviceType === null)
    return { planningGroupKey: null, routeScopeKey: null };
  const routeParts = [
    input.deliveryDate,
    input.serviceType,
    input.timeWindowStart,
    input.timeWindowEnd,
  ].filter((part): part is string => part !== null && part !== "");
  const routeScopeKey = routeParts.join("|");
  const planningGroupKey =
    input.deliveryArea === null
      ? routeScopeKey
      : `${routeScopeKey}|${input.deliveryArea}`;
  return { planningGroupKey, routeScopeKey };
}

function recomputeReviewReasons(
  current: string[],
  input: {
    deliveryArea: string | null;
    deliveryDate: string | null;
    hasAddress: boolean;
    routeScopeKey: string | null;
    serviceType: DeliveryServiceType | null;
  },
): string[] {
  const kept = current.filter(
    (reason) =>
      ![
        "missing_address",
        "missing_delivery_area",
        "missing_delivery_date",
        "missing_route_scope",
        "delivery_day_unparsed",
        "delivery_date_weekday_mismatch",
        "delivery_date_weekday_unverified",
      ].includes(reason),
  );
  if (!input.hasAddress) kept.push("missing_address");
  if (input.deliveryArea === null) kept.push("missing_delivery_area");
  if (input.deliveryDate === null) kept.push("missing_delivery_date");
  if (input.routeScopeKey === null || input.serviceType === null)
    kept.push("missing_route_scope");
  return [...new Set(kept)];
}

function recomputeCoordinateReviewReasons(
  current: string[],
  input: {
    deliveryArea: string | null;
    deliveryDate: string | null;
    hasAddress: boolean;
    routeScopeKey: string | null;
    serviceType: DeliveryServiceType | null;
  },
): string[] {
  const kept = current.filter((reason) => reason !== "missing_coordinates");
  if (!input.hasAddress) kept.push("missing_address");
  if (input.deliveryArea === null) kept.push("missing_delivery_area");
  if (input.deliveryDate === null) kept.push("missing_delivery_date");
  if (input.routeScopeKey === null || input.serviceType === null)
    kept.push("missing_route_scope");
  return [...new Set(kept)];
}

function hasAddressFields(input: {
  address1: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
}): boolean {
  return [input.address1, input.city, input.countryCode, input.postalCode].some(
    (value) => value !== null && value.trim() !== "",
  );
}

function weekdayForDate(value: string | null): DeliveryWeekday | null {
  if (value === null) return null;
  const date = parseDateOnly(value);
  if (date === null) return null;
  return [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ][date.getUTCDay()] as DeliveryWeekday;
}

function toDeliveryStopWrite(
  input: SyncedOrderWithDeliveryStopInput["deliveryStop"],
): {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: Date | null;
  geocodeStatus: "PENDING" | "RESOLVED";
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
    throw new Error("delivery stop input required");
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
    timeWindowEnd: parseTorontoTimeWindow(
      input.deliveryDate,
      input.timeWindowEnd,
    ),
    timeWindowStart: parseTorontoTimeWindow(
      input.deliveryDate,
      input.timeWindowStart,
    ),
  };
}

function readSourceIdentity(input: SyncedOrderWithDeliveryStopInput["order"]): {
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: CommerceSourcePlatform;
  sourceSiteUrl: string | null;
  sourceUpdatedAt: Date;
} {
  const sourcePlatform = input.sourcePlatform ?? "SHOPIFY";
  return {
    sourceOrderId: input.sourceOrderId ?? input.shopifyOrderGid,
    sourceOrderNumber: input.sourceOrderNumber ?? input.name,
    sourcePlatform,
    sourceSiteUrl: input.sourceSiteUrl ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? input.updatedAtShopify,
  };
}

function toOrderWrite(input: SyncedOrderWithDeliveryStopInput["order"]): {
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
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: CommerceSourcePlatform;
  sourceSiteUrl: string | null;
  sourceUpdatedAt: Date | null;
  totalPriceAmount: string | null;
  updatedAtShopify: Date;
} {
  const sourceIdentity = readSourceIdentity(input);
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
    shippingAddress: toJson(
      readShippingAddressFromRawPayload(input.rawPayload),
    ),
    shopifyOrderGid: input.shopifyOrderGid,
    shopifyOrderLegacyId: input.shopifyOrderLegacyId,
    sourceOrderId: sourceIdentity.sourceOrderId,
    sourceOrderNumber: sourceIdentity.sourceOrderNumber,
    sourcePlatform: sourceIdentity.sourcePlatform,
    sourceSiteUrl: sourceIdentity.sourceSiteUrl,
    sourceUpdatedAt: sourceIdentity.sourceUpdatedAt,
    totalPriceAmount: input.totalPriceAmount,
    updatedAtShopify: input.updatedAtShopify,
  };
}

function toOrderDeliveryFactWrite(input: SyncedOrderDeliveryFactInput): {
  batchEligible: boolean;
  commerceConnectionId: string | null;
  computedAt: Date;
  deliveryArea: string | null;
  deliveryDate: Date | null;
  deliveryDateWeekday: string | null;
  deliveryDateWeekdayMismatch: boolean;
  deliveryDateWeekdayVerified: boolean;
  deliveryDayParseStatus: SyncedOrderDeliveryFactInput["deliveryDayParseStatus"];
  deliveryDayUnparsedReason: string | null;
  deliverySession: string | null;
  deliveryWeekday: string | null;
  geocodeStatus: SyncedOrderDeliveryFactInput["geocodeStatus"];
  mappingDiagnostics: Prisma.InputJsonValue;
  matchedMappingPaths: Prisma.InputJsonValue;
  planningGroupKey: string | null;
  rawDeliveryArea: string | null;
  rawDeliveryDate: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  rawPickupDay: string | null;
  readiness: SyncedOrderDeliveryFactInput["readiness"];
  reviewReasons: Prisma.InputJsonValue;
  routeScopeKey: string | null;
  serviceType: string | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: SyncedOrderDeliveryFactInput["sourcePlatform"];
  sourceSiteUrl: string | null;
  sourceUpdatedAt: Date | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
} {
  return {
    batchEligible: input.batchEligible,
    commerceConnectionId: input.commerceConnectionId ?? null,
    computedAt: input.computedAt ?? new Date(),
    deliveryArea: input.deliveryArea,
    deliveryDate: parseDateOnly(input.deliveryDate),
    deliveryDateWeekday: input.deliveryDateWeekday,
    deliveryDateWeekdayMismatch: input.deliveryDateWeekdayMismatch,
    deliveryDateWeekdayVerified: input.deliveryDateWeekdayVerified,
    deliveryDayParseStatus: input.deliveryDayParseStatus,
    deliveryDayUnparsedReason: input.deliveryDayUnparsedReason,
    deliverySession: input.deliverySession,
    deliveryWeekday: input.deliveryWeekday,
    geocodeStatus: input.geocodeStatus,
    mappingDiagnostics: toJson(input.mappingDiagnostics ?? {}),
    matchedMappingPaths: toJson(input.matchedMappingPaths),
    planningGroupKey: input.planningGroupKey,
    rawDeliveryArea: input.rawDeliveryArea,
    rawDeliveryDate: input.rawDeliveryDate,
    rawDeliveryDay: input.rawDeliveryDay,
    rawDeliveryTimeWindow: input.rawDeliveryTimeWindow,
    rawPickupDay: input.rawPickupDay,
    readiness: input.readiness,
    reviewReasons: toJson(input.reviewReasons),
    routeScopeKey: input.routeScopeKey,
    serviceType: input.serviceType,
    sourceOrderId: input.sourceOrderId,
    sourceOrderNumber: input.sourceOrderNumber,
    sourcePlatform: input.sourcePlatform,
    sourceSiteUrl: input.sourceSiteUrl,
    sourceUpdatedAt: input.sourceUpdatedAt,
    timeWindowEnd: parseTorontoTimeWindow(
      input.deliveryDate,
      input.timeWindowEnd,
    ),
    timeWindowStart: parseTorontoTimeWindow(
      input.deliveryDate,
      input.timeWindowStart,
    ),
  };
}

function readShippingAddressFromRawPayload(
  rawPayload: SyncedOrderWithDeliveryStopInput["order"]["rawPayload"],
): {
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
    countryCode:
      readString(shippingAddress?.countryCodeV2) ??
      readString(shippingAddress?.countryCode),
    postalCode:
      readString(shippingAddress?.zip) ??
      readString(shippingAddress?.postalCode),
    province: readString(shippingAddress?.province),
  };
}

function buildDeliveryMetadataDiagnostics(input: {
  deliveryDate: string | null;
  deliveryDateWeekday: string | null;
  deliveryWeekday: string | null;
  fact: DeliveryFactCanonicalRecord | null;
  raw: Record<string, unknown> | null;
  reviewReasons: string[];
  routeScopeKey: string | null;
  serviceType: string | null;
}): CanonicalOrderRow["deliveryMetadataDiagnostics"] {
  const diagnostics =
    objectOrNull(input.fact?.mappingDiagnostics) ??
    objectOrNull(input.raw?.mappingDiagnostics);
  const deliveryMetadata = objectOrNull(diagnostics?.deliveryMetadata);
  const rawCandidates = Array.isArray(deliveryMetadata?.candidates)
    ? deliveryMetadata.candidates
    : [];
  const candidates = rawCandidates.slice(0, 25).flatMap((value) => {
    const object = objectOrNull(value);
    if (object === null) return [];
    const path = readString(object.path);
    const parseStatus = readString(object.parseStatus);
    const valuePreview = readString(object.valuePreview);
    if (path === null || parseStatus === null || valuePreview === null)
      return [];
    const source = readString(object.source);
    const trust = readString(object.trust);
    return [
      {
        parseStatus,
        path: redactDiagnosticPath(path),
        ...(source === null ? {} : { source }),
        timeWindowEnd: readString(object.timeWindowEnd),
        timeWindowStart: readString(object.timeWindowStart),
        ...(trust === null ? {} : { trust }),
        valuePreview: redactDiagnosticValue(valuePreview, path) ?? "",
        weekday: readString(object.weekday),
      },
    ];
  });
  const unsupportedValues = Array.isArray(diagnostics?.unsupportedValues)
    ? diagnostics.unsupportedValues
    : [];
  const unsupportedValueCounts = unsupportedValues.reduce<
    Record<string, number>
  >((counts, value) => {
    const object = objectOrNull(value);
    const type = readString(object?.type) ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  const rawMatchedMappingPaths = readMatchedMappingPaths(
    input.fact?.matchedMappingPaths ?? input.raw?.matchedMappingPaths,
  );
  const matchedMappingPaths = redactMatchedMappingPaths(rawMatchedMappingPaths);
  return {
    candidates,
    conflictTimeWindows:
      readStringArray(deliveryMetadata?.conflictTimeWindows) ?? [],
    conflictWeekdays: readStringArray(deliveryMetadata?.conflictWeekdays) ?? [],
    current: {
      deliveryDate: input.deliveryDate,
      deliveryDateWeekday: input.deliveryDateWeekday,
      deliveryDayParseStatus:
        readString(input.fact?.deliveryDayParseStatus) ??
        readString(input.raw?.deliveryDayParseStatus),
      deliveryWeekday: input.deliveryWeekday,
      rawDeliveryDatePreview: redactDiagnosticValue(
        input.fact?.rawDeliveryDate ?? readString(input.raw?.deliveryDateRaw),
        rawMatchedMappingPaths.deliveryDate ?? "rawDeliveryDate",
      ),
      rawDeliveryDayPreview: redactDiagnosticValue(
        input.fact?.rawDeliveryDay ??
          readString(input.raw?.deliveryDayRaw) ??
          readString(input.raw?.deliveryDay),
        rawMatchedMappingPaths.deliveryDay ?? "rawDeliveryDay",
      ),
      rawDeliveryTimeWindowPreview: redactDiagnosticValue(
        input.fact?.rawDeliveryTimeWindow ??
          readString(input.raw?.deliveryTimeWindowRaw),
        rawMatchedMappingPaths.deliveryTimeWindow ?? "rawDeliveryTimeWindow",
      ),
      reviewReasons: input.reviewReasons,
      routeScopeKey: input.routeScopeKey,
      serviceType: input.serviceType,
      timeWindowEnd: readCanonicalTimeWindow({
        factTime: input.fact?.timeWindowEnd ?? null,
        part: "end",
        raw: input.raw,
        routeScopeKey: input.routeScopeKey,
      }),
      timeWindowStart: readCanonicalTimeWindow({
        factTime: input.fact?.timeWindowStart ?? null,
        part: "start",
        raw: input.raw,
        routeScopeKey: input.routeScopeKey,
      }),
    },
    matchedMappingPaths,
    status: readString(deliveryMetadata?.status) ?? "UNKNOWN",
    unsupportedValueCounts,
  };
}

function redactDiagnosticValue(
  value: string | null,
  path?: string | null,
): string | null {
  if (value === null) return null;
  if (isSensitiveDiagnosticPath(path)) return "[redacted-secret]";
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, "[redacted-phone]")
    .replace(
      /\b(?:consumer_secret|consumer_key|webhook_secret|token|cookie|password)\s*[:=]\s*\S+/giu,
      "[redacted-secret]",
    );
  return redacted.length > 96 ? `${redacted.slice(0, 93)}...` : redacted;
}

function isSensitiveDiagnosticPath(value: string | null | undefined): boolean {
  const normalized = readString(value)?.toLowerCase() ?? "";
  return /(?:consumer[_-]?secret|consumer[_-]?key|webhook[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|secret|password|cookie|authorization|auth[_-]?token)/u.test(
    normalized,
  );
}

function redactDiagnosticPath(value: string): string {
  return isSensitiveDiagnosticPath(value) ? "[redacted-sensitive-path]" : value;
}

function redactMatchedMappingPaths(
  value: Record<string, string | null>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [
      key,
      rawValue === null ? null : redactDiagnosticPath(rawValue),
    ]),
  );
}

function readMatchedMappingPaths(
  value: unknown,
): Record<string, string | null> {
  const object = objectOrNull(value);
  if (object === null) return {};
  return Object.fromEntries(
    Object.entries(object).map(([key, rawValue]) => [
      key,
      readString(rawValue),
    ]),
  );
}

function hasMetadataResolved(input: {
  deliveryDate: string | null;
  routeScopeKey: string | null;
  serviceType: string | null;
  reviewReasons: string[];
}): boolean {
  if (
    input.deliveryDate === null ||
    input.routeScopeKey === null ||
    input.serviceType === null
  )
    return false;
  const metadataBlockers = new Set([
    "missing_delivery_area",
    "missing_delivery_date",
    "missing_route_scope",
    "delivery_day_unparsed",
    "delivery_time_window_unparsed",
    "delivery_date_weekday_unverified",
    "ambiguous_delivery_day",
    "ambiguous_delivery_time_window",
    "delivery_date_weekday_mismatch",
    "missing_order_date",
  ]);
  return !input.reviewReasons.some((reason) => metadataBlockers.has(reason));
}

function toCanonicalOrderRow(order: CanonicalOrderRecord): CanonicalOrderRow {
  const stop = order.deliveryStops[0] ?? null;
  const fact = order.deliveryFacts?.[0] ?? null;
  const raw = objectOrNull(order.rawPayload);
  const shippingAddress = readShippingAddress(order.shippingAddress, stop);
  const latitude = decimalNumber(stop?.latitude);
  const longitude = decimalNumber(stop?.longitude);
  const hasCoordinates = latitude !== null && longitude !== null;
  const factReviewReasons = readStringArray(fact?.reviewReasons) ?? null;
  const reviewReasons =
    factReviewReasons ?? readStringArray(raw?.reviewReasons) ?? [];
  const readiness = readReadiness(
    fact?.readiness ?? raw?.readiness,
    order.cancelledAt,
    reviewReasons,
  );
  const planningStatus: PlanningStatus =
    (stop?.routePlanStops?.length ?? 0) > 0 ? "PLANNED" : "UNPLANNED";
  const routePlan = stop?.routePlanStops?.[0]?.routePlan ?? null;
  const deliveryDate =
    formatDateOnlyNullable(fact?.deliveryDate ?? null) ??
    readString(raw?.deliveryDate) ??
    formatDateOnlyNullable(stop?.deliveryDate ?? null);
  const deliveryDateWeekday = readString(
    fact?.deliveryDateWeekday ?? raw?.deliveryDateWeekday,
  );
  const deliveryWeekday = readDeliveryWeekday(
    fact?.deliveryWeekday ?? fact?.deliveryDateWeekday ?? raw?.deliveryWeekday,
  );
  const routeScopeKey = fact?.routeScopeKey ?? readString(raw?.routeScopeKey);
  const serviceType = readServiceType(fact?.serviceType ?? raw?.serviceType);
  const metadataResolved = hasMetadataResolved({
    deliveryDate,
    reviewReasons,
    routeScopeKey,
    serviceType,
  });
  const routeEligible =
    metadataResolved &&
    readiness === "READY_TO_PLAN" &&
    planningStatus === "UNPLANNED" &&
    routePlan === null &&
    hasCoordinates;
  const deliveryMetadataDiagnostics =
    buildDeliveryMetadataDiagnostics({
      deliveryDate,
      deliveryDateWeekday,
      deliveryWeekday,
      fact,
      raw,
      reviewReasons,
      routeScopeKey,
      serviceType,
    }) ?? null;

  return {
    cancelledAt: formatDateTime(order.cancelledAt),
    currencyCode: order.currencyCode,
    deliveryArea: fact?.deliveryArea ?? readString(raw?.deliveryArea),
    deliveryBatchEndDate: readString(raw?.deliveryBatchEndDate),
    deliveryBatchStartDate: readString(raw?.deliveryBatchStartDate),
    deliveryDate,
    deliveryDateSource: readDeliveryDateSource(raw?.deliveryDateSource),
    deliveryDayRaw:
      fact?.rawDeliveryDay ??
      readString(raw?.deliveryDayRaw) ??
      readString(raw?.deliveryDay),
    deliverySession: readDeliverySession(
      fact?.deliverySession ?? raw?.deliverySession,
    ),
    deliveryMetadataDiagnostics,
    deliveryStopId: stop?.id ?? null,
    deliveryStopStatus: stop?.status ?? null,
    deliveryWeekday,
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
    metadataResolved,
    orderId: order.id,
    phone: order.phone,
    pickup: readBoolean(raw?.pickup) ?? false,
    planningGroupKey:
      fact?.planningGroupKey ?? readString(raw?.planningGroupKey),
    planningStatus,
    processedAt: formatDateTime(order.processedAt),
    readiness,
    recipientName: stop?.recipientName ?? readString(raw?.recipientName),
    reviewReasons,
    routePlanId: routePlan?.id ?? null,
    routePlanName: routePlan?.name ?? null,
    routeEligible,
    routePlanStatus: routePlan?.status ?? null,
    routeScopeKey,
    serviceType,
    shippingAddress,
    shopifyOrderGid: order.shopifyOrderGid,
    shopifyOrderLegacyId:
      order.shopifyOrderLegacyId === null
        ? null
        : String(order.shopifyOrderLegacyId),
    sourceOrderId: order.sourceOrderId ?? null,
    sourceOrderNumber: order.sourceOrderNumber ?? null,
    sourcePlatform: order.sourcePlatform ?? "SHOPIFY",
    sourceSiteUrl: order.sourceSiteUrl ?? null,
    sourceUpdatedAt: formatDateTime(
      order.sourceUpdatedAt ?? order.updatedAtShopify,
    ),
    timeWindowEnd: readCanonicalTimeWindow({
      factTime: fact?.timeWindowEnd ?? stop?.timeWindowEnd ?? null,
      part: "end",
      raw,
      routeScopeKey,
    }),
    timeWindowStart: readCanonicalTimeWindow({
      factTime: fact?.timeWindowStart ?? stop?.timeWindowStart ?? null,
      part: "start",
      raw,
      routeScopeKey,
    }),
    totalPriceAmount: decimalLikeString(order.totalPriceAmount),
    updatedAtShopify: formatDateTime(order.updatedAtShopify),
  };
}

function readReadiness(
  value: unknown,
  cancelledAt: Date | null,
  reviewReasons: string[],
): CanonicalOrderReadiness {
  const text = readString(value);
  if (
    text === "READY_TO_PLAN" ||
    text === "NEEDS_REVIEW" ||
    text === "SKIPPED"
  ) {
    return text;
  }
  return cancelledAt === null && reviewReasons.length === 0
    ? "READY_TO_PLAN"
    : "NEEDS_REVIEW";
}

function readShippingAddress(
  value: unknown,
  fallback: DeliveryStopRecord | null,
): CanonicalOrderRow["shippingAddress"] {
  const object = objectOrNull(value);
  return {
    address1: fallback?.address1 ?? readString(object?.address1) ?? null,
    address2: fallback?.address2 ?? readString(object?.address2) ?? null,
    city: fallback?.city ?? readString(object?.city) ?? null,
    countryCode:
      fallback?.countryCode ?? readString(object?.countryCode) ?? null,
    postalCode: fallback?.postalCode ?? readString(object?.postalCode) ?? null,
    province: fallback?.province ?? readString(object?.province) ?? null,
  };
}

function readDeliveryWeekday(value: unknown): DeliveryWeekday | null {
  return value === "SUNDAY" ||
    value === "MONDAY" ||
    value === "TUESDAY" ||
    value === "WEDNESDAY" ||
    value === "THURSDAY" ||
    value === "FRIDAY" ||
    value === "SATURDAY"
    ? value
    : null;
}

function readServiceType(value: unknown): DeliveryServiceType | null {
  return value === "DELIVERY" ||
    value === "EVENING_DELIVERY" ||
    value === "PICKUP"
    ? value
    : null;
}

function readDeliverySession(
  value: unknown,
): CanonicalOrderRow["deliverySession"] {
  return value === "DAY" || value === "EVENING" || value === "PICKUP"
    ? value
    : null;
}

function readDeliveryDateSource(
  value: unknown,
): CanonicalOrderRow["deliveryDateSource"] {
  return value === "EXPLICIT_ATTRIBUTE" ||
    value === "LINE_ITEM_DATE_RANGE" ||
    value === "ORDER_DATE_CYCLE_RULE" ||
    value === "MISSING"
    ? value
    : null;
}

function parseDateOnly(value: string | null): Date | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function parseTorontoTimeWindow(
  deliveryDate: string | null,
  time: string | null,
): Date | null {
  if (deliveryDate === null || time === null) return null;
  if (!/^\d{2}:\d{2}$/u.test(time)) return null;
  return zonedTimeToUtc(deliveryDate, time, "America/Toronto");
}

function zonedTimeToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const dateParts = date.split("-").map(Number);
  const timeParts = time.split(":").map(Number);
  const year = dateParts[0];
  const month = dateParts[1];
  const day = dateParts[2];
  const hour = timeParts[0];
  const minute = timeParts[1];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  )
    return null;
  if ([year, month, day, hour, minute].some((part) => Number.isNaN(part)))
    return null;
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    }).formatToParts(utc);
    const localYear = Number(parts.find((part) => part.type === "year")?.value);
    const localMonth = Number(
      parts.find((part) => part.type === "month")?.value,
    );
    const localDay = Number(parts.find((part) => part.type === "day")?.value);
    const localHour = Number(parts.find((part) => part.type === "hour")?.value);
    const localMinute = Number(
      parts.find((part) => part.type === "minute")?.value,
    );
    const localAsUtc = Date.UTC(
      localYear,
      localMonth - 1,
      localDay,
      localHour,
      localMinute,
      0,
    );
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    utc = new Date(utc.getTime() + (targetAsUtc - localAsUtc));
  }
  return utc;
}

function formatDateOnlyNullable(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function formatTimeOnlyNullable(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(11, 16);
}

function readCanonicalTimeWindow(input: {
  factTime: Date | null;
  part: "start" | "end";
  raw: Record<string, unknown> | null;
  routeScopeKey: string | null;
}): string | null {
  const rawKey =
    input.part === "start" ? "timeWindowStart" : "timeWindowEnd";
  return (
    readRouteScopeTime(input.routeScopeKey, input.part) ??
    readString(input.raw?.[rawKey]) ??
    formatTimeOnlyNullable(input.factTime)
  );
}

function readRouteScopeTime(
  routeScopeKey: string | null,
  part: "start" | "end",
): string | null {
  if (routeScopeKey === null) return null;
  const pieces = routeScopeKey.split("|");
  const value = pieces[part === "start" ? 2 : 3] ?? "";
  return /^\d{2}:\d{2}$/u.test(value) ? value : null;
}

function readGeocodeStatus(value: unknown): CanonicalOrderRow["geocodeStatus"] {
  return value === "NOT_REQUIRED" || value === "RESOLVED" || value === "FAILED"
    ? value
    : "PENDING";
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function decimalLikeString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value instanceof Prisma.Decimal) {
    return value.toString();
  }
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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

function normalizeShopDomain(
  value: string,
  options: { allowAnyDomain?: boolean } = {},
): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = readHostLikeValue(trimmed);

  if (options.allowAnyDomain === true) {
    if (!isValidHostLikeValue(withoutProtocol)) {
      throw new Error("Shop domain is not a valid host name");
    }
    return withoutProtocol;
  }

  if (!withoutProtocol.endsWith(".myshopify.com")) {
    throw new Error("Shop domain must end with .myshopify.com");
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error("Shop domain is not a valid myshopify.com domain");
  }

  return withoutProtocol;
}

function readHostLikeValue(value: string): string {
  if (/^https?:\/\//u.test(value)) {
    return new URL(value).host;
  }
  return value.replace(/\/$/u, "");
}

function isValidHostLikeValue(value: string): boolean {
  const [host, port] = splitHostAndPort(value);
  if (
    port !== null &&
    (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
  ) {
    return false;
  }
  return (
    host === "localhost" ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) ||
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      host,
    )
  );
}

function splitHostAndPort(value: string): [string, string | null] {
  const match = /^(?<host>.+):(?<port>\d+)$/u.exec(value);
  if (
    match?.groups === undefined ||
    match.groups.host === undefined ||
    match.groups.port === undefined
  ) {
    return [value, null];
  }
  return [match.groups.host, match.groups.port];
}
