import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import type {
  DsvExecutionCloseInput,
  DsvExecutionCloseResult,
  DsvExecutionCommandInput,
  DsvExecutionContentSnapshot,
  DsvExecutionSelectionInput,
  DsvExecutionSelectionResult,
  DsvExecutionSyncInput,
  DsvExecutionSyncResult,
} from './dsv-execution-context.types.js';
import { DsvExecutionContextError } from './dsv-execution-context.types.js';

type Tx = Prisma.TransactionClient;

type ExecutionRow = {
  assignmentEpoch: bigint;
  contentFingerprint: string;
  contentSnapshot: Prisma.JsonValue;
  driverId: string | null;
  effectiveAt: Date;
  id: string;
  policy: Prisma.JsonValue | null;
  recipientAccountId: string | null;
  routePlanId: string;
  routeVersion: number;
  shopId: string;
  startedAt: Date | null;
  status: string;
  vehicleId: string | null;
};

type RouteSnapshot = {
  childVersionId: string;
  content: DsvExecutionContentSnapshot;
  contentFingerprint: string;
  driverId: string;
  planDate: Date;
  publishedAt: Date;
  recipientAccountId: string | null;
  routePlanId: string;
  shopId: string;
  startedAt: Date | null;
  vehicleId: string | null;
};

type RouteReadResult =
  | { closeReason: 'CANCELLED' | 'COMPLETED'; route: null }
  | { closeReason: null; route: RouteSnapshot }
  | { closeReason: null; route: null };

