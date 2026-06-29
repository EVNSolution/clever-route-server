import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';
import { InventoryValidationError, type InventoryService } from '../modules/inventory/inventory.types.js';
import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';

export type AdminInventoryDependencies = {
  inventoryService: InventoryService;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminInventoryRoutes(app: FastifyInstance, dependencies: AdminInventoryDependencies): void {
  app.get('/admin/inventories', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_inventories'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    const inventories = await dependencies.inventoryService.listInventories({
      appId: authenticated.appId,
      shopDomain: authenticated.shopDomain
    });
    return reply.code(200).send({ data: { inventories }, error: null });
  });

  app.post<{ Body: unknown }>('/admin/inventories', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_inventories'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readCreateInventoryPayload(request.body);
      const inventory = await dependencies.inventoryService.createInventory({
        actor: authenticated.subject,
        appId: authenticated.appId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      return reply.code(201).send({ data: { inventory }, error: null });
    } catch (error) {
      return sendInventoryError(reply, error);
    }
  });

  app.get<{ Params: { inventoryId: string } }>('/admin/inventories/:inventoryId', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_inventories'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    const inventory = await dependencies.inventoryService.getInventory({
      appId: authenticated.appId,
      inventoryId: request.params.inventoryId,
      shopDomain: authenticated.shopDomain
    });
    if (inventory === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Inventory not found'));
    return reply.code(200).send({ data: { inventory }, error: null });
  });

  app.patch<{ Body: unknown; Params: { inventoryId: string } }>('/admin/inventories/:inventoryId/orders', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_inventories'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readUpdateInventoryOrdersPayload(request.body);
      const inventory = await dependencies.inventoryService.updateInventoryOrders({
        actor: authenticated.subject,
        appId: authenticated.appId,
        inventoryId: request.params.inventoryId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (inventory === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Inventory not found'));
      return reply.code(200).send({ data: { inventory }, error: null });
    } catch (error) {
      return sendInventoryError(reply, error);
    }
  });

  app.delete<{ Params: { inventoryId: string } }>('/admin/inventories/:inventoryId', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_inventories'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const result = await dependencies.inventoryService.deleteInventory({
        appId: authenticated.appId,
        inventoryId: request.params.inventoryId,
        shopDomain: authenticated.shopDomain
      });
      return reply.code(200).send({ data: result, error: null });
    } catch (error) {
      return sendInventoryError(reply, error);
    }
  });
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminInventoryDependencies,
  options: AdminSessionAuthLogContext
):
  | { appId: string; shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = extractBearerToken(authorization);
  if (sessionToken === null) return { message: 'Missing bearer session token', status: 'unauthorized' };

  try {
    const expectedAppId = readHeaderValue(appIdHeader);
    const verified = dependencies.sessionTokenVerifier.verify(
      sessionToken,
      expectedAppId === null ? {} : { expectedAppId }
    );
    return {
      appId: verified.appId ?? DEFAULT_SHOPIFY_APP_ID,
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject
    };
  } catch (error) {
    logRejectedAdminSessionToken({ ...options, error });
    return { message: 'Invalid Shopify session token', status: 'unauthorized' };
  }
}

function readCreateInventoryPayload(value: unknown): { name: string; note?: string | null; orderIds?: string[] } {
  const object = requireObject(value);
  return {
    name: requireNonEmptyString(object.name),
    ...(object.note === undefined ? {} : { note: readNullableString(object.note) }),
    ...(object.orderIds === undefined ? {} : { orderIds: readStringArray(object.orderIds) })
  };
}

function readUpdateInventoryOrdersPayload(value: unknown): { addOrderIds?: string[]; removeOrderIds?: string[] } {
  const object = requireObject(value);
  return {
    ...(object.addOrderIds === undefined ? {} : { addOrderIds: readStringArray(object.addOrderIds) }),
    ...(object.removeOrderIds === undefined ? {} : { removeOrderIds: readStringArray(object.removeOrderIds) })
  };
}

function sendInventoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InventoryValidationError) return reply.code(400).send(errorResponse(error.code, error.blockers.join('; ')));
  if (error instanceof BadInventoryPayloadError) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid inventory payload'));
  throw error;
}

class BadInventoryPayloadError extends Error {}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadInventoryPayloadError('object required');
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadInventoryPayloadError('string array required');
  return value.map(requireNonEmptyString);
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BadInventoryPayloadError('non-empty string required');
  return value.trim();
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadInventoryPayloadError('string required');
  return value.trim() === '' ? null : value.trim();
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') return null;
  return match[1].trim();
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}
