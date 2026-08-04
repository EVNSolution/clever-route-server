import { describe, expect, test, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  PrismaDsvResourceService,
} from '../src/modules/dsv/dsv-resource.service.js';
import type { DsvResourceConflictError, DsvResourceNotFoundError } from '../src/modules/dsv/dsv-resource.service.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const driverId = '66666666-6666-4666-8666-666666666666';
const vehicleId = '77777777-7777-4777-8777-777777777777';

describe('PrismaDsvResourceService', () => {
  test('creates a driver profile through the parent composite relation', async () => {
    const driver = {
      displayName: '김도윤',
      dsvProfile: {
        age: 18,
        career: '미제공',
        gender: '미제공',
        score: '미제공',
        traits: [],
        zone: '미제공',
      },
      id: driverId,
      phone: '010-6000-0000',
    };
    const prisma = {
      driver: {
        create: vi.fn(() => Promise.resolve(driver)),
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    await expect(service.createDriver({
      age: 18,
      career: '미제공',
      gender: '미제공',
      name: '김도윤',
      phone: '010-6000-0000',
      score: '미제공',
      shopDomain: 'tomatonofood.com',
      traits: [],
      zone: '미제공',
    })).resolves.toMatchObject({ id: driverId, name: '김도윤' });

    expect(prisma.driver.create).toHaveBeenCalledWith({
      data: {
        displayName: '김도윤',
        dsvProfile: {
          create: {
            age: 18,
            career: '미제공',
            gender: '미제공',
            lookupName: '김도윤',
            score: '미제공',
            traits: [],
            zone: '미제공',
          },
        },
        phone: '010-6000-0000',
        shopId,
        status: 'ACTIVE',
      },
      include: { dsvProfile: true },
    });
  });

  test('creates a vehicle profile through the parent composite relation', async () => {
    const vehicle = {
      dsvProfile: { note: '', typeLabel: '미지정' },
      id: vehicleId,
      licensePlate: '21사 6101',
    };
    const prisma = {
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
      vehicle: {
        create: vi.fn(() => Promise.resolve(vehicle)),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    await expect(service.createVehicle({
      note: '',
      plate: '21사 6101',
      shopDomain: 'tomatonofood.com',
      type: '미지정',
    })).resolves.toMatchObject({ id: vehicleId, plate: '21사 6101' });

    expect(prisma.vehicle.create).toHaveBeenCalledWith({
      data: {
        dsvProfile: { create: { note: '', typeLabel: '미지정' } },
        label: '미지정',
        licensePlate: '21사 6101',
        shopId,
        status: 'ACTIVE',
        vehicleType: 'OTHER',
      },
      include: { dsvProfile: true },
    });
  });

  test('issues a shop signup link without requiring an existing driver', async () => {
    const transaction = {
      dsvDriverAccountSignupInvite: {
        create: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ id: 'invite-id' });
        }),
        updateMany: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    const result = await service.issueDriverSignupInvite({
      shopDomain: 'tomatonofood.com',
    });

    expect(result.signupUrl).toMatch(/^clever-driver:\/\/signup\?token=[A-Za-z0-9_-]{43}$/u);
    const revokeInput = transaction.dsvDriverAccountSignupInvite.updateMany.mock.calls[0]?.[0] as {
      data: { revokedAt: Date };
    };
    const createInput = transaction.dsvDriverAccountSignupInvite.create.mock.calls[0]?.[0] as {
      data: { expiresAt: Date; shopId: string; tokenHash: string };
    };
    expect(transaction.dsvDriverAccountSignupInvite.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: revokeInput.data.revokedAt },
      where: { consumedAt: null, driverId: null, revokedAt: null, shopId },
    });
    expect(transaction.dsvDriverAccountSignupInvite.create).toHaveBeenCalledWith({
      data: {
        expiresAt: createInput.data.expiresAt,
        shopId,
        tokenHash: createInput.data.tokenHash,
      },
    });
    expect(createInput.data.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.signupUrl).not.toContain(createInput.data.tokenHash);
  });

  test('revokes older signup links and stores only a hash for the exact DSV driver', async () => {
    const transaction = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ accountId: null, id: driverId })),
      },
      dsvDriverAccountSignupInvite: {
        create: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ id: 'invite-id' });
        }),
        updateMany: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    const result = await service.issueDriverSignupInvite({
      driverId,
      shopDomain: 'tomatonofood.com',
    });

    expect(result.signupUrl).toMatch(/^clever-driver:\/\/signup\?token=[A-Za-z0-9_-]{43}$/u);
    expect(transaction.driver.findFirst).toHaveBeenCalledWith({
      select: { accountId: true, id: true },
      where: {
        accountId: null,
        dsvProfile: { isNot: null },
        id: driverId,
        shopId,
        status: 'ACTIVE',
      },
    });
    const revokeInput = transaction.dsvDriverAccountSignupInvite.updateMany.mock.calls[0]?.[0] as {
      data: { revokedAt: Date };
    };
    const createInput = transaction.dsvDriverAccountSignupInvite.create.mock.calls[0]?.[0] as {
      data: { driverId: string; expiresAt: Date; shopId: string; tokenHash: string };
    };
    expect(revokeInput.data.revokedAt).toBeInstanceOf(Date);
    expect(createInput.data.expiresAt).toBeInstanceOf(Date);
    expect(createInput.data.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(transaction.dsvDriverAccountSignupInvite.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: revokeInput.data.revokedAt },
      where: { consumedAt: null, driverId, revokedAt: null },
    });
    expect(transaction.dsvDriverAccountSignupInvite.create).toHaveBeenCalledWith({
      data: {
        driverId,
        expiresAt: createInput.data.expiresAt,
        shopId,
        tokenHash: createInput.data.tokenHash,
      },
    });
    expect(result.signupUrl).not.toContain(createInput.data.tokenHash);
  });

  test('blocks assigning a driver or vehicle that already has a default assignment', async () => {
    const prisma = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ id: driverId })),
      },
      dsvVehicleDriverAssignment: {
        create: vi.fn(),
        findFirst: vi.fn()
          .mockResolvedValueOnce({ id: '88888888-8888-4888-8888-888888888888' })
          .mockResolvedValueOnce(null),
      },
      vehicle: {
        findFirst: vi.fn(() => Promise.resolve({ id: vehicleId })),
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    await expect(service.assignDriver({
      actor: 'operator',
      driverId,
      shopDomain: 'tomatonofood.com',
      vehicleId,
    })).rejects.toMatchObject({
      code: 'DRIVER_ASSIGNMENT_EXISTS',
    } satisfies Partial<DsvResourceConflictError>);

    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { dsvProfile: { isNot: null }, id: driverId, shopId, status: 'ACTIVE' },
    });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { dsvProfile: { isNot: null }, id: vehicleId, shopId, status: 'ACTIVE' },
    });
    expect(prisma.dsvVehicleDriverAssignment.findFirst).toHaveBeenNthCalledWith(1, {
      select: { id: true },
      where: { driverId, shopId },
    });
    expect(prisma.dsvVehicleDriverAssignment.findFirst).toHaveBeenNthCalledWith(2, {
      select: { id: true },
      where: { shopId, vehicleId },
    });
    expect(prisma.dsvVehicleDriverAssignment.create).not.toHaveBeenCalled();
  });

  test('blocks assigning a vehicle that already has a different default driver', async () => {
    const prisma = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ id: driverId })),
      },
      dsvVehicleDriverAssignment: {
        create: vi.fn(),
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: '88888888-8888-4888-8888-888888888888' }),
      },
      vehicle: {
        findFirst: vi.fn(() => Promise.resolve({ id: vehicleId })),
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    await expect(service.assignDriver({
      actor: 'operator',
      driverId,
      shopDomain: 'tomatonofood.com',
      vehicleId,
    })).rejects.toMatchObject({
      code: 'VEHICLE_ASSIGNMENT_EXISTS',
    } satisfies Partial<DsvResourceConflictError>);

    expect(prisma.dsvVehicleDriverAssignment.create).not.toHaveBeenCalled();
  });

  test('maps concurrent vehicle deletion during assignment create to not found', async () => {
    const prisma = {
      driver: {
        findFirst: vi.fn(() => Promise.resolve({ id: driverId })),
      },
      dsvVehicleDriverAssignment: {
        create: vi.fn(() => Promise.reject(new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
          clientVersion: 'test',
          code: 'P2003',
          meta: { field_name: 'dsv_vehicle_driver_assignments_vehicleId_shopId_fkey' },
        }))),
        findFirst: vi.fn(() => Promise.resolve(null)),
      },
      vehicle: {
        findFirst: vi.fn(() => Promise.resolve({ id: vehicleId })),
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: shopId })),
      },
    };
    const service = new PrismaDsvResourceService(prisma as never);

    await expect(service.assignDriver({
      actor: 'operator',
      driverId,
      shopDomain: 'tomatonofood.com',
      vehicleId,
    })).rejects.toMatchObject({
      resource: 'vehicle',
    } satisfies Partial<DsvResourceNotFoundError>);
  });
});