const LIVE_CONTEXT_STATUSES = ['ACTIVE'] as const;
const OPEN_NOTIFICATION_STATUSES = ['OPEN', 'PENDING'] as const;
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class PrismaDsvExecutionContextService {
  constructor(private readonly tx: Tx) {}

  async syncForRoute(input: DsvExecutionSyncInput): Promise<DsvExecutionSyncResult> {
    if (!hasExecutionDelegates(this.tx)) return unavailableSync(input.routePlanId);
    return this.runCommand<DsvExecutionSyncResult>({
      commandId: input.commandId,
      commandName: `SYNC_ROUTE_EXECUTION:${input.routePlanId}`,
      payload: syncCommandPayload(input),
      shopId: input.shopId,
    }, async () => this.syncForRouteClaimed(input));
  }

  async closeForRoute(input: DsvExecutionCloseInput): Promise<DsvExecutionCloseResult> {
    if (!hasExecutionDelegates(this.tx)) return {
      executionContextId: null,
      outcome: 'SKIPPED_UNAVAILABLE',
      status: null,
    };
    const execute = async () => this.closeForRouteClaimed(input);
    if (input.commandId === undefined) {
      await lockCommand(this.tx, input.shopId, `route:${input.routePlanId}`);
      return execute();
    }
    return this.runCommand<DsvExecutionCloseResult>({
      commandId: input.commandId,
      commandName: `CLOSE_EXECUTION_${input.reason}:${input.routePlanId}`,
      payload: commandPayload(input),
      shopId: input.shopId,
    }, execute);
  }

  async selectActiveExecution(input: DsvExecutionSelectionInput): Promise<DsvExecutionSelectionResult> {
    if (input.validUntil.getTime() <= input.validFrom.getTime()) {
      throw new DsvExecutionContextError('SELECTION_INTERVAL_INVALID');
    }
    return this.runCommand<DsvExecutionSelectionResult>({
      commandId: input.commandId,
      commandName: 'SELECT_ACTIVE_EXECUTION',
      payload: commandPayload(input),
      shopId: input.shopId,
    }, async () => {
      await lockCommand(this.tx, input.shopId, `vehicle:${input.vehicleId}`);
      await validateVehicle(this.tx, input.shopId, input.vehicleId);
      await lockExecutionContext(this.tx, input.shopId, input.executionContextId);
      const context = await this.tx.dsvExecutionContext.findFirst({
        where: {
          id: input.executionContextId,
          shopId: input.shopId,
          status: { in: [...LIVE_CONTEXT_STATUSES] },
          vehicleId: input.vehicleId,
        },
      });
      if (context === null) throw new DsvExecutionContextError('EXECUTION_CONTEXT_SCOPE_INVALID');
      const overlap = await this.tx.dsvExecutionSelection.findFirst({
        where: {
          shopId: input.shopId,
          validFrom: { lt: input.validUntil },
          validUntil: { gt: input.validFrom },
          vehicleId: input.vehicleId,
        },
      });
      if (overlap !== null) throw new DsvExecutionContextError('SELECTION_INTERVAL_OVERLAP');
      await this.tx.dsvExecutionSelection.create({
        data: {
          executionContextId: context.id,
          shopId: input.shopId,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          vehicleId: input.vehicleId,
        },
      });
      return { executionContextId: context.id, outcome: 'ACCEPT', vehicleId: input.vehicleId };
    });
  }

  async resolveSelectedExecution(input: { at: Date; shopId: string; vehicleId: string }): Promise<ExecutionRow | null> {
    const selected = await this.tx.dsvExecutionSelection.findFirst({
      orderBy: { validFrom: 'desc' },
      where: {
        shopId: input.shopId,
        validFrom: { lte: input.at },
        validUntil: { gt: input.at },
        vehicleId: input.vehicleId,
      },
    });
    if (selected !== null) {
      return this.tx.dsvExecutionContext.findFirst({
        where: {
          id: selected.executionContextId,
          shopId: input.shopId,
          status: { in: [...LIVE_CONTEXT_STATUSES] },
          vehicleId: input.vehicleId,
        },
      });
    }
    const candidates = await this.tx.dsvExecutionContext.findMany({
      take: 2,
      where: {
        shopId: input.shopId,
        status: { in: [...LIVE_CONTEXT_STATUSES] },
        vehicleId: input.vehicleId,
      },
    });
    return candidates.length === 1 ? candidates[0] as ExecutionRow : null;
  }

  async runCommand<T extends Prisma.InputJsonValue>(
    input: DsvExecutionCommandInput,
    execute: () => Promise<T>,
  ): Promise<T> {
    await lockCommand(this.tx, input.shopId, `${input.commandName}:${input.commandId}`);
    const payloadHash = sha256CanonicalJson(input.payload);
    const existing = await this.tx.dsvExecutionCommand.findUnique({
      where: {
        shopId_commandName_commandId: {
          commandId: input.commandId,
          commandName: input.commandName,
          shopId: input.shopId,
        },
      },
    });
    if (existing !== null) {
      if (existing.payloadHash !== payloadHash) {
        throw new DsvExecutionContextError('COMMAND_PAYLOAD_MISMATCH');
      }
      // Prisma stores command results as JSON. The command type fixes the result shape.
      return { ...(existing.result as T & object), outcome: 'REPLAY' };
    }
    const result = await execute();
    await this.tx.dsvExecutionCommand.create({
      data: {
        commandId: input.commandId,
        commandName: input.commandName,
        payloadHash,
        result,
        shopId: input.shopId,
      },
    });
    return result;
  }

  private async syncForRouteClaimed(input: DsvExecutionSyncInput): Promise<DsvExecutionSyncResult> {
    const now = input.now ?? new Date();
    await lockCommand(this.tx, input.shopId, `route:${input.routePlanId}`);
    await lockRoutePlan(this.tx, input.shopId, input.routePlanId);
    if (input.executionContextId !== undefined) {
      await lockCommand(this.tx, input.shopId, `context:${input.executionContextId}`);
    }
    const currentMapping = await this.tx.dsvExecutionRouteMapping.findFirst({
      orderBy: { validFrom: 'desc' },
      where: { routePlanId: input.routePlanId, shopId: input.shopId, validUntil: null },
    });
    const routeRead = await loadRouteSnapshot(this.tx, input.shopId, input.routePlanId, currentMapping !== null);
    if (routeRead.closeReason !== null && currentMapping !== null) {
      await lockExecutionContext(this.tx, input.shopId, currentMapping.executionContextId);
      const closed = await this.closeMappedContext(currentMapping.executionContextId, input.shopId, routeRead.closeReason, now);
      return closed === null
        ? mappingRequired(input.routePlanId)
        : resultFor(closed, input.routePlanId, routeRead.closeReason === 'CANCELLED' && closed.recipientAccountId !== null ? ['N03'] : []);
    }
    const route = routeRead.route;
    if (route === null) return skippedNonDsv(input.routePlanId);
    if (currentMapping !== null) {
      await lockExecutionContext(this.tx, input.shopId, currentMapping.executionContextId);
      if (input.tripIntent === 'NEW_EXECUTION') {
        throw new DsvExecutionContextError('NEW_EXECUTION_REQUIRES_UNMAPPED_ROUTE');
      }
      if (input.tripIntent === 'SAME_EXECUTION'
        && input.executionContextId !== undefined
        && input.executionContextId !== currentMapping.executionContextId) {
        throw new DsvExecutionContextError('EXECUTION_CONTEXT_SCOPE_INVALID');
      }
      const context = await this.tx.dsvExecutionContext.findFirst({
        where: { id: currentMapping.executionContextId, shopId: input.shopId },
      }) as ExecutionRow | null;
      if (context === null) throw new DsvExecutionContextError('EXECUTION_CONTEXT_SCOPE_INVALID');
      return this.updateExistingContext(context, route, now);
    }

    if (input.tripIntent === 'SAME_EXECUTION') {
      if (input.executionContextId === undefined) {
        throw new DsvExecutionContextError('SAME_EXECUTION_CONTEXT_REQUIRED');
      }
      await lockExecutionContext(this.tx, input.shopId, input.executionContextId);
      const context = await this.tx.dsvExecutionContext.findFirst({
        where: { id: input.executionContextId, shopId: input.shopId },
      }) as ExecutionRow | null;
      if (context === null) throw new DsvExecutionContextError('EXECUTION_CONTEXT_SCOPE_INVALID');
      if (context.status !== 'ACTIVE') throw new DsvExecutionContextError('CLOSED_EXECUTION_CONTEXT');
      await this.validateRebindEffectiveAt(context, route, now);
      await this.rebindRoute(context, route, now);
      return this.updateExistingContext(context, route, now);
    }

    const createIsExplicit = input.tripIntent === 'NEW_EXECUTION' || input.tripIntent === 'INITIAL_EXECUTION';
    const isFirstPublication = input.firstPublication === true || input.previousPublishedAt === null;
    if (!createIsExplicit && !isFirstPublication) return mappingRequired(input.routePlanId);
    if (now.getTime() < route.publishedAt.getTime()) {
      throw new DsvExecutionContextError('MAPPING_EFFECTIVE_TIME_INVALID');
    }
    if (route.vehicleId !== null) {
      await lockCommand(
        this.tx,
        input.shopId,
        `vehicle-service-date:${route.vehicleId}:${route.planDate.toISOString().slice(0, 10)}`,
      );
    }

    const possibleExisting = route.vehicleId === null ? [] : await this.tx.dsvExecutionContext.findMany({
      take: 1,
      where: {
        serviceDate: route.planDate,
        shopId: input.shopId,
        vehicleId: route.vehicleId,
      },
    });
    if (input.tripIntent !== 'NEW_EXECUTION' && possibleExisting.length > 0) {
      return mappingRequired(input.routePlanId);
    }
    return this.createContext(route, now);
  }

  private async createContext(route: RouteSnapshot, now: Date): Promise<DsvExecutionSyncResult> {
    const context = await this.tx.dsvExecutionContext.create({
      data: {
        assignmentEpoch: 1n,
        contentFingerprint: route.contentFingerprint,
        contentSnapshot: route.content,
        driverId: route.driverId,
        effectiveAt: now,
        notificationMode: 'OFF',
        recipientAccountId: route.recipientAccountId,
        reminderStatus: 'AWAITING_DEPARTURE',
        routePlanId: route.routePlanId,
        routeVersion: 1,
        serviceDate: route.planDate,
        shopId: route.shopId,
        ...(route.startedAt === null ? {} : {
          reminderStatus: 'RESOLVED_START',
          startedAt: route.startedAt,
        }),
        status: 'ACTIVE',
        vehicleId: route.vehicleId,
      },
    });
    await this.tx.dsvExecutionRouteMapping.create({
      data: {
        executionContextId: context.id,
        routePlanId: route.routePlanId,
        shopId: context.shopId,
        validFrom: now,
      },
    });
    const notificationKinds: string[] = [];
    if (route.recipientAccountId !== null) {
      await createNotification(this.tx, context, 'N01', now, {
        routePlanId: route.routePlanId,
        routeVersionId: route.childVersionId,
      });
      notificationKinds.push('N01');
    }
    return resultFor(context, route.routePlanId, notificationKinds);
  }

  private async updateExistingContext(
    context: ExecutionRow,
    route: RouteSnapshot,
    now: Date,
  ): Promise<DsvExecutionSyncResult> {
    const assignmentChanged = context.driverId !== route.driverId
      || context.recipientAccountId !== route.recipientAccountId
      || context.vehicleId !== route.vehicleId;
    const contentChanged = context.contentFingerprint !== route.contentFingerprint;
    const snapshotChanged = canonicalJson(context.contentSnapshot) !== canonicalJson(route.content);
    if (context.status !== 'ACTIVE') {
      if (assignmentChanged || contentChanged || context.routePlanId !== route.routePlanId) {
        throw new DsvExecutionContextError('CLOSED_EXECUTION_CONTEXT');
      }
      return resultFor(context, route.routePlanId, []);
    }
    const newlyObservedStart = context.startedAt === null && route.startedAt !== null;
    if (!assignmentChanged && !contentChanged && !snapshotChanged
      && context.routePlanId === route.routePlanId && !newlyObservedStart) {
      return resultFor(context, route.routePlanId, []);
    }

    const previousEpoch = context.assignmentEpoch;
    const previousDriverId = context.driverId;
    const previousRecipientAccountId = context.recipientAccountId;
    const nextEpoch = assignmentChanged ? previousEpoch + 1n : previousEpoch;
    const nextVersion = contentChanged ? context.routeVersion + 1 : context.routeVersion;
    if (context.vehicleId !== route.vehicleId) {
      if (route.vehicleId !== null) {
        await lockCommand(this.tx, route.shopId,
          `vehicle-service-date:${route.vehicleId}:${route.planDate.toISOString().slice(0, 10)}`);
      }
      await closeSelections(this.tx, context.id, route.shopId, now);
    }
    if (assignmentChanged) {
      await resolveOpenNotifications(this.tx, context.id, now, 'ASSIGNMENT_REPLACED');
    } else if (newlyObservedStart) {
      await resolveOpenNotifications(this.tx, context.id, now, 'ROUTE_STARTED', ['N04', 'N05']);
    } else if (contentChanged) {
      await resolveOpenNotifications(this.tx, context.id, now, 'CONTENT_SUPERSEDED', ['N01', 'N02', 'N06']);
    }
    const updated = await this.tx.dsvExecutionContext.update({
      data: {
        assignmentEpoch: nextEpoch,
        contentFingerprint: route.contentFingerprint,
        contentSnapshot: route.content,
        driverId: route.driverId,
        effectiveAt: now,
        recipientAccountId: route.recipientAccountId,
        routePlanId: route.routePlanId,
        routeVersion: nextVersion,
        vehicleId: route.vehicleId,
        ...(newlyObservedStart ? {
          reminderDueAt: null,
          reminderStatus: 'RESOLVED_START',
          startedAt: route.startedAt,
        } : {}),
        ...(assignmentChanged ? {
          departureObservedAt: null,
          reminderDueAt: null,
          reminderIncidentId: null,
          reminderOrdinal: 0,
          reminderStatus: 'AWAITING_FRESH_DEPARTURE',
        } : {}),
      },
      where: { id_shopId: { id: context.id, shopId: route.shopId } },
    });

    const notificationKinds: string[] = [];
    const assignmentOwnerChanged = previousDriverId !== route.driverId
      || previousRecipientAccountId !== route.recipientAccountId;
    if (assignmentChanged && previousRecipientAccountId !== null && assignmentOwnerChanged) {
      await createNotification(this.tx, {
        ...updated,
        assignmentEpoch: previousEpoch,
        recipientAccountId: previousRecipientAccountId,
      }, 'N03', now, { releasedAt: now.toISOString() });
      notificationKinds.push('N03');
    }
    if (route.recipientAccountId !== null && (assignmentChanged || contentChanged)) {
      const kind = assignmentChanged && assignmentOwnerChanged ? 'N01' : 'N02';
      await createNotification(this.tx, updated, kind, now, {
        routePlanId: route.routePlanId,
        routeVersionId: route.childVersionId,
      });
      notificationKinds.push(kind);
    }
    return resultFor(updated, route.routePlanId, notificationKinds);
  }

  private async rebindRoute(context: ExecutionRow, route: RouteSnapshot, now: Date): Promise<void> {
    await this.tx.dsvExecutionRouteMapping.updateMany({
      data: { validUntil: now },
      where: { executionContextId: context.id, shopId: route.shopId, validUntil: null },
    });
    await this.tx.dsvExecutionRouteMapping.create({
      data: {
        executionContextId: context.id,
        routePlanId: route.routePlanId,
        shopId: route.shopId,
        validFrom: now,
      },
    });
  }

  private async validateRebindEffectiveAt(context: ExecutionRow, route: RouteSnapshot, now: Date): Promise<void> {
    if (now.getTime() < context.effectiveAt.getTime() || now.getTime() < route.publishedAt.getTime()) {
      throw new DsvExecutionContextError('MAPPING_EFFECTIVE_TIME_INVALID');
    }
    const activeMapping = await this.tx.dsvExecutionRouteMapping.findFirst({
      orderBy: { validFrom: 'desc' },
      where: { executionContextId: context.id, shopId: route.shopId, validUntil: null },
    });
    if (activeMapping !== null && now.getTime() < activeMapping.validFrom.getTime()) {
      throw new DsvExecutionContextError('MAPPING_EFFECTIVE_TIME_INVALID');
    }
  }

  private async closeForRouteClaimed(input: DsvExecutionCloseInput): Promise<DsvExecutionCloseResult> {
    const now = input.now ?? new Date();
    await lockRoutePlan(this.tx, input.shopId, input.routePlanId);
    const mapping = await this.tx.dsvExecutionRouteMapping.findFirst({
      orderBy: { validFrom: 'desc' },
      where: { routePlanId: input.routePlanId, shopId: input.shopId, validUntil: null },
    });
    if (mapping === null) return { executionContextId: null, outcome: 'NOT_FOUND', status: null };
    await lockExecutionContext(this.tx, input.shopId, mapping.executionContextId);
    const context = await this.tx.dsvExecutionContext.findFirst({
      where: { id: mapping.executionContextId, shopId: input.shopId },
    });
    if (context === null) return { executionContextId: null, outcome: 'NOT_FOUND', status: null };
    if (context.status !== 'ACTIVE') {
      return { executionContextId: context.id, outcome: 'ALREADY_CLOSED', status: context.status as 'CANCELLED' | 'COMPLETED' };
    }
    await resolveOpenNotifications(this.tx, context.id, now, input.reason);
    await closeSelections(this.tx, context.id, input.shopId, now);
    if (input.reason === 'CANCELLED' && context.recipientAccountId !== null) {
      await createNotification(this.tx, context, 'N03', now, { cancelledAt: now.toISOString() });
    }
    await this.tx.dsvExecutionRouteMapping.updateMany({
      data: { validUntil: now },
      where: { executionContextId: context.id, shopId: input.shopId, validUntil: null },
    });
    await this.tx.dsvExecutionContext.update({
      data: {
        closedAt: now,
        monitorEndAt: now,
        reminderDueAt: null,
        reminderStatus: 'ENDED',
        status: input.reason,
      },
      where: { id_shopId: { id: context.id, shopId: input.shopId } },
    });
    return { executionContextId: context.id, outcome: 'ACCEPT', status: input.reason };
  }

  private async closeMappedContext(
    executionContextId: string,
    shopId: string,
    reason: 'CANCELLED' | 'COMPLETED',
    now: Date,
  ): Promise<ExecutionRow | null> {
    const context = await this.tx.dsvExecutionContext.findFirst({
      where: { id: executionContextId, shopId },
    }) as ExecutionRow | null;
    if (context === null || context.status !== 'ACTIVE') return context;
    await resolveOpenNotifications(this.tx, context.id, now, reason);
    await closeSelections(this.tx, context.id, shopId, now);
    if (reason === 'CANCELLED' && context.recipientAccountId !== null) {
      await createNotification(this.tx, context, 'N03', now, { cancelledAt: now.toISOString() });
    }
    await this.tx.dsvExecutionRouteMapping.updateMany({
      data: { validUntil: now },
      where: { executionContextId: context.id, shopId, validUntil: null },
    });
    return this.tx.dsvExecutionContext.update({
      data: {
        closedAt: now,
        monitorEndAt: now,
        reminderDueAt: null,
        reminderStatus: 'ENDED',
        status: reason,
      },
      where: { id_shopId: { id: context.id, shopId } },
    });
  }
}

