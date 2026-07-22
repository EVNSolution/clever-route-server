import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { canAccessShopDomain } from '../modules/commerce/admin-commerce-auth.js';
import type { AdminCommerceActor } from '../modules/commerce/admin-commerce-auth.js';
import {
  DestinationTipConflictError,
  DestinationTipSourceError,
  destinationTipCategories,
  destinationTipSeverities,
  destinationTipStatuses,
} from '../modules/dsv/dsv-control.repository.js';
import type {
  DsvControlRepository,
} from '../modules/dsv/dsv-control.repository.js';
import type { PrismaAdminStoreSettingsService } from '../modules/commerce/admin-store-settings.service.js';
import {
  DsvDispatchImportConflictError,
  DsvDispatchImportShopNotFoundError,
  DsvDispatchImportValidationError,
} from '../modules/dsv/dsv-dispatch-import.service.js';
import type {
  DsvDispatchImportInput,
  DsvDispatchImportService,
  DsvDispatchImportSourceRow,
} from '../modules/dsv/dsv-dispatch-import.service.js';
import {
  DsvResourceConflictError,
  DsvResourceNotFoundError,
} from '../modules/dsv/dsv-resource.service.js';
import type {
  DsvDriverInput,
  DsvResourceService,
  DsvVehicleInput,
} from '../modules/dsv/dsv-resource.service.js';
import {
  DsvForbiddenError,
  createDsvAdminPrincipal,
  requireDsvScopes,
} from '../modules/dsv/dsv-principal.js';
import type {
  DsvPrincipal,
  DsvScope,
} from '../modules/dsv/dsv-principal.js';
import {
  clearAdminWebSessionCookie,
  createAdminWebSession,
  verifyAdminWebCsrfToken,
  verifyAdminWebLoginSecret,
  verifyAdminWebSessionFromRequest,
} from './admin-ui-session.js';

const apiRoot = '/api/dsv';
const cookiePath = `${apiRoot}/`;
const sessionSubjectPrefix = 'dsv-shop:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DsvControlDependencies = {
  allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  cookieName: string;
  dispatchImportService: DsvDispatchImportService;
  loginId: string;
  loginSecret: string;
  repository: DsvControlRepository;
  resourceService: DsvResourceService;
  secureCookies: boolean;
  sessionSecret: string;
  settingsService: Pick<PrismaAdminStoreSettingsService, 'getSettings' | 'saveSettings'>;
};

