import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ITEM_REVIEW_REASONS,
  aggregateOrderItems,
  toOrderItemDto,
  type OrderItemDto,
  type OrderItemRecordLike
} from '../order-items/order-items.js';

import {
  RoutePlanBatchInvalidError,
  RoutePlanConflictError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanOptionsUpdateInvalidError,
  RoutePlanPublishInvalidError,
  RoutePlanStopUpdateInvalidError
} from './route-plan.types.js';
import { assertSafeRouteScopeToken } from '../route-ops/route-scope-config.js';
import type {
  RoutePlanDepotInput,
  RoutePlanDetail,
  RoutePlanDetailStop,
  RoutePlanDriverSummary,
  RoutePlanEndMode,
  ListRoutePlansInput,
  RoutePlanOrderAttributeInput,
  RoutePlanOrderInput,
  PublishRoutePlanInput,
  SaveRoutePlanInput,
  SaveRoutePlanOperation,
  SaveRoutePlanResult,
  UpdateRoutePlanDriverInput,
  UpdateRoutePlanOptionsInput,
  UpdateRoutePlanStopsInput,
  RoutePlanShippingAddressInput,
  RoutePlanRouteScopeInput,
  RoutePlanSummary
} from './route-plan.types.js';
import { applyCachedRouteGeometry, computeRouteShapeSignature, routeGeometryCacheUpsertArgs } from './route-plan-geometry-cache.js';
import type { RouteGeometryCacheRead, RouteGeometryCacheWrite } from './route-plan-geometry-cache.js';
import type { RoutePlanRepository } from './route-plan.service.js';
import { readNormalizedPaymentStatus } from '../payments/normalized-payment-status.js';
import { appScopedShopWhere, normalizeShopifyAppId } from '../shopify/shopify-app-scope.js';

const DEFAULT_API_VERSION = '2026-04';
const OPTIMIZER_VERSION = 'manual-sequence-mvp';
const DEFAULT_ROUTE_END_MODE: RoutePlanEndMode = 'END_AT_LAST_STOP';

type RoutePlanPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'deliveryStop' | 'driver' | 'order' | 'orderDeliveryFact' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop' | 'shop'
>;

type RoutePlanGeometryCacheRecord = {
  generatedAt: Date;
  geometry: unknown;
  metrics: unknown;
  provider: string;
  providerVersion: string | null;
  shapeSignature: string;
  source: string;
  stopPoints: unknown;
};

type RoutePlanGeometryCacheMetadataRecord = Omit<RoutePlanGeometryCacheRecord, 'geometry' | 'metrics' | 'stopPoints'>;

type RoutePlanRecord = {
  createdAt: Date;
  constraints?: unknown;
  deliveryDate?: Date | null;
  depotLatitude: unknown;
  depotLongitude: unknown;
  driver?: RoutePlanDriverRecord | null;
  driverId?: string | null;
  id: string;
  metrics: unknown;
  name: string;
  planDate: Date;
  routeGroupingChildVersions?: RouteGroupingChildVersionRecord[];
  routeStops?: RoutePlanStopRecord[];
  status: string;
  updatedAt: Date;
};

type RouteGroupingChildVersionRecord = {
  groupingId: string;
  status: string;
  version: number;
};

type RoutePlanDriverRecord = {
  _count?: { driverEvents?: number };
  authSubject: string | null;
  createdAt: Date;
  displayName: string;
  id: string;
  lastSeenAt: Date | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  updatedAt: Date;
};

type RoutePlanStopRecord = {
  deliveryStop: DeliveryStopRecord;
  deliveryStopId: string;
  distanceFromPreviousMeters: number | null;
  durationFromPreviousSeconds: number | null;
  estimatedArrivalAt: Date | null;
  sequence: number;
};

type DeliveryStopRecord = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate?: Date | null;
  id: string;
  latitude: unknown;
  longitude: unknown;
  order: OrderRecord;
  orderId: string;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
  routePlanStops?: Array<{ id: string }>;
  status: string;
};

type OrderRecord = {
  currencyCode?: string | null;
  deliveryStops?: DeliveryStopRecord[];
  email?: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  id: string;
  name: string;
  orderItems?: OrderItemRecordLike[];
  deliveryCustomerProfileLinks?: Array<{ matchReasons: unknown; matchStatus: string; profile: { adminMemo: string | null; id: string } }>;
  phone?: string | null;
  rawPayload: unknown;
  shippingAddress: unknown;
  shopifyOrderGid: string;
  totalPriceAmount?: unknown;
};

type OrderDeliveryFactRecord = {
  deliveryArea: string | null;
  deliveryDate: Date | null;
  deliveryDateWeekday: string | null;
  deliveryDateWeekdayMismatch: boolean;
  deliveryDateWeekdayVerified: boolean;
  deliveryDayParseStatus: string;
  deliverySession: string | null;
  deliveryWeekday: string | null;
  geocodeStatus: string;
  order: {
    deliveryStops?: DeliveryFactStopRecord[];
    name: string;
    orderItems?: OrderItemRecordLike[];
  };
  orderId: string;
  planningGroupKey: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  readiness: string;
  reviewReasons: unknown;
  routeScopeKey: string | null;
  serviceType: string | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  sourcePlatform: string;
  sourceSiteUrl: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
};

type DeliveryFactStopRecord = {
  id: string;
  latitude: unknown;
  longitude: unknown;
  routePlanStops?: Array<{ id: string }>;
};

type RoutePlanShopRecord = {
  defaultDepotAddress?: string | null;
  defaultDepotLatitude?: unknown;
  defaultDepotLongitude?: unknown;
  id: string;
};

export class PrismaRoutePlanRepository implements RoutePlanRepository {
  constructor(
    private readonly prisma: RoutePlanPrismaClient,
    private readonly options: { allowAnyShopDomain?: boolean } = {}
  ) {}

