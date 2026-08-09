import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  DsvForbiddenError,
  requireDsvScopes,
} from '../modules/dsv/dsv-principal.js';
import type {
  DsvAdminPrincipal,
  DsvCustomerUserPrincipal,
  DsvPrincipal,
  DsvScope,
} from '../modules/dsv/dsv-principal.js';
import {
  cutCustomerScopedRouteGeometry,
  type DsvV1LngLat,
} from '../modules/dsv/dsv-customer-route-geometry.js';
import {
  mapDsvV1ConditionListItem,
  mapDsvV1ControlSummary,
  mapDsvV1CustomerDeliveryInquiryPage,
  mapDsvV1CustomerListItem,
  mapDsvV1DestinationListItem,
  mapDsvV1DriverListItem,
  mapDsvV1ManagementListPage,
  mapDsvV1RecordPage,
  mapDsvV1SellerOrderSummaryPage,
  mapDsvV1SessionPrincipal,
  mapDsvV1VehicleListItem,
  toDsvV1ErrorEnvelope,
  toDsvV1SuccessEnvelope,
  type DsvV1DepartureLocationDto,
  type DsvV1CustomerRouteDto,
  type DsvV1CustomerTrailDto,
  type DsvV1ErrorCode,
} from '../modules/dsv/dsv-v1-read.dto.js';
import {
  DsvV1ReadQueryError,
  type DsvV1CustomerRouteScopeRow,
  type DsvV1CustomerDeliveriesInput,
  type DsvV1DispatchListInput,
  type DsvV1ReadListInput,
  type DsvV1ReadQueryService,
  type DsvV1ServiceDateInput,
  type DsvV1RecordsInput,
  type DsvV1VehicleGpsTrailHistoryInput,
  type DsvV1VehicleGpsTrailHistoryResult,
  type DsvV1VehicleTemperatureHistoryInput,
} from '../modules/dsv/dsv-v1-read-query.service.js';
import {
  DsvTimeConstraintCommandError,
  type DsvClearTimeConstraintInput,
  type DsvConfirmTimeConstraintInput,
  type DsvTimeConstraintActor,
  type DsvTimeConstraintCommandService,
} from '../modules/dsv/dsv-time-constraint-command.service.js';
import {
  DsvDispatchChangeRequestError,
  type DsvDispatchChangeRequestCancelInput,
  type DsvDispatchChangeRequestCommandInput,
  type DsvDispatchRecoveryInput,
  type DsvDispatchChangeRequestService,
} from '../modules/dsv/dsv-dispatch-change-request.service.js';
import {
  DsvOrderMessageError,
  type DsvOrderMessageService,
} from '../modules/dsv/dsv-order-message.service.js';
import type { DsvOperationalNotificationService } from '../modules/dsv/dsv-operational-notification.service.js';
import type { DsvDriverNotificationRuntime } from '../modules/dsv/dsv-driver-notification.runtime.js';
import type { DsvMapProfile } from '../modules/dsv/dsv-map-profile.config.js';
import type { DsvRouteOptimizationSchedulerPort } from '../modules/dsv/dsv-route-optimization.scheduler.js';
import type { RouteGeometryProvider } from '../modules/route-plans/route-plan.service.js';
import type { RoutePlanDetail, RoutePlanService } from '../modules/route-plans/route-plan.types.js';
import {
  clearAdminWebSessionCookie,
  verifyAdminWebCsrfToken,
  verifyAdminWebSessionFromRequest,
} from './admin-ui-session.js';

export type { DsvV1ReadQueryService } from '../modules/dsv/dsv-v1-read-query.service.js';

const apiRoot = '/api/dsv/v1';
const cookiePath = '/api/dsv/';

type DsvV1Session = {
  principal: DsvPrincipal;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
};

export type DsvV1SessionResolver = {
  resolve(subject: string): Promise<DsvPrincipal>;
};

export type DsvV1ReadDependencies = {
  cookieName: string;
  mapProfile?: DsvMapProfile;
  queryService?: DsvV1ReadQueryService;
  routeGeometryProvider?: Pick<RouteGeometryProvider, 'buildRoute'>;
  routeOptimizationScheduler?: DsvRouteOptimizationSchedulerPort;
  routePlanService?: Pick<RoutePlanService, 'getRoutePlanDetail' | 'listRoutePlans'>;
  secureCookies: boolean;
  sessionResolver: DsvV1SessionResolver;
  sessionSecret: string;
  dispatchChangeRequestService?: DsvDispatchChangeRequestService;
  driverNotificationRuntime?: DsvDriverNotificationRuntime;
  orderMessageService?: DsvOrderMessageService;
  operationalNotificationService?: DsvOperationalNotificationService;
  timeConstraintCommandService?: DsvTimeConstraintCommandService;
};

type RouteSpec<Query> = {
  allowedQuery: readonly string[];
  handler: (principal: DsvPrincipal, query: Query) => unknown;
  parseQuery: (request: FastifyRequest) => Query | null;
  requiredScopes: readonly DsvScope[];
};

