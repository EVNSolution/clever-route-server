import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverEventAdmissionUnavailableError,
  DriverEventAssignmentChangedError,
  DriverEventRouteVersionMismatchError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import {
  PrismaDriverEventReceiptRepository
} from '../src/modules/driver/driver-event-receipt.repository.js';
import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const now = new Date('2026-08-24T05:00:00.000Z');
const secret = 'contract-v2-secret';

describe('ordered driver event contract v2', () => {
  test('rejects an unsupported v3 event contract instead of silently applying v2 semantics', async () => {
    const recordDriverEvent = vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' }));
    const app = await buildApp({ driverApi: routeDependencies(recordDriverEvent) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...versionedPayload(), driverContractVersion: 3 },
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ data: null, error: { code: 'BAD_REQUEST', message: 'Invalid driver event payload' } });
      expect(recordDriverEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('passes exact decimal-string generation and version fields to the service', async () => {
    const recordDriverEvent = vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' }));
    const app = await buildApp({ driverApi: routeDependencies(recordDriverEvent) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: versionedPayload(),
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(202);
      const admitted = (recordDriverEvent.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown> | undefined;
      expect(admitted).toMatchObject({
        appVersion: '1.2.0',
        assignmentGeneration: '7',
        driverContractVersion: 2,
        expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
        versionCode: 120
      });
      expect(typeof admitted?.requestId).toBe('string');
    } finally {
      await app.close();
    }
  });

  test('does not create admission evidence for an unauthenticated v2 request', async () => {
    const admitDriverEventAttempt = vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 }));
    const dependencies = routeDependencies(vi.fn(), { admitDriverEventAttempt });
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({ method: 'POST', payload: versionedPayload(), url: '/driver/events' });
      expect(response.statusCode).toBe(401);
      expect(admitDriverEventAttempt).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('durably admits and rejects incomplete authenticated v2 events before business handling', async () => {
    const recordDriverEvent = vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' }));
    const admitDriverEventAttempt = vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 }));
    const finalizeDriverEventAttempt = vi.fn(() => Promise.resolve());
    const dependencies = routeDependencies(recordDriverEvent, { admitDriverEventAttempt, finalizeDriverEventAttempt });
    const app = await buildApp({ driverApi: dependencies });
    try {
      const payload = versionedPayload();
      delete payload.assignmentGeneration;
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload,
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(400);
      expect(recordDriverEvent).not.toHaveBeenCalled();
      expect(admitDriverEventAttempt).toHaveBeenCalled();
      expect(finalizeDriverEventAttempt).toHaveBeenCalledWith('attempt-id', {
        errorCode: 'BAD_REQUEST', failureStage: 'WIRE_VALIDATION', retryable: false, status: 'REJECTED'
      });
    } finally {
      await app.close();
    }
  });

  test('preserves sanitized admission evidence for a malformed expected route version', async () => {
    const recordDriverEvent = vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' }));
    const admitDriverEventAttempt = vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 }));
    const dependencies = routeDependencies(recordDriverEvent, { admitDriverEventAttempt });
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...versionedPayload(), expectedRouteVersionId: 'not-a-uuid' },
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(400);
      expect(recordDriverEvent).not.toHaveBeenCalled();
      expect(admitDriverEventAttempt).toHaveBeenCalledWith(expect.objectContaining({
        expectedRouteVersionId: null,
        routePlanId: 'route-plan-id'
      }));
    } finally {
      await app.close();
    }
  });

  test('rejects hostile client event identifiers without persisting or logging their contents', async () => {
    const admitDriverEventAttempt = vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 }));
    const logLines: string[] = [];
    const app = await buildApp({
      driverApi: routeDependencies(vi.fn(), { admitDriverEventAttempt }),
      logger: { level: 'info', stream: { write: (line: string) => logLines.push(line) } }
    });
    const hostileId = 'private@example.invalid token=secret +1-519-555-0100';
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...versionedPayload(), clientEventId: hostileId },
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(400);
      expect(admitDriverEventAttempt).toHaveBeenCalledWith(expect.objectContaining({ clientEventId: null }));
      expect(logLines.join('\n')).not.toContain(hostileId);
      expect(logLines.join('\n')).not.toContain('private@example.invalid');
    } finally {
      await app.close();
    }
  });

  test.each([
    [new DriverEventRouteVersionMismatchError(), 409, 'ROUTE_VERSION_MISMATCH'],
    [new DriverEventAssignmentChangedError(), 409, 'ROUTE_ASSIGNMENT_CHANGED'],
    [new DriverEventAdmissionUnavailableError(), 503, 'DRIVER_EVENT_ADMISSION_UNAVAILABLE']
  ])('maps stable contract failures without exposing payload data', async (error, status, code) => {
    const recordDriverEvent = vi.fn(() => Promise.reject(error));
    const app = await buildApp({ driverApi: routeDependencies(recordDriverEvent) });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: versionedPayload(),
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ data: null, error: { code } });
      expect(response.body).not.toContain('appVersion');
    } finally {
      await app.close();
    }
  });

  test('persists attempt evidence before business transaction and applies it after commit', async () => {
    const operations: string[] = [];
    const attemptCreate = vi.fn(() => { operations.push('attempt:create'); return Promise.resolve({ id: 'attempt-id' }); });
    const attemptUpdate = vi.fn(() => { operations.push('attempt:update'); return Promise.resolve({ id: 'attempt-id' }); });
    const prisma = repositoryHarness({ attemptCreate, attemptUpdate, operations });
    const repository = new PrismaDriverEventRepository(prisma as never, { now: () => now });

    await expect(repository.recordDriverEvent(repositoryInput())).resolves.toEqual({
      duplicate: false,
      eventId: 'event-id'
    });
    expect(operations).toEqual(expect.arrayContaining(['attempt:create', 'business:transaction', 'attempt:update']));
    expect(operations.indexOf('attempt:create')).toBeLessThan(operations.indexOf('business:transaction'));
    const applied = (attemptUpdate.mock.calls as unknown[][])[0]?.[0] as { data?: Record<string, unknown> } | undefined;
    expect(applied?.data).toMatchObject({ committedEventId: 'event-id', status: 'APPLIED' });
  });

  test('records a non-retryable version rejection outside the rolled-back transaction', async () => {
    const attemptUpdate = vi.fn(() => Promise.resolve({ id: 'attempt-id' }));
    const prisma = repositoryHarness({
      attemptCreate: vi.fn(() => Promise.resolve({ id: 'attempt-id' })),
      attemptUpdate,
      currentRouteVersionId: 'different-version-id',
      operations: []
    });
    const repository = new PrismaDriverEventRepository(prisma as never, { now: () => now });

    await expect(repository.recordDriverEvent(repositoryInput())).rejects.toBeInstanceOf(DriverEventRouteVersionMismatchError);
    const rejected = (attemptUpdate.mock.calls as unknown[][])[0]?.[0] as { data?: Record<string, unknown> } | undefined;
    expect(rejected?.data).toMatchObject({
      errorCode: 'ROUTE_VERSION_MISMATCH',
      retryable: false,
      status: 'REJECTED'
    });
  });

  test('fails closed before the business transaction when attempt admission cannot persist', async () => {
    const prisma = repositoryHarness({
      attemptCreate: vi.fn(() => Promise.reject(new Error('database unavailable'))),
      attemptUpdate: vi.fn(),
      operations: []
    }) as { $transaction: ReturnType<typeof vi.fn> };
    const repository = new PrismaDriverEventRepository(prisma as never, { now: () => now });
    await expect(repository.recordDriverEvent(repositoryInput())).rejects.toBeInstanceOf(DriverEventAdmissionUnavailableError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('emits a flat redacted contract log suitable for stdout-to-CloudWatch', async () => {
    const logLines: string[] = [];
    const app = await buildApp({
      driverApi: routeDependencies(vi.fn(() => Promise.reject(new DriverEventAssignmentChangedError()))),
      logger: { level: 'info', stream: { write: (line: string) => logLines.push(line) } }
    });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` },
        method: 'POST',
        payload: { ...versionedPayload(), address: 'never-log', note: 'never-log', proof: 'never-log' },
        url: '/driver/events'
      });
      expect(response.statusCode).toBe(409);
      const record = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === 'driver_event_contract_failure');
      expect(record).toMatchObject({
        code: 'ROUTE_ASSIGNMENT_CHANGED',
        event: 'driver_event_contract_failure',
        retryable: false,
        routePlanId: 'route-plan-id',
        shopId: 'shop-id'
      });
      expect(JSON.stringify(record)).not.toMatch(/never-log|address|note|proof/iu);
      const contractLogs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => typeof line.event === 'string' && line.event.startsWith('driver_event_contract_'));
      expect(JSON.stringify(contractLogs)).not.toMatch(/never-log|"address"|"note"|"proof"/iu);
    } finally {
      await app.close();
    }
  });

  test('emits accepted and applied lifecycle metrics with failure-stage dimensions', async () => {
    const logLines: string[] = [];
    const app = await buildApp({
      driverApi: routeDependencies(vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' }))),
      logger: { level: 'info', stream: { write: (line: string) => logLines.push(line) } }
    });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${routeToken()}` }, method: 'POST', payload: versionedPayload(), url: '/driver/events'
      });
      expect(response.statusCode).toBe(202);
      const metrics = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === 'driver_event_contract_metric');
      expect(metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ failureStage: 'ADMISSION', outcome: 'accepted' }),
        expect.objectContaining({ failureStage: 'COMMITTED', outcome: 'applied' })
      ]));
    } finally {
      await app.close();
    }
  });
});

