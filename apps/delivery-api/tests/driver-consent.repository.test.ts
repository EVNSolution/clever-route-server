import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverConsentRepository } from '../src/modules/driver/driver-consent.repository.js';

const recordedAt = new Date('2026-05-12T05:50:00.000Z');

describe('PrismaDriverConsentRepository', () => {
  test('upserts required driver consent records for the authenticated shop driver', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverConsentRepository(prisma as never);

    const result = await repository.recordDriverConsents({
      appContext: { appVersion: '0.1.0' },
      consents: [
        { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
        { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
      ],
      deviceContext: { platform: 'ios' },
      driverId: 'driver-id',
      recordedAt,
      routeContext: 'route-context',
      shopDomain: 'Example.myshopify.com'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'example.myshopify.com' } });
    expect(prisma.driver.findUnique).toHaveBeenCalledWith({ where: { id: 'driver-id' } });
    expect(prisma.driverConsentRecord.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.driverConsentRecord.upsert).toHaveBeenNthCalledWith(1, {
      create: {
        accepted: true,
        appContext: { appVersion: '0.1.0' },
        consentType: 'LOCATION_INFORMATION',
        consentVersion: 'location-v1',
        deviceContext: { platform: 'ios' },
        driverId: 'driver-id',
        recordedAt,
        routeContext: 'route-context',
        shopId: 'shop-id'
      },
      update: {
        accepted: true,
        appContext: { appVersion: '0.1.0' },
        deviceContext: { platform: 'ios' },
        recordedAt,
        routeContext: 'route-context',
        shopId: 'shop-id'
      },
      where: {
        driverId_consentType_consentVersion: {
          consentType: 'LOCATION_INFORMATION',
          consentVersion: 'location-v1',
          driverId: 'driver-id'
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

  test('rejects driver consent when the token driver is not in the token shop', async () => {
    const { prisma } = createPrismaHarness({ driverShopId: 'other-shop-id' });
    const repository = new PrismaDriverConsentRepository(prisma as never);

    await expect(
      repository.recordDriverConsents({
        appContext: null,
        consents: [
          { accepted: true, type: 'LOCATION_INFORMATION', version: 'location-v1' },
          { accepted: true, type: 'PERSONAL_INFORMATION', version: 'privacy-v1' }
        ],
        deviceContext: null,
        driverId: 'driver-id',
        recordedAt,
        routeContext: null,
        shopDomain: 'example.myshopify.com'
      })
    ).rejects.toThrow('Driver not found for shop');
    expect(prisma.driverConsentRecord.upsert).not.toHaveBeenCalled();
  });
});

function createPrismaHarness(input: { driverShopId?: string } = {}) {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: input.driverShopId ?? 'shop-id' }))
      },
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
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}
