import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadDriverApiDependencies } from '../../src/modules/driver/driver.dependencies.js';
import { PrismaDriverEventRepository } from '../../src/modules/driver/driver-event.repository.js';
import { signDriverAccountToken } from '../../src/modules/driver/driver-token-verifier.js';
import { PrismaDsvExecutionApiService } from '../../src/modules/dsv/dsv-execution-api.service.js';
import {
  DsvExecutionCommandError,
  PrismaDsvExecutionCommandsService,
} from '../../src/modules/dsv/dsv-execution-commands.service.js';
import { PrismaDsvAdminAccountRepository } from '../../src/modules/dsv/dsv-admin-account.repository.js';
import { createDsvAdminSessionSubject, parseDsvAdminSessionSubject } from '../../src/modules/dsv/dsv-admin-session-subject.js';
import { PrismaDsvDriverAuthRepository } from '../../src/modules/dsv/dsv-driver-auth.repository.js';
import { PrismaDsvOperationalDriverNotificationService } from '../../src/modules/dsv/dsv-operational-driver-notification.service.js';
import { PrismaDsvGeofenceService } from '../../src/modules/dsv/dsv-geofence.service.js';
import type { DsvGeofencePolicy } from '../../src/modules/dsv/dsv-geofence-policy.js';
import { PrismaDsvExecutionContextService } from '../../src/modules/dsv/dsv-execution-context.service.js';
import { PrismaUvisTelemetryRepository } from '../../src/modules/uvis/uvis-telemetry.repository.js';
import { PrismaRouteGroupingService } from '../../src/modules/route-grouping/route-grouping.service.js';
import type {
  DsvOperationalPushMessage,
  DsvOperationalPushProvider,
  DsvOperationalPushResult,
} from '../../src/modules/dsv/dsv-operational-driver-notification.provider.js';
import { createDsvAdminPrincipal, type DsvAdminPrincipal } from '../../src/modules/dsv/dsv-principal.js';
import { createAdminWebSession, verifyAdminWebSessionFromRequest } from '../../src/routes/admin-ui-session.js';
import { PrismaDsvDriverExecutionPrincipalResolver } from '../../src/routes/dsv-execution.routes.js';
import { FakeDriverPushProvider } from './fake-driver-push-provider.js';

export const DSV_ISOLATED_DATABASE_URL =
  'postgresql://dsv_operational:dsv_operational@127.0.0.1:55496/dsv_operational?schema=public';
export const DSV_ISOLATED_TARGET_CLASS = 'safe-local-dsv-operational-disposable';
export const DSV_ISOLATED_PORT = 4908;
export const DSV_ISOLATED_SERVICE_DATE = '2026-10-07';

const driverJwtSecret = 'test-dsv-isolated-driver-jwt-secret-2026';
const sessionSecret = 'dsv-isolated-admin-session-secret-2026';
const cookieName = 'dsv_isolated_admin';

export type DsvIsolatedFixture = {
  accountId: string;
  admin: { accountId: string; activeSessionId: string; actorId: string; csrfToken: string; cookie: string };
  childVersionId: string;
  contextId: string;
  deviceId: string;
  driverId: string;
  driverToken: string;
  foreign: { accountId: string; contextId: string; driverToken: string; shopId: string };
  n06NotificationId: string;
  nextStopId: string;
  orderId: string;
  routePlanId: string;
  serviceDate: string;
  shopDomain: string;
  shopId: string;
  stopId: string;
  vehicleId: string;
  vehiclePlate: string;
  warningNotificationId: string;
};

type FixtureRecord = DsvIsolatedFixture & {
  accountIds: string[];
  adminAccountIds: string[];
  driverCredentials: { loginId: string; password: string };
  shopIds: string[];
  traces: Array<Record<string, unknown>>;
};

const geofencePolicy: DsvGeofencePolicy = {
  arrivalDwellSeconds: 10,
  arrivalMinSamples: 2,
  destinationExitRadiusMeters: 80,
  destinationRadiusMeters: 60,
  exitDwellSeconds: 10,
  exitMinSamples: 2,
  futureToleranceSeconds: 5,
  maxGapSeconds: 120,
  maxObservationDelaySeconds: 120,
  maxReminderCount: 3,
  maxSpeedKph: 160,
  mode: 'LIVE',
  notificationTtlSeconds: 3_600,
  policyVersion: 'isolated-android-v1',
  reminderIntervalSeconds: 300,
  warehouseExitRadiusMeters: 100,
  warehouseRadiusMeters: 80,
};

