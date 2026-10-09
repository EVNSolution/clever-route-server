import type { PrismaClient } from '@prisma/client';
import type { RecordDriverEventResult } from './driver-event.repository.js';
import { getPrivateDriverDemoConfig, privateDriverDemoVisibilityWhere } from './private-driver-demo.js';

export type DriverEventReceipt = {
  assignmentGeneration: string | null;
  clientEventId: string;
  completion?: RecordDriverEventResult['completion'];
  errorCode: string | null;
  expectedRouteVersionId: string | null;
  routePlanId: string;
  routeStatus: string;
  status: 'APPLIED' | 'REJECTED' | 'UNKNOWN';
};

export class DriverEventReceiptScopeError extends Error {
  constructor() {
    super('Driver event receipt is outside the authenticated account scope');
    this.name = 'DriverEventReceiptScopeError';
  }
}

type ReceiptPrismaClient = Pick<PrismaClient, 'driverEvent' | 'driverEventAttempt' | 'routePlan'>;

export class PrismaDriverEventReceiptRepository {
  constructor(private readonly prisma: ReceiptPrismaClient) {}

  async lookup(input: {
    accountId: string;
    clientEventId: string;
    routePlanId: string;
  }): Promise<DriverEventReceipt> {
    // Historical event ownership alone must not grant another account access to
    // a private route after its driver record or assignment changes.
    const privateConfig = getPrivateDriverDemoConfig();
    const routeVisibility = privateDriverDemoVisibilityWhere(privateConfig?.accountId === input.accountId ? process.env : {});
    const committed = await this.prisma.driverEvent.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        assignmentGeneration: true,
        clientEventId: true,
        stopCompletionReceipt: { select: { result: true } },
        expectedRouteVersionId: true,
        routePlan: { select: { status: true } },
        routePlanId: true
      },
      where: {
        clientEventId: input.clientEventId,
        driver: { accountId: input.accountId },
        routePlan: { is: routeVisibility },
        routePlanId: input.routePlanId
      }
    });
    if (committed !== null && committed.clientEventId !== null && committed.routePlanId !== null && committed.routePlan !== null) {
      const completion = readStoredCompletion(committed.stopCompletionReceipt?.result);
      return {
        assignmentGeneration: committed.assignmentGeneration?.toString() ?? null,
        clientEventId: committed.clientEventId,
        ...(completion === undefined ? {} : { completion }),
        errorCode: null,
        expectedRouteVersionId: committed.expectedRouteVersionId,
        routePlanId: committed.routePlanId,
        routeStatus: committed.routePlan.status,
        status: 'APPLIED'
      };
    }

    const attempt = await this.prisma.driverEventAttempt.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        assignmentGeneration: true,
        clientEventId: true,
        errorCode: true,
        expectedRouteVersionId: true,
        retryable: true,
        routePlan: { select: { status: true } },
        routePlanId: true,
        status: true
      },
      where: {
        clientEventId: input.clientEventId,
        driver: { accountId: input.accountId },
        routePlan: { is: routeVisibility },
        routePlanId: input.routePlanId
      }
    });
    if (attempt !== null && attempt.clientEventId !== null && attempt.routePlanId !== null && attempt.routePlan !== null) {
      const rejected = attempt.status === 'REJECTED' && attempt.retryable === false;
      return {
        assignmentGeneration: attempt.assignmentGeneration?.toString() ?? null,
        clientEventId: attempt.clientEventId,
        errorCode: rejected ? attempt.errorCode : null,
        expectedRouteVersionId: attempt.expectedRouteVersionId,
        routePlanId: attempt.routePlanId,
        routeStatus: attempt.routePlan.status,
        status: rejected ? 'REJECTED' : 'UNKNOWN'
      };
    }

    const route = await this.prisma.routePlan.findFirst({
      select: { status: true },
      where: { driver: { accountId: input.accountId }, id: input.routePlanId, AND: [routeVisibility] }
    });
    if (route === null) throw new DriverEventReceiptScopeError();
    return {
      assignmentGeneration: null,
      clientEventId: input.clientEventId,
      errorCode: null,
      expectedRouteVersionId: null,
      routePlanId: input.routePlanId,
      routeStatus: route.status,
      status: 'UNKNOWN'
    };
  }
}

function readStoredCompletion(result: unknown): RecordDriverEventResult['completion'] {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const completion = (result as Record<string, unknown>).completion;
  if (completion === null || typeof completion !== 'object' || Array.isArray(completion)) return undefined;
  return completion as NonNullable<RecordDriverEventResult['completion']>;
}

export type DriverEventReceiptServiceApi = Pick<PrismaDriverEventReceiptRepository, 'lookup'>;
