import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDsvOperationalDriverNotificationService,
  disabledDsvOperationalNotificationSendPolicy,
  type DsvOperationalNotificationSendPolicy,
} from '../src/modules/dsv/dsv-operational-driver-notification.service.js';
import {
  notificationCopy,
  type DsvOperationalPushProvider,
} from '../src/modules/dsv/dsv-operational-driver-notification.provider.js';
import { createDsvAdminPrincipal, type DsvDriverPrincipal } from '../src/modules/dsv/dsv-principal.js';

const now = new Date('2026-10-06T02:30:00.000Z');
const accountId = '10000000-0000-4000-8000-000000000001';
const shopId = '20000000-0000-4000-8000-000000000001';
const notificationId = '30000000-0000-4000-8000-000000000001';
const executionContextId = '40000000-0000-4000-8000-000000000001';
const secondExecutionContextId = '40000000-0000-4000-8000-000000000002';
const routePlanId = '50000000-0000-4000-8000-000000000001';
const tokenId = '60000000-0000-4000-8000-000000000001';
const capabilityId = '70000000-0000-4000-8000-000000000001';
const attemptId = '80000000-0000-4000-8000-000000000001';

describe('DSV operational N01 copy', () => {
  test.each([
    ['future service date', '2026-10-08T00:00:00.000Z', '10월 8일 배차가 등록되었습니다.'],
    ['year rollover service date', '2027-01-01T00:00:00.000Z', '1월 1일 배차가 등록되었습니다.'],
  ])('uses the execution service date for %s', (_caseName, value, expectedTitle) => {
    const serviceDate = new Date(value);

    expect(notificationCopy('N01', serviceDate)).toEqual({
      body: '앱에서 새 배차를 확인해 주세요.',
      title: expectedTitle,
    });
    expect(notificationCopy('N01', serviceDate)).toEqual(notificationCopy('N01', serviceDate));
  });
});

const driverPrincipal: DsvDriverPrincipal = {
  driverId: '90000000-0000-4000-8000-000000000001',
  principalType: 'DRIVER',
  scopes: ['driver:assignments:read'],
  shopId,
};

const livePolicy: DsvOperationalNotificationSendPolicy = {
  allowedAccountIds: [accountId],
  allowedKinds: ['N05'],
  allowedShopIds: [shopId],
  approvedAuthorizationId: 'change-control-123',
  approvedGeofencePolicyVersion: 'synthetic-v1',
  businessReminderCap: 3,
  liveSendingEnabled: true,
  maxProviderAttempts: 3,
  monitorWindowMs: 8 * 60 * 60 * 1000,
  notificationRetentionMs: 8 * 60 * 60 * 1000,
  retryDelayMs: 60_000,
};

