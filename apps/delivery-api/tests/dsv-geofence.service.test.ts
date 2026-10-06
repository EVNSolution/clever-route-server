import { describe, expect, it, vi } from 'vitest';

import { PrismaDsvGeofenceService } from '../src/modules/dsv/dsv-geofence.service.js';
import type { DsvGeofencePolicy } from '../src/modules/dsv/dsv-geofence-policy.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const sampleId = '22222222-2222-4222-8222-222222222222';
const shopId = '33333333-3333-4333-8333-333333333333';
const vehicleId = '44444444-4444-4444-8444-444444444444';
const livePolicy: DsvGeofencePolicy = {
  arrivalDwellSeconds: 60,
  arrivalMinSamples: 2,
  destinationExitRadiusMeters: 120,
  destinationRadiusMeters: 80,
  exitDwellSeconds: 120,
  exitMinSamples: 2,
  futureToleranceSeconds: 5,
  maxGapSeconds: 180,
  maxObservationDelaySeconds: 300,
  maxReminderCount: 5,
  maxSpeedKph: 140,
  mode: 'LIVE',
  notificationTtlSeconds: 3_600,
  policyVersion: 'synthetic-live-v1',
  reminderIntervalSeconds: 300,
  warehouseExitRadiusMeters: 140,
  warehouseRadiusMeters: 100,
};

