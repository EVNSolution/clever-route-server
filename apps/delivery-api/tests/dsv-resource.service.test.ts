import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDsvResourceService,
} from '../src/modules/dsv/dsv-resource.service.js';
import type { DsvResourceConflictError } from '../src/modules/dsv/dsv-resource.service.js';

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
        findFirst: vi.fn(() => Promise.resolve({ id: '88888888-8888-4888-8888-888888888888' })),
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
      code: 'ASSIGNMENT_EXISTS',
    } satisfies Partial<DsvResourceConflictError>);

    expect(prisma.dsvVehicleDriverAssignment.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        OR: [{ driverId }, { vehicleId }],
        shopId,
      },
    });
    expect(prisma.dsvVehicleDriverAssignment.create).not.toHaveBeenCalled();
  });
});
