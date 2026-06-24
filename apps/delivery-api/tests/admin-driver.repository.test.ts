import { describe, expect, test, vi } from 'vitest';

import { PrismaAdminDriverRepository } from '../src/modules/driver/admin-driver.repository.js';

const anyDateMatcher: unknown = expect.any(Date);
const anyStringMatcher: unknown = expect.any(String);
const sixHexCodeMatcher: unknown = expect.stringMatching(/^[0-9A-F]{6}$/u);

describe('PrismaAdminDriverRepository', () => {
  test('upserts the shop and creates a pending invite driver', async () => {
    const { prisma } = createPrismaHarness({ existingDriver: null });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const driver = await repository.createPendingDriver({
      displayName: null,
      phone: '+821089216198',
      shopDomain: 'Example.myshopify.com'
    });

    expect(prisma.shop.upsert).toHaveBeenCalledWith({
      create: { appId: 'clever', shopDomain: 'example.myshopify.com' },
      update: {},
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } }
    });
    expect(prisma.driver.create).toHaveBeenCalledWith({
      data: {
        authSubject: null,
        displayName: '+821089216198',
        inviteCode: sixHexCodeMatcher,
        inviteCodeExpiresAt: anyDateMatcher,
        phone: '+821089216198',
        shopId: 'shop-id',
        status: 'ACTIVE'
      },
      include: { _count: { select: { driverEvents: true } } }
    });
    expect(driver).toEqual(
      expect.objectContaining({
        authStatus: 'INVITE_PENDING',
        authSubject: null,
        displayName: '+821089216198',
        inviteCode: anyStringMatcher,
        inviteCodeExpiresAt: anyStringMatcher,
        phone: '+821089216198',
        recentEventsCount: 0,
        status: 'PENDING'
      })
    );
  });

  test('accepts WooCommerce customer domains for server-owned driver management', async () => {
    const { prisma } = createPrismaHarness({ existingDriver: null });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    await repository.createPendingDriver({
      displayName: 'Alex Driver',
      phone: '+14165550123',
      shopDomain: 'https://Dev1.TomatonoFood.com/wp-admin/'
    });

    expect(prisma.shop.upsert).toHaveBeenCalledWith({
      create: { appId: 'clever', shopDomain: 'dev1.tomatonofood.com' },
      update: {},
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'dev1.tomatonofood.com' } }
    });
  });

  test('updates an existing shop driver with the same phone without creating a duplicate', async () => {
    const existingDriver = driverRecord({ displayName: '+821089216198', id: 'existing-driver-id' });
    const updatedDriver = driverRecord({ displayName: 'Minji Kim', id: 'existing-driver-id' });
    const { prisma } = createPrismaHarness({ existingDriver, updatedDriver });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const driver = await repository.createPendingDriver({
      displayName: 'Minji Kim',
      phone: '+821089216198',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.driver.create).not.toHaveBeenCalled();
    expect(prisma.driver.update).toHaveBeenCalledWith({
      data: {
        displayName: 'Minji Kim',
        inviteCode: sixHexCodeMatcher,
        inviteCodeExpiresAt: anyDateMatcher,
        phone: '+821089216198'
      },
      include: { _count: { select: { driverEvents: true } } },
      where: { id: 'existing-driver-id' }
    });
    expect(driver.id).toBe('existing-driver-id');
    expect(driver.displayName).toBe('Minji Kim');
    expect(driver.authStatus).toBe('INVITE_PENDING');
  });

  test('regenerates an invite code only for the authenticated shop driver', async () => {
    const regeneratedDriver = driverRecord({ id: 'driver-id', inviteCode: 'ABC123' });
    const { prisma } = createPrismaHarness({ updatedDriver: regeneratedDriver });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const driver = await repository.regenerateInviteCode({
      driverId: 'driver-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } }
    });
    expect(prisma.driver.update).toHaveBeenCalledWith({
      data: {
        authSubject: null,
        inviteCode: sixHexCodeMatcher,
        inviteCodeExpiresAt: anyDateMatcher,
        tokensInvalidatedAt: anyDateMatcher,
        tokenVersion: { increment: 1 }
      },
      include: { _count: { select: { driverEvents: true } } },
      where: { id: 'driver-id', shopId: 'shop-id' }
    });
    expect(prisma.driverSession.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: anyDateMatcher },
      where: { driverId: 'driver-id', revokedAt: null }
    });
    expect(driver).toEqual(expect.objectContaining({
      authStatus: 'INVITE_PENDING',
      id: 'driver-id',
      inviteCode: 'ABC123',
      inviteCodeExpiresAt: '2026-05-12T02:00:00.000Z',
      status: 'PENDING'
    }));
  });

  test('lists only drivers for the requested shop and masks linked auth subjects', async () => {
    const { prisma } = createPrismaHarness({
      listDrivers: [
        driverRecord({
          authSubject: 'driver-auth-subject',
          displayName: 'Minji Kim',
          id: 'linked-driver-id',
          lastSeenAt: new Date('2026-05-11T01:59:00.000Z'),
          phone: '+14165550108',
          recentEventsCount: 4
        }),
        driverRecord({ id: 'pending-driver-id' })
      ]
    });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const drivers = await repository.listDrivers({ shopDomain: 'example.myshopify.com' });

    expect(prisma.driver.findMany).toHaveBeenCalledWith({
      include: { _count: { select: { driverEvents: true } } },
      orderBy: [{ createdAt: 'desc' }, { displayName: 'asc' }],
      where: { shopId: 'shop-id' }
    });
    expect(drivers).toEqual([
      expect.objectContaining({
        authStatus: 'APP_LINKED',
        authSubject: 'present',
        id: 'linked-driver-id',
        recentEventsCount: 4,
        status: 'ACTIVE'
      }),
      expect.objectContaining({
        authStatus: 'INVITE_PENDING',
        authSubject: null,
        id: 'pending-driver-id',
        recentEventsCount: 0,
        status: 'PENDING'
      })
    ]);
  });

  test('returns an empty list when the requested shop is not installed', async () => {
    const { prisma } = createPrismaHarness({ shop: null });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const drivers = await repository.listDrivers({ shopDomain: 'missing.myshopify.com' });

    expect(drivers).toEqual([]);
    expect(prisma.driver.findMany).not.toHaveBeenCalled();
  });

  test('deletes only the authenticated shop driver', async () => {
    const { prisma } = createPrismaHarness({ deletedDriver: { id: 'driver-id' } });
    const repository = new PrismaAdminDriverRepository(prisma as never);

    const driverId = await repository.deleteDriver({
      driverId: 'driver-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } }
    });
    expect(prisma.driver.delete).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'driver-id', shopId: 'shop-id' }
    });
    expect(driverId).toBe('driver-id');
  });
});