describe('driver completion receipt precedence', () => {
  test('returns APPLIED from the committed event even when the admission row is still ACCEPTED', async () => {
    const repository = new PrismaDriverEventReceiptRepository({
      driverEvent: { findFirst: vi.fn(() => Promise.resolve({
        assignmentGeneration: 7n,
        clientEventId: 'complete-1',
        expectedRouteVersionId: 'version-id',
        routePlan: { status: 'COMPLETED' },
        routePlanId: 'route-id'
      })) },
      driverEventAttempt: { findFirst: vi.fn() },
      routePlan: { findFirst: vi.fn() }
    } as never);
    await expect(repository.lookup({ accountId: 'account-id', clientEventId: 'complete-1', routePlanId: 'route-id' }))
      .resolves.toEqual({
        assignmentGeneration: '7',
        clientEventId: 'complete-1',
        errorCode: null,
        expectedRouteVersionId: 'version-id',
        routePlanId: 'route-id',
        routeStatus: 'COMPLETED',
        status: 'APPLIED'
      });
  });

  test('exposes receipt lookup only through an active account token', async () => {
    const lookup = vi.fn(() => Promise.resolve({
      assignmentGeneration: '7', clientEventId: 'complete-1', errorCode: null,
      expectedRouteVersionId: 'version-id', routePlanId: 'route-plan-id', routeStatus: 'COMPLETED', status: 'APPLIED' as const
    }));
    const dependencies = routeDependencies(vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'event-id' })));
    dependencies.driverEventReceiptService = { lookup };
    const app = await buildApp({ driverApi: dependencies });
    const accountToken = signDriverAccountToken({
      accountId: 'account-id', expiresInSeconds: 60, subject: 'driver-account:account-id'
    }, { now, secret }).token;
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${accountToken}` },
        method: 'GET',
        url: '/driver/event-receipts/route-plan-id/complete-1'
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({ data: { status: 'APPLIED' }, error: null });
      expect(lookup).toHaveBeenCalledWith({ accountId: 'account-id', clientEventId: 'complete-1', routePlanId: 'route-plan-id' });
    } finally {
      await app.close();
    }
  });
});

function routeDependencies(
  recordDriverEvent: ReturnType<typeof vi.fn>,
  attempts: {
    admitDriverEventAttempt?: ReturnType<typeof vi.fn>;
    finalizeDriverEventAttempt?: ReturnType<typeof vi.fn>;
  } = {}
): DriverApiDependencies {
  return {
    driverEventService: {
      admitDriverEventAttempt: (attempts.admitDriverEventAttempt ?? vi.fn(() => Promise.resolve({ attemptId: 'attempt-id', attemptNumber: 1 }))) as NonNullable<DriverApiDependencies['driverEventService']['admitDriverEventAttempt']>,
      finalizeDriverEventAttempt: (attempts.finalizeDriverEventAttempt ?? vi.fn(() => Promise.resolve())) as NonNullable<DriverApiDependencies['driverEventService']['finalizeDriverEventAttempt']>,
      recordDriverEvent: recordDriverEvent as DriverApiDependencies['driverEventService']['recordDriverEvent']
    },
    driverTokenAccessRepository: {
      isDriverAccessTokenActive: vi.fn(() => Promise.resolve(false)),
      isDriverAccountAccessTokenActive: vi.fn(() => Promise.resolve(true)),
      resolveDriverRouteAccess: vi.fn(() => Promise.resolve({
        accountId: 'account-id', driverId: 'driver-id', routePlanId: 'route-plan-id', shopDomain: 'k-food.myshopify.com', shopId: 'shop-id'
      }))
    },
    jwtSecret: secret,
    now: () => now
  };
}

function routeToken(): string {
  return signDriverRouteToken({
    accountId: 'account-id', expiresInSeconds: 60, routePlanId: 'route-plan-id', subject: 'driver-account:account-id'
  }, { now, secret }).token;
}

function versionedPayload(): Record<string, unknown> {
  return {
    appVersion: '1.2.0', assignmentGeneration: '7', clientEventId: 'complete-1', deliveryStopId: null,
    driverContractVersion: 2, eventType: 'ROUTE_COMPLETED', expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
    occurredAt: '2026-08-24T04:59:00.000Z', routePlanId: 'route-plan-id', versionCode: 120
  };
}

function repositoryInput() {
  return {
    appVersion: '1.2.0', assignmentGeneration: '7', clientEventId: 'complete-1', deliveryStopId: null,
    driverContractVersion: 2, driverId: 'driver-id', eventType: 'ROUTE_COMPLETED',
    expectedRouteVersionId: '22222222-2222-4222-8222-222222222222', latitude: null, longitude: null,
    occurredAt: new Date('2026-08-24T04:59:00.000Z'), payload: versionedPayload(), requestId: 'request-id',
    routePlanId: 'route-plan-id', shopDomain: 'k-food.myshopify.com', shopId: 'shop-id', versionCode: 120
  };
}

function repositoryHarness(input: {
  attemptCreate: ReturnType<typeof vi.fn>;
  attemptUpdate: ReturnType<typeof vi.fn>;
  currentRouteVersionId?: string;
  operations: string[];
}) {
  const currentVersion = input.currentRouteVersionId ?? '22222222-2222-4222-8222-222222222222';
  const prisma: object = {};
  Object.assign(prisma, {
    $queryRaw: vi.fn((query: { strings?: string[] }) => {
      const sql = query.strings?.join('') ?? '';
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve(sql.includes("table_name = 'driver_events'") ? [{ column_name: 'routeVersionId' }] : []);
      }
      if (sql.includes('FROM "route_plans"')) return Promise.resolve([{ assignmentGeneration: 7n, driverId: 'driver-id' }]);
      if (sql.includes('FROM route_grouping_child_versions')) return Promise.resolve([{ id: currentVersion }]);
      return Promise.resolve([]);
    }),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      input.operations.push('business:transaction');
      return callback(prisma);
    }),
    deliveryStop: { updateMany: vi.fn() },
    driverEvent: {
      create: vi.fn(() => Promise.resolve({ createdAt: now, id: 'event-id' })),
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(() => Promise.resolve(null))
    },
    driverEventAttempt: {
      create: vi.fn(async (args: unknown) => ({
        ...(await (input.attemptCreate as (value: unknown) => Promise<Record<string, unknown>>)(args)),
        attemptNumber: 1
      })),
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(() => Promise.resolve(null)),
      update: input.attemptUpdate
    },
    dsvDispatchChangeRequest: {},
    order: {},
    routePlan: {
      findFirst: vi.fn(() => Promise.resolve({ id: 'route-plan-id', status: 'IN_PROGRESS' })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    },
    routePlanGeometryCache: {},
    routePlanStop: { findFirst: vi.fn(), findMany: vi.fn(() => Promise.resolve([])) },
    routeTrackingGeometry: {}
  });
  return prisma;
}
