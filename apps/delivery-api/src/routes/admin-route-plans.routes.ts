import type { FastifyInstance } from 'fastify';

import {
  logRejectedAdminSessionToken,
  type AdminSessionAuthLogContext,
  type AdminSessionTokenVerifier
} from './admin-session-auth.js';

import {
  RoutePlanDriverAssignInvalidError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanOptionsUpdateInvalidError,
  RoutePlanStopUpdateInvalidError
} from '../modules/route-plans/route-plan.types.js';
import type {
  CreateRoutePlanPayload,
  RoutePlanOrderAttributeInput,
  RoutePlanOrderInput,
  RoutePlanRouteScopeInput,
  RoutePlanService,
  RoutePlanShippingAddressInput,
  UpdateRoutePlanDriverPayload,
  UpdateRoutePlanOptionsPayload,
  UpdateRoutePlanStopsPayload
} from '../modules/route-plans/route-plan.types.js';

export type AdminRoutePlanDependencies = {
  routePlanService: RoutePlanService;
  sessionTokenVerifier: AdminSessionTokenVerifier;
};

export function registerAdminRoutePlanRoutes(
  app: FastifyInstance,
  dependencies: AdminRoutePlanDependencies
): void {
  app.post<{ Body: unknown }>('/admin/route-plans', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, dependencies, {
      log: request.log,
      surface: 'admin_route_plans'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    let payload: CreateRoutePlanPayload;
    try {
      payload = readCreateRoutePlanPayload(request.body);
    } catch (error) {
      if (error instanceof RouteScopeMismatchError) {
        return reply
          .code(400)
          .send(errorResponse('ROUTE_SCOPE_MISMATCH', 'Route plan contains orders from different delivery scopes.'));
      }
      return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route plan payload'));
    }

    let routePlan;
    try {
      routePlan = await dependencies.routePlanService.createRoutePlan({
        createdBy: authenticated.subject,
        payload,
        shopDomain: authenticated.shopDomain
      });
    } catch (error) {
      if (error instanceof RoutePlanOrderAlreadyPlannedError) {
        return reply
          .code(409)
          .send(
            errorResponse(
              'ROUTE_ORDER_ALREADY_PLANNED',
              '이미 Route에 등록된 주문이 포함되어 있어 새 Route를 만들지 않았습니다. Orders의 기본 Un-routed view에서 아직 Route에 없는 주문만 선택해주세요.'
            )
          );
      }

      throw error;
    }

    return reply.code(201).send({
      data: { routePlan },
      error: null
    });
  });

  app.get('/admin/route-plans', async (request, reply) => {
    const authenticated = authenticate(request.headers.authorization, dependencies, {
      log: request.log,
      surface: 'admin_route_plans'
    });
    if (authenticated.status === 'unauthorized') {
      return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
    }

    const routePlans = await dependencies.routePlanService.listRoutePlans({
      shopDomain: authenticated.shopDomain
    });

    return reply.code(200).send({
      data: { routePlans },
      error: null
    });
  });

  app.get<{ Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, dependencies, {
        log: request.log,
        surface: 'admin_route_plans'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      const detail = await dependencies.routePlanService.getRoutePlanDetail({
        routePlanId: request.params.routePlanId,
        shopDomain: authenticated.shopDomain
      });
      if (detail === null) {
        return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
      }

      return reply.code(200).send({
        data: detail,
        error: null
      });
    }
  );

  app.patch<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/driver',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, dependencies, {
        log: request.log,
        surface: 'admin_route_plans'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      let payload: UpdateRoutePlanDriverPayload;
      try {
        payload = readUpdateRoutePlanDriverPayload(request.body);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route driver assignment payload'));
      }

      try {
        const detail = await dependencies.routePlanService.assignRoutePlanDriver({
          payload,
          routePlanId: request.params.routePlanId,
          shopDomain: authenticated.shopDomain
        });
        if (detail === null) {
          return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
        }

        return reply.code(200).send({
          data: detail,
          error: null
        });
      } catch (error) {
        if (error instanceof RoutePlanDriverAssignInvalidError) {
          return reply.code(400).send(errorResponse(error.code, error.message));
        }
        throw error;
      }
    }
  );

  app.patch<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/stops',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, dependencies, {
        log: request.log,
        surface: 'admin_route_plans'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      let payload: UpdateRoutePlanStopsPayload;
      try {
        payload = readUpdateRoutePlanStopsPayload(request.body);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route stop update payload'));
      }

      try {
        const detail = await dependencies.routePlanService.updateRoutePlanStops({
          payload,
          routePlanId: request.params.routePlanId,
          shopDomain: authenticated.shopDomain
        });
        if (detail === null) {
          return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
        }

        return reply.code(200).send({
          data: detail,
          error: null
        });
      } catch (error) {
        if (error instanceof RoutePlanStopUpdateInvalidError) {
          return reply.code(400).send(errorResponse(error.code, error.message));
        }
        if (error instanceof RoutePlanOrderAlreadyPlannedError) {
          return reply
            .code(409)
            .send(
              errorResponse(
                'ROUTE_ORDER_ALREADY_PLANNED',
                '이미 다른 Route에 등록된 주문이 포함되어 있어 Route stops를 저장하지 않았습니다. 아직 Route에 없는 주문만 추가해주세요.'
              )
            );
        }
        throw error;
      }
    }
  );

  app.patch<{ Body: unknown; Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId/options',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, dependencies, {
        log: request.log,
        surface: 'admin_route_plans'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      let payload: UpdateRoutePlanOptionsPayload;
      try {
        payload = readUpdateRoutePlanOptionsPayload(request.body);
      } catch {
        return reply.code(400).send(errorResponse('BAD_REQUEST', 'Invalid route options payload'));
      }

      try {
        const detail = await dependencies.routePlanService.updateRoutePlanOptions({
          payload,
          routePlanId: request.params.routePlanId,
          shopDomain: authenticated.shopDomain
        });
        if (detail === null) {
          return reply.code(404).send(errorResponse('NOT_FOUND', 'Route plan not found'));
        }

        return reply.code(200).send({
          data: detail,
          error: null
        });
      } catch (error) {
        if (error instanceof RoutePlanOptionsUpdateInvalidError) {
          return reply.code(400).send(errorResponse(error.code, error.message));
        }
        throw error;
      }
    }
  );

  app.delete<{ Params: { routePlanId: string } }>(
    '/admin/route-plans/:routePlanId',
    async (request, reply) => {
      const authenticated = authenticate(request.headers.authorization, dependencies, {
        log: request.log,
        surface: 'admin_route_plans'
      });
      if (authenticated.status === 'unauthorized') {
        return reply.code(401).send(errorResponse('UNAUTHORIZED', authenticated.message));
      }

      const result = await dependencies.routePlanService.deleteRoutePlan({
        routePlanId: request.params.routePlanId,
        shopDomain: authenticated.shopDomain
      });

      return reply.code(200).send({
        data: result,
        error: null
      });
    }
  );
}