describe('PrismaDsvGeofenceService retry bounds', () => {
  it('defers a publication race only while the technical retry budget remains', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const harness = createNoContextHarness({ now });
    const service = new PrismaDsvGeofenceService(harness.prisma as never, {
      technicalRetryDelayMs: 5_000,
      technicalRetryMaxAgeMs: 60_000,
      technicalRetryMaxAttempts: 2,
    });

    await expect(service.process(jobId, now)).resolves.toEqual({
      jobId,
      reason: 'NO_EXECUTION_CONTEXT',
      status: 'DEFERRED',
    });
    const lastUpdate = harness.job.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toMatchObject({
      nextAttemptAt: new Date(now.getTime() + 5_000),
      resultReason: 'NO_EXECUTION_CONTEXT',
      status: 'PENDING',
    });
  });

  it('ends an unattributed job when its technical attempt budget is exhausted', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const harness = createNoContextHarness({ now });
    const service = new PrismaDsvGeofenceService(harness.prisma as never, {
      technicalRetryMaxAttempts: 1,
    });

    await expect(service.process(jobId, now)).resolves.toEqual({
      jobId,
      reason: 'TECHNICAL_RETRY_EXHAUSTED:NO_EXECUTION_CONTEXT',
      status: 'IGNORED',
    });
    const lastUpdate = harness.job.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(lastUpdate.data).toMatchObject({
      processedAt: now,
      resultReason: 'TECHNICAL_RETRY_EXHAUSTED:NO_EXECUTION_CONTEXT',
      status: 'COMPLETED',
    });
  });

  it('ends an unattributed job when the source sample expires', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const harness = createNoContextHarness({ now, staleAfter: now });
    const service = new PrismaDsvGeofenceService(harness.prisma as never, {
      technicalRetryMaxAttempts: 10,
    });

    await expect(service.process(jobId, now)).resolves.toMatchObject({
      reason: 'SAMPLE_EXPIRED:NO_EXECUTION_CONTEXT',
      status: 'IGNORED',
    });
  });

  it('ends a changed-context retry after the execution monitor window closes', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const harness = createNoContextHarness({ now });
    const context = executionContext(new Date(now.getTime() - 500));
    harness.transaction.dsvExecutionContext.findMany.mockResolvedValue([context]);
    harness.transaction.dsvExecutionContext.findFirst.mockResolvedValue(null);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, {
      technicalRetryMaxAttempts: 10,
    });

    await expect(service.process(jobId, now)).resolves.toMatchObject({
      reason: 'MONITOR_WINDOW_EXPIRED:CONTEXT_CHANGED',
      status: 'IGNORED',
    });
  });

  it('ends a shadow departure timer instead of replaying it after LIVE activation', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T00:01:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T00:05:00.000Z'),
      reminderDueAt: new Date('2026-10-06T00:06:00.000Z'),
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(now)).resolves.toBe(0);
    const update = harness.executionContext.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({ reminderDueAt: null, reminderStatus: 'STALE_ACTIVATION' });
    expect(harness.notification.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['future', new Date('2026-10-06T00:11:00.000Z')],
  ])('does not generate a reminder with %s LIVE eligibility', async (_name, liveEligibleAt) => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T00:09:00.000Z'),
      liveEligibleAt,
      reminderDueAt: now,
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(now)).resolves.toBe(0);
    expect(harness.notification.createMany).not.toHaveBeenCalled();
  });

  it('creates one fresh LIVE reminder and expires it before the next five-minute interval', async () => {
    const now = new Date('2026-10-06T00:10:00.000Z');
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T00:05:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T00:04:00.000Z'),
      reminderDueAt: new Date('2026-10-06T00:10:00.000Z'),
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(now)).resolves.toBe(1);
    const created = harness.notification.createMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({
      expiresAt: new Date('2026-10-06T00:15:00.000Z'),
      kind: 'N05',
      ordinal: 1,
    });
    const update = harness.executionContext.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({
      reminderDueAt: new Date('2026-10-06T00:15:00.000Z'),
      reminderOrdinal: 1,
    });
  });

  it('T01/T02 creates no missing-start reminder before departure or before T+5 minutes', async () => {
    const beforeDeparture = reminderContext({
      departureObservedAt: null,
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: null,
    });
    const beforeDepartureHarness = createReminderHarness(beforeDeparture);
    const serviceBeforeDeparture = new PrismaDsvGeofenceService(beforeDepartureHarness.prisma as never, { policy: livePolicy });
    await expect(serviceBeforeDeparture.tickReminders(new Date('2026-10-06T07:30:00.000Z'))).resolves.toBe(0);

    const beforeDue = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:35:00.000Z'),
    });
    const beforeDueHarness = createReminderHarness(beforeDue);
    const serviceBeforeDue = new PrismaDsvGeofenceService(beforeDueHarness.prisma as never, { policy: livePolicy });
    await expect(serviceBeforeDue.tickReminders(new Date('2026-10-06T07:34:59.999Z'))).resolves.toBe(0);
    expect(beforeDueHarness.notification.createMany).not.toHaveBeenCalled();
  });

  it('T03/T04 creates the first reminder at T+5 and the second only 300 seconds later', async () => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:35:00.000Z'),
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(new Date('2026-10-06T07:35:00.000Z'))).resolves.toBe(1);
    await expect(service.tickReminders(new Date('2026-10-06T07:39:59.999Z'))).resolves.toBe(0);
    await expect(service.tickReminders(new Date('2026-10-06T07:40:00.000Z'))).resolves.toBe(1);
    expect(harness.notification.createMany).toHaveBeenCalledTimes(2);
    expect(context).toMatchObject({
      reminderDueAt: new Date('2026-10-06T07:45:00.000Z'),
      reminderOrdinal: 2,
    });
  });

  it.each([
    ['T05 start before the next due time', new Date('2026-10-06T07:42:00.000Z'), new Date('2026-10-06T07:45:00.000Z')],
    ['T06 start before departure', new Date('2026-10-06T07:25:00.000Z'), new Date('2026-10-06T07:35:00.000Z')],
  ])('%s creates no N05 intent', async (_name, startedAt, reminderDueAt) => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt,
      startedAt,
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(reminderDueAt)).resolves.toBe(0);
    expect(harness.notification.createMany).not.toHaveBeenCalled();
  });

  it('T07 applies an injected six-reminder cap without treating six as a default', async () => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:35:00.000Z'),
    });
    context.policy = { ...livePolicy, maxReminderCount: 6 };
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: context.policy });

    for (const time of ['07:35', '07:40', '07:45', '07:50', '07:55', '08:00']) {
      await expect(service.tickReminders(new Date(`2026-10-06T${time}:00.000Z`))).resolves.toBe(1);
    }
    await expect(service.tickReminders(new Date('2026-10-06T08:05:00.000Z'))).resolves.toBe(0);
    expect(harness.notification.createMany).toHaveBeenCalledTimes(6);
    expect(context).toMatchObject({ reminderDueAt: null, reminderOrdinal: 6, reminderStatus: 'CAP_REACHED' });
  });

  it.each([
    ['T08 late confirmation', '2026-10-06T07:37:00.000Z', '2026-10-06T07:42:00.000Z'],
    ['T09 worker recovery', '2026-10-06T07:51:00.000Z', '2026-10-06T07:56:00.000Z'],
  ])('%s creates at most one reminder and schedules from actual recovery', async (_name, recoveryAt, nextDueAt) => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:35:00.000Z'),
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(new Date(recoveryAt))).resolves.toBe(1);
    await expect(service.tickReminders(new Date(recoveryAt))).resolves.toBe(0);
    expect(harness.notification.createMany).toHaveBeenCalledOnce();
    expect(context.reminderDueAt).toEqual(new Date(nextDueAt));
  });

  it('T11 preserves the execution and reminder ordinal across midnight', async () => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T23:58:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T20:00:00.000Z'),
      reminderDueAt: new Date('2026-10-07T00:03:00.000Z'),
    });
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(new Date('2026-10-07T00:03:00.000Z'))).resolves.toBe(1);
    expect(context).toMatchObject({
      reminderDueAt: new Date('2026-10-07T00:08:00.000Z'),
      reminderOrdinal: 1,
      status: 'ACTIVE',
    });
  });

  it('ends reminder generation when the monitor window has closed', async () => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:35:00.000Z'),
    });
    context.monitorEndAt = new Date('2026-10-06T07:34:00.000Z');
    const harness = createReminderHarness(context);
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(new Date('2026-10-06T07:35:00.000Z'))).resolves.toBe(0);
    expect(context).toMatchObject({ reminderDueAt: null, reminderStatus: 'AUTHORITY_ENDED' });
  });

  it('T12 does not treat a READ acknowledgement as business resolution', async () => {
    const context = reminderContext({
      departureObservedAt: new Date('2026-10-06T07:30:00.000Z'),
      liveEligibleAt: new Date('2026-10-06T07:00:00.000Z'),
      reminderDueAt: new Date('2026-10-06T07:40:00.000Z'),
    });
    context.reminderOrdinal = 1;
    const harness = createReminderHarness(context);
    harness.acknowledgement.findFirst.mockResolvedValue({ ackKind: 'READ' });
    const service = new PrismaDsvGeofenceService(harness.prisma as never, { policy: livePolicy });

    await expect(service.tickReminders(new Date('2026-10-06T07:40:00.000Z'))).resolves.toBe(1);
    expect(context.reminderOrdinal).toBe(2);
    expect(harness.acknowledgement.findFirst).not.toHaveBeenCalled();
  });
});

