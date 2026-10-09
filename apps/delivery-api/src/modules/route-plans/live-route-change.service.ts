import { readTollPolicy } from './delivery-options.js';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DisabledDriverPushProvider,
  type DriverPushProvider,
  type DriverRoutePushResult
} from '../route-grouping/driver-push.provider.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import { hasDeliveryWorkCompleted, KFOOD_DELIVERY_APP_ID, KFOOD_DELIVERY_SHOP_DOMAIN } from './kfood-delivery-completion.js';
import { computeRouteShapeSignature, computeRouteShapeSignatureFromParts, routeGeometryCacheUpsertArgs } from './route-plan-geometry-cache.js';
import { PrismaRoutePlanRepository, readRoutePlanGeometryDetail } from './route-plan.repository.js';
import type { RouteGeometryProvider } from './route-plan.service.js';
import type { RoutePlanDetail, RoutePlanRouteResult } from './route-plan.types.js';
import {
  acknowledgeLiveRouteChange,
  discardLiveRouteChange,
  getAdminLiveRouteChange,
  getLiveRouteChange,
  LiveRouteChangeError,
  publishLiveRouteChange,
  saveLiveRouteChange
} from './live-route-change.js';

export { LiveRouteChangeError } from './live-route-change.js';

type AdminScope = { appId: string; shopDomain: string; routePlanId: string };
type DriverScope = { accountId: string; driverId: string; shopId: string; routePlanId: string; tokenVersion?: number };
export type LiveRouteStopOverride = {
  deliveryStopId: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};
export type SaveLiveRouteChangePayload = {
  commandId: string;
  expectedAssignmentGeneration: string;
  expectedRouteVersionId: string;
  expectedRevision: number;
  stopOverrides: LiveRouteStopOverride[];
  futureStopOrder?: string[];
};
export type ApplyLiveRouteChangePayload = { publicationVersionId: string; assignmentGeneration: string };

const MAX_STOPS = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STRING_LIMITS = {
  address1: 500, address2: 500, city: 255, province: 255, postalCode: 32,
  countryCode: 2
} as const;
const DELIVERY_COMPLETION_SELECT = {
  status: true,
  deliveryWorkCompletedAt: true, deliveryWorkCompletedGeneration: true,
  deliveryWorkCompletedVersionId: true, driverNavigationUntil: true
} as const;
const GEOMETRY_ROUTE_SELECT = {
  driverId: true, assignmentGeneration: true, constraints: true,
  ...DELIVERY_COMPLETION_SELECT,
  depotLatitude: true, depotLongitude: true,
  liveChangeState: { select: { latestPublicationId: true, assignmentGeneration: true, driverId: true } },
  routeStops: {
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStopId: true, sequence: true, estimatedArrivalAt: true,
      deliveryStop: { select: { orderId: true, status: true, latitude: true, longitude: true, serviceMinutes: true } }
    }
  }
} satisfies Prisma.RoutePlanSelect;
type GeometryRoute = Prisma.RoutePlanGetPayload<{ select: typeof GEOMETRY_ROUTE_SELECT }>;
export type LiveRouteGeometryResult = {
  status: 'fresh' | 'failed' | 'superseded' | 'unavailable';
  errorCode?: string;
};

