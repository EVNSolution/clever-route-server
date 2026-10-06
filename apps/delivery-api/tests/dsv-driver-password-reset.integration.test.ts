import { createHash, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  PrismaDsvDriverPasswordResetService,
} from '../src/modules/dsv/dsv-driver-password-reset.service.js';
import { lockDsvDriverAccount } from '../src/modules/dsv/dsv-driver-account-lock.js';
import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

const databaseUrl = process.env.DRIVER_PASSWORD_RESET_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const shopId = '91000000-0000-4000-8000-000000000001';
const accountId = '92000000-0000-4000-8000-000000000001';
const driverId = '93000000-0000-4000-8000-000000000001';
const vehicleId = '94000000-0000-4000-8000-000000000001';
const assignmentId = '95000000-0000-4000-8000-000000000001';
const routePlanId = '96000000-0000-4000-8000-000000000001';
const actorId = '97000000-0000-4000-8000-000000000001';
const eligibilityShopId = '91000000-0000-4000-8000-000000000002';
const movedShopId = '91000000-0000-4000-8000-000000000003';
const eligibilityAccountId = '92000000-0000-4000-8000-000000000002';
const eligibilityDriverId = '93000000-0000-4000-8000-000000000002';
const oldPassword = 'CurrentStrongPassw0rd!';
const newPassword = 'NewStrongPassw0rd!';

