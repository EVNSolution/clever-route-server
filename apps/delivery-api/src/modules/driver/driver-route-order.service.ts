import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import type { DsvAssignmentTransactionClient, DsvAssignmentTransactionPort } from '../dsv/dsv-assignment-transaction-port.js';
import {
  replaceCurrentRouteGroupingChildVersion,
  syncRoutePlanStopsPreservingRows
} from '../route-grouping/route-grouping.service.js';

type DriverRouteOrderPrisma = DsvAssignmentTransactionPort & Pick<PrismaClient, 'dsvCommandReceipt'>;

export type DriverRouteOrderInput = {
  commandId: string;
  driverId: string;
  expectedVersion: string;
  orderedStopIds: string[];
  routePlanId: string;
  shopId: string;
};

export type DriverRouteOrderResult = {
  routePlanId: string;
  routeVersionId: string;
  stops: Array<{ deliveryStopId: string; sequence: number }>;
};

export type DriverRouteOrderServiceContract = {
  reorder(input: DriverRouteOrderInput): Promise<DriverRouteOrderResult>;
};

export type DriverRouteOrderErrorCode =
  | 'COMMAND_IN_PROGRESS'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'INVALID_STOP_SET'
  | 'ROUTE_COMPLETED'
  | 'ROUTE_SCOPE_REJECTED'
  | 'VERSION_CONFLICT';

export class DriverRouteOrderError extends Error {
  constructor(readonly code: DriverRouteOrderErrorCode, message: string = code) {
    super(message);
    this.name = 'DriverRouteOrderError';
  }
}

const commandName = 'reorderDriverRouteStops';
const transactionOptions = { maxWait: 20_000, timeout: 30_000 } as const;

export class PrismaDriverRouteOrderService implements DriverRouteOrderServiceContract {
  constructor(private readonly prisma: DriverRouteOrderPrisma) {}

  async reorder(input: DriverRouteOrderInput): Promise<DriverRouteOrderResult> {
    const payloadHash = hashPayload(input);
    return this.prisma.$transaction(async (tx) => {
      await lockCommand(tx, input.shopId, input.commandId);
      const existing = await tx.dsvCommandReceipt.findUnique({
        where: { shopId_commandName_commandId: { commandId: input.commandId, commandName, shopId: input.shopId } }
      });
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw new DriverRouteOrderError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        if (existing.status === 'STARTED') throw new DriverRouteOrderError('COMMAND_IN_PROGRESS');
        const replay = parseResult(existing.responseBodyRef);
        if (existing.status === 'SUCCEEDED' && replay !== null) return replay;
        throw new DriverRouteOrderError('VERSION_CONFLICT');
      }

      const receipt = await tx.dsvCommandReceipt.create({
        data: {
          actorId: input.driverId,
          actorType: 'DRIVER',
          commandId: input.commandId,
          commandName,
          payloadHash,
          principalType: 'DRIVER',
          requestId: input.commandId,
          shopId: input.shopId,
          status: 'STARTED'
        },
        select: { id: true }
      });

      await lockRoutePlan(tx, input.shopId, input.routePlanId);
      const routePlan = await tx.routePlan.findFirst({
        include: {
          driverEvents: { select: { eventType: true }, where: { eventType: 'ROUTE_COMPLETED' } },
          routeStops: {
            include: { deliveryStop: { include: { order: { select: { currentRouteVersionId: true, id: true, shopifyOrderGid: true } } } } },
            orderBy: { sequence: 'asc' }
          }
        },
        where: { id: input.routePlanId, shopId: input.shopId }
      });
      if (routePlan === null || routePlan.driverId !== input.driverId) throw new DriverRouteOrderError('ROUTE_SCOPE_REJECTED');
      if (routePlan.status === 'COMPLETED' || routePlan.status === 'CANCELLED' || routePlan.driverEvents.length > 0) {
        throw new DriverRouteOrderError('ROUTE_COMPLETED');
      }

      const currentChild = await tx.routeGroupingChildVersion.findFirst({
        where: {
          driverId: input.driverId,
          id: input.expectedVersion,
          routePlanId: input.routePlanId,
          shopId: input.shopId,
          status: 'CURRENT',
          supersededAt: null
        }
      });
      if (currentChild === null) throw new DriverRouteOrderError('VERSION_CONFLICT');

      const currentStopIds = routePlan.routeStops.map((stop) => stop.deliveryStopId);
      if (!isExactSet(input.orderedStopIds, currentStopIds)) throw new DriverRouteOrderError('INVALID_STOP_SET');
      if (routePlan.routeStops.some((stop) => stop.deliveryStop.order.currentRouteVersionId !== currentChild.id)) {
        throw new DriverRouteOrderError('VERSION_CONFLICT');
      }

      const stopById = new Map(routePlan.routeStops.map((stop) => [stop.deliveryStopId, stop]));
      const orderedStops = input.orderedStopIds.map((deliveryStopId) => {
        const stop = stopById.get(deliveryStopId);
        if (stop === undefined) throw new DriverRouteOrderError('INVALID_STOP_SET');
        return stop;
      });
      await syncRoutePlanStopsPreservingRows(tx, input.shopId, input.routePlanId, orderedStops);
      await tx.routePlanGeometryCache.deleteMany({ where: { routePlanId: input.routePlanId } });
      const nextVersionId = await replaceCurrentRouteGroupingChildVersion(tx, {
        currentChildId: currentChild.id,
        driverId: input.driverId,
        groupingId: currentChild.groupingId,
        groupingVersionId: currentChild.groupingVersionId,
        notificationStatus: currentChild.notificationStatus,
        orderIds: orderedStops.map((stop) => stop.deliveryStop.order.id),
        publishedAt: currentChild.publishedAt,
        routePlanId: input.routePlanId,
        shopId: input.shopId,
        snapshot: reorderedSnapshot(currentChild.snapshot, orderedStops),
        version: currentChild.version
      });
      await tx.routePlanStop.updateMany({
        data: {
          distanceFromPreviousMeters: null,
          durationFromPreviousSeconds: null,
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: nextVersionId,
          etaSource: null,
          etaStatus: 'PENDING'
        },
        where: { routePlanId: input.routePlanId, shopId: input.shopId }
      });

      const result: DriverRouteOrderResult = {
        routePlanId: input.routePlanId,
        routeVersionId: nextVersionId,
        stops: input.orderedStopIds.map((deliveryStopId, index) => ({ deliveryStopId, sequence: index + 1 }))
      };
      const completed = await tx.dsvCommandReceipt.updateMany({
        data: {
          completedAt: new Date(),
          nextRoutePlanId: input.routePlanId,
          nextRouteVersionId: nextVersionId,
          previousRoutePlanId: input.routePlanId,
          previousRouteVersionId: currentChild.id,
          responseBodyRef: canonicalJson(result),
          responseStatus: 200,
          resultEntityId: input.routePlanId,
          resultEntityType: 'RoutePlan',
          status: 'SUCCEEDED'
        },
        where: { id: receipt.id, payloadHash, shopId: input.shopId, status: 'STARTED' }
      });
      if (completed.count !== 1) throw new DriverRouteOrderError('VERSION_CONFLICT');
      return result;
    }, transactionOptions);
  }
}

