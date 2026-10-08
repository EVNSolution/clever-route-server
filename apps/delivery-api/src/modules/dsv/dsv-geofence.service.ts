import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  advanceDsvGeofence,
  dsvGeofenceTransitionEvidence,
  emptyDsvGeofenceState,
  haversineMeters,
  missingStartDueAt,
  nextMissingStartReminderAt,
  resolveDsvExecutionAttribution,
  type DsvGeofenceObservation,
  type DsvGeofenceTargetState,
} from './dsv-geofence-engine.js';
import { dsvBusinessDayBounds, dsvServiceDateAt, isDsvBusinessDay, isDsvMissingStartWindow } from './dsv-business-time.js';
import { parseDsvGeofencePolicy, type DsvGeofencePolicy } from './dsv-geofence-policy.js';

const ACTIVE_ROUTE_STATUSES = new Set(['READY', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS']);
const TERMINAL_STOP_STATUSES = new Set(['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED']);

export type DsvGeofenceProcessResult = {
  jobId: string;
  reason: string;
  status: 'DEFERRED' | 'IGNORED' | 'PROCESSED';
  executionContextId?: string;
};

type SnapshotPoint = { latitude: number; longitude: number };
type SnapshotStop = { id: string; latitude: number | null; longitude: number | null; orderId: string; sequence: number; status: string };
type Snapshot = { depot: SnapshotPoint | null; stops: SnapshotStop[] };

type GeofenceJob = {
  attemptCount: number;
  createdAt: Date;
  id: string;
  leaseToken: string | null;
  sampleId: string;
  shopId: string;
  vehicleId: string;
};

type TelemetrySample = {
  deviceId: string;
  id: string;
  latitude: unknown;
  longitude: unknown;
  observedAt: Date;
  plateMatched: boolean | null;
  receivedAt: Date;
  shopId: string;
  sourceKind: string;
  speedKph: unknown;
  staleAfter: Date;
  vehicleId: string;
  device: { shopId: string; vehicleId: string };
};

type ExecutionContext = {
  assignmentEpoch: bigint;
  closedAt: Date | null;
  contentSnapshot: unknown;
  departureObservedAt: Date | null;
  driverId: string | null;
  effectiveAt: Date;
  id: string;
  liveEligibleAt: Date | null;
  monitorEndAt: Date | null;
  monitorStartAt: Date | null;
  notificationMode: string;
  policy: unknown;
  recipientAccountId: string | null;
  reminderIncidentId: string | null;
  reminderOrdinal: number;
  reminderStatus: string;
  routePlanId: string;
  routeVersion: number;
  shopId: string;
  serviceDate: Date;
  startedAt: Date | null;
  status: string;
  vehicleId: string | null;
  warehouseNotifiedAt: Date | null;
};

type ServiceOptions = {
  clock?: () => Date;
  leaseMs?: number;
  policy?: DsvGeofencePolicy | null;
  technicalRetryDelayMs?: number;
  technicalRetryMaxAgeMs?: number;
  technicalRetryMaxAttempts?: number;
};

type TechnicalRetryPolicy = {
  delayMs: number;
  maxAgeMs: number;
  maxAttempts: number;
};

const DEFAULT_TECHNICAL_RETRY_POLICY: TechnicalRetryPolicy = {
  delayMs: 30_000,
  maxAgeMs: 10 * 60_000,
  maxAttempts: 5,
};

export class PrismaDsvGeofenceService {
  private readonly clock: (() => Date) | undefined;
  private readonly leaseMs: number;
  private readonly policy: DsvGeofencePolicy | null;
  private readonly technicalRetryPolicy: TechnicalRetryPolicy;

  constructor(private readonly prisma: PrismaClient, options: ServiceOptions = {}) {
    this.clock = options.clock;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.policy = options.policy ?? null;
    this.technicalRetryPolicy = {
      delayMs: boundedPositiveIntegerOrDefault(options.technicalRetryDelayMs, DEFAULT_TECHNICAL_RETRY_POLICY.delayMs, 300_000),
      maxAgeMs: boundedPositiveIntegerOrDefault(options.technicalRetryMaxAgeMs, DEFAULT_TECHNICAL_RETRY_POLICY.maxAgeMs, 86_400_000),
      maxAttempts: boundedPositiveIntegerOrDefault(options.technicalRetryMaxAttempts, DEFAULT_TECHNICAL_RETRY_POLICY.maxAttempts, 100),
    };
  }

  async runOnce(now = new Date()): Promise<DsvGeofenceProcessResult | null> {
    const job = await this.claimJob(undefined, now);
    return job === null ? null : this.processClaimed(job, now);
  }

  async process(jobId: string, now = new Date()): Promise<DsvGeofenceProcessResult> {
    const job = await this.claimJob(jobId, now);
    if (job === null) return { jobId, reason: 'NOT_CLAIMED', status: 'DEFERRED' };
    return this.processClaimed(job, now);
  }

  /** Publication can occur after the vehicle has already completed its arrival dwell. */
  async reconcileWarehouseArrivals(now = new Date()): Promise<number> {
    const candidates = await this.prisma.dsvExecutionContext.findMany({
      select: { id: true, shopId: true },
      where: {
        closedAt: null, effectiveAt: { lte: now }, notificationMode: 'LIVE',
        serviceDate: dsvServiceDateAt(now), startedAt: null, status: 'ACTIVE',
        warehouseNotifiedAt: null, vehicleId: { not: null },
      },
    });
    let count = 0;
    for (const candidate of candidates) {
      count += await this.prisma.$transaction(async (transaction) => {
        await lockExecutionContext(transaction, candidate.id);
        const context = await transaction.dsvExecutionContext.findFirst({
          where: { id: candidate.id, shopId: candidate.shopId },
        });
        if (context === null || context.startedAt !== null || context.warehouseNotifiedAt !== null
          || context.vehicleId === null || !await hasCurrentNotificationAuthority(transaction, context, now)) return 0;
        const policy = this.resolvePolicy(context.policy);
        const depot = parseSnapshot(context.contentSnapshot)?.depot;
        if (policy === null || policy.mode !== 'LIVE' || depot === null || depot === undefined) return 0;
        const currentCandidates = await transaction.dsvExecutionContext.findMany({
          where: { shopId: context.shopId, vehicleId: context.vehicleId, status: 'ACTIVE', closedAt: null,
            effectiveAt: { lte: now }, OR: [
              { serviceDate: context.serviceDate },
              { monitorStartAt: { lte: now }, monitorEndAt: { gt: now } },
            ] },
        });
        const eligible = await filterContextsWithMapping(transaction, currentCandidates, now);
        const selection = eligible.length <= 1 ? null : await transaction.dsvExecutionSelection.findFirst({
          where: { shopId: context.shopId, vehicleId: context.vehicleId,
            executionContextId: { in: eligible.map((item) => item.id) }, validFrom: { lte: now }, validUntil: { gt: now } },
        });
        if (resolveDsvExecutionAttribution(eligible, selection?.executionContextId ?? null)?.id !== context.id) return 0;
        // Only the first assignment can use dwell observed before publication. Reassignment needs fresh evidence.
        const historySeconds = policy.maxObservationDelaySeconds + policy.arrivalDwellSeconds
          + policy.maxGapSeconds * policy.arrivalMinSamples;
        const since = new Date(Math.max(now.getTime() - historySeconds * 1000,
          context.assignmentEpoch === 1n ? 0 : context.effectiveAt.getTime()));
        const samples = await transaction.uvisVehicleTelemetrySample.findMany({
          include: { device: { select: { shopId: true, vehicleId: true } } },
          orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
          where: { shopId: context.shopId, vehicleId: context.vehicleId, sourceKind: 'VEHICLE_GPS',
            observedAt: { gte: since, lte: now } },
        });
        let state = emptyDsvGeofenceState();
        let firstObservedAt: Date | null = null;
        let confirmedObservedAt: Date | null = null;
        let confirmationSampleId: string | null = null;
        let sourceSample: TelemetrySample | null = null;
        for (const sample of samples) {
          if (validateObservationIdentity(sample, { shopId: context.shopId, vehicleId: context.vehicleId }) !== null
            || validateObservationTiming(sample, policy, sample.receivedAt) !== null) {
            state = emptyDsvGeofenceState();
            sourceSample = null;
            continue;
          }
          if (state.lastObservationAt !== null
            && sample.observedAt.getTime() - Date.parse(state.lastObservationAt) > policy.maxGapSeconds * 1000) {
            state = emptyDsvGeofenceState();
          }
          const observation = toObservation(sample);
          const advanced = advanceDsvGeofence(state, observation, {
            ...depot, entryRadiusMeters: policy.warehouseRadiusMeters, exitRadiusMeters: policy.warehouseExitRadiusMeters,
          }, policy);
          if (advanced.transition === 'ARRIVED') {
            const evidence = dsvGeofenceTransitionEvidence(state, observation);
            firstObservedAt = evidence.firstObservedAt;
            confirmedObservedAt = evidence.confirmedObservedAt;
            confirmationSampleId = sample.id;
          }
          state = advanced.state;
          sourceSample = sample;
        }
        if (state.phase !== 'INSIDE' || sourceSample === null || sourceSample.staleAfter <= now
          || validateObservationTiming(sourceSample, policy, now) !== null
          || firstObservedAt === null || confirmedObservedAt === null || confirmationSampleId === null) return 0;
        const created = await createLiveNotification(transaction, context, policy, now, {
          evidenceObservedAt: sourceSample.observedAt, kind: 'N04', logicalKey: `N04:${context.id}`, ordinal: 1, targetStopId: null,
        });
        if (!created) return 0;
        const coordinateHash = geofenceCoordinateHash(depot, policy.warehouseRadiusMeters, policy.warehouseExitRadiusMeters);
        await transaction.dsvGeofenceState.upsert({
          create: { assignmentEpoch: context.assignmentEpoch, executionContextId: context.id, policyVersion: policy.policyVersion,
            shopId: context.shopId, state: { coordinateHash, geofence: state }, targetKey: 'DEPOT' },
          update: { policyVersion: policy.policyVersion, state: { coordinateHash, geofence: state } },
          where: { executionContextId_assignmentEpoch_targetKey: {
            executionContextId: context.id, assignmentEpoch: context.assignmentEpoch, targetKey: 'DEPOT',
          } },
        });
        await transaction.dsvGeofenceEvent.createMany({
          data: { assignmentEpoch: context.assignmentEpoch, confirmedAt: now, confirmedObservedAt,
            executionContextId: context.id, firstObservedAt,
            logicalKey: `${context.id}:${context.assignmentEpoch.toString()}:DEPOT:ARRIVED:${state.visitOrdinal}:${confirmationSampleId}`,
            policyVersion: policy.policyVersion, routeVersion: context.routeVersion, shopId: context.shopId,
            sourceSampleId: confirmationSampleId, targetKey: 'DEPOT', transition: 'ARRIVED', visitOrdinal: state.visitOrdinal },
          skipDuplicates: true,
        });
        await transaction.dsvExecutionContext.update({
          data: { warehouseNotifiedAt: sourceSample.observedAt }, where: { id: context.id },
        });
        return 1;
      });
    }
    return count;
  }

  async tickReminders(at?: Date): Promise<number> {
    const readNow = this.clock ?? (at === undefined ? () => new Date() : () => at);
    const contexts = await this.prisma.dsvExecutionContext.findMany({
      select: {
        assignmentEpoch: true,
        id: true,
        policy: true,
        reminderDueAt: true,
        shopId: true,
      },
      where: {
        reminderStatus: { in: ['REMINDER_ACTIVE', 'CAP_REACHED'] },
        startedAt: null,
        status: 'ACTIVE',
      },
    });
    let created = 0;
    for (const candidate of contexts) {
      const inserted = await this.prisma.$transaction(async (transaction) => {
        await lockExecutionContext(transaction, candidate.id);
        let now = readNow();
        const context = await transaction.dsvExecutionContext.findFirst({ where: { id: candidate.id, shopId: candidate.shopId } });
        if (context === null || !['REMINDER_ACTIVE', 'CAP_REACHED'].includes(context.reminderStatus)) return 0;
        if (now < dsvBusinessDayBounds(context.serviceDate).start) return 0;
        if (!isDsvMissingStartWindow(context.serviceDate, now)) {
          await expireMissingStart(transaction, context.id, now);
          return 0;
        }
        if (context.startedAt !== null || context.closedAt !== null || context.status !== 'ACTIVE') return 0;
        const resumingLegacyCap = context.reminderStatus === 'CAP_REACHED';
        if (!resumingLegacyCap && (context.reminderDueAt === null || context.reminderDueAt.getTime() > now.getTime())) return 0;
        const policy = this.resolvePolicy(context.policy);
        if (policy === null || policy.mode !== 'LIVE' || context.notificationMode !== 'LIVE') return 0;
        if (
          context.liveEligibleAt === null
          || context.liveEligibleAt.getTime() > now.getTime()
          || context.departureObservedAt === null
          || context.departureObservedAt.getTime() < context.liveEligibleAt.getTime()
        ) {
          await transaction.dsvExecutionContext.update({
            data: { reminderDueAt: null, reminderStatus: 'STALE_ACTIVATION' },
            where: { id: context.id },
          });
          return 0;
        }
        if (context.reminderIncidentId === null) {
          await transaction.dsvExecutionContext.update({
            data: { reminderDueAt: null, reminderStatus: 'INCIDENT_MISSING' },
            where: { id: context.id },
          });
          return 0;
        }
        if (!await hasCurrentNotificationAuthority(transaction, context, now)) {
          await transaction.dsvExecutionContext.update({
            data: { reminderDueAt: null, reminderStatus: 'AUTHORITY_ENDED' },
            where: { id: context.id },
          });
          return 0;
        }
        if (resumingLegacyCap) {
          const latest = await transaction.dsvOperationalNotification.findFirst({
            select: { createdAt: true }, orderBy: { createdAt: 'desc' },
            where: { executionContextId: context.id, assignmentEpoch: context.assignmentEpoch, kind: 'N05' },
          });
          const dueAt = missingStartDueAt(latest?.createdAt ?? context.departureObservedAt);
          await transaction.dsvExecutionContext.update({
            data: { reminderStatus: 'REMINDER_ACTIVE', reminderDueAt: dueAt }, where: { id: context.id },
          });
          if (dueAt > now) return 0;
        }
        const ordinal = context.reminderOrdinal + 1;
        now = readNow();
        if (!isDsvMissingStartWindow(context.serviceDate, now)) {
          await expireMissingStart(transaction, context.id, now);
          return 0;
        }
        const result = await transaction.dsvOperationalNotification.createMany({
          data: {
            assignmentEpoch: context.assignmentEpoch,
            audience: 'DRIVER',
            businessStatus: 'OPEN',
            createdAt: now,
            dueAt: now,
            executionContextId: context.id,
            expiresAt: operationalGeofenceNotificationExpiresAt(context, policy, now, 'N05'),
            kind: 'N05',
            logicalKey: `N05:${context.id}:${context.assignmentEpoch.toString()}:${context.reminderIncidentId}:${ordinal}`,
            ordinal,
            payload: { schemaVersion: 1 },
            recipientAccountId: context.recipientAccountId,
            routeVersion: context.routeVersion,
            shopId: context.shopId,
          },
          skipDuplicates: true,
        });
        await transaction.dsvExecutionContext.update({
          data: {
            reminderDueAt: nextMissingStartReminderAt(now),
            reminderOrdinal: ordinal,
          },
          where: { id: context.id },
        });
        return result.count;
      });
      created += inserted;
    }
    return created;
  }

  private async claimJob(jobId: string | undefined, now: Date): Promise<GeofenceJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.dsvGeofenceJob.findFirst({
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        where: {
          ...(jobId === undefined ? {} : { id: jobId }),
          nextAttemptAt: { lte: now },
          OR: [
            { status: 'PENDING' },
            { leaseExpiresAt: { lt: now }, status: 'PROCESSING' },
          ],
        },
      }) as GeofenceJob | null;
      if (candidate === null) return null;
      const leaseToken = randomUUID();
      const claimed = await transaction.dsvGeofenceJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          leaseToken,
          status: 'PROCESSING',
        },
        where: {
          id: candidate.id,
          OR: [
            { status: 'PENDING' },
            { leaseExpiresAt: { lt: now }, status: 'PROCESSING' },
          ],
        },
      });
      return claimed.count === 1 ? { ...candidate, attemptCount: candidate.attemptCount + 1, leaseToken } : null;
    });
  }

  private async processClaimed(job: GeofenceJob, now: Date): Promise<DsvGeofenceProcessResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const fenced = await transaction.dsvGeofenceJob.findFirst({
          where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
        });
        if (fenced === null) return { jobId: job.id, reason: 'LEASE_LOST', status: 'DEFERRED' };
        const sample = await transaction.uvisVehicleTelemetrySample.findUnique({
          include: { device: { select: { shopId: true, vehicleId: true } } },
          where: { id: job.sampleId },
        }) as TelemetrySample | null;
        if (sample === null) return finishIgnored(transaction, job, now, 'SAMPLE_NOT_FOUND');
        const identityReason = validateObservationIdentity(sample, job);
        if (identityReason !== null) return finishIgnored(transaction, job, now, identityReason);

        const contexts = await transaction.dsvExecutionContext.findMany({
          where: {
            closedAt: null,
            effectiveAt: { lte: sample.observedAt },
            OR: [
              { serviceDate: dsvServiceDateAt(sample.observedAt) },
              { monitorStartAt: { lte: sample.observedAt }, monitorEndAt: { gt: sample.observedAt } },
            ],
            shopId: sample.shopId,
            status: 'ACTIVE',
            vehicleId: sample.vehicleId,
          },
        }) as ExecutionContext[];
        const eligible = await filterContextsWithMapping(transaction, contexts, sample.observedAt);
        const context = await selectExecutionContext(transaction, eligible, sample);
        if (context === null) {
          const reason = eligible.length > 1 ? 'AMBIGUOUS_EXECUTION_CONTEXT' : 'NO_EXECUTION_CONTEXT';
          return this.finishDeferredOrIgnored(transaction, job, sample, now, reason, eligible);
        }
        await lockExecutionContext(transaction, context.id);
        const current = await transaction.dsvExecutionContext.findFirst({
          where: {
            assignmentEpoch: context.assignmentEpoch, id: context.id, shopId: sample.shopId,
            status: 'ACTIVE', closedAt: null, vehicleId: sample.vehicleId,
            effectiveAt: { lte: sample.observedAt },
            OR: [
              { serviceDate: dsvServiceDateAt(sample.observedAt) },
              { monitorStartAt: { lte: sample.observedAt }, monitorEndAt: { gt: sample.observedAt } },
            ],
          },
        }) as ExecutionContext | null;
        if (current === null) return this.finishDeferredOrIgnored(transaction, job, sample, now, 'CONTEXT_CHANGED', [context]);
        if (current.routePlanId !== context.routePlanId || current.routeVersion !== context.routeVersion) {
          return this.finishDeferredOrIgnored(transaction, job, sample, now, 'CONTENT_CHANGED', [context]);
        }
        const freshCandidates = await transaction.dsvExecutionContext.findMany({
          where: {
            shopId: sample.shopId, status: 'ACTIVE', closedAt: null, vehicleId: sample.vehicleId,
            effectiveAt: { lte: sample.observedAt },
            OR: [
              { serviceDate: dsvServiceDateAt(sample.observedAt) },
              { monitorStartAt: { lte: sample.observedAt }, monitorEndAt: { gt: sample.observedAt } },
            ],
          },
        }) as ExecutionContext[];
        const freshEligible = await filterContextsWithMapping(transaction, freshCandidates, sample.observedAt);
        const freshSelection = await selectExecutionContext(transaction, freshEligible, sample);
        if (freshSelection?.id !== current.id) {
          return this.finishDeferredOrIgnored(transaction, job, sample, now, 'ATTRIBUTION_CHANGED', freshEligible);
        }
        const effectivePolicy = this.resolvePolicy(current.policy);
        if (effectivePolicy === null) return finishIgnored(transaction, job, now, 'POLICY_NOT_CONFIGURED', current.id);
        const invalidReason = validateObservationTiming(sample, effectivePolicy, now);
        if (invalidReason !== null) return finishIgnored(transaction, job, now, invalidReason, current.id);
        if (sample.observedAt.getTime() > now.getTime()) {
          return this.finishDeferredOrIgnored(transaction, job, sample, now, 'OBSERVATION_NOT_YET_CURRENT', [current]);
        }
        const snapshot = parseSnapshot(current.contentSnapshot);
        if (snapshot === null) return finishIgnored(transaction, job, now, 'INVALID_CONTENT_SNAPSHOT', current.id);
        const observation = toObservation(sample);
        const locatedStops = snapshot.stops.filter(isLocatedStop);
        const stopMatches = locatedStops.filter((stop) =>
          !TERMINAL_STOP_STATUSES.has(stop.status)
          && haversineMeters(observation, stop) <= effectivePolicy.destinationRadiusMeters);

        if (snapshot.depot !== null && isDsvBusinessDay(current.serviceDate, sample.observedAt)
          && isDsvBusinessDay(current.serviceDate, now)) {
          await this.processTarget(transaction, current, observation, effectivePolicy, {
            key: 'DEPOT',
            point: snapshot.depot,
            entryRadiusMeters: effectivePolicy.warehouseRadiusMeters,
            exitRadiusMeters: effectivePolicy.warehouseExitRadiusMeters,
            stop: null,
          }, now);
        }
        if (stopMatches.length <= 1 && withinMonitorWindow(current, now) && withinMonitorWindow(current, sample.observedAt)) {
          for (const stop of locatedStops) {
            if (TERMINAL_STOP_STATUSES.has(stop.status)) continue;
            await this.processTarget(transaction, current, observation, effectivePolicy, {
              key: `STOP:${stop.id}`,
              point: stop,
              entryRadiusMeters: effectivePolicy.destinationRadiusMeters,
              exitRadiusMeters: effectivePolicy.destinationExitRadiusMeters,
              stop,
            }, now);
          }
        }
        const completed = await transaction.dsvGeofenceJob.updateMany({
          data: {
            leaseExpiresAt: null,
            leaseToken: null,
            processedAt: now,
            resultReason: stopMatches.length > 1 ? 'PROCESSED_STOP_OVERLAP_DEFERRED' : 'PROCESSED',
            status: 'COMPLETED',
          },
          where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
        });
        if (completed.count !== 1) throw new Error('DSV geofence lease was lost before commit');
        return {
          executionContextId: current.id,
          jobId: job.id,
          reason: stopMatches.length > 1 ? 'STOP_OVERLAP_DEFERRED' : 'PROCESSED',
          status: 'PROCESSED',
        };
      });
    } catch (error) {
      const retryExpired = technicalRetryTerminalReason(job, now, this.technicalRetryPolicy);
      await this.prisma.dsvGeofenceJob.updateMany({
        data: {
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: new Date(now.getTime() + this.technicalRetryPolicy.delayMs),
          processedAt: retryExpired === null ? null : now,
          resultReason: retryExpired ?? 'PROCESSING_ERROR',
          status: retryExpired === null ? 'PENDING' : 'COMPLETED',
        },
        where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
      });
      throw error;
    }
  }

  private async finishDeferredOrIgnored(
    transaction: Prisma.TransactionClient,
    job: GeofenceJob,
    sample: TelemetrySample,
    now: Date,
    reason: string,
    contexts: ExecutionContext[],
  ): Promise<DsvGeofenceProcessResult> {
    const terminalReason = deferredTerminalReason(job, sample, contexts, now, this.technicalRetryPolicy);
    if (terminalReason !== null) {
      return finishIgnored(transaction, job, now, `${terminalReason}:${reason}`);
    }
    return finishDeferred(transaction, job, now, reason, this.technicalRetryPolicy.delayMs);
  }

  private async processTarget(
    transaction: Prisma.TransactionClient,
    context: ExecutionContext,
    observation: DsvGeofenceObservation,
    policy: DsvGeofencePolicy,
    target: { entryRadiusMeters: number; exitRadiusMeters: number; key: string; point: SnapshotPoint; stop: SnapshotStop | null },
    now: Date,
  ): Promise<void> {
    const coordinateHash = geofenceCoordinateHash(target.point, target.entryRadiusMeters, target.exitRadiusMeters);
    const persisted = await transaction.dsvGeofenceState.findUnique({
      where: {
        executionContextId_assignmentEpoch_targetKey: {
          assignmentEpoch: context.assignmentEpoch,
          executionContextId: context.id,
          targetKey: target.key,
        },
      },
    });
    const stored = parseStoredState(persisted?.state);
    const previous = persisted?.policyVersion === policy.policyVersion && stored?.coordinateHash === coordinateHash
      ? stored.geofence
      : emptyDsvGeofenceState();
    const advanced = advanceDsvGeofence(previous, observation, {
      ...target.point,
      entryRadiusMeters: target.entryRadiusMeters,
      exitRadiusMeters: target.exitRadiusMeters,
    }, policy);
    await transaction.dsvGeofenceState.upsert({
      create: {
        assignmentEpoch: context.assignmentEpoch,
        executionContextId: context.id,
        policyVersion: policy.policyVersion,
        shopId: context.shopId,
        state: { coordinateHash, geofence: advanced.state },
        targetKey: target.key,
      },
      update: {
        policyVersion: policy.policyVersion,
        state: { coordinateHash, geofence: advanced.state },
      },
      where: {
        executionContextId_assignmentEpoch_targetKey: {
          assignmentEpoch: context.assignmentEpoch,
          executionContextId: context.id,
          targetKey: target.key,
        },
      },
    });
    if (advanced.transition === 'NONE') return;
    const evidence = dsvGeofenceTransitionEvidence(previous, observation);
    await transaction.dsvGeofenceEvent.createMany({
      data: {
        assignmentEpoch: context.assignmentEpoch,
        confirmedAt: now,
        confirmedObservedAt: evidence.confirmedObservedAt,
        executionContextId: context.id,
        firstObservedAt: evidence.firstObservedAt,
        logicalKey: [
          context.id,
          context.assignmentEpoch.toString(),
          target.key,
          advanced.transition,
          advanced.state.visitOrdinal.toString(),
          observation.sampleId,
        ].join(':'),
        policyVersion: policy.policyVersion,
        routeVersion: context.routeVersion,
        shopId: context.shopId,
        sourceSampleId: observation.sampleId,
        targetKey: target.key,
        transition: advanced.transition,
        visitOrdinal: advanced.state.visitOrdinal,
      },
      skipDuplicates: true,
    });

    if (target.key === 'DEPOT') {
      if (advanced.transition === 'ARRIVED') {
        if (context.startedAt === null && context.warehouseNotifiedAt === null) {
          const created = await createLiveNotification(transaction, context, policy, now, {
            evidenceObservedAt: observation.observedAt,
            kind: 'N04',
            logicalKey: `N04:${context.id}`,
            ordinal: 1,
            targetStopId: null,
          });
          if (created) {
            await transaction.dsvExecutionContext.update({ data: { warehouseNotifiedAt: observation.observedAt }, where: { id: context.id } });
            context.warehouseNotifiedAt = observation.observedAt;
          }
        }
        if (context.startedAt === null && context.departureObservedAt !== null) {
          await transaction.dsvExecutionContext.update({
            data: { reminderDueAt: null, reminderStatus: 'PAUSED_WAREHOUSE_RETURN' },
            where: { id: context.id },
          });
          await transaction.dsvOperationalNotification.updateMany({
            data: { businessStatus: 'RESOLVED', resolutionReason: 'WAREHOUSE_RETURN', resolvedAt: now },
            where: {
              businessStatus: 'OPEN',
              executionContextId: context.id,
              kind: 'N05',
            },
          });
        }
      } else if (context.startedAt === null && isDsvMissingStartWindow(context.serviceDate, now)) {
        await transaction.dsvExecutionContext.update({
          data: {
            departureObservedAt: observation.observedAt,
            reminderIncidentId: context.reminderIncidentId ?? randomUUID(),
            reminderDueAt: missingStartDueAt(observation.observedAt),
            reminderStatus: 'REMINDER_ACTIVE',
          },
          where: { id: context.id },
        });
      }
      return;
    }

    if (advanced.transition === 'ARRIVED' && target.stop !== null) {
      if (!await isCurrentNonTerminalStop(transaction, context, target.stop)) return;
      await createLiveNotification(transaction, context, policy, now, {
        evidenceObservedAt: observation.observedAt,
        kind: 'N06',
        logicalKey: `N06:${context.id}:${context.assignmentEpoch.toString()}:${target.stop.id}:${advanced.state.visitOrdinal}`,
        ordinal: advanced.state.visitOrdinal,
        targetStopId: target.stop.id,
      });
    }
  }

  private resolvePolicy(contextPolicy: unknown): DsvGeofencePolicy | null {
    if (contextPolicy !== null && contextPolicy !== undefined) return parseDsvGeofencePolicy(contextPolicy);
    return this.policy;
  }
}

