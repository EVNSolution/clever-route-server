import type { DriverPushToken, PrismaClient } from '@prisma/client';

import { DSV_OPERATIONAL_DRIVER_APP_ID, type DsvOperationalDriverNotificationKind } from './dsv-operational-driver-notification.provider.js';
import { isCompleteLivePolicy, type DsvOperationalNotificationSendPolicySource } from './dsv-operational-driver-notification.service.js';

type RoutingPrisma = Pick<PrismaClient,
  'dsvExecutionContext' | 'dsvOperationalNotification' | 'dsvNotificationCapability' | 'driverPushToken' | 'routePlan' | 'vehicle'>;

/** A publication/change token belongs to one channel for the current installation generation. */
export async function legacyDsvNotificationTokens<T extends Pick<DriverPushToken, 'id' | 'appId' | 'tokenHash' | 'updatedAt' | 'deviceId'>>(
  value: unknown,
  policySource: DsvOperationalNotificationSendPolicySource,
  input: { accountId: string; action: string; routePlanId: string; tokens: T[]; now?: Date },
): Promise<T[]> {
  const policy = typeof policySource === 'function' ? policySource() : policySource;
  if (!isCompleteLivePolicy(policy)) return input.tokens;
  if (!policy.allowedAccountIds.includes(input.accountId)) return input.tokens;
  const release = input.action === 'released' || input.action === 'cancelled';
  if (value === null || typeof value !== 'object' || !('dsvExecutionContext' in value)) {
    throw new Error('Live DSV channel routing requires operational storage');
  }
  const prisma = value as RoutingPrisma;
  const now = input.now ?? new Date();
  const kinds: DsvOperationalDriverNotificationKind[] = release ? ['N03'] : ['N01', 'N02'];
  const contexts = await prisma.dsvExecutionContext.findMany({
    where: { routePlanId: input.routePlanId, notificationMode: 'LIVE', liveEligibleAt: { lte: now } },
  });
  const reserved = new Set<string>();
  for (const context of contexts) {
    const contextPolicy = context.policy as Record<string, unknown> | null;
    if (!policy.allowedShopIds.includes(context.shopId)) continue;
    if (!release && (context.status !== 'ACTIVE' || context.closedAt !== null || context.recipientAccountId !== input.accountId)) continue;
    if (contextPolicy?.authorizationId !== policy.approvedAuthorizationId) continue;
    const intent = await prisma.dsvOperationalNotification.findFirst({
      where: { shopId: context.shopId, executionContextId: context.id, recipientAccountId: input.accountId,
        kind: { in: kinds.filter((kind) => policy.allowedKinds.includes(kind)) }, businessStatus: 'OPEN',
        createdAt: { gte: context.liveEligibleAt! }, dueAt: { lte: now }, expiresAt: { gt: now },
        ...(release ? {} : { routeVersion: context.routeVersion, assignmentEpoch: context.assignmentEpoch }) },
      orderBy: { createdAt: 'desc' },
    });
    if (intent === null) continue;
    if (intent.expiresAt.getTime() - intent.createdAt.getTime() > policy.notificationRetentionMs!) continue;
    if (release) {
      const releaseIsCurrent = context.closedAt !== null || context.status !== 'ACTIVE'
        || (context.assignmentEpoch > intent.assignmentEpoch && context.recipientAccountId !== input.accountId);
      if (!releaseIsCurrent) continue;
    } else {
      const route = await prisma.routePlan.findFirst({
        where: { id: context.routePlanId, shopId: context.shopId },
        select: {
          driverId: true, status: true, vehicleId: true, driver: { select: { accountId: true, status: true } },
          routeGroupingChildVersions: {
            where: { status: 'CURRENT', supersededAt: null, publishedAt: { not: null }, driverId: context.driverId },
            take: 1, select: { id: true },
          },
        },
      });
      if (route === null || ['CANCELLED', 'COMPLETED', 'INCOMPLETE'].includes(route.status)
        || route.driverId !== context.driverId || route.vehicleId !== context.vehicleId
        || route.driver?.status !== 'ACTIVE' || route.driver.accountId !== input.accountId
        || route.routeGroupingChildVersions.length !== 1) continue;
      if (context.vehicleId === null || await prisma.vehicle.findFirst({
        where: { id: context.vehicleId, shopId: context.shopId, status: 'ACTIVE' }, select: { id: true },
      }) === null) continue;
    }
    const capabilities = await prisma.dsvNotificationCapability.findMany({
      where: { shopId: context.shopId, accountId: input.accountId, tokenId: { in: input.tokens.map((token) => token.id) }, kinds: { has: intent.kind } },
    });
    for (const token of input.tokens) {
      if (token.appId !== DSV_OPERATIONAL_DRIVER_APP_ID) continue;
      const capability = capabilities.find((item) => item.tokenId === token.id);
      if (capability !== undefined && capability.schemaVersion === 1 && capability.tokenHash === token.tokenHash
        && capability.tokenUpdatedAt.getTime() === token.updatedAt.getTime()
        && token.deviceId !== null && token.deviceId === capability.installationId) {
        const current = await prisma.driverPushToken.findUnique({
          where: { id: token.id },
          select: { accountId: true, account: { select: { status: true } }, status: true, tokenHash: true, updatedAt: true },
        });
        if (current?.status === 'ACTIVE' && current.account.status === 'ACTIVE'
          && current.accountId === input.accountId && current.tokenHash === token.tokenHash
          && current.updatedAt.getTime() === token.updatedAt.getTime()) reserved.add(token.id);
      }
    }
  }
  return input.tokens.filter((token) => !reserved.has(token.id));
}
