/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';
import { PrismaDsvExecutionContextService } from '../src/modules/dsv/dsv-execution-context.service.js';

import {
  createDsvIsolatedHttpHarness,
  type DsvIsolatedFixture,
  type DsvIsolatedHttpHarness,
} from './support/dsv-isolated-http-harness.js';

const optedIn = process.env.CLEVER_RUN_DISPOSABLE_DB_TESTS === '1';
const serverSuite = optedIn ? describe.sequential : describe.skip;

serverSuite('DSV isolated real PostgreSQL HTTP integration', () => {
  let harness: DsvIsolatedHttpHarness;
  let fixture: DsvIsolatedFixture;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createDsvIsolatedHttpHarness();
    fixture = await harness.createFixture();
    const address = await harness.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address;
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  test('resolves N06 to the exact delivery stop without a GET side effect', async () => {
    const headers = driverHeaders(fixture);
    const before = await harness.prisma.dsvOperationalNotificationAck.count({
      where: { notificationId: fixture.n06NotificationId },
    });
    const response = await requestJson(baseUrl, `/api/dsv/driver/operational-notifications/${fixture.n06NotificationId}/resolve`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.destination).toEqual({
      executionContextId: fixture.contextId,
      routePlanId: fixture.routePlanId,
      targetStopId: fixture.stopId,
      type: 'EXECUTION',
    });
    await expect(harness.prisma.dsvOperationalNotificationAck.count({
      where: { notificationId: fixture.n06NotificationId },
    })).resolves.toBe(before);
  });

  test('reports one N07, supports response-loss replay, and keeps route, order, and stop business state separate', async () => {
    const commandId = randomUUID();
    const payload = reportPayload(fixture, commandId);
    const [first, concurrent] = await Promise.all([
      requestJson(baseUrl, `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`, {
        body: payload, headers: driverHeaders(fixture), method: 'POST',
      }),
      requestJson(baseUrl, `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`, {
        body: payload, headers: driverHeaders(fixture), method: 'POST',
      }),
    ]);
    expect([first.status, concurrent.status].sort()).toEqual([200, 201]);
    expect(first.body.data.commandId).toBe(commandId);
    expect(concurrent.body.data.commandId).toBe(commandId);
    expect(first.body.data.exceptionId).toBe(concurrent.body.data.exceptionId);

    const reportId = String(first.body.data.exceptionId);
    const notificationId = String(first.body.data.notificationId);
    await expect(harness.prisma.dsvExecutionCommand.count({
      where: { commandId, commandName: 'REPORT_DELIVERY_EXCEPTION', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(harness.prisma.dsvDeliveryException.count({ where: { id: reportId } })).resolves.toBe(1);
    await expect(harness.prisma.dsvOperationalNotification.count({
      where: { audience: 'OPS', eventId: reportId, id: notificationId, kind: 'N07' },
    })).resolves.toBe(1);

    const list = await requestJson(baseUrl, '/api/dsv/v1/operations/delivery-exceptions?limit=30', {
      headers: adminHeaders(fixture, false),
    });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: reportId, status: 'OPEN' })]));
    const opened = await requestJson(baseUrl, `/api/dsv/v1/operations/delivery-exceptions/${reportId}`, {
      headers: adminHeaders(fixture, false),
    });
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({ id: reportId, targetStopId: fixture.stopId });

    const noCsrf = await requestJson(baseUrl, `/api/dsv/v1/operations/delivery-exceptions/${reportId}/acknowledge`, {
      body: {}, headers: { cookie: fixture.admin.cookie }, method: 'POST',
    });
    expect(noCsrf.status).toBe(403);
    await expect(harness.prisma.dsvDeliveryException.findUniqueOrThrow({ where: { id: reportId } }))
      .resolves.toMatchObject({ status: 'OPEN' });
    const acknowledged = await requestJson(baseUrl, `/api/dsv/v1/operations/delivery-exceptions/${reportId}/acknowledge`, {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.data.status).toBe('ACKNOWLEDGED');
    const resolved = await requestJson(baseUrl, `/api/dsv/v1/operations/delivery-exceptions/${reportId}/resolve`, {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe('RESOLVED');

    const [route, order, stop, notification] = await Promise.all([
      harness.prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }),
      harness.prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      harness.prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }),
      harness.prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: notificationId } }),
    ]);
    expect(route.status).toBe('READY');
    expect(order.currentRouteVersionId).toBe(fixture.childVersionId);
    expect(stop.status).toBe('PENDING');
    expect(notification).toMatchObject({ businessStatus: 'RESOLVED', resolutionReason: 'OPERATIONS_RESOLVED' });
  });

  test('projects the synthetic dispatch into the actual mobile route and drives notifications through GPS workers', async () => {
    const credentialResponse = await requestJson(baseUrl, '/api/dsv/__fixture/credentials/driver', {
      headers: adminHeaders(fixture),
    });
    const login = await requestJson(baseUrl, '/api/dsv/driver/auth/login', {
      body: credentialResponse.body.data,
      method: 'POST',
    });
    expect(login.status).toBe(200);
    const accessToken = String(login.body.data.accessToken);
    const lookup = await requestJson(baseUrl, '/driver/route-access/lookup', {
      headers: { authorization: `Bearer ${accessToken}` },
      body: { routeContext: null },
      method: 'POST',
    });
    expect(lookup.status).toBe(200);
    const routeChoice = lookup.body.data.routes.find((route: any) => route.routeAccess.routePlanId === fixture.routePlanId);
    expect(routeChoice).toBeDefined();
    const assigned = await requestJson(baseUrl, `/driver/assigned-route?routeContext=${fixture.routePlanId}`, {
      headers: { authorization: `Bearer ${String(routeChoice.driverAccess.accessToken)}` },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toMatchObject({
      route: {
        deliveryDate: fixture.serviceDate,
        id: fixture.routePlanId,
        routeVersionId: fixture.childVersionId,
        stops: expect.arrayContaining([expect.objectContaining({
          deliveryStopId: fixture.stopId,
          destinationId: expect.stringMatching(/^DEST-PRIMARY-/u),
          shippedBoxes: 3,
        })]),
      },
      status: 'ASSIGNED_ROUTE',
    });
    expect(fixture.nextStopId).not.toBe(fixture.stopId);

    const warehouse = await requestJson(baseUrl, '/api/dsv/__fixture/actions/geofence/warehouse-cycle', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(warehouse.status, JSON.stringify(warehouse.body)).toBe(200);
    expect(warehouse.body.data).toMatchObject({ atDue: 1, beforeDue: 0 });
    expect(warehouse.body.data.notificationKinds).toEqual(expect.arrayContaining(['N04', 'N05']));
    const destination = await requestJson(baseUrl, '/api/dsv/__fixture/actions/geofence/destination-arrival', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(destination.status).toBe(200);
    expect(destination.body.data.targetStopId).toBe(fixture.stopId);
    expect(destination.body.data.targetStopId).not.toBe(fixture.nextStopId);
    const repeated = await requestJson(baseUrl, '/api/dsv/__fixture/actions/geofence/reminder-repeat', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(repeated.body.data).toMatchObject({ atDue: 1, beforeDue: 0, reminderOrdinal: 2 });
    const started = await requestJson(baseUrl, '/api/dsv/__fixture/actions/geofence/start-stop', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(started.body.data).toMatchObject({ afterStart: 0, reminderStatus: 'RESOLVED_START' });
    const changed = await requestJson(baseUrl, '/api/dsv/__fixture/actions/publication/change', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(changed.body.data.notificationKinds).toContain('N02');
    const state = await requestJson(baseUrl, '/api/dsv/__fixture/state');
    expect(state.body.geofenceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetKey: 'DEPOT', transition: 'ARRIVED' }),
      expect.objectContaining({ targetKey: 'DEPOT', transition: 'DEPARTED' }),
      expect.objectContaining({ targetKey: `STOP:${fixture.stopId}`, transition: 'ARRIVED' }),
    ]));
    expect(state.body.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/api/dsv/driver/auth/login', status: 200 }),
      expect.objectContaining({ method: 'POST', path: '/driver/route-access/lookup', status: 200 }),
      expect.objectContaining({ method: 'GET', path: '/driver/assigned-route', status: 200 }),
    ]));
  });

  test('serializes the Android flow lock and rejects resets while it is active', async () => {
    const begin = await requestJson(baseUrl, '/api/dsv/__fixture/actions/begin', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(begin.body.data.locked).toBe(true);
    const resets = await Promise.all([
      requestJson(baseUrl, '/api/dsv/__fixture/reset', { body: {}, method: 'POST' }),
      requestJson(baseUrl, '/api/dsv/__fixture/reset', { body: {}, method: 'POST' }),
    ]);
    expect(resets.map(({ status }) => status)).toEqual([409, 409]);
    const end = await requestJson(baseUrl, '/api/dsv/__fixture/actions/end', {
      body: {}, headers: adminHeaders(fixture), method: 'POST',
    });
    expect(end.body.data.locked).toBe(false);
  });

  test('rejects authentication loss, reassignment, foreign tenant identifiers, and missing CSRF', async () => {
    const before = await Promise.all([
      harness.prisma.dsvDeliveryException.count({ where: { shopId: fixture.shopId } }),
      harness.prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } }),
    ]);
    const missing = await requestJson(baseUrl, `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`, {
      body: reportPayload(fixture, randomUUID()), method: 'POST',
    });
    expect(missing.status).toBe(401);

    const foreign = await requestJson(baseUrl, `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`, {
      body: reportPayload(fixture, randomUUID()), headers: { authorization: `Bearer ${fixture.foreign.driverToken}` }, method: 'POST',
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('CONTEXT_NOT_FOUND');

    await harness.prisma.routePlan.update({
      data: { driverId: null },
      where: { id: fixture.routePlanId },
    });
    const reassigned = await requestJson(baseUrl, `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`, {
      body: reportPayload(fixture, randomUUID()), headers: driverHeaders(fixture), method: 'POST',
    });
    expect(reassigned.status).toBe(409);
    expect(reassigned.body.error.code).toBe('ASSIGNMENT_CHANGED');

    const credentialResponse = await requestJson(baseUrl, '/api/dsv/__fixture/credentials/driver', {
      headers: adminHeaders(fixture),
    });
    expect(credentialResponse.status).toBe(200);
    const credentials = credentialResponse.body.data as { loginId: string; password: string };
    await harness.prisma.driverAccount.update({
      data: { tokenVersion: { increment: 1 } },
      where: { id: fixture.accountId },
    });
    const staleToken = await requestJson(baseUrl, '/api/dsv/driver/executions', { headers: driverHeaders(fixture) });
    expect(staleToken.status).toBe(401);
    const login = await requestJson(baseUrl, '/api/dsv/driver/auth/login', {
      body: credentials,
      method: 'POST',
    });
    expect(login.status).toBe(200);
    expect(login.body.data.account.id).toBe(fixture.accountId);
    const recovered = await requestJson(baseUrl, '/api/dsv/driver/executions', {
      headers: { authorization: `Bearer ${String(login.body.data.accessToken)}` },
    });
    expect(recovered.status).toBe(200);

    await harness.prisma.dsvAdminAccount.update({
      data: { scopes: ['dsv:session:read'] },
      where: { id: fixture.admin.accountId },
    });
    const scopeLost = await requestJson(baseUrl, '/api/dsv/v1/operations/delivery-exceptions?limit=30', {
      headers: adminHeaders(fixture, false),
    });
    expect(scopeLost.status).toBe(403);
    await harness.prisma.dsvAdminAccount.update({
      data: { activeSessionId: null },
      where: { id: fixture.admin.accountId },
    });
    const sessionRevoked = await requestJson(baseUrl, '/api/dsv/v1/operations/delivery-exceptions?limit=30', {
      headers: adminHeaders(fixture, false),
    });
    expect(sessionRevoked.status).toBe(403);
    expect(sessionRevoked.body.error.code).toBe('UNAUTHORIZED');
    await expect(Promise.all([
      harness.prisma.dsvDeliveryException.count({ where: { shopId: fixture.shopId } }),
      harness.prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } }),
    ])).resolves.toEqual(before);
  });
});

