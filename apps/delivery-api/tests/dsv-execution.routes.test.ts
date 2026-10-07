/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import Fastify from 'fastify';
import { describe, expect, test, vi } from 'vitest';

import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import { createDsvAdminPrincipal } from '../src/modules/dsv/dsv-principal.js';
import { createAdminWebSession } from '../src/routes/admin-ui-session.js';
import {
  PrismaDsvDriverExecutionPrincipalResolver,
  registerDsvExecutionRoutes,
  type DsvExecutionRouteDependencies,
} from '../src/routes/dsv-execution.routes.js';

const secret = '12345678901234567890123456789012';
const ids = {
  account: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  command: '33333333-3333-4333-8333-333333333333',
  context: '44444444-4444-4444-8444-444444444444',
  driver: '55555555-5555-4555-8555-555555555555',
  notification: '66666666-6666-4666-8666-666666666666',
  shop: '77777777-7777-4777-8777-777777777777',
  stop: '88888888-8888-4888-8888-888888888888',
  token: '99999999-9999-4999-8999-999999999999',
};

function setup() {
  const commands = {
    acknowledgeDeliveryException: vi.fn().mockResolvedValue({ id: ids.notification, status: 'ACKNOWLEDGED' }),
    getDeliveryException: vi.fn().mockResolvedValue({ id: ids.notification, status: 'OPEN' }),
    listDeliveryExceptions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    reportDeliveryException: vi.fn().mockResolvedValue({ commandId: ids.command, duplicate: false }),
    resolveDeliveryException: vi.fn().mockResolvedValue({ id: ids.notification, status: 'RESOLVED' }),
    start: vi.fn().mockResolvedValue({ commandId: ids.command, duplicate: false }),
  };
  const notifications = {
    ack: vi.fn().mockResolvedValue({ acknowledged: true }),
    list: vi.fn().mockResolvedValue({ items: [] }),
    registerCapability: vi.fn().mockResolvedValue({ registered: true }),
    resolve: vi.fn().mockResolvedValue({ destination: { type: 'EXECUTION', id: ids.context } }),
  };
  const driverPrincipalResolver = { resolve: vi.fn().mockResolvedValue({
    accountId: ids.account,
    principal: { driverId: ids.driver, principalType: 'DRIVER', scopes: [], shopId: ids.shop },
    shopDomain: 'tenant.example.test',
    tokenVersion: 3,
  }) };
  const dependencies: DsvExecutionRouteDependencies = {
    commands, driverJwtSecret: secret, driverPrincipalResolver, notifications,
  };
  const app = Fastify();
  registerDsvExecutionRoutes(app, dependencies);
  const token = signDriverAccountToken({
    accountId: ids.account, expiresInSeconds: 900, subject: ids.account, tokenVersion: 3,
  }, { secret }).token;
  return { app, commands, driverPrincipalResolver, headers: { authorization: `Bearer ${token}` }, notifications };
}

function setupAdmin() {
  const base = setup();
  const contexts = { get: vi.fn().mockResolvedValue({ context: { executionContextId: ids.context } }), list: vi.fn().mockResolvedValue({ items: [] }), map: vi.fn(), select: vi.fn() };
  const sessionResolver = { resolve: vi.fn().mockResolvedValue(createDsvAdminPrincipal({
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', shopDomain: 'tenant.example.test', shopId: ids.shop,
  })) };
  const { cookieHeader, session } = createAdminWebSession({
    cookieName: 'dsv_admin', path: '/api/dsv/', secure: false, sessionSecret: secret, subject: 'dsv-shop:tenant.example.test',
  });
  const app = Fastify();
  registerDsvExecutionRoutes(app, {
    admin: { cookieName: 'dsv_admin', sessionResolver, sessionSecret: secret },
    commands: base.commands,
    contexts,
    driverJwtSecret: secret,
    driverPrincipalResolver: base.driverPrincipalResolver,
    notifications: base.notifications,
  });
  void base.app.close();
  return {
    ...base, app, contexts, sessionResolver,
    adminHeaders: { cookie: cookieHeader.split(';')[0] ?? '', 'x-csrf-token': session.csrfToken },
  };
}

const startPayload = {
  assignmentEpoch: '4',
  assignmentGeneration: '9',
  commandId: ids.command,
  expectedRouteVersionId: ids.child,
  occurredAt: '2026-10-06T09:00:00.000Z',
  routeVersion: 3,
};