function createNoContextHarness(input: { now: Date; staleAfter?: Date }) {
  const candidate = {
    attemptCount: 0,
    createdAt: new Date(input.now.getTime() - 1_000),
    id: jobId,
    leaseToken: null,
    sampleId,
    shopId,
    vehicleId,
  };
  const job = {
    findFirst: vi.fn(() => Promise.resolve(candidate)),
    updateMany: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve({ count: 1 });
    }),
  };
  const transaction = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    dsvExecutionContext: {
      findFirst: vi.fn((args?: unknown): Promise<unknown> => {
        void args;
        return Promise.resolve(null);
      }),
      findMany: vi.fn((args?: unknown): Promise<unknown[]> => {
        void args;
        return Promise.resolve([]);
      }),
    },
    dsvExecutionRouteMapping: { findFirst: vi.fn(() => Promise.resolve({ id: 'mapping-id' })) },
    dsvGeofenceJob: job,
    uvisVehicleTelemetrySample: {
      findUnique: vi.fn(() => Promise.resolve({
        device: { shopId, vehicleId },
        deviceId: '55555555-5555-4555-8555-555555555555',
        id: sampleId,
        latitude: '37.49',
        longitude: '127.01',
        observedAt: new Date(input.now.getTime() - 1_000),
        plateMatched: true,
        receivedAt: new Date(input.now.getTime() - 500),
        shopId,
        sourceKind: 'VEHICLE_GPS',
        speedKph: '10',
        staleAfter: input.staleAfter ?? new Date(input.now.getTime() + 60_000),
        vehicleId,
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    dsvGeofenceJob: job,
  };
  return { job, prisma, transaction };
}

function executionContext(monitorEndAt: Date) {
  return {
    assignmentEpoch: 1n,
    closedAt: null,
    contentSnapshot: { depot: null, stops: [] },
    departureObservedAt: null,
    driverId: null,
    effectiveAt: new Date('2026-10-06T00:00:00.000Z'),
    id: '66666666-6666-4666-8666-666666666666',
    liveEligibleAt: null,
    monitorEndAt,
    monitorStartAt: new Date('2026-10-06T00:00:00.000Z'),
    notificationMode: 'SHADOW',
    policy: null,
    recipientAccountId: null,
    reminderIncidentId: null,
    reminderOrdinal: 0,
    reminderStatus: 'AWAITING_DEPARTURE',
    routePlanId: '77777777-7777-4777-8777-777777777777',
    routeVersion: 1,
    shopId,
    startedAt: null,
    status: 'ACTIVE',
    vehicleId,
    warehouseNotifiedAt: null,
  };
}

function reminderContext(input: { departureObservedAt: Date | null; liveEligibleAt: Date | null; reminderDueAt: Date | null; startedAt?: Date }) {
  return {
    ...executionContext(new Date('2026-10-08T00:00:00.000Z')),
    departureObservedAt: input.departureObservedAt,
    driverId: '88888888-8888-4888-8888-888888888888',
    liveEligibleAt: input.liveEligibleAt,
    notificationMode: 'LIVE',
    policy: livePolicy,
    recipientAccountId: '99999999-9999-4999-8999-999999999999',
    reminderDueAt: input.reminderDueAt,
    reminderIncidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reminderStatus: 'REMINDER_ACTIVE',
    startedAt: input.startedAt ?? null,
  };
}

function createReminderHarness(context: ReturnType<typeof reminderContext>) {
  const executionContextDelegate = {
    findFirst: vi.fn((args?: unknown) => {
      void args;
      return Promise.resolve(context);
    }),
    findMany: vi.fn((args?: unknown) => {
      void args;
      return Promise.resolve([context]);
    }),
    update: vi.fn((args: unknown) => {
      const data = (args as { data: Partial<typeof context> }).data;
      Object.assign(context, data);
      return Promise.resolve(context);
    }),
  };
  const notification = {
    createMany: vi.fn((args: unknown) => {
      void args;
      return Promise.resolve({ count: 1 });
    }),
  };
  const acknowledgement = {
    findFirst: vi.fn((args?: unknown): Promise<unknown> => {
      void args;
      return Promise.resolve(null);
    }),
  };
  const transaction = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    driver: { findFirst: vi.fn(() => Promise.resolve({ accountId: context.recipientAccountId, status: 'ACTIVE' })) },
    driverAccount: { findFirst: vi.fn(() => Promise.resolve({ id: context.recipientAccountId })) },
    dsvExecutionContext: executionContextDelegate,
    dsvExecutionRouteMapping: { findFirst: vi.fn(() => Promise.resolve({ id: 'mapping-id' })) },
    dsvOperationalNotificationAcknowledgement: acknowledgement,
    dsvOperationalNotification: notification,
    routePlan: { findFirst: vi.fn(() => Promise.resolve({ driverId: context.driverId, status: 'READY', vehicleId })) },
    vehicle: { findFirst: vi.fn(() => Promise.resolve({ id: vehicleId })) },
  };
  const prisma = {
    $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    dsvExecutionContext: executionContextDelegate,
  };
  return { acknowledgement, executionContext: executionContextDelegate, notification, prisma };
}