export async function syncDsvExecutionForRoute(
  tx: Tx,
  input: DsvExecutionSyncInput,
): Promise<DsvExecutionSyncResult> {
  return new PrismaDsvExecutionContextService(tx).syncForRoute(input);
}

export async function closeDsvExecutionForRoute(
  tx: Tx,
  input: DsvExecutionCloseInput,
): Promise<DsvExecutionCloseResult> {
  return new PrismaDsvExecutionContextService(tx).closeForRoute(input);
}

async function loadRouteSnapshot(
  tx: Tx,
  shopId: string,
  routePlanId: string,
  hasExistingMapping: boolean,
): Promise<RouteReadResult> {
  const route = await tx.routePlan.findUnique({
    select: {
      depotLatitude: true,
      depotLongitude: true,
      driverId: true,
      id: true,
      planDate: true,
      driverEvents: {
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
        take: 1,
        where: { eventType: 'ROUTE_STARTED' },
      },
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: {
          deliveryStop: {
            select: {
              latitude: true,
              longitude: true,
              address1: true,
              address2: true,
              countryCode: true,
              order: { select: { destinationId: true, id: true, rawPayload: true, sellerOrderSourceKind: true } },
              postalCode: true,
              status: true,
            },
          },
          deliveryStopId: true,
          sequence: true,
        },
      },
      vehicleId: true,
      status: true,
    },
    where: { id_shopId: { id: routePlanId, shopId } },
  });
  if (route === null) throw new DsvExecutionContextError('ROUTE_SCOPE_INVALID');
  if (route.status === 'COMPLETED' || route.status === 'INCOMPLETE') {
    return { closeReason: 'COMPLETED', route: null };
  }
  if (route.status === 'CANCELLED') return { closeReason: 'CANCELLED', route: null };
  const dsvStops = route.routeStops.filter((stop) => {
    const sourceKind = stop.deliveryStop.order.sellerOrderSourceKind;
    return sourceKind === 'DSV_DISPATCH' || sourceKind === 'DSV_DISPATCH_IMPORT';
  });
  if (dsvStops.length === 0) {
    return hasExistingMapping ? { closeReason: 'CANCELLED', route: null } : { closeReason: null, route: null };
  }
  if (dsvStops.length !== route.routeStops.length) {
    throw new DsvExecutionContextError('ROUTE_CURRENT_SNAPSHOT_INVALID');
  }
  if (route.driverId === null) {
    return hasExistingMapping ? { closeReason: 'CANCELLED', route: null } : { closeReason: null, route: null };
  }
  const child = await tx.routeGroupingChildVersion.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { driverId: true, id: true, publishedAt: true, snapshot: true },
    where: { routePlanId, shopId, status: 'CURRENT', supersededAt: null },
  });
  if (child === null || child.publishedAt === null || child.driverId !== route.driverId) {
    if (hasExistingMapping) return { closeReason: 'CANCELLED', route: null };
    throw new DsvExecutionContextError('ROUTE_CURRENT_SNAPSHOT_INVALID');
  }
  const snapshotStopIds = readChildStopIds(child.snapshot);
  if (snapshotStopIds.length !== dsvStops.length
    || dsvStops.some((stop) => !snapshotStopIds.includes(stop.deliveryStopId))) {
    throw new DsvExecutionContextError('ROUTE_CURRENT_SNAPSHOT_INVALID');
  }
  let driver: { accountId: string | null };
  try {
    driver = await validateDriver(tx, shopId, route.driverId);
    if (route.vehicleId !== null) await validateVehicle(tx, shopId, route.vehicleId);
  } catch (error) {
    if (hasExistingMapping && error instanceof DsvExecutionContextError) {
      return { closeReason: 'CANCELLED', route: null };
    }
    throw error;
  }
  const content: DsvExecutionContentSnapshot = {
    depot: route.depotLatitude === null || route.depotLongitude === null ? null : {
      latitude: Number(route.depotLatitude),
      longitude: Number(route.depotLongitude),
    },
    stops: dsvStops.map((stop) => ({
      address: {
        address1: stop.deliveryStop.address1,
        address2: stop.deliveryStop.address2,
        countryCode: stop.deliveryStop.countryCode,
        postalCode: stop.deliveryStop.postalCode,
      },
      destinationId: stop.deliveryStop.order.destinationId,
      id: stop.deliveryStopId,
      latitude: stop.deliveryStop.latitude === null ? null : Number(stop.deliveryStop.latitude),
      longitude: stop.deliveryStop.longitude === null ? null : Number(stop.deliveryStop.longitude),
      orderId: stop.deliveryStop.order.id,
      quantity: readShippedBoxes(stop.deliveryStop.order.rawPayload),
      sequence: stop.sequence,
      status: stop.deliveryStop.status,
    })),
  };
  return { closeReason: null, route: {
    childVersionId: child.id,
    content,
    contentFingerprint: contentFingerprint(content),
    driverId: route.driverId,
    planDate: route.planDate,
    publishedAt: child.publishedAt,
    recipientAccountId: driver.accountId,
    routePlanId: route.id,
    shopId,
    startedAt: route.driverEvents[0]?.occurredAt ?? null,
    vehicleId: route.vehicleId,
  } };
}