function authenticate(
  authorization: string | undefined,
  dependencies: AdminRoutePlanDependencies,
  options: AdminSessionAuthLogContext
):
  | { shopDomain: string; status: 'authenticated'; subject: string }
  | { message: string; status: 'unauthorized' } {
  const sessionToken = extractBearerToken(authorization);
  if (sessionToken === null) {
    return { message: 'Missing bearer session token', status: 'unauthorized' };
  }

  try {
    const verified = dependencies.sessionTokenVerifier.verify(sessionToken);
    return {
      shopDomain: verified.shopDomain,
      status: 'authenticated',
      subject: verified.subject
    };
  } catch (error) {
    logRejectedAdminSessionToken({ ...options, error });
    return { message: 'Invalid Shopify session token', status: 'unauthorized' };
  }
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim() === '') {
    return null;
  }

  return match[1].trim();
}

function readCreateRoutePlanPayload(value: unknown): CreateRoutePlanPayload {
  const object = requireObject(value);
  const name = requireNonEmptyString(object.name);
  const planDate = requirePlanDate(object.planDate);
  const depot = readDepot(object.depot);
  const orders = readOrders(object.orders);
  const routeScope = readRouteScope(object.routeScope);
  validateRouteScope(planDate, orders, routeScope);

  return {
    depot,
    name,
    orders,
    planDate,
    ...(routeScope === undefined ? {} : { routeScope })
  };
}

