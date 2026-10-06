import type { Prisma } from '@prisma/client';
import { closeDsvExecutionForRoute, syncDsvExecutionForRoute } from './dsv-execution-context.service.js';

// Legacy narrow repository ports and older test doubles have no operational delegates.
// A generated production transaction always has them; database errors still roll back its domain write.
function operationalTransaction(value: unknown): Prisma.TransactionClient | null {
  if (value === null || typeof value !== 'object' || !('dsvExecutionContext' in value)) return null;
  return value as Prisma.TransactionClient;
}

export async function syncDsvExecutionHook(value: unknown, input: {
  shopId: string; routePlanId: string; commandId: string; firstPublication?: boolean;
  previousPublishedAt?: Date | null; now?: Date;
}): Promise<void> {
  const tx = operationalTransaction(value);
  if (tx !== null) await syncDsvExecutionForRoute(tx, input);
}

export async function closeDsvExecutionHook(value: unknown, input: {
  shopId: string; routePlanId: string; reason: 'COMPLETED' | 'CANCELLED'; now?: Date;
}): Promise<void> {
  const tx = operationalTransaction(value);
  if (tx !== null) await closeDsvExecutionForRoute(tx, input);
}

export async function syncDsvDriverAttributionHook(value: unknown, input: {
  driverId: string; commandId: string;
}): Promise<void> {
  const tx = operationalTransaction(value);
  if (tx === null) return;
  const contexts = await tx.dsvExecutionContext.findMany({
    where: { driverId: input.driverId, status: 'ACTIVE' }, orderBy: { routePlanId: 'asc' },
    select: { routePlanId: true, shopId: true },
  });
  for (const context of contexts) {
    await syncDsvExecutionForRoute(tx, { ...context, commandId: `${input.commandId}:${context.routePlanId}` });
  }
}

export async function resolveDsvStopNotificationsHook(value: unknown, input: {
  deliveryStopId: string; shopId: string; now?: Date;
}): Promise<void> {
  const tx = operationalTransaction(value);
  if (tx === null) return;
  await tx.dsvOperationalNotification.updateMany({
    where: {
      audience: 'DRIVER', businessStatus: 'OPEN', kind: 'N06',
      shopId: input.shopId, targetStopId: input.deliveryStopId,
    },
    data: { businessStatus: 'RESOLVED', resolutionReason: 'STOP_TERMINAL', resolvedAt: input.now ?? new Date() },
  });
}
