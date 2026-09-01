import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REJECTION_CODES = new Set([
  'ACCOUNT_NOT_FOUND',
  'DUPLICATE_EXTERNAL_REQUEST',
  'IDENTITY_NOT_VERIFIED',
  'LEGAL_HOLD',
]);

export type DriverAccountDeletionLifecycleStatus =
  | 'REQUESTED'
  | 'DEFERRED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'FAILED';

export type DriverAccountDeletionResult = {
  duplicate: boolean;
  requestId: string;
  status: DriverAccountDeletionLifecycleStatus;
  counts?: {
    accountSessionsRevoked: number;
    consentDeviceContextsCleared: number;
    driverFeedbackNotesRedacted: number;
    driverSessionsRevoked: number;
    driversAnonymized: number;
    pushTokensDeleted: number;
    signupInvitesRevoked: number;
  };
};

type DriverAccountDeletionServiceOptions = {
  afterClaim?: () => Promise<void>;
  now?: () => Date;
  processingKey?: () => string;
};

export class DriverAccountDeletionActiveRouteError extends Error {}
export class DriverAccountDeletionNotFoundError extends Error {}
export class DriverAccountDeletionProcessingError extends Error {}

export class PrismaDriverAccountDeletionService {
  private readonly afterClaim: () => Promise<void>;
  private readonly now: () => Date;
  private readonly processingKey: () => string;

  constructor(
    private readonly prisma: PrismaClient,
    options: DriverAccountDeletionServiceOptions = {},
  ) {
    this.afterClaim = options.afterClaim ?? (() => Promise.resolve());
    this.now = options.now ?? (() => new Date());
    this.processingKey = options.processingKey ?? randomUUID;
  }