class FakeOperationalPushProvider implements DsvOperationalPushProvider {
  readonly providerName = 'dsv-isolated-fake';
  readonly sent: DsvOperationalPushMessage[] = [];

  send(message: DsvOperationalPushMessage): Promise<DsvOperationalPushResult> {
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake:${message.payload.notificationId}`, status: 'SENT' });
  }
}

export type DsvIsolatedHttpHarness = {
  app: FastifyInstance;
  close(): Promise<void>;
  createFixture(): Promise<DsvIsolatedFixture>;
  fixture(): DsvIsolatedFixture;
  prisma: PrismaClient;
};

export async function createDsvIsolatedHttpHarness(): Promise<DsvIsolatedHttpHarness> {
  assertSafeEnvironment();
  const prisma = new PrismaClient({ datasourceUrl: DSV_ISOLATED_DATABASE_URL });
  await prisma.$connect();
  const commands = new PrismaDsvExecutionCommandsService(prisma, new PrismaDriverEventRepository(prisma));
  const contexts = new PrismaDsvExecutionApiService(prisma);
  const notifications = new PrismaDsvOperationalDriverNotificationService(
    prisma,
    new FakeOperationalPushProvider(),
  );
  const adminAccounts = new PrismaDsvAdminAccountRepository(prisma);
  const driverAuthRepository = new PrismaDsvDriverAuthRepository(prisma);
  const driverApi = loadDriverApiDependencies({
    env: {
      DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND: 'none',
      DRIVER_PROOF_MEDIA_SCANNER_BACKEND: 'none',
      DRIVER_PROOF_MEDIA_STORAGE_BACKEND: 'local',
      DRIVER_PROOF_MEDIA_STORAGE_DIR: '/tmp/dsv-isolated-driver-proof-media',
      JWT_SECRET: driverJwtSecret,
      NODE_ENV: 'test',
    },
    prisma,
  });
  let current: FixtureRecord | null = null;
  let flowLocked = false;
  let fixtureMutation: Promise<unknown> = Promise.resolve();

  const app = await buildApp({
    corsOrigin: false,
    dsvExecution: {
      admin: {
        cookieName,
        sessionResolver: {
          async resolve(subject: string): Promise<DsvAdminPrincipal> {
            const parsed = parseDsvAdminSessionSubject(subject);
            if (current === null || parsed?.kind !== 'account' || parsed.shopDomain !== current.shopDomain) {
              throw new DsvExecutionCommandError('UNAUTHORIZED');
            }
            const account = await adminAccounts.resolveSession(parsed);
            if (account === null) throw new DsvExecutionCommandError('UNAUTHORIZED');
            return createDsvAdminPrincipal({
              actorId: account.accountId,
              ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
              mustChangePassword: account.mustChangePassword,
              scopes: account.scopes,
              shopDomain: parsed.shopDomain,
              shopId: current.shopId,
            });
          },
        },
        sessionSecret,
      },
      commands,
      contexts,
      driverJwtSecret,
      driverPrincipalResolver: new PrismaDsvDriverExecutionPrincipalResolver(prisma),
      notifications,
    },
    ...(driverApi === undefined ? {} : { driverApi }),
    dsvDriverAuth: { jwtSecret: driverJwtSecret, repository: driverAuthRepository },
    logger: false,
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (current !== null && isTraceablePath(request.url)) {
      const body = objectValue(request.body);
      current.traces.push({
        at: new Date().toISOString(),
        commandId: typeof body?.commandId === 'string' ? body.commandId : null,
        contextId: executionContextId(request.url),
        explanation: typeof body?.explanation === 'string' ? body.explanation : null,
        method: request.method,
        path: request.url.split('?')[0],
        reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : null,
        status: reply.statusCode,
        targetStopId: typeof body?.targetStopId === 'string' ? body.targetStopId : null,
      });
      if (current.traces.length > 100) current.traces.splice(0, current.traces.length - 100);
    }
    done();
  });

  app.get('/api/dsv/__fixture/health', async (request, reply) => {
    requireLoopback(request);
    return reply.send({ data: { database: 'postgresql', serverSha: process.env.DSV_SERVER_SHA ?? 'working-tree' } });
  });
  app.get('/api/dsv/__fixture/session/admin', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    reply.header('set-cookie', `${fixture.admin.cookie}; Path=/api/dsv/; HttpOnly; SameSite=Strict`);
    return reply.send({ csrfToken: fixture.admin.csrfToken });
  });
  app.get('/api/dsv/__fixture/credentials/driver', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    return reply.send({ data: fixture.driverCredentials });
  });
  app.get('/api/dsv/__fixture/state', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    const [report, reportCount, route, order, stop, warning, context, notifications, events, commands] = await Promise.all([
      prisma.dsvDeliveryException.findFirst({ orderBy: { createdAt: 'desc' }, where: { shopId: fixture.shopId } }),
      prisma.dsvDeliveryException.count({ where: { shopId: fixture.shopId } }),
      prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }),
      prisma.dsvOperationalNotification.findUnique({ where: { id: fixture.warningNotificationId } }),
      prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }),
      prisma.dsvOperationalNotification.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { businessStatus: true, createdAt: true, id: true, kind: true, logicalKey: true, resolutionReason: true },
        where: { executionContextId: fixture.contextId },
      }),
      prisma.dsvGeofenceEvent.findMany({
        orderBy: [{ confirmedObservedAt: 'asc' }, { id: 'asc' }],
        select: { confirmedObservedAt: true, targetKey: true, transition: true },
        where: { executionContextId: fixture.contextId },
      }),
      prisma.dsvExecutionCommand.findMany({
        orderBy: { createdAt: 'asc' },
        select: { commandId: true, commandName: true },
        where: { shopId: fixture.shopId },
      }),
    ]);
    return reply.send({
      contextId: fixture.contextId,
      n06NotificationId: fixture.n06NotificationId,
      expectedChildVersionId: fixture.childVersionId,
      orderCurrentRouteVersionId: order.currentRouteVersionId,
      reportStatus: report?.status ?? null,
      reportId: report?.id ?? null,
      reportCount,
      reportReasonCode: report?.reasonCode ?? null,
      reportExplanation: report?.explanation ?? null,
      reportTargetStopId: report?.targetStopId ?? null,
      routeStatus: route.status,
      serviceDate: fixture.serviceDate,
      stopId: fixture.stopId,
      stopStatus: stop.status,
      commands,
      commandReceiptCount: commands.length,
      startedAt: context.startedAt,
      reminderDueAt: context.reminderDueAt,
      reminderStatus: context.reminderStatus,
      lastWarningAt: notifications.filter(({ kind }) => kind === 'N05').at(-1)?.createdAt ?? null,
      geofenceEvents: events,
      notifications,
      traces: fixture.traces,
      warningStatus: warning?.businessStatus ?? null,
    });
  });
  app.post('/api/dsv/__fixture/reset', async (request, reply) => {
    requireLoopback(request);
    const fixture = await serializedFixtureMutation(async () => {
      if (flowLocked) return null;
      return createFixture();
    });
    if (fixture === null) return reply.code(409).send({ error: { code: 'FIXTURE_FLOW_LOCKED' } });
    reply.header('set-cookie', `${fixture.admin.cookie}; Path=/api/dsv/; HttpOnly; SameSite=Strict`);
    return reply.send({
      contextId: fixture.contextId,
      csrfToken: fixture.admin.csrfToken,
      serviceDate: fixture.serviceDate,
      stopId: fixture.stopId,
    });
  });
  app.post('/api/dsv/__fixture/actions/begin', async (request, reply) => {
    requireLoopback(request);
    await serializedFixtureMutation(() => {
      const fixture = requireFixture(current);
      requireFixtureAdmin(request, fixture);
      flowLocked = true;
      return Promise.resolve();
    });
    return reply.send({ data: { locked: true } });
  });
  app.post('/api/dsv/__fixture/actions/end', async (request, reply) => {
    requireLoopback(request);
    await serializedFixtureMutation(() => {
      const fixture = requireFixture(current);
      requireFixtureAdmin(request, fixture);
      flowLocked = false;
      return Promise.resolve();
    });
    return reply.send({ data: { locked: false } });
  });
  app.post('/api/dsv/__fixture/actions/geofence/warehouse-cycle', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const result = await serializedFixtureMutation(() => runWarehouseCycle(prisma, fixture));
    return reply.send({ data: result });
  });
  app.post('/api/dsv/__fixture/actions/geofence/destination-arrival', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const result = await serializedFixtureMutation(() => runDestinationArrival(prisma, fixture));
    return reply.send({ data: result });
  });
  app.post('/api/dsv/__fixture/actions/geofence/reminder-repeat', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const result = await serializedFixtureMutation(() => runReminderRepeat(prisma, fixture));
    return reply.send({ data: result });
  });
  app.post('/api/dsv/__fixture/actions/geofence/start-stop', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.driverToken}` },
      method: 'POST',
      payload: {
        assignmentEpoch: '1', assignmentGeneration: '1', commandId: randomUUID(),
        expectedRouteVersionId: fixture.childVersionId,
        occurredAt: new Date().toISOString(), routeVersion: 1,
      },
      url: `/api/dsv/driver/executions/${fixture.contextId}/start`,
    });
    if (response.statusCode >= 400) return reply.code(response.statusCode).send(response.json());
    const afterStart = await new PrismaDsvGeofenceService(prisma, { policy: geofencePolicy })
      .tickReminders(new Date(Date.now() + 3_600_000));
    const context = await prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } });
    return reply.send({ data: { afterStart, reminderStatus: context.reminderStatus, startedAt: context.startedAt } });
  });
  app.post('/api/dsv/__fixture/actions/publication/change', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const result = await serializedFixtureMutation(async () => {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } });
      const rawPayload = objectValue(order.rawPayload) ?? {};
      const dsv = objectValue(rawPayload.dsv) ?? {};
      const normalized = objectValue(dsv.normalized) ?? {};
      await prisma.order.update({
        data: {
          rawPayload: {
            ...rawPayload,
            dsv: { ...dsv, normalized: { ...normalized, shippedBoxes: 4 } },
          },
        },
        where: { id: fixture.orderId },
      });
      return prisma.$transaction((transaction) => new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId: randomUUID(),
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
      }));
    });
    return reply.send({ data: result });
  });
  app.post('/api/dsv/__fixture/actions/auth/expire', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    await serializedFixtureMutation(() => prisma.driverAccount.update({
      data: { tokenVersion: { increment: 1 } },
      where: { id: fixture.accountId },
    }));
    return reply.send({ data: { expired: true } });
  });
  app.post('/api/dsv/__fixture/actions/report', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const commandId = randomUUID();
    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.driverToken}` },
      method: 'POST',
      payload: {
        assignmentEpoch: '1', assignmentGeneration: '1', commandId,
        expectedRouteVersionId: fixture.childVersionId,
        explanation: 'browser isolated integration', occurredAt: new Date().toISOString(),
        reasonCode: 'UNDELIVERABLE', routeVersion: 1, targetStopId: fixture.stopId,
      },
      url: `/api/dsv/driver/executions/${fixture.contextId}/delivery-exceptions`,
    });
    return reply.code(response.statusCode).send(response.json());
  });
  app.post('/api/dsv/__fixture/actions/start', async (request, reply) => {
    requireLoopback(request);
    const fixture = requireFixture(current);
    requireFixtureAdmin(request, fixture);
    const response = await app.inject({
      headers: { authorization: `Bearer ${fixture.driverToken}` },
      method: 'POST',
      payload: {
        assignmentEpoch: '1', assignmentGeneration: '1', commandId: randomUUID(),
        expectedRouteVersionId: fixture.childVersionId,
        occurredAt: new Date().toISOString(), routeVersion: 1,
      },
      url: `/api/dsv/driver/executions/${fixture.contextId}/start`,
    });
    return reply.code(response.statusCode).send(response.json());
  });
  app.get('/api/dsv/v1/session', async (request, reply) => {
    const fixture = requireFixture(current);
    const session = verifyAdminWebSessionFromRequest({ cookieName, request, sessionSecret });
    if (session === null || session.subject !== fixtureSessionSubject(fixture)) {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED' } });
    }
    const account = await adminAccounts.resolveSession({
      accountId: fixture.admin.accountId,
      activeSessionId: fixture.admin.activeSessionId,
    });
    if (account === null) return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED' } });
    const principal = createDsvAdminPrincipal({
      actorId: account.accountId,
      ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
      mustChangePassword: account.mustChangePassword,
      scopes: account.scopes,
      shopDomain: fixture.shopDomain,
      shopId: fixture.shopId,
    });
    return reply.send({
      data: { ...principal, csrfToken: session.csrfToken },
      meta: { apiVersion: 'dsv.v1' },
      requestId: request.id,
    });
  });
  app.get('/api/dsv/auth/session', async (request, reply) => {
    const session = verifyAdminWebSessionFromRequest({ cookieName, request, sessionSecret });
    return session === null
      ? reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED' } })
      : reply.send({ data: { csrfToken: session.csrfToken } });
  });

  const createFixture = async (): Promise<DsvIsolatedFixture> => {
    if (current !== null) await cleanupFixture(prisma, current);
    current = await seedFixture(prisma);
    return publicFixture(current);
  };

  function serializedFixtureMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = fixtureMutation.then(operation, operation);
    fixtureMutation = result.then(() => undefined, () => undefined);
    return result;
  }
  await app.ready();

  return {
    app,
    async close() {
      await app.close();
      if (current !== null) await cleanupFixture(prisma, current);
      await prisma.$disconnect();
    },
    createFixture,
    fixture: () => publicFixture(requireFixture(current)),
    prisma,
  };
}

function assertSafeEnvironment(): void {
  const errors = [
    process.env.CLEVER_RUN_DISPOSABLE_DB_TESTS === '1',
    process.env.DSV_OPERATIONAL_DATABASE_TARGET_CLASS === DSV_ISOLATED_TARGET_CLASS,
    process.env.DSV_OPERATIONAL_DATABASE_URL === DSV_ISOLATED_DATABASE_URL,
    process.env.DATABASE_URL === DSV_ISOLATED_DATABASE_URL,
  ];
  if (errors.some((value) => !value)) {
    throw new Error('Refusing DSV isolated HTTP harness: exact disposable PostgreSQL environment is required');
  }
}

function requireLoopback(request: FastifyRequest): void {
  const address = request.ip.replace(/^::ffff:/u, '');
  if (address !== '127.0.0.1' && address !== '::1') throw new Error('Fixture endpoint is loopback-only');
}

function isTraceablePath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path.startsWith('/api/dsv/driver/executions/')
    || path === '/api/dsv/driver/auth/login'
    || path === '/driver/route-access/lookup'
    || path === '/driver/assigned-route';
}

function executionContextId(url: string): string | null {
  return /^\/api\/dsv\/driver\/executions\/([^/?]+)/u.exec(url)?.[1] ?? null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireFixtureAdmin(request: FastifyRequest, fixture: FixtureRecord): void {
  const session = verifyAdminWebSessionFromRequest({ cookieName, request, sessionSecret });
  if (session === null || session.subject !== fixtureSessionSubject(fixture)
    || request.headers['x-csrf-token'] !== session.csrfToken) {
    throw new Error('Fixture action requires the isolated admin session and CSRF token');
  }
}

function requireFixture(value: FixtureRecord | null): FixtureRecord {
  if (value === null) throw new Error('DSV isolated fixture is not initialized');
  return value;
}

function fixtureSessionSubject(fixture: FixtureRecord): string {
  return createDsvAdminSessionSubject({
    accountId: fixture.admin.accountId,
    activeSessionId: fixture.admin.activeSessionId,
    shopDomain: fixture.shopDomain,
  });
}

function publicFixture(fixture: FixtureRecord): DsvIsolatedFixture {
  return fixture;
}

async function seedFixture(prisma: PrismaClient): Promise<FixtureRecord> {
  // A killed local runtime can leave only this reserved synthetic tenant behind.
  await prisma.shop.deleteMany({ where: { appId: 'clever', shopDomain: 'dsv-demo.local' } });
  const primary = await seedTenant(prisma, 'primary');
  const foreign = await seedTenant(prisma, 'foreign');
  const activeSessionId = randomUUID();
  const adminAccount = await prisma.dsvAdminAccount.create({
    data: {
      activeSessionId,
      displayName: 'Isolated DSV Administrator',
      loginId: `isolated-${randomUUID()}`,
      passwordHash: 'isolated-not-used',
      passwordSalt: 'isolated-not-used',
      scopes: ['dsv:session:read', 'dsv:control:read', 'dsv:dispatches:write'],
      status: 'ACTIVE',
    },
  });
  const session = createAdminWebSession({
    cookieName,
    path: '/api/dsv/',
    secure: false,
    sessionSecret,
    subject: createDsvAdminSessionSubject({ accountId: adminAccount.id, activeSessionId, shopDomain: primary.shopDomain }),
  });
  const n06 = await prisma.dsvOperationalNotification.create({
    data: {
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      dueAt: new Date('2026-10-06T01:00:00.000Z'),
      executionContextId: primary.contextId,
      expiresAt: new Date('2099-10-07T00:00:00.000Z'),
      kind: 'N06',
      logicalKey: `N06:${primary.contextId}:1:${primary.stopId}`,
      payload: { schema: 'dsv_destination_arrival_v1' },
      recipientAccountId: primary.accountId,
      routeVersion: 1,
      shopId: primary.shopId,
      targetStopId: primary.stopId,
    },
  });
  const warning = await prisma.dsvOperationalNotification.create({
    data: {
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      dueAt: new Date('2026-10-06T00:30:00.000Z'),
      executionContextId: primary.contextId,
      expiresAt: new Date('2099-10-07T00:00:00.000Z'),
      kind: 'N05',
      logicalKey: `N05:${primary.contextId}:1:1`,
      payload: { schema: 'dsv_missing_start_v1' },
      recipientAccountId: primary.accountId,
      routeVersion: 1,
      shopId: primary.shopId,
    },
  });
  return {
    ...primary,
    accountIds: [primary.accountId, foreign.accountId],
    admin: {
      accountId: adminAccount.id,
      activeSessionId,
      actorId: adminAccount.id,
      cookie: session.cookieHeader.split(';')[0] ?? '',
      csrfToken: session.session.csrfToken,
    },
    foreign: {
      accountId: foreign.accountId,
      contextId: foreign.contextId,
      driverToken: foreign.driverToken,
      shopId: foreign.shopId,
    },
    driverCredentials: primary.driverCredentials,
    n06NotificationId: n06.id,
    adminAccountIds: [adminAccount.id],
    shopIds: [primary.shopId, foreign.shopId],
    traces: [],
    warningNotificationId: warning.id,
  };
}

async function seedTenant(prisma: PrismaClient, label: string) {
  const unique = randomUUID();
  const shopDomain = label === 'primary' ? 'dsv-demo.local' : `dsv-foreign-${unique}.example.test`;
  const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain } });
  const driverName = `Synthetic ${label} ${unique.slice(0, 8)}`;
  const driverPhone = `010${unique.replaceAll('-', '').replace(/\D/gu, '').padEnd(8, '0').slice(0, 8)}`;
  const driver = await prisma.driver.create({
    data: { displayName: driverName, phone: driverPhone, shopId: shop.id, status: 'ACTIVE' },
  });
  await prisma.dsvDriverProfile.create({
    data: { driverId: driver.id, lookupName: driverName, shopId: shop.id },
  });
  const driverCredentials = {
    loginId: `isolated.${label}.${unique.slice(0, 8)}`,
    password: `Isolated-${unique}-Pass!`,
  };
  const authSession = await new PrismaDsvDriverAuthRepository(prisma).register({
    ...driverCredentials,
    name: driverName,
    phone: driverPhone,
  });
  const account = await prisma.driverAccount.findUniqueOrThrow({ where: { id: authSession.accountId } });
  await prisma.driver.update({ data: { accountId: account.id }, where: { id: driver.id } });
  const vehicle = await prisma.vehicle.create({
    data: { label: `Synthetic Vehicle ${label}`, licensePlate: unique.slice(0, 30), shopId: shop.id, status: 'ACTIVE' },
  });
  const device = await prisma.dsvVehicleTelematicsDevice.create({
    data: {
      capabilities: ['VEHICLE_GPS'],
      installedAt: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      serialNumber: `UVIS-${unique}`,
      shopId: shop.id,
      vehicleId: vehicle.id,
    },
  });
  const order = await prisma.order.create({
    data: {
      name: `#isolated-${label}`,
      rawPayload: {
        dsv: {
          normalized: {
            conditionCode: 'STANDARD',
            destinationId: `DEST-${label.toUpperCase()}-${unique.slice(0, 8)}`,
            sellerOrderKey: `SO-${unique}`,
            shippedBoxes: 3,
          },
        },
        deliverySession: 'MORNING',
        normalizedPaymentStatus: 'PAID',
        serviceType: 'DELIVERY',
      },
      sellerOrderKey: `SO-${unique}`,
      sellerOrderSourceKind: 'DSV_DISPATCH',
      serviceDate: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      shopId: shop.id,
      shopifyOrderGid: `gid://synthetic/Order/${unique}`,
      sourceOrderId: unique,
      sourcePlatform: 'SHOPIFY',
    },
  });
  const stop = await prisma.deliveryStop.create({
    data: {
      address1: `Synthetic ${label} destination`,
      countryCode: 'KR',
      latitude: label === 'primary' ? '37.5000000' : '35.1000000',
      longitude: label === 'primary' ? '127.0000000' : '129.0000000',
      orderId: order.id,
      recipientName: `Synthetic ${label} recipient`,
      shopId: shop.id,
      status: 'PENDING',
    },
  });
  const nextOrder = await prisma.order.create({
    data: {
      name: `#isolated-${label}-next`,
      rawPayload: {
        dsv: {
          normalized: {
            conditionCode: 'STANDARD',
            destinationId: `DEST-${label.toUpperCase()}-NEXT-${unique.slice(0, 8)}`,
            sellerOrderKey: `SO-NEXT-${unique}`,
            shippedBoxes: 1,
          },
        },
        deliverySession: 'MORNING',
        normalizedPaymentStatus: 'PAID',
        serviceType: 'DELIVERY',
      },
      sellerOrderKey: `SO-NEXT-${unique}`,
      sellerOrderSourceKind: 'DSV_DISPATCH',
      serviceDate: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      shopId: shop.id,
      shopifyOrderGid: `gid://synthetic/Order/next-${unique}`,
      sourceOrderId: `next-${unique}`,
      sourcePlatform: 'SHOPIFY',
    },
  });
  const nextStop = await prisma.deliveryStop.create({
    data: {
      address1: `Synthetic ${label} next destination`,
      countryCode: 'KR',
      latitude: label === 'primary' ? '37.4950000' : '35.0950000',
      longitude: label === 'primary' ? '127.0050000' : '129.0050000',
      orderId: nextOrder.id,
      recipientName: `Synthetic ${label} next recipient`,
      shopId: shop.id,
      status: 'PENDING',
    },
  });
  const route = await prisma.routePlan.create({
    data: {
      assignmentGeneration: 1n,
      constraints: {},
      depotLatitude: '37.4900000',
      depotLongitude: '127.0100000',
      driverId: driver.id,
      metrics: {},
      name: `Synthetic Route ${label}`,
      optimizerVersion: 'dsv-isolated-http',
      planDate: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      shopId: shop.id,
      status: 'READY',
      vehicleId: vehicle.id,
    },
  });
  const grouping = await prisma.routeGrouping.create({
    data: { name: `Synthetic Grouping ${label}`, planDate: route.planDate, shopId: shop.id, status: 'READY' },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 },
  });
  const child = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      publishedAt: null,
      routePlanId: route.id,
      shopId: shop.id,
      snapshot: { assignmentGeneration: '1', stops: [
        { deliveryStopId: nextStop.id, orderId: nextOrder.id, sequence: 1 },
        { deliveryStopId: stop.id, orderId: order.id, sequence: 2 },
      ] },
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.routePlanStop.create({
      data: { deliveryStopId: nextStop.id, etaInputRouteVersionId: child.id, routePlanId: route.id, sequence: 1, shopId: shop.id },
    }),
    prisma.routePlanStop.create({
      data: { deliveryStopId: stop.id, etaInputRouteVersionId: child.id, routePlanId: route.id, sequence: 2, shopId: shop.id },
    }),
    prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: order.id } }),
    prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: nextOrder.id } }),
  ]);
  const publication = await new PrismaRouteGroupingService(prisma, new FakeDriverPushProvider())
    .recordChildRoutePublished({ routePlanId: route.id, shopDomain });
  if (publication.publishedAt === null) throw new Error(`Synthetic route publication failed: ${publication.status}`);
  const context = await prisma.dsvExecutionContext.findFirstOrThrow({ where: { routePlanId: route.id, shopId: shop.id } });
  return {
    accountId: account.id,
    childVersionId: child.id,
    contextId: context.id,
    deviceId: device.id,
    driverId: driver.id,
    driverCredentials,
    driverToken: signDriverAccountToken({
      accountId: account.id,
      expiresInSeconds: 8 * 60 * 60,
      subject: `driver-account:${account.id}`,
      tokenVersion: account.tokenVersion,
    }, { secret: driverJwtSecret }).token,
    orderId: order.id,
    nextStopId: nextStop.id,
    routePlanId: route.id,
    serviceDate: DSV_ISOLATED_SERVICE_DATE,
    shopDomain,
    shopId: shop.id,
    stopId: stop.id,
    vehicleId: vehicle.id,
    vehiclePlate: vehicle.licensePlate!,
  };
}

