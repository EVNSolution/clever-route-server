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
import type {
  DsvOperationalPushMessage,
  DsvOperationalPushProvider,
  DsvOperationalPushResult,
} from '../../src/modules/dsv/dsv-operational-driver-notification.provider.js';
import { createDsvAdminPrincipal, type DsvAdminPrincipal } from '../../src/modules/dsv/dsv-principal.js';
import { createAdminWebSession, verifyAdminWebSessionFromRequest } from '../../src/routes/admin-ui-session.js';
import { PrismaDsvDriverExecutionPrincipalResolver } from '../../src/routes/dsv-execution.routes.js';

export const DSV_ISOLATED_DATABASE_URL =
  'postgresql://dsv_operational:dsv_operational@127.0.0.1:55496/dsv_operational?schema=public';
export const DSV_ISOLATED_TARGET_CLASS = 'safe-local-dsv-operational-disposable';
export const DSV_ISOLATED_PORT = 4908;
export const DSV_ISOLATED_SERVICE_DATE = '2026-10-06';

const driverJwtSecret = 'test-dsv-isolated-driver-jwt-secret-2026';
const sessionSecret = 'dsv-isolated-admin-session-secret-2026';
const cookieName = 'dsv_isolated_admin';

export type DsvIsolatedFixture = {
  accountId: string;
  admin: { accountId: string; activeSessionId: string; actorId: string; csrfToken: string; cookie: string };
  childVersionId: string;
  contextId: string;
  driverId: string;
  driverToken: string;
  foreign: { accountId: string; contextId: string; driverToken: string; shopId: string };
  n06NotificationId: string;
  orderId: string;
  routePlanId: string;
  serviceDate: string;
  shopDomain: string;
  shopId: string;
  stopId: string;
  vehicleId: string;
  warningNotificationId: string;
};

type FixtureRecord = DsvIsolatedFixture & {
  accountIds: string[];
  adminAccountIds: string[];
  driverCredentials: { loginId: string; password: string };
  shopIds: string[];
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

  const app = await buildApp({
    corsOrigin: true,
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
    const [report, route, order, stop, warning] = await Promise.all([
      prisma.dsvDeliveryException.findFirst({ orderBy: { createdAt: 'desc' }, where: { shopId: fixture.shopId } }),
      prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }),
      prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: fixture.warningNotificationId } }),
    ]);
    return reply.send({
      contextId: fixture.contextId,
      n06NotificationId: fixture.n06NotificationId,
      expectedChildVersionId: fixture.childVersionId,
      orderCurrentRouteVersionId: order.currentRouteVersionId,
      reportStatus: report?.status ?? null,
      routeStatus: route.status,
      serviceDate: fixture.serviceDate,
      stopId: fixture.stopId,
      stopStatus: stop.status,
      warningStatus: warning.businessStatus,
    });
  });
  app.post('/api/dsv/__fixture/reset', async (request, reply) => {
    requireLoopback(request);
    const fixture = await createFixture();
    reply.header('set-cookie', `${fixture.admin.cookie}; Path=/api/dsv/; HttpOnly; SameSite=Strict`);
    return reply.send({
      contextId: fixture.contextId,
      csrfToken: fixture.admin.csrfToken,
      serviceDate: fixture.serviceDate,
      stopId: fixture.stopId,
    });
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
  const vehicle = await prisma.vehicle.create({
    data: { label: `Synthetic Vehicle ${label}`, licensePlate: unique.slice(0, 30), shopId: shop.id, status: 'ACTIVE' },
  });
  const order = await prisma.order.create({
    data: {
      name: `#isolated-${label}`,
      rawPayload: { dsv: { normalized: { shippedBoxes: 1 } } },
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
      publishedAt: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      routePlanId: route.id,
      shopId: shop.id,
      snapshot: { assignmentGeneration: '1', stops: [{ deliveryStopId: stop.id, orderId: order.id, sequence: 1 }] },
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.routePlanStop.create({
      data: { deliveryStopId: stop.id, etaInputRouteVersionId: child.id, routePlanId: route.id, sequence: 1, shopId: shop.id },
    }),
    prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: order.id } }),
  ]);
  const context = await prisma.dsvExecutionContext.create({
    data: {
      assignmentEpoch: 1n,
      contentFingerprint: `fingerprint-${unique}`,
      contentSnapshot: {
        depot: { latitude: 37.49, longitude: 127.01 },
        stops: [{ id: stop.id, orderId: order.id, quantity: 1, sequence: 1, status: 'PENDING' }],
      },
      driverId: driver.id,
      effectiveAt: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      notificationMode: 'OFF',
      recipientAccountId: account.id,
      reminderDueAt: new Date('2026-10-06T00:30:00.000Z'),
      reminderIncidentId: randomUUID(),
      reminderStatus: 'REMINDER_ACTIVE',
      routePlanId: route.id,
      routeVersion: 1,
      serviceDate: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
      shopId: shop.id,
      status: 'ACTIVE',
      vehicleId: vehicle.id,
    },
  });
  await prisma.dsvExecutionRouteMapping.create({
    data: {
      executionContextId: context.id,
      routePlanId: route.id,
      shopId: shop.id,
      validFrom: new Date(`${DSV_ISOLATED_SERVICE_DATE}T00:00:00.000Z`),
    },
  });
  return {
    accountId: account.id,
    childVersionId: child.id,
    contextId: context.id,
    driverId: driver.id,
    driverCredentials,
    driverToken: signDriverAccountToken({
      accountId: account.id,
      expiresInSeconds: 8 * 60 * 60,
      subject: `driver-account:${account.id}`,
      tokenVersion: account.tokenVersion,
    }, { secret: driverJwtSecret }).token,
    orderId: order.id,
    routePlanId: route.id,
    serviceDate: DSV_ISOLATED_SERVICE_DATE,
    shopDomain,
    shopId: shop.id,
    stopId: stop.id,
    vehicleId: vehicle.id,
  };
}

async function cleanupFixture(prisma: PrismaClient, fixture: FixtureRecord): Promise<void> {
  await prisma.shop.deleteMany({ where: { id: { in: fixture.shopIds } } });
  await prisma.driverAccount.deleteMany({ where: { id: { in: fixture.accountIds } } });
  await prisma.dsvAdminAccount.deleteMany({ where: { id: { in: fixture.adminAccountIds } } });
}