function readUpdateRoutePlanStopsPayload(value: unknown): UpdateRoutePlanStopsPayload {
  const object = requireObject(value);
  if (!Array.isArray(object.stops)) {
    throw new Error('stops must be an array');
  }

  return {
    stops: object.stops.map((item) => {
      const stop = requireObject(item);
      const deliveryStopId = readNullableString(stop.deliveryStopId);
      return {
        ...(deliveryStopId === null ? {} : { deliveryStopId }),
        sequence: requirePositiveInteger(stop.sequence),
        shopifyOrderGid: requireNonEmptyString(stop.shopifyOrderGid)
      };
    })
  };
}

function readUpdateRoutePlanDriverPayload(value: unknown): UpdateRoutePlanDriverPayload {
  const object = requireObject(value);
  return {
    driverId: readNullableString(object.driverId)
  };
}

function readUpdateRoutePlanOptionsPayload(value: unknown): UpdateRoutePlanOptionsPayload {
  const object = requireObject(value);
  const routeEndMode = requireNonEmptyString(object.routeEndMode);
  if (routeEndMode !== 'END_AT_LAST_STOP' && routeEndMode !== 'RETURN_TO_DEPOT') {
    throw new Error('routeEndMode must be supported');
  }
  return { routeEndMode };
}


class RouteScopeMismatchError extends Error {}

function readRouteScope(value: unknown): RoutePlanRouteScopeInput | undefined {
  if (value === undefined || value === null) return undefined;
  const object = requireObject(value);
  const deliveryDate = requirePlanDate(object.deliveryDate);
  const serviceType = readLegacyServiceType(object.serviceType);
  const deliverySession = readLegacyDeliverySession(object.deliverySession);
  return {
    deliveryDate,
    deliverySession,
    routeScopeKey: requireNonEmptyString(object.routeScopeKey),
    serviceType,
    timeWindowEnd: readNullableTime(object.timeWindowEnd),
    timeWindowStart: readNullableTime(object.timeWindowStart)
  };
}

function validateRouteScope(
  planDate: string,
  orders: RoutePlanOrderInput[],
  routeScope: RoutePlanRouteScopeInput | undefined
): void {
  if (routeScope === undefined) return;
  if (planDate !== routeScope.deliveryDate) throw new RouteScopeMismatchError();
  for (const order of orders) {
    if (readOrderRouteScopeKey(order) !== routeScope.routeScopeKey) throw new RouteScopeMismatchError();
  }
}

function readOrderRouteScopeKey(order: RoutePlanOrderInput): string | null {
  const rawPayload = objectOrNull(order.rawPayload);
  return order.routeScopeKey ?? readNullableString(rawPayload?.routeScopeKey);
}

function readDepot(value: unknown): CreateRoutePlanPayload['depot'] {
  const object = requireObject(value);
  return {
    address: readNullableString(object.address),
    latitude: readNullableCoordinate(object.latitude),
    longitude: readNullableCoordinate(object.longitude)
  };
}

function readOrders(value: unknown): RoutePlanOrderInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('orders must be a non-empty array');
  }

  return value.map((item) => readOrder(item));
}

function readOrder(value: unknown): RoutePlanOrderInput {
  const object = requireObject(value);
  const deliveryDate = readNullablePlanDate(object.deliveryDate);
  const deliverySession = readNullableDeliverySession(object.deliverySession);
  const serviceType = readNullableServiceType(object.serviceType);
  const timeWindowEnd = readNullableTime(object.timeWindowEnd);
  const timeWindowStart = readNullableTime(object.timeWindowStart);
  const rawPayload = object.rawPayload ?? {};
  const routeScopeKey =
    readNullableString(object.routeScopeKey) ??
    readNullableString(objectOrNull(rawPayload)?.routeScopeKey) ??
    buildRouteScopeKey({
      deliveryDate,
      serviceType,
      timeWindowEnd,
      timeWindowStart
    });

  return {
    attributes: readAttributes(object.attributes),
    currencyCode: readNullableString(object.currencyCode),
    deliveryArea: readNullableString(object.deliveryArea),
    deliveryDate,
    deliveryDay: readNullableString(object.deliveryDay),
    deliverySession,
    email: readNullableString(object.email),
    financialStatus: readNullableString(object.financialStatus),
    fulfillmentStatus: readNullableString(object.fulfillmentStatus),
    latitude: readNullableCoordinate(object.latitude),
    longitude: readNullableCoordinate(object.longitude),
    name: requireNonEmptyString(object.name),
    phone: readNullableString(object.phone),
    planningGroupKey: readNullableString(object.planningGroupKey),
    processedAt: readNullableDate(object.processedAt),
    rawPayload,
    recipientName: readNullableString(object.recipientName),
    routeScopeKey,
    serviceType,
    shippingAddress: readShippingAddress(object.shippingAddress),
    shopifyOrderGid: requireNonEmptyString(object.shopifyOrderGid),
    timeWindowEnd,
    timeWindowStart,
    totalPriceAmount: readNullableString(object.totalPriceAmount)
  };
}

