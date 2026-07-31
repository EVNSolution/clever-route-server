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