async function runWarehouseCycle(prisma: PrismaClient, fixture: FixtureRecord) {
  const base = new Date(Date.now() + 5_000);
  await prepareLiveGeofence(prisma, fixture, base);
  const service = new PrismaDsvGeofenceService(prisma, { policy: geofencePolicy });
  await processGpsObservations(prisma, fixture, service, [
    { at: base, coordinates: ['37.4900000', '127.0100000'] as const },
    { at: new Date(base.getTime() + 10_000), coordinates: ['37.4900000', '127.0100000'] as const },
    { at: new Date(base.getTime() + 60_000), coordinates: ['37.5200000', '127.0300000'] as const },
    { at: new Date(base.getTime() + 70_000), coordinates: ['37.5200000', '127.0300000'] as const },
  ]);
  const dueAt = new Date(base.getTime() + 370_000);
  const beforeDue = await service.tickReminders(new Date(dueAt.getTime() - 1));
  const atDue = await service.tickReminders(dueAt);
  return {
    atDue,
    beforeDue,
    dueAt: dueAt.toISOString(),
    notificationKinds: await notificationKinds(prisma, fixture.contextId),
  };
}

async function runReminderRepeat(prisma: PrismaClient, fixture: FixtureRecord) {
  const before = await prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } });
  if (before.reminderDueAt === null) throw new Error('Fixture reminder is not active');
  const service = new PrismaDsvGeofenceService(prisma, { policy: geofencePolicy });
  const beforeDue = await service.tickReminders(new Date(before.reminderDueAt.getTime() - 1));
  const atDue = await service.tickReminders(before.reminderDueAt);
  const after = await prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } });
  return {
    atDue,
    beforeDue,
    nextDueAt: after.reminderDueAt,
    reminderOrdinal: after.reminderOrdinal,
  };
}