async function validateDriver(tx: Tx, shopId: string, driverId: string): Promise<{ accountId: string | null }> {
  const driver = await tx.driver.findUnique({
    select: { accountId: true, status: true },
    where: { id_shopId: { id: driverId, shopId } },
  });
  if (driver === null || driver.status !== 'ACTIVE') throw new DsvExecutionContextError('DRIVER_SCOPE_INVALID');
  if (driver.accountId !== null) {
    const account = await tx.driverAccount.findUnique({
      select: { status: true },
      where: { id: driver.accountId },
    });
    if (account === null || account.status !== 'ACTIVE') {
      throw new DsvExecutionContextError('DRIVER_ACCOUNT_SCOPE_INVALID');
    }
  }
  return { accountId: driver.accountId };
}

async function validateVehicle(tx: Tx, shopId: string, vehicleId: string): Promise<void> {
  const vehicle = await tx.vehicle.findUnique({
    select: { status: true },
    where: { id_shopId: { id: vehicleId, shopId } },
  });
  if (vehicle === null || vehicle.status !== 'ACTIVE') throw new DsvExecutionContextError('VEHICLE_SCOPE_INVALID');
}

async function createNotification(
  tx: Tx,
  context: {
    assignmentEpoch: bigint;
    id: string;
    policy?: Prisma.JsonValue | null;
    recipientAccountId: string | null;
    routeVersion: number;
    shopId: string;
  },
  kind: 'N01' | 'N02' | 'N03',
  now: Date,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  if (context.recipientAccountId === null) return;
  const logicalKey = kind === 'N02'
    ? `${kind}:${context.id}:${context.routeVersion}:${context.assignmentEpoch.toString()}`
    : `${kind}:${context.id}:${context.assignmentEpoch.toString()}`;
  await tx.dsvOperationalNotification.upsert({
    create: {
      assignmentEpoch: context.assignmentEpoch,
      audience: 'DRIVER',
      dueAt: now,
      executionContextId: context.id,
      expiresAt: new Date(now.getTime() + notificationRetentionMs(context.policy)),
      kind,
      logicalKey,
      payload,
      recipientAccountId: context.recipientAccountId,
      routeVersion: context.routeVersion,
      shopId: context.shopId,
    },
    update: {},
    where: { logicalKey },
  });
}