export function registerDsvV1ReadRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.get(`${apiRoot}/session`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, (session) =>
      sendV1Data(
        reply,
        request,
        mapDsvV1SessionPrincipal(session.principal, session.session.csrfToken),
      )));

  app.post(`${apiRoot}/session/logout`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, (session) => {
      if (hasUnsupportedQuery(request, [])) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
      if (!isEmptyObjectBody(request.body)) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported request body');
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      return sendV1Data(reply.header('Set-Cookie', clearAdminWebSessionCookie({
        cookieName: dependencies.cookieName,
        path: cookiePath,
        secure: dependencies.secureCookies,
      })), request, { ok: true });
    }));

  registerReadRoute(app, dependencies, 'dispatches', {
    allowedQuery: ['cursor', 'destinationName', 'limit', 'orderNumber', 'serviceDate'],
    handler: async (principal, query) => mapDsvV1SellerOrderSummaryPage(
      await requireQueryService(dependencies).listDispatches(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parseDispatchesQuery,
    requiredScopes: ['dsv:dispatches:read'],
  });
  registerReadRoute(app, dependencies, 'control', {
    allowedQuery: ['serviceDate'],
    handler: async (principal, query) => mapDsvV1ControlSummary(
      await requireQueryService(dependencies).listControl(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parseServiceDateOnlyQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'control/routes', {
    allowedQuery: ['serviceDate'],
    handler: async (principal, query) => {
      const admin = requireAdminPrincipal(principal);
      const queryService = requireQueryService(dependencies);
      const routePlanService = requireRoutePlanService(dependencies);
      const shopDomain = requireAdminShopDomain(admin);
      const serviceDate = query.serviceDate ?? (await queryService.resolveTenantDates(admin.shopId)).today;
      const routePlans = await routePlanService.listRoutePlans({
        appId: 'clever',
        deliveryDate: serviceDate,
        shopDomain,
      });
      const details = await Promise.all(routePlans.map((routePlan) => routePlanService.getRoutePlanDetail({
        appId: 'clever',
        routePlanId: routePlan.id,
        shopDomain,
      })));
      return {
        routes: details.flatMap((detail) => {
          if (detail === null) return [];
          return [{
            coordinates: detail.routeGeometry?.coordinates ?? [],
            generatedAt: detail.routeGeometryGeneratedAt ?? null,
            geometryStatus: detail.routeGeometryStatus ?? 'missing',
            legDurationsSeconds: [...detail.routeStopPoints]
              .sort((left, right) => left.sequence - right.sequence)
              .map((stop) => stop.durationFromPreviousSeconds ?? null),
            routePlanId: detail.routePlan.id,
          }];
        }),
        serviceDate,
      };
    },
    parseQuery: parseServiceDateOnlyQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'map/profile', {
    allowedQuery: [],
    handler: () => {
      if (dependencies.mapProfile === undefined) {
        throw new DsvV1DependencyError('DSV map profile is not configured');
      }
      return dependencies.mapProfile;
    },
    parseQuery: parseEmptyQuery,
    requiredScopes: [],
  });
  registerReadRoute(app, dependencies, 'records', {
    allowedQuery: ['limit', 'page', 'serviceDate'],
    handler: async (principal, query) => mapDsvV1RecordPage(
      await requireQueryService(dependencies).listRecords(requireAdminPrincipal(principal), query)
    ),
    parseQuery: parseRecordsQuery,
    requiredScopes: ['dsv:records:read'],
  });
  registerReadRoute(app, dependencies, 'drivers', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listDrivers(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1DriverListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:resources:read'],
  });
  registerReadRoute(app, dependencies, 'vehicles', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listVehicles(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1VehicleListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:resources:read'],
  });
  registerReadRoute(app, dependencies, 'vehicles/:vehicleId/temperature-history', {
    allowedQuery: ['from', 'limit', 'to'],
    handler: async (principal, query) =>
      requireQueryService(dependencies).listVehicleTemperatureHistory(requireAdminPrincipal(principal), query),
    parseQuery: parseVehicleTemperatureHistoryQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'vehicles/:vehicleId/gps-trail-history', {
    allowedQuery: ['serviceDate'],
    handler: async (principal, query) =>
      requireQueryService(dependencies).listVehicleGpsTrailHistory(requireAdminPrincipal(principal), query),
    parseQuery: parseVehicleGpsTrailHistoryQuery,
    requiredScopes: ['dsv:control:read'],
  });
  registerReadRoute(app, dependencies, 'customers', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listCustomers(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1CustomerListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:customers:read'],
  });
  registerReadRoute(app, dependencies, 'destinations', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listDestinations(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1DestinationListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:destinations:read'],
  });
  registerReadRoute(app, dependencies, 'conditions', {
    allowedQuery: ['cursor', 'limit'],
    handler: async (principal, query) => {
      const page = await requireQueryService(dependencies).listConditions(requireAdminPrincipal(principal), query);
      return mapDsvV1ManagementListPage({ items: page.items.map(mapDsvV1ConditionListItem), page: page.page });
    },
    parseQuery: parsePagedQuery,
    requiredScopes: ['dsv:conditions:read'],
  });
  registerTimeConstraintCommandRoutes(app, dependencies);
  registerDispatchChangeRequestRoutes(app, dependencies);
  registerOrderMessageRoutes(app, dependencies);
  registerOperationalNotificationRoutes(app, dependencies);
  registerReadRoute(app, dependencies, 'customer/deliveries', {
    allowedQuery: ['cursor', 'includeGpsTrails', 'limit', 'serviceDate', 'window'],
    handler: async (principal, query) => {
      const customerPrincipal = requireCustomerPrincipal(principal);
      const page = await requireQueryService(dependencies).listCustomerDeliveries(customerPrincipal, query);
      const routeScope = page.emptyReason === undefined
        ? await requireQueryService(dependencies).listCustomerRouteScope(customerPrincipal, page.serviceDate)
        : [];
      const trailHistories = query.includeGpsTrails === true && routeScope.length > 0
        ? await requireQueryService(dependencies).listCustomerGpsTrailHistories(customerPrincipal, page.serviceDate, routeScope)
        : [];
      return mapDsvV1CustomerDeliveryInquiryPage({
        ...page,
        customerDisplayName: customerDisplayNameFromDeliveries(page.items),
        ...(await buildCustomerScopedRoutes({
          items: routeScope,
          ...(dependencies.routeGeometryProvider === undefined ? {} : { routeGeometryProvider: dependencies.routeGeometryProvider }),
          ...(dependencies.routePlanService === undefined ? {} : { routePlanService: dependencies.routePlanService }),
          shopDomain: requireCustomerShopDomain(customerPrincipal),
          trailHistories,
        })),
      });
    },
    parseQuery: parseCustomerDeliveriesQuery,
    requiredScopes: ['dsv:customer-deliveries:read'],
  });
  registerReadRoute(app, dependencies, 'customers/deliveries', {
    allowedQuery: ['cursor', 'customerId', 'includeGpsTrails', 'limit', 'serviceDate', 'window'],
    handler: async (principal, query) => {
      const adminPrincipal = requireAdminPrincipal(principal);
      const page = await requireQueryService(dependencies).listCustomerDeliveriesForAdmin(
        adminPrincipal,
        query.customerId,
        query,
      );
      const routeScope = page.emptyReason === undefined
        ? await requireQueryService(dependencies).listCustomerRouteScopeForAdmin(
            adminPrincipal,
            query.customerId,
            page.serviceDate,
          )
        : [];
      const trailHistories = query.includeGpsTrails === true && routeScope.length > 0
        ? await requireQueryService(dependencies).listCustomerGpsTrailHistoriesForAdmin(
            adminPrincipal,
            page.serviceDate,
            routeScope,
          )
        : [];
      return mapDsvV1CustomerDeliveryInquiryPage({
        ...page,
        customerDisplayName: customerDisplayNameFromDeliveries(page.items),
        ...(await buildCustomerScopedRoutes({
          items: routeScope,
          ...(dependencies.routeGeometryProvider === undefined ? {} : { routeGeometryProvider: dependencies.routeGeometryProvider }),
          ...(dependencies.routePlanService === undefined ? {} : { routePlanService: dependencies.routePlanService }),
          shopDomain: requireAdminShopDomain(adminPrincipal),
          trailHistories,
        })),
      });
    },
    parseQuery: parseAdminCustomerDeliveriesQuery,
    requiredScopes: ['dsv:customers:read', 'dsv:dispatches:read'],
  });
}

function registerOperationalNotificationRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.get(`${apiRoot}/operational-notifications`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:read']);
      const service = dependencies.operationalNotificationService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV operational notification service is not configured');
      return sendV1Data(reply, request, await service.list({ shopDomain: requireAdminShopDomain(principal) }));
    }));
}

function registerDispatchChangeRequestRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.post(`${apiRoot}/seller-orders/:sellerOrderId/active-removal/request`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.dispatchChangeRequestService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV dispatch change request service is not configured');
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readActiveRemovalCommand(request);
      if (sellerOrderId === null || command === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid active removal payload');
      try {
        return sendV1Data(reply, request, await service.requestActiveRemoval({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendDispatchChangeRequestError(reply, request, error);
      }
    }));

  app.post(`${apiRoot}/seller-orders/:sellerOrderId/recover-unassigned`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.dispatchChangeRequestService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV dispatch change request service is not configured');
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readRecoverUnassignedCommand(request);
      if (sellerOrderId === null || command === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid recovery payload');
      try {
        return sendV1Data(reply, request, await service.recoverCancelledToUnassigned({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendDispatchChangeRequestError(reply, request, error);
      }
    }));

  app.post(`${apiRoot}/dispatch-change-requests/:changeRequestId/cancel`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.dispatchChangeRequestService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV dispatch change request service is not configured');
      const changeRequestId = readUuidParam(request, 'changeRequestId');
      const command = readCancelChangeRequestCommand(request);
      if (changeRequestId === null || command === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid dispatch change cancel payload');
      try {
        return sendV1Data(reply, request, await service.cancel({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          changeRequestId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendDispatchChangeRequestError(reply, request, error);
      }
    }));
}

function registerOrderMessageRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.post(`${apiRoot}/seller-orders/:sellerOrderId/messages`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.orderMessageService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV order message service is not configured');
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const body = readCreateOrderMessageBody(request);
      if (sellerOrderId === null || body === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid order message payload');
      try {
        return sendV1Data(reply, request, await service.create({
          actor: dsvV1AdminCommandActor(principal, request),
          ...body,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendOrderMessageError(reply, request, error);
      }
    }));

  app.get(`${apiRoot}/customer/seller-orders/:sellerOrderId/messages`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireCustomerPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:customer-deliveries:read']);
      const service = dependencies.orderMessageService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV order message service is not configured');
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      if (sellerOrderId === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid seller order id');
      try {
        return sendV1Data(reply, request, { messages: await service.listCustomerMessages({ customerId: principal.customerId, sellerOrderId, shopId: principal.shopId }) });
      } catch (error) {
        return sendOrderMessageError(reply, request, error);
      }
    }));

  app.patch(`${apiRoot}/customers/:customerId/notification-settings`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:customers:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.orderMessageService;
      if (service === undefined) return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV order message service is not configured');
      const customerId = readUuidParam(request, 'customerId');
      const body = readCustomerNotificationSettingsBody(request);
      if (customerId === null || body === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid customer notification settings payload');
      try {
        return sendV1Data(reply, request, await service.updateCustomerNotificationSettings({
          customerId,
          ...body,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendOrderMessageError(reply, request, error);
      }
    }));
}

async function buildCustomerScopedRoutes(input: {
  items: readonly DsvV1CustomerRouteScopeRow[];
  routeGeometryProvider?: Pick<RouteGeometryProvider, 'buildRoute'>;
  routePlanService?: Pick<RoutePlanService, 'getRoutePlanDetail' | 'listRoutePlans'>;
  shopDomain: string;
  trailHistories?: readonly DsvV1VehicleGpsTrailHistoryResult[];
}): Promise<{
  departureLocation?: DsvV1DepartureLocationDto;
  routes: DsvV1CustomerRouteDto[];
  trails?: DsvV1CustomerTrailDto[];
}> {
  const routeKeys = uniqueRouteKeys(input.items);
  if (routeKeys.length === 0) return { routes: [] };
  if (input.routePlanService === undefined) {
    throw new DsvV1DependencyError('DSV route plan read service is not configured');
  }
  const routes: DsvV1CustomerRouteDto[] = [];
  const trails: DsvV1CustomerTrailDto[] = [];
  let departureLocation: DsvV1DepartureLocationDto | undefined;
  for (const routeKey of routeKeys) {
    const detail = await input.routePlanService.getRoutePlanDetail({
      appId: 'clever',
      routePlanId: routeKey.routePlanId,
      shopDomain: input.shopDomain,
    });
    if (detail === null) continue;
    const depot = routePlanDepotCoordinates(detail);
    departureLocation ??= depot === null ? undefined : { latitude: depot[1], longitude: depot[0] };
    const customerOrderIds = new Set(input.items
      .filter((item) => item.routePlanId === routeKey.routePlanId && item.vehicleId === routeKey.vehicleId)
      .map((item) => item.sellerOrderId));
    const customerStops = detail.stops
      .filter((stop) => customerOrderIds.has(stop.orderId))
      .sort((left, right) => left.sequence - right.sequence);
    const lastCustomerStop = customerStops.at(-1) ?? null;
    const firstCustomerStop = customerStops[0] ?? null;
    const end = routeStopEndpoint(detail.routeStopPoints, lastCustomerStop?.deliveryStopId ?? null)
      ?? stopCoordinates(lastCustomerStop);
    const start = routeKey.vehiclePosition ?? depot;
    if (end === null) continue;
    if (start === null) continue;
    const coordinates = detail.routeGeometry === null
      ? await rebuildCustomerScopedRouteGeometry({
          customerStops,
          detail,
          provider: input.routeGeometryProvider,
          start,
        })
      : cutCustomerScopedRouteGeometry({
          coordinates: detail.routeGeometry.coordinates,
          end,
          start,
        }) ?? await rebuildCustomerScopedRouteGeometry({
          customerStops,
          detail,
          provider: input.routeGeometryProvider,
          start,
        });
    const firstRouteSequence = detail.stops.reduce(
      (minimum, stop) => Math.min(minimum, stop.sequence),
      Number.POSITIVE_INFINITY,
    );
    const trailStart = firstCustomerStop?.sequence === firstRouteSequence
      ? depot
      : routeStopEndpoint(detail.routeStopPoints, firstCustomerStop?.deliveryStopId ?? null)
        ?? stopCoordinates(firstCustomerStop);
    const trailEnd = routeStopEndpoint(detail.routeStopPoints, lastCustomerStop?.deliveryStopId ?? null)
      ?? stopCoordinates(lastCustomerStop);
    const history = input.trailHistories?.find((item) => item.vehicleId === routeKey.vehicleId);
    if (history !== undefined && trailStart !== null && trailEnd !== null) {
      const segments = customerScopedTrailSegments(history, routeKey.routePlanId, trailStart, trailEnd);
      if (segments.length > 0) trails.push({ segments, vehicleId: routeKey.vehicleId });
    }
    if (coordinates !== null) routes.push({ coordinates, vehicleId: routeKey.vehicleId });
  }
  return {
    ...(departureLocation === undefined ? {} : { departureLocation }),
    routes,
    ...(input.trailHistories === undefined ? {} : { trails }),
  };
}

function customerScopedTrailSegments(
  history: DsvV1VehicleGpsTrailHistoryResult,
  routePlanId: string,
  start: DsvV1LngLat,
  end: DsvV1LngLat,
): DsvV1CustomerTrailDto['segments'] {
  return history.sessions
    .filter((session) => session.routePlanId === routePlanId)
    .flatMap((session) => clipTrailSession(session.segments, start, end));
}

function clipTrailSession(
  segments: DsvV1VehicleGpsTrailHistoryResult['sessions'][number]['segments'],
  start: DsvV1LngLat,
  end: DsvV1LngLat,
): DsvV1CustomerTrailDto['segments'] {
  const samples = segments.flatMap((segment) => segment.samples.map((sample) => ({
    coordinate: [sample.longitude, sample.latitude] as DsvV1LngLat,
  })));
  if (samples.length < 2) return [];
  const startIndex = nearestTrailSampleIndex(samples, start);
  const nearestEndIndex = nearestTrailSampleIndex(samples, end);
  if (startIndex === null || nearestEndIndex === null) return [];
  const startDistance = coordinateDistanceMeters(samples[startIndex]!.coordinate, start);
  if (startDistance > 1_000) return [];
  const endIndex = coordinateDistanceMeters(samples[nearestEndIndex]!.coordinate, end) <= 1_000
    ? nearestEndIndex
    : samples.length - 1;
  if (endIndex <= startIndex) return [];
  let segmentStartIndex = 0;
  return segments.flatMap((segment) => {
    const localStart = Math.max(0, startIndex - segmentStartIndex);
    const localEnd = Math.min(segment.samples.length - 1, endIndex - segmentStartIndex);
    segmentStartIndex += segment.samples.length;
    const coordinates = localEnd >= localStart
      ? segment.samples.slice(localStart, localEnd + 1).map((sample) => [sample.longitude, sample.latitude] as DsvV1LngLat)
      : [];
    return coordinates.length >= 2 ? [{ coordinates }] : [];
  });
}

function nearestTrailSampleIndex(
  samples: readonly { coordinate: DsvV1LngLat }[],
  target: DsvV1LngLat,
): number | null {
  let nearestIndex: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const distance = coordinateDistanceMeters(sample.coordinate, target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function coordinateDistanceMeters(left: DsvV1LngLat, right: DsvV1LngLat): number {
  const latitudeDelta = (right[1] - left[1]) * Math.PI / 180;
  const longitudeDelta = (right[0] - left[0]) * Math.PI / 180;
  const leftLatitude = left[1] * Math.PI / 180;
  const rightLatitude = right[1] * Math.PI / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(haversine));
}

async function rebuildCustomerScopedRouteGeometry(input: {
  customerStops: RoutePlanDetail['stops'];
  detail: RoutePlanDetail;
  provider: Pick<RouteGeometryProvider, 'buildRoute'> | undefined;
  start: DsvV1LngLat;
}): Promise<DsvV1LngLat[] | null> {
  if (input.provider === undefined || input.customerStops.length === 0) return null;
  try {
    const result = await input.provider.buildRoute({
      ...input.detail,
      routePlan: {
        ...input.detail.routePlan,
        depot: { latitude: input.start[1], longitude: input.start[0] },
        routeEndMode: 'END_AT_LAST_STOP',
      },
      routeGeometry: null,
      routeStopPoints: [],
      stops: input.customerStops,
    });
    return result.routeGeometry?.coordinates ?? null;
  } catch {
    return null;
  }
}

function uniqueRouteKeys(items: readonly DsvV1CustomerRouteScopeRow[]): Array<{
  routePlanId: string;
  vehicleId: string;
  vehiclePosition: DsvV1LngLat | null;
}> {
  const byRouteAndVehicle = new Map<string, { routePlanId: string; vehicleId: string; vehiclePosition: DsvV1LngLat | null }>();
  for (const item of items) {
    if (
      item.routePlanId === undefined
      || item.routePlanId === null
      || item.vehicleId === undefined
      || item.vehicleId === null
    ) continue;
    const key = `${item.routePlanId}:${item.vehicleId}`;
    if (!byRouteAndVehicle.has(key)) {
      byRouteAndVehicle.set(key, {
        routePlanId: item.routePlanId,
        vehicleId: item.vehicleId,
        vehiclePosition: lngLatFromLatLng(item.vehicleLatitude ?? null, item.vehicleLongitude ?? null),
      });
    }
  }
  return [...byRouteAndVehicle.values()];
}

function customerDisplayNameFromDeliveries(items: readonly { customerDisplayName?: string | null }[]): string | null {
  return items.find((item) => item.customerDisplayName !== undefined && item.customerDisplayName !== null)?.customerDisplayName ?? null;
}

function routePlanDepotCoordinates(detail: RoutePlanDetail): DsvV1LngLat | null {
  return lngLatFromLatLng(detail.routePlan.depot.latitude, detail.routePlan.depot.longitude);
}

function lngLatFromLatLng(latitude: number | null, longitude: number | null): DsvV1LngLat | null {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return [longitude, latitude];
}

function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function routeStopEndpoint(
  stopPoints: RoutePlanDetail['routeStopPoints'],
  deliveryStopId: string | null,
): DsvV1LngLat | null {
  if (deliveryStopId === null) return null;
  const stopPoint = stopPoints.find((point) => point.deliveryStopId === deliveryStopId) ?? null;
  return stopPoint?.snappedCoordinates ?? stopPoint?.inputCoordinates ?? null;
}

function stopCoordinates(stop: RoutePlanDetail['stops'][number] | null): DsvV1LngLat | null {
  if (stop === null) return null;
  return lngLatFromLatLng(stop.coordinates.latitude, stop.coordinates.longitude);
}

function registerTimeConstraintCommandRoutes(app: FastifyInstance, dependencies: DsvV1ReadDependencies): void {
  app.post(`${apiRoot}/seller-orders/:sellerOrderId/time-constraint/confirm`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.timeConstraintCommandService;
      if (service === undefined) {
        return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV time constraint command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readConfirmTimeConstraintCommand(request);
      if (sellerOrderId === null || command === null) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid time constraint confirmation payload');
      }
      try {
        return sendV1Data(reply, request, await service.confirm({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendTimeConstraintCommandError(reply, request, error);
      }
    }));

  app.post(`${apiRoot}/seller-orders/:sellerOrderId/time-constraint/clear`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      const principal = requireAdminPrincipal(session.principal);
      requireDsvScopes(principal, ['dsv:dispatches:write']);
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendV1Error(reply, request, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const service = dependencies.timeConstraintCommandService;
      if (service === undefined) {
        return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV time constraint command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readClearTimeConstraintCommand(request);
      if (sellerOrderId === null || command === null) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid time constraint clear payload');
      }
      try {
        return sendV1Data(reply, request, await service.clear({
          actor: dsvV1AdminCommandActor(principal, request),
          ...command,
          sellerOrderId,
          shopDomain: requireAdminShopDomain(principal),
        }));
      } catch (error) {
        return sendTimeConstraintCommandError(reply, request, error);
      }
    }));
}

function registerReadRoute<Query>(
  app: FastifyInstance,
  dependencies: DsvV1ReadDependencies,
  path: string,
  spec: RouteSpec<Query>,
): void {
  app.get(`${apiRoot}/${path}`, (request, reply) =>
    withDsvV1Session(request, reply, dependencies, async (session) => {
      if (hasUnsupportedQuery(request, spec.allowedQuery)) {
        return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
      }
      const query = spec.parseQuery(request);
      if (query === null) return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Invalid query parameter');
      requireDsvScopes(session.principal, spec.requiredScopes);
      return sendV1Data(reply, request, await spec.handler(session.principal, query));
    }));
}

async function readDsvV1Session(request: FastifyRequest, dependencies: DsvV1ReadDependencies): Promise<DsvV1Session | null> {
  const session = verifyAdminWebSessionFromRequest({
    cookieName: dependencies.cookieName,
    request,
    sessionSecret: dependencies.sessionSecret,
  });
  if (session === null) return null;
  try {
    return {
      principal: await dependencies.sessionResolver.resolve(session.subject),
      session,
    };
  } catch (error) {
    if (error instanceof DsvV1AuthenticationError) return null;
    throw error;
  }
}

async function withDsvV1Session(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvV1ReadDependencies,
  handler: (session: DsvV1Session) => unknown,
): Promise<unknown> {
  try {
    if (hasUnsupportedQuery(request, []) && request.url.startsWith(`${apiRoot}/session?`)) {
      return sendV1Error(reply, request, 400, 'BAD_REQUEST', 'Unsupported query parameter');
    }
    const session = await readDsvV1Session(request, dependencies);
    if (session === null) return sendV1Error(reply, request, 401, 'UNAUTHENTICATED', 'DSV session required');
    requireDsvScopes(session.principal, ['dsv:session:read']);
    return await handler(session);
  } catch (error) {
    if (error instanceof DsvV1ForbiddenError) {
      return sendV1Error(reply, request, 403, 'FORBIDDEN', error.message);
    }
    if (error instanceof DsvForbiddenError) {
      return sendV1Error(reply, request, error.httpStatus, 'FORBIDDEN', error.message, error.details);
    }
    if (error instanceof DsvV1ReadQueryError) {
      return sendV1Error(reply, request, error.httpStatus, error.code, error.message, safeDsvV1ErrorDetails(error.details));
    }
    if (error instanceof DsvV1DependencyError) {
      return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', error.message);
    }
    request.log.error({ err: error }, 'DSV v1 request failed');
    return sendV1Error(reply, request, 503, 'DEPENDENCY_UNAVAILABLE', 'DSV v1 dependency unavailable');
  }
}

function sendV1Data<T>(reply: FastifyReply, request: FastifyRequest, data: T, statusCode = 200): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store')
    .send(toDsvV1SuccessEnvelope(data, request.id));
}

function sendV1Error(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: DsvV1ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send(
    toDsvV1ErrorEnvelope({
      code,
      ...(details === undefined ? {} : { details }),
      message,
      requestId: request.id,
    })
  );
}

function sendTimeConstraintCommandError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (!(error instanceof DsvTimeConstraintCommandError)) throw error;
  switch (error.code) {
    case 'COMMAND_IN_PROGRESS':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
    case 'SELLER_ORDER_ASSIGNMENT_CHANGED':
      return sendV1Error(reply, request, 409, error.code, error.message);
    case 'SELLER_ORDER_NOT_FOUND':
      return sendV1Error(reply, request, 404, 'NOT_FOUND', error.message);
    case 'VALIDATION_FAILED':
      return sendV1Error(reply, request, 400, 'BAD_REQUEST', error.message);
  }
}

function sendDispatchChangeRequestError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (!(error instanceof DsvDispatchChangeRequestError)) throw error;
  switch (error.code) {
    case 'COMMAND_IN_PROGRESS':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
    case 'VERSION_CONFLICT':
      return sendV1Error(reply, request, 409, error.code === 'VERSION_CONFLICT' ? 'VERSION_CONFLICT' : error.code, error.message);
    case 'NOT_FOUND':
      return sendV1Error(reply, request, 404, 'NOT_FOUND', error.message);
  }
}

function sendOrderMessageError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (!(error instanceof DsvOrderMessageError)) throw error;
  switch (error.code) {
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
      return sendV1Error(reply, request, 409, error.code, error.message);
    case 'NOT_FOUND':
      return sendV1Error(reply, request, 404, 'NOT_FOUND', error.message);
    case 'VALIDATION_FAILED':
      return sendV1Error(reply, request, 400, 'BAD_REQUEST', error.message);
  }
}

function safeDsvV1ErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const safeEntries = Object.entries(details).flatMap(([key, value]) => {
    const safeValue = safeDsvV1ErrorDetailValue(value);
    return safeValue === undefined ? [] : [[key, safeValue] as const];
  });
  return safeEntries.length === 0 ? undefined : Object.fromEntries(safeEntries);
}

function safeDsvV1ErrorDetailValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value;
  if (Array.isArray(value)) {
    const safeValues = value.map(safeDsvV1ErrorDetailValue).filter((item) => item !== undefined);
    return safeValues.length === value.length ? safeValues : undefined;
  }
  return undefined;
}

function parsePagedQuery(request: FastifyRequest): DsvV1ReadListInput | null {
  const cursor = readSingleQueryString(request, 'cursor');
  const limit = readLimit(request);
  if (cursor === null || limit === null) return null;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parsePagedDateQuery(request: FastifyRequest): DsvV1ServiceDateInput | null {
  const base = parsePagedQuery(request);
  const serviceDate = readServiceDate(request);
  if (base === null || serviceDate === null) return null;
  return {
    ...base,
    ...(serviceDate === undefined ? {} : { serviceDate }),
  };
}

function parseRecordsQuery(request: FastifyRequest): DsvV1RecordsInput | null {
  const limit = readLimit(request);
  const page = readPageNumber(request);
  const serviceDate = readServiceDate(request);
  if (limit === null || page === null || serviceDate === null) return null;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(page === undefined ? {} : { page }),
    ...(serviceDate === undefined ? {} : { serviceDate }),
  };
}

function parseDispatchesQuery(request: FastifyRequest): DsvV1DispatchListInput | null {
  const base = parsePagedDateQuery(request);
  const destinationName = readOptionalSearchText(request, 'destinationName');
  const orderNumber = readOptionalSearchText(request, 'orderNumber');
  if (base === null || destinationName === null || orderNumber === null) return null;
  return {
    ...base,
    ...(destinationName === undefined ? {} : { destinationName }),
    ...(orderNumber === undefined ? {} : { orderNumber }),
  };
}

function parseServiceDateOnlyQuery(request: FastifyRequest): Pick<DsvV1ServiceDateInput, 'serviceDate'> | null {
  const serviceDate = readServiceDate(request);
  if (serviceDate === null) return null;
  return serviceDate === undefined ? {} : { serviceDate };
}

function parseCustomerDeliveriesQuery(request: FastifyRequest): DsvV1CustomerDeliveriesInput | null {
  const base = parsePagedDateQuery(request);
  const includeGpsTrails = readSingleQueryString(request, 'includeGpsTrails');
  const window = readSingleQueryString(request, 'window');
  if (base === null || includeGpsTrails === null || window === null) return null;
  if (includeGpsTrails !== undefined && includeGpsTrails !== 'true' && includeGpsTrails !== 'false') return null;
  if (
    window !== undefined
    && window !== 'today'
    && window !== 'tomorrow'
    && window !== 'day-after-tomorrow'
  ) return null;
  return {
    ...base,
    ...(includeGpsTrails === undefined ? {} : { includeGpsTrails: includeGpsTrails === 'true' }),
    ...(window === undefined ? {} : { window }),
  };
}

function parseVehicleTemperatureHistoryQuery(request: FastifyRequest): DsvV1VehicleTemperatureHistoryInput | null {
  const vehicleId = readUuidParam(request, 'vehicleId');
  const from = readIsoDateTimeQuery(request, 'from');
  const to = readIsoDateTimeQuery(request, 'to');
  const limit = readTemperatureHistoryLimit(request);
  if (vehicleId === null || from === null || to === null || limit === null) return null;
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) return null;
  return {
    ...(from === undefined ? {} : { from }),
    ...(limit === undefined ? {} : { limit }),
    ...(to === undefined ? {} : { to }),
    vehicleId,
  };
}

function parseVehicleGpsTrailHistoryQuery(request: FastifyRequest): DsvV1VehicleGpsTrailHistoryInput | null {
  const vehicleId = readUuidParam(request, 'vehicleId');
  const serviceDate = readServiceDate(request);
  if (vehicleId === null || serviceDate === null) return null;
  return {
    ...(serviceDate === undefined ? {} : { serviceDate }),
    vehicleId,
  };
}

function parseAdminCustomerDeliveriesQuery(
  request: FastifyRequest,
): (DsvV1CustomerDeliveriesInput & { customerId: string }) | null {
  const base = parseCustomerDeliveriesQuery(request);
  const customerId = readSingleQueryString(request, 'customerId');
  if (base === null || customerId === undefined || customerId === null) return null;
  return { ...base, customerId };
}

function parseEmptyQuery(): Record<string, never> {
  return {};
}

function readServiceDate(request: FastifyRequest): string | undefined | null {
  const value = readSingleQueryString(request, 'serviceDate');
  if (value === undefined || value === null) return value;
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

function readLimit(request: FastifyRequest): number | undefined | null {
  const value = readSingleQueryString(request, 'limit');
  if (value === undefined || value === null) return value;
  if (!/^\d+$/u.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function readPageNumber(request: FastifyRequest): number | undefined | null {
  const value = readSingleQueryString(request, 'page');
  if (value === undefined || value === null) return value;
  if (!/^\d+$/u.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

function readTemperatureHistoryLimit(request: FastifyRequest): number | undefined | null {
  const value = readSingleQueryString(request, 'limit');
  if (value === undefined || value === null) return value;
  if (!/^\d+$/u.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 288 ? limit : null;
}

function readIsoDateTimeQuery(request: FastifyRequest, key: string): Date | undefined | null {
  const value = readSingleQueryString(request, key);
  if (value === undefined || value === null) return value;
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readOptionalSearchText(request: FastifyRequest, key: string): string | undefined | null {
  const value = readSingleQueryString(request, key);
  if (value === undefined || value === null) return value;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length <= 120 ? normalized : null;
}

function readSingleQueryString(request: FastifyRequest, key: string): string | undefined | null {
  const value = queryRecord(request)[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readConfirmTimeConstraintCommand(request: FastifyRequest): Omit<DsvConfirmTimeConstraintInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'deliveryStopId', 'expectedVersion', 'timeWindowEnd', 'timeWindowStart'])) return null;
  const base = readTimeConstraintCommandBase(body);
  const timeWindowStart = readBoundedText(body.timeWindowStart, 5);
  const timeWindowEnd = readBoundedText(body.timeWindowEnd, 5);
  if (base === null || timeWindowStart === null || timeWindowEnd === null) return null;
  return { ...base, timeWindowEnd, timeWindowStart };
}

function readClearTimeConstraintCommand(request: FastifyRequest): Omit<DsvClearTimeConstraintInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'deliveryStopId', 'expectedVersion', 'reason'])) return null;
  const base = readTimeConstraintCommandBase(body);
  const reason = readOptionalBoundedText(body.reason, 500);
  if (base === null || reason === null) return null;
  return { ...base, ...(reason === undefined ? {} : { reason }) };
}

function readActiveRemovalCommand(request: FastifyRequest): Omit<DsvDispatchChangeRequestCommandInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'deliveryStopId', 'expectedVersion'])) return null;
  const commandId = readBoundedText(body.commandId, 120);
  const deliveryStopId = readUuidValue(body.deliveryStopId);
  const expectedVersion = readBoundedText(body.expectedVersion, 160);
  if (commandId === null || deliveryStopId === null || expectedVersion === null) return null;
  return { commandId, deliveryStopId, expectedVersion };
}

function readCancelChangeRequestCommand(request: FastifyRequest): Omit<DsvDispatchChangeRequestCancelInput, 'actor' | 'changeRequestId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId', 'expectedVersion'])) return null;
  const commandId = readBoundedText(body.commandId, 120);
  const expectedVersion = readExpectedVersion(body);
  if (commandId === null || expectedVersion === invalidExpectedVersion) return null;
  return {
    commandId,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

function readRecoverUnassignedCommand(request: FastifyRequest): Omit<DsvDispatchRecoveryInput, 'actor' | 'sellerOrderId' | 'shopDomain'> | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['commandId'])) return null;
  const commandId = readBoundedText(body.commandId, 120);
  return commandId === null ? null : { commandId };
}