describe('PrismaDsvOperationalDriverNotificationService capability and inbox', () => {
  test('returns a bounded driver inbox without persisted payload detail', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findMany.mockResolvedValue([{
      businessStatus: 'OPEN',
      createdAt: now,
      executionContextId,
      expiresAt: new Date(now.getTime() + 60_000),
      id: notificationId,
      kind: 'N01',
    }]);
    prisma.dsvOperationalNotificationAck.findMany.mockResolvedValue([{
      createdAt: now,
      notificationId,
    }]);
    prisma.dsvExecutionContext.findMany.mockResolvedValue([{
      id: executionContextId,
      serviceDate: new Date('2026-10-08T00:00:00.000Z'),
    }]);
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    const result = await service.list({ limit: 500, now, principal: driverPrincipal });

    expect(result).toEqual({
      items: [{
        ackedAt: now.toISOString(),
        businessStatus: 'OPEN',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        id: notificationId,
        kind: 'N01',
        summary: { body: '앱에서 새 배차를 확인해 주세요.', title: '10월 8일 배차가 등록되었습니다.' },
      }],
      nextCursor: null,
    });
    expect(prisma.dsvOperationalNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 101,
      where: expect.objectContaining({ audience: 'DRIVER', recipientAccountId: accountId, shopId }) as unknown,
    }));
    expect(JSON.stringify(result)).not.toContain('payload');
  });

  test('keeps two N01 inbox items distinct by execution service date', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findMany.mockResolvedValue([
      {
        businessStatus: 'OPEN',
        createdAt: now,
        executionContextId,
        expiresAt: new Date(now.getTime() + 60_000),
        id: notificationId,
        kind: 'N01',
      },
      {
        businessStatus: 'OPEN',
        createdAt: new Date(now.getTime() - 1_000),
        executionContextId: secondExecutionContextId,
        expiresAt: new Date(now.getTime() + 60_000),
        id: '30000000-0000-4000-8000-000000000002',
        kind: 'N01',
      },
    ]);
    prisma.dsvExecutionContext.findMany.mockResolvedValue([
      { id: executionContextId, serviceDate: new Date('2026-10-08T00:00:00.000Z') },
      { id: secondExecutionContextId, serviceDate: new Date('2026-10-09T00:00:00.000Z') },
    ]);
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    const result = await service.list({ now, principal: driverPrincipal });

    expect(result.items.map((item) => item.summary.title)).toEqual([
      '10월 8일 배차가 등록되었습니다.',
      '10월 9일 배차가 등록되었습니다.',
    ]);
  });

  test('binds capability to the authenticated account and current token generation', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.driverPushToken.findFirst.mockResolvedValue({
      appId: 'com.evnsolution.clever.driver',
      deviceId: 'installation-1',
      id: tokenId,
      status: 'ACTIVE',
      tokenHash: 'token-hash',
      updatedAt: now,
    });
    prisma.dsvNotificationCapability.upsert.mockResolvedValue({ id: capabilityId, schemaVersion: 1 });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.registerCapability({
      installationId: 'installation-1',
      kinds: ['N01', 'N05'],
      now,
      principal: driverPrincipal,
      schemaVersion: 1,
      tokenId,
    })).resolves.toEqual({
      capabilityId,
      kinds: ['N01', 'N05'],
      schemaVersion: 1,
    });

    expect(prisma.dsvNotificationCapability.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        accountId,
        installationId: 'installation-1',
        shopId,
        tokenHash: 'token-hash',
        tokenUpdatedAt: now,
      }) as unknown,
      where: { tokenId },
    }));
  });

  test('rejects a capability for a different installation', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.driverPushToken.findFirst.mockResolvedValue({
      appId: 'com.evnsolution.clever.driver',
      deviceId: 'installation-2',
      id: tokenId,
      status: 'ACTIVE',
      tokenHash: 'token-hash',
      updatedAt: now,
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.registerCapability({
      installationId: 'installation-1',
      kinds: ['N05'],
      principal: driverPrincipal,
      schemaVersion: 1,
      tokenId,
    })).rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_INVALID' });
  });

  test('rejects an unsupported capability schema version', async () => {
    const { prisma, provider } = createBaseHarness();
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.registerCapability({
      installationId: 'installation-1',
      kinds: ['N05'],
      principal: driverPrincipal,
      schemaVersion: 2,
      tokenId,
    })).rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_INVALID' });
    expect(prisma.driverPushToken.findFirst).not.toHaveBeenCalled();
  });

  test('ack is idempotent and does not resolve the business warning', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({ id: notificationId });
    prisma.dsvOperationalNotificationAck.upsert.mockResolvedValue({ createdAt: now });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.ack({ notificationId, now, principal: driverPrincipal })).resolves.toEqual({
      ackedAt: now.toISOString(),
      notificationId,
    });

    expect(prisma.dsvOperationalNotificationAck.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
      where: { notificationId_accountId_ackKind: { accountId, ackKind: 'READ', notificationId } },
    }));
    expect(prisma.dsvOperationalNotification.updateMany).not.toHaveBeenCalled();
  });

  test('acks an OPS N07 with a scoped UUID actor without resolving the report', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({ id: notificationId });
    prisma.dsvOperationalNotificationAck.upsert.mockResolvedValue({ createdAt: now });
    const actorId = 'a1000000-0000-4000-8000-000000000001';
    const admin = createDsvAdminPrincipal({ actorId, shopId });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.ack({ notificationId, now, principal: admin })).resolves.toEqual({
      ackedAt: now.toISOString(),
      notificationId,
    });

    expect(prisma.dsvOperationalNotification.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { audience: 'OPS', id: notificationId, kind: 'N07', shopId },
    });
    expect(prisma.dsvOperationalNotification.updateMany).not.toHaveBeenCalled();
  });

  test('resolves N03 for the previous recipient without exposing execution detail', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      executionContextId,
      expiresAt: new Date(now.getTime() + 60_000),
      id: notificationId,
      kind: 'N03',
      recipientAccountId: accountId,
      routeVersion: 1,
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.resolve({ notificationId, now, principal: driverPrincipal })).resolves.toEqual({
      destination: { type: 'ASSIGNMENT_RELEASED' },
      notificationId,
    });
    expect(prisma.dsvExecutionContext.findFirst).not.toHaveBeenCalled();
    expect(prisma.routePlan.findFirst).not.toHaveBeenCalled();
  });

  test('limits operations inbox access to N07 and the operations audience', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({
      assignmentEpoch: 1n,
      audience: 'OPS',
      businessStatus: 'OPEN',
      eventId: 'a0000000-0000-4000-8000-000000000001',
      executionContextId,
      expiresAt: new Date(now.getTime() + 60_000),
      id: notificationId,
      kind: 'N07',
      recipientAccountId: null,
      routeVersion: 1,
      targetStopId: 'b0000000-0000-4000-8000-000000000001',
    });
    prisma.dsvDeliveryException.findFirst.mockResolvedValue({ id: 'a0000000-0000-4000-8000-000000000001' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);
    const admin = createDsvAdminPrincipal({ actorId: 'admin', shopId });

    await expect(service.resolve({ notificationId, now, principal: admin })).resolves.toEqual({
      destination: {
        executionContextId,
        reportId: 'a0000000-0000-4000-8000-000000000001',
        targetStopId: 'b0000000-0000-4000-8000-000000000001',
        type: 'OPERATIONS_EXCEPTION',
      },
      notificationId,
    });
  });

  test('allows a resolved N05 to open the still-current execution without mutating it', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'RESOLVED',
      eventId: null,
      executionContextId,
      expiresAt: new Date(now.getTime() + 60_000),
      id: notificationId,
      kind: 'N05',
      recipientAccountId: accountId,
      routeVersion: 1,
      targetStopId: null,
    });
    mockCurrentContext(prisma);
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.resolve({ notificationId, now, principal: driverPrincipal })).resolves.toEqual({
      destination: { executionContextId, routePlanId, type: 'EXECUTION' },
      notificationId,
    });
    expect(prisma.dsvExecutionContext.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ routeVersion: 1 }) as unknown,
    }));
    expect(prisma.dsvOperationalNotification.updateMany).not.toHaveBeenCalled();
  });

  test('rejects an N06 destination that is terminal in the current route', async () => {
    const { prisma, provider } = createBaseHarness();
    const targetStopId = 'b0000000-0000-4000-8000-000000000001';
    prisma.dsvOperationalNotification.findFirst.mockResolvedValue({
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      eventId: null,
      executionContextId,
      expiresAt: new Date(now.getTime() + 60_000),
      id: notificationId,
      kind: 'N06',
      recipientAccountId: accountId,
      routeVersion: 1,
      targetStopId,
    });
    mockCurrentContext(prisma);
    prisma.routePlanStop.findFirst.mockResolvedValue({ deliveryStop: { status: 'DELIVERED' } });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider);

    await expect(service.resolve({ notificationId, now, principal: driverPrincipal }))
      .rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_NOT_FOUND' });
  });
});

