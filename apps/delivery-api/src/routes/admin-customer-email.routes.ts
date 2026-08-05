import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CustomerEmailNotFoundError,
  CustomerEmailValidationError,
  CustomerEmailVersionConflictError,
  readCustomerEmailCommandPayload,
  readCustomerEmailTestPayload,
  type CustomerEmailService,
} from '../modules/customer-email/customer-email.service.js';
import { readCustomerEmailSignal } from '../modules/customer-email/customer-email-settings.js';
import {
  CustomerEmailTransportConfigurationError,
  CustomerEmailTransportSendError,
} from '../modules/customer-email/customer-email-transport.js';
import {
  logRejectedAdminSessionToken,
  type AdminSessionTokenVerifier,
} from './admin-session-auth.js';
import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';

export type AdminCustomerEmailDependencies = {
  customerEmailService: CustomerEmailService;
  logoAssets?: CustomerEmailLogoAssetStore;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export type CustomerEmailLogoAssetStore = {
  directory: string;
  publicBaseUrl: string;
};

const maxLogoBytes = 3 * 1024 * 1024;
const logoFileNamePattern = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/u;

export function registerAdminCustomerEmailRoutes(
  app: FastifyInstance,
  dependencies: AdminCustomerEmailDependencies,
): void {
  app.get('/admin/customer-email/settings', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    const customerEmailSettings = await dependencies.customerEmailService.getSettings(authenticated);
    if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
    return reply.code(200).send({ data: { customerEmailSettings }, error: null });
  });

  app.patch<{ Body: unknown }>('/admin/customer-email/settings', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    try {
      const customerEmailSettings = await dependencies.customerEmailService.saveSettings({
        ...authenticated,
        payload: request.body,
      });
      if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
      return reply.code(200).send({ data: { customerEmailSettings }, error: null });
    } catch (error) {
      return sendCustomerEmailError(reply, error);
    }
  });

  app.patch<{ Body: unknown }>('/admin/customer-email/settings/global', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    try {
      const customerEmailSettings = await dependencies.customerEmailService.saveGlobalSettings({
        ...authenticated,
        payload: request.body,
      });
      if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
      return reply.code(200).send({ data: { customerEmailSettings }, error: null });
    } catch (error) {
      return sendCustomerEmailError(reply, error);
    }
  });

  app.patch<{ Body: unknown; Params: { signal: string } }>('/admin/customer-email/settings/templates/:signal', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    const signal = readCustomerEmailSignal(request.params.signal);
    if (signal === null) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email template signal'));
    try {
      const customerEmailSettings = await dependencies.customerEmailService.saveTemplateSettings({
        ...authenticated,
        payload: request.body,
        signal,
      });
      if (customerEmailSettings === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Shop not found'));
      return reply.code(200).send({ data: { customerEmailSettings }, error: null });
    } catch (error) {
      return sendCustomerEmailError(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/admin/customer-email/test', async (request, reply) => {
    const correlationId = readCorrelationId(request.headers['x-correlation-id']) ?? request.id;
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') {
      request.log.warn({ correlationId }, 'customer email test rejected before authentication');
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }
    const payload = readCustomerEmailTestPayload(request.body);
    if (payload === null) {
      request.log.warn({ appId: authenticated.appId, correlationId, shopDomain: authenticated.shopDomain }, 'customer email test rejected because payload is invalid');
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email test payload'));
    }
    request.log.info({
      appId: authenticated.appId,
      correlationId,
      recipientDomain: readEmailDomain(payload.recipientEmail),
      shopDomain: authenticated.shopDomain,
      signal: payload.signal ?? 'DELIVERY_SCHEDULED',
    }, 'customer email test requested');
    try {
      const result = await dependencies.customerEmailService.sendTest({
        ...authenticated,
        ...payload,
      });
      request.log.info({
        correlationId,
        messageId: result.messageId,
        provider: result.provider,
      }, 'customer email test accepted by provider');
      return reply.code(202).send({ data: { correlationId, test: result }, error: null });
    } catch (error) {
      request.log.error({
        correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        providerStatus: error instanceof CustomerEmailTransportSendError ? error.statusCode : null,
      }, 'customer email test failed');
      return sendCustomerEmailError(reply, error);
    }
  });

  app.post('/admin/customer-email/logo', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    if (dependencies.logoAssets === undefined) {
      return reply.code(503).send(errorResponse('CUSTOMER_EMAIL_ASSET_STORAGE_NOT_CONFIGURED', 'Customer email logo storage is not configured.'));
    }
    if (!request.isMultipart()) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Logo upload must be multipart/form-data.'));

    const file = await request.file();
    if (file === undefined || file.fieldname !== 'logo') {
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Logo upload must include a logo file.'));
    }

    const collected = await readLogoFile(file);
    if (collected.status !== 'ok') {
      return collected.status === 'too-large'
        ? reply.code(413).send(errorResponse('PAYLOAD_TOO_LARGE', 'Logo must be at most 3 MiB.'))
        : reply.code(400).send(errorResponse('BAD_REQUEST', 'Logo must be a PNG, JPEG, or WebP image.'));
    }

    const sha256 = createHash('sha256').update(collected.bytes).digest('hex');
    const fileName = `${sha256}.${collected.extension}`;
    await mkdir(dependencies.logoAssets.directory, { recursive: true });
    await writeFile(join(dependencies.logoAssets.directory, fileName), collected.bytes, { flag: 'wx' }).catch((error: unknown) => {
      if (isFileAlreadyExistsError(error)) return;
      throw error;
    });

    return reply.code(201).send({
      data: {
        logoAsset: {
          contentType: collected.contentType,
          sizeBytes: collected.bytes.byteLength,
          url: `${dependencies.logoAssets.publicBaseUrl.replace(/\/+$/u, '')}/customer-email/assets/${fileName}`,
        },
      },
      error: null,
    });
  });

  app.get<{ Params: { fileName: string } }>('/customer-email/assets/:fileName', async (request, reply) => {
    if (dependencies.logoAssets === undefined) {
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Customer email asset not found'));
    }
    const fileName = request.params.fileName;
    if (!logoFileNamePattern.test(fileName)) {
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Customer email asset not found'));
    }
    const contentType = contentTypeForLogoFileName(fileName);
    if (contentType === null) {
      return reply.code(404).send(errorResponse('NOT_FOUND', 'Customer email asset not found'));
    }
    try {
      const bytes = await readFile(join(dependencies.logoAssets.directory, fileName));
      return reply
        .code(200)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .type(contentType)
        .send(bytes);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return reply.code(404).send(errorResponse('NOT_FOUND', 'Customer email asset not found'));
      }
      throw error;
    }
  });

  app.post<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/customer-email/preview',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
      if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      const payload = readCustomerEmailCommandPayload(request.body);
      if (payload === null) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email preview payload'));
      const preview = await dependencies.customerEmailService.preview({
        ...authenticated,
        deliveryStopIds: payload.deliveryStopIds,
        routePlanId: request.params.routePlanId,
        signal: payload.signal,
      });
      if (preview === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
      return reply.code(200).send({ data: { preview }, error: null });
    },
  );

  app.post<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/customer-email/send',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, request.log);
      if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      const payload = readCustomerEmailCommandPayload(request.body);
      if (payload === null || payload.commandId === undefined) {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid customer email send payload'));
      }
      try {
        const dispatch = await dependencies.customerEmailService.send({
          ...authenticated,
          actor: authenticated.subject,
          commandId: payload.commandId,
          confirmed: payload.confirmed ?? false,
          deliveryStopIds: payload.deliveryStopIds,
          ...(payload.missingValuesConfirmed === undefined ? {} : { missingValuesConfirmed: payload.missingValuesConfirmed }),
          ...(payload.resendConfirmed === undefined ? {} : { resendConfirmed: payload.resendConfirmed }),
          routePlanId: request.params.routePlanId,
          signal: payload.signal,
        });
        if (dispatch === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
        return reply.code(202).send({ data: { dispatch }, error: null });
      } catch (error) {
        return sendCustomerEmailError(reply, error);
      }
    },
  );
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminCustomerEmailDependencies,
  log: Parameters<typeof logRejectedAdminSessionToken>[0]['log'],
):
  | { appId: string; shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = readBearerToken(authorization);
  if (sessionToken === null) return { message: 'Missing bearer session token', status: 'unauthorized' };
  try {
    const verified = dependencies.sessionTokenVerifier.verify(sessionToken, {
      appId: readAppIdHeader(appIdHeader),
    });
    return {
      appId: verified.appId ?? readAppIdHeader(appIdHeader) ?? DEFAULT_SHOPIFY_APP_ID,
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject,
    };
  } catch (error) {
    logRejectedAdminSessionToken({ error, log, surface: 'admin_customer_email' });
    return { message: 'Invalid bearer session token', status: 'unauthorized' };
  }
}