export class PrismaLiveRouteChangeService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly pushProvider: DriverPushProvider = new DisabledDriverPushProvider(),
    private readonly options: { now?: () => Date; notificationLeaseMs?: number; geometryProvider?: RouteGeometryProvider } = {}
  ) {}

  async getAdminDraft(input: AdminScope) {
    return getAdminLiveRouteChange(this.prisma, {
      routePlanId: input.routePlanId, shopId: await this.adminShopId(input)
    });
  }

  async saveAdminDraft(input: AdminScope & SaveLiveRouteChangePayload) {
    return saveLiveRouteChange(this.prisma, {
      ...input, shopId: await this.adminShopId(input)
    });
  }

  async dispatchAdminDraft(input: AdminScope & {
    commandId: string; expectedAssignmentGeneration: string; expectedRouteVersionId: string; expectedRevision: number
  }) {
    const shopId = await this.adminShopId(input);
    const scope = { ...input, shopId };
    // The publication and constrained geometry share the existing route lock. A failed
    // provider call rolls back stop edits, the publication cursor, its receipt, and cache changes.
    const { result, preparedGeometry } = await this.prisma.$transaction(async (tx) => {
      const route = await this.lockGeometryRoute(tx, scope);
      const result = await publishLiveRouteChange(tx, {
        routePlanId: input.routePlanId, shopId, commandId: input.commandId,
        expectedAssignmentGeneration: input.expectedAssignmentGeneration, expectedRouteVersionId: input.expectedRouteVersionId,
        expectedRevision: input.expectedRevision
      });
      const preparedGeometry = readTollPolicy(route?.constraints) === 'AVOID_TOLLS'
        ? await this.preparePublicationTollGeometry(tx, scope, result.publicationVersionId, result.assignmentGeneration)
        : null;
      return { result, preparedGeometry };
    }, { timeout: 30_000 });
    const geometry = preparedGeometry ?? await this.rebuildPublicationGeometry(scope, result.publicationVersionId, result.assignmentGeneration);
    const notification = await this.sendPublicationNotification(result.publicationVersionId);
    return { ...result, geometry, notification };
  }

  async discardAdminDraft(input: AdminScope & {
    commandId: string; expectedAssignmentGeneration: string; expectedRouteVersionId: string; expectedRevision: number
  }) {
    return discardLiveRouteChange(this.prisma, {
      routePlanId: input.routePlanId, shopId: await this.adminShopId(input), commandId: input.commandId,
      expectedAssignmentGeneration: input.expectedAssignmentGeneration, expectedRouteVersionId: input.expectedRouteVersionId,
      expectedRevision: input.expectedRevision
    });
  }

  async getDriverPublication(input: DriverScope) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDriverRoute(tx, input);
      await this.assertDriverScope(tx, input);
      return getLiveRouteChange(tx, { ...input, now: this.now() });
    }, { timeout: 15_000 });
  }

  async acknowledgeDriverPublication(input: DriverScope & ApplyLiveRouteChangePayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDriverRoute(tx, input);
      await this.assertDriverScope(tx, input);
      return acknowledgeLiveRouteChange(tx, { ...input, now: this.now() });
    }, { timeout: 15_000 });
  }

  private async adminShopId(input: AdminScope): Promise<string> {
    if (input.appId !== KFOOD_DELIVERY_APP_ID || input.shopDomain.trim().toLowerCase() !== KFOOD_DELIVERY_SHOP_DOMAIN) {
      throw new LiveRouteChangeError('NOT_FOUND', 404, 'Live route changes are unavailable for this shop');
    }
    const shop = await this.prisma.shop.findUnique({
      select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: input.shopDomain.trim().toLowerCase() })
    });
    if (shop === null) throw new LiveRouteChangeError('NOT_FOUND', 404, 'Route not found');
    return shop.id;
  }

  private async assertDriverScope(tx: Prisma.TransactionClient, input: DriverScope): Promise<void> {
    const route = await tx.routePlan.findFirst({
      select: {
        isStoreReviewData: true,
        driver: { select: { isStoreReviewData: true, account: { select: { isStoreReviewAccount: true } } } }
      },
      where: {
        id: input.routePlanId, shopId: input.shopId, driverId: input.driverId,
        driver: {
          accountId: input.accountId, authSubject: { not: null }, status: 'ACTIVE',
          account: { status: 'ACTIVE', ...(input.tokenVersion === undefined ? {} : { tokenVersion: input.tokenVersion }) }
        },
        shop: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN }
      }
    });
    if (route === null || route.driver === null
      || route.isStoreReviewData !== route.driver.isStoreReviewData
      || route.driver.isStoreReviewData !== (route.driver.account?.isStoreReviewAccount === true)) {
      throw new LiveRouteChangeError('FORBIDDEN', 403, 'Driver access is no longer valid');
    }
  }

  private async lockDriverRoute(tx: Prisma.TransactionClient, input: DriverScope): Promise<void> {
    await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${input.routePlanId}::uuid AND "shopId" = ${input.shopId}::uuid FOR UPDATE`;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  private async preparePublicationTollGeometry(
    tx: Prisma.TransactionClient, scope: AdminScope & { shopId: string }, publicationVersionId: string, generation: string
  ): Promise<LiveRouteGeometryResult> {
    const detail = await readRoutePlanGeometryDetail(tx, scope);
    if (detail === null) throw new LiveRouteChangeError('NOT_FOUND', 404, 'Route was not found');
    const signature = computeRouteShapeSignature(detail);
    const route = await this.lockGeometryRoute(tx, scope);
    if (!geometryPublicationMatches(route, publicationVersionId, generation, signature)) return { status: 'superseded' };
    const existing = await tx.routePlanGeometryCache.findUnique({
      where: { routePlanId_shapeSignature: { routePlanId: scope.routePlanId, shapeSignature: signature } },
      select: { geometry: true }
    });
    if (existing?.geometry != null) return { status: 'fresh' };
    const result = await this.options.geometryProvider?.buildRoute(detail).catch(() => null) ?? null;
    if (result === null || !isCompleteLiveGeometry(detail, result)) {
      throw new LiveRouteChangeError('TOLL_POLICY_ROUTE_UNAVAILABLE', 503,
        'Toll-avoiding route calculation failed. The existing published route was preserved.');
    }
    return this.commitPublicationGeometry(scope, publicationVersionId, generation, signature, result, 'ROUTE_GEOMETRY_BUILD_FAILED', tx);
  }

  private async rebuildPublicationGeometry(
    scope: AdminScope & { shopId: string }, publicationVersionId: string, generation: string
  ): Promise<LiveRouteGeometryResult> {
    const detail = await new PrismaRoutePlanRepository(this.prisma).findRoutePlanDetail(scope);
    if (detail === null) return { status: 'superseded' };
    const signature = computeRouteShapeSignature(detail);
    const eligibility = await this.prisma.$transaction(async (tx) => {
      const route = await this.lockGeometryRoute(tx, scope);
      if (!geometryPublicationMatches(route, publicationVersionId, generation, signature)) return 'superseded';
      const cache = await tx.routePlanGeometryCache.findUnique({
        where: { routePlanId_shapeSignature: { routePlanId: scope.routePlanId, shapeSignature: signature } },
        select: { geometry: true }
      });
      return cache?.geometry == null ? 'missing' : 'fresh';
    }, { timeout: 15_000 });
    if (eligibility === 'fresh' || eligibility === 'superseded') return { status: eligibility };

    const provider = this.options.geometryProvider;
    if (provider === undefined) {
      return this.commitPublicationGeometry(scope, publicationVersionId, generation, signature, null, 'ROUTE_GEOMETRY_PROVIDER_UNAVAILABLE');
    }
    const result = await provider.buildRoute(detail).catch(() => null);
    return this.commitPublicationGeometry(scope, publicationVersionId, generation, signature,
      result !== null && isCompleteLiveGeometry(detail, result) ? result : null, 'ROUTE_GEOMETRY_BUILD_FAILED');
  }

  private async lockGeometryRoute(tx: Prisma.TransactionClient, scope: { shopId: string; routePlanId: string }) {
    await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${scope.routePlanId}::uuid AND "shopId" = ${scope.shopId}::uuid FOR UPDATE`;
    return tx.routePlan.findFirst({ where: { id: scope.routePlanId, shopId: scope.shopId }, select: GEOMETRY_ROUTE_SELECT });
  }

  private async commitPublicationGeometry(
    scope: AdminScope & { shopId: string }, publicationVersionId: string, generation: string,
    signature: string, result: RoutePlanRouteResult | null, failureCode: string, transaction?: Prisma.TransactionClient
  ): Promise<LiveRouteGeometryResult> {
    const commit = async (tx: Prisma.TransactionClient): Promise<LiveRouteGeometryResult> => {
      const route = await this.lockGeometryRoute(tx, scope);
      if (route === null || !geometryPublicationMatches(route, publicationVersionId, generation, signature)) return { status: 'superseded' };
      const existingCache = await tx.routePlanGeometryCache.findUnique({
        where: { routePlanId_shapeSignature: { routePlanId: scope.routePlanId, shapeSignature: signature } },
        select: { geometry: true }
      });
      // A later successful duplicate refresh must survive an earlier failed refresh.
      if (existingCache?.geometry != null) return { status: 'fresh' };
      const now = this.now();
      if (result !== null) {
        await tx.routePlanGeometryCache.upsert(routeGeometryCacheUpsertArgs({
          routePlanId: scope.routePlanId, shapeSignature: signature, generatedAt: now,
          geometry: result.routeGeometry, metrics: result.routeMetrics, stopPoints: result.routeStopPoints,
          provider: 'osrm', source: 'SHAPE_MUTATION'
        }));
      }
      const currentIndex = protectedGeometryStopIndex(route);
      const current = route.routeStops[currentIndex];
      let cursor = current?.estimatedArrivalAt == null ? null
        : Math.max(now.getTime(), current.estimatedArrivalAt.getTime()) + current.deliveryStop.serviceMinutes * 60_000;
      const pointById = new Map(result?.routeStopPoints.map((point) => [point.deliveryStopId, point]) ?? []);
      for (const [index, stop] of route.routeStops.entries()) {
        if (index <= currentIndex || !['PENDING', 'ASSIGNED'].includes(stop.deliveryStop.status)) continue;
        const point = pointById.get(stop.deliveryStopId);
        const duration = point?.durationFromPreviousSeconds == null ? null : Math.round(point.durationFromPreviousSeconds);
        if (cursor !== null && duration != null) cursor += duration * 1_000;
        else cursor = null;
        const estimatedArrivalAt = result !== null && cursor !== null ? new Date(cursor) : null;
        await tx.routePlanStop.updateMany({
          where: {
            routePlanId: scope.routePlanId, shopId: scope.shopId, deliveryStopId: stop.deliveryStopId,
            sequence: stop.sequence, deliveryStop: { status: { in: ['PENDING', 'ASSIGNED'] } }
          },
          data: {
            distanceFromPreviousMeters: point?.distanceFromPreviousMeters == null ? null : Math.round(point.distanceFromPreviousMeters),
            durationFromPreviousSeconds: duration ?? null, estimatedArrivalAt, etaCalculatedAt: now,
            etaSource: 'LIVE_ROUTE_CHANGE', etaStatus: estimatedArrivalAt === null ? 'FAILED' : 'READY',
            etaInputRouteVersionId: null,
            etaFailureCode: result === null ? failureCode : estimatedArrivalAt === null ? 'ETA_INPUT_CURRENT_STOP_UNAVAILABLE' : null,
            etaFailureMessage: null
          }
        });
        if (cursor !== null) cursor += stop.deliveryStop.serviceMinutes * 60_000;
      }
      return result !== null ? { status: 'fresh' }
        : { status: failureCode === 'ROUTE_GEOMETRY_PROVIDER_UNAVAILABLE' ? 'unavailable' : 'failed', errorCode: failureCode };
    };
    return transaction === undefined ? this.prisma.$transaction(commit, { timeout: 15_000 }) : commit(transaction);
  }

  private async sendPublicationNotification(publicationVersionId: string) {
    const leaseToken = randomUUID();
    const now = this.now();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const publication = await tx.routeLiveChangePublication.findUnique({ where: { id: publicationVersionId } });
      if (publication === null) return null;
      // Use the publication writer's lock order: route, then publication.
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${publication.routePlanId}::uuid AND "shopId" = ${publication.shopId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM route_live_change_publications WHERE id = ${publicationVersionId}::uuid FOR UPDATE`;
      const current = await tx.routeLiveChangePublication.findUnique({ where: { id: publicationVersionId } });
      if (current === null || current.notificationStatus === 'SENT' || current.notificationStatus === 'SKIPPED'
        || (current.notificationStatus === 'SENDING' && current.leaseUntil !== null && current.leaseUntil > now)
        || (current.nextAttemptAt !== null && current.nextAttemptAt > now)) return null;
      const route = await tx.routePlan.findFirst({
        select: { id: true, assignmentGeneration: true, ...DELIVERY_COMPLETION_SELECT },
        where: {
          id: current.routePlanId, shopId: current.shopId, driverId: current.driverId,
          assignmentGeneration: current.assignmentGeneration, status: 'IN_PROGRESS',
          driver: { authSubject: { not: null }, status: 'ACTIVE', account: { status: 'ACTIVE' } }
        }
      });
      const state = await tx.routeLiveChangeState.findUnique({ where: { routePlanId: current.routePlanId } });
      if (route === null || hasDeliveryWorkCompleted(route) || state?.latestPublicationId !== current.id) {
        await tx.routeLiveChangePublication.update({
          where: { id: current.id },
          data: { notificationStatus: 'SKIPPED', leaseToken: null, leaseUntil: null, errorCode: 'ASSIGNMENT_OR_PUBLICATION_CHANGED' }
        });
        return null;
      }
      return tx.routeLiveChangePublication.update({
        where: { id: current.id },
        data: {
          notificationStatus: 'SENDING', leaseToken,
          leaseUntil: new Date(now.getTime() + (this.options.notificationLeaseMs ?? 60_000)),
          attemptCount: { increment: 1 }, nextAttemptAt: null, errorCode: null
        }
      });
    });

    if (claimed !== null) {
      // Re-check assignment immediately before any external provider call.
      const route = await this.prisma.routePlan.findFirst({
        select: { driver: { select: { accountId: true } }, assignmentGeneration: true, ...DELIVERY_COMPLETION_SELECT },
        where: {
          id: claimed.routePlanId, shopId: claimed.shopId, driverId: claimed.driverId,
          assignmentGeneration: claimed.assignmentGeneration, status: 'IN_PROGRESS',
          driver: { authSubject: { not: null }, status: 'ACTIVE', account: { status: 'ACTIVE' } }
        }
      });
      let result: DriverRoutePushResult;
      if (route?.driver?.accountId == null || hasDeliveryWorkCompleted(route)) {
        result = { status: 'SKIPPED', errorCode: 'ASSIGNMENT_CHANGED' };
      } else {
        const tokens = await this.prisma.driverPushToken.findMany({
          where: { accountId: route.driver.accountId, appId: KFOOD_DELIVERY_APP_ID, status: 'ACTIVE' }, orderBy: { lastSeenAt: 'desc' }
        });
        const currentRoute = await this.prisma.routePlan.findFirst({
          select: { id: true, assignmentGeneration: true, ...DELIVERY_COMPLETION_SELECT },
          where: {
            id: claimed.routePlanId, shopId: claimed.shopId, driverId: claimed.driverId,
            assignmentGeneration: claimed.assignmentGeneration, status: 'IN_PROGRESS',
            liveChangeState: { latestPublicationId: claimed.id },
            driver: { accountId: route.driver.accountId, authSubject: { not: null }, status: 'ACTIVE', account: { status: 'ACTIVE' } }
          }
        });
        const canSend = currentRoute !== null && !hasDeliveryWorkCompleted(currentRoute);
        const results = !canSend ? [] : await Promise.all(tokens.map(async (token) => {
          const outcome = await this.pushProvider.sendRouteNotification({
            action: 'changed', routePlanId: claimed.routePlanId, devicePushToken: token.devicePushToken,
            publicationVersion: claimed.id,
            metadata: {
              publicationVersionId: claimed.id, assignmentGeneration: claimed.assignmentGeneration.toString(),
              publicationSequence: String(claimed.sequence)
            }
          }).catch((): DriverRoutePushResult => ({ status: 'FAILED', errorCode: 'NOTIFICATION_PROVIDER_FAILED' }));
          if (outcome.invalidToken === true) {
            await this.prisma.driverPushToken.updateMany({
              where: { id: token.id, tokenHash: token.tokenHash }, data: { revokedAt: this.now(), status: 'INVALID' }
            });
          }
          return outcome;
        }));
        result = !canSend ? { status: 'SKIPPED', errorCode: 'ASSIGNMENT_OR_PUBLICATION_CHANGED' }
          : results.find((outcome) => outcome.status === 'SENT')
          ?? results.find((outcome) => outcome.status === 'FAILED')
          ?? results[0] ?? { status: 'FAILED', errorCode: 'NO_ACTIVE_TOKEN' };
        // A provider or token can be configured later; repeated Dispatch retries this same row.
        if (canSend && result.status === 'SKIPPED') result = { ...result, status: 'FAILED' };
      }
      await this.prisma.routeLiveChangePublication.updateMany({
        where: { id: claimed.id, notificationStatus: 'SENDING', leaseToken },
        data: {
          notificationStatus: result.status, leaseToken: null, leaseUntil: null,
          providerId: result.providerMessageId ?? null, errorCode: result.errorCode ?? null,
          sentAt: result.status === 'SENT' ? this.now() : null,
          nextAttemptAt: result.status === 'FAILED' ? this.now() : null
        }
      });
    }
    const notification = await this.prisma.routeLiveChangePublication.findUnique({
      where: { id: publicationVersionId }, select: { notificationStatus: true, attemptCount: true, errorCode: true }
    });
    return notification === null ? null : {
      status: notification.notificationStatus, attemptCount: notification.attemptCount, errorCode: notification.errorCode
    };
  }
}

export function readLiveRouteChangeRouteId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('Invalid route ID');
  return value.toLowerCase();
}

export function readLiveRouteChangeDispatchPayload(value: unknown): {
  commandId: string; expectedAssignmentGeneration: string; expectedRouteVersionId: string; expectedRevision: number
} {
  const body = object(value);
  assertKeys(body, ['commandId', 'expectedAssignmentGeneration', 'expectedRouteVersionId', 'expectedRevision']);
  return {
    commandId: readLiveRouteChangeRouteId(body.commandId),
    expectedAssignmentGeneration: assignmentGeneration(body.expectedAssignmentGeneration),
    expectedRouteVersionId: readLiveRouteChangeRouteId(body.expectedRouteVersionId), expectedRevision: revision(body.expectedRevision)
  };
}

export function readSaveLiveRouteChangePayload(value: unknown): SaveLiveRouteChangePayload {
  const body = object(value);
  assertKeys(body, ['commandId', 'expectedAssignmentGeneration', 'expectedRouteVersionId', 'expectedRevision', 'stopOverrides', 'futureStopOrder']);
  if (!Array.isArray(body.stopOverrides) || body.stopOverrides.length > MAX_STOPS) throw new Error('Invalid stop overrides');
  const stopOverrides = body.stopOverrides.map((value): LiveRouteStopOverride => {
    const row = object(value);
    assertKeys(row, ['deliveryStopId', ...Object.keys(STRING_LIMITS), 'latitude', 'longitude']);
    const result: LiveRouteStopOverride = { deliveryStopId: readLiveRouteChangeRouteId(row.deliveryStopId) };
    for (const [key, limit] of Object.entries(STRING_LIMITS)) {
      if (!Object.hasOwn(row, key)) continue;
      const field = row[key];
      if (field !== null && (typeof field !== 'string' || field.length > limit)) throw new Error('Invalid stop field');
      if (key === 'countryCode' && field !== null && !/^[A-Z]{2}$/u.test(field)) throw new Error('Invalid country code');
      Object.assign(result, { [key]: field });
    }
    if (Object.hasOwn(row, 'latitude') || Object.hasOwn(row, 'longitude')) {
      const latitude = coordinate(row.latitude, 90);
      const longitude = coordinate(row.longitude, 180);
      if ((latitude === null) !== (longitude === null)) throw new Error('Coordinates must be supplied together');
      result.latitude = latitude;
      result.longitude = longitude;
    }
    if (Object.keys(result).length === 1) throw new Error('Empty stop override');
    return result;
  });
  if (new Set(stopOverrides.map((row) => row.deliveryStopId)).size !== stopOverrides.length) throw new Error('Duplicate stop override');
  const result: SaveLiveRouteChangePayload = {
    commandId: readLiveRouteChangeRouteId(body.commandId),
    expectedAssignmentGeneration: assignmentGeneration(body.expectedAssignmentGeneration),
    expectedRouteVersionId: readLiveRouteChangeRouteId(body.expectedRouteVersionId),
    expectedRevision: revision(body.expectedRevision), stopOverrides
  };
  if (Object.hasOwn(body, 'futureStopOrder')) {
    if (!Array.isArray(body.futureStopOrder) || body.futureStopOrder.length === 0 || body.futureStopOrder.length > MAX_STOPS) throw new Error('Invalid stop order');
    result.futureStopOrder = body.futureStopOrder.map(readLiveRouteChangeRouteId);
    if (new Set(result.futureStopOrder).size !== result.futureStopOrder.length) throw new Error('Duplicate stop order');
  }
  if (stopOverrides.length === 0 && result.futureStopOrder === undefined) throw new Error('Empty live route change');
  return result;
}

export function readApplyLiveRouteChangePayload(value: unknown): ApplyLiveRouteChangePayload {
  const body = object(value);
  assertKeys(body, ['publicationVersionId', 'assignmentGeneration']);
  return { publicationVersionId: readLiveRouteChangeRouteId(body.publicationVersionId), assignmentGeneration: assignmentGeneration(body.assignmentGeneration) };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payload');
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown payload field');
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid revision');
  return value;
}

function assignmentGeneration(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/u.test(value)
    || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error('Invalid assignment generation');
  return value;
}

function coordinate(value: unknown, limit: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error('Invalid coordinate');
  return value;
}

function geometryPublicationMatches(route: GeometryRoute | null, publicationVersionId: string, generation: string, signature: string): boolean {
  if (route === null || route.status !== 'IN_PROGRESS' || hasDeliveryWorkCompleted(route) || route.assignmentGeneration.toString() !== generation
    || route.liveChangeState?.latestPublicationId !== publicationVersionId
    || route.liveChangeState.assignmentGeneration !== route.assignmentGeneration
    || route.liveChangeState.driverId !== route.driverId) return false;
  const constraints: Prisma.JsonObject = route.constraints !== null && typeof route.constraints === 'object' && !Array.isArray(route.constraints)
    ? route.constraints : {};
  return computeRouteShapeSignatureFromParts({
    depot: { latitude: route.depotLatitude === null ? null : Number(route.depotLatitude), longitude: route.depotLongitude === null ? null : Number(route.depotLongitude) },
    routeEndMode: constraints.routeEndMode === 'RETURN_TO_DEPOT' ? 'RETURN_TO_DEPOT' : 'END_AT_LAST_STOP',
    tollPolicy: readTollPolicy(constraints),
    stops: route.routeStops.map((stop) => ({
      deliveryStopId: stop.deliveryStopId, orderId: stop.deliveryStop.orderId, sequence: stop.sequence,
      coordinates: {
        latitude: stop.deliveryStop.latitude === null ? null : Number(stop.deliveryStop.latitude),
        longitude: stop.deliveryStop.longitude === null ? null : Number(stop.deliveryStop.longitude)
      }
    }))
  }) === signature;
}

function protectedGeometryStopIndex(route: GeometryRoute): number {
  const terminal = new Set(['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED']);
  let index = route.routeStops.findIndex((stop) => !terminal.has(stop.deliveryStop.status));
  if (index < 0) return route.routeStops.length;
  for (let next = index + 1; next < route.routeStops.length; next += 1) {
    if (['ARRIVED', 'EN_ROUTE'].includes(route.routeStops[next]!.deliveryStop.status)) index = next;
  }
  return index;
}

function isCompleteLiveGeometry(detail: RoutePlanDetail, result: RoutePlanRouteResult): boolean {
  if (result.routeGeometry === null || result.routeMetrics === null || result.routeGeometry.coordinates.length < 2
    || result.routeGeometry.coordinates.some(([longitude, latitude]) => !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90)
    || !nonNegative(result.routeMetrics.distanceMeters) || !nonNegative(result.routeMetrics.durationSeconds)
    || result.routeStopPoints.length !== detail.stops.length) return false;
  const expected = new Map(detail.stops.map((stop) => [stop.deliveryStopId, stop.sequence]));
  return new Set(result.routeStopPoints.map((point) => point.deliveryStopId)).size === expected.size
    && result.routeStopPoints.every((point) => expected.get(point.deliveryStopId) === point.sequence
      && nonNegative(point.distanceFromPreviousMeters) && nonNegative(point.durationFromPreviousSeconds));
}

function nonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