describe('PrismaDsvOperationalDriverNotificationService sender', () => {
  test('keeps live sending off when required policy decisions are absent', async () => {
    const { prisma, provider } = createBaseHarness();
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma as never,
      provider,
      disabledDsvOperationalNotificationSendPolicy,
    );

    await expect(service.runOnce(now)).resolves.toEqual({
      attempted: 0,
      blockedByPolicy: true,
      dead: 0,
      sent: 0,
      skipped: 0,
    });
    expect(provider.send).not.toHaveBeenCalled();
  });

  test('blocks live sending when the approved geofence policy version is missing', async () => {
    const { prisma, provider } = createBaseHarness();
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma as never,
      provider,
      { ...livePolicy, approvedGeofencePolicyVersion: null },
    );

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 0, blockedByPolicy: true });
    expect(provider.send).not.toHaveBeenCalled();
  });

  test('sends one minimal payload after current ownership and policy revalidation', async () => {
    const { prisma, provider } = createSenderHarness();
    provider.send.mockResolvedValue({ providerMessageId: 'fcm-1', status: 'SENT' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toEqual({
      attempted: 1,
      blockedByPolicy: false,
      dead: 0,
      sent: 1,
      skipped: 0,
    });

    expect(provider.send).toHaveBeenCalledWith({
      body: '배송 시작이 확인되지 않았습니다. 안전한 곳에 정차한 후 시작 버튼을 눌러주세요.',
      collapseKey: `${executionContextId}:N05`,
      payload: {
        expiresAt: '2026-10-06T02:35:00.000Z',
        kind: 'N05',
        notificationId,
        schemaVersion: '1',
      },
      title: '운행 시작 확인이 필요합니다',
      token: 'push-token',
      ttlMs: 300_000,
    });
    expect(JSON.stringify(provider.send.mock.calls[0]?.[0])).not.toContain(routePlanId);
    expect(JSON.stringify(provider.send.mock.calls[0]?.[0])).not.toContain('latitude');
  });

  test('sends N05 beyond six without a configured business cap', async () => {
    const { prisma, provider } = createSenderHarness({ ordinal: 8 });
    provider.send.mockResolvedValue({ status: 'SENT' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider,
      { ...livePolicy, businessReminderCap: null }, { clock: () => now });
    await expect(service.runOnce(now)).resolves.toMatchObject({ sent: 1 });
  });

  test.each(['2026-10-06T03:00:00.000Z', '2026-10-07T01:00:00.000Z'])('blocks old queued N05 at %s', async (at) => {
    const { notification, prisma, provider } = createSenderHarness();
    const boundary = new Date(at);
    notification.createdAt = new Date(boundary.getTime() - 60_000);
    notification.dueAt = notification.createdAt;
    notification.expiresAt = new Date(boundary.getTime() + 86_400_000);
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider,
      { ...livePolicy, notificationRetentionMs: 2 * 86_400_000 }, { clock: () => boundary });
    await expect(service.runOnce(boundary)).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  test('checks noon after the final asynchronous lease lookup', async () => {
    const { notification, prisma, provider } = createSenderHarness();
    let clock = new Date('2026-10-06T02:59:59.900Z');
    notification.createdAt = clock;
    notification.dueAt = clock;
    const first: unknown = await prisma.dsvOperationalNotificationAttempt.findFirst();
    prisma.dsvOperationalNotificationAttempt.findFirst
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => {
        clock = new Date('2026-10-06T03:00:00.000Z');
        return Promise.resolve(first);
      });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => clock });
    await expect(service.runOnce(clock)).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'MISSING_START_EXPIRED', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('limits provider TTL to noon and does not schedule a retry across noon', async () => {
    const { notification, prisma, provider } = createSenderHarness();
    let clock = new Date('2026-10-06T02:59:59.000Z');
    notification.createdAt = clock;
    notification.dueAt = clock;
    provider.send.mockImplementation(() => {
      clock = new Date('2026-10-06T03:00:00.000Z');
      return Promise.resolve({ errorCode: 'TEMPORARY', status: 'FAILED' as const });
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => clock });
    await expect(service.runOnce(clock)).resolves.toMatchObject({ sent: 0, dead: 1 });
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      ttlMs: 1_000, payload: expect.objectContaining({ expiresAt: '2026-10-06T03:00:00.000Z' }) as unknown,
    }));
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DEAD' }) as unknown,
    }));
  });

  test.each(['N01', 'N02', 'N04'] as const)('does not apply the N05 noon cutoff to %s', async (kind) => {
    const { notification, prisma, provider } = createSenderHarness({ kind });
    const afterNoon = new Date('2026-10-06T04:00:00.000Z');
    notification.createdAt = afterNoon;
    notification.dueAt = afterNoon;
    notification.expiresAt = new Date(afterNoon.getTime() + 3_600_000);
    provider.send.mockResolvedValue({ status: 'SENT' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider,
      { ...livePolicy, allowedKinds: [kind] }, { clock: () => afterNoon });
    await expect(service.runOnce(afterNoon)).resolves.toMatchObject({ sent: 1 });
  });

  test('uses the future execution service date for N01 push instead of the send date', async () => {
    const { prisma, provider } = createSenderHarness({ kind: 'N01' });
    provider.send.mockResolvedValue({ providerMessageId: 'fcm-n01', status: 'SENT' });
    const policy = { ...livePolicy, allowedKinds: ['N01'] as const };
    const sendDate = now;
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policy, { clock: () => sendDate });

    await expect(service.runOnce(sendDate)).resolves.toMatchObject({ sent: 1 });

    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      body: '앱에서 새 배차를 확인해 주세요.',
      title: '1월 2일 배차가 등록되었습니다.',
    }));
  });

  test('keeps the same N01 service-date copy across a provider retry', async () => {
    const { prisma, provider } = createSenderHarness({ kind: 'N01' });
    provider.send
      .mockResolvedValueOnce({ errorCode: 'TEMPORARY', status: 'FAILED' })
      .mockResolvedValueOnce({ providerMessageId: 'fcm-n01-retry', status: 'SENT' });
    const policy = { ...livePolicy, allowedKinds: ['N01'] as const };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policy, { clock: () => now });

    await service.runOnce(now);
    await service.runOnce(now);

    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.send.mock.calls.map(([message]) => message.title)).toEqual([
      '1월 2일 배차가 등록되었습니다.',
      '1월 2일 배차가 등록되었습니다.',
    ]);
  });

  test('re-reads the notification authority immediately before provider send', async () => {
    const { notification, prisma, provider } = createSenderHarness();
    prisma.dsvOperationalNotification.findFirst
      .mockResolvedValueOnce(notification)
      .mockResolvedValueOnce({ ...notification, businessStatus: 'RESOLVED' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });

    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'NOTIFICATION_NOT_OPEN', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('honors a dynamic policy kill switch immediately before provider send', async () => {
    const { prisma, provider } = createSenderHarness();
    let reads = 0;
    const policySource = () => {
      reads += 1;
      return reads >= 4 ? disabledDsvOperationalNotificationSendPolicy : livePolicy;
    };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policySource, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });

    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'LIVE_POLICY_DISABLED', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('honors a policy kill switch that changes during the N01 service-date read', async () => {
    const { context, prisma, provider } = createSenderHarness({ kind: 'N01' });
    const n01Policy = { ...livePolicy, allowedKinds: ['N01'] as const };
    let disabledDuringDateRead = false;
    prisma.dsvExecutionContext.findFirst.mockImplementation((query: { select?: Record<string, boolean> }) => {
      if (query.select?.serviceDate === true && Object.keys(query.select).length === 1) {
        disabledDuringDateRead = true;
        return Promise.resolve({ serviceDate: context.serviceDate });
      }
      return Promise.resolve(context);
    });
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma as never,
      provider,
      () => disabledDuringDateRead ? disabledDsvOperationalNotificationSendPolicy : n01Policy,
      { clock: () => now },
    );

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });

    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'LIVE_POLICY_DISABLED', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('rejects a current execution when its assigned vehicle is inactive', async () => {
    const { prisma, provider } = createSenderHarness();
    prisma.routePlan.findFirst.mockResolvedValue({
      driver: { accountId, status: 'ACTIVE' },
      driverId: driverPrincipal.driverId,
      status: 'IN_PROGRESS',
      vehicle: { status: 'INACTIVE' },
      vehicleId: 'vehicle-1',
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  test('materializes an unattempted later intent instead of reselecting attempted open intents', async () => {
    const { prisma, provider } = createBaseHarness();
    prisma.$queryRaw.mockResolvedValue([{ id: notificationId, kind: 'N05', recipientAccountId: accountId, shopId }]);
    prisma.dsvNotificationCapability.findMany.mockResolvedValue([{ id: capabilityId, kinds: ['N05'], tokenId }]);
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy);

    await service.runOnce(now);

    expect(prisma.dsvOperationalNotificationAttempt.createMany).toHaveBeenCalledWith({
      data: [{ capabilityId, nextAttemptAt: now, notificationId, shopId, tokenId }],
      skipDuplicates: true,
    });
  });

  test('rejects old worker completion when its lease fence is no longer current', async () => {
    const { prisma, provider } = createSenderHarness();
    provider.send.mockResolvedValue({ providerMessageId: 'late-fcm', status: 'SENT' });
    prisma.dsvOperationalNotificationAttempt.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const logger = { warn: vi.fn() };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now }, logger);

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      { attemptId },
      'Rejected stale operational notification worker completion.',
    );
  });

  test('keeps provider retries separate from the logical reminder ordinal', async () => {
    const { prisma, provider } = createSenderHarness({ attemptCount: 1, ordinal: 2 });
    provider.send.mockResolvedValue({ errorCode: 'TEMPORARY', status: 'FAILED' });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, dead: 0, sent: 0, skipped: 1 });

    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        errorCode: 'TEMPORARY',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        status: 'RETRY',
      }) as unknown,
      where: expect.objectContaining({ id: attemptId, status: 'LEASED' }) as unknown,
    });
    expect(prisma.dsvOperationalNotification.updateMany).not.toHaveBeenCalled();
  });

  test('marks a reclaimed lease dead before provider send when the claim budget is exceeded', async () => {
    const { prisma, provider } = createSenderHarness({ attemptCount: 4 });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, dead: 1, sent: 0, skipped: 0 });

    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith({
      data: {
        completedAt: now,
        errorCode: 'PROVIDER_ATTEMPT_CAP_REACHED',
        leaseExpiresAt: null,
        leaseToken: null,
        status: 'DEAD',
      },
      where: expect.objectContaining({ id: attemptId, status: 'LEASED' }) as unknown,
    });
  });

  test('does not send a kind missing from the installation capability', async () => {
    const { prisma, provider } = createSenderHarness();
    prisma.dsvNotificationCapability.findFirst.mockResolvedValue({
      accountId,
      id: capabilityId,
      installationId: 'installation-1',
      kinds: ['N01'],
      schemaVersion: 1,
      shopId,
      tokenHash: 'token-hash',
      tokenId,
      tokenUpdatedAt: now,
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'KIND_UNSUPPORTED', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('revalidates N06 stop membership and terminal state before provider send', async () => {
    const { prisma, provider } = createSenderHarness({ kind: 'N06' });
    prisma.routePlanStop.findFirst.mockResolvedValue({ deliveryStop: { status: 'DELIVERED' } });
    const policy = { ...livePolicy, allowedKinds: ['N06'] as const };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'TARGET_STOP_STALE', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('does not send N04 after the execution has started', async () => {
    const { prisma, provider } = createSenderHarness({ kind: 'N04' });
    prisma.dsvExecutionContext.findFirst.mockResolvedValue({
      closedAt: null,
      driverId: driverPrincipal.driverId,
      id: executionContextId,
      liveEligibleAt: new Date('2026-10-06T02:00:00.000Z'),
      monitorEndAt: new Date('2026-10-06T04:00:00.000Z'),
      monitorStartAt: new Date('2026-10-06T02:00:00.000Z'),
      notificationMode: 'LIVE',
      policy: { authorizationId: 'change-control-123', policyVersion: 'synthetic-v1' },
      routePlanId,
      startedAt: now,
      status: 'ACTIVE',
      vehicleId: 'vehicle-1',
    });
    const policy = { ...livePolicy, allowedKinds: ['N04'] as const };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.dsvOperationalNotificationAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ errorCode: 'START_ALREADY_RECORDED', status: 'SKIPPED' }) as unknown,
    }));
  });

  test('permits a limited N03 release for a cancelled execution', async () => {
    const { prisma, provider, notification } = createSenderHarness({ kind: 'N03' });
    provider.send.mockResolvedValue({ providerMessageId: 'release-fcm', status: 'SENT' });
    prisma.dsvExecutionContext.findFirst.mockResolvedValue({
      closedAt: now,
      liveEligibleAt: new Date('2026-10-06T02:00:00.000Z'),
      monitorEndAt: new Date('2026-10-06T02:30:00.000Z'),
      monitorStartAt: new Date('2026-10-06T02:00:00.000Z'),
      notificationMode: 'LIVE',
      policy: { authorizationId: 'change-control-123', policyVersion: 'synthetic-v1' },
      status: 'CANCELLED',
    });
    const policy = { ...livePolicy, allowedKinds: ['N03'] as const };
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, policy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ sent: 1, skipped: 0 });
    expect(notification.kind).toBe('N03');
    expect(prisma.routePlan.findFirst).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ kind: 'N03' }) as unknown,
    }));
  });

  test('does not revoke a token when an invalid-token result loses the lease CAS', async () => {
    const { prisma, provider } = createSenderHarness();
    provider.send.mockResolvedValue({
      errorCode: 'messaging/registration-token-not-registered',
      invalidToken: true,
      status: 'FAILED',
    });
    prisma.dsvOperationalNotificationAttempt.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ dead: 0, skipped: 1 });
    expect(prisma.driverPushToken.updateMany).not.toHaveBeenCalled();
  });

  test('revokes an invalid token only after the lease CAS succeeds in the same transaction', async () => {
    const { prisma, provider } = createSenderHarness();
    provider.send.mockResolvedValue({
      errorCode: 'messaging/registration-token-not-registered',
      invalidToken: true,
      status: 'FAILED',
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma as never, provider, livePolicy, { clock: () => now });

    await expect(service.runOnce(now)).resolves.toMatchObject({ dead: 1, skipped: 0 });
    expect(prisma.driverPushToken.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: now, status: 'INVALID' },
      where: { id: tokenId, tokenHash: 'token-hash' },
    });
  });
});

