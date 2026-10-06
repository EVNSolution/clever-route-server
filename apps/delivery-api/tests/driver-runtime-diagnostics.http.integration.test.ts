import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import {
  PrismaDriverRuntimeDiagnosticsRepository,
} from '../src/modules/driver/driver-runtime-diagnostics.repository.js';
import {
  signDriverAccountToken,
  signDriverRouteToken,
} from '../src/modules/driver/driver-token-verifier.js';
import { registerJsonBodyParser } from '../src/routes/json-body-parser.js';
import {
  registerDriverRuntimeDiagnosticsRoutes,
  type DriverRuntimeDiagnosticsService,
} from '../src/routes/driver-runtime-diagnostics.routes.js';

const databaseUrl = process.env.DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_URL;
const targetClass = process.env.DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_TARGET_CLASS;
const enabled = databaseUrl !== undefined || targetClass !== undefined;

if (enabled) {
  if (targetClass !== 'safe-local-disposable' || databaseUrl === undefined) {
    throw new Error('Driver runtime diagnostic HTTP integration requires its exact safe-local-disposable URL and target class');
  }
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    url.protocol !== 'postgresql:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
    || ['5433', '55444', '55455'].includes(url.port)
    || !['clever_diagnostics', 'clever_diagnostics_http', 'clever_g002', 'clever_g002_disposable'].includes(databaseName)
  ) {
    throw new Error('Driver runtime diagnostic HTTP integration requires an approved disposable loopback database');
  }
}

const describeDatabase = enabled ? describe : describe.skip;
const jwtSecret = 'driver-runtime-http-integration-secret';
const fixtureAccounts = new Set<string>();
const fixtureShops = new Set<string>();
const disabledDatabaseUrl = 'postgresql://disabled@127.0.0.1:1/disabled';

type Scope = Awaited<ReturnType<typeof seedScope>>;

function diagnosticSnapshot(at: Date, blockers: Array<Record<string, unknown>> = []) {
  const observedAt = at.toISOString();
  return {
    snapshotObservedAt: observedAt,
    lifecycle: 'FOREGROUND',
    network: 'ONLINE',
    locationPermission: 'GRANTED_ALWAYS',
    locationService: 'ENABLED',
    locationTask: 'STARTED',
    locationTaskExpected: true,
    stateObservedAt: {
      lifecycle: observedAt,
      network: observedAt,
      locationPermission: observedAt,
      locationService: observedAt,
      locationTask: observedAt,
    },
    businessQueue: {
      queueDepth: 0,
      oldestQueuedAt: null,
      oldestAgeMs: null,
      retryCount: 0,
      nextRetryAt: null,
      observedAt,
    },
    lastGpsCallbackAt: observedAt,
    lastGpsCollectedAt: observedAt,
    lastGpsPersistedAt: observedAt,
    lastGpsSendAttemptAt: observedAt,
    lastGpsSendAcknowledgedAt: observedAt,
    ...(blockers.length === 0 ? {} : { blockers }),
  };
}

function diagnosticEnvelope(input: {
  at: Date;
  deviceInstanceHash: string;
  routePlanId: string | null;
  recordRoutePlanId?: string | null;
  diagnosticId?: string;
  identifiers?: { clientEventId?: string; requestId?: string };
  blockers?: Array<Record<string, unknown>>;
  bootId?: string;
  recordAt?: Date;
}) {
  const diagnosticId = input.diagnosticId ?? randomUUID();
  const batchId = randomUUID();
  const bootId = input.bootId ?? randomUUID();
  const snapshot = diagnosticSnapshot(input.at, input.blockers);
  const context = {
    appVersion: '1.0.0-http-integration',
    versionCode: 1,
    os: 'ANDROID',
    osVersion: '15',
    deviceInstanceHash: input.deviceInstanceHash,
    routePlanId: input.routePlanId,
    sessionGeneration: '1',
    assignmentGeneration: '1',
  };
  return {
    schemaVersion: 1,
    batchId,
    bootId,
    sentAt: input.at.toISOString(),
    discardedRecordCount: 0,
    liveContext: context,
    liveSnapshot: snapshot,
    records: [{
      diagnosticId,
      bootId,
      sequence: 1,
      observedAt: (input.recordAt ?? input.at).toISOString(),
      kind: 'HEARTBEAT',
      context: {
        ...context,
        routePlanId: input.recordRoutePlanId === undefined ? input.routePlanId : input.recordRoutePlanId,
      },
      snapshot,
      ...(input.identifiers === undefined ? {} : { identifiers: input.identifiers }),
    }],
  };
}

