import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverConsentRepository } from '../src/modules/driver/driver-consent.repository.js';

const recordedAt = new Date('2026-05-12T05:50:00.000Z');

describe('PrismaDriverConsentRepository', () => {
  test('uses the assigned route Store without a same-domain default-app Store lookup', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverConsentRepository(prisma as never);

    const result = await repository.recordDriverConsents({
      appContext: { appVersion: '0.1.0' },
      consents: [
        { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
        { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
      ],
      deviceContext: { platform: 'ios' },
      accountId: 'account-id',
      recordedAt,
      routePlanId: 'route-plan-id'
    });

    expect(prisma.routePlan.findUnique).toHaveBeenCalledWith({
      select: { driverId: true, shopId: true, driver: { select: { accountId: true } } },
      where: { id: 'route-plan-id' }
    });
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.driverConsentRecord.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.driverConsentRecord.upsert).toHaveBeenNthCalledWith(1, {
      create: {
        accepted: true,
        appContext: { appVersion: '0.1.0' },
        accountId: 'account-id',
        consentType: 'LOCATION_INFORMATION',
        consentVersion: 'location-v1',
        deviceContext: { platform: 'ios' },
        driverId: 'driver-id',
        recordedAt,
        routeContext: 'route-plan-id',
        shopId: 'shop-id'
      },
      update: {
        accepted: true,
        appContext: { appVersion: '0.1.0' },
        deviceContext: { platform: 'ios' },
        driverId: 'driver-id',
        recordedAt,
        routeContext: 'route-plan-id',
        shopId: 'shop-id'
      },
      where: {
        accountId_consentType_consentVersion: {
          accountId: 'account-id',
          consentType: 'LOCATION_INFORMATION',
          consentVersion: 'location-v1'
        }
      }
    });
    expect(result).toEqual({
      status: 'CONSENT_RECORDED',
      recordedAt: '2026-05-12T05:50:00.000Z',
      records: [
        { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
        { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
      ]
    });
  });

  test('rejects consent when the route assignment belongs to another account', async () => {
    const { prisma } = createPrismaHarness({ routeAccountId: 'other-account-id' });
    const repository = new PrismaDriverConsentRepository(prisma as never);

    await expect(
      repository.recordDriverConsents({
        appContext: null,
        consents: [
          { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
          { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
        ],
        deviceContext: null,
        accountId: 'account-id',
        recordedAt,
        routePlanId: 'route-plan-id'
      })
    ).rejects.toThrow('Route assignment account mismatch');
    expect(prisma.driverConsentRecord.upsert).not.toHaveBeenCalled();
  });
});

function createPrismaHarness(input: { routeAccountId?: string } = {}) {
  return {
    prisma: {
      driverConsentRecord: {
        upsert: vi.fn((args: { create: { accepted: boolean; consentType: string; consentVersion: string } }) =>
          Promise.resolve({
            accepted: args.create.accepted,
            consentType: args.create.consentType,
            consentVersion: args.create.consentVersion,
            recordedAt
          })
        )
      },
      routePlan: {
        findUnique: vi.fn(() => Promise.resolve({
          driver: { accountId: input.routeAccountId ?? 'account-id' },
          driverId: 'driver-id',
          shopId: 'shop-id'
        }))
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({
          appId: 'clever',
          id: 'wrong-default-app-shop-id',
          shopDomain: 'same-domain.myshopify.com'
        }))
      }
    }
  };
}