function readCreateOrderMessageBody(request: FastifyRequest): { audience: 'CUSTOMER' | 'DRIVER'; body: string; commandId: string } | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['audience', 'body', 'commandId'])) return null;
  const audience = body.audience === 'CUSTOMER' || body.audience === 'DRIVER' ? body.audience : null;
  const text = readBoundedText(body.body, 500);
  const commandId = readBoundedText(body.commandId, 120);
  return audience === null || text === null || commandId === null ? null : { audience, body: text, commandId };
}

function readCustomerNotificationSettingsBody(request: FastifyRequest): { enabled: boolean; recipient: string | null } | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedBodyKeys(body, ['enabled', 'recipient'])) return null;
  if (typeof body.enabled !== 'boolean') return null;
  const recipient = body.recipient === null || body.recipient === undefined || body.recipient === ''
    ? null
    : readBoundedText(body.recipient, 320);
  return recipient === null && body.enabled ? null : { enabled: body.enabled, recipient };
}

function readTimeConstraintCommandBase(body: Record<string, unknown>): {
  commandId: string;
  deliveryStopId: string;
  expectedVersion?: string | null;
} | null {
  const commandId = readBoundedText(body.commandId, 120);
  const deliveryStopId = readUuidValue(body.deliveryStopId);
  const expectedVersion = readExpectedVersion(body);
  if (commandId === null || deliveryStopId === null || expectedVersion === invalidExpectedVersion) return null;
  return {
    commandId,
    deliveryStopId,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

const invalidExpectedVersion = Symbol('invalidExpectedVersion');

function readExpectedVersion(body: Record<string, unknown>): string | null | undefined | typeof invalidExpectedVersion {
  if (!Object.hasOwn(body, 'expectedVersion')) return undefined;
  if (body.expectedVersion === null) return null;
  return readBoundedText(body.expectedVersion, 160) ?? invalidExpectedVersion;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyAllowedBodyKeys(body: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowedKeys.includes(key));
}

function readUuidParam(request: FastifyRequest, key: string): string | null {
  const params = request.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  return readUuidValue((params as Record<string, unknown>)[key]);
}

function readUuidValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return null;
  return value;
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized !== '' && normalized.length <= maxLength ? normalized : null;
}

function readOptionalBoundedText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  return readBoundedText(value, maxLength);
}

