import { Prisma, type PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export type DsvDriverInput = {
  age: number;
  career: string;
  gender: string;
  name: string;
  score: string;
  traits: string[];
  zone: string;
};

export type DsvDriverView = DsvDriverInput & { id: string };

export type DsvVehicleInput = {
  note: string;
  plate: string;
  type: string;
};

export type DsvVehicleView = DsvVehicleInput & { id: string };

export type DsvVehicleDriverAssignmentView = {
  driverId: string;
  id: string;
  kind: '기본 배정';
  vehicleId: string;
};

export type DsvResourceSnapshot = {
  assignments: DsvVehicleDriverAssignmentView[];
  drivers: DsvDriverView[];
  vehicles: DsvVehicleView[];
};

export type DsvResourceService = {
  assignDriver(input: { actor: string; driverId: string; shopDomain: string; vehicleId: string }): Promise<DsvVehicleDriverAssignmentView>;
  createDriver(input: DsvDriverInput & { shopDomain: string }): Promise<DsvDriverView>;
  createVehicle(input: DsvVehicleInput & { shopDomain: string }): Promise<DsvVehicleView>;
  deleteDriver(input: { driverId: string; shopDomain: string }): Promise<void>;
  deleteVehicle(input: { shopDomain: string; vehicleId: string }): Promise<void>;
  list(input: { shopDomain: string }): Promise<DsvResourceSnapshot | null>;
  unassignDriver(input: { assignmentId: string; shopDomain: string; vehicleId: string }): Promise<void>;
  updateDriver(input: DsvDriverInput & { driverId: string; shopDomain: string }): Promise<DsvDriverView>;
  updateVehicle(input: DsvVehicleInput & { shopDomain: string; vehicleId: string }): Promise<DsvVehicleView>;
};

export class DsvResourceNotFoundError extends Error {
  constructor(readonly resource: 'assignment' | 'driver' | 'shop' | 'vehicle') {
    super(`${resource} not found`);
    this.name = 'DsvResourceNotFoundError';
  }
}

export class DsvResourceConflictError extends Error {
  constructor(readonly code: 'ASSIGNMENT_EXISTS' | 'DRIVER_NAME_EXISTS' | 'VEHICLE_PLATE_EXISTS') {
    super({
      ASSIGNMENT_EXISTS: '이미 기본 배정된 차량 또는 배송원입니다.',
      DRIVER_NAME_EXISTS: '같은 이름의 배송원이 이미 등록되어 있습니다.',
      VEHICLE_PLATE_EXISTS: '같은 차량 번호가 이미 등록되어 있습니다.',
    }[code]);
    this.name = 'DsvResourceConflictError';
  }
}

export class PrismaDsvResourceService implements DsvResourceService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(input: { shopDomain: string }): Promise<DsvResourceSnapshot | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const [drivers, vehicles, assignments] = await Promise.all([
      this.prisma.driver.findMany({
        include: { dsvProfile: true },
        orderBy: [{ displayName: 'asc' }],
        where: { dsvProfile: { isNot: null }, shopId: shop.id },
      }),
      this.prisma.vehicle.findMany({
        include: { dsvProfile: true },
        orderBy: [{ licensePlate: 'asc' }],
        where: { dsvProfile: { isNot: null }, shopId: shop.id },
      }),
      this.prisma.dsvVehicleDriverAssignment.findMany({
        orderBy: [{ createdAt: 'asc' }],
        where: { shopId: shop.id },
      }),
    ]);
    return {
      assignments: assignments.map(assignmentView),
      drivers: drivers.flatMap((driver) => driver.dsvProfile === null ? [] : [driverView(driver, driver.dsvProfile)]),
      vehicles: vehicles.flatMap((vehicle) => vehicle.dsvProfile === null ? [] : [vehicleView(vehicle, vehicle.dsvProfile)]),
    };
  }

  async createDriver(input: DsvDriverInput & { shopDomain: string }): Promise<DsvDriverView> {
    const shop = await this.requireShop(input.shopDomain);
    try {
      const driver = await this.prisma.driver.create({
        data: {
          displayName: input.name,
          dsvProfile: { create: { ...driverProfileData(input), lookupName: input.name } },
          shopId: shop.id,
          status: 'ACTIVE',
        },
        include: { dsvProfile: true },
      });
      return driverView(driver, driver.dsvProfile!);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvResourceConflictError('DRIVER_NAME_EXISTS');
      throw error;
    }
  }

  async updateDriver(input: DsvDriverInput & { driverId: string; shopDomain: string }): Promise<DsvDriverView> {
    const shop = await this.requireShop(input.shopDomain);
    try {
      const driver = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.dsvDriverProfile.findFirst({ where: { driverId: input.driverId, shopId: shop.id } });
        if (profile === null) throw new DsvResourceNotFoundError('driver');
        await tx.driver.update({ data: { displayName: input.name }, where: { id: input.driverId, shopId: shop.id } });
        await tx.dsvDriverProfile.update({
          data: { ...driverProfileData(input), lookupName: input.name },
          where: { driverId: input.driverId },
        });
        return tx.driver.findUniqueOrThrow({ include: { dsvProfile: true }, where: { id: input.driverId } });
      });
      return driverView(driver, driver.dsvProfile!);
    } catch (error) {
      if (error instanceof DsvResourceNotFoundError) throw error;
      if (isNotFound(error)) throw new DsvResourceNotFoundError('driver');
      if (isUniqueConflict(error)) throw new DsvResourceConflictError('DRIVER_NAME_EXISTS');
      throw error;
    }
  }

  async deleteDriver(input: { driverId: string; shopDomain: string }): Promise<void> {
    const shop = await this.requireShop(input.shopDomain);
    const result = await this.prisma.driver.deleteMany({ where: { dsvProfile: { isNot: null }, id: input.driverId, shopId: shop.id } });
    if (result.count === 0) throw new DsvResourceNotFoundError('driver');
  }

  async createVehicle(input: DsvVehicleInput & { shopDomain: string }): Promise<DsvVehicleView> {
    const shop = await this.requireShop(input.shopDomain);
    try {
      const vehicle = await this.prisma.vehicle.create({
        data: {
          dsvProfile: { create: { note: input.note, typeLabel: input.type } },
          label: input.type,
          licensePlate: input.plate,
          shopId: shop.id,
          status: 'ACTIVE',
          vehicleType: vehicleType(input.type),
        },
        include: { dsvProfile: true },
      });
      return vehicleView(vehicle, vehicle.dsvProfile!);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvResourceConflictError('VEHICLE_PLATE_EXISTS');
      throw error;
    }
  }

  async updateVehicle(input: DsvVehicleInput & { shopDomain: string; vehicleId: string }): Promise<DsvVehicleView> {
    const shop = await this.requireShop(input.shopDomain);
    try {
      const vehicle = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.dsvVehicleProfile.findFirst({ where: { shopId: shop.id, vehicleId: input.vehicleId } });
        if (profile === null) throw new DsvResourceNotFoundError('vehicle');
        await tx.vehicle.update({
          data: { label: input.type, licensePlate: input.plate, vehicleType: vehicleType(input.type) },
          where: { id: input.vehicleId, shopId: shop.id },
        });
        await tx.dsvVehicleProfile.update({
          data: { note: input.note, typeLabel: input.type },
          where: { vehicleId: input.vehicleId },
        });
        return tx.vehicle.findUniqueOrThrow({ include: { dsvProfile: true }, where: { id: input.vehicleId } });
      });
      return vehicleView(vehicle, vehicle.dsvProfile!);
    } catch (error) {
      if (error instanceof DsvResourceNotFoundError) throw error;
      if (isNotFound(error)) throw new DsvResourceNotFoundError('vehicle');
      if (isUniqueConflict(error)) throw new DsvResourceConflictError('VEHICLE_PLATE_EXISTS');
      throw error;
    }
  }

  async deleteVehicle(input: { shopDomain: string; vehicleId: string }): Promise<void> {
    const shop = await this.requireShop(input.shopDomain);
    const result = await this.prisma.vehicle.deleteMany({ where: { dsvProfile: { isNot: null }, id: input.vehicleId, shopId: shop.id } });
    if (result.count === 0) throw new DsvResourceNotFoundError('vehicle');
  }

  async assignDriver(input: {
    actor: string;
    driverId: string;
    shopDomain: string;
    vehicleId: string;
  }): Promise<DsvVehicleDriverAssignmentView> {
    const shop = await this.requireShop(input.shopDomain);
    const [driver, vehicle, existingAssignment] = await Promise.all([
      this.prisma.driver.findFirst({ select: { id: true }, where: { id: input.driverId, shopId: shop.id } }),
      this.prisma.vehicle.findFirst({ select: { id: true }, where: { id: input.vehicleId, shopId: shop.id } }),
      this.prisma.dsvVehicleDriverAssignment.findFirst({
        select: { id: true },
        where: {
          OR: [{ driverId: input.driverId }, { vehicleId: input.vehicleId }],
          shopId: shop.id,
        },
      }),
    ]);
    if (driver === null) throw new DsvResourceNotFoundError('driver');
    if (vehicle === null) throw new DsvResourceNotFoundError('vehicle');
    if (existingAssignment !== null) throw new DsvResourceConflictError('ASSIGNMENT_EXISTS');
    try {
      return assignmentView(await this.prisma.dsvVehicleDriverAssignment.create({
        data: { createdBy: input.actor, driverId: input.driverId, shopId: shop.id, vehicleId: input.vehicleId },
      }));
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvResourceConflictError('ASSIGNMENT_EXISTS');
      throw error;
    }
  }

  async unassignDriver(input: { assignmentId: string; shopDomain: string; vehicleId: string }): Promise<void> {
    const shop = await this.requireShop(input.shopDomain);
    const result = await this.prisma.dsvVehicleDriverAssignment.deleteMany({
      where: { id: input.assignmentId, shopId: shop.id, vehicleId: input.vehicleId },
    });
    if (result.count === 0) throw new DsvResourceNotFoundError('assignment');
  }

  private findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ shopDomain }) });
  }

  private async requireShop(shopDomain: string): Promise<{ id: string }> {
    const shop = await this.findShop(shopDomain);
    if (shop === null) throw new DsvResourceNotFoundError('shop');
    return shop;
  }
}