async function createLiveNotification(
  transaction: Prisma.TransactionClient,
  context: ExecutionContext,
  policy: DsvGeofencePolicy,
  now: Date,
  input: { evidenceObservedAt: Date; kind: string; logicalKey: string; ordinal: number; targetStopId: string | null },
): Promise<boolean> {
  if (policy.mode !== 'LIVE' || context.notificationMode !== 'LIVE') return false;
  if (
    context.liveEligibleAt === null
    || context.liveEligibleAt.getTime() > now.getTime()
    || (input.kind !== 'N04' && input.evidenceObservedAt.getTime() < context.liveEligibleAt.getTime())
  ) return false;
  if (!await hasCurrentNotificationAuthority(transaction, context, now, input.kind)) return false;
  const inserted = await transaction.dsvOperationalNotification.createMany({
    data: {
      assignmentEpoch: context.assignmentEpoch,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      createdAt: now,
      dueAt: now,
      executionContextId: context.id,
      expiresAt: operationalGeofenceNotificationExpiresAt(context, policy, now, input.kind),
      kind: input.kind,
      logicalKey: input.logicalKey,
      ordinal: input.ordinal,
      payload: { schemaVersion: 1 },
      recipientAccountId: context.recipientAccountId,
      routeVersion: context.routeVersion,
      shopId: context.shopId,
      targetStopId: input.targetStopId,
    },
    skipDuplicates: true,
  });
  return inserted.count === 1;
}