function dsvV1AdminCommandActor(principal: DsvAdminPrincipal, request: FastifyRequest): DsvTimeConstraintActor {
  return {
    actorId: principal.actorId ?? null,
    actorType: 'DSV_ADMIN' as const,
    principalType: 'DSV_ADMIN' as const,
    requestId: request.id,
  };
}

function hasUnsupportedQuery(request: FastifyRequest, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(queryRecord(request)).some((key) => !allowed.has(key));
}

function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return typeof request.query === 'object' && request.query !== null && !Array.isArray(request.query)
    ? request.query as Record<string, unknown>
    : {};
}

function isEmptyObjectBody(value: unknown): boolean {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
}

function requireQueryService(dependencies: DsvV1ReadDependencies): DsvV1ReadQueryService {
  if (dependencies.queryService === undefined) {
    throw new DsvV1DependencyError('DSV v1 read query service is not configured');
  }
  return dependencies.queryService;
}

function requireRoutePlanService(
  dependencies: DsvV1ReadDependencies,
): Pick<RoutePlanService, 'getRoutePlanDetail' | 'listRoutePlans'> {
  if (dependencies.routePlanService === undefined) {
    throw new DsvV1DependencyError('DSV route plan read service is not configured');
  }
  return dependencies.routePlanService;
}

