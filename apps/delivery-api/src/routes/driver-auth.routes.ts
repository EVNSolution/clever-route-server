import type { FastifyInstance } from 'fastify';
import { signDriverAccountToken, signDriverToken, verifyDriverToken } from '../modules/driver/driver-token-verifier.js';
import type { DriverAuthSessionInfo, PrismaDriverAuthRepository } from '../modules/driver/driver-auth.repository.js';
import type { DriverPushTokenService } from '../modules/route-grouping/driver-push-token.service.js';

export type DriverAuthDependencies = {
  driverAuthRepository: PrismaDriverAuthRepository;
  jwtSecret: string;
  pushTokenService?: DriverPushTokenService;
};

const DRIVER_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DRIVER_PIN_PATTERN = /^\d{6}$/u;

export function registerDriverAuthRoutes(app: FastifyInstance, dependencies: DriverAuthDependencies): void {
  app.post<{ Body: unknown }>('/driver/auth/refresh', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'refreshToken is required' } });
    }

    const { refreshToken } = body as { refreshToken?: unknown };
    if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'refreshToken is required' } });
    }

    try {
      const sessionInfo = await dependencies.driverAuthRepository.refreshSession({
        refreshToken: refreshToken.trim()
      });
      return reply.code(200).send(buildAuthSessionResponse(sessionInfo, dependencies.jwtSecret));
    } catch (error) {
      if (isInvalidRefreshTokenError(error)) {
        return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' } });
      }

      request.log.error({ err: error }, 'driver auth refresh failed');
      return reply.code(500).send({ data: null, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Driver session could not be refreshed' } });
    }
  });

  app.post<{ Body: unknown }>('/driver/auth/login', async (request, reply) => {
    const body = objectOrNull(request.body);
    const phone = body === null ? null : readRequiredString(body.phone);
    const pin = body === null ? null : readRequiredString(body.pin);
    if (phone === null || !/^\+[1-9]\d{7,14}$/u.test(phone) || pin === null || !DRIVER_PIN_PATTERN.test(pin)) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'phone and 6-digit PIN are required' } });
    }

    try {
      const sessionInfo = await dependencies.driverAuthRepository.loginWithPin({ phone, pin });
      return reply.code(200).send(buildAuthSessionResponse(sessionInfo, dependencies.jwtSecret));
    } catch {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid phone or PIN' } });
    }
  });


  app.put<{ Body: unknown }>('/api/driver/mobile/push-token', async (request, reply) => {
    if (dependencies.pushTokenService === undefined) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'Driver push token service is not enabled' } });
    }
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' } });
    }
    let verified;
    try {
      verified = verifyDriverToken(token, { secret: dependencies.jwtSecret });
    } catch {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid driver bearer token' } });
    }
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'push token payload is required' } });
    }
    const payload = body as Record<string, unknown>;
    const devicePushToken = readRequiredString(payload.devicePushToken);
    const platform = readRequiredString(payload.platform);
    const appId = readRequiredString(payload.appId);
    if (devicePushToken === null || platform === null || appId === null) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'platform, appId, and devicePushToken are required' } });
    }
    const result = await dependencies.pushTokenService.upsertDriverPushToken({
      appId,
      appVersion: readOptionalString(payload.appVersion),
      deviceId: readOptionalString(payload.deviceId),
      devicePushToken,
      driverId: verified.driverId,
      locale: readOptionalString(payload.locale),
      platform,
      timezone: readOptionalString(payload.timezone)
    });
    return reply.code(200).send({ data: { pushToken: result }, error: null });
  });

  app.delete<{ Body: unknown }>('/api/driver/mobile/push-token', async (request, reply) => {
    if (dependencies.pushTokenService === undefined) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'Driver push token service is not enabled' } });
    }
    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' } });
    }
    let verified;
    try {
      verified = verifyDriverToken(token, { secret: dependencies.jwtSecret });
    } catch {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid driver bearer token' } });
    }
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'devicePushToken is required' } });
    }
    const devicePushToken = readRequiredString((body as Record<string, unknown>).devicePushToken);
    if (devicePushToken === null) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'devicePushToken is required' } });
    }
    const result = await dependencies.pushTokenService.revokeDriverPushToken({ devicePushToken, driverId: verified.driverId });
    return reply.code(200).send({ data: result, error: null });
  });

  app.post<{ Body: unknown }>('/driver/auth/verify-invite', async (request, reply) => {
    const body = objectOrNull(request.body);
    const displayName = body?.displayName;
    const phone = body?.phone;
    const inviteCode = body?.inviteCode;
    const pin = body?.pin;

    if (
      typeof phone !== 'string' ||
      !/^\+[1-9]\d{7,14}$/u.test(phone.trim()) ||
      typeof inviteCode !== 'string' ||
      typeof pin !== 'string' ||
      !DRIVER_PIN_PATTERN.test(pin.trim())
    ) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'phone, inviteCode, and 6-digit PIN are required' } });
    }
    if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'displayName must be a string' } });
    }

    const normalizedInviteCode = inviteCode.trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/u.test(normalizedInviteCode)) {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'inviteCode must be a 6-character hexadecimal code' } });
    }
    const normalizedDisplayName = typeof displayName === 'string' && displayName.trim().length > 0 ? displayName.trim() : undefined;
    request.log.info(
      {
        displayNameLength: normalizedDisplayName?.length ?? 0,
        displayNameProvided: normalizedDisplayName !== undefined,
        inviteCodeLength: normalizedInviteCode.length,
        payloadKeys: Object.keys(body ?? {}).sort(),
        phoneLast4: phone.trim().slice(-4)
      },
      'driver invite verification payload accepted'
    );

    try {
      const sessionInfo = await dependencies.driverAuthRepository.verifyInvite({
        phone: phone.trim(),
        inviteCode: normalizedInviteCode,
        pin: pin.trim(),
        ...(normalizedDisplayName === undefined ? {} : { displayName: normalizedDisplayName })
      });
      return reply.code(200).send(buildAuthSessionResponse(sessionInfo, dependencies.jwtSecret));
    } catch (error) {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: (error as Error).message } });
    }
  });
}

function buildAuthSessionResponse(sessionInfo: DriverAuthSessionInfo, secret: string): {
  data: {
    accessToken: string;
    expiresAt: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
    tokenType: 'Bearer';
    ttlSeconds: number;
    use: 'consent_and_assigned_route' | 'driver_account';
  };
  error: null;
} {
  const tokenResult = sessionInfo.kind === 'account'
    ? signDriverAccountToken({
        accountId: sessionInfo.accountId,
        expiresInSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
        subject: `driver-account:${sessionInfo.accountId}`,
        tokenVersion: sessionInfo.tokenVersion
      }, { secret })
    : signDriverToken({
        driverId: sessionInfo.driverId,
        expiresInSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
        shopDomain: sessionInfo.shopDomain,
        subject: `driver:${sessionInfo.driverId}`,
        tokenVersion: sessionInfo.tokenVersion
      }, { secret });

  return {
    data: {
      accessToken: tokenResult.token,
      expiresAt: tokenResult.expiresAt,
      refreshToken: sessionInfo.refreshToken,
      refreshTokenExpiresAt: sessionInfo.expiresAt.toISOString(),
      tokenType: 'Bearer',
      ttlSeconds: DRIVER_ACCESS_TOKEN_TTL_SECONDS,
      use: sessionInfo.kind === 'account' ? 'driver_account' : 'consent_and_assigned_route'
    },
    error: null
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}


function readBearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

function readRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isInvalidRefreshTokenError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Invalid refresh token' || error.message === 'Invalid or expired refresh token');
}