async function runDestinationArrival(prisma: PrismaClient, fixture: FixtureRecord) {
  const base = new Date(Date.now() + 900_000);
  const service = new PrismaDsvGeofenceService(prisma, { policy: geofencePolicy });
  await processGpsObservations(prisma, fixture, service, [
    { at: base, coordinates: ['37.5000000', '127.0000000'] as const },
    { at: new Date(base.getTime() + 10_000), coordinates: ['37.5000000', '127.0000000'] as const },
  ]);
  const notification = await prisma.dsvOperationalNotification.findFirstOrThrow({
    orderBy: { createdAt: 'desc' },
    where: {
      businessStatus: 'OPEN',
      executionContextId: fixture.contextId,
      kind: 'N06',
      targetStopId: fixture.stopId,
    },
  });
  return { notificationId: notification.id, targetStopId: notification.targetStopId };
}

async function prepareLiveGeofence(prisma: PrismaClient, fixture: FixtureRecord, now: Date): Promise<void> {
  await prisma.dsvOperationalNotification.deleteMany({
    where: { executionContextId: fixture.contextId, kind: { in: ['N05', 'N06'] } },
  });
  await prisma.dsvExecutionContext.update({
    data: {
      departureObservedAt: null,
      liveEligibleAt: now,
      monitorEndAt: new Date(now.getTime() + 3_600_000),
      monitorStartAt: now,
      notificationMode: 'LIVE',
      policy: geofencePolicy,
      reminderDueAt: null,
      reminderIncidentId: null,
      reminderOrdinal: 0,
      reminderStatus: 'NOT_STARTED',
      warehouseNotifiedAt: null,
    },
    where: { id: fixture.contextId },
  });
}