function createPrismaHarness(input: {
  deletedDriver?: { id: string };
  existingDriver?: ReturnType<typeof driverRecord> | null;
  listDrivers?: ReturnType<typeof driverRecord>[];
  shop?: { id: string } | null;
  updatedDriver?: ReturnType<typeof driverRecord>;
} = {}): {
  prisma: {
    driver: {
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    driverSession: {
      updateMany: ReturnType<typeof vi.fn>;
    };
    shop: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };
} {
  const shop = input.shop === undefined ? { id: 'shop-id' } : input.shop;
  const createdDriver = driverRecord();
  return {
    prisma: {
      driver: {
        create: vi.fn(() => Promise.resolve(createdDriver)),
        delete: vi.fn(() => Promise.resolve(input.deletedDriver ?? { id: 'driver-id' })),
        findFirst: vi.fn(() => Promise.resolve(input.existingDriver ?? null)),
        findMany: vi.fn(() => Promise.resolve(input.listDrivers ?? [])),
        update: vi.fn(() => Promise.resolve(input.updatedDriver ?? input.existingDriver ?? createdDriver))
      },
      driverSession: {
        updateMany: vi.fn(() => Promise.resolve({ count: 0 }))
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve(shop)),
        upsert: vi.fn(() => Promise.resolve(shop ?? { id: 'shop-id' }))
      }
    }
  };
}

function driverRecord(overrides: Partial<{
  authSubject: string | null;
  createdAt: Date;
  displayName: string;
  id: string;
  lastSeenAt: Date | null;
  phone: string | null;
  recentEventsCount: number;
  inviteCode: string | null;
  inviteCodeExpiresAt: Date | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tokenVersion: number;
  tokensInvalidatedAt: Date | null;
  updatedAt: Date;
}> = {}): {
  _count: { driverEvents: number };
  authSubject: string | null;
  createdAt: Date;
  displayName: string;
  id: string;
  inviteCode: string | null;
  inviteCodeExpiresAt: Date | null;
  lastSeenAt: Date | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tokenVersion: number;
  tokensInvalidatedAt: Date | null;
  updatedAt: Date;
} {
  return {
    _count: { driverEvents: overrides.recentEventsCount ?? 0 },
    authSubject: overrides.authSubject ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-05-11T02:00:00.000Z'),
    displayName: overrides.displayName ?? '+821089216198',
    id: overrides.id ?? 'driver-id',
    inviteCode: overrides.inviteCode ?? 'ABCDEF',
    inviteCodeExpiresAt: overrides.inviteCodeExpiresAt ?? new Date('2026-05-12T02:00:00.000Z'),
    lastSeenAt: overrides.lastSeenAt ?? null,
    phone: overrides.phone ?? '+821089216198',
    status: overrides.status ?? 'ACTIVE',
    tokenVersion: overrides.tokenVersion ?? 0,
    tokensInvalidatedAt: overrides.tokensInvalidatedAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date('2026-05-11T02:00:00.000Z')
  };
}
