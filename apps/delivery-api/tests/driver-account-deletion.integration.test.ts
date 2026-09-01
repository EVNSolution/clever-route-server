import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  DriverAccountDeletionProcessingError,
  PrismaDriverAccountDeletionService,
} from '../src/modules/driver/driver-account-deletion.service.js';
import { PrismaDriverSelfServiceRepository } from '../src/modules/driver/driver-self-service.repository.js';

const databaseUrl = process.env.DRIVER_ACCOUNT_DELETION_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const now = new Date('2026-09-01T08:00:00.000Z');
const accountId = '81000000-0000-4000-8000-000000000001';
const driverId = '82000000-0000-4000-8000-000000000001';
const shopId = '83000000-0000-4000-8000-000000000001';
const routePlanId = '84000000-0000-4000-8000-000000000001';
const raceAccountId = '81000000-0000-4000-8000-000000000002';
const raceDriverId = '82000000-0000-4000-8000-000000000002';
const raceShopId = '83000000-0000-4000-8000-000000000002';

describe('driver account deletion PostgreSQL contract', () => {
  live('fulfills one synthetic verified request transactionally and idempotently', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let markClaimReached: () => void = () => undefined;
    const claimReached = new Promise<void>((resolve) => { markClaimReached = resolve; });
    let releaseFulfillment: () => void = () => undefined;
    const fulfillmentReleased = new Promise<void>((resolve) => { releaseFulfillment = resolve; });
    const service = new PrismaDriverAccountDeletionService(prisma, {
      afterClaim: async () => {
        markClaimReached();
        await fulfillmentReleased;
      },
      now: () => now,
      processingKey: () => '85000000-0000-4000-8000-000000000001',
    });

    try {
      await seedSyntheticAccount(prisma);

      await expect(service.requestVerifiedExternal({
        accountId,
        processedBy: 'cc-274-fixture',
        verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
      })).resolves.toMatchObject({ duplicate: false, status: 'REQUESTED' });

      const request = await prisma.driverAccountDeletionRequest.findUniqueOrThrow({ where: { accountId } });
      await expect(service.requestVerifiedExternal({
        accountId,
        processedBy: 'cc-274-fixture',
        verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
      })).resolves.toEqual({ duplicate: true, requestId: request.id, status: 'REQUESTED' });

      const fulfillment = service.fulfill({
        processedBy: 'cc-274-fixture',
        requestId: request.id,
      });
      await claimReached;
      try {
        await expect(service.reject({
          processedBy: 'cc-274-review',
          reasonCode: 'IDENTITY_NOT_VERIFIED',
          requestId: request.id,
        })).rejects.toBeInstanceOf(DriverAccountDeletionProcessingError);
        expect(await prisma.driverAccountDeletionRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
          processingKey: '85000000-0000-4000-8000-000000000001',
          status: 'PROCESSING',
        });
      } finally {
        releaseFulfillment();
      }

      await expect(fulfillment).resolves.toMatchObject({
        counts: {
          accountSessionsRevoked: 1,
          consentDeviceContextsCleared: 1,
          driverFeedbackNotesRedacted: 1,
          driverSessionsRevoked: 1,
          driversAnonymized: 1,
          pushTokensDeleted: 1,
          signupInvitesRevoked: 1,
        },
        duplicate: false,
        status: 'COMPLETED',
      });

      expect(await prisma.driverAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({
        failedPasswordAttempts: 0,
        failedPinAttempts: 0,
        loginId: null,
        name: null,
        passwordHash: null,
        passwordSalt: null,
        phone: `deleted:${accountId}`,
        pinHash: null,
        pinSalt: null,
        residentNumberFrontFingerprint: null,
        status: 'INACTIVE',
        tokenVersion: 8,
      });
      expect(await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).toMatchObject({
        authSubject: null,
        displayName: 'Deleted driver',
        inviteCode: null,
        phone: null,
        status: 'INACTIVE',
        tokenVersion: 4,
        tokensInvalidatedAt: now,
      });
      expect(await prisma.driverAccountSession.count({ where: { accountId, revokedAt: now } })).toBe(1);
      expect(await prisma.driverSession.count({ where: { driverId, revokedAt: now } })).toBe(1);
      expect(await prisma.driverPushToken.count({ where: { accountId } })).toBe(0);
      expect(await prisma.dsvDriverAccountSignupInvite.count({ where: { driverId, revokedAt: now } })).toBe(1);
      expect(await prisma.driverConsentRecord.findFirstOrThrow({ where: { accountId } })).toMatchObject({ deviceContext: null });
      expect(await prisma.driverRouteFeedback.findFirstOrThrow({ where: { driverId } })).toMatchObject({
        reviewNote: '[redacted after account deletion]',
      });
      expect(await prisma.routePlan.count({ where: { id: routePlanId, status: 'COMPLETED' } })).toBe(1);
      expect(await prisma.driverAccountDeletionRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
        attemptCount: 1,
        driverDisplayName: null,
        driverPhone: null,
        failureCode: null,
        processedAt: now,
        processedBy: 'cc-274-fixture',
        processingKey: null,
        reason: null,
        rejectionCode: null,
        requestChannel: 'EXTERNAL_SUPPORT',
        requestedBy: 'cc-274-fixture',
        shopDomain: null,
        status: 'COMPLETED',
        verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
      });

      await expect(service.fulfill({
        processedBy: 'cc-274-fixture',
        requestId: request.id,
      })).resolves.toEqual({ duplicate: true, requestId: request.id, status: 'COMPLETED' });
    } finally {
      await prisma.driverAccountDeletionRequest.deleteMany({ where: { accountId } });
      await prisma.shop.deleteMany({ where: { id: shopId } });
      await prisma.driverAccount.deleteMany({ where: { id: accountId } });
      await prisma.$disconnect();
    }
  });

  live('converges a legacy intake that races an account link on one account-level request', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const repository = new PrismaDriverSelfServiceRepository(prisma);
    let releaseLink: () => void = () => undefined;
    const linkReleased = new Promise<void>((resolve) => { releaseLink = resolve; });
    let markLinkUpdated: () => void = () => undefined;
    const linkUpdated = new Promise<void>((resolve) => { markLinkUpdated = resolve; });
    let linking: Promise<void> | null = null;

    try {
      await prisma.driverAccount.create({
        data: { id: raceAccountId, phone: '+10000000002' },
      });
      await prisma.shop.create({ data: { id: raceShopId, shopDomain: 'cc-274-race.invalid' } });
      await prisma.driver.create({
        data: {
          displayName: 'Synthetic Race Driver',
          id: raceDriverId,
          phone: '+10000000002',
          shopId: raceShopId,
        },
      });

      linking = prisma.$transaction(async (tx) => {
        await tx.driver.update({
          data: { accountId: raceAccountId, authSubject: `driver-${raceDriverId}` },
          where: { id: raceDriverId },
        });
        markLinkUpdated();
        await linkReleased;
      });
      await linkUpdated;

      const legacyIntake = repository.requestAccountDeletion({
        driverId: raceDriverId,
        reason: null,
        requestedAt: now,
        shopDomain: 'cc-274-race.invalid',
        shopId: raceShopId,
      });
      const releaseTimer = setTimeout(releaseLink, 100);
      const legacyResult = await legacyIntake;
      clearTimeout(releaseTimer);
      releaseLink();
      await linking;

      expect(legacyResult).toMatchObject({ duplicate: false, status: 'REQUESTED' });
      await expect(repository.requestGlobalAccountDeletion({
        accountId: raceAccountId,
        reason: null,
        requestedAt: now,
        tokenVersion: 0,
      })).resolves.toEqual({
        duplicate: true,
        requestId: legacyResult.requestId,
        status: 'REQUESTED',
      });
      expect(await prisma.driverAccountDeletionRequest.findMany({
        where: { OR: [{ accountId: raceAccountId }, { driverId: raceDriverId }] },
      })).toEqual([
        expect.objectContaining({
          accountId: raceAccountId,
          driverId: null,
          id: legacyResult.requestId,
        }),
      ]);
    } finally {
      releaseLink();
      await linking?.catch(() => undefined);
      await prisma.driverAccountDeletionRequest.deleteMany({
        where: { OR: [{ accountId: raceAccountId }, { driverId: raceDriverId }] },
      });
      await prisma.driver.deleteMany({ where: { id: raceDriverId } });
      await prisma.shop.deleteMany({ where: { id: raceShopId } });
      await prisma.driverAccount.deleteMany({ where: { id: raceAccountId } });
      await prisma.$disconnect();
    }
  });
});