function notificationRetentionMs(policy: Prisma.JsonValue | null | undefined): number {
  if (policy === null || policy === undefined || typeof policy !== 'object' || Array.isArray(policy)) {
    return NOTIFICATION_RETENTION_MS;
  }
  const seconds = (policy as Record<string, unknown>).notificationTtlSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : NOTIFICATION_RETENTION_MS;
}

async function resolveOpenNotifications(
  tx: Tx,
  executionContextId: string,
  now: Date,
  reason: string,
  kinds?: string[],
): Promise<void> {
  await tx.dsvOperationalNotification.updateMany({
    data: { businessStatus: 'RESOLVED', resolvedAt: now, resolutionReason: reason },
    where: {
      audience: 'DRIVER',
      businessStatus: { in: [...OPEN_NOTIFICATION_STATUSES] },
      executionContextId,
      ...(kinds === undefined ? {} : { kind: { in: kinds } }),
    },
  });
}

async function lockCommand(tx: Tx, shopId: string, key: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-execution:${shopId}:${key}`}, 0))
    )
    SELECT 1 AS locked FROM lock
  `);
}

async function lockRoutePlan(tx: Tx, shopId: string, routePlanId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM route_plans
    WHERE id = ${routePlanId}::uuid AND "shopId" = ${shopId}::uuid
    FOR UPDATE
  `);
}

async function lockExecutionContext(tx: Tx, shopId: string, executionContextId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM dsv_execution_contexts
    WHERE id = ${executionContextId}::uuid AND "shopId" = ${shopId}::uuid
    FOR UPDATE
  `);
}