  async assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);
    const driverId = input.payload.driverId;

    const assigned = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: { id: true },
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        return false;
      }

      const routePlan = await tx.routePlan.findFirst({
        select: { id: true },
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      });
      if (routePlan === null) {
        return false;
      }

      if (driverId !== null) {
        const driver = await tx.driver.findFirst({
          select: { id: true },
          where: {
            id: driverId,
            shopId: shop.id
          }
        });
        if (driver === null) {
          throw new RoutePlanDriverAssignInvalidError('Route driver must belong to the current shop.');
        }
      }

      await tx.routePlan.update({
        data: { driverId },
        where: { id: routePlan.id }
      });

      return true;
    });

    if (!assigned) {
      return null;
    }

    return this.findRoutePlanDetail({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
  }

  async publishRoutePlan(input: PublishRoutePlanInput): Promise<RoutePlanDetail | null> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);

    const published = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: { id: true },
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        return false;
      }

      const routePlan = (await tx.routePlan.findFirst({
        include: routePlanInclude(),
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      })) as RoutePlanRecord | null;
      if (routePlan === null) {
        return false;
      }

      if (routePlan.status === 'CANCELLED' || routePlan.status === 'COMPLETED') {
        throw new RoutePlanPublishInvalidError('Completed or cancelled routes cannot be published to drivers.');
      }

      if (routePlan.driverId === null) {
        throw new RoutePlanPublishInvalidError('Assign a driver before publishing this route.');
      }

      if (routePlanStopCount(routePlan) === 0) {
        throw new RoutePlanPublishInvalidError('Add at least one stop before publishing this route.');
      }

      const currentItemSummary = aggregateOrderItems(
        routeItemDtosFromRouteStops(routePlan.routeStops ?? []),
        readString(objectOrNull(routePlan.metrics)?.itemFingerprint)
      );
      if (routePlan.status !== 'DRAFT' && currentItemSummary.changedSincePublish) {
        throw new RoutePlanPublishInvalidError('Route items changed after publish. Review the route before publishing again.');
      }

      if (routePlan.status === 'DRAFT') {
        await tx.routePlan.update({
          data: {
            metrics: toJson({
              ...objectOrEmpty(routePlan.metrics),
              itemFingerprint: currentItemSummary.fingerprint
            }),
            status: 'ASSIGNED'
          },
          where: { id: routePlan.id }
        });
      }

      return true;
    });

    if (!published) {
      return null;
    }

    return this.findRoutePlanDetail({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
  }

  async saveRoutePlan(input: SaveRoutePlanInput): Promise<SaveRoutePlanResult | null> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);
    const normalizedStops =
      input.payload.stops === undefined ? undefined : normalizeStopUpdateInputs(input.payload.stops);
    if (input.payload.stops !== undefined) {
      assertNoDuplicateStopUpdateInputs(input.payload.stops);
    }

    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: shopDepotSelect(),
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        return null;
      }

      let routePlan = (await tx.routePlan.findFirst({
        include: routePlanInclude(),
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      })) as RoutePlanRecord | null;
      if (routePlan === null) {
        return null;
      }

      const initialDriverId = routePlan.driverId ?? routePlan.driver?.id ?? null;
      const initialRouteStatus = routePlan.status;
      const hasShapePayload = input.payload.routeEndMode !== undefined || input.payload.stops !== undefined;
      const hasDepartureTimePayload = Object.hasOwn(input.payload, 'departureTime');
      const nextDepartureTime = hasDepartureTimePayload ? input.payload.departureTime ?? null : null;
      const willRepairDraftDepot =
        hasShapePayload &&
        initialRouteStatus === 'DRAFT' &&
        readDepotFromRoutePlan(routePlan) === null &&
        readDepotFromShopDefaults(shop) !== null;
      const hasRouteEndModeChange =
        input.payload.routeEndMode !== undefined &&
        readRouteEndMode(routePlan.constraints) !== input.payload.routeEndMode;
      const hasStopSequenceChange =
        input.payload.stops !== undefined &&
        normalizedStops !== undefined &&
        !sameStopSequenceRecord(routePlan, input.payload.stops);
      const hasDriverPayload = Object.hasOwn(input.payload, 'driverId');
      const nextDriverId = hasDriverPayload ? input.payload.driverId ?? null : null;
      const hasDriverChange = hasDriverPayload && initialDriverId !== nextDriverId;
      const hasDepartureTimeChange =
        hasDepartureTimePayload && readDepartureTime(routePlan.constraints) !== nextDepartureTime;
      const hasRouteMutation =
        willRepairDraftDepot ||
        hasRouteEndModeChange ||
        hasStopSequenceChange ||
        hasDriverChange ||
        hasDepartureTimeChange;

      if (input.payload.expectedUpdatedAt !== undefined && hasRouteMutation) {
        const claimed = await tx.routePlan.updateMany({
          data: { updatedAt: new Date() },
          where: {
            id: routePlan.id,
            shopId: shop.id,
            updatedAt: parseExpectedRoutePlanUpdatedAt(input.payload.expectedUpdatedAt)
          }
        });
        if (claimed.count !== 1) {
          throw new RoutePlanConflictError();
        }
      }

      if (willRepairDraftDepot) {
        routePlan = await repairDraftDepotIfMissingInTransaction(tx, routePlan, shop);
      }

      const operations: SaveRoutePlanOperation[] = [];
      let driverId = routePlan.driverId ?? routePlan.driver?.id ?? null;
      const routeStatus = routePlan.status;
      let stopCount = routePlan.routeStops?.length ?? 0;

      if (input.payload.routeEndMode !== undefined) {
        if (!hasRouteEndModeChange) {
          operations.push({ name: 'options', reason: 'unchanged', status: 'skipped' });
        } else {
          const currentDepot = readDepotFromRoutePlan(routePlan);
          const defaultDepot = readDepotFromShopDefaults(shop);
          const effectiveDepot = currentDepot ?? defaultDepot;
          if (input.payload.routeEndMode === 'RETURN_TO_DEPOT' && effectiveDepot === null) {
            throw new RoutePlanOptionsUpdateInvalidError('Return-to-store routing requires default depot coordinates.');
          }

          const constraints = updateConstraintsRouteEndMode(routePlan.constraints, input.payload.routeEndMode, effectiveDepot);
          const depotPatch =
            currentDepot === null && defaultDepot !== null
              ? {
                  depotLatitude: decimalString(defaultDepot.latitude),
                  depotLongitude: decimalString(defaultDepot.longitude)
                }
              : {};
          await tx.routePlan.update({
            data: {
              ...depotPatch,
              constraints
            },
            where: { id: routePlan.id }
          });
          routePlan = {
            ...routePlan,
            ...depotPatch,
            constraints
          };
          operations.push({ name: 'options', reason: 'route_end_mode_changed', status: 'applied' });
        }
      } else {
        operations.push({ name: 'options', reason: 'not_provided', status: 'skipped' });
      }

      if (hasDepartureTimePayload) {
        if (!hasDepartureTimeChange) {
          operations.push({ name: 'departure_time', reason: 'unchanged', status: 'skipped' });
        } else {
          const constraints = updateConstraintsDepartureTime(routePlan.constraints, nextDepartureTime);
          await tx.routePlan.update({
            data: { constraints },
            where: { id: routePlan.id }
          });
          routePlan = { ...routePlan, constraints };
          operations.push({ name: 'departure_time', reason: nextDepartureTime === null ? 'cleared' : 'changed', status: 'applied' });
        }
      }

      if (input.payload.stops !== undefined && normalizedStops !== undefined) {
        if (!hasStopSequenceChange) {
          operations.push({ name: 'stops', reason: 'unchanged', status: 'skipped' });
        } else {
          const routeDate = deriveRouteDate(routePlan);
          const orderGids = normalizedStops.map((stop) => stop.shopifyOrderGid);
          const orders = (await tx.order.findMany({
            include: {
              deliveryStops: {
                take: 1
              },
              orderItems: {
                orderBy: { lineIndex: 'asc' }
              }
            },
            where: {
              shopId: shop.id,
              shopifyOrderGid: { in: orderGids }
            }
          })) as unknown as OrderRecord[];
          const ordersByGid = new Map(orders.map((order) => [order.shopifyOrderGid, order]));
          const missingOrderGids = orderGids.filter((gid) => !ordersByGid.has(gid));
          if (missingOrderGids.length > 0) {
            throw new RoutePlanStopUpdateInvalidError('Route stops can only include orders from the current shop.');
          }

          const wrongDateOrders = normalizedStops.filter((stop) => {
            const order = ordersByGid.get(stop.shopifyOrderGid);
            return order !== undefined && readOrderDeliveryDate(order) !== routeDate;
          });
          if (wrongDateOrders.length > 0) {
            throw new RoutePlanStopUpdateInvalidError(
              'Route stops must share the same delivery date as the route. Choose orders for the route delivery date before saving stops.'
            );
          }

          const deliveryStopIds: string[] = [];
          for (const stopInput of normalizedStops) {
            const order = ordersByGid.get(stopInput.shopifyOrderGid);
            if (order === undefined) {
              throw new RoutePlanStopUpdateInvalidError('Route stops can only include orders from the current shop.');
            }

            if (stopInput.deliveryStopId !== null) {
              const deliveryStop = await tx.deliveryStop.findFirst({
                where: {
                  id: stopInput.deliveryStopId,
                  orderId: order.id,
                  shopId: shop.id
                }
              });
              if (deliveryStop === null) {
                throw new RoutePlanStopUpdateInvalidError('Route stop does not belong to the selected order.');
              }
              deliveryStopIds.push(deliveryStop.id);
              continue;
            }

            const deliveryStop = await tx.deliveryStop.upsert({
              create: {
                ...toDeliveryStopWriteFromOrder(order, routeDate),
                orderId: order.id,
                shopId: shop.id
              },
              update: toDeliveryStopWriteFromOrder(order, routeDate),
              where: {
                shopId_orderId: {
                  orderId: order.id,
                  shopId: shop.id
                }
              }
            });
            deliveryStopIds.push(deliveryStop.id);
          }

          const stopsAssignedElsewhere = await tx.routePlanStop.findMany({
            select: { deliveryStopId: true },
            where: {
              deliveryStopId: { in: deliveryStopIds },
              routePlanId: { not: input.routePlanId },
              routePlan: { shopId: shop.id }
            }
          });
          if (stopsAssignedElsewhere.length > 0) {
            throw new RoutePlanOrderAlreadyPlannedError();
          }

          await tx.routePlanStop.deleteMany({
            where: { routePlanId: input.routePlanId }
          });

          if (deliveryStopIds.length > 0) {
            await tx.routePlanStop.createMany({
              data: deliveryStopIds.map((deliveryStopId, index) => ({
                deliveryStopId,
                routePlanId: input.routePlanId,
                sequence: index + 1
              }))
            });
          }

          const latestMetrics = routeMetricsForStatus({
            existingMetrics: routePlan.metrics,
            nextMetrics: createMetricsFromOrders(ordersByGid, orderGids, deliveryStopIds.length),
            status: routeStatus
          });
          await tx.routePlan.update({
            data: {
              metrics: latestMetrics
            },
            where: { id: input.routePlanId }
          });
          stopCount = deliveryStopIds.length;
          operations.push({ name: 'stops', reason: 'sequence_changed', status: 'applied' });
        }
      } else {
        operations.push({ name: 'stops', reason: 'not_provided', status: 'skipped' });
      }

      if (hasDriverPayload) {
        if (!hasDriverChange) {
          operations.push({ name: 'driver', reason: 'unchanged', status: 'skipped' });
        } else {
          if (nextDriverId !== null) {
            const driver = await tx.driver.findFirst({
              select: { id: true },
              where: {
                id: nextDriverId,
                shopId: shop.id
              }
            });
            if (driver === null) {
              throw new RoutePlanDriverAssignInvalidError('Route driver must belong to the current shop.');
            }
          }

          await tx.routePlan.update({
            data: { driverId: nextDriverId },
            where: { id: routePlan.id }
          });
          driverId = nextDriverId;
          operations.push({ name: 'driver', reason: driverId === null ? 'driver_cleared' : 'driver_changed', status: 'applied' });
        }
      } else {
        operations.push({ name: 'driver', reason: 'not_provided', status: 'skipped' });
      }

      operations.push({
        name: 'publish',
        reason: publishSkipReasonFromState(routeStatus, driverId, stopCount),
        status: 'skipped'
      });

      const updatedRoutePlan = (await tx.routePlan.findFirst({
        include: routePlanInclude(),
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      })) as RoutePlanRecord | null;
      if (updatedRoutePlan === null) {
        return null;
      }

      return {
        detail: await applyRouteGeometryCache(tx, toRoutePlanDetail(updatedRoutePlan)),
        operations
      };
    });
  }

  async createRoutePlanDraft(input: {
    createdBy: string;
    depot: RoutePlanDepotInput;
    name: string;
    orders: RoutePlanOrderInput[];
    planDate: string;
    routeScope?: RoutePlanRouteScopeInput;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanSummary> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);
    const planDate = parsePlanDate(input.planDate);
    const metrics = createMetrics(input.orders);
    assertNoDuplicateOrderInputs(input.orders);

    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.upsert({
        create: {
          apiVersion: DEFAULT_API_VERSION,
          appId: normalizeShopifyAppId(input.appId),
          shopDomain
        },
        select: shopDepotSelect(),
        update: {},
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      const effectiveDepot = resolveEffectiveDepot(input.depot, shop);
      const constraints = createConstraints(effectiveDepot, input.routeScope);
      const deliveryStopIds: string[] = [];

      for (const orderInput of input.orders) {
        const order = await tx.order.upsert({
          create: {
            ...toOrderWrite(orderInput),
            shopId: shop.id
          },
          update: toOrderWrite(orderInput),
          where: {
            shopId_shopifyOrderGid: {
              shopId: shop.id,
              shopifyOrderGid: orderInput.shopifyOrderGid
            }
          }
        });
        if (orderInput.items !== undefined) {
          await tx.orderItem.deleteMany({ where: { orderId: order.id, shopId: shop.id } });
          if (orderInput.items.length > 0) {
            await tx.orderItem.createMany({
              data: orderInput.items.map((item, index) => ({
                lineIndex: index,
                name: item.name,
                options: toJson(item.options),
                orderId: order.id,
                productId: item.productId,
                quantity: item.quantity,
                shopId: shop.id,
                sku: item.sku,
                variationId: item.variationId
              }))
            });
          }
        }
        const deliveryStop = await tx.deliveryStop.upsert({
          create: {
            ...toDeliveryStopWrite(orderInput, planDate, input.routeScope),
            orderId: order.id,
            shopId: shop.id
          },
          update: toDeliveryStopWrite(orderInput, planDate, input.routeScope),
          where: {
            shopId_orderId: {
              orderId: order.id,
              shopId: shop.id
            }
          }
        });

        deliveryStopIds.push(deliveryStop.id);
      }

      const existingRoutePlanStops = await tx.routePlanStop.findMany({
        select: { deliveryStopId: true },
        where: {
          deliveryStopId: { in: deliveryStopIds },
          routePlan: { shopId: shop.id }
        }
      });

      if (existingRoutePlanStops.length > 0) {
        const duplicateDeliveryStopIds = new Set(
          existingRoutePlanStops.map((routeStop) => routeStop.deliveryStopId)
        );
        const duplicateOrderNames = input.orders
          .filter((_, orderIndex) => duplicateDeliveryStopIds.has(deliveryStopIds[orderIndex] ?? ''))
          .map((order) => order.name);

        throw new RoutePlanOrderAlreadyPlannedError(duplicateOrderNames);
      }

      const routePlan = await tx.routePlan.create({
        data: {
          constraints,
          createdBy: input.createdBy,
          depotLatitude: decimalString(effectiveDepot.latitude),
          depotLongitude: decimalString(effectiveDepot.longitude),
          metrics,
          name: input.name,
          optimizerVersion: OPTIMIZER_VERSION,
          planDate,
          shopId: shop.id,
          status: 'DRAFT'
        }
      });

      await tx.routePlanStop.createMany({
        data: deliveryStopIds.map((deliveryStopId, index) => ({
          deliveryStopId,
          routePlanId: routePlan.id,
          sequence: index + 1
        }))
      });

      return toRoutePlanSummary(routePlan, input.orders);
    });
  }

  async createRoutePlanDraftFromOrderIds(input: {
    createdBy: string;
    depot: RoutePlanDepotInput;
    name: string;
    orderIds: string[];
    planDate: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanSummary> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);
    const planDate = parsePlanDate(input.planDate);
    const orderIds = normalizeSelectedOrderIds(input.orderIds);

    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: shopDepotSelect(),
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        throw new RoutePlanBatchInvalidError(['shop not found']);
      }

      const facts = (await tx.orderDeliveryFact.findMany({
        include: {
          order: {
            include: {
              deliveryStops: {
                include: {
                  routePlanStops: {
                    select: { id: true }
                  }
                },
                take: 1
              },
              orderItems: {
                orderBy: { lineIndex: 'asc' }
              }
            }
          }
        },
        where: {
          orderId: { in: orderIds },
          shopId: shop.id
        }
      })) as OrderDeliveryFactRecord[];

      const blockers = validateFactsForRouteCreation({
        facts,
        orderIds,
        planDate: input.planDate
      });
      if (blockers.length > 0) {
        throw new RoutePlanBatchInvalidError(blockers);
      }

      const orderedFacts = orderIds.map((orderId) => facts.find((fact) => fact.orderId === orderId)).filter((fact): fact is OrderDeliveryFactRecord => fact !== undefined);
      const first = orderedFacts[0];
      if (first === undefined || first.routeScopeKey === null || first.deliverySession === null || first.serviceType === null) {
        throw new RoutePlanBatchInvalidError(['selected orders do not have a route scope']);
      }
      const routeScope: RoutePlanRouteScopeInput = {
        deliveryDate: input.planDate,
        deliverySession: readRouteScopeDeliverySession(first.deliverySession),
        routeScopeKey: first.routeScopeKey,
        serviceType: readRouteScopeServiceType(first.serviceType),
        timeWindowEnd: readRouteScopeTime(first.routeScopeKey, 'end') ?? formatTimeOnlyNullable(first.timeWindowEnd),
        timeWindowStart: readRouteScopeTime(first.routeScopeKey, 'start') ?? formatTimeOnlyNullable(first.timeWindowStart)
      };
      const deliveryStopIds = orderedFacts.map((fact) => fact.order.deliveryStops?.[0]?.id).filter((id): id is string => id !== undefined);
      const metrics = createMetricsFromFacts(orderedFacts);
      const effectiveDepot = resolveEffectiveDepot(input.depot, shop);
      const constraints = createConstraints(effectiveDepot, routeScope);

      const routePlan = await tx.routePlan.create({
        data: {
          constraints,
          createdBy: input.createdBy,
          depotLatitude: decimalString(effectiveDepot.latitude),
          depotLongitude: decimalString(effectiveDepot.longitude),
          metrics,
          name: input.name,
          optimizerVersion: OPTIMIZER_VERSION,
          planDate,
          shopId: shop.id,
          status: 'DRAFT'
        }
      });

      await tx.routePlanStop.createMany({
        data: deliveryStopIds.map((deliveryStopId, index) => ({
          deliveryStopId,
          routePlanId: routePlan.id,
          sequence: index + 1
        }))
      });

      return {
        ...toRoutePlanSummary(routePlan),
        itemSummary: aggregateOrderItems(orderedFacts.flatMap((fact) =>
          (fact.order.orderItems ?? []).map((item) => toOrderItemDto(item))
        ))
      };
    });
  }

  async listRoutePlans(input: ListRoutePlansInput): Promise<RoutePlanSummary[]> {
    const shop = await this.findShop(input);
    if (shop === null) {
      return [];
    }

    const where: Prisma.RoutePlanWhereInput = {
      shopId: shop.id,
      ...(input.deliveryDate === undefined ? {} : { planDate: parsePlanDate(input.deliveryDate) })
    };
    const routePlans = await this.prisma.routePlan.findMany({
      include: routePlanSummaryInclude(),
      orderBy: { createdAt: 'desc' },
      where
    });

    return (routePlans as RoutePlanRecord[]).map((routePlan) => toRoutePlanSummary(routePlan));
  }

  async findRoutePlanDetail(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null> {
    const shop = await this.findShop(input);
    if (shop === null) {
      return null;
    }

    const routePlan = await this.prisma.routePlan.findFirst({
      include: routePlanInclude(),
      where: {
        id: input.routePlanId,
        shopId: shop.id
      }
    });

    if (routePlan === null) {
      return null;
    }

    return this.applyRouteGeometryCache(toRoutePlanDetail(routePlan));
  }

  async routePlanExists(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<boolean> {
    const shop = await this.findShop(input);
    if (shop === null) {
      return false;
    }
    const routePlan = await this.prisma.routePlan.findFirst({
      select: { id: true },
      where: {
        id: input.routePlanId,
        shopId: shop.id
      }
    });
    return routePlan !== null;
  }

  async upsertRouteGeometryCache(input: RouteGeometryCacheWrite): Promise<void> {
    await this.prisma.routePlanGeometryCache.upsert(routeGeometryCacheUpsertArgs(input));
  }

  private applyRouteGeometryCache(detail: RoutePlanDetail): Promise<RoutePlanDetail> {
    return applyRouteGeometryCache(this.prisma, detail);
  }

  async deleteRoutePlan(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<{ routePlanId: string; deleted: boolean }> {
    const shop = await this.findShop(input);
    if (shop === null) {
      return { routePlanId: input.routePlanId, deleted: false };
    }

    const routePlan = await this.prisma.routePlan.findFirst({
      select: { id: true },
      where: {
        id: input.routePlanId,
        shopId: shop.id
      }
    });

    if (routePlan === null) {
      return { routePlanId: input.routePlanId, deleted: false };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.routePlanStop.deleteMany({
        where: { routePlanId: input.routePlanId }
      });
      await tx.routePlan.delete({
        where: { id: input.routePlanId }
      });
    });

    return { routePlanId: input.routePlanId, deleted: true };
  }

  async updateRoutePlanOptions(input: UpdateRoutePlanOptionsInput): Promise<RoutePlanDetail | null> {
    const shopDomain = this.normalizeShopDomain(input.shopDomain);
    const routeEndMode = input.payload.routeEndMode;

    const updated = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: shopDepotSelect(),
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        return false;
      }

      const routePlan = (await tx.routePlan.findFirst({
        select: {
          constraints: true,
          depotLatitude: true,
          depotLongitude: true,
          id: true,
          status: true
        },
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      })) as Pick<RoutePlanRecord, 'constraints' | 'depotLatitude' | 'depotLongitude' | 'id' | 'status'> | null;
      if (routePlan === null) {
        return false;
      }
      const currentDepot = readDepotFromRoutePlan(routePlan);
      const defaultDepot = readDepotFromShopDefaults(shop);
      const effectiveDepot = currentDepot ?? defaultDepot;
      if (routeEndMode === 'RETURN_TO_DEPOT' && effectiveDepot === null) {
        throw new RoutePlanOptionsUpdateInvalidError('Return-to-store routing requires default depot coordinates.');
      }

      await tx.routePlan.update({
        data: {
          ...(currentDepot === null && defaultDepot !== null
            ? {
                depotLatitude: decimalString(defaultDepot.latitude),
                depotLongitude: decimalString(defaultDepot.longitude)
              }
            : {}),
          constraints: updateConstraintsRouteEndMode(routePlan.constraints, routeEndMode, effectiveDepot)
        },
        where: { id: routePlan.id }
      });

      return true;
    });

    if (!updated) {
      return null;
    }

    return this.findRoutePlanDetail({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
  }

  async updateRoutePlanStops(input: UpdateRoutePlanStopsInput): Promise<RoutePlanDetail | null> {
    assertNoDuplicateStopUpdateInputs(input.payload.stops);
    const normalizedStops = normalizeStopUpdateInputs(input.payload.stops);
    const shopDomain = this.normalizeShopDomain(input.shopDomain);

    const updated = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        select: { id: true },
        where: this.shopWhere({ appId: input.appId, shopDomain })
      });
      if (shop === null) {
        return false;
      }

      const routePlan = (await tx.routePlan.findFirst({
        include: routePlanInclude(),
        where: {
          id: input.routePlanId,
          shopId: shop.id
        }
      })) as RoutePlanRecord | null;
      if (routePlan === null) {
        return false;
      }

      const routeDate = deriveRouteDate(routePlan);
      const orderGids = normalizedStops.map((stop) => stop.shopifyOrderGid);
      const orders = (await tx.order.findMany({
        include: {
          deliveryStops: {
            take: 1
          },
          orderItems: {
            orderBy: { lineIndex: 'asc' }
          }
        },
        where: {
          shopId: shop.id,
          shopifyOrderGid: { in: orderGids }
        }
      })) as unknown as OrderRecord[];
      const ordersByGid = new Map(orders.map((order) => [order.shopifyOrderGid, order]));
      const missingOrderGids = orderGids.filter((gid) => !ordersByGid.has(gid));
      if (missingOrderGids.length > 0) {
        throw new RoutePlanStopUpdateInvalidError('Route stops can only include orders from the current shop.');
      }

      const wrongDateOrders = normalizedStops.filter((stop) => {
        const order = ordersByGid.get(stop.shopifyOrderGid);
        return order !== undefined && readOrderDeliveryDate(order) !== routeDate;
      });
      if (wrongDateOrders.length > 0) {
        throw new RoutePlanStopUpdateInvalidError(
          'Route stops must share the same delivery date as the route. Choose orders for the route delivery date before saving stops.'
        );
      }

      const deliveryStopIds: string[] = [];
      for (const stopInput of normalizedStops) {
        const order = ordersByGid.get(stopInput.shopifyOrderGid);
        if (order === undefined) {
          throw new RoutePlanStopUpdateInvalidError('Route stops can only include orders from the current shop.');
        }

        if (stopInput.deliveryStopId !== null) {
          const deliveryStop = await tx.deliveryStop.findFirst({
            where: {
              id: stopInput.deliveryStopId,
              orderId: order.id,
              shopId: shop.id
            }
          });
          if (deliveryStop === null) {
            throw new RoutePlanStopUpdateInvalidError('Route stop does not belong to the selected order.');
          }
          deliveryStopIds.push(deliveryStop.id);
          continue;
        }

        const deliveryStop = await tx.deliveryStop.upsert({
          create: {
            ...toDeliveryStopWriteFromOrder(order, routeDate),
            orderId: order.id,
            shopId: shop.id
          },
          update: toDeliveryStopWriteFromOrder(order, routeDate),
          where: {
            shopId_orderId: {
              orderId: order.id,
              shopId: shop.id
            }
          }
        });
        deliveryStopIds.push(deliveryStop.id);
      }

      const stopsAssignedElsewhere = await tx.routePlanStop.findMany({
        select: { deliveryStopId: true },
        where: {
          deliveryStopId: { in: deliveryStopIds },
          routePlanId: { not: input.routePlanId },
          routePlan: { shopId: shop.id }
        }
      });
      if (stopsAssignedElsewhere.length > 0) {
        throw new RoutePlanOrderAlreadyPlannedError();
      }

      await tx.routePlanStop.deleteMany({
        where: { routePlanId: input.routePlanId }
      });

      if (deliveryStopIds.length > 0) {
        await tx.routePlanStop.createMany({
          data: deliveryStopIds.map((deliveryStopId, index) => ({
            deliveryStopId,
            routePlanId: input.routePlanId,
            sequence: index + 1
          }))
        });
      }

      const nextMetrics = routeMetricsForStatus({
        existingMetrics: routePlan.metrics,
        nextMetrics: createMetricsFromOrders(ordersByGid, orderGids, deliveryStopIds.length),
        status: routePlan.status
      });
      await tx.routePlan.update({
        data: {
          metrics: nextMetrics
        },
        where: { id: input.routePlanId }
      });

      return true;
    });

    if (!updated) {
      return null;
    }

    return this.findRoutePlanDetail({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
  }

  private async findShop(input: { appId?: string | undefined; shopDomain: string }): Promise<RoutePlanShopRecord | null> {
    return this.prisma.shop.findUnique({
      select: shopDepotSelect(),
      where: this.shopWhere(input)
    });
  }

  private shopWhere(input: { appId?: string | undefined; shopDomain: string }): {
    appId_shopDomain: { appId: string; shopDomain: string };
  } {
    return appScopedShopWhere({
      appId: input.appId,
      shopDomain: this.normalizeShopDomain(input.shopDomain)
    });
  }

  private async repairDraftDepotIfMissing(
    routePlan: RoutePlanRecord,
    shop: RoutePlanShopRecord
  ): Promise<RoutePlanRecord> {
    if (routePlan.status !== 'DRAFT' || readDepotFromRoutePlan(routePlan) !== null) {
      return routePlan;
    }

    const defaultDepot = readDepotFromShopDefaults(shop);
    if (defaultDepot === null) {
      return routePlan;
    }

    const constraints = mergeConstraintsDepot(routePlan.constraints, defaultDepot);
    await this.prisma.routePlan.update({
      data: {
        constraints,
        depotLatitude: decimalString(defaultDepot.latitude),
        depotLongitude: decimalString(defaultDepot.longitude)
      },
      where: { id: routePlan.id }
    });

    const repaired = await this.prisma.routePlan.findFirst({
      include: routePlanInclude(),
      where: {
        id: routePlan.id,
        shopId: shop.id
      }
    });
    if (repaired !== null && readDepotFromRoutePlan(repaired) !== null) {
      return repaired;
    }
    return {
      ...routePlan,
      constraints,
      depotLatitude: decimalString(defaultDepot.latitude),
      depotLongitude: decimalString(defaultDepot.longitude)
    };
  }

  private normalizeShopDomain(value: string): string {
    return normalizeShopDomain(value, { allowAnyDomain: this.options.allowAnyShopDomain === true });
  }
}