async function seedScope(prisma: PrismaClient, label: string) {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: { appId: 'clever', shopDomain: `diagnostics-${label}-${suffix}.invalid` },
  });
  fixtureShops.add(shop.id);
  const account = await prisma.driverAccount.create({
    data: { phone: `diagnostics-${label}-${suffix}`, tokenVersion: 3 },
  });
  fixtureAccounts.add(account.id);
  const driver = await prisma.driver.create({
    data: { accountId: account.id, displayName: `Synthetic diagnostics ${label}`, shopId: shop.id },
  });
  const route = await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId: driver.id,
      metrics: {},
      name: `Synthetic diagnostics ${label}`,
      optimizerVersion: 'http-integration',
      planDate: new Date('2026-10-02T00:00:00.000Z'),
      shopId: shop.id,
      status: 'IN_PROGRESS',
    },
  });
  return { account, driver, route, shop };
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  if (fixtureShops.size > 0) {
    await prisma.shop.deleteMany({ where: { id: { in: [...fixtureShops] } } });
    fixtureShops.clear();
  }
  if (fixtureAccounts.size > 0) {
    await prisma.driverAccount.deleteMany({ where: { id: { in: [...fixtureAccounts] } } });
    fixtureAccounts.clear();
  }
}

async function startServer(prisma: PrismaClient, initialNow = new Date()) {
  let currentNow = initialNow;
  let rejectNextIngest = false;
  const repository = new PrismaDriverRuntimeDiagnosticsRepository(prisma, {
    now: () => new Date(currentNow),
  });
  const service: DriverRuntimeDiagnosticsService = {
    register: repository.register.bind(repository),
    authenticate: repository.authenticate.bind(repository),
    recordContact: repository.recordContact.bind(repository),
    recordFailure: repository.recordFailure.bind(repository),
    revoke: repository.revoke.bind(repository),
    listForShop: repository.listForShop.bind(repository),
    ingest: async (credential, envelope) => {
      if (rejectNextIngest) {
        rejectNextIngest = false;
        throw new Error('synthetic storage outage after authenticated contact');
      }
      return repository.ingest(credential, envelope);
    },
  };
  const app = Fastify({ logger: false });
  registerJsonBodyParser(app);
  await registerDriverRuntimeDiagnosticsRoutes(app, {
    jwtSecret,
    now: () => new Date(currentNow),
    service,
    sessionTokenVerifier: {
      verify(token: string) {
        const shopDomain = /^admin:(.+)$/u.exec(token)?.[1];
        if (shopDomain === undefined) throw new Error('invalid admin fixture token');
        return { appId: 'clever', shopDomain, subject: 'http-integration-admin' };
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Fastify did not bind a TCP integration-test address');
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    failNextIngest() { rejectNextIngest = true; },
    repository,
    setNow(value: Date) { currentNow = value; },
  };
}

function accountToken(scope: Scope): string {
  return signDriverAccountToken({
    accountId: scope.account.id,
    tokenVersion: scope.account.tokenVersion,
    subject: `driver-account:${scope.account.id}`,
    expiresInSeconds: 900,
  }, { secret: jwtSecret }).token;
}

async function registerDevice(baseUrl: string, scope: Scope, deviceInstanceHash: string) {
  const response = await fetch(`${baseUrl}/driver/sync-health/registrations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accountToken(scope)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, deviceInstanceHash }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ expiresAt: string; token: string }>;
}

async function postDiagnostics(baseUrl: string, token: string, payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/driver/sync-health/diagnostics`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describeDatabase('driver runtime diagnostics real HTTP and PostgreSQL boundary', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? disabledDatabaseUrl });

  afterEach(async () => {
    await cleanup(prisma);
  });

  test('registration stores only the token hash and rejects wrong bearer scopes', async () => {
    const scope = await seedScope(prisma, 'registration');
    const server = await startServer(prisma);
    const deviceInstanceHash = 'a'.repeat(64);
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const stored = await prisma.driverRuntimeDiagnosticCredential.findFirstOrThrow({
        where: { device: { accountId: scope.account.id, deviceInstanceHash } },
      });
      expect(stored.tokenHash).not.toBe(credential.token);
      expect(JSON.stringify(stored)).not.toContain(credential.token);

      const routeToken = signDriverRouteToken({
        accountId: scope.account.id,
        routePlanId: scope.route.id,
        tokenVersion: scope.account.tokenVersion,
        subject: `driver-account:${scope.account.id}`,
        expiresInSeconds: 900,
      }, { secret: jwtSecret }).token;
      for (const token of [routeToken, credential.token]) {
        const response = await fetch(`${server.baseUrl}/driver/sync-health/registrations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, deviceInstanceHash: 'b'.repeat(64) }),
        });
        expect(response.status).toBe(401);
      }
      const unauthorized = await postDiagnostics(server.baseUrl, 'not-a-diagnostic-token', diagnosticEnvelope({
        at: new Date(), deviceInstanceHash, routePlanId: scope.route.id,
      }));
      expect(unauthorized.status).toBe(401);
    } finally {
      await server.app.close();
    }
  });

  test('a cached diagnostic credential authenticates after the HTTP server restarts', async () => {
    const scope = await seedScope(prisma, 'cached-credential');
    const now = new Date();
    const firstServer = await startServer(prisma, now);
    const deviceInstanceHash = '9'.repeat(64);
    const credential = await registerDevice(firstServer.baseUrl, scope, deviceInstanceHash);
    await firstServer.app.close();

    const restartedServer = await startServer(prisma, now);
    try {
      const diagnosticId = randomUUID();
      const response = await postDiagnostics(restartedServer.baseUrl, credential.token, diagnosticEnvelope({
        at: now,
        deviceInstanceHash,
        diagnosticId,
        routePlanId: scope.route.id,
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ acceptedDiagnosticIds: [diagnosticId] });
    } finally {
      await restartedServer.app.close();
    }
  });

  test('authenticated malformed JSON durably records contact and failure metadata', async () => {
    const scope = await seedScope(prisma, 'malformed');
    const now = new Date();
    const server = await startServer(prisma, now);
    const deviceInstanceHash = 'c'.repeat(64);
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const response = await fetch(`${server.baseUrl}/driver/sync-health/diagnostics`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
        body: '{"incomplete":',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'INVALID_JSON' } });
      const device = await prisma.driverRuntimeDiagnosticDevice.findFirstOrThrow({
        where: { accountId: scope.account.id, deviceInstanceHash },
      });
      expect(device.lastContactAt?.toISOString()).toBe(now.toISOString());
      expect(device.lastFailureAt?.toISOString()).toBe(now.toISOString());
      expect(device.lastFailureCode).toBe('INVALID_JSON');
      const adminResponse = await fetch(`${server.baseUrl}/admin/drivers/runtime-diagnostics`, {
        headers: { authorization: `Bearer admin:${scope.shop.shopDomain}` },
      });
      expect(adminResponse.status).toBe(200);
      expect((await adminResponse.json() as { data: { devices: unknown[] } }).data.devices).toEqual([]);
    } finally {
      await server.app.close();
    }
  });

  test('retry after a discarded successful response acknowledges the record without persisting it twice', async () => {
    const scope = await seedScope(prisma, 'duplicate');
    const now = new Date();
    const server = await startServer(prisma, now);
    const deviceInstanceHash = 'd'.repeat(64);
    const diagnosticId = randomUUID();
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const payload = diagnosticEnvelope({ at: now, deviceInstanceHash, diagnosticId, routePlanId: scope.route.id });
      const discardedResponse = await postDiagnostics(server.baseUrl, credential.token, payload);
      expect(discardedResponse.status).toBe(200);

      const retry = await postDiagnostics(server.baseUrl, credential.token, payload);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ acceptedDiagnosticIds: [diagnosticId], rejectedDiagnostics: [] });
      expect(await prisma.driverRuntimeDiagnosticRecord.count({ where: { diagnosticId } })).toBe(1);
    } finally {
      await server.app.close();
    }
  });

  test('admin status joins matching APPLIED and FAILED server attempts while preserving tenant isolation', async () => {
    const scope = await seedScope(prisma, 'attempts');
    const otherScope = await seedScope(prisma, 'other-tenant');
    const now = new Date();
    const server = await startServer(prisma, now);
    const cases = [
      { hash: 'e'.repeat(64), status: 'APPLIED', state: 'SERVER_APPLIED_CLIENT_ACK_UNKNOWN' },
      { hash: 'f'.repeat(64), status: 'FAILED', state: 'SERVER_RECEIVED_NOT_APPLIED' },
    ] as const;
    try {
      for (const item of cases) {
        const clientEventId = randomUUID();
        const requestId = randomUUID();
        const credential = await registerDevice(server.baseUrl, scope, item.hash);
        const blocker = {
          clientEventId,
          requestId,
          httpStatus: 503,
          lastObservedAt: now.toISOString(),
          reason: 'HTTP_SERVER_ERROR',
          since: now.toISOString(),
          stage: 'TRANSPORT',
        };
        const response = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
          at: now,
          blockers: [blocker],
          deviceInstanceHash: item.hash,
          identifiers: { clientEventId, requestId },
          routePlanId: scope.route.id,
        }));
        expect(response.status).toBe(200);
        await prisma.driverEventAttempt.create({
          data: {
            attemptNumber: 1,
            clientEventId,
            driverContractVersion: 2,
            driverId: scope.driver.id,
            errorCode: item.status === 'FAILED' ? 'SERVER_WRITE_FAILED' : null,
            eventType: 'LOCATION_UPDATED',
            occurredAt: now,
            receivedAt: now,
            requestId: randomUUID(),
            retainedUntil: new Date(now.getTime() + 86_400_000),
            routePlanId: scope.route.id,
            shopId: scope.shop.id,
            status: item.status,
            transportRequestId: requestId,
          },
        });
      }

      const response = await fetch(`${server.baseUrl}/admin/drivers/runtime-diagnostics`, {
        headers: { authorization: `Bearer admin:${scope.shop.shopDomain}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        data: { devices: Array<{ deviceInstanceHash: string; attempts: Array<{ status: string }>; diagnosis: { state: string } }> };
      };
      for (const item of cases) {
        const device = body.data.devices.find((candidate) => candidate.deviceInstanceHash === item.hash);
        expect(device?.attempts.map((attempt) => attempt.status)).toEqual([item.status]);
        expect(device?.diagnosis.state).toBe(item.state);
      }

      const isolated = await fetch(`${server.baseUrl}/admin/drivers/runtime-diagnostics`, {
        headers: { authorization: `Bearer admin:${otherScope.shop.shopDomain}` },
      });
      expect(isolated.status).toBe(200);
      expect((await isolated.json() as { data: { devices: unknown[] } }).data.devices).toEqual([]);
    } finally {
      await server.app.close();
    }
  });

  test('storage failure after contact returns no acknowledgement and retains the last good snapshot', async () => {
    const scope = await seedScope(prisma, 'storage-failure');
    const initialNow = new Date();
    const server = await startServer(prisma, initialNow);
    const deviceInstanceHash = '1'.repeat(64);
    const bootId = randomUUID();
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const acceptedId = randomUUID();
      const accepted = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
        at: initialNow, bootId, deviceInstanceHash, diagnosticId: acceptedId, routePlanId: scope.route.id,
      }));
      expect(accepted.status).toBe(200);
      const before = await prisma.driverRuntimeDiagnosticSnapshot.findFirstOrThrow({
        where: { device: { accountId: scope.account.id, deviceInstanceHash } },
      });

      const failureNow = new Date(initialNow.getTime() + 60_000);
      server.setNow(failureNow);
      server.failNextIngest();
      const failedId = randomUUID();
      const failed = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
        at: failureNow, bootId, deviceInstanceHash, diagnosticId: failedId, routePlanId: scope.route.id,
      }));
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: { code: 'DIAGNOSTIC_STORAGE_UNAVAILABLE' } });
      expect(await prisma.driverRuntimeDiagnosticRecord.count({ where: { diagnosticId: failedId } })).toBe(0);

      const after = await prisma.driverRuntimeDiagnosticSnapshot.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.snapshot).toEqual(before.snapshot);
      expect(after.snapshotObservedAt).toEqual(before.snapshotObservedAt);
      expect(after.lastIngestionFailureAt?.toISOString()).toBe(failureNow.toISOString());
      expect(after.lastIngestionFailureCode).toBe('DIAGNOSTIC_STORAGE_UNAVAILABLE');
    } finally {
      await server.app.close();
    }
  });

  test('a delayed record replays against its retained route scope after live assignment is removed', async () => {
    const scope = await seedScope(prisma, 'replay');
    const initialNow = new Date();
    const server = await startServer(prisma, initialNow);
    const deviceInstanceHash = '2'.repeat(64);
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const first = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
        at: initialNow, deviceInstanceHash, routePlanId: scope.route.id,
      }));
      expect(first.status).toBe(200);
      await prisma.routePlan.update({ where: { id: scope.route.id }, data: { driverId: null } });

      const replayId = randomUUID();
      const replayNow = new Date(initialNow.getTime() + 60_000);
      server.setNow(replayNow);
      const replay = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
        at: replayNow,
        deviceInstanceHash,
        diagnosticId: replayId,
        recordAt: initialNow,
        recordRoutePlanId: scope.route.id,
        routePlanId: null,
      }));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ acceptedDiagnosticIds: [replayId] });
      expect(await prisma.driverRuntimeDiagnosticRecord.findFirstOrThrow({ where: { diagnosticId: replayId } }))
        .toMatchObject({ isHistoricalReplay: true, routePlanId: scope.route.id, shopId: scope.shop.id });
    } finally {
      await server.app.close();
    }
  });

  test('admin status uses the shared injected clock to mark a silent device as signal absent', async () => {
    const scope = await seedScope(prisma, 'signal-absent');
    const initialNow = new Date();
    const server = await startServer(prisma, initialNow);
    const deviceInstanceHash = '3'.repeat(64);
    try {
      const credential = await registerDevice(server.baseUrl, scope, deviceInstanceHash);
      const accepted = await postDiagnostics(server.baseUrl, credential.token, diagnosticEnvelope({
        at: initialNow, deviceInstanceHash, routePlanId: scope.route.id,
      }));
      expect(accepted.status).toBe(200);
      server.setNow(new Date(initialNow.getTime() + 180_001));

      const response = await fetch(`${server.baseUrl}/admin/drivers/runtime-diagnostics`, {
        headers: { authorization: `Bearer admin:${scope.shop.shopDomain}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { devices: Array<{ diagnosis: { state: string } }> } };
      expect(body.data.devices).toHaveLength(1);
      expect(body.data.devices[0]?.diagnosis.state).toBe('SIGNAL_ABSENT_UNKNOWN');
    } finally {
      await server.app.close();
    }
  });
});
