import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyDriverAccountToken } from '../modules/driver/driver-token-verifier.js';
import {
  parseDriverDiagnosticEnvelopeDetailed,
  parseDriverDiagnosticSnapshot,
  type DriverDiagnosticEnvelope
} from '../modules/driver/driver-runtime-diagnostics.contract.js';
import { deriveDriverRuntimeDiagnostic } from '../modules/driver/driver-runtime-diagnostics.projection.js';
import type {
  DriverRuntimeDiagnosticCredential,
  DriverRuntimeDiagnosticShopDevice,
  PrismaDriverRuntimeDiagnosticsRepository
} from '../modules/driver/driver-runtime-diagnostics.repository.js';
import { DriverRuntimeDiagnosticsError } from '../modules/driver/driver-runtime-diagnostics.repository.js';
import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';
import type { AdminSessionTokenVerifier } from './admin-session-auth.js';
import { isInvalidJsonBodyError } from './json-body-parser.js';

export type DriverRuntimeDiagnosticsService = Pick<PrismaDriverRuntimeDiagnosticsRepository,
  'register' | 'authenticate' | 'recordContact' | 'recordFailure' | 'revoke' | 'ingest' | 'listForShop'>;

type Dependencies = {
  service: DriverRuntimeDiagnosticsService;
  jwtSecret: string;
  sessionTokenVerifier?: AdminSessionTokenVerifier;
  now?: () => Date;
};