function readShippingAddress(value: unknown): RoutePlanShippingAddressInput {
  const object = requireObject(value);
  return {
    address1: readNullableString(object.address1),
    address2: readNullableString(object.address2),
    city: readNullableString(object.city),
    countryCode: readNullableString(object.countryCode),
    postalCode: readNullableString(object.postalCode),
    province: readNullableString(object.province)
  };
}

function readAttributes(value: unknown): RoutePlanOrderAttributeInput[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('attributes must be an array');
  }

  return value.map((item) => {
    const object = requireObject(item);
    return {
      key: requireNonEmptyString(object.key),
      value: requireNonEmptyString(object.value)
    };
  });
}


function readNullableTime(value: unknown): string | null {
  const text = readNullableString(value);
  if (text === null) return null;
  if (!/^\d{2}:\d{2}$/u.test(text)) throw new Error('time must be HH:mm');
  return text;
}

function readNullablePlanDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requirePlanDate(value);
}

const LEGACY_DELIVERY_SESSIONS = new Set(['DAY', 'EVENING', 'PICKUP']);
const LEGACY_SERVICE_TYPES = new Set(['DELIVERY', 'EVENING_DELIVERY', 'PICKUP']);

function readNullableDeliverySession(value: unknown): RoutePlanOrderInput['deliverySession'] {
  const text = readNullableString(value);
  if (text === null) return null;
  return readLegacyDeliverySession(text);
}

function readNullableServiceType(value: unknown): RoutePlanOrderInput['serviceType'] {
  const text = readNullableString(value);
  if (text === null) return null;
  return readLegacyServiceType(text);
}

function readLegacyDeliverySession(value: unknown): string {
  const text = requireNonEmptyString(value);
  if (!LEGACY_DELIVERY_SESSIONS.has(text)) throw new Error('invalid deliverySession');
  return text;
}

function readLegacyServiceType(value: unknown): string {
  const text = requireNonEmptyString(value);
  if (!LEGACY_SERVICE_TYPES.has(text)) throw new Error('invalid serviceType');
  return text;
}

function buildRouteScopeKey(input: {
  deliveryDate: string | null;
  serviceType: RoutePlanOrderInput['serviceType'];
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
}): string | null {
  if (input.deliveryDate === null || input.serviceType === null || input.serviceType === undefined) {
    return null;
  }

  return [
    input.deliveryDate,
    input.serviceType,
    input.timeWindowStart ?? '',
    input.timeWindowEnd ?? ''
  ].join('|');
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('object required');
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('non-empty string required');
  }

  return value.trim();
}

function requirePlanDate(value: unknown): string {
  const planDate = requireNonEmptyString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(planDate)) {
    throw new Error('planDate must be YYYY-MM-DD');
  }

  const date = new Date(`${planDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== planDate) {
    throw new Error('planDate must be valid');
  }

  return planDate;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('positive integer required');
  }

  return value;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('string required');
  }

  return value.trim() === '' ? null : value.trim();
}

function readNullableCoordinate(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('coordinate must be a finite number');
  }

  return value;
}

function readNullableDate(value: unknown): Date | null {
  const text = readNullableString(value);
  if (text === null) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid date');
  }

  return date;
}

function errorResponse(code: string, message: string): {
  data: null;
  error: { code: string; message: string };
} {
  return {
    data: null,
    error: { code, message }
  };
}