const driverSource = process.env.DSV_DRIVER_SOURCE?.trim();
const clientSuite = optedIn && driverSource ? describe.sequential : describe.skip;

clientSuite('DSV Driver client queue against isolated HTTP server', () => {
  let harness: DsvIsolatedHttpHarness;
  let fixture: DsvIsolatedFixture;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createDsvIsolatedHttpHarness();
    fixture = await harness.createFixture();
    baseUrl = await harness.app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  test('imports the actual Driver queue and replays an unknown response with one server-side report', async () => {
    process.env.EXPO_PUBLIC_DSV_API_BASE_URL = baseUrl;
    const queueModuleUrl = pathToFileURL(`${driverSource!}/src/domain/delivery/driverCommandQueue.ts`).href;
    const apiModuleUrl = pathToFileURL(`${driverSource!}/src/api/dsvDriverOperational.ts`).href;
    const routeModuleUrl = pathToFileURL(`${driverSource!}/src/api/dsvDriverRoute.ts`).href;
    const driverModule = await import(/* @vite-ignore */ queueModuleUrl) as {
      DriverCommandQueue: new (options: Record<string, unknown>) => {
        enqueueDeliveryException(context: Record<string, unknown>, details: Record<string, unknown>): Promise<{ status: string }>;
        initialize(): Promise<void>;
        retryPending(): Promise<void>;
      };
    };
    const driverApi = await import(/* @vite-ignore */ apiModuleUrl) as {
      loadDriverExecutionContexts(token: string): Promise<Record<string, unknown>[]>;
      loadDriverOperationalInbox(token: string): Promise<{ items: Array<{ id: string; kind: string }> }>;
      reportDriverDeliveryException(
        token: string, contextId: string, input: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
      resolveDriverOperationalNotification(
        token: string, notificationId: string,
      ): Promise<{ destination: { targetStopId?: string }; notificationId: string }>;
    };
    const driverRouteApi = await import(/* @vite-ignore */ routeModuleUrl) as {
      loadDriverDeliveryRoute(token: string, routePlanId: string): Promise<{
        orders: Array<{ conditionCode: string; id: string; sellerOrderKey: string; shippedBoxes: number }>;
      }>;
    };
    const deliveryRoute = await driverRouteApi.loadDriverDeliveryRoute(fixture.driverToken, fixture.routePlanId);
    expect(deliveryRoute.orders).toHaveLength(2);
    expect(deliveryRoute.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ conditionCode: 'STANDARD', id: fixture.stopId, shippedBoxes: 3 }),
      expect.objectContaining({ conditionCode: 'STANDARD', id: fixture.nextStopId, shippedBoxes: 1 }),
    ]));
    expect(deliveryRoute.orders.every(({ sellerOrderKey }) => sellerOrderKey.length > 0)).toBe(true);
    const inbox = await driverApi.loadDriverOperationalInbox(fixture.driverToken);
    expect(inbox.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.n06NotificationId, kind: 'N06' }),
    ]));
    const destination = await driverApi.resolveDriverOperationalNotification(
      fixture.driverToken,
      fixture.n06NotificationId,
    );
    expect(destination.destination.targetStopId).toBe(fixture.stopId);

    let stored: unknown[] = [];
    let loseFirstResponse = true;
    let clientError: unknown = null;
    const createQueue = () => new driverModule.DriverCommandQueue({
      createCommandId: () => randomUUID(),
      getSession: () => ({ accountId: fixture.accountId, generation: 1 }),
      loadContexts: () => driverApi.loadDriverExecutionContexts(fixture.driverToken),
      now: () => '2026-10-06T02:00:00.000Z',
      send: async (command: { executionContextId: string; payload: Record<string, unknown> }) => {
        let result: Record<string, unknown>;
        try {
          result = await driverApi.reportDriverDeliveryException(
            fixture.driverToken,
            command.executionContextId,
            command.payload,
          );
        } catch (error) {
          clientError = error;
          throw error;
        }
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw Object.assign(new Error('synthetic response loss'), { code: 'NETWORK_RETRY', status: 0 });
        }
        return result;
      },
      store: {
        load: async () => structuredClone(stored),
        save: async (commands: unknown[]) => { stored = structuredClone(commands); },
      },
    });
    const queue = createQueue();
    await queue.initialize();
    const pending = await queue.enqueueDeliveryException(driverContext(fixture), {
      explanation: 'isolated actual Driver queue', reasonCode: 'UNDELIVERABLE', targetStopId: fixture.stopId,
    });
    expect(pending.status).toBe('pending');
    const durablePayload = structuredClone((stored[0] as { payload: unknown }).payload);
    const restartedQueue = createQueue();
    await restartedQueue.initialize();
    await restartedQueue.retryPending();
    expect(clientError).toBeNull();
    expect(stored[0]).toMatchObject({ lastError: null, status: 'confirmed' });
    expect((stored[0] as { payload: unknown }).payload).toEqual(durablePayload);
    await expect(harness.prisma.dsvDeliveryException.count({ where: { shopId: fixture.shopId } })).resolves.toBe(1);
    await expect(harness.prisma.dsvExecutionCommand.count({
      where: { commandName: 'REPORT_DELIVERY_EXCEPTION', shopId: fixture.shopId },
    })).resolves.toBe(1);
  });

  test('keeps the actual mobile route visible after a same-shop reassignment links the new account', async () => {
    process.env.EXPO_PUBLIC_DSV_API_BASE_URL = baseUrl;
    const unique = randomUUID();
    const name = `Synthetic reassigned ${unique.slice(0, 8)}`;
    const phone = `010${unique.replaceAll('-', '').replace(/\D/gu, '').padEnd(8, '0').slice(0, 8)}`;
    const credentials = { loginId: `isolated.reassigned.${unique.slice(0, 8)}`, password: `Isolated-${unique}-Pass!` };
    const driver = await harness.prisma.driver.create({
      data: {
        displayName: name,
        dsvProfile: { create: { lookupName: name } },
        phone,
        shopId: fixture.shopId,
        status: 'ACTIVE',
      },
    });
    const session = await new PrismaDsvDriverAuthRepository(harness.prisma).register({ ...credentials, name, phone });
    await expect(harness.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).resolves.toMatchObject({
      accountId: session.accountId,
      authSubject: `driver-${driver.id}`,
    });
    const sync = await harness.prisma.$transaction(async (transaction) => {
      await transaction.routePlan.update({ data: { driverId: driver.id }, where: { id: fixture.routePlanId } });
      await transaction.routeGroupingChildVersion.update({ data: { driverId: driver.id }, where: { id: fixture.childVersionId } });
      return new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId: randomUUID(),
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
      });
    });
    expect(sync.notificationKinds).toEqual(expect.arrayContaining(['N01', 'N03']));

    const login = await requestJson(baseUrl, '/api/dsv/driver/auth/login', { body: credentials, method: 'POST' });
    expect(login.status).toBe(200);
    const routeModuleUrl = pathToFileURL(`${driverSource!}/src/api/dsvDriverRoute.ts`).href;
    const routeApi = await import(/* @vite-ignore */ routeModuleUrl) as {
      loadDriverDeliveryRoute(token: string, routePlanId: string): Promise<{ orders: Array<{ id: string }> }>;
    };
    const route = await routeApi.loadDriverDeliveryRoute(String(login.body.data.accessToken), fixture.routePlanId);
    expect(route.orders.map(({ id }) => id)).toEqual(expect.arrayContaining([fixture.nextStopId, fixture.stopId]));
  });
});

function driverContext(fixture: DsvIsolatedFixture) {
  return {
    assignmentEpoch: '1',
    assignmentGeneration: '1',
    executionContextId: fixture.contextId,
    expectedRouteVersionId: fixture.childVersionId,
    routeVersion: 1,
    startedAt: null,
    status: 'ACTIVE',
  };
}

function reportPayload(fixture: DsvIsolatedFixture, commandId: string) {
  return {
    assignmentEpoch: '1',
    assignmentGeneration: '1',
    commandId,
    expectedRouteVersionId: fixture.childVersionId,
    explanation: 'isolated HTTP integration',
    occurredAt: '2026-10-06T02:00:00.000Z',
    reasonCode: 'UNDELIVERABLE',
    routeVersion: 1,
    targetStopId: fixture.stopId,
  };
}

function driverHeaders(fixture: DsvIsolatedFixture): Record<string, string> {
  return { authorization: `Bearer ${fixture.driverToken}` };
}

function adminHeaders(fixture: DsvIsolatedFixture, csrf = true): Record<string, string> {
  return { cookie: fixture.admin.cookie, ...(csrf ? { 'x-csrf-token': fixture.admin.csrfToken } : {}) };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<{ body: any; status: number }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { body: await response.json(), status: response.status };
}