function operationalGeofenceNotificationExpiresAt(
  context: ExecutionContext,
  policy: DsvGeofencePolicy,
  createdAt: Date,
  kind: string,
): Date {
  const policyExpiry = createdAt.getTime() + policy.notificationTtlSeconds * 1000;
  const { end, noon } = dsvBusinessDayBounds(context.serviceDate);
  const expiry = kind === 'N05'
    ? Math.min(createdAt.getTime() + 300_000, noon.getTime())
    : kind === 'N04' ? Math.min(createdAt.getTime() + 300_000, end.getTime())
      : Math.min(createdAt.getTime() + policy.reminderIntervalSeconds * 1000, context.monitorEndAt?.getTime() ?? end.getTime());
  return new Date(Math.min(policyExpiry, expiry));
}

async function hasCurrentNotificationAuthority(
  transaction: Prisma.TransactionClient,
  context: ExecutionContext,
  now: Date,
  kind = 'N04',
): Promise<boolean> {
  if (context.driverId === null || context.recipientAccountId === null || context.vehicleId === null) return false;
  if (context.status !== 'ACTIVE' || context.closedAt !== null) return false;
  if (kind === 'N06' ? !withinMonitorWindow(context, now) : !isDsvBusinessDay(context.serviceDate, now)) return false;
  const route = await transaction.routePlan.findFirst({
    select: { driverId: true, status: true, vehicleId: true },
    where: { id: context.routePlanId, shopId: context.shopId },
  });
  if (
    route === null
    || !ACTIVE_ROUTE_STATUSES.has(route.status)
    || route.driverId !== context.driverId
    || route.vehicleId !== context.vehicleId
  ) return false;
  const mapping = await transaction.dsvExecutionRouteMapping.findFirst({
    select: { id: true },
    where: {
      executionContextId: context.id,
      routePlanId: context.routePlanId,
      shopId: context.shopId,
      validFrom: { lte: now },
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
  });
  if (mapping === null) return false;
  const driver = await transaction.driver.findFirst({
    select: { accountId: true, status: true },
    where: { id: context.driverId, shopId: context.shopId },
  });
  if (driver?.status !== 'ACTIVE' || driver.accountId !== context.recipientAccountId) return false;
  const [account, vehicle] = await Promise.all([
    transaction.driverAccount.findFirst({
      select: { id: true },
      where: { id: context.recipientAccountId, status: 'ACTIVE' },
    }),
    transaction.vehicle.findFirst({
      select: { id: true },
      where: { id: context.vehicleId, shopId: context.shopId, status: 'ACTIVE' },
    }),
  ]);
  return account !== null && vehicle !== null;
}

async function filterContextsWithMapping(
  transaction: Prisma.TransactionClient,
  contexts: ExecutionContext[],
  observedAt: Date,
): Promise<ExecutionContext[]> {
  const eligible: ExecutionContext[] = [];
  for (const context of contexts) {
    const mapping = await transaction.dsvExecutionRouteMapping.findFirst({
      select: { id: true },
      where: {
        executionContextId: context.id,
        shopId: context.shopId,
        validFrom: { lte: observedAt },
        OR: [{ validUntil: null }, { validUntil: { gt: observedAt } }],
      },
    });
    if (mapping !== null) eligible.push(context);
  }
  return eligible;
}

async function isCurrentNonTerminalStop(
  transaction: Prisma.TransactionClient,
  context: ExecutionContext,
  stop: SnapshotStop,
): Promise<boolean> {
  const membership = await transaction.routePlanStop.findFirst({
    select: { deliveryStop: { select: { orderId: true, status: true } } },
    where: {
      deliveryStopId: stop.id,
      routePlanId: context.routePlanId,
      shopId: context.shopId,
    },
  });
  return membership !== null
    && membership.deliveryStop.orderId === stop.orderId
    && !TERMINAL_STOP_STATUSES.has(membership.deliveryStop.status);
}

async function selectExecutionContext(
  transaction: Prisma.TransactionClient,
  contexts: ExecutionContext[],
  sample: TelemetrySample,
): Promise<ExecutionContext | null> {
  if (contexts.length === 1) return contexts[0] ?? null;
  if (contexts.length === 0) return null;
  const selection = await transaction.dsvExecutionSelection.findFirst({
    where: {
      executionContextId: { in: contexts.map((context) => context.id) },
      shopId: sample.shopId,
      validFrom: { lte: sample.observedAt },
      validUntil: { gt: sample.observedAt },
      vehicleId: sample.vehicleId,
    },
  });
  return resolveDsvExecutionAttribution(contexts, selection?.executionContextId ?? null);
}

async function lockExecutionContext(transaction: Prisma.TransactionClient, executionContextId: string): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    SELECT 1
    FROM "dsv_execution_contexts"
    WHERE id = ${executionContextId}::uuid
    FOR UPDATE
  `);
}

function validateObservationIdentity(
  sample: TelemetrySample,
  job: Pick<GeofenceJob, 'shopId' | 'vehicleId'>,
): string | null {
  if (sample.sourceKind !== 'VEHICLE_GPS') return 'NOT_VEHICLE_GPS';
  if (
    sample.shopId !== job.shopId
    || sample.vehicleId !== job.vehicleId
    || sample.device.shopId !== sample.shopId
    || sample.device.vehicleId !== sample.vehicleId
  ) return 'DEVICE_SCOPE_MISMATCH';
  if (sample.plateMatched !== true) return 'PLATE_NOT_VERIFIED';
  const latitude = toFiniteNumber(sample.latitude);
  const longitude = toFiniteNumber(sample.longitude);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return 'INVALID_COORDINATES';
  if (latitude === 0 && longitude === 0) return 'ZERO_COORDINATES';
  return null;
}

function validateObservationTiming(
  sample: TelemetrySample,
  policy: DsvGeofencePolicy,
  now: Date,
): string | null {
  const speedKph = toFiniteNumber(sample.speedKph);
  if (speedKph !== null && (speedKph < 0 || speedKph > policy.maxSpeedKph)) return 'INVALID_SPEED';
  if (sample.receivedAt.getTime() - sample.observedAt.getTime() > policy.maxObservationDelaySeconds * 1000) return 'OBSERVATION_TOO_LATE';
  if (now.getTime() - sample.observedAt.getTime() > policy.maxObservationDelaySeconds * 1000) return 'OBSERVATION_STALE';
  if (sample.observedAt.getTime() - now.getTime() > policy.futureToleranceSeconds * 1000) return 'OBSERVATION_IN_FUTURE';
  return null;
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const depot = source.depot === null ? null : parsePoint(source.depot);
  if (depot === undefined) return null;
  if (!Array.isArray(source.stops)) return null;
  const stops: SnapshotStop[] = [];
  for (const valueStop of source.stops) {
    if (valueStop === null || typeof valueStop !== 'object' || Array.isArray(valueStop)) return null;
    const stop = valueStop as Record<string, unknown>;
    const latitude = stop.latitude === null ? null : toFiniteNumber(stop.latitude);
    const longitude = stop.longitude === null ? null : toFiniteNumber(stop.longitude);
    if (
      (latitude !== null && Math.abs(latitude) > 90)
      || (longitude !== null && Math.abs(longitude) > 180)
      || (latitude === null) !== (longitude === null)
      || typeof stop.id !== 'string'
      || typeof stop.orderId !== 'string'
      || typeof stop.sequence !== 'number'
      || typeof stop.status !== 'string'
    ) return null;
    stops.push({ id: stop.id, latitude, longitude, orderId: stop.orderId, sequence: stop.sequence, status: stop.status });
  }
  return { depot, stops };
}

function isLocatedStop(stop: SnapshotStop): stop is SnapshotStop & SnapshotPoint {
  return stop.latitude !== null && stop.longitude !== null;
}

function parsePoint(value: unknown): SnapshotPoint | null | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const point = value as Record<string, unknown>;
  const latitude = toFiniteNumber(point.latitude);
  const longitude = toFiniteNumber(point.longitude);
  if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function parseStoredState(value: unknown): { coordinateHash: string; geofence: DsvGeofenceTargetState } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.coordinateHash !== 'string' || source.geofence === null || typeof source.geofence !== 'object') return null;
  const geofence = source.geofence as DsvGeofenceTargetState;
  if (!['OUTSIDE', 'ENTERING', 'INSIDE', 'EXITING'].includes(geofence.phase)) return null;
  return { coordinateHash: source.coordinateHash, geofence };
}

function toObservation(sample: TelemetrySample): DsvGeofenceObservation {
  return {
    latitude: toFiniteNumber(sample.latitude) as number,
    longitude: toFiniteNumber(sample.longitude) as number,
    observedAt: sample.observedAt,
    sampleId: sample.id,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value !== null && typeof value === 'object' && 'toNumber' in value) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') {
      const parsed = (toNumber as () => unknown).call(value);
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

async function finishIgnored(
  transaction: Prisma.TransactionClient,
  job: GeofenceJob,
  now: Date,
  reason: string,
  executionContextId?: string,
): Promise<DsvGeofenceProcessResult> {
  await finishJob(transaction, job, now, reason, 'COMPLETED');
  return { ...(executionContextId === undefined ? {} : { executionContextId }), jobId: job.id, reason, status: 'IGNORED' };
}

async function finishDeferred(
  transaction: Prisma.TransactionClient,
  job: GeofenceJob,
  now: Date,
  reason: string,
  retryDelayMs: number,
): Promise<DsvGeofenceProcessResult> {
  const updated = await transaction.dsvGeofenceJob.updateMany({
    data: {
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs),
      processedAt: null,
      resultReason: reason,
      status: 'PENDING',
    },
    where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
  });
  if (updated.count !== 1) throw new Error('DSV geofence lease was lost before commit');
  return { jobId: job.id, reason, status: 'DEFERRED' };
}

function deferredTerminalReason(
  job: GeofenceJob,
  sample: TelemetrySample,
  contexts: ExecutionContext[],
  now: Date,
  policy: TechnicalRetryPolicy,
): string | null {
  if (sample.staleAfter.getTime() <= now.getTime()) return 'SAMPLE_EXPIRED';
  if (
    contexts.length > 0
    && contexts.every((context) => dsvBusinessDayBounds(context.serviceDate).end <= now
      && (context.monitorEndAt === null || context.monitorEndAt <= now))
  ) return 'BUSINESS_DAY_EXPIRED';
  return technicalRetryTerminalReason(job, now, policy);
}

function technicalRetryTerminalReason(
  job: GeofenceJob,
  now: Date,
  policy: TechnicalRetryPolicy,
): string | null {
  if (job.attemptCount >= policy.maxAttempts) return 'TECHNICAL_RETRY_EXHAUSTED';
  if (now.getTime() - job.createdAt.getTime() >= policy.maxAgeMs) return 'TECHNICAL_RETRY_EXPIRED';
  return null;
}

function boundedPositiveIntegerOrDefault(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= maximum ? value as number : fallback;
}

async function finishJob(
  transaction: Prisma.TransactionClient,
  job: GeofenceJob,
  now: Date,
  reason: string,
  status: string,
): Promise<void> {
  const updated = await transaction.dsvGeofenceJob.updateMany({
    data: { leaseExpiresAt: null, leaseToken: null, processedAt: now, resultReason: reason, status },
    where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
  });
  if (updated.count !== 1) throw new Error('DSV geofence lease was lost before commit');
}

function withinMonitorWindow(context: ExecutionContext, now: Date): boolean {
  return context.monitorStartAt !== null && context.monitorEndAt !== null
    && now >= context.monitorStartAt && now < context.monitorEndAt;
}

function geofenceCoordinateHash(point: SnapshotPoint, entryRadiusMeters: number, exitRadiusMeters: number): string {
  return createHash('sha256').update(`${point.latitude},${point.longitude},${entryRadiusMeters},${exitRadiusMeters}`).digest('hex');
}

async function expireMissingStart(transaction: Prisma.TransactionClient, executionContextId: string, now: Date): Promise<void> {
  await transaction.dsvExecutionContext.update({
    data: { reminderDueAt: null, reminderStatus: 'EXPIRED_NOON' }, where: { id: executionContextId },
  });
  await transaction.dsvOperationalNotification.updateMany({
    data: { businessStatus: 'EXPIRED', resolvedAt: now, resolutionReason: 'MISSING_START_NOON' },
    where: { executionContextId, kind: 'N05', businessStatus: 'OPEN' },
  });
}
