import { randomBytes, createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export type DriverAuthPrismaClient = Pick<PrismaClient, 'driver' | 'driverSession'>;
type DriverInviteRecord = Prisma.DriverGetPayload<{ include: { shop: { select: { shopDomain: true } } } }>;

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
    const now = new Date();
    const driver = await this.prisma.driver.findFirst({
      where: {
        phone: input.phone,
        inviteCode: input.inviteCode,
        status: 'ACTIVE',
        inviteCodeExpiresAt: {
          gt: now
        }
      },
      include: { shop: { select: { shopDomain: true } } }
    }) ?? await this.findLegacyPhoneInvite(input, now);

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
        phone: input.phone,
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

  private async findLegacyPhoneInvite(input: VerifyInviteInput, now: Date): Promise<DriverInviteRecord | null> {
    const canonicalInputPhone = normalizeLegacyDriverPhone(input.phone);
    if (canonicalInputPhone === null) return null;

    const candidates = await this.prisma.driver.findMany({
      where: {
        inviteCode: input.inviteCode,
        status: 'ACTIVE',
        inviteCodeExpiresAt: {
          gt: now
        }
      },
      include: { shop: { select: { shopDomain: true } } }
    });

    return candidates.find((candidate) => normalizeLegacyDriverPhone(candidate.phone) === canonicalInputPhone) ?? null;
  }
}

function normalizeDisplayName(displayName: string | null | undefined): string | null {
  if (typeof displayName !== 'string') {
    return null;
  }

  const normalizedDisplayName = displayName.trim();
  return normalizedDisplayName.length === 0 ? null : normalizedDisplayName;
}

function normalizeLegacyDriverPhone(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (/^\+[1-9]\d{7,14}$/u.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/gu, '');
  if (digits.length === 0) return null;
  if (/^00[1-9]\d{7,14}$/u.test(digits)) return `+${digits.slice(2)}`;
  if (/^1[2-9]\d{9}$/u.test(digits)) return `+${digits}`;
  if (/^[2-9]\d{9}$/u.test(digits)) return `+1${digits}`;
  if (/^8210\d{8}$/u.test(digits)) return `+${digits}`;
  if (/^010\d{8}$/u.test(digits)) return `+82${digits.slice(1)}`;

  return null;
}