async function seedSyntheticAccount(prisma: PrismaClient): Promise<void> {
  await prisma.driverAccount.create({
    data: {
      failedPasswordAttempts: 2,
      failedPinAttempts: 3,
      id: accountId,
      loginId: 'synthetic-delete-login',
      name: 'Synthetic Delete Fixture',
      passwordHash: 'synthetic-password-hash',
      passwordSalt: 'synthetic-password-salt',
      phone: '+10000000001',
      pinHash: 'synthetic-pin-hash',
      pinSalt: 'synthetic-pin-salt',
      residentNumberFrontFingerprint: 'synthetic-fingerprint',
      tokenVersion: 7,
    },
  });
  await prisma.shop.create({ data: { id: shopId, shopDomain: 'cc-274-fixture.invalid' } });
  await prisma.driver.create({
    data: {
      accountId,
      authSubject: 'synthetic-delete-subject',
      displayName: 'Synthetic Driver',
      id: driverId,
      inviteCode: 'SYNTHETIC-DELETE',
      phone: '+10000000001',
      shopId,
      tokenVersion: 3,
    },
  });
  await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId,
      id: routePlanId,
      metrics: {},
      name: 'Synthetic completed route',
      optimizerVersion: 'fixture',
      planDate: now,
      shopId,
      status: 'COMPLETED',
    },
  });
  await prisma.driverAccountSession.create({
    data: {
      accountId,
      expiresAt: new Date('2026-10-01T08:00:00.000Z'),
      refreshTokenHash: 'synthetic-account-refresh-hash',
    },
  });
  await prisma.driverSession.create({
    data: {
      driverId,
      expiresAt: new Date('2026-10-01T08:00:00.000Z'),
      refreshTokenHash: 'synthetic-driver-refresh-hash',
    },
  });
  await prisma.driverPushToken.create({
    data: {
      accountId,
      appId: 'clever-routes',
      deviceId: 'synthetic-device',
      devicePushToken: 'synthetic-push-token',
      platform: 'android',
      tokenHash: 'synthetic-push-token-hash',
    },
  });
  await prisma.dsvDriverAccountSignupInvite.create({
    data: {
      driverId,
      expiresAt: new Date('2026-10-01T08:00:00.000Z'),
      shopId,
      tokenHash: 'synthetic-signup-token-hash',
    },
  });
  await prisma.driverConsentRecord.create({
    data: {
      accepted: true,
      accountId,
      consentType: 'PERSONAL_INFORMATION',
      consentVersion: 'cc-274-fixture',
      deviceContext: { deviceId: 'synthetic-device', platform: 'android' },
      driverId,
      recordedAt: now,
      shopId,
    },
  });
  await prisma.driverRouteFeedback.create({
    data: {
      driverId,
      reviewNote: 'synthetic private feedback',
      routePlanId,
      shopId,
      submittedAt: now,
    },
  });
}

function assertDisposableDatabase(): void {
  const url = new URL(databaseUrl);
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.port).toBe('55490');
  expect(url.pathname).toBe('/clever_g006');
  expect(process.env.G006_DATABASE_TARGET_CLASS).toBe('safe-local-g006-disposable');
}