function isExactSet(requested: string[], current: string[]): boolean {
  return requested.length === current.length
    && new Set(requested).size === requested.length
    && requested.every((id) => current.includes(id));
}

function reorderedSnapshot(
  snapshot: Prisma.JsonValue,
  stops: Array<{ deliveryStopId: string; deliveryStop: { order: { id: string; shopifyOrderGid: string } } }>
): Prisma.InputJsonValue {
  const base = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot
    : {};
  return {
    ...base,
    membershipDeleted: false,
    membershipFormat: 'MODERN',
    membershipSchemaVersion: 1,
    predecessorChildVersionId: null,
    stops: stops.map((stop, index) => ({
      deliveryStopId: stop.deliveryStopId,
      orderId: stop.deliveryStop.order.id,
      sequence: index + 1,
      sourceOrderId: stop.deliveryStop.order.shopifyOrderGid
    }))
  };
}

function hashPayload(input: DriverRouteOrderInput): string {
  return createHash('sha256').update(canonicalJson({
    commandId: input.commandId,
    driverId: input.driverId,
    expectedVersion: input.expectedVersion,
    orderedStopIds: input.orderedStopIds,
    routePlanId: input.routePlanId,
    shopId: input.shopId
  })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function parseResult(value: string | null): DriverRouteOrderResult | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DriverRouteOrderResult>;
    return typeof parsed.routePlanId === 'string'
      && typeof parsed.routeVersionId === 'string'
      && Array.isArray(parsed.stops)
      ? parsed as DriverRouteOrderResult
      : null;
  } catch {
    return null;
  }
}

async function lockCommand(tx: Pick<DsvAssignmentTransactionClient, '$queryRaw'>, shopId: string, commandId: string): Promise<void> {
  await tx.$queryRaw`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`driver-route-order:${shopId}:${commandId}`}, 0))) SELECT 1 FROM lock`;
}

async function lockRoutePlan(tx: Pick<DsvAssignmentTransactionClient, '$queryRaw'>, shopId: string, routePlanId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${routePlanId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
}