function driverProfileData(input: DsvDriverInput) {
  return {
    age: input.age,
    career: input.career,
    gender: input.gender,
    score: input.score,
    traits: input.traits,
    zone: input.zone,
  };
}

function driverView(
  driver: { displayName: string; id: string },
  profile: { age: number; career: string; gender: string; score: string; traits: string[]; zone: string },
): DsvDriverView {
  return {
    age: profile.age,
    career: profile.career,
    gender: profile.gender,
    id: driver.id,
    name: driver.displayName,
    score: profile.score,
    traits: profile.traits,
    zone: profile.zone,
  };
}

function vehicleView(
  vehicle: { id: string; licensePlate: string | null },
  profile: { note: string; typeLabel: string },
): DsvVehicleView {
  return { id: vehicle.id, note: profile.note, plate: vehicle.licensePlate ?? '', type: profile.typeLabel };
}

function assignmentView(assignment: { driverId: string; id: string; vehicleId: string }): DsvVehicleDriverAssignmentView {
  return { driverId: assignment.driverId, id: assignment.id, kind: '기본 배정', vehicleId: assignment.vehicleId };
}

function vehicleType(type: string): 'BIKE' | 'CAR' | 'OTHER' | 'SCOOTER' | 'TRUCK' | 'VAN' {
  const normalized = type.toLowerCase();
  if (/스쿠터|scooter/u.test(normalized)) return 'SCOOTER';
  if (/오토바이|이륜|bike/u.test(normalized)) return 'BIKE';
  if (/승합|van/u.test(normalized)) return 'VAN';
  if (/승용|car/u.test(normalized)) return 'CAR';
  if (/탑차|윙바디|트럭|화물|truck/u.test(normalized)) return 'TRUCK';
  return 'OTHER';
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
