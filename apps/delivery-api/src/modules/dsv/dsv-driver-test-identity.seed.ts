import type { PrismaClient } from '@prisma/client';

import { fingerprintResidentNumberFront } from './dsv-driver-identity.js';

export const APPROVED_DSV_DRIVER_TEST_IDENTITY = {
  approval: 'cc-240-yang-woojin-production-test-identity',
  driverId: '9e486f38-ecaf-4324-baa8-dad1d52eefbc',
  name: '양우진',
} as const;

export type DsvDriverTestIdentitySeedResult = {
  applied: boolean;
  driverId: string;
  name: string;
  status: 'DRY_RUN' | 'SEEDED' | 'UNCHANGED';
};

export async function seedDsvDriverTestIdentity(input: {
  apply: boolean;
  approval: string;
  driverId: string;
  expectedName: string;
  identitySecret: string;
  prisma: PrismaClient;
  residentNumberFront: string;
}): Promise<DsvDriverTestIdentitySeedResult> {
  assertApprovedTarget(input);

  const driver = await input.prisma.driver.findUnique({
    select: {
      accountId: true,
      displayName: true,
      dsvProfile: { select: { residentNumberFrontFingerprint: true } },
      id: true,
      phone: true,
      status: true,
    },
    where: { id: input.driverId },
  });
  if (driver === null) throw new Error('Approved DSV driver was not found');
  if (driver.displayName !== input.expectedName) throw new Error('Approved DSV driver name does not match');
  if (driver.status !== 'ACTIVE') throw new Error('Approved DSV driver is not active');
  if (driver.accountId !== null) throw new Error('Approved DSV driver is already linked to an account');
  if (driver.phone === null || driver.phone.trim() === '') {
    throw new Error('Approved DSV driver has no phone number');
  }
  if (driver.dsvProfile === null) throw new Error('Approved DSV driver has no DSV profile');

  const fingerprint = fingerprintResidentNumberFront(
    input.residentNumberFront,
    input.identitySecret,
  );
  const currentFingerprint = driver.dsvProfile.residentNumberFrontFingerprint;
  if (currentFingerprint !== null && currentFingerprint !== fingerprint) {
    throw new Error('Approved DSV driver already has a different identity fingerprint');
  }
  if (!input.apply) return result('DRY_RUN', false);
  if (currentFingerprint === fingerprint) return result('UNCHANGED', false);

  const update = await input.prisma.dsvDriverProfile.updateMany({
    data: { residentNumberFrontFingerprint: fingerprint },
    where: {
      driverId: input.driverId,
      residentNumberFrontFingerprint: null,
    },
  });
  if (update.count !== 1) {
    throw new Error('Approved DSV driver identity changed concurrently; no update was applied');
  }
  return result('SEEDED', true);

  function result(
    status: DsvDriverTestIdentitySeedResult['status'],
    applied: boolean,
  ): DsvDriverTestIdentitySeedResult {
    return {
      applied,
      driverId: input.driverId,
      name: input.expectedName,
      status,
    };
  }
}

function assertApprovedTarget(input: {
  approval: string;
  driverId: string;
  expectedName: string;
}): void {
  if (input.approval !== APPROVED_DSV_DRIVER_TEST_IDENTITY.approval) {
    throw new Error('Production test identity approval token does not match');
  }
  if (input.driverId !== APPROVED_DSV_DRIVER_TEST_IDENTITY.driverId) {
    throw new Error('Production test identity driver ID is not approved');
  }
  if (input.expectedName !== APPROVED_DSV_DRIVER_TEST_IDENTITY.name) {
    throw new Error('Production test identity driver name is not approved');
  }
}