const prefix = '/driver/sync-health';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function registerDriverRuntimeDiagnosticsRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { service } = dependencies;
  // This context is private to the request; credentials and payloads never enter log bindings.
  const credentials = new WeakMap<FastifyRequest, DriverRuntimeDiagnosticCredential>();
  const envelopes = new WeakMap<FastifyRequest, DriverDiagnosticEnvelope>();
  await app.register(async (diagnostics) => {
    await diagnostics.register(rateLimit, { global: false });
    const limitIp = diagnostics.createRateLimit({
      max: (request) => request.routeOptions.url === `${prefix}/diagnostics` ? 120
        : request.routeOptions.url === `${prefix}/registrations` ? 20 : 30,
      timeWindow: '1 minute',
      keyGenerator: (request) => `${request.method}:${request.routeOptions.url}:${request.ip}`
    });
    const limitDevice = diagnostics.createRateLimit({
      max: 60, timeWindow: '1 minute',
      keyGenerator: (request) => credentials.get(request)?.deviceId ?? request.ip
    });
    diagnostics.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const ipLimit = await limitIp(request);
      if (!ipLimit.isAllowed && ipLimit.isExceeded) {
        return reply.header('Retry-After', ipLimit.ttlInSeconds).code(429).send(failure('RATE_LIMITED'));
      }
      if (request.routeOptions.url !== `${prefix}/diagnostics`) return;
      const token = bearer(request.headers.authorization);
      const credential = token === null ? null : await service.authenticate(token);
      if (credential === null) return reply.code(401).send(failure('DIAGNOSTIC_UNAUTHORIZED'));
      credentials.set(request, credential);
      const deviceLimit = await limitDevice(request);
      if (!deviceLimit.isAllowed && deviceLimit.isExceeded) {
        return reply.header('Retry-After', deviceLimit.ttlInSeconds).code(429).send(failure('RATE_LIMITED'));
      }
      // Capture contact before parsing JSON so a malformed authenticated request is still observable.
      await service.recordContact(credential);
    });
    diagnostics.setErrorHandler(async (error, request, reply) => {
      const status = error instanceof DriverRuntimeDiagnosticsError ? (error.code === 'DRIVER_SCOPE_REJECTED' ? 403 : 400)
        : isInvalidJsonBodyError(error) ? 400 : statusCode(error);
      const code = error instanceof DriverRuntimeDiagnosticsError ? error.code : status === 400 ? 'INVALID_JSON' : status === 413 ? 'PAYLOAD_TOO_LARGE'
        : status === 429 ? 'RATE_LIMITED' : 'DIAGNOSTIC_STORAGE_UNAVAILABLE';
      const credential = credentials.get(request);
      if (credential !== undefined) await recordFailure(credential, code, request);
      return reply.code(status).send(failure(code));
    });

    diagnostics.post(`${prefix}/registrations`, {
      bodyLimit: 1024
    }, async (request, reply) => {
      const account = accountClaims(request, dependencies.jwtSecret);
      if (account === null) return reply.code(401).send(failure('UNAUTHORIZED'));
      const deviceInstanceHash = registrationDevice(request.body);
      if (deviceInstanceHash === null) return reply.code(400).send(failure('INVALID_REGISTRATION'));
      const credential = await service.register({ ...account, deviceInstanceHash });
      return credential === null
        ? reply.code(401).send(failure('UNAUTHORIZED'))
        : reply.code(200).send(credential);
    });

    diagnostics.delete(`${prefix}/registrations`, { bodyLimit: 1024 }, async (request, reply) => {
      const account = accountClaims(request, dependencies.jwtSecret);
      if (account === null) return reply.code(401).send(failure('UNAUTHORIZED'));
      const deviceInstanceHash = registrationDevice(request.body);
      if (deviceInstanceHash === null) return reply.code(400).send(failure('INVALID_REGISTRATION'));
      const result = await service.revoke({ ...account, deviceInstanceHash });
      return result === null ? reply.code(401).send(failure('UNAUTHORIZED')) : reply.code(200).send(result);
    });

    diagnostics.post(`${prefix}/diagnostics`, {
      bodyLimit: 64 * 1024
    }, async (request, reply) => {
      const credential = credentials.get(request);
      if (credential === undefined) return reply.code(401).send(failure('DIAGNOSTIC_UNAUTHORIZED'));
      const parsed = parseDriverDiagnosticEnvelopeDetailed(request.body);
      if (parsed === null) {
        await recordFailure(credential, 'INVALID_ENVELOPE', request);
        return reply.code(400).send(failure('INVALID_ENVELOPE'));
      }
      envelopes.set(request, parsed.envelope);
      const result = await service.ingest(credential, parsed.envelope);
      const rejectedDiagnostics = [
        ...result.rejectedDiagnostics,
        ...parsed.rejectedRecords.flatMap((record) => record.diagnosticId === null ? [] : [{
          diagnosticId: record.diagnosticId, code: record.code
        }])
      ];
      if (parsed.rejectedRecords.length > 0) await recordFailure(credential, 'INVALID_RECORD', request);
      return reply.code(200).send({ ...result, rejectedDiagnostics });
    });

    diagnostics.get<{ Querystring: { diagnosticId?: string; routePlanId?: string } }>('/admin/drivers/runtime-diagnostics', async (request, reply) => {
      const token = bearer(request.headers.authorization);
      const verifier = dependencies.sessionTokenVerifier;
      if (token === null || verifier === undefined) return reply.code(401).send(failure('UNAUTHORIZED'));
      let scope: { appId: string; shopDomain: string };
      try {
        const header = request.headers['x-clever-app-id'];
        const expectedAppId = typeof header === 'string' && header.trim() !== '' ? header.trim() : undefined;
        const verified = verifier.verify(token, expectedAppId === undefined ? {} : { expectedAppId });
        scope = { appId: verified.appId ?? DEFAULT_SHOPIFY_APP_ID, shopDomain: verified.shopDomain };
      } catch {
        return reply.code(401).send(failure('UNAUTHORIZED'));
      }
      const routePlanId = request.query.routePlanId;
      const diagnosticId = request.query.diagnosticId;
      if (routePlanId !== undefined && !uuid.test(routePlanId)) return reply.code(400).send(failure('INVALID_ROUTE_ID'));
      if (diagnosticId !== undefined && !uuid.test(diagnosticId)) return reply.code(400).send(failure('INVALID_DIAGNOSTIC_ID'));
      if (diagnosticId !== undefined && routePlanId === undefined) return reply.code(400).send(failure('ROUTE_ID_REQUIRED'));
      const result = await service.listForShop({
        ...scope,
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
        ...(routePlanId === undefined ? {} : { routePlanId })
      });
      if (result === null) return reply.code(404).send(failure('NOT_FOUND'));
      const now = dependencies.now?.() ?? new Date();
      return reply.code(200).send({
        data: {
          ...result,
          evaluatedAt: now.toISOString(),
          timeZone: 'America/Toronto',
          devices: result.devices.map((device) => ({
            ...device,
            diagnosis: diagnoseDevice(device, now),
            display: {
              lastContactAt: torontoTime(device.lastScopedContactAt),
              snapshotObservedAt: torontoTime(device.latestSnapshot?.snapshotObservedAt ?? null)
            }
          }))
        },
        error: null
      });
    });
  });

  async function recordFailure(credential: DriverRuntimeDiagnosticCredential, code: string, request: FastifyRequest): Promise<void> {
    try {
      const envelope = envelopes.get(request);
      if (envelope === undefined) await service.recordFailure(credential, code);
      else await service.recordFailure(credential, code, envelope);
    } catch {
      // Storage itself can be unavailable. Do not claim durable contact or expose raw DB errors.
      request.log.warn({ event: 'driver_diagnostic_failure_unpersisted', code, requestId: request.id }, 'Diagnostic failure metadata unavailable');
    }
  }
}