describe('DSV DriverAccount password reset PostgreSQL contract', () => {
  live('revalidates the active same-shop DSV driver relationship without consuming a rejected link', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const token = 'Z'.repeat(43);
    const service = new PrismaDsvDriverPasswordResetService(prisma, {
      now: () => new Date('2026-09-10T05:00:00.000Z'),
      token: () => token,
      webPublicOrigin: 'https://dsv.example',
    });

    try {
      const oldPasswordHash = await passwordHash(oldPassword, 'eligibility-password-salt');
      await prisma.shop.createMany({
        data: [
          { id: eligibilityShopId, shopDomain: 'reset-eligibility.test' },
          { id: movedShopId, shopDomain: 'reset-moved.test' },
        ],
      });
      await prisma.driverAccount.create({
        data: {
          id: eligibilityAccountId,
          loginId: 'driver.reset.eligibility',
          name: 'Eligibility Driver',
          passwordHash: oldPasswordHash,
          passwordSalt: 'eligibility-password-salt',
          phone: '01090000002',
        },
      });
      await prisma.driver.create({
        data: {
          accountId: eligibilityAccountId,
          authSubject: 'driver-password-reset-eligibility-fixture',
          displayName: 'Eligibility Driver',
          dsvProfile: { create: { lookupName: 'Eligibility Driver' } },
          id: eligibilityDriverId,
          phone: '01090000002',
          shopId: eligibilityShopId,
          tokenVersion: 4,
        },
      });

      let releaseConcurrentDeactivation = (): void => undefined;
      let reportConcurrentDeactivation = (): void => undefined;
      const concurrentDeactivationAllowed = new Promise<void>((resolve) => { releaseConcurrentDeactivation = resolve; });
      const concurrentDeactivationHeld = new Promise<void>((resolve) => { reportConcurrentDeactivation = resolve; });
      const concurrentDeactivation = prisma.$transaction(async (tx) => {
        await tx.driver.update({ data: { status: 'INACTIVE' }, where: { id: eligibilityDriverId } });
        reportConcurrentDeactivation();
        await concurrentDeactivationAllowed;
      });
      await concurrentDeactivationHeld;
      let concurrentIssueSettled = false;
      const concurrentIssue = service.issueLink({
        actorId,
        driverId: eligibilityDriverId,
        requestId: 'issue-concurrent-inactive',
        shopId: eligibilityShopId,
      }).finally(() => { concurrentIssueSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(concurrentIssueSettled).toBe(false);
      releaseConcurrentDeactivation();
      await concurrentDeactivation;
      await expect(concurrentIssue).resolves.toBeNull();
      await prisma.driver.update({ data: { status: 'ACTIVE' }, where: { id: eligibilityDriverId } });

      await expect(service.issueLink({
        actorId,
        driverId: eligibilityDriverId,
        requestId: 'issue-wrong-shop',
        shopId: movedShopId,
      })).resolves.toBeNull();
      await expect(service.issueLink({
        actorId,
        driverId: '93000000-0000-4000-8000-000000000099',
        requestId: 'issue-unknown-driver',
        shopId: eligibilityShopId,
      })).resolves.toBeNull();
      await expect(service.issueLink({
        actorId,
        driverId: eligibilityDriverId,
        requestId: 'issue-eligibility',
        shopId: eligibilityShopId,
      })).resolves.toMatchObject({
        expiresAt: new Date('2026-09-10T05:30:00.000Z'),
        method: 'ADMIN_LINK',
      });

      let releaseConcurrentUnlink = (): void => undefined;
      let reportConcurrentUnlink = (): void => undefined;
      const concurrentUnlinkAllowed = new Promise<void>((resolve) => { releaseConcurrentUnlink = resolve; });
      const concurrentUnlinkHeld = new Promise<void>((resolve) => { reportConcurrentUnlink = resolve; });
      const concurrentUnlink = prisma.$transaction(async (tx) => {
        await tx.driver.update({ data: { accountId: null }, where: { id: eligibilityDriverId } });
        reportConcurrentUnlink();
        await concurrentUnlinkAllowed;
      });
      await concurrentUnlinkHeld;
      let concurrentCompleteSettled = false;
      const concurrentComplete = service.complete({
        password: newPassword,
        requestId: 'complete-concurrent-unlink',
        token,
      }).then(
        () => {
          concurrentCompleteSettled = true;
          return null;
        },
        (error: unknown) => {
          concurrentCompleteSettled = true;
          return error;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(concurrentCompleteSettled).toBe(false);
      releaseConcurrentUnlink();
      await concurrentUnlink;
      await expect(concurrentComplete).resolves.toMatchObject({ code: 'INVALID_TOKEN' });
      await expect(prisma.driverAccountPasswordResetLink.findUniqueOrThrow({
        select: { consumedAt: true },
        where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      })).resolves.toMatchObject({ consumedAt: null });
      await prisma.driver.update({ data: { accountId: eligibilityAccountId }, where: { id: eligibilityDriverId } });

      const expectRejectedButUnconsumed = async (): Promise<void> => {
        await expect(service.issueLink({
          actorId,
          driverId: eligibilityDriverId,
          requestId: 'issue-ineligible',
          shopId: eligibilityShopId,
        })).resolves.toBeNull();
        await expect(service.validateLink({ token })).resolves.toBeNull();
        await expect(service.complete({ password: newPassword, requestId: 'ineligible', token }))
          .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
        await expect(prisma.driverAccountPasswordResetLink.findUniqueOrThrow({
          select: { consumedAt: true },
          where: { tokenHash: createHash('sha256').update(token).digest('hex') },
        })).resolves.toMatchObject({ consumedAt: null });
      };
      const expectRestored = async (): Promise<void> => {
        await expect(service.validateLink({ token })).resolves.toMatchObject({ method: 'ADMIN_LINK' });
      };

      await prisma.driverAccount.update({ data: { status: 'INACTIVE' }, where: { id: eligibilityAccountId } });
      await expectRejectedButUnconsumed();
      await prisma.driverAccount.update({ data: { status: 'ACTIVE' }, where: { id: eligibilityAccountId } });
      await expectRestored();

      await prisma.driverAccount.update({ data: { loginId: null }, where: { id: eligibilityAccountId } });
      await expectRejectedButUnconsumed();
      await prisma.driverAccount.update({
        data: { loginId: 'driver.reset.eligibility' },
        where: { id: eligibilityAccountId },
      });
      await expectRestored();

      await prisma.driver.update({ data: { status: 'INACTIVE' }, where: { id: eligibilityDriverId } });
      await expectRejectedButUnconsumed();
      await prisma.driver.update({ data: { status: 'ACTIVE' }, where: { id: eligibilityDriverId } });
      await expectRestored();

      await prisma.driver.update({ data: { accountId: null }, where: { id: eligibilityDriverId } });
      await expectRejectedButUnconsumed();
      await prisma.driver.update({ data: { accountId: eligibilityAccountId }, where: { id: eligibilityDriverId } });
      await expectRestored();

      await prisma.dsvDriverProfile.delete({ where: { driverId: eligibilityDriverId } });
      await expectRejectedButUnconsumed();
      await prisma.dsvDriverProfile.create({
        data: { driverId: eligibilityDriverId, lookupName: 'Eligibility Driver', shopId: eligibilityShopId },
      });
      await expectRestored();

      await prisma.dsvDriverProfile.delete({ where: { driverId: eligibilityDriverId } });
      await prisma.driver.update({ data: { shopId: movedShopId }, where: { id: eligibilityDriverId } });
      await prisma.dsvDriverProfile.create({
        data: { driverId: eligibilityDriverId, lookupName: 'Eligibility Driver', shopId: movedShopId },
      });
      await expectRejectedButUnconsumed();
      await prisma.dsvDriverProfile.delete({ where: { driverId: eligibilityDriverId } });
      await prisma.driver.update({ data: { shopId: eligibilityShopId }, where: { id: eligibilityDriverId } });
      await prisma.dsvDriverProfile.create({
        data: { driverId: eligibilityDriverId, lookupName: 'Eligibility Driver', shopId: eligibilityShopId },
      });
      await expectRestored();

      await expect(service.complete({ password: 'weak', requestId: 'weak-password', token }))
        .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
      await expectRestored();
      await expect(service.complete({ password: oldPassword, requestId: 'reused-password', token }))
        .rejects.toMatchObject({ code: 'PASSWORD_REUSED' });
      await expectRestored();

      const [driverBefore, profileBefore] = await Promise.all([
        prisma.driver.findUniqueOrThrow({
          select: { accountId: true, authSubject: true, displayName: true, id: true, phone: true, shopId: true, status: true },
          where: { id: eligibilityDriverId },
        }),
        prisma.dsvDriverProfile.findUniqueOrThrow({
          select: { age: true, career: true, driverId: true, gender: true, lookupName: true, shopId: true, traits: true, zone: true },
          where: { driverId: eligibilityDriverId },
        }),
      ]);
      await service.complete({ password: newPassword, requestId: 'eligible-complete', token });
      await expect(prisma.driver.findUniqueOrThrow({
        select: { accountId: true, authSubject: true, displayName: true, id: true, phone: true, shopId: true, status: true },
        where: { id: eligibilityDriverId },
      })).resolves.toEqual(driverBefore);
      await expect(prisma.dsvDriverProfile.findUniqueOrThrow({
        select: { age: true, career: true, driverId: true, gender: true, lookupName: true, shopId: true, traits: true, zone: true },
        where: { driverId: eligibilityDriverId },
      })).resolves.toEqual(profileBefore);
      const serializedAudits = JSON.stringify(await prisma.dsvAuditEvent.findMany({
        where: { entityId: eligibilityAccountId, entityType: 'DRIVER_ACCOUNT' },
      }));
      expect(serializedAudits).not.toContain(oldPassword);
      expect(serializedAudits).not.toContain(newPassword);
      expect(serializedAudits).not.toContain('Eligibility Driver');
      expect(serializedAudits).not.toContain('driver.reset.eligibility');
      expect(serializedAudits).not.toContain('01090000002');
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  live('enforces expiry, one-time concurrency, session revocation, and relationship preservation', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let now = new Date('2026-09-10T06:00:00.000Z');
    let token = 'A'.repeat(43);
    const service = new PrismaDsvDriverPasswordResetService(prisma, {
      now: () => now,
      token: () => token,
      webPublicOrigin: 'https://dsv.example',
    });

    try {
      await seed(prisma);
      let releaseCredentialChange = (): void => undefined;
      let reportLockHeld = (): void => undefined;
      const credentialChangeAllowed = new Promise<void>((resolve) => { releaseCredentialChange = resolve; });
      const lockHeld = new Promise<void>((resolve) => { reportLockHeld = resolve; });
      const replacementSalt = 'replacement-password-salt';
      const replacementHash = await passwordHash('Replacement-driver-password-25!', replacementSalt);
      const replaceCredentials = prisma.$transaction(async (tx) => {
        await lockDsvDriverAccount(tx, accountId);
        reportLockHeld();
        await credentialChangeAllowed;
        await tx.driverAccount.update({
          data: { passwordHash: replacementHash, passwordSalt: replacementSalt, tokenVersion: 8 },
          where: { id: accountId },
        });
      });
      await lockHeld;
      const concurrentOldPasswordLogin = new PrismaDsvDriverAuthRepository(prisma).login({
        loginId: 'driver.reset',
        password: oldPassword,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseCredentialChange();
      await replaceCredentials;
      await expect(concurrentOldPasswordLogin).rejects.toThrow('Invalid login ID or password');
      expect(await prisma.driverAccountSession.count({ where: { accountId } })).toBe(2);
      await prisma.driverAccount.update({
        data: {
          failedPasswordAttempts: 0,
          passwordHash: await passwordHash(oldPassword, 'old-password-salt'),
          passwordLockedUntil: null,
          passwordSalt: 'old-password-salt',
          tokenVersion: 7,
        },
        where: { id: accountId },
      });
      const auth = new PrismaDsvDriverAuthRepository(prisma);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(auth.login({ loginId: 'driver.reset', password: 'WrongPassw0rd!' }))
          .rejects.toThrow('Invalid login ID or password');
      }
      const lockedAccount = await prisma.driverAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(lockedAccount.failedPasswordAttempts).toBe(5);
      expect(lockedAccount.passwordLockedUntil).not.toBeNull();

      const initial = await service.issueLink({ actorId, driverId, requestId: 'issue-expiring', shopId });
      expect(initial).toMatchObject({ method: 'ADMIN_LINK' });
      expect(initial?.setupUrl).toBe(`https://dsv.example/driver/password-reset#token=${token}`);
      const storedInitial = await prisma.driverAccountPasswordResetLink.findUniqueOrThrow({
        where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      });
      expect(storedInitial.tokenHash).not.toContain(token);
      expect(await service.validateLink({ token })).toMatchObject({ method: 'ADMIN_LINK' });

      now = new Date('2026-09-10T06:31:00.000Z');
      expect(await service.validateLink({ token })).toBeNull();
      await expect(service.complete({ password: newPassword, requestId: 'expired', token }))
        .rejects.toMatchObject({ code: 'INVALID_TOKEN' });

      token = 'B'.repeat(43);
      await service.issueLink({ actorId, driverId, requestId: 'issue-revoked', shopId });
      const revokedToken = token;
      now = new Date('2026-09-10T06:32:00.000Z');
      token = 'C'.repeat(43);
      await service.issueLink({ actorId, driverId, requestId: 'issue-current', shopId });
      expect(await service.validateLink({ token: revokedToken })).toBeNull();

      const access = new PrismaDriverTokenAccessRepository(prisma);
      await expect(access.isDriverAccountAccessTokenActive({ accountId, tokenVersion: 7 })).resolves.toBe(true);
      await expect(access.isDriverAccessTokenActive({ driverId, shopDomain: 'reset.test', tokenVersion: 3 })).resolves.toBe(true);

      const resetToken = token;
      const outcomes = await Promise.allSettled([
        service.complete({ password: newPassword, requestId: 'complete-1', token: resetToken }),
        service.complete({ password: newPassword, requestId: 'complete-2', token: resetToken }),
      ]);
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({ reason: { code: 'INVALID_TOKEN' } });
      await expect(service.complete({ password: 'FreshStrongPassw0rd!', requestId: 'reuse', token: resetToken }))
        .rejects.toMatchObject({ code: 'INVALID_TOKEN' });

      const account = await prisma.driverAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(account).toMatchObject({
        failedPasswordAttempts: 0,
        passwordLockedUntil: null,
        tokenVersion: 8,
      });
      expect(account.passwordSalt).not.toBe('old-password-salt');
      expect(account.passwordHash).not.toBe(await passwordHash(oldPassword, 'old-password-salt'));
      await expect(access.isDriverAccountAccessTokenActive({ accountId, tokenVersion: 7 })).resolves.toBe(false);
      await expect(access.isDriverAccessTokenActive({ driverId, shopDomain: 'reset.test', tokenVersion: 3 })).resolves.toBe(false);

      const [accountSessions, driverSessions, driver, routePlan, assignment] = await Promise.all([
        prisma.driverAccountSession.findMany({ where: { accountId } }),
        prisma.driverSession.findMany({ where: { driverId } }),
        prisma.driver.findUniqueOrThrow({ where: { id: driverId } }),
        prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } }),
        prisma.dsvVehicleDriverAssignment.findUniqueOrThrow({ where: { id: assignmentId } }),
      ]);
      expect(accountSessions).toHaveLength(2);
      expect(driverSessions).toHaveLength(2);
      expect(accountSessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      expect(driverSessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      expect(driver.accountId).toBe(accountId);
      expect(routePlan).toMatchObject({ driverId, vehicleId });
      expect(assignment).toMatchObject({ driverId, vehicleId });

      const audits = await prisma.dsvAuditEvent.findMany({
        orderBy: { occurredAt: 'asc' },
        where: { entityId: accountId, entityType: 'DRIVER_ACCOUNT' },
      });
      expect(audits.map(({ eventType }) => eventType)).toContain('DRIVER_ACCOUNT_PASSWORD_RESET_COMPLETED');
      const serializedAudits = JSON.stringify(audits);
      expect(serializedAudits).not.toContain(resetToken);
      expect(serializedAudits).not.toContain('driver.reset');
      expect(serializedAudits).not.toContain('01090000001');

      now = new Date('2026-09-10T07:00:00.000Z');
      for (const [index, value] of ['D', 'E', 'F'].entries()) {
        token = value.repeat(43);
        await expect(service.issueLink({ actorId, driverId, requestId: `limited-${index}`, shopId })).resolves.not.toBeNull();
      }
      token = 'G'.repeat(43);
      await expect(service.issueLink({ actorId, driverId, requestId: 'limited-3', shopId }))
        .rejects.toMatchObject({ code: 'RATE_LIMITED' });

      now = new Date('2026-09-10T07:16:00.000Z');
      token = 'H'.repeat(43);
      await service.issueLink({ actorId, driverId, requestId: 'same-password-link', shopId });
      await expect(service.complete({ password: newPassword, requestId: 'same-password', token }))
        .rejects.toMatchObject({ code: 'PASSWORD_REUSED' });
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);
});

async function seed(prisma: PrismaClient): Promise<void> {
  const oldPasswordHash = await passwordHash(oldPassword, 'old-password-salt');
  await prisma.shop.create({ data: { id: shopId, shopDomain: 'reset.test' } });
  await prisma.driverAccount.create({
    data: {
      failedPasswordAttempts: 0,
      id: accountId,
      loginId: 'driver.reset',
      name: 'Synthetic Driver',
      passwordHash: oldPasswordHash,
      passwordLockedUntil: null,
      passwordSalt: 'old-password-salt',
      phone: '01090000001',
      tokenVersion: 7,
    },
  });
  await prisma.driver.create({
    data: {
      accountId,
      authSubject: 'driver-password-reset-fixture',
      displayName: 'Synthetic Driver',
      dsvProfile: { create: { lookupName: 'Synthetic Driver' } },
      id: driverId,
      phone: '01090000001',
      shopId,
      tokenVersion: 3,
    },
  });
  await prisma.vehicle.create({
    data: {
      dsvProfile: { create: { note: '', typeLabel: 'Synthetic' } },
      id: vehicleId,
      label: 'Synthetic Vehicle',
      licensePlate: 'TEST-RESET-01',
      shopId,
    },
  });
  await prisma.dsvVehicleDriverAssignment.create({
    data: { driverId, id: assignmentId, shopId, vehicleId },
  });
  await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId,
      id: routePlanId,
      metrics: {},
      name: 'Synthetic assigned route',
      optimizerVersion: 'test',
      planDate: new Date('2026-09-10T00:00:00.000Z'),
      shopId,
      vehicleId,
    },
  });
  await prisma.driverAccountSession.create({
    data: {
      accountId,
      expiresAt: new Date('2026-10-10T00:00:00.000Z'),
      refreshTokenHash: createHash('sha256').update('account-refresh').digest('hex'),
    },
  });
  await prisma.driverAccountSession.create({
    data: {
      accountId,
      expiresAt: new Date('2026-10-10T00:00:00.000Z'),
      refreshTokenHash: createHash('sha256').update('account-refresh-2').digest('hex'),
    },
  });
  await prisma.driverSession.create({
    data: {
      driverId,
      expiresAt: new Date('2026-10-10T00:00:00.000Z'),
      refreshTokenHash: createHash('sha256').update('driver-refresh').digest('hex'),
    },
  });
  await prisma.driverSession.create({
    data: {
      driverId,
      expiresAt: new Date('2026-10-10T00:00:00.000Z'),
      refreshTokenHash: createHash('sha256').update('driver-refresh-2').digest('hex'),
    },
  });
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const derived = await promisify(scrypt)(password, salt, 64) as Buffer;
  return derived.toString('base64url');
}

function assertDisposableDatabase(): void {
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('driver_password_reset')) {
    throw new Error('Refusing to run Driver password reset integration test outside its disposable database');
  }
}