async function closeSelections(tx: Tx, executionContextId: string, shopId: string, now: Date): Promise<void> {
  await tx.dsvExecutionSelection.updateMany({
    data: { validUntil: now },
    where: {
      executionContextId,
      shopId,
      validFrom: { lt: now },
      validUntil: { gt: now },
    },
  });
  await tx.dsvExecutionSelection.deleteMany({
    where: { executionContextId, shopId, validFrom: { gte: now } },
  });
}

function commandPayload(input: object): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(input, (_key, value: unknown) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    return value;
  })) as Prisma.InputJsonValue;
}

function syncCommandPayload(input: DsvExecutionSyncInput): Prisma.InputJsonValue {
  return commandPayload({
    commandId: input.commandId,
    executionContextId: input.executionContextId,
    now: input.now,
    routePlanId: input.routePlanId,
    shopId: input.shopId,
    tripIntent: input.tripIntent,
  });
}

function sha256CanonicalJson(value: Prisma.InputJsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function contentFingerprint(content: DsvExecutionContentSnapshot): string {
  return sha256CanonicalJson({
    depot: content.depot,
    stops: content.stops.map((stop) => ({
      address: stop.address,
      destinationId: stop.destinationId,
      id: stop.id,
      latitude: stop.latitude,
      longitude: stop.longitude,
      orderId: stop.orderId,
      quantity: stop.quantity,
      sequence: stop.sequence,
    })),
  });
}

function readChildStopIds(snapshot: Prisma.JsonValue): string[] {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const object = snapshot as Record<string, unknown>;
  const stops = object.stops;
  if (!Array.isArray(stops)) {
    const legacyStopIds = object.deliveryStopIds;
    return Array.isArray(legacyStopIds)
      ? legacyStopIds.filter((value): value is string => typeof value === 'string')
      : [];
  }
  return stops.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const id = (entry as Record<string, unknown>).deliveryStopId;
    return typeof id === 'string' ? [id] : [];
  });
}

