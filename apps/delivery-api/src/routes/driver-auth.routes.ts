import type { FastifyInstance } from 'fastify';
import { signDriverToken } from '../modules/driver/driver-token-verifier.js';
import type { PrismaDriverAuthRepository } from '../modules/driver/driver-auth.repository.js';

export type DriverAuthDependencies = {
  driverAuthRepository: PrismaDriverAuthRepository;
  jwtSecret: string;
};

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
      const tokenResult = signDriverToken(
        {
          driverId: sessionInfo.driverId,
          expiresInSeconds: 15 * 60,
          shopDomain: sessionInfo.shopDomain,
          subject: `driver:${sessionInfo.driverId}`,
          tokenVersion: sessionInfo.tokenVersion
        },
        { secret: dependencies.jwtSecret }
      );

      return reply.code(200).send({
        data: {
          accessToken: tokenResult.token,
          expiresAt: tokenResult.expiresAt,
          refreshToken: sessionInfo.refreshToken,
          refreshTokenExpiresAt: sessionInfo.expiresAt.toISOString()
        },
        error: null
      });
    } catch (error) {
      if (isInvalidRefreshTokenError(error)) {
        return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' } });
      }

      request.log.error({ err: error }, 'driver auth refresh failed');
      return reply.code(500).send({ data: null, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Driver session could not be refreshed' } });
    }
  });

  app.post<{ Body: { displayName?: unknown; phone: string; inviteCode: string } }>('/driver/auth/verify-invite', async (request, reply) => {
    const { displayName, phone, inviteCode } = request.body;

    if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/u.test(phone.trim()) || typeof inviteCode !== 'string') {
      return reply.code(400).send({ data: null, error: { code: 'BAD_REQUEST', message: 'phone and inviteCode are required' } });
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
        payloadKeys: Object.keys(request.body).sort(),
        phoneLast4: phone.trim().slice(-4)
      },
      'driver invite verification payload accepted'
    );

    try {
      const sessionInfo = await dependencies.driverAuthRepository.verifyInvite({
        phone: phone.trim(),
        inviteCode: normalizedInviteCode,
        ...(normalizedDisplayName === undefined ? {} : { displayName: normalizedDisplayName })
      });

      const tokenResult = signDriverToken(
        {
          driverId: sessionInfo.driverId,
          expiresInSeconds: 15 * 60, // 15 minutes access token
          shopDomain: sessionInfo.shopDomain,
          subject: `driver:${sessionInfo.driverId}`,
          tokenVersion: sessionInfo.tokenVersion
        },
        { secret: dependencies.jwtSecret }
      );

      return reply.code(200).send({
        data: {
          accessToken: tokenResult.token,
          expiresAt: tokenResult.expiresAt,
          refreshToken: sessionInfo.refreshToken,
          refreshTokenExpiresAt: sessionInfo.expiresAt.toISOString()
        },
        error: null
      });
    } catch (error) {
      return reply.code(401).send({ data: null, error: { code: 'UNAUTHORIZED', message: (error as Error).message } });
    }
  });
}

function isInvalidRefreshTokenError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Invalid refresh token' || error.message === 'Invalid or expired refresh token');
}
