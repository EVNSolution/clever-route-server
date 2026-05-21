import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AdminDriverRow } from '../src/modules/driver/admin-driver.types.js';
import type { AdminDriversDependencies } from '../src/routes/admin-drivers.routes.js';

const pendingDriver: AdminDriverRow = {
  authStatus: 'INVITE_PENDING',
  authSubject: null,
  createdAt: '2026-05-11T02:00:00.000Z',
  displayName: '+821089216198',
  id: 'driver-id',
  lastSeenAt: null,
  phone: '+821089216198',
  recentEventsCount: 0,
  status: 'PENDING',
  updatedAt: '2026-05-11T02:00:00.000Z',
  inviteCode: 'ABCDEF',
  inviteCodeExpiresAt: '2026-05-12T02:00:00.000Z'
};

const linkedDriver: AdminDriverRow = {
  authStatus: 'APP_LINKED',
  authSubject: 'present',
  createdAt: '2026-05-10T02:00:00.000Z',
  displayName: 'Minji Kim',
  id: 'linked-driver-id',
  lastSeenAt: '2026-05-11T01:59:00.000Z',
  phone: '+14165550108',
  recentEventsCount: 4,
  status: 'ACTIVE',
  updatedAt: '2026-05-11T01:59:00.000Z',
  inviteCode: null,
  inviteCodeExpiresAt: null
};

describe('Admin drivers routes', () => {
  test('rejects driver creation without a Shopify session token', async () => {
    const { createPendingDriver, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: driverInvitePayload(),
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(createPendingDriver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('logs invalid Shopify session tokens with a sanitized reason', async () => {
    const { createPendingDriver, dependencies } = createDependencyHarness();
    dependencies.sessionTokenVerifier.verify = vi.fn(() => {
      throw new Error('Shopify session token audience mismatch');
    });
    const logLines: string[] = [];
    const app = await buildApp({
      adminDrivers: dependencies,
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) }
      }
    });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: driverInvitePayload(),
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid Shopify session token' }
      });
      expect(createPendingDriver).not.toHaveBeenCalled();
      expect(
        logLines.some((line) =>
          line.includes('shopify admin session token rejected') &&
          line.includes('shopify_admin_session_token_rejected') &&
          line.includes('admin_drivers') &&
          line.includes('audience_mismatch') &&
          !line.includes('session-token')
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('rejects invalid driver invite payloads', async () => {
    const { createPendingDriver, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { ...driverInvitePayload(), phone: '01089216198' },
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid driver payload' }
      });
      expect(createPendingDriver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('creates a pending driver invite for the token shop', async () => {
    const { createPendingDriver, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: driverInvitePayload(),
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { driver: pendingDriver }, error: null });
      expect(createPendingDriver).toHaveBeenCalledWith({
        createdBy: 'shopify-user-id',
        displayName: null,
        inviteLink: 'https://clever.delivery/driver/download',
        phone: '+821089216198',
        shopDomain: 'example.myshopify.com',
        source: 'clever-app-driver-invite'
      });
    } finally {
      await app.close();
    }
  });

  test('returns a clear schema-drift error when driver creation storage is not migrated', async () => {
    const { createPendingDriver, dependencies } = createDependencyHarness();
    createPendingDriver.mockRejectedValueOnce(Object.assign(new Error('missing column'), { code: 'P2022' }));
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: driverInvitePayload(),
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'DRIVER_SCHEMA_NOT_READY',
          message: 'Delivery driver storage schema is not up to date. Run the delivery API schema push and retry.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('lists drivers for the authenticated shop', async () => {
    const { dependencies, listDrivers } = createDependencyHarness();
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { drivers: [linkedDriver, pendingDriver] }, error: null });
      expect(listDrivers).toHaveBeenCalledWith({ shopDomain: 'example.myshopify.com' });
    } finally {
      await app.close();
    }
  });

  test('returns a clear schema-drift error when driver listing storage is not migrated', async () => {
    const { dependencies, listDrivers } = createDependencyHarness();
    listDrivers.mockRejectedValueOnce(Object.assign(new Error('missing column'), { code: 'P2022' }));
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/drivers'
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'DRIVER_SCHEMA_NOT_READY',
          message: 'Delivery driver storage schema is not up to date. Run the delivery API schema push and retry.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('deletes a driver for the authenticated shop', async () => {
    const { deleteDriver, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminDrivers: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/drivers/driver-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { driverId: 'driver-id' }, error: null });
      expect(deleteDriver).toHaveBeenCalledWith({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('logs driver deletion failures with driver and shop context', async () => {
    const { deleteDriver, dependencies } = createDependencyHarness();
    deleteDriver.mockRejectedValueOnce(new Error('missing driver'));
    const logLines: string[] = [];
    const app = await buildApp({
      adminDrivers: dependencies,
      logger: {
        level: 'error',
        stream: { write: (line: string) => logLines.push(line) }
      }
    });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/drivers/missing-driver-id'
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Driver not found' }
      });
      expect(
        logLines.some((line) =>
          line.includes('admin driver deletion failed') &&
          line.includes('missing-driver-id') &&
          line.includes('example.myshopify.com')
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  createPendingDriver: ReturnType<typeof vi.fn<AdminDriversDependencies['adminDriverService']['createPendingDriver']>>;
  deleteDriver: ReturnType<typeof vi.fn<AdminDriversDependencies['adminDriverService']['deleteDriver']>>;
  dependencies: AdminDriversDependencies;
  listDrivers: ReturnType<typeof vi.fn<AdminDriversDependencies['adminDriverService']['listDrivers']>>;
  regenerateInviteCode: ReturnType<typeof vi.fn<AdminDriversDependencies['adminDriverService']['regenerateInviteCode']>>;
} {
  const verify = vi.fn(() => ({
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const createPendingDriver = vi.fn<AdminDriversDependencies['adminDriverService']['createPendingDriver']>(() =>
    Promise.resolve(pendingDriver)
  );
  const listDrivers = vi.fn<AdminDriversDependencies['adminDriverService']['listDrivers']>(() =>
    Promise.resolve([linkedDriver, pendingDriver])
  );
  const deleteDriver = vi.fn<AdminDriversDependencies['adminDriverService']['deleteDriver']>((input) =>
    Promise.resolve(input.driverId)
  );
  const regenerateInviteCode = vi.fn<AdminDriversDependencies['adminDriverService']['regenerateInviteCode']>(() =>
    Promise.resolve(pendingDriver)
  );

  return {
    createPendingDriver,
    dependencies: {
      adminDriverService: {
        createPendingDriver,
        deleteDriver,
        listDrivers,
        regenerateInviteCode
      },
      sessionTokenVerifier: { verify }
    },
    deleteDriver,
    listDrivers,
    regenerateInviteCode
  };
}

function driverInvitePayload(): Record<string, unknown> {
  return {
    displayName: null,
    inviteLink: 'https://clever.delivery/driver/download',
    phone: '+821089216198',
    source: 'clever-app-driver-invite'
  };
}