function createBaseHarness() {
  const transaction = vi.fn();
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: transaction,
    driver: {
      findFirst: vi.fn().mockResolvedValue({ account: { status: 'ACTIVE' }, accountId, status: 'ACTIVE' }),
    },
    driverAccount: {},
    driverPushToken: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    dsvDeliveryException: { findFirst: vi.fn() },
    dsvExecutionContext: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    dsvNotificationCapability: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    dsvOperationalNotification: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    dsvOperationalNotificationAck: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    dsvOperationalNotificationAttempt: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    routePlan: { findFirst: vi.fn() },
    routeGroupingChildVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'published-child-1' }) },
    routePlanStop: { findFirst: vi.fn() },
  };
  transaction.mockImplementation(async (operation: unknown) => {
    if (typeof operation === 'function') return (operation as (client: typeof prisma) => unknown)(prisma);
    return Promise.all(operation as Promise<unknown>[]);
  });
  const provider = {
    providerName: 'fake-fcm',
    send: vi.fn<DsvOperationalPushProvider['send']>(),
  };
  return { prisma, provider };
}

function createSenderHarness(overrides: { attemptCount?: number; kind?: 'N01' | 'N02' | 'N03' | 'N04' | 'N05' | 'N06'; ordinal?: number } = {}) {
  const { prisma, provider } = createBaseHarness();
  const notification = {
    assignmentEpoch: 1n,
    audience: 'DRIVER',
    businessStatus: 'OPEN',
    createdAt: now,
    dueAt: now,
    executionContextId,
    expiresAt: new Date('2026-10-06T04:00:00.000Z'),
    id: notificationId,
    kind: overrides.kind ?? 'N05',
    ordinal: overrides.ordinal ?? 1,
    recipientAccountId: accountId,
    routeVersion: 1,
    targetStopId: overrides.kind === 'N06' ? 'b0000000-0000-4000-8000-000000000001' : null,
  };
  prisma.dsvOperationalNotification.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([{ id: notificationId, kind: notification.kind, recipientAccountId: accountId, shopId }]);
  prisma.dsvNotificationCapability.findMany.mockResolvedValue([{ id: capabilityId, kinds: [notification.kind], tokenId }]);
  prisma.dsvOperationalNotificationAttempt.findMany.mockResolvedValue([{
    id: attemptId,
    leaseExpiresAt: null,
    status: 'PENDING',
  }]);
  prisma.dsvOperationalNotificationAttempt.updateMany.mockResolvedValue({ count: 1 });
  prisma.dsvOperationalNotificationAttempt.findFirst.mockResolvedValue({
    attemptCount: overrides.attemptCount ?? 1,
    capabilityId,
    id: attemptId,
    notificationId,
    shopId,
    tokenId,
  });
  prisma.dsvOperationalNotification.findFirst.mockResolvedValue(notification);
  prisma.dsvNotificationCapability.findFirst.mockResolvedValue({
    accountId,
    id: capabilityId,
    installationId: 'installation-1',
    kinds: [notification.kind],
    schemaVersion: 1,
    shopId,
    tokenHash: 'token-hash',
    tokenId,
    tokenUpdatedAt: now,
  });
  prisma.driverPushToken.findUnique.mockResolvedValue({
    account: { status: 'ACTIVE' },
    accountId,
    appId: 'com.evnsolution.clever.driver',
    deviceId: 'installation-1',
    devicePushToken: 'push-token',
    id: tokenId,
    status: 'ACTIVE',
    tokenHash: 'token-hash',
    updatedAt: now,
  });
  const context = {
    closedAt: null,
    driverId: driverPrincipal.driverId,
    id: executionContextId,
    liveEligibleAt: new Date('2026-10-06T02:00:00.000Z'),
    monitorEndAt: new Date('2026-10-06T04:00:00.000Z'),
    monitorStartAt: new Date('2026-10-06T02:00:00.000Z'),
    notificationMode: 'LIVE',
    policy: { authorizationId: 'change-control-123', policyVersion: 'synthetic-v1' },
    routePlanId,
    serviceDate: new Date(overrides.kind === 'N01' ? '2027-01-02T00:00:00.000Z' : '2026-10-06T00:00:00.000Z'),
    startedAt: null,
    status: 'ACTIVE',
    vehicleId: 'vehicle-1',
  };
  prisma.dsvExecutionContext.findFirst.mockResolvedValue(context);
  prisma.routePlan.findFirst.mockResolvedValue({
    driver: { accountId, status: 'ACTIVE' },
    driverId: driverPrincipal.driverId,
    status: 'IN_PROGRESS',
    vehicle: { status: 'ACTIVE' },
    vehicleId: 'vehicle-1',
  });
  return { context, notification, prisma, provider };
}

function mockCurrentContext(prisma: ReturnType<typeof createBaseHarness>['prisma']): void {
  prisma.dsvExecutionContext.findFirst.mockResolvedValue({
    closedAt: null,
    driverId: driverPrincipal.driverId,
    id: executionContextId,
    liveEligibleAt: new Date('2026-10-06T02:00:00.000Z'),
    monitorEndAt: new Date('2026-10-06T04:00:00.000Z'),
    monitorStartAt: new Date('2026-10-06T02:00:00.000Z'),
    notificationMode: 'LIVE',
    policy: { authorizationId: 'change-control-123', policyVersion: 'synthetic-v1' },
    routePlanId,
    startedAt: null,
    status: 'ACTIVE',
    vehicleId: 'vehicle-1',
  });
  prisma.routePlan.findFirst.mockResolvedValue({
    driver: { accountId, status: 'ACTIVE' },
    driverId: driverPrincipal.driverId,
    status: 'IN_PROGRESS',
    vehicle: { status: 'ACTIVE' },
    vehicleId: 'vehicle-1',
  });
}