function sendCustomerEmailError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown): unknown {
  if (error instanceof CustomerEmailNotFoundError) return reply.code(404).send(errorResponse('NOT_FOUND', error.message));
  if (error instanceof CustomerEmailVersionConflictError) return reply.code(409).send(errorResponse(error.code, error.message));
  if (error instanceof CustomerEmailValidationError) return reply.code(400).send(errorResponse(error.code, error.message));
  if (error instanceof CustomerEmailTransportConfigurationError) {
    return reply.code(503).send(errorResponse('CUSTOMER_EMAIL_NOT_CONFIGURED', 'Customer email transport is not configured.'));
  }
  if (error instanceof CustomerEmailTransportSendError) {
    return reply.code(502).send(errorResponse('CUSTOMER_EMAIL_SEND_FAILED', 'Customer email provider rejected the request.'));
  }
  throw error;
}

function readBearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1] ?? null;
}

function readAppIdHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readCorrelationId(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && candidate.length <= 128 ? candidate : null;
}

function readEmailDomain(value: string): string | null {
  const separator = value.lastIndexOf('@');
  return separator >= 0 ? value.slice(separator + 1).trim().toLowerCase() || null : null;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}

async function readLogoFile(file: MultipartFile): Promise<
  | { bytes: Buffer; contentType: 'image/jpeg' | 'image/png' | 'image/webp'; extension: 'jpg' | 'png' | 'webp'; status: 'ok' }
  | { status: 'invalid' | 'too-large' }
> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.file as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxLogoBytes) return { status: 'too-large' };
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks);
  const detected = detectLogoImageType(bytes);
  if (detected === null || detected.contentType !== file.mimetype) return { status: 'invalid' };
  return { bytes, ...detected, status: 'ok' };
}

function detectLogoImageType(bytes: Buffer): { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; extension: 'jpg' | 'png' | 'webp' } | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function contentTypeForLogoFileName(fileName: string): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg')) return 'image/jpeg';
  if (fileName.endsWith('.webp')) return 'image/webp';
  return null;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