async function repairDraftDepotIfMissingInTransaction(
  tx: Pick<RoutePlanPrismaClient, 'routePlan'>,
  routePlan: RoutePlanRecord,
  shop: RoutePlanShopRecord
): Promise<RoutePlanRecord> {
  if (routePlan.status !== 'DRAFT' || readDepotFromRoutePlan(routePlan) !== null) {
    return routePlan;
  }

  const defaultDepot = readDepotFromShopDefaults(shop);
  if (defaultDepot === null) {
    return routePlan;
  }

  const constraints = mergeConstraintsDepot(routePlan.constraints, defaultDepot);
  await tx.routePlan.update({
    data: {
      constraints,
      depotLatitude: decimalString(defaultDepot.latitude),
      depotLongitude: decimalString(defaultDepot.longitude)
    },
    where: { id: routePlan.id }
  });

  const repaired = await tx.routePlan.findFirst({
    include: routePlanInclude(),
    where: {
      id: routePlan.id,
      shopId: shop.id
    }
  });
  if (repaired !== null && readDepotFromRoutePlan(repaired) !== null) {
    return repaired;
  }
  return {
    ...routePlan,
    constraints,
    depotLatitude: decimalString(defaultDepot.latitude),
    depotLongitude: decimalString(defaultDepot.longitude)
  };
}

