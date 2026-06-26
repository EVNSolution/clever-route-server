import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';
import { DEFAULT_SHOPIFY_APP_ID } from '../modules/shopify/shopify-app-scope.js';
import {
  RouteGroupingBranchLockConflictError,
  RouteGroupingConflictError,
  RouteGroupingDeleteBlockedError,
  RouteGroupingRiskConfirmationRequiredError,
  RouteGroupingUnresolvedAssignmentsError,
  RouteGroupingValidationError,
  type RouteGroupingService
} from '../modules/route-grouping/route-grouping.types.js';

export type AdminRouteGroupDependencies = {
  routeGroupingService: RouteGroupingService;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminRouteGroupRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteGroupDependencies
): void {
  app.get<{ Querystring: unknown }>('/admin/route-groups', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const query = readListQuery(request.query);
      const routeGroups = await dependencies.routeGroupingService.listGroupings({
        appId: authenticated.appId,
        shopDomain: authenticated.shopDomain,
        ...query
      });
      return reply.code(200).send({ data: { routeGroups }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.post<{ Body: unknown }>('/admin/route-groups', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readCreateGroupingPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.createGrouping({
        appId: authenticated.appId,
        createdBy: authenticated.subject,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      return reply.code(201).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.get<{ Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    const routeGroup = await dependencies.routeGroupingService.getGrouping({
      appId: authenticated.appId,
      groupingId: request.params.routeGroupId,
      shopDomain: authenticated.shopDomain
    });
    if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
    return reply.code(200).send({ data: { routeGroup }, error: null });
  });

  app.post<{ Body: unknown; Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId/branches', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readCreateBranchPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.createBranch({
        appId: authenticated.appId,
        actor: authenticated.subject,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(201).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.patch<{ Body: unknown; Params: { branchId: string; routeGroupId: string } }>('/admin/route-groups/:routeGroupId/branches/:branchId/orders', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readUpdateGroupingOrdersPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.updateBranchOrders({
        appId: authenticated.appId,
        branchId: request.params.branchId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.delete<{ Params: { branchId: string; routeGroupId: string } }>('/admin/route-groups/:routeGroupId/branches/:branchId', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const routeGroup = await dependencies.routeGroupingService.deleteBranch({
        appId: authenticated.appId,
        branchId: request.params.branchId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.patch<{ Body: unknown; Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId/orders', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readUpdateGroupingOrdersPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.updateGroupingOrders({
        appId: authenticated.appId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.patch<{ Body: unknown; Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId/polygons', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readSavePolygonsPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.savePolygons({
        appId: authenticated.appId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.patch<{ Body: unknown; Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId/assignments', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readAssignmentsPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.resolveAssignments({
        appId: authenticated.appId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.post<{ Body: unknown; Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId/generate-child-routes', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const payload = readGenerateChildRoutesPayload(request.body);
      const routeGroup = await dependencies.routeGroupingService.generateChildRoutes({
        appId: authenticated.appId,
        actor: authenticated.subject,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain,
        ...payload
      });
      if (routeGroup === null) return reply.code(404).send(errorResponse('NOT_FOUND', 'Route group not found'));
      return reply.code(200).send({ data: { routeGroup }, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });

  app.delete<{ Params: { routeGroupId: string } }>('/admin/route-groups/:routeGroupId', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, request.headers['x-clever-app-id'], dependencies, {
      log: request.log,
      surface: 'admin_route_groups'
    });
    if (authenticated.status === 'unauthorized') return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));

    try {
      const result = await dependencies.routeGroupingService.deleteGrouping({
        appId: authenticated.appId,
        groupingId: request.params.routeGroupId,
        shopDomain: authenticated.shopDomain
      });
      return reply.code(200).send({ data: result, error: null });
    } catch (error) {
      return sendRouteGroupingError(reply, error);
    }
  });
}

function authenticate(
  authorization: string | undefined,
  appIdHeader: string | string[] | undefined,
  dependencies: AdminRouteGroupDependencies,
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

function readListQuery(value: unknown): { dateRangeEnd?: string; dateRangeStart?: string; deliveryDate?: string } {
  const query = objectOrEmpty(value);
  return {
    ...optionalDateField(query, 'deliveryDate'),
    ...optionalDateField(query, 'dateRangeStart'),
    ...optionalDateField(query, 'dateRangeEnd')
  };
}

function readCreateGroupingPayload(value: unknown): {
  dateRangeEnd?: string;
  dateRangeStart?: string;
  name: string;
  orderIds: string[];
  planDate?: string;
} {
  const object = requireObject(value);
  return {
    ...optionalDateField(object, 'planDate'),
    ...optionalDateField(object, 'dateRangeStart'),
    ...optionalDateField(object, 'dateRangeEnd'),
    name: requireNonEmptyString(object.name),
    orderIds: readStringArray(object.orderIds)
  };
}

function readUpdateGroupingOrdersPayload(value: unknown): { addOrderIds?: string[]; expectedUpdatedAt?: string; removeOrderIds?: string[] } {
  const object = requireObject(value);
  return {
    ...(object.addOrderIds === undefined ? {} : { addOrderIds: readStringArray(object.addOrderIds) }),
    ...(object.removeOrderIds === undefined ? {} : { removeOrderIds: readStringArray(object.removeOrderIds) }),
    ...optionalStringField(object, 'expectedUpdatedAt')
  };
}

function readCreateBranchPayload(value: unknown): { driverId?: string | null; label?: string | null; orderIds?: string[] } {
  const object = requireObject(value);
  return {
    ...(object.driverId === undefined ? {} : { driverId: readNullableString(object.driverId) }),
    ...(object.label === undefined ? {} : { label: readNullableString(object.label) }),
    ...(object.orderIds === undefined ? {} : { orderIds: readStringArray(object.orderIds) })
  };
}

function readSavePolygonsPayload(value: unknown): {
  deletePolygonIds?: string[];
  expectedUpdatedAt: string;
  polygons: Array<{ closed: boolean; color?: string | null; driverId?: string | null; geometry: unknown; id?: string | null; label: string }>;
} {
  const object = requireObject(value);
  if (!Array.isArray(object.polygons)) throw new BadRouteGroupPayloadError('polygons must be an array');
  return {
    ...(object.deletePolygonIds === undefined ? {} : { deletePolygonIds: readStringArray(object.deletePolygonIds) }),
    expectedUpdatedAt: requireNonEmptyString(object.expectedUpdatedAt),
    polygons: object.polygons.map((entry) => {
      const polygon = requireObject(entry);
      return {
        closed: readBoolean(polygon.closed),
        ...(polygon.color === undefined ? {} : { color: readNullableString(polygon.color) }),
        ...(polygon.driverId === undefined ? {} : { driverId: readNullableString(polygon.driverId) }),
        geometry: polygon.geometry,
        ...(polygon.id === undefined ? {} : { id: readNullableString(polygon.id) }),
        label: requireNonEmptyString(polygon.label)
      };
    })
  };
}

function readAssignmentsPayload(value: unknown): { assignments: Array<{ assignedDriverId: string; orderId: string }> } {
  const object = requireObject(value);
  if (!Array.isArray(object.assignments)) throw new BadRouteGroupPayloadError('assignments must be an array');
  return {
    assignments: object.assignments.map((entry) => {
      const assignment = requireObject(entry);
      return {
        assignedDriverId: requireNonEmptyString(assignment.assignedDriverId),
        orderId: requireNonEmptyString(assignment.orderId)
      };
    })
  };
}

function readGenerateChildRoutesPayload(value: unknown): { confirmRisk?: boolean } {
  if (value === undefined || value === null) return {};
  const object = requireObject(value);
  return object.confirmRisk === undefined ? {} : { confirmRisk: readBoolean(object.confirmRisk) };
}

function sendRouteGroupingError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RouteGroupingBranchLockConflictError) return reply.code(409).send({ data: { orderIds: error.orderIds }, error: { code: error.code, message: error.message } });
  if (error instanceof RouteGroupingConflictError) return reply.code(409).send(errorResponse(error.code, error.message));
  if (error instanceof RouteGroupingDeleteBlockedError) return reply.code(409).send(errorResponse(error.code, error.blockers.join('; ')));
  if (error instanceof RouteGroupingRiskConfirmationRequiredError) {
    return reply.code(409).send({ data: { warnings: error.warnings }, error: { code: error.code, message: error.message } });
  }
  if (error instanceof RouteGroupingUnresolvedAssignmentsError) return reply.code(409).send(errorResponse(error.code, error.message));
  if (error instanceof RouteGroupingValidationError) return reply.code(400).send(errorResponse(error.code, error.blockers.join('; ')));
  if (error instanceof BadRouteGroupPayloadError) return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route group payload'));
  throw error;
}

class BadRouteGroupPayloadError extends Error {}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireObject(value);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRouteGroupPayloadError('object required');
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadRouteGroupPayloadError('string array required');
  return value.map(requireNonEmptyString);
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BadRouteGroupPayloadError('non-empty string required');
  return value.trim();
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRouteGroupPayloadError('string required');
  return value.trim() === '' ? null : value.trim();
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BadRouteGroupPayloadError('boolean required');
  return value;
}

function optionalStringField<T extends string>(object: Record<string, unknown>, key: T): Partial<Record<T, string>> {
  if (object[key] === undefined || object[key] === null || object[key] === '') return {};
  return { [key]: requireNonEmptyString(object[key]) } as Partial<Record<T, string>>;
}

function optionalDateField<T extends string>(object: Record<string, unknown>, key: T): Partial<Record<T, string>> {
  const field = optionalStringField(object, key);
  const value = field[key];
  if (value === undefined) return field;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new BadRouteGroupPayloadError(`${key} must be YYYY-MM-DD`);
  return field;
}

function errorResponse(code: string, message: string): { data: null; error: { code: string; message: string } } {
  return { data: null, error: { code, message } };
}
