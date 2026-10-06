import { describe, expect, test, vi } from 'vitest';

import { legacyDsvNotificationTokens } from '../src/modules/dsv/dsv-notification-channel-routing.js';
import { loadDsvOperationalSendPolicy } from '../src/modules/dsv/dsv-operational-send-policy.js';
import { disabledDsvOperationalNotificationSendPolicy, type DsvOperationalNotificationSendPolicy } from '../src/modules/dsv/dsv-operational-driver-notification.service.js';

const now = new Date('2026-10-06T01:00:00Z');
const accountId = '11111111-1111-4111-8111-111111111111';
const shopId = '22222222-2222-4222-8222-222222222222';
const policy: DsvOperationalNotificationSendPolicy = {
  allowedAccountIds: [accountId], allowedShopIds: [shopId], allowedKinds: ['N01', 'N02', 'N03'],
  approvedAuthorizationId: 'synthetic-test-only', approvedGeofencePolicyVersion: 'synthetic-v1',
  businessReminderCap: 3, liveSendingEnabled: true, maxProviderAttempts: 2,
  monitorWindowMs: 3_600_000, notificationRetentionMs: 3_600_000, retryDelayMs: 30_000,
};
const token = { id: 'token', appId: 'com.evnsolution.clever.driver', deviceId: 'install', tokenHash: 'hash', updatedAt: now };

describe('DSV token-generation channel routing', () => {
  test('default and incomplete policies preserve legacy sending and forbid new live sending', async () => {
    expect(loadDsvOperationalSendPolicy({}).liveSendingEnabled).toBe(false);
    expect(loadDsvOperationalSendPolicy({ DSV_OPERATIONAL_SEND_ENABLED: 'true', DSV_OPERATIONAL_SEND_POLICY_JSON: '{}' }).liveSendingEnabled).toBe(false);
    expect(loadDsvOperationalSendPolicy({ DSV_OPERATIONAL_SEND_ENABLED: 'true', DSV_OPERATIONAL_SEND_POLICY_JSON: '{' }).liveSendingEnabled).toBe(false);
    expect(loadDsvOperationalSendPolicy({ DSV_OPERATIONAL_SEND_ENABLED: 'true', DSV_OPERATIONAL_SEND_POLICY_JSON: JSON.stringify(policy) })).toEqual(policy);
    expect(await legacyDsvNotificationTokens(null, disabledDsvOperationalNotificationSendPolicy, input())).toEqual([token]);
  });

  test('a supported current installation uses the operational channel only', async () => {
    const prisma = storage();
    expect(await legacyDsvNotificationTokens(prisma, policy, input())).toEqual([]);
    expect(prisma.dsvNotificationCapability.findMany).toHaveBeenCalledOnce();
  });

  test.each(['hash', 'generation', 'installation', 'schema', 'app'] as const)('stale %s capability preserves legacy delivery', async (mutation) => {
    const prisma = storage();
    const candidate = { ...token };
    if (mutation === 'hash') candidate.tokenHash = 'renewed';
    if (mutation === 'generation') candidate.updatedAt = new Date(now.getTime() + 1);
    if (mutation === 'installation') candidate.deviceId = 'reinstalled';
    if (mutation === 'app') candidate.appId = 'different-app';
    if (mutation === 'schema') prisma.dsvNotificationCapability.findMany.mockResolvedValue([{ ...capability(), schemaVersion: 99 }]);
    expect(await legacyDsvNotificationTokens(prisma, policy, { ...input(), tokens: [candidate] })).toEqual([candidate]);
  });

  test('allowlists and context OFF retain the legacy channel', async () => {
    expect(await legacyDsvNotificationTokens(storage(), { ...policy, allowedAccountIds: ['different'] }, input())).toEqual([token]);
    const prisma = storage();
    prisma.dsvExecutionContext.findMany.mockResolvedValue([]);
    expect(await legacyDsvNotificationTokens(prisma, policy, input())).toEqual([token]);
  });

  test.each(['retention', 'window', 'route', 'account'] as const)('new worker ineligible %s retains legacy delivery', async (reason) => {
    const prisma = storage();
    if (reason === 'retention') prisma.dsvOperationalNotification.findFirst.mockResolvedValue({
      ...intent(), expiresAt: new Date(now.getTime() + policy.notificationRetentionMs! + 1),
    });
    if (reason === 'window') prisma.dsvExecutionContext.findMany.mockResolvedValue([{
      ...context(), monitorEndAt: new Date(now.getTime() + policy.monitorWindowMs! + 1),
    }]);
    if (reason === 'route') prisma.routePlan.findFirst.mockResolvedValue({ ...route(), driverId: 'new-driver' });
    if (reason === 'account') prisma.driverPushToken.findUnique.mockResolvedValue({ ...currentToken(), account: { status: 'DISABLED' } });
    expect(await legacyDsvNotificationTokens(prisma, policy, input())).toEqual([token]);
  });
});

function input() { return { accountId, action: 'assigned', routePlanId: 'route', tokens: [token], now }; }
function capability() { return { tokenId: token.id, schemaVersion: 1, tokenHash: token.tokenHash, tokenUpdatedAt: now, installationId: token.deviceId }; }
function intent() { return { id: 'notification', kind: 'N01', assignmentEpoch: 1n, createdAt: now, expiresAt: new Date(now.getTime() + 1000) }; }
function context() {
  return {
    id: 'context', shopId, status: 'ACTIVE', closedAt: null, driverId: 'driver', vehicleId: 'vehicle', routePlanId: 'route',
    recipientAccountId: accountId, routeVersion: 1, assignmentEpoch: 1n,
    liveEligibleAt: now, policy: { authorizationId: policy.approvedAuthorizationId },
    monitorStartAt: new Date(now.getTime() - 1000), monitorEndAt: new Date(now.getTime() + 1000),
  };
}
function route() { return { driverId: 'driver', vehicleId: 'vehicle', status: 'READY', driver: { status: 'ACTIVE', accountId }, routeGroupingChildVersions: [{ id: 'child' }] }; }
function currentToken() { return { accountId, status: 'ACTIVE', account: { status: 'ACTIVE' }, tokenHash: token.tokenHash, updatedAt: token.updatedAt }; }
function storage() {
  return {
    dsvExecutionContext: { findMany: vi.fn().mockResolvedValue([context()]) },
    dsvOperationalNotification: { findFirst: vi.fn().mockResolvedValue(intent()) },
    dsvNotificationCapability: { findMany: vi.fn().mockResolvedValue([capability()]) },
    routePlan: { findFirst: vi.fn().mockResolvedValue(route()) },
    driverPushToken: { findUnique: vi.fn().mockResolvedValue(currentToken()) },
    vehicle: { findFirst: vi.fn().mockResolvedValue({ id: 'vehicle' }) },
  };
}
