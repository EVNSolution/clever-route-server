import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type DriverAuthPrismaClient = Pick<PrismaClient, 'driver' | 'driverSession'>;

export type VerifyInviteInput = {
  displayName?: string | null;
  phone: string;
  inviteCode: string;
};

export type DriverSessionInfo = {
  driverId: string;
  shopDomain: string;
  refreshToken: string;
  expiresAt: Date;
  tokenVersion: number;
};

export class PrismaDriverAuthRepository {
  constructor(private readonly prisma: DriverAuthPrismaClient) {}

  async verifyInvite(input: VerifyInviteInput): Promise<DriverSessionInfo> {
    const driver = await this.prisma.driver.findFirst({
      where: {
        phone: input.phone,
        inviteCode: input.inviteCode,
        status: 'ACTIVE',
        inviteCodeExpiresAt: {
          gt: new Date()
        }
      },
      include: { shop: { select: { shopDomain: true } } }
    });

    if (!driver) {
      throw new Error('Invalid or expired invite code');
    }

    // Clear the invite code since it's used, update authSubject if null,
    // and persist the registration name supplied by the driver app.
    const authSubject = driver.authSubject ?? `driver-${driver.id}`;
    const displayName = normalizeDisplayName(input.displayName);
    await this.prisma.driver.update({
      where: { id: driver.id },
      data: {
        inviteCode: null,
        inviteCodeExpiresAt: null,
        authSubject,
        ...(displayName === null ? {} : { displayName })
      }
    });

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.prisma.driverSession.create({
      data: {
        driverId: driver.id,
        refreshTokenHash,
        expiresAt
      }
    });

    return {
      driverId: driver.id,
      shopDomain: driver.shop.shopDomain,
      refreshToken,
      expiresAt,
      tokenVersion: driver.tokenVersion
    };
  }
}

function normalizeDisplayName(displayName: string | null | undefined): string | null {
  if (typeof displayName !== 'string') {
    return null;
  }

  const normalizedDisplayName = displayName.trim();
  return normalizedDisplayName.length === 0 ? null : normalizedDisplayName;
}