function requireAdminPrincipal(principal: DsvPrincipal): DsvAdminPrincipal {
  if (principal.principalType === 'DSV_ADMIN') return principal;
  throw new DsvForbiddenError({ principal, requiredScopes: [] });
}

function requireAdminShopDomain(principal: DsvAdminPrincipal): string {
  const shopDomain = principal.shopDomain?.trim();
  if (shopDomain === undefined || shopDomain === '') {
    throw new DsvV1DependencyError('DSV admin shop domain is not available');
  }
  return shopDomain;
}

function requireCustomerPrincipal(principal: DsvPrincipal): DsvCustomerUserPrincipal {
  if (principal.principalType === 'CUSTOMER_USER') return principal;
  throw new DsvForbiddenError({ principal, requiredScopes: ['dsv:customer-deliveries:read'] });
}

function requireCustomerShopDomain(principal: DsvCustomerUserPrincipal): string {
  const shopDomain = principal.shopDomain?.trim();
  if (shopDomain === undefined || shopDomain === '') {
    throw new DsvV1DependencyError('DSV customer shop domain is not available');
  }
  return shopDomain;
}

export class DsvV1AuthenticationError extends Error {
  constructor() {
    super('DSV v1 authentication failed');
    this.name = 'DsvV1AuthenticationError';
  }
}

export class DsvV1ForbiddenError extends Error {
  constructor(message = 'DSV v1 principal is forbidden') {
    super(message);
    this.name = 'DsvV1ForbiddenError';
  }
}

class DsvV1DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsvV1DependencyError';
  }
}