describe('DSV execution HTTP routes', () => {
  test('authenticates the account token and injects server-owned tenant identity into start', async () => {
    const { app, commands, headers } = setup();
    try {
      const response = await app.inject({
        headers, method: 'POST', payload: startPayload,
        url: `/api/dsv/driver/executions/${ids.context}/start`,
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(commands.start).toHaveBeenCalledWith({
        ...startPayload,
        accountId: ids.account,
        driverId: ids.driver,
        executionContextId: ids.context,
        occurredAt: new Date(startPayload.occurredAt),
        shopDomain: 'tenant.example.test',
        shopId: ids.shop,
      });
    } finally { await app.close(); }
  });

  test('rejects missing and wrong-audience authentication before dependencies', async () => {
    const { app, commands, driverPrincipalResolver } = setup();
    const routeToken = signDriverRouteToken({
      accountId: ids.account, expiresInSeconds: 900, routePlanId: ids.context, subject: ids.account,
    }, { secret }).token;
    try {
      for (const authorization of [undefined, 'Bearer malformed', `Bearer ${routeToken}`]) {
        const response = await app.inject({
          headers: authorization === undefined ? {} : { authorization },
          method: 'POST', payload: startPayload, url: `/api/dsv/driver/executions/${ids.context}/start`,
        });
        expect(response.statusCode).toBe(401);
      }
      expect(driverPrincipalResolver.resolve).not.toHaveBeenCalled();
      expect(commands.start).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('strictly rejects unknown, malformed and out-of-range command fields', async () => {
    const { app, commands, headers } = setup();
    try {
      const invalidPayloads = [
        { ...startPayload, accountId: ids.account },
        { ...startPayload, assignmentEpoch: 4 },
        { ...startPayload, assignmentGeneration: '0' },
        { ...startPayload, commandId: 'not-uuid' },
        { ...startPayload, occurredAt: '2026-10-06' },
        { ...startPayload, routeVersion: 0 },
      ];
      for (const payload of invalidPayloads) {
        const response = await app.inject({ headers, method: 'POST', payload, url: `/api/dsv/driver/executions/${ids.context}/start` });
        expect(response.statusCode).toBe(400);
      }
      expect(commands.start).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('rejects impossible execution-list calendar dates', async () => {
    const { app, headers } = setup();
    try {
      expect((await app.inject({ headers, method: 'GET', url: '/api/dsv/driver/executions?serviceDate=2026-02-30' })).statusCode).toBe(400);
      expect((await app.inject({ headers, method: 'GET', url: '/api/dsv/driver/executions?serviceDate=0000-01-01' })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  test('keeps resolver GET pure and acknowledges with a separate POST', async () => {
    const { app, headers, notifications } = setup();
    try {
      const resolved = await app.inject({
        headers, method: 'GET', url: `/api/dsv/driver/operational-notifications/${ids.notification}/resolve`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(notifications.resolve).toHaveBeenCalledOnce();
      expect(notifications.ack).not.toHaveBeenCalled();

      const acked = await app.inject({
        headers, method: 'POST', payload: { ackKind: 'READ' },
        url: `/api/dsv/driver/operational-notifications/${ids.notification}/acks`,
      });
      expect(acked.statusCode).toBe(200);
      expect(notifications.ack).toHaveBeenCalledWith({
        ackKind: 'READ', notificationId: ids.notification,
        principal: expect.objectContaining({ driverId: ids.driver, principalType: 'DRIVER', shopId: ids.shop }),
      });
    } finally { await app.close(); }
  });

  test('strictly validates capability and delivery exception payloads', async () => {
    const { app, commands, headers, notifications } = setup();
    try {
      const capability = await app.inject({
        headers, method: 'POST', payload: { installationId: 'device-a', kinds: ['N01', 'N05'], schemaVersion: 1, tokenId: ids.token },
        url: '/api/dsv/driver/operational-notifications/capability',
      });
      expect(capability.statusCode).toBe(200);
      expect(notifications.registerCapability).toHaveBeenCalledOnce();
      expect((await app.inject({
        headers, method: 'POST', payload: { installationId: 'device-a', kinds: ['N01', 'N01'], schemaVersion: 1, tokenId: ids.token },
        url: '/api/dsv/driver/operational-notifications/capability',
      })).statusCode).toBe(400);

      const exception = await app.inject({
        headers, method: 'POST', payload: {
          ...startPayload, explanation: '수취인 부재', reasonCode: 'RECIPIENT_ABSENT', targetStopId: ids.stop,
        }, url: `/api/dsv/driver/executions/${ids.context}/delivery-exceptions`,
      });
      expect(exception.statusCode).toBe(201);
      expect(commands.reportDeliveryException).toHaveBeenCalledWith(expect.objectContaining({
        accountId: ids.account, driverId: ids.driver, reasonCode: 'RECIPIENT_ABSENT', targetStopId: ids.stop,
      }));
      expect((await app.inject({
        headers, method: 'POST', payload: {
          ...startPayload, reasonCode: 'RECIPIENT_ABSENT', status: 'FAILED', targetStopId: ids.stop,
        }, url: `/api/dsv/driver/executions/${ids.context}/delivery-exceptions`,
      })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  test('keeps operations report GET pure and requires CSRF plus write scope for state changes', async () => {
    const { adminHeaders, app, commands } = setupAdmin();
    try {
      const list = await app.inject({ headers: { cookie: adminHeaders.cookie }, method: 'GET', url: '/api/dsv/v1/operations/delivery-exceptions' });
      expect(list.statusCode).toBe(200);
      expect(commands.listDeliveryExceptions).toHaveBeenCalledWith({ shopId: ids.shop });
      expect(commands.acknowledgeDeliveryException).not.toHaveBeenCalled();

      const noCsrf = await app.inject({
        headers: { cookie: adminHeaders.cookie }, method: 'POST', payload: {},
        url: `/api/dsv/v1/operations/delivery-exceptions/${ids.notification}/acknowledge`,
      });
      expect(noCsrf.statusCode).toBe(403);
      const acknowledged = await app.inject({
        headers: adminHeaders, method: 'POST', payload: {},
        url: `/api/dsv/v1/operations/delivery-exceptions/${ids.notification}/acknowledge`,
      });
      expect(acknowledged.statusCode).toBe(200);
      expect(commands.acknowledgeDeliveryException).toHaveBeenCalledWith({ id: ids.notification, shopId: ids.shop });
    } finally { await app.close(); }
  });

  test('supports the OPS N07 inbox and blocks customer sessions', async () => {
    const { adminHeaders, app, notifications, sessionResolver } = setupAdmin();
    try {
      expect((await app.inject({ headers: { cookie: adminHeaders.cookie }, method: 'GET', url: '/api/dsv/v1/operations/notifications' })).statusCode).toBe(200);
      expect(notifications.list).toHaveBeenCalledWith({ principal: expect.objectContaining({ principalType: 'DSV_ADMIN', shopId: ids.shop }) });
      expect((await app.inject({
        headers: adminHeaders, method: 'POST', payload: { ackKind: 'READ' },
        url: `/api/dsv/v1/operations/notifications/${ids.notification}/acks`,
      })).statusCode).toBe(200);
      expect(notifications.ack).toHaveBeenCalledWith(expect.objectContaining({ ackKind: 'READ', notificationId: ids.notification }));

      sessionResolver.resolve.mockResolvedValueOnce({
        customerId: ids.account, principalType: 'CUSTOMER_USER', scopes: ['dsv:session:read'], shopId: ids.shop,
      });
      expect((await app.inject({ headers: { cookie: adminHeaders.cookie }, method: 'GET', url: '/api/dsv/v1/operations/notifications' })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  test('reads execution control evidence without CSRF and requires control read scope', async () => {
    const { adminHeaders, app, contexts, sessionResolver } = setupAdmin();
    try {
      const response = await app.inject({
        headers: { cookie: adminHeaders.cookie },
        method: 'GET',
        url: `/api/dsv/v1/operations/executions/${ids.context}`,
      });
      expect(response.statusCode).toBe(200);
      expect(contexts.get).toHaveBeenCalledWith({
        executionContextId: ids.context,
        principal: expect.objectContaining({ principalType: 'DSV_ADMIN', shopId: ids.shop }),
      });
      expect(contexts.map).not.toHaveBeenCalled();
      expect(contexts.select).not.toHaveBeenCalled();

      sessionResolver.resolve.mockResolvedValueOnce(createDsvAdminPrincipal({
        actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        scopes: ['dsv:session:read'],
        shopId: ids.shop,
      }));
      expect((await app.inject({
        headers: { cookie: adminHeaders.cookie },
        method: 'GET',
        url: `/api/dsv/v1/operations/executions/${ids.context}`,
      })).statusCode).toBe(403);
      expect(contexts.get).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  test('gives a verified DSV driver the read and event scopes used by operational APIs', async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: ids.driver,
      shop: { shopDomain: 'tenant.example.test' },
      shopId: ids.shop,
    }]);
    const resolver = new PrismaDsvDriverExecutionPrincipalResolver({ driver: { findMany } } as never);
    await expect(resolver.resolve({ accountId: ids.account, tokenVersion: 3 })).resolves.toMatchObject({
      accountId: ids.account,
      principal: {
        driverId: ids.driver,
        principalType: 'DRIVER',
        scopes: ['driver:assignments:read', 'driver:events:write'],
        shopId: ids.shop,
      },
      tokenVersion: 3,
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: expect.objectContaining({
        account: { id: ids.account, status: 'ACTIVE', tokenVersion: 3 },
        dsvProfile: { isNot: null },
        status: 'ACTIVE',
      }),
    }));
  });
});