  async requestVerifiedExternal(input: {
    accountId: string;
    processedBy: string;
    verificationMethod: 'OPERATOR_VERIFIED_CONTACT';
  }): Promise<DriverAccountDeletionResult> {
    assertUuid(input.accountId, 'accountId');
    assertActor(input.processedBy);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const account = await tx.driverAccount.findUnique({
          select: { id: true, status: true },
          where: { id: input.accountId },
        });
        if (account === null || account.status !== 'ACTIVE') {
          throw new DriverAccountDeletionNotFoundError('Active driver account not found');
        }

        const existing = await this.findOrPromoteAccountDeletionRequest(tx, input.accountId);
        if (existing !== null) {
          return {
            duplicate: true,
            requestId: existing.id,
            status: existing.status,
          };
        }

        const activeRoute = await tx.routePlan.findFirst({
          select: { id: true },
          where: {
            driver: { accountId: input.accountId },
            status: 'IN_PROGRESS',
          },
        });
        if (activeRoute !== null) {
          throw new DriverAccountDeletionActiveRouteError(
            'Finish or release the active route before requesting account deletion',
          );
        }

        const request = await tx.driverAccountDeletionRequest.create({
          data: {
            accountId: input.accountId,
            driverDisplayName: null,
            driverPhone: null,
            reason: null,
            requestChannel: 'EXTERNAL_SUPPORT',
            requestedAt: this.now(),
            requestedBy: input.processedBy,
            shopDomain: null,
            status: 'REQUESTED',
            verificationMethod: input.verificationMethod,
          },
          select: { id: true, status: true },
        });
        return {
          duplicate: false,
          requestId: request.id,
          status: request.status,
        };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const concurrent = await this.prisma.driverAccountDeletionRequest.findUnique({
        select: { id: true, status: true },
        where: { accountId: input.accountId },
      });
      if (concurrent === null) throw error;
      return {
        duplicate: true,
        requestId: concurrent.id,
        status: concurrent.status,
      };
    }
  }

  async inspect(requestId: string): Promise<{
    activeRouteCount: number;
    accountPresent: boolean;
    accountSessionCount: number;
    driverCount: number;
    driverSessionCount: number;
    pushTokenCount: number;
    requestId: string;
    signupInviteCount: number;
    status: DriverAccountDeletionLifecycleStatus;
  }> {
    assertUuid(requestId, 'requestId');
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.driverAccountDeletionRequest.findUnique({
        select: { accountId: true, driverId: true, id: true, status: true },
        where: { id: requestId },
      });
      if (request === null) throw new DriverAccountDeletionNotFoundError('Account deletion request not found');
      const drivers = request.accountId === null
        ? request.driverId === null ? [] : [{ id: request.driverId }]
        : await tx.driver.findMany({ select: { id: true }, where: { accountId: request.accountId } });
      const driverIds = drivers.map((driver) => driver.id);
      const [accountSessionCount, driverSessionCount, pushTokenCount, signupInviteCount, activeRouteCount] = await Promise.all([
        request.accountId === null ? 0 : tx.driverAccountSession.count({ where: { accountId: request.accountId, revokedAt: null } }),
        driverIds.length === 0 ? 0 : tx.driverSession.count({ where: { driverId: { in: driverIds }, revokedAt: null } }),
        request.accountId === null ? 0 : tx.driverPushToken.count({ where: { accountId: request.accountId } }),
        driverIds.length === 0 ? 0 : tx.dsvDriverAccountSignupInvite.count({ where: { driverId: { in: driverIds }, revokedAt: null } }),
        driverIds.length === 0 ? 0 : tx.routePlan.count({ where: { driverId: { in: driverIds }, status: 'IN_PROGRESS' } }),
      ]);
      return {
        activeRouteCount,
        accountPresent: request.accountId !== null,
        accountSessionCount,
        driverCount: driverIds.length,
        driverSessionCount,
        pushTokenCount,
        requestId,
        signupInviteCount,
        status: request.status,
      };
    });
  }

  async fulfill(input: { processedBy: string; requestId: string }): Promise<DriverAccountDeletionResult> {
    assertUuid(input.requestId, 'requestId');
    assertActor(input.processedBy);
    const claimed = await this.claim(input.requestId, input.processedBy);
    if (claimed.terminal !== null) return claimed.terminal;
    await this.afterClaim();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.driverAccountDeletionRequest.findFirst({
          select: { accountId: true, driverId: true, id: true, processingKey: true, status: true },
          where: {
            id: input.requestId,
            processingKey: claimed.processingKey,
            status: 'PROCESSING',
          },
        });
        if (request === null) throw new DriverAccountDeletionProcessingError('Account deletion claim was lost');

        const drivers = request.accountId === null
          ? request.driverId === null ? [] : [{ id: request.driverId }]
          : await tx.driver.findMany({ select: { id: true }, where: { accountId: request.accountId } });
        const driverIds = drivers.map((driver) => driver.id);
        const activeRoute = driverIds.length === 0
          ? null
          : await tx.routePlan.findFirst({
              select: { id: true },
              where: { driverId: { in: driverIds }, status: 'IN_PROGRESS' },
            });

        if (activeRoute !== null) {
          const deferred = await tx.driverAccountDeletionRequest.updateMany({
            data: {
              failureCode: null,
              processedAt: null,
              processedBy: input.processedBy,
              processingKey: null,
              processingLeaseExpiresAt: null,
              rejectionCode: null,
              status: 'DEFERRED',
            },
            where: {
              id: input.requestId,
              processingKey: claimed.processingKey,
              status: 'PROCESSING',
            },
          });
          if (deferred.count !== 1) {
            throw new DriverAccountDeletionProcessingError('Account deletion claim was lost before deferral');
          }
          return { duplicate: false, requestId: input.requestId, status: 'DEFERRED' };
        }

        const counts = {
          accountSessionsRevoked: 0,
          consentDeviceContextsCleared: 0,
          driverFeedbackNotesRedacted: 0,
          driverSessionsRevoked: 0,
          driversAnonymized: 0,
          pushTokensDeleted: 0,
          signupInvitesRevoked: 0,
        };

        if (request.accountId !== null) {
          const accountSessions = await tx.driverAccountSession.updateMany({
            data: { revokedAt: this.now() },
            where: { accountId: request.accountId, revokedAt: null },
          });
          const pushTokens = await tx.driverPushToken.deleteMany({ where: { accountId: request.accountId } });
          await tx.driverAccount.update({
            data: {
              failedPasswordAttempts: 0,
              failedPinAttempts: 0,
              loginId: null,
              name: null,
              passwordHash: null,
              passwordLockedUntil: null,
              passwordSalt: null,
              phone: `deleted:${request.accountId}`,
              pinHash: null,
              pinLockedUntil: null,
              pinSalt: null,
              residentNumberFrontFingerprint: null,
              status: 'INACTIVE',
              tokenVersion: { increment: 1 },
            },
            where: { id: request.accountId },
          });
          counts.accountSessionsRevoked = accountSessions.count;
          counts.pushTokensDeleted = pushTokens.count;
        }

        if (driverIds.length > 0) {
          const [driversAnonymized, driverSessions, signupInvites, consentRecords, feedback] = await Promise.all([
            tx.driver.updateMany({
              data: {
                authSubject: null,
                displayName: 'Deleted driver',
                inviteCode: null,
                inviteCodeExpiresAt: null,
                lastSeenAt: null,
                phone: null,
                status: 'INACTIVE',
                tokenVersion: { increment: 1 },
                tokensInvalidatedAt: this.now(),
              },
              where: { id: { in: driverIds } },
            }),
            tx.driverSession.updateMany({
              data: { revokedAt: this.now() },
              where: { driverId: { in: driverIds }, revokedAt: null },
            }),
            tx.dsvDriverAccountSignupInvite.updateMany({
              data: { revokedAt: this.now() },
              where: { driverId: { in: driverIds }, revokedAt: null },
            }),
            tx.driverConsentRecord.updateMany({
              data: { deviceContext: Prisma.DbNull },
              where: {
                OR: [
                  ...(request.accountId === null ? [] : [{ accountId: request.accountId }]),
                  { driverId: { in: driverIds } },
                ],
              },
            }),
            tx.driverRouteFeedback.updateMany({
              data: { reviewNote: '[redacted after account deletion]' },
              where: { driverId: { in: driverIds } },
            }),
          ]);
          counts.driversAnonymized = driversAnonymized.count;
          counts.driverSessionsRevoked = driverSessions.count;
          counts.signupInvitesRevoked = signupInvites.count;
          counts.consentDeviceContextsCleared = consentRecords.count;
          counts.driverFeedbackNotesRedacted = feedback.count;
        }

        const completed = await tx.driverAccountDeletionRequest.updateMany({
          data: {
            driverDisplayName: null,
            driverPhone: null,
            failureCode: null,
            processedAt: this.now(),
            processedBy: input.processedBy,
            processingKey: null,
            processingLeaseExpiresAt: null,
            reason: null,
            rejectionCode: null,
            shopDomain: null,
            status: 'COMPLETED',
          },
          where: {
            id: input.requestId,
            processingKey: claimed.processingKey,
            status: 'PROCESSING',
          },
        });
        if (completed.count !== 1) {
          throw new DriverAccountDeletionProcessingError('Account deletion claim was lost before completion');
        }

        return {
          counts,
          duplicate: false,
          requestId: input.requestId,
          status: 'COMPLETED',
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      await this.prisma.driverAccountDeletionRequest.updateMany({
        data: {
          failureCode: 'TRANSACTION_FAILED',
          processedAt: this.now(),
          processedBy: input.processedBy,
          processingKey: null,
          processingLeaseExpiresAt: null,
          status: 'FAILED',
        },
        where: {
          id: input.requestId,
          processingKey: claimed.processingKey,
          status: 'PROCESSING',
        },
      });
      throw new DriverAccountDeletionProcessingError('Account deletion transaction failed', { cause: error });
    }
  }

  async reject(input: { processedBy: string; reasonCode: string; requestId: string }): Promise<DriverAccountDeletionResult> {
    assertUuid(input.requestId, 'requestId');
    assertActor(input.processedBy);
    if (!REJECTION_CODES.has(input.reasonCode)) throw new Error('Invalid rejection reason code');

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.driverAccountDeletionRequest.findUnique({
        select: { id: true, status: true },
        where: { id: input.requestId },
      });
      if (request === null) throw new DriverAccountDeletionNotFoundError('Account deletion request not found');
      if (request.status === 'COMPLETED' || request.status === 'REJECTED') {
        return {
          duplicate: true,
          requestId: request.id,
          status: request.status as DriverAccountDeletionLifecycleStatus,
        };
      }
      if (request.status === 'PROCESSING') {
        throw new DriverAccountDeletionProcessingError('Account deletion request is already processing');
      }
      const rejected = await tx.driverAccountDeletionRequest.updateMany({
        data: {
          driverDisplayName: null,
          driverPhone: null,
          failureCode: null,
          processedAt: this.now(),
          processedBy: input.processedBy,
          processingKey: null,
          processingLeaseExpiresAt: null,
          reason: null,
          rejectionCode: input.reasonCode,
          shopDomain: null,
          status: 'REJECTED',
        },
        where: {
          id: input.requestId,
          status: { in: ['REQUESTED', 'DEFERRED', 'FAILED'] },
        },
      });
      if (rejected.count === 1) {
        return { duplicate: false, requestId: input.requestId, status: 'REJECTED' };
      }

      const latest = await tx.driverAccountDeletionRequest.findUnique({
        select: { id: true, status: true },
        where: { id: input.requestId },
      });
      if (latest?.status === 'COMPLETED' || latest?.status === 'REJECTED') {
        return {
          duplicate: true,
          requestId: latest.id,
          status: latest.status,
        };
      }
      throw new DriverAccountDeletionProcessingError('Account deletion request changed while rejection was attempted');
    });
  }

  private async claim(requestId: string, processedBy: string): Promise<{
    processingKey: string;
    terminal: DriverAccountDeletionResult | null;
  }> {
    const current = await this.prisma.driverAccountDeletionRequest.findUnique({
      select: { id: true, status: true },
      where: { id: requestId },
    });
    if (current === null) throw new DriverAccountDeletionNotFoundError('Account deletion request not found');
    if (current.status === 'COMPLETED') {
      return {
        processingKey: '',
        terminal: { duplicate: true, requestId, status: 'COMPLETED' },
      };
    }
    if (current.status === 'REJECTED') {
      return {
        processingKey: '',
        terminal: { duplicate: true, requestId, status: 'REJECTED' },
      };
    }

    const now = this.now();
    const key = this.processingKey();
    const claim = await this.prisma.driverAccountDeletionRequest.updateMany({
      data: {
        attemptCount: { increment: 1 },
        failureCode: null,
        lastAttemptAt: now,
        processedBy,
        processingKey: key,
        processingLeaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),
        processingStartedAt: now,
        rejectionCode: null,
        status: 'PROCESSING',
      },
      where: {
        id: requestId,
        OR: [
          { status: { in: ['REQUESTED', 'DEFERRED', 'FAILED'] } },
          { processingLeaseExpiresAt: { lte: now }, status: 'PROCESSING' },
        ],
      },
    });
    if (claim.count === 1) return { processingKey: key, terminal: null };

    const latest = await this.prisma.driverAccountDeletionRequest.findUnique({
      select: { id: true, status: true },
      where: { id: requestId },
    });
    if (latest?.status === 'COMPLETED' || latest?.status === 'REJECTED') {
      return {
        processingKey: '',
        terminal: {
          duplicate: true,
          requestId,
          status: latest.status,
        },
      };
    }
    throw new DriverAccountDeletionProcessingError('Account deletion request is already processing');
  }

  private async findOrPromoteAccountDeletionRequest(
    client: Pick<Prisma.TransactionClient, 'driverAccountDeletionRequest'>,
    accountId: string,
  ): Promise<{ id: string; status: DriverAccountDeletionLifecycleStatus } | null> {
    const accountRequest = await client.driverAccountDeletionRequest.findUnique({
      select: { id: true, status: true },
      where: { accountId },
    });
    if (accountRequest !== null) return accountRequest;

    const legacyRequest = await client.driverAccountDeletionRequest.findFirst({
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      where: { driver: { accountId } },
    });
    if (legacyRequest === null) return null;

    return client.driverAccountDeletionRequest.update({
      data: { accountId, driverId: null, shopDomain: null },
      select: { id: true, status: true },
      where: { id: legacyRequest.id },
    });
  }
}

function assertActor(value: string): void {
  if (!ACTOR_PATTERN.test(value)) throw new Error('processedBy must be a non-PII operator label');
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${field} must be a UUID`);
}