function readShippedBoxes(rawPayload: Prisma.JsonValue): number | null {
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;
  const dsv = (rawPayload as Record<string, unknown>).dsv;
  if (dsv === null || typeof dsv !== 'object' || Array.isArray(dsv)) return null;
  const normalized = (dsv as Record<string, unknown>).normalized;
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) return null;
  const quantity = (normalized as Record<string, unknown>).shippedBoxes;
  return typeof quantity === 'number' && Number.isInteger(quantity) ? quantity : null;
}

function resultFor(
  context: { assignmentEpoch: bigint; id: string; routeVersion: number },
  routePlanId: string,
  notificationKinds: string[],
): DsvExecutionSyncResult {
  return {
    assignmentEpoch: context.assignmentEpoch.toString(),
    executionContextId: context.id,
    notificationKinds,
    outcome: 'ACCEPT',
    routePlanId,
    routeVersion: context.routeVersion,
  };
}

function mappingRequired(routePlanId: string): DsvExecutionSyncResult {
  return {
    assignmentEpoch: null,
    executionContextId: null,
    notificationKinds: [],
    outcome: 'MAPPING_REQUIRED',
    routePlanId,
    routeVersion: null,
  };
}

function skippedNonDsv(routePlanId: string): DsvExecutionSyncResult {
  return { ...mappingRequired(routePlanId), outcome: 'SKIPPED_NON_DSV' };
}

function unavailableSync(routePlanId: string): DsvExecutionSyncResult {
  return { ...mappingRequired(routePlanId), outcome: 'SKIPPED_UNAVAILABLE' };
}

function hasExecutionDelegates(tx: Tx): boolean {
  const value = tx as unknown as Record<string, unknown>;
  return value.dsvExecutionCommand !== undefined && value.dsvExecutionContext !== undefined;
}
