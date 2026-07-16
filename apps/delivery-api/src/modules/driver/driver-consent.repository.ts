import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import type {
  RecordDriverConsentsInput,
  RecordDriverConsentsResult
} from './driver-consent.types.js';
type DriverConsentPrismaClient = Pick<PrismaClient, 'driverConsentRecord' | 'routePlan'>;

export class DriverRouteAssignmentError extends Error {
  constructor(
    message: string,
    readonly code: 'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH' | 'ROUTE_ASSIGNMENT_NOT_FOUND'
  ) {
    super(message);
    this.name = 'DriverRouteAssignmentError';
  }
}

export class PrismaDriverConsentRepository {
  constructor(private readonly prisma: DriverConsentPrismaClient) {}

  async recordDriverConsents(input: RecordDriverConsentsInput): Promise<RecordDriverConsentsResult> {
    const routePlan = await this.prisma.routePlan.findUnique({
      select: { driverId: true, shopId: true, driver: { select: { accountId: true } } },
      where: { id: input.routePlanId }
    });
    if (routePlan === null || routePlan.driver === null || routePlan.driverId === null) {
      throw new DriverRouteAssignmentError('Route assignment not found', 'ROUTE_ASSIGNMENT_NOT_FOUND');
    }
    if (routePlan.driver.accountId !== input.accountId) {
      throw new DriverRouteAssignmentError(
        'Route assignment account mismatch',
        'ROUTE_ASSIGNMENT_ACCOUNT_MISMATCH'
      );
    }

    const appContext = jsonOrNull(input.appContext);
    const deviceContext = jsonOrNull(input.deviceContext);

    const records = await Promise.all(
      input.consents.map(async (consent) => {
        const record = await this.prisma.driverConsentRecord.upsert({
          create: {
            accepted: consent.accepted,
            accountId: input.accountId,
            appContext,
            consentType: consent.type,
            consentVersion: consent.version,
            deviceContext,
            driverId: routePlan.driverId,
            recordedAt: input.recordedAt,
            routeContext: input.routePlanId,
            shopId: routePlan.shopId
          },
          update: {
            accepted: consent.accepted,
            appContext,
            deviceContext,
            driverId: routePlan.driverId,
            recordedAt: input.recordedAt,
            routeContext: input.routePlanId,
            shopId: routePlan.shopId
          },
          where: {
            accountId_consentType_consentVersion: {
              accountId: input.accountId,
              consentType: consent.type,
              consentVersion: consent.version
            }
          }
        });

        return {
          accepted: record.accepted,
          type: record.consentType,
          version: record.consentVersion
        };
      })
    );

    return {
      status: 'CONSENT_RECORDED',
      recordedAt: input.recordedAt.toISOString(),
      records
    };
  }
}

function jsonOrNull(value: Record<string, unknown> | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) {
    return Prisma.JsonNull;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