function diagnoseDevice(device: DriverRuntimeDiagnosticShopDevice, now: Date) {
  const diagnosis = deriveDriverRuntimeDiagnostic({
    lastContactAt: device.lastScopedContactAt,
    snapshot: device.latestSnapshot === null ? null : parseDriverDiagnosticSnapshot(device.latestSnapshot.snapshot),
    firstObservedAt: device.latestSnapshot?.firstObservedAt ?? null,
    attempts: device.attempts,
    now
  });
  if (device.lastIngestionFailureCode === null || diagnosis.state === 'SIGNAL_ABSENT_UNKNOWN') return diagnosis;
  return {
    ...diagnosis,
    state: device.lastIngestionFailureCode === 'FUTURE_SNAPSHOT' ? 'UNKNOWN_STALE_EVIDENCE' : 'UNKNOWN_INGESTION_FAILED',
    stage: null,
    reasons: [device.lastIngestionFailureCode],
    observedAt: device.lastIngestionFailureAt,
    evidence: { attemptIds: [], clientEventIds: [], requestIds: [] }
  };
}

function bearer(value: string | undefined): string | null {
  return value === undefined ? null : /^Bearer\s+(\S+)$/iu.exec(value)?.[1] ?? null;
}

function accountClaims(request: FastifyRequest, secret: string): { accountId: string; tokenVersion: number } | null {
  const token = bearer(request.headers.authorization);
  if (token === null) return null;
  try {
    const claims = verifyDriverAccountToken(token, { secret });
    return { accountId: claims.accountId, tokenVersion: claims.tokenVersion };
  } catch {
    return null;
  }
}

function registrationDevice(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every((key) => key === 'schemaVersion' || key === 'deviceInstanceHash')
    && body.schemaVersion === 1 && typeof body.deviceInstanceHash === 'string'
    && /^[a-f0-9]{32,128}$/iu.test(body.deviceInstanceHash) ? body.deviceInstanceHash.toLowerCase() : null;
}

function failure(code: string): { error: { code: string } } { return { error: { code } }; }

function statusCode(error: unknown): number {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
  return status === 400 || status === 413 || status === 429 ? status : 503;
}

function torontoTime(value: Date | null): string | null {
  return value === null ? null : new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'long', hourCycle: 'h23'
  }).format(value);
}