async function processGpsObservations(
  prisma: PrismaClient,
  fixture: FixtureRecord,
  service: PrismaDsvGeofenceService,
  observations: Array<{ at: Date; coordinates: readonly [string, string] }>,
): Promise<void> {
  const telemetry = new PrismaUvisTelemetryRepository(prisma);
  for (const observation of observations) {
    const stored = await telemetry.recordSample({
      deviceId: fixture.deviceId,
      ignitionOn: true,
      latitude: observation.coordinates[0],
      longitude: observation.coordinates[1],
      observedAt: observation.at,
      receivedAt: observation.at,
      sourceDeviceIdentifier: 'isolated-uvis-device',
      sourceKind: 'VEHICLE_GPS',
      sourcePlate: fixture.vehiclePlate,
      speedKph: '10',
      staleAfter: new Date(observation.at.getTime() + 300_000),
    });
    const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
    await prisma.dsvGeofenceJob.update({ data: { nextAttemptAt: observation.at }, where: { id: job.id } });
    await service.process(job.id, new Date(observation.at.getTime() + 1_000));
  }
}

async function notificationKinds(prisma: PrismaClient, executionContextId: string): Promise<string[]> {
  return (await prisma.dsvOperationalNotification.findMany({
    orderBy: { createdAt: 'asc' },
    select: { kind: true },
    where: { businessStatus: 'OPEN', executionContextId },
  })).map(({ kind }) => kind);
}

async function cleanupFixture(prisma: PrismaClient, fixture: FixtureRecord): Promise<void> {
  await prisma.shop.deleteMany({ where: { id: { in: fixture.shopIds } } });
  await prisma.driverAccount.deleteMany({ where: { id: { in: fixture.accountIds } } });
  await prisma.dsvAdminAccount.deleteMany({ where: { id: { in: fixture.adminAccountIds } } });
}
