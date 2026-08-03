import { describe, expect, test, vi } from 'vitest';

import {
  APPROVED_DSV_DRIVER_TEST_IDENTITY,
  seedDsvDriverTestIdentity,
} from '../src/modules/dsv/dsv-driver-test-identity.seed.js';

const baseDriver = {
  accountId: null,
  displayName: APPROVED_DSV_DRIVER_TEST_IDENTITY.name,
  dsvProfile: { residentNumberFrontFingerprint: null },
  id: APPROVED_DSV_DRIVER_TEST_IDENTITY.driverId,
  phone: '01012345678',
  status: 'ACTIVE',
};

describe('guarded production DSV driver test identity seed', () => {
  test('rejects every target except the explicitly approved production driver', async () => {
    await expect(seed({ driverId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow('not approved');
    await expect(seed({ approval: 'wrong' })).rejects.toThrow('approval token');
    await expect(seed({ expectedName: '다른 배송원' })).rejects.toThrow('name is not approved');
  });

  test('dry-runs without persisting and applies only a keyed fingerprint', async () => {
    const dryRun = await seed();
    expect(dryRun).toMatchObject({ applied: false, status: 'DRY_RUN' });
    expect(updateMany).not.toHaveBeenCalled();

    const applied = await seed({ apply: true });
    expect(applied).toMatchObject({ applied: true, status: 'SEEDED' });
    const update = updateMany.mock.calls[0]?.[0] as { data: { residentNumberFrontFingerprint: string } };
    expect(update.data.residentNumberFrontFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(update.data.residentNumberFrontFingerprint).not.toContain('9001011');
  });
});

const findUnique = vi.fn((input: unknown) => {
  void input;
  return Promise.resolve(baseDriver);
});
const updateMany = vi.fn((input: unknown) => {
  void input;
  return Promise.resolve({ count: 1 });
});

function seed(overrides: Partial<Parameters<typeof seedDsvDriverTestIdentity>[0]> = {}) {
  findUnique.mockClear();
  updateMany.mockClear();
  return seedDsvDriverTestIdentity({
    apply: false,
    approval: APPROVED_DSV_DRIVER_TEST_IDENTITY.approval,
    driverId: APPROVED_DSV_DRIVER_TEST_IDENTITY.driverId,
    expectedName: APPROVED_DSV_DRIVER_TEST_IDENTITY.name,
    identitySecret: 'identity-secret-that-is-at-least-32-characters',
    prisma: {
      driver: { findUnique },
      dsvDriverProfile: { updateMany },
    } as never,
    residentNumberFront: '9001011',
    ...overrides,
  });
}