function parseExpectedRoutePlanUpdatedAt(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RoutePlanConflictError();
  }
  return parsed;
}

function toRoutePlanDetail(record: RoutePlanRecord): RoutePlanDetail {
  return {
    routePlan: toRoutePlanSummary(record),
    routeGeometry: null,
    routeMetrics: null,
    routeStopPoints: [],
    stops: [...(record.routeStops ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map((routeStop) => toRoutePlanDetailStop(routeStop))
  } satisfies RoutePlanDetail;
}

type RouteGeometryCacheLookupClient = Pick<RoutePlanPrismaClient, 'routePlanGeometryCache'>;

async function applyRouteGeometryCache(
  client: RouteGeometryCacheLookupClient,
  detail: RoutePlanDetail
): Promise<RoutePlanDetail> {
  const shapeSignature = computeRouteShapeSignature(detail);
  const matching = await client.routePlanGeometryCache.findUnique({
    select: routeGeometryCacheSelect(),
    where: {
      routePlanId_shapeSignature: {
        routePlanId: detail.routePlan.id,
        shapeSignature
      }
    }
  }) as RoutePlanGeometryCacheRecord | null;
  if (matching !== null) return applyCachedRouteGeometry(detail, matching);

  const latest = await client.routePlanGeometryCache.findFirst({
    orderBy: { generatedAt: 'desc' },
    select: routeGeometryCacheMetadataSelect(),
    where: { routePlanId: detail.routePlan.id }
  });
  return applyCachedRouteGeometry(detail, toStaleRouteGeometryCacheRead(latest));
}

function routeGeometryCacheSelect() {
  return {
    generatedAt: true,
    geometry: true,
    metrics: true,
    provider: true,
    providerVersion: true,
    shapeSignature: true,
    source: true,
    stopPoints: true
  } as const;
}

function routeGeometryCacheMetadataSelect() {
  return {
    generatedAt: true,
    geometry: false,
    metrics: false,
    provider: true,
    providerVersion: true,
    shapeSignature: true,
    source: true,
    stopPoints: false
  } as const;
}

function toStaleRouteGeometryCacheRead(record: RoutePlanGeometryCacheMetadataRecord | null): RouteGeometryCacheRead | null {
  if (record === null) return null;
  return {
    ...record,
    geometry: null,
    metrics: null,
    stopPoints: []
  };
}

function sameStopSequenceRecord(
  routePlan: RoutePlanRecord,
  stops: UpdateRoutePlanStopsInput['payload']['stops']
): boolean {
  const current = [...(routePlan.routeStops ?? [])].sort((left, right) => left.sequence - right.sequence);
  if (current.length !== stops.length) return false;

  const next = [...stops].sort((left, right) => left.sequence - right.sequence);
  return current.every((routeStop, index) => {
    const nextStop = next[index];
    return (
      nextStop !== undefined &&
      routeStop.deliveryStop.order.shopifyOrderGid === nextStop.shopifyOrderGid &&
      routeStop.deliveryStopId === (nextStop.deliveryStopId ?? routeStop.deliveryStopId)
    );
  });
}

function publishSkipReasonFromState(status: string, driverId: string | null, stopCount: number): string {
  if (status !== 'DRAFT') return `status_${status.toLowerCase()}`;
  if (driverId === null) return 'missing_driver';
  if (stopCount === 0) return 'missing_stops';
  return 'explicit_publish_required';
}

function routePlanStopCount(routePlan: RoutePlanRecord): number {
  const count = (routePlan as RoutePlanRecord & { _count?: { routeStops?: number } })._count?.routeStops;
  return typeof count === 'number' ? count : routePlan.routeStops?.length ?? 0;
}

function assertNoDuplicateOrderInputs(orders: RoutePlanOrderInput[]): void {
  const seenOrderGids = new Set<string>();
  const duplicateOrderNames: string[] = [];

  for (const order of orders) {
    if (seenOrderGids.has(order.shopifyOrderGid)) {
      duplicateOrderNames.push(order.name);
      continue;
    }

    seenOrderGids.add(order.shopifyOrderGid);
  }

  if (duplicateOrderNames.length > 0) {
    throw new RoutePlanOrderAlreadyPlannedError(duplicateOrderNames);
  }
}

function normalizeSelectedOrderIds(orderIds: string[]): string[] {
  const normalized = orderIds.map((id) => id.trim()).filter((id) => id !== '');
  if (normalized.length === 0) {
    throw new RoutePlanBatchInvalidError(['select at least one order']);
  }
  const seen = new Set<string>();
  const duplicates = normalized.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  if (duplicates.length > 0) {
    throw new RoutePlanBatchInvalidError(duplicates.map((id) => `${id}: duplicate selected order`));
  }
  return normalized;
}

function validateFactsForRouteCreation(input: {
  facts: OrderDeliveryFactRecord[];
  orderIds: string[];
  planDate: string;
}): string[] {
  const blockers: string[] = [];
  const factsByOrderId = new Map(input.facts.map((fact) => [fact.orderId, fact]));
  const missing = input.orderIds.filter((orderId) => !factsByOrderId.has(orderId));
  blockers.push(...missing.map((orderId) => `${orderId}: delivery facts not found`));

  const sourceScopes = new Set<string>();
  const routeScopes = new Set<string>();
  for (const orderId of input.orderIds) {
    const fact = factsByOrderId.get(orderId);
    if (fact === undefined) continue;
    const label = fact.sourceOrderNumber ?? fact.order.name ?? orderId;
    const reviewReasons = readStringArray(fact.reviewReasons) ?? [];
    const stop = fact.order.deliveryStops?.[0] ?? null;
    sourceScopes.add(`${fact.sourcePlatform}|${fact.sourceSiteUrl ?? ''}`);
    routeScopes.add(`${formatDateOnlyNullable(fact.deliveryDate)}|${fact.routeScopeKey ?? ''}|${fact.deliverySession ?? ''}|${fact.serviceType ?? ''}|${formatTimeOnlyNullable(fact.timeWindowStart) ?? ''}|${formatTimeOnlyNullable(fact.timeWindowEnd) ?? ''}`);

    if (formatDateOnlyNullable(fact.deliveryDate) !== input.planDate) {
      blockers.push(`${label}: delivery date does not match the route date`);
    }
    const hasCoordinates = stop === null ? false : decimalNumber(stop.latitude) !== null && decimalNumber(stop.longitude) !== null;
    const alreadyPlanned = (stop?.routePlanStops?.length ?? 0) > 0;
    const operationalReviewReasons = discountLiveOperationalReviewReasons(reviewReasons, { alreadyPlanned, hasCoordinates });
    const factReady = fact.readiness === 'READY_TO_PLAN' || operationalReviewReasons.length === 0;
    if (!factReady) {
      blockers.push(`${label}: needs review (${operationalReviewReasons.length === 0 ? 'needs_delivery_metadata_review' : operationalReviewReasons.join(', ')})`);
    }
    if (fact.routeScopeKey === null || fact.deliverySession === null || fact.serviceType === null) {
      blockers.push(`${label}: missing route scope`);
    }
    if (fact.deliveryDateWeekdayMismatch || reviewReasons.includes('delivery_date_weekday_mismatch')) {
      blockers.push(`${label}: delivery date weekday mismatch`);
    }
    if (
      (fact.rawDeliveryDay !== null || fact.rawDeliveryTimeWindow !== null) &&
      (!fact.deliveryDateWeekdayVerified ||
        fact.deliveryDayParseStatus === 'UNPARSED' ||
        fact.deliveryDayParseStatus === 'UNVERIFIED' ||
        reviewReasons.includes('delivery_day_unparsed') ||
        reviewReasons.includes('delivery_date_weekday_unverified'))
    ) {
      blockers.push(`${label}: unverified Woo delivery day/time`);
    }
    if (stop === null) {
      blockers.push(`${label}: missing delivery stop`);
      continue;
    }
    if (!hasCoordinates) {
      blockers.push(`${label}: missing delivery coordinates`);
    }
    if (alreadyPlanned) {
      blockers.push(`${label}: already assigned to a route`);
    }
  }

  if (sourceScopes.size > 1) blockers.push('selected orders have mixed source scope');
  if (routeScopes.size > 1) blockers.push('selected orders have mixed route scope');
  return [...new Set(blockers)];
}

function discountLiveOperationalReviewReasons(
  reviewReasons: string[],
  input: { alreadyPlanned: boolean; hasCoordinates: boolean }
): string[] {
  const itemReviewReasons = new Set<string>(ITEM_REVIEW_REASONS);
  return reviewReasons.filter((reason) => {
    if (itemReviewReasons.has(reason)) return false;
    if (reason === 'missing_coordinates' && input.hasCoordinates) return false;
    if (reason === 'already_planned' && !input.alreadyPlanned) return false;
    return true;
  });
}

function readRouteScopeDeliverySession(value: string): RoutePlanRouteScopeInput['deliverySession'] {
  try {
    return assertSafeRouteScopeToken(value, 'delivery session');
  } catch {
    throw new RoutePlanBatchInvalidError(['invalid delivery session']);
  }
}

function readRouteScopeServiceType(value: string): RoutePlanRouteScopeInput['serviceType'] {
  try {
    return assertSafeRouteScopeToken(value, 'service type');
  } catch {
    throw new RoutePlanBatchInvalidError(['invalid service type']);
  }
}

function readRouteScopeTime(routeScopeKey: string, part: 'start' | 'end'): string | null {
  const pieces = routeScopeKey.split('|');
  const value = pieces[part === 'start' ? 2 : 3] ?? '';
  return /^\d{2}:\d{2}$/u.test(value) ? value : null;
}

function assertNoDuplicateStopUpdateInputs(stops: UpdateRoutePlanStopsInput['payload']['stops']): void {
  const seenOrderGids = new Set<string>();
  for (const stop of stops) {
    if (seenOrderGids.has(stop.shopifyOrderGid)) {
      throw new RoutePlanStopUpdateInvalidError('Route stop update payload contains duplicate orders.');
    }
    seenOrderGids.add(stop.shopifyOrderGid);
  }
}

function normalizeStopUpdateInputs(
  stops: UpdateRoutePlanStopsInput['payload']['stops']
): Array<{ deliveryStopId: string | null; sequence: number; shopifyOrderGid: string }> {
  return [...stops]
    .map((stop, index) => ({ ...stop, originalIndex: index }))
    .sort((left, right) => left.sequence - right.sequence || left.originalIndex - right.originalIndex)
    .map((stop, index) => ({
      deliveryStopId: stop.deliveryStopId ?? null,
      sequence: index + 1,
      shopifyOrderGid: stop.shopifyOrderGid
    }));
}

function deriveRouteDate(routePlan: RoutePlanRecord): string {
  const constraints = objectOrNull(routePlan.constraints);
  const routeScope = objectOrNull(constraints?.routeScope);
  return (
    readDateOnlyString(routeScope?.deliveryDate) ??
    formatDateOnlyNullable(routePlan.deliveryDate ?? null) ??
    formatDateOnly(routePlan.planDate)
  );
}

function readOrderDeliveryDate(order: OrderRecord): string | null {
  const rawPayload = objectOrNull(order.rawPayload);
  return readDateOnlyString(rawPayload?.deliveryDate) ?? formatDateOnlyNullable(order.deliveryStops?.[0]?.deliveryDate ?? null);
}

function toDeliveryStopWriteFromOrder(
  order: OrderRecord,
  routeDate: string
): {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: Date;
  geocodeStatus: 'PENDING' | 'RESOLVED';
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
} {
  const shippingAddress = readShippingAddress(order.shippingAddress, order.deliveryStops?.[0] ?? emptyDeliveryStopFallback(order));
  const rawPayload = objectOrNull(order.rawPayload);
  const latitude = decimalString(readNumber(rawPayload?.latitude) ?? decimalNumber(order.deliveryStops?.[0]?.latitude));
  const longitude = decimalString(readNumber(rawPayload?.longitude) ?? decimalNumber(order.deliveryStops?.[0]?.longitude));
  return {
    address1: shippingAddress.address1,
    address2: shippingAddress.address2,
    city: shippingAddress.city,
    countryCode: shippingAddress.countryCode,
    deliveryDate: parsePlanDate(routeDate),
    geocodeStatus: latitude === null || longitude === null ? 'PENDING' : 'RESOLVED',
    latitude,
    longitude,
    phone: order.phone ?? order.deliveryStops?.[0]?.phone ?? null,
    postalCode: shippingAddress.postalCode,
    province: shippingAddress.province,
    recipientName: readString(rawPayload?.recipientName) ?? order.deliveryStops?.[0]?.recipientName ?? null,
    timeWindowEnd: parseTorontoTimeWindow(routeDate, readString(rawPayload?.timeWindowEnd)),
    timeWindowStart: parseTorontoTimeWindow(routeDate, readString(rawPayload?.timeWindowStart))
  };
}

function emptyDeliveryStopFallback(order: OrderRecord): DeliveryStopRecord {
  return {
    address1: null,
    address2: null,
    city: null,
    countryCode: null,
    id: '',
    latitude: null,
    longitude: null,
    order,
    orderId: order.id,
    phone: null,
    postalCode: null,
    province: null,
    recipientName: null,
    status: 'PENDING'
  };
}


function readPaymentMethodTitle(rawPayload: Record<string, unknown> | null): string | null {
  if (rawPayload === null) return null;
  return readString(rawPayload.payment_method_title)
    ?? readString(rawPayload.paymentMethodTitle)
    ?? readString(rawPayload.payment_method)
    ?? readString(rawPayload.paymentMethod);
}

function readCustomerNote(rawPayload: Record<string, unknown> | null): string | null {
  if (rawPayload === null) return null;
  for (const key of ['customer_note', 'customerNote', 'note']) {
    const value = rawPayload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const customer = rawPayload.customer;
  if (customer !== null && typeof customer === 'object' && !Array.isArray(customer)) {
    const value = (customer as Record<string, unknown>).note;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function createMetricsFromOrders(
  ordersByGid: Map<string, OrderRecord>,
  orderGids: string[],
  stopsCount: number
): Prisma.InputJsonObject {
  const orders = orderGids.flatMap((gid) => {
    const order = ordersByGid.get(gid);
    return order === undefined ? [] : [order];
  });
  return {
    deliveryAreas: uniqueStrings(orders.map((order) => readString(objectOrNull(order.rawPayload)?.deliveryArea))),
    deliveryDays: uniqueStrings(
      orders.map((order) => {
        const rawPayload = objectOrNull(order.rawPayload);
        return readString(rawPayload?.deliveryDayRaw) ?? readString(rawPayload?.deliveryDay);
      })
    ),
    itemFingerprint: aggregateOrderItems(orders.flatMap((order) => (order.orderItems ?? []).map((item) => toOrderItemDto(item)))).fingerprint,
    missingCoordinates: orders.filter((order) => {
      const stop = order.deliveryStops?.[0] ?? null;
      return decimalNumber(stop?.latitude) === null || decimalNumber(stop?.longitude) === null;
    }).length,
    stopsCount
  };
}



function createMetricsFromFacts(facts: OrderDeliveryFactRecord[]): Prisma.InputJsonObject {
  const items = facts.flatMap((fact) => (fact.order.orderItems ?? []).map((item) => toOrderItemDto(item)));
  return {
    deliveryAreas: uniqueStrings(facts.map((fact) => fact.deliveryArea)),
    deliveryDays: uniqueStrings(facts.map((fact) => fact.rawDeliveryDay ?? fact.deliveryWeekday)),
    itemFingerprint: aggregateOrderItems(items).fingerprint,
    missingCoordinates: facts.filter((fact) => {
      const stop = fact.order.deliveryStops?.[0] ?? null;
      return decimalNumber(stop?.latitude) === null || decimalNumber(stop?.longitude) === null;
    }).length,
    stopsCount: facts.length
  };
}

function routeMetricsForStatus(input: {
  existingMetrics: unknown;
  nextMetrics: Prisma.InputJsonObject;
  status: string;
}): Prisma.InputJsonObject {
  const publishedItemFingerprint = input.status === 'DRAFT'
    ? null
    : readString(objectOrNull(input.existingMetrics)?.itemFingerprint);
  if (publishedItemFingerprint === null) return input.nextMetrics;
  return {
    ...input.nextMetrics,
    itemFingerprint: publishedItemFingerprint
  };
}

function routeItemDtosFromRouteStops(routeStops: RoutePlanStopRecord[]): OrderItemDto[] {
  return routeStops.flatMap((routeStop) =>
    (routeStop.deliveryStop.order.orderItems ?? []).map((item) => toOrderItemDto(item))
  );
}

function routePlanSummaryInclude() {
  return {
    driver: {
      include: {
        _count: {
          select: {
            driverEvents: true
          }
        }
      }
    },
    routeGroupingChildVersions: {
      orderBy: { createdAt: 'desc' as const },
      select: {
        groupingId: true,
        status: true,
        version: true
      },
      take: 1
    },
    routeStops: {
      include: {
        deliveryStop: {
          include: {
            order: {
              include: {
                orderItems: {
                  orderBy: { lineIndex: 'asc' as const }
                },
                deliveryCustomerProfileLinks: {
                  include: { profile: true },
                  take: 1
                }
              }
            }
          }
        }
      },
      orderBy: { sequence: 'asc' as const }
    }
  };
}

function routePlanInclude() {
  return {
    driver: {
      include: {
        _count: {
          select: {
            driverEvents: true
          }
        }
      }
    },
    routeGroupingChildVersions: {
      orderBy: { createdAt: 'desc' },
      select: {
        groupingId: true,
        status: true,
        version: true
      },
      take: 1
    },
    routeStops: {
      include: {
        deliveryStop: {
          include: {
            order: {
              include: {
                orderItems: {
                  orderBy: { lineIndex: 'asc' }
                },
                deliveryCustomerProfileLinks: {
                  include: { profile: true },
                  take: 1
                }
              }
            }
          }
        }
      },
      orderBy: {
        sequence: 'asc'
      }
    }
  } satisfies Prisma.RoutePlanInclude;
}

function shopDepotSelect() {
  return {
    defaultDepotAddress: true,
    defaultDepotLatitude: true,
    defaultDepotLongitude: true,
    id: true
  } satisfies Prisma.ShopSelect;
}

function toOrderWrite(input: RoutePlanOrderInput): {
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
  updatedAtShopify: Date | null;
} {
  return {
    currencyCode: input.currencyCode,
    email: input.email,
    financialStatus: input.financialStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    name: input.name,
    phone: input.phone,
    processedAt: input.processedAt,
    rawPayload: toJson({
      ...objectOrEmpty(input.rawPayload),
      attributes: input.attributes,
      deliveryArea: input.deliveryArea,
      deliveryDate: input.deliveryDate ?? null,
      deliveryDay: input.deliveryDay,
      deliverySession: input.deliverySession ?? null,
      planningGroupKey: input.planningGroupKey ?? null,
      recipientName: input.recipientName,
      routeScopeKey: input.routeScopeKey ?? null,
      serviceType: input.serviceType ?? null,
      timeWindowEnd: input.timeWindowEnd ?? null,
      timeWindowStart: input.timeWindowStart ?? null
    }),
    shippingAddress: toJson(input.shippingAddress),
    shopifyOrderGid: input.shopifyOrderGid,
    shopifyOrderLegacyId: parseShopifyOrderLegacyId(input.shopifyOrderGid),
    totalPriceAmount: input.totalPriceAmount,
    updatedAtShopify: input.processedAt
  };
}

function toDeliveryStopWrite(
  input: RoutePlanOrderInput,
  planDate: Date,
  routeScope: RoutePlanRouteScopeInput | undefined
): {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryDate: Date;
  geocodeStatus: 'PENDING' | 'RESOLVED';
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
  postalCode: string | null;
  province: string | null;
  recipientName: string | null;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
} {
  return {
    address1: input.shippingAddress.address1,
    address2: input.shippingAddress.address2,
    city: input.shippingAddress.city,
    countryCode: input.shippingAddress.countryCode,
    deliveryDate: planDate,
    geocodeStatus: input.latitude === null || input.longitude === null ? 'PENDING' : 'RESOLVED',
    latitude: decimalString(input.latitude),
    longitude: decimalString(input.longitude),
    phone: input.phone,
    postalCode: input.shippingAddress.postalCode,
    province: input.shippingAddress.province,
    recipientName: input.recipientName,
    timeWindowEnd: parseTorontoTimeWindow(routeScope?.deliveryDate ?? null, routeScope?.timeWindowEnd ?? null),
    timeWindowStart: parseTorontoTimeWindow(routeScope?.deliveryDate ?? null, routeScope?.timeWindowStart ?? null)
  };
}

function toRoutePlanSummary(routePlan: RoutePlanRecord, inputOrders?: RoutePlanOrderInput[]): RoutePlanSummary {
  const metrics = readMetrics(routePlan.metrics, inputOrders, routePlan.routeStops ?? []);
  const itemSummary = aggregateOrderItems(
    inputOrders === undefined
      ? routeItemDtosFromRouteStops(routePlan.routeStops ?? [])
      : inputOrders.flatMap((order) => order.items ?? []),
    routePlan.status === 'DRAFT' ? null : readString(objectOrNull(routePlan.metrics)?.itemFingerprint)
  );
  return {
    createdAt: routePlan.createdAt.toISOString(),
    deliveryDate: deriveRouteDate(routePlan),
    deliveryAreas: metrics.deliveryAreas,
    deliveryDays: metrics.deliveryDays,
    depot: {
      latitude: decimalNumber(routePlan.depotLatitude),
      longitude: decimalNumber(routePlan.depotLongitude)
    },
    departureTime: readDepartureTime(routePlan.constraints),
    driver: toRoutePlanDriverSummary(routePlan.driver ?? null),
    driverId: routePlan.driverId ?? routePlan.driver?.id ?? null,
    id: routePlan.id,
    itemSummary,
    missingCoordinates: metrics.missingCoordinates,
    name: routePlan.name,
    planDate: formatDateOnly(routePlan.planDate),
    routeEndMode: readRouteEndMode(routePlan.constraints),
    routeGroupingChild: toRouteGroupingChildSummary(routePlan.routeGroupingChildVersions),
    status: routePlan.status,
    stopsCount: metrics.stopsCount,
    updatedAt: routePlan.updatedAt.toISOString()
  };
}

function toRouteGroupingChildSummary(childVersions: RouteGroupingChildVersionRecord[] | undefined): NonNullable<RoutePlanSummary['routeGroupingChild']> | null {
  const child = childVersions?.[0];
  if (child === undefined) return null;
  return {
    groupingId: child.groupingId,
    status: child.status,
    version: child.version
  };
}

function toRoutePlanDriverSummary(driver: RoutePlanDriverRecord | null): RoutePlanDriverSummary | null {
  if (driver === null) {
    return null;
  }

  const isInvitePending = driver.authSubject === null;
  return {
    authStatus: isInvitePending ? 'INVITE_PENDING' : 'APP_LINKED',
    authSubject: isInvitePending ? null : 'present',
    createdAt: driver.createdAt.toISOString(),
    displayName: driver.displayName,
    id: driver.id,
    lastSeenAt: driver.lastSeenAt?.toISOString() ?? null,
    phone: driver.phone,
    recentEventsCount: driver._count?.driverEvents ?? 0,
    status: isInvitePending ? 'PENDING' : driver.status,
    updatedAt: driver.updatedAt.toISOString()
  };
}

function toRoutePlanDetailStop(routeStop: RoutePlanStopRecord): RoutePlanDetailStop {
  const deliveryStop = routeStop.deliveryStop;
  const order = deliveryStop.order;
  const rawPayload = objectOrNull(order.rawPayload);
  const shippingAddress = readShippingAddress(order.shippingAddress, deliveryStop);
  const attributes = readAttributes(rawPayload);

  return {
    address: shippingAddress,
    attributes,
    coordinates: {
      latitude: decimalNumber(deliveryStop.latitude),
      longitude: decimalNumber(deliveryStop.longitude)
    },
    deliveryArea: readString(rawPayload?.deliveryArea) ?? readAttribute(attributes, 'Delivery Area'),
    deliveryDay: readString(rawPayload?.deliveryDay) ?? readAttribute(attributes, 'Delivery Day'),
    deliveryStopId: deliveryStop.id,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    items: (order.orderItems ?? []).map((item) => toOrderItemDto(item)),
    customerNoteContext: {
      adminMemo: order.deliveryCustomerProfileLinks?.[0]?.profile.adminMemo ?? null,
      customerNote: readCustomerNote(rawPayload),
      deliveryCustomerProfileId: order.deliveryCustomerProfileLinks?.[0]?.profile.id ?? null,
      matchReasons: order.deliveryCustomerProfileLinks?.[0]?.matchReasons ?? [],
      matchStatus: order.deliveryCustomerProfileLinks?.[0]?.matchStatus ?? null
    },
    normalizedPaymentStatus: readNormalizedPaymentStatus(rawPayload?.normalizedPaymentStatus),
    currencyCode: order.currencyCode ?? null,
    distanceFromPreviousMeters: routeStop.distanceFromPreviousMeters,
    durationFromPreviousSeconds: routeStop.durationFromPreviousSeconds,
    email: order.email ?? null,
    estimatedArrivalAt: routeStop.estimatedArrivalAt?.toISOString() ?? null,
    paymentMethodTitle: readPaymentMethodTitle(rawPayload),
    phone: deliveryStop.phone ?? order.phone ?? null,
    totalPriceAmount: stringOrNull(order.totalPriceAmount),
    orderId: order.id,
    orderName: order.name,
    paymentStatus: order.financialStatus,
    recipientName: deliveryStop.recipientName ?? readString(rawPayload?.recipientName),
    sequence: routeStop.sequence,
    shopifyOrderGid: order.shopifyOrderGid,
    status: deliveryStop.status
  };
}



function createMetrics(orders: RoutePlanOrderInput[]): Prisma.InputJsonObject {
  const itemSummary = aggregateOrderItems(orders.flatMap((order) => order.items ?? []));
  return {
    deliveryAreas: uniqueStrings(orders.map((order) => order.deliveryArea)),
    deliveryDays: uniqueStrings(orders.map((order) => order.deliveryDay)),
    itemFingerprint: itemSummary.fingerprint,
    missingCoordinates: orders.filter((order) => order.latitude === null || order.longitude === null).length,
    stopsCount: orders.length
  };
}

function createConstraints(
  depot: RoutePlanDepotInput,
  routeScope: RoutePlanRouteScopeInput | undefined,
  routeEndMode: RoutePlanEndMode = DEFAULT_ROUTE_END_MODE
): Prisma.InputJsonObject {
  return {
    depot: {
      address: depot.address,
      latitude: depot.latitude,
      longitude: depot.longitude
    },
    optimizer: OPTIMIZER_VERSION,
    routeEndMode,
    routeScope: routeScope ?? null,
    sequenceSource: 'request-order'
  };
}

function resolveEffectiveDepot(
  requestedDepot: RoutePlanDepotInput,
  shop: RoutePlanShopRecord
): RoutePlanDepotInput {
  if (hasValidDepotCoordinates(requestedDepot)) {
    return {
      address: readString(requestedDepot.address) ?? readString(shop.defaultDepotAddress) ?? null,
      latitude: requestedDepot.latitude,
      longitude: requestedDepot.longitude
    };
  }

  return readDepotFromShopDefaults(shop) ?? requestedDepot;
}

function readDepotFromShopDefaults(shop: RoutePlanShopRecord): RoutePlanDepotInput | null {
  const latitude = decimalNumber(shop.defaultDepotLatitude);
  const longitude = decimalNumber(shop.defaultDepotLongitude);
  if (!isValidLatitudeNumber(latitude) || !isValidLongitudeNumber(longitude)) {
    return null;
  }

  return {
    address: readString(shop.defaultDepotAddress) ?? null,
    latitude,
    longitude
  };
}

function readDepotFromRoutePlan(
  routePlan: Pick<RoutePlanRecord, 'constraints' | 'depotLatitude' | 'depotLongitude'>
): RoutePlanDepotInput | null {
  const latitude = decimalNumber(routePlan.depotLatitude);
  const longitude = decimalNumber(routePlan.depotLongitude);
  if (!isValidLatitudeNumber(latitude) || !isValidLongitudeNumber(longitude)) {
    return null;
  }

  const constraints = objectOrNull(routePlan.constraints);
  const depot = objectOrNull(constraints?.depot);
  return {
    address: readString(depot?.address) ?? null,
    latitude,
    longitude
  };
}

function mergeConstraintsDepot(value: unknown, depot: RoutePlanDepotInput): Prisma.InputJsonObject {
  const constraints = objectOrEmpty(value);
  return toJson({
    ...constraints,
    depot: {
      ...objectOrEmpty(constraints.depot),
      address: depot.address,
      latitude: depot.latitude,
      longitude: depot.longitude
    },
    optimizer: readString(constraints.optimizer) ?? OPTIMIZER_VERSION,
    routeEndMode: readRouteEndMode(value),
    sequenceSource: readString(constraints.sequenceSource) ?? 'request-order'
  }) as Prisma.InputJsonObject;
}

function updateConstraintsRouteEndMode(
  value: unknown,
  routeEndMode: RoutePlanEndMode,
  depot: RoutePlanDepotInput | null
): Prisma.InputJsonObject {
  const constraints = objectOrEmpty(value);
  const depotObject = depot === null
    ? objectOrEmpty(constraints.depot)
    : {
        ...objectOrEmpty(constraints.depot),
        address: depot.address,
        latitude: depot.latitude,
        longitude: depot.longitude
      };
  return toJson({
    ...constraints,
    depot: depotObject,
    optimizer: readString(constraints.optimizer) ?? OPTIMIZER_VERSION,
    routeEndMode,
    sequenceSource: readString(constraints.sequenceSource) ?? 'request-order'
  }) as Prisma.InputJsonObject;
}

function updateConstraintsDepartureTime(
  value: unknown,
  departureTime: string | null
): Prisma.InputJsonObject {
  const constraints = objectOrEmpty(value);
  return toJson({
    ...constraints,
    departureTime,
    optimizer: readString(constraints.optimizer) ?? OPTIMIZER_VERSION,
    routeEndMode: readRouteEndMode(value),
    sequenceSource: readString(constraints.sequenceSource) ?? 'request-order'
  }) as Prisma.InputJsonObject;
}

function readDepartureTime(value: unknown): string | null {
  const departureTime = readString(objectOrNull(value)?.departureTime);
  return departureTime !== null && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(departureTime) ? departureTime : null;
}

function readRouteEndMode(value: unknown): RoutePlanEndMode {
  const constraints = objectOrNull(value);
  return constraints?.routeEndMode === 'RETURN_TO_DEPOT' ? 'RETURN_TO_DEPOT' : DEFAULT_ROUTE_END_MODE;
}

function hasValidDepotCoordinates(depot: RoutePlanDepotInput): depot is RoutePlanDepotInput & {
  latitude: number;
  longitude: number;
} {
  return isValidLatitudeNumber(depot.latitude) && isValidLongitudeNumber(depot.longitude);
}

function isValidLatitudeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitudeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function readMetrics(
  value: unknown,
  inputOrders: RoutePlanOrderInput[] | undefined,
  routeStops: RoutePlanStopRecord[]
): {
  deliveryAreas: string[];
  deliveryDays: string[];
  missingCoordinates: number;
  stopsCount: number;
} {
  const object = objectOrNull(value);
  const fallbackOrders = inputOrders ?? [];
  return {
    deliveryAreas: readStringArray(object?.deliveryAreas) ?? deriveStrings(fallbackOrders, routeStops, 'area'),
    deliveryDays: readStringArray(object?.deliveryDays) ?? deriveStrings(fallbackOrders, routeStops, 'day'),
    missingCoordinates:
      readFiniteNumber(object?.missingCoordinates) ??
      (inputOrders ?? routeStops).filter((item) =>
        'latitude' in item
          ? item.latitude === null || item.longitude === null
          : item.deliveryStop.latitude === null || item.deliveryStop.longitude === null
      ).length,
    stopsCount: readFiniteNumber(object?.stopsCount) ?? (inputOrders?.length ?? routeStops.length)
  };
}

function deriveStrings(
  inputOrders: RoutePlanOrderInput[],
  routeStops: RoutePlanStopRecord[],
  kind: 'area' | 'day'
): string[] {
  if (inputOrders.length > 0) {
    return uniqueStrings(inputOrders.map((order) => (kind === 'area' ? order.deliveryArea : order.deliveryDay)));
  }

  return uniqueStrings(
    routeStops.map((routeStop) => {
      const rawPayload = objectOrNull(routeStop.deliveryStop.order.rawPayload);
      const attributes = readAttributes(rawPayload);
      return kind === 'area'
        ? readString(rawPayload?.deliveryArea) ?? readAttribute(attributes, 'Delivery Area')
        : readString(rawPayload?.deliveryDay) ?? readAttribute(attributes, 'Delivery Day');
    })
  );
}

function readShippingAddress(
  value: unknown,
  fallback: DeliveryStopRecord
): RoutePlanShippingAddressInput {
  const object = objectOrNull(value);
  return {
    address1: readString(object?.address1) ?? fallback.address1,
    address2: readString(object?.address2) ?? fallback.address2,
    city: readString(object?.city) ?? fallback.city,
    countryCode: readString(object?.countryCode) ?? fallback.countryCode,
    postalCode: readString(object?.postalCode) ?? fallback.postalCode,
    province: readString(object?.province) ?? fallback.province
  };
}

function readAttributes(value: Record<string, unknown> | null): RoutePlanOrderAttributeInput[] {
  if (!Array.isArray(value?.attributes)) {
    return [];
  }

  return value.attributes.flatMap((attribute) => {
    const object = objectOrNull(attribute);
    const key = readString(object?.key);
    const valueText = readString(object?.value);
    if (key === null || valueText === null) {
      return [];
    }

    return [{ key, value: valueText }];
  });
}

function readAttribute(attributes: RoutePlanOrderAttributeInput[], key: string): string | null {
  return attributes.find((attribute) => attribute.key.toLowerCase() === key.toLowerCase())?.value ?? null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Prisma.Decimal) return value.toString();
  return null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readDateOnlyString(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return objectOrNull(value) ?? {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value.trim() !== ''))];
}

function decimalString(value: number | null): string | null {
  return value === null ? null : String(value);
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


function parseTorontoTimeWindow(deliveryDate: string | null, time: string | null): Date | null {
  if (deliveryDate === null || time === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(deliveryDate) || !/^\d{2}:\d{2}$/u.test(time)) return null;
  return new Date(`${deliveryDate}T${time}:00-04:00`);
}

function parsePlanDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatDateOnlyNullable(value: Date | null): string | null {
  return value === null ? null : formatDateOnly(value);
}

function formatTimeOnlyNullable(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(11, 16);
}

function parseShopifyOrderLegacyId(value: string): bigint | null {
  const match = /\/(\d+)$/u.exec(value);
  if (match?.[1] === undefined) {
    return null;
  }

  return BigInt(match[1]);
}

function normalizeShopDomain(value: string, options: { allowAnyDomain?: boolean } = {}): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (options.allowAnyDomain === true) {
    if (
      withoutProtocol === '' ||
      withoutProtocol.length > 255 ||
      withoutProtocol.startsWith('.') ||
      withoutProtocol.endsWith('.') ||
      !withoutProtocol.includes('.') ||
      !/^[a-z0-9.-]+$/u.test(withoutProtocol)
    ) {
      throw new Error('Shop domain is not a valid customer domain');
    }
    return withoutProtocol;
  }

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
