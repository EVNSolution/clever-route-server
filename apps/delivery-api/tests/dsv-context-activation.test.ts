import { describe, expect, test } from 'vitest';

import { resolveDsvContextActivation } from '../src/modules/dsv/dsv-context-activation.js';

const ACCOUNT = '0769631b-df51-441b-84db-82bb8210f7bc';
const OTHER_ACCOUNT = 'ac9871b2-f6a0-437e-b371-da7ae9021a3e';
const SHOP = '95375ce2-8a45-43d0-a7f0-b3de2a74191c';
const NOW = new Date('2026-10-12T07:00:00.000Z');
const SERVICE_DATE = new Date('2026-10-13T00:00:00.000Z');

const geofence = {
  arrivalDwellSeconds: 60,
  arrivalMinSamples: 2,
  destinationExitRadiusMeters: 200,
  destinationRadiusMeters: 100,
  exitDwellSeconds: 0,
  exitMinSamples: 1,
  futureToleranceSeconds: 30,
  maxGapSeconds: 360,
  maxObservationDelaySeconds: 300,
  maxSpeedKph: 150,
  mode: 'LIVE',
  notificationTtlSeconds: 604_800,
  policyVersion: 'fleet-v1',
  warehouseExitRadiusMeters: 300,
  warehouseRadiusMeters: 150,
};

const send = {
  allowedAccountIds: [ACCOUNT],
  allowedKinds: ['N01', 'N02', 'N03', 'N04', 'N05', 'N06'],
  allowedShopIds: [SHOP],
  approvedAuthorizationId: 'owner-instruction-20261012',
  approvedGeofencePolicyVersion: 'fleet-v1',
  maxProviderAttempts: 5,
  monitorWindowMs: 86_400_000,
  notificationRetentionMs: 604_800_000,
  retryDelayMs: 30_000,
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    DSV_GEOFENCE_ENABLED: 'true',
    DSV_GEOFENCE_POLICY_JSON: JSON.stringify(geofence),
    DSV_OPERATIONAL_SEND_ENABLED: 'true',
    DSV_OPERATIONAL_SEND_POLICY_JSON: JSON.stringify(send),
    ...overrides,
  } as Record<string, string | undefined>;
}

const input = { now: NOW, recipientAccountId: ACCOUNT, serviceDate: SERVICE_DATE, shopId: SHOP };

describe('resolveDsvContextActivation', () => {
  test('starts LIVE with the approved policy snapshot and the Seoul business-day monitor window', () => {
    const result = resolveDsvContextActivation(env(), input);
    expect(result).toMatchObject({
      liveEligibleAt: NOW,
      monitorEndAt: new Date('2026-10-13T15:00:00.000Z'),
      monitorStartAt: new Date('2026-10-12T15:00:00.000Z'),
      notificationMode: 'LIVE',
      policy: { authorizationId: 'owner-instruction-20261012', mode: 'LIVE', policyVersion: 'fleet-v1' },
    });
  });

  test.each([
    ['geofence switch is not true', env({ DSV_GEOFENCE_ENABLED: undefined })],
    ['geofence policy is missing', env({ DSV_GEOFENCE_POLICY_JSON: undefined })],
    ['geofence policy is not valid JSON', env({ DSV_GEOFENCE_POLICY_JSON: '{' })],
    ['geofence policy misses a required value', env({ DSV_GEOFENCE_POLICY_JSON: JSON.stringify({ ...geofence, maxSpeedKph: undefined }) })],
    ['send switch is not true', env({ DSV_OPERATIONAL_SEND_ENABLED: undefined })],
    ['send policy is missing', env({ DSV_OPERATIONAL_SEND_POLICY_JSON: undefined })],
    ['send policy is incomplete', env({ DSV_OPERATIONAL_SEND_POLICY_JSON: JSON.stringify({ ...send, allowedKinds: [] }) })],
    ['policy versions differ', env({ DSV_OPERATIONAL_SEND_POLICY_JSON: JSON.stringify({ ...send, approvedGeofencePolicyVersion: 'other' }) })],
  ])('stays OFF when %s', (_name, value) => {
    expect(resolveDsvContextActivation(value, input)).toBeNull();
  });

  test('stays OFF for a recipient or shop outside the allowlist, and without a recipient', () => {
    expect(resolveDsvContextActivation(env(), { ...input, recipientAccountId: OTHER_ACCOUNT })).toBeNull();
    expect(resolveDsvContextActivation(env(), { ...input, recipientAccountId: null })).toBeNull();
    expect(resolveDsvContextActivation(env(), { ...input, shopId: OTHER_ACCOUNT })).toBeNull();
  });

  test('a SHADOW geofence policy records decisions only and needs no send policy', () => {
    const result = resolveDsvContextActivation(
      env({
        DSV_GEOFENCE_POLICY_JSON: JSON.stringify({ ...geofence, mode: 'SHADOW' }),
        DSV_OPERATIONAL_SEND_ENABLED: undefined,
        DSV_OPERATIONAL_SEND_POLICY_JSON: undefined,
      }),
      { ...input, recipientAccountId: null },
    );
    expect(result).toMatchObject({ liveEligibleAt: null, notificationMode: 'SHADOW', policy: { mode: 'SHADOW' } });
    expect(result?.policy).not.toHaveProperty('authorizationId');
  });
});