export function registerDsvControlRoutes(app: FastifyInstance, dependencies: DsvControlDependencies): void {
  app.post(`${apiRoot}/auth/login`, async (request, reply) => {
    const body = objectBody(request.body);
    const id = readTrimmed(body?.id);
    const password = readTrimmed(body?.password);
    const shopDomain = normalizeShopDomain(readTrimmed(body?.shopDomain));
    if (id === null || password === null || shopDomain === null) {
      return sendError(reply, 400, 'BAD_REQUEST', 'ID, password, and shopDomain are required');
    }
    if (id !== dependencies.loginId || !verifyAdminWebLoginSecret({ candidate: password, expected: dependencies.loginSecret })) {
      return sendError(reply, 401, 'UNAUTHORIZED', '로그인 정보가 올바르지 않습니다.');
    }
    if (!canAccessShopDomain(actor(dependencies), shopDomain) || !(await dependencies.repository.hasShop(shopDomain))) {
      return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
    }
    const { cookieHeader, session } = createAdminWebSession({
      cookieName: dependencies.cookieName,
      path: cookiePath,
      secure: dependencies.secureCookies,
      sessionSecret: dependencies.sessionSecret,
      subject: `${sessionSubjectPrefix}${shopDomain}`,
    });
    return sendData(reply.header('Set-Cookie', cookieHeader), {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      shopDomain,
    });
  });

  app.post(`${apiRoot}/auth/logout`, async (request, reply) => {
    const session = readDsvSession(request, dependencies);
    if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
    if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }
    return sendData(reply.header('Set-Cookie', clearAdminWebSessionCookie({
      cookieName: dependencies.cookieName,
      path: cookiePath,
      secure: dependencies.secureCookies,
    })), { loggedOut: true });
  });

  app.get(`${apiRoot}/auth/session`, async (request, reply) => {
    const session = readDsvSession(request, dependencies);
    if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
    return sendData(reply, {
      csrfToken: session.session.csrfToken,
      expiresAt: new Date(session.session.expiresAt).toISOString(),
      shopDomain: session.shopDomain,
    });
  });

  app.get(`${apiRoot}/settings/operations`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const settings = await dependencies.settingsService.getSettings({ shopDomain });
      return settings === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found')
        : sendData(reply, {
            loadingStartTime: settings.routeOpsUiSettings.loadingStartTime,
            plannedDepartureTime: settings.routeOpsUiSettings.plannedDepartureTime,
          });
    }, ['dsv:settings:read']));

  app.patch(`${apiRoot}/settings/operations`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const body = objectBody(request.body);
      if (body === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid operation settings payload');
      if (Object.keys(body).some((key) => key !== 'loadingStartTime' && key !== 'plannedDepartureTime')) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation settings payload contains an unsupported field');
      }
      const hasLoadingStartTime = Object.hasOwn(body, 'loadingStartTime');
      const hasPlannedDepartureTime = Object.hasOwn(body, 'plannedDepartureTime');
      if (!hasLoadingStartTime && !hasPlannedDepartureTime) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation settings update is empty');
      }
      const loadingStartTime = hasLoadingStartTime ? readNullableTime(body.loadingStartTime) : null;
      const plannedDepartureTime = hasPlannedDepartureTime ? readNullableTime(body.plannedDepartureTime) : null;
      if ((hasLoadingStartTime && loadingStartTime === undefined) || (hasPlannedDepartureTime && plannedDepartureTime === undefined)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation times must use HH:mm or null');
      }
      const current = await dependencies.settingsService.getSettings({ shopDomain });
      if (current === null) return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
      const saved = await dependencies.settingsService.saveSettings({
        defaultDepotAddress: current.defaultDepotAddress,
        defaultDepotLatitude: current.defaultDepotLatitude,
        defaultDepotLongitude: current.defaultDepotLongitude,
        locale: current.locale,
        routeOpsUiSettings: {
          ...current.routeOpsUiSettings,
          ...(hasLoadingStartTime ? { loadingStartTime: loadingStartTime ?? null } : {}),
          ...(hasPlannedDepartureTime ? { plannedDepartureTime: plannedDepartureTime ?? null } : {}),
        },
        routeScopeConfig: current.routeScopeConfig,
        shopDomain,
      });
      return sendData(reply, {
        loadingStartTime: saved.routeOpsUiSettings.loadingStartTime,
        plannedDepartureTime: saved.routeOpsUiSettings.plannedDepartureTime,
      });
    }, ['dsv:settings:write']));

  app.get(`${apiRoot}/conditions`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const conditions = await dependencies.dispatchImportService.listConditions({ shopDomain });
      return conditions === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found')
        : sendData(reply, { conditions });
    }, ['dsv:conditions:read']));

  app.get(`${apiRoot}/resources`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const resources = await dependencies.resourceService.list({ shopDomain });
      return resources === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found')
        : sendData(reply, resources);
    }, ['dsv:resources:read']));

  app.post(`${apiRoot}/drivers`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const input = readDriverInput(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid driver payload');
      try {
        const driver = await dependencies.resourceService.createDriver({ ...input, shopDomain });
        return sendData(reply, { driver }, 201);
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.patch(`${apiRoot}/drivers/:driverId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const driverId = readUuidParam(request, 'driverId');
      const input = readDriverInput(request.body);
      if (driverId === null || input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid driver update');
      try {
        const driver = await dependencies.resourceService.updateDriver({ ...input, driverId, shopDomain });
        return sendData(reply, { driver });
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.delete(`${apiRoot}/drivers/:driverId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const driverId = readUuidParam(request, 'driverId');
      if (driverId === null) return sendError(reply, 400, 'BAD_REQUEST', 'driverId must be a UUID');
      try {
        await dependencies.resourceService.deleteDriver({ driverId, shopDomain });
        return sendData(reply, { driverId });
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.post(`${apiRoot}/vehicles`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const input = readVehicleInput(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid vehicle payload');
      try {
        const vehicle = await dependencies.resourceService.createVehicle({ ...input, shopDomain });
        return sendData(reply, { vehicle }, 201);
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.patch(`${apiRoot}/vehicles/:vehicleId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const vehicleId = readUuidParam(request, 'vehicleId');
      const input = readVehicleInput(request.body);
      if (vehicleId === null || input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid vehicle update');
      try {
        const vehicle = await dependencies.resourceService.updateVehicle({ ...input, shopDomain, vehicleId });
        return sendData(reply, { vehicle });
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.delete(`${apiRoot}/vehicles/:vehicleId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const vehicleId = readUuidParam(request, 'vehicleId');
      if (vehicleId === null) return sendError(reply, 400, 'BAD_REQUEST', 'vehicleId must be a UUID');
      try {
        await dependencies.resourceService.deleteVehicle({ shopDomain, vehicleId });
        return sendData(reply, { vehicleId });
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.post(`${apiRoot}/vehicles/:vehicleId/drivers`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const vehicleId = readUuidParam(request, 'vehicleId');
      const driverId = readUuidBodyField(request.body, 'driverId');
      if (vehicleId === null || driverId === null) return sendError(reply, 400, 'BAD_REQUEST', 'Vehicle and driver ids must be UUIDs');
      try {
        const assignment = await dependencies.resourceService.assignDriver({ actor: actorId, driverId, shopDomain, vehicleId });
        return sendData(reply, { assignment }, 201);
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.delete(`${apiRoot}/vehicles/:vehicleId/drivers/:assignmentId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const vehicleId = readUuidParam(request, 'vehicleId');
      const assignmentId = readUuidParam(request, 'assignmentId');
      if (vehicleId === null || assignmentId === null) return sendError(reply, 400, 'BAD_REQUEST', 'Vehicle and assignment ids must be UUIDs');
      try {
        await dependencies.resourceService.unassignDriver({ assignmentId, shopDomain, vehicleId });
        return sendData(reply, { assignmentId });
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.post(`${apiRoot}/conditions`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const body = objectBody(request.body);
      const code = readBoundedText(body?.code, 80);
      const name = readBoundedText(body?.name, 160);
      const description = readBoundedText(body?.description, 1_000);
      if (code === null || name === null || description === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid transport condition payload');
      }
      try {
        const condition = await dependencies.dispatchImportService.createCondition({
          actor: actorId,
          code,
          description,
          name,
          shopDomain,
        });
        return sendData(reply, { condition }, 201);
      } catch (error) {
        if (error instanceof DsvDispatchImportConflictError && error.code === 'CONDITION_EXISTS') {
          return sendError(reply, 409, error.code, error.message);
        }
        if (error instanceof DsvDispatchImportShopNotFoundError) return sendError(reply, 404, 'NOT_FOUND', error.message);
        throw error;
      }
    }, ['dsv:conditions:write']));

  app.post(`${apiRoot}/dispatch-imports/preview`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const input = readDispatchImportInput(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid dispatch import payload');
      try {
        return sendData(reply, await dependencies.dispatchImportService.preview({ ...input, shopDomain }));
      } catch (error) {
        if (error instanceof DsvDispatchImportShopNotFoundError) return sendError(reply, 404, 'NOT_FOUND', error.message);
        throw error;
      }
    }, ['dsv:imports:write']));

  app.post(`${apiRoot}/dispatch-imports`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const input = readDispatchImportInput(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid dispatch import payload');
      try {
        const dispatchImport = await dependencies.dispatchImportService.commit({
          ...input,
          actor: actorId,
          shopDomain,
        });
        return sendData(reply, { dispatchImport }, 201);
      } catch (error) {
        if (error instanceof DsvDispatchImportValidationError) {
          return sendError(reply, 422, 'DISPATCH_IMPORT_INVALID', error.message, { preview: error.preview });
        }
        if (error instanceof DsvDispatchImportConflictError) return sendError(reply, 409, error.code, error.message);
        if (error instanceof DsvDispatchImportShopNotFoundError) return sendError(reply, 404, 'NOT_FOUND', error.message);
        throw error;
      }
    }, ['dsv:imports:write']));

  app.get(`${apiRoot}/dispatch-imports/:importId`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const importId = readUuidParam(request, 'importId');
      if (importId === null) return sendError(reply, 400, 'BAD_REQUEST', 'importId must be a UUID');
      const dispatchImport = await dependencies.dispatchImportService.getImport({ importId, shopDomain });
      return dispatchImport === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Dispatch import not found')
        : sendData(reply, { dispatchImport });
    }, ['dsv:imports:read']));

  app.get(`${apiRoot}/control/delivery-stops/:deliveryStopId/context`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const deliveryStopId = readUuidParam(request, 'deliveryStopId');
      if (deliveryStopId === null) return sendError(reply, 400, 'BAD_REQUEST', 'deliveryStopId must be a UUID');
      const context = await dependencies.repository.getDeliveryStopContext({ deliveryStopId, shopDomain });
      return context === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Delivery stop not found')
        : sendData(reply, context);
    }, ['dsv:control:read']));

  app.get(`${apiRoot}/destinations/:destinationId/tips`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      if (destinationId === null) return sendError(reply, 400, 'BAD_REQUEST', 'destinationId must be a UUID');
      const statusValue = readQuery(request, 'status') ?? 'active';
      if (!includes(destinationTipStatuses, statusValue)) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid tip status');
      const tips = await dependencies.repository.listDestinationTips({ destinationId, shopDomain, status: statusValue });
      return tips === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination not found') : sendData(reply, { tips });
    }, ['dsv:destinations:read']));

  app.post(`${apiRoot}/destinations/:destinationId/tips`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      if (destinationId === null) return sendError(reply, 400, 'BAD_REQUEST', 'destinationId must be a UUID');
      const body = objectBody(request.body);
      const category = readEnum(body?.category, destinationTipCategories);
      const severity = readEnum(body?.severity, destinationTipSeverities);
      const title = readBoundedText(body?.title, 80);
      const text = readBoundedText(body?.body, 1_000);
      const sourceDeliveryStopId = readOptionalUuid(body?.sourceDeliveryStopId);
      if (category === null || severity === null || title === null || text === null || sourceDeliveryStopId === undefined) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid destination tip payload');
      }
      try {
        const tip = await dependencies.repository.createDestinationTip({
          actor: actorId,
          body: text,
          category,
          destinationId,
          severity,
          shopDomain,
          sourceDeliveryStopId,
          title,
        });
        return tip === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination not found') : sendData(reply, { tip }, 201);
      } catch (error) {
        if (error instanceof DestinationTipSourceError) return sendError(reply, 400, 'BAD_REQUEST', error.message);
        throw error;
      }
    }, ['dsv:destinations:write']));

  app.patch(`${apiRoot}/destinations/:destinationId/tips/:tipId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const destinationId = readUuidParam(request, 'destinationId');
      const tipId = readUuidParam(request, 'tipId');
      if (destinationId === null || tipId === null) return sendError(reply, 400, 'BAD_REQUEST', 'Destination and tip ids must be UUIDs');
      const body = objectBody(request.body);
      const revision = readPositiveInteger(body?.revision);
      const category = readOptionalEnum(body?.category, destinationTipCategories);
      const severity = readOptionalEnum(body?.severity, destinationTipSeverities);
      const status = readOptionalEnum(body?.status, destinationTipStatuses);
      const title = readOptionalBoundedText(body?.title, 80);
      const text = readOptionalBoundedText(body?.body, 1_000);
      if (revision === null || category === null || severity === null || status === null || title === null || text === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid destination tip update');
      }
      if ([category, severity, status, title, text].every((value) => value === undefined)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Destination tip update is empty');
      }
      try {
        const tip = await dependencies.repository.updateDestinationTip({
          actor: actorId,
          ...(text === undefined ? {} : { body: text }),
          ...(category === undefined ? {} : { category }),
          destinationId,
          revision,
          ...(severity === undefined ? {} : { severity }),
          shopDomain,
          ...(status === undefined ? {} : { status }),
          tipId,
          ...(title === undefined ? {} : { title }),
        });
        return tip === null ? sendError(reply, 404, 'NOT_FOUND', 'Destination tip not found') : sendData(reply, { tip });
      } catch (error) {
        if (error instanceof DestinationTipConflictError) {
          return sendError(reply, 409, 'TIP_REVISION_CONFLICT', error.message, { currentRevision: error.currentRevision });
        }
        throw error;
      }
    }, ['dsv:destinations:write']));
}

function actor(dependencies: DsvControlDependencies): AdminCommerceActor {
  return { allowedShopDomains: dependencies.allowedShopDomains, subject: dependencies.loginId };
}

function readDsvSession(request: FastifyRequest, dependencies: DsvControlDependencies): {
  actor: string;
  principal: DsvPrincipal;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
  shopDomain: string;
} | null {
  const session = verifyAdminWebSessionFromRequest({
    cookieName: dependencies.cookieName,
    request,
    sessionSecret: dependencies.sessionSecret,
  });
  if (session === null || !session.subject.startsWith(sessionSubjectPrefix)) return null;
  const shopDomain = normalizeShopDomain(session.subject.slice(sessionSubjectPrefix.length));
  if (shopDomain === null || !canAccessShopDomain(actor(dependencies), shopDomain)) return null;
  return {
    actor: dependencies.loginId,
    principal: createDsvAdminPrincipal({ shopId: shopDomain }),
    session,
    shopDomain,
  };
}

async function withDsvSession(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  handler: (session: NonNullable<ReturnType<typeof readDsvSession>>) => Promise<unknown>,
  requiredScopes: readonly DsvScope[] = ['dsv:session:read'],
): Promise<unknown> {
  const session = readDsvSession(request, dependencies);
  if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
  try {
    requireDsvScopes(session.principal, requiredScopes);
    return await handler(session);
  } catch (error) {
    if (error instanceof DsvForbiddenError) {
      return sendError(reply, error.httpStatus, error.code, error.message, error.details);
    }
    request.log.error({ err: error }, 'DSV API request failed');
    if (isPrismaSchemaDriftError(error)) {
      return sendError(reply, 503, 'DSV_SCHEMA_NOT_READY', 'DSV storage schema is not up to date. Apply the delivery API migration and retry.');
    }
    return sendError(reply, 500, 'DSV_REQUEST_FAILED', 'DSV API request failed');
  }
}

async function withDsvMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  handler: (session: NonNullable<ReturnType<typeof readDsvSession>>) => Promise<unknown>,
  requiredScopes: readonly DsvScope[],
): Promise<unknown> {
  return withDsvSession(request, reply, dependencies, async (session) => {
    if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }
    return handler(session);
  }, requiredScopes);
}

function sendData<T>(reply: FastifyReply, data: T, statusCode = 200): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send({ data, error: null });
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send({
    data: null,
    error: { code, ...(details === undefined ? {} : { details }), message },
  });
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readDispatchImportInput(value: unknown): DsvDispatchImportInput | null {
  const body = objectBody(value);
  const fileName = readBoundedText(body?.fileName, 255);
  const planDate = readDate(body?.planDate);
  if (fileName === null || planDate === null || !Array.isArray(body?.rows) || body.rows.length === 0 || body.rows.length > 500) return null;
  const rows: DsvDispatchImportSourceRow[] = [];
  for (const valueRow of body.rows) {
    const row = objectBody(valueRow);
    const rowNumber = readInteger(row?.rowNumber);
    const shippedBoxes = readInteger(row?.shippedBoxes);
    const driverName = readText(row?.driverName);
    const vehiclePlate = readText(row?.vehiclePlate);
    const destinationName = readText(row?.destinationName);
    const conditionCode = readText(row?.conditionCode);
    const address = readText(row?.address);
    const customerCode = readText(row?.customerCode);
    const sellerOrderKey = readText(row?.sellerOrderKey);
    const notes = readNullableText(row?.notes);
    const latitude = readNullableNumber(row?.latitude);
    const longitude = readNullableNumber(row?.longitude);
    if (
      rowNumber === null || shippedBoxes === null || driverName === null || vehiclePlate === null
      || destinationName === null || conditionCode === null || address === null || customerCode === null
      || sellerOrderKey === null || notes === undefined || latitude === undefined || longitude === undefined
    ) return null;
    rows.push({
      address,
      conditionCode,
      customerCode,
      destinationName,
      driverName,
      latitude,
      longitude,
      notes,
      rowNumber,
      sellerOrderKey,
      shippedBoxes,
      vehiclePlate,
    });
  }
  return { fileName, planDate, rows };
}

function readDriverInput(value: unknown): DsvDriverInput | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['age', 'career', 'gender', 'name', 'score', 'traits', 'zone'])) return null;
  const age = readInteger(body.age);
  const career = readBoundedText(body.career, 160);
  const gender = readBoundedText(body.gender, 40);
  const name = readBoundedText(body.name, 80);
  const score = readBoundedText(body.score, 40);
  const traits = readBoundedTextArray(body.traits, 20, 160);
  const zone = readBoundedText(body.zone, 160);
  if (age === null || age < 18 || age > 100 || career === null || gender === null || name === null || score === null || traits === null || zone === null) return null;
  return { age, career, gender, name, score, traits, zone };
}

function readVehicleInput(value: unknown): DsvVehicleInput | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['note', 'plate', 'type'])) return null;
  const note = readBoundedTextAllowEmpty(body.note, 1_000);
  const plate = readBoundedText(body.plate, 40);
  const type = readBoundedText(body.type, 160);
  return note === null || plate === null || type === null ? null : { note, plate, type };
}

function readUuidBodyField(value: unknown, field: string): string | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, [field])) return null;
  const id = readTrimmed(body[field]);
  return id !== null && uuidPattern.test(id) ? id : null;
}

function readBoundedTextArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map((item) => readBoundedText(item, maxLength));
  return items.some((item) => item === null) ? null : items as string[];
}

function readBoundedTextAllowEmpty(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= maxLength ? text : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function sendResourceError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvResourceNotFoundError) {
    return sendError(reply, 404, 'NOT_FOUND', error.message);
  }
  if (error instanceof DsvResourceConflictError) {
    return sendError(reply, 409, error.code, error.message);
  }
  throw error;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().normalize('NFKC') : null;
}

function readNullableText(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return readText(value) ?? undefined;
}

function readInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function readTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeShopDomain(value: string | null): string | null {
  if (value === null) return null;
  const domain = value.toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
  return /^[a-z0-9.-]+$/u.test(domain) ? domain : null;
}

function readUuidParam(request: FastifyRequest, name: string): string | null {
  const params = request.params as Record<string, unknown>;
  const value = readTrimmed(params[name]);
  return value !== null && uuidPattern.test(value) ? value : null;
}

function readQuery(request: FastifyRequest, name: string): string | null {
  const query = request.query as Record<string, unknown>;
  return readTrimmed(query[name]);
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  const text = readTrimmed(value);
  return text !== null && text.length <= maxLength ? text : null;
}

function readOptionalBoundedText(value: unknown, maxLength: number): string | null | undefined {
  return value === undefined ? undefined : readBoundedText(value, maxLength);
}

function readOptionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  const id = readTrimmed(value);
  return id !== null && uuidPattern.test(id) ? id : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNullableTime(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) return undefined;
  return value;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && includes(values, value) ? value : null;
}

function readOptionalEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null | undefined {
  return value === undefined ? undefined : readEnum(value, values);
}

function includes<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function isPrismaSchemaDriftError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'P2021' || error.code === 'P2022');
}
