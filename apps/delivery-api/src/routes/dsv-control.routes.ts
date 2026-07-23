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
import type {
  AdminStoreSettings,
  PrismaAdminStoreSettingsService,
} from '../modules/commerce/admin-store-settings.service.js';
import {
  DsvAssignmentCommandError,
  type DsvAssignmentCommandBaseInput,
  type DsvAssignmentResult,
} from '../modules/dsv/dsv-assignment-command.service.js';
import {
  DsvDispatchImportApplyError,
  DsvDispatchImportConflictError,
  DsvDispatchImportShopNotFoundError,
  DsvDispatchImportValidationError,
  DsvTransportConditionNotFoundError,
} from '../modules/dsv/dsv-dispatch-import.service.js';
import type {
  DsvDispatchImportApplyInput,
  DsvDispatchImportApplyResult,
  DsvDispatchImportInput,
  DsvDispatchImportService,
  DsvDispatchImportSourceRow,
} from '../modules/dsv/dsv-dispatch-import.service.js';
import type {
  DsvDispatchImportNotificationService,
} from '../modules/dsv/dsv-dispatch-import-notification.service.js';
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
import type { DsvAdminAccountAuthenticator } from '../modules/dsv/dsv-admin-account.repository.js';
import {
  createDsvAdminSessionSubject,
  parseDsvAdminSessionSubject,
} from '../modules/dsv/dsv-admin-session-subject.js';
import type {
  DsvPrincipal,
  DsvScope,
} from '../modules/dsv/dsv-principal.js';
import {
  normalizeDsvOperationalSettings,
  validateDsvOperationalSettings,
} from '../modules/dsv/dsv-operational-settings.js';
import type {
  DsvAddressCanonicalizer,
  DsvAddressResolutionStatus,
} from '../modules/dsv/dsv-address-canonicalization.js';
import type { GeocodingService } from '../modules/geocoding/geocoding.service.js';
import {
  clearAdminWebSessionCookie,
  createAdminWebSession,
  verifyAdminWebCsrfToken,
  verifyAdminWebSessionFromRequest,
} from './admin-ui-session.js';

const apiRoot = '/api/dsv';
const cookiePath = `${apiRoot}/`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const applyCommandIdHeader = 'idempotency-key';
const assignmentCommandIdHeader = 'idempotency-key';
const versionedApiRoot = `${apiRoot}/v1`;
const defaultLoadingStartTime = '07:30';
const defaultPlannedDepartureTime = '08:30';
const operationSettingFields = [
  'departureAddress',
  'departureLatitude',
  'departureLongitude',
  'dwellMinutes',
  'etaDelayMinutes',
  'forwardDelayAlerts',
  'gpsSilenceSeconds',
  'loadingStartTime',
  'plannedDepartureTime',
  'recordMissingProof',
  'showTemperatureAlerts',
  'temperatureLimit',
] as const;

type DsvAdminReassignCommandInput = DsvAssignmentCommandBaseInput & {
  targetDriverId: string;
  targetRoutePlanId?: string | null;
  targetSequence?: number | null;
  targetVehicleId?: string | null;
};

export type DsvAdminAssignmentCommandService = {
  reassign(input: DsvAdminReassignCommandInput): Promise<DsvAssignmentResult>;
  unassign(input: DsvAssignmentCommandBaseInput): Promise<DsvAssignmentResult>;
};

type DsvControlSession = {
  actor: string;
  principal: DsvPrincipal;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
  shopDomain: string;
};

export type DsvControlDependencies = {
  addressCanonicalizer?: DsvAddressCanonicalizer;
  adminAccounts: DsvAdminAccountAuthenticator;
  allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  assignmentCommandService?: DsvAdminAssignmentCommandService;
  cookieName: string;
  dispatchImportNotificationService?: DsvDispatchImportNotificationService;
  dispatchImportService: DsvDispatchImportService;
  geocodingService?: Pick<GeocodingService, 'geocode'>;
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
    const password = readPassword(body?.password);
    const shopDomain = normalizeShopDomain(readTrimmed(body?.shopDomain));
    if (id === null || password === null || shopDomain === null) {
      return sendError(reply, 400, 'BAD_REQUEST', 'ID, password, and shopDomain are required');
    }
    const account = await dependencies.adminAccounts.authenticate({ loginId: id, password });
    if (account === null) {
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
      subject: createDsvAdminSessionSubject({
        accountId: account.accountId,
        shopDomain,
        tokenVersion: account.tokenVersion,
      }),
    });
    return sendData(reply.header('Set-Cookie', cookieHeader), {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      shopDomain,
    });
  });

  app.post(`${apiRoot}/auth/logout`, (request, reply) =>
    withDsvSession(request, reply, dependencies, (session) => {
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      return sendData(reply.header('Set-Cookie', clearAdminWebSessionCookie({
        cookieName: dependencies.cookieName,
        path: cookiePath,
        secure: dependencies.secureCookies,
      })), { loggedOut: true });
    }));

  app.get(`${apiRoot}/auth/session`, (request, reply) =>
    withDsvSession(request, reply, dependencies, (session) => sendData(reply, {
      csrfToken: session.session.csrfToken,
      expiresAt: new Date(session.session.expiresAt).toISOString(),
      shopDomain: session.shopDomain,
    })));

  app.get(`${apiRoot}/settings/operations`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const settings = await dependencies.settingsService.getSettings({ shopDomain });
      return settings === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found')
        : sendData(reply, operationSettingsData(settings));
    }, ['dsv:settings:read']));

  app.patch(`${apiRoot}/settings/operations`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const body = objectBody(request.body);
      if (body === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid operation settings payload');
      if (!hasOnlyAllowedKeys(body, [...operationSettingFields])) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation settings payload contains an unsupported field');
      }
      if (Object.keys(body).length === 0) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation settings update is empty');
      }
      const hasLoadingStartTime = Object.hasOwn(body, 'loadingStartTime');
      const hasPlannedDepartureTime = Object.hasOwn(body, 'plannedDepartureTime');
      const loadingStartTime = hasLoadingStartTime ? readNullableTime(body.loadingStartTime) : null;
      const plannedDepartureTime = hasPlannedDepartureTime ? readNullableTime(body.plannedDepartureTime) : null;
      if ((hasLoadingStartTime && loadingStartTime === undefined) || (hasPlannedDepartureTime && plannedDepartureTime === undefined)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation times must use HH:mm or null');
      }
      const current = await dependencies.settingsService.getSettings({ shopDomain });
      if (current === null) return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
      const departureAddress = Object.hasOwn(body, 'departureAddress')
        ? readNullableText(body.departureAddress)
        : current.defaultDepotAddress;
      const departureLatitude = Object.hasOwn(body, 'departureLatitude')
        ? readNullableNumber(body.departureLatitude)
        : current.defaultDepotLatitude;
      const departureLongitude = Object.hasOwn(body, 'departureLongitude')
        ? readNullableNumber(body.departureLongitude)
        : current.defaultDepotLongitude;
      if (
        departureAddress === undefined
        || departureLatitude === undefined
        || departureLongitude === undefined
        || !validDepartureLocation(departureAddress, departureLatitude, departureLongitude)
      ) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Departure address and coordinates must form one valid location');
      }
      let dsvOperationalSettings;
      try {
        dsvOperationalSettings = validateDsvOperationalSettings({
          ...normalizeDsvOperationalSettings(current.dsvOperationalSettings),
          ...operationFieldsFrom(body),
        });
      } catch {
        return sendError(reply, 400, 'BAD_REQUEST', 'Operation settings contain an invalid value');
      }
      const saved = await dependencies.settingsService.saveSettings({
        defaultDepotAddress: departureAddress,
        defaultDepotLatitude: departureLatitude,
        defaultDepotLongitude: departureLongitude,
        dsvOperationalSettings,
        locale: current.locale,
        routeOpsUiSettings: {
          ...current.routeOpsUiSettings,
          ...(hasLoadingStartTime ? { loadingStartTime: loadingStartTime ?? null } : {}),
          ...(hasPlannedDepartureTime ? { plannedDepartureTime: plannedDepartureTime ?? null } : {}),
        },
        routeScopeConfig: current.routeScopeConfig,
        shopDomain,
      });
      return sendData(reply, operationSettingsData(saved));
    }, ['dsv:settings:write']));

  app.post(`${apiRoot}/settings/operations/geocode`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const body = objectBody(request.body);
      const address = readBoundedText(body?.address, 500);
      if (body === null || !hasOnlyKeys(body, ['address']) || address === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'A departure address is required');
      }
      const current = await dependencies.settingsService.getSettings({ shopDomain });
      if (
        current !== null
        && normalizedAddress(current.defaultDepotAddress) === normalizedAddress(address)
        && validCoordinates(current.defaultDepotLatitude, current.defaultDepotLongitude)
      ) {
        return sendData(reply, {
          address,
          latitude: current.defaultDepotLatitude,
          longitude: current.defaultDepotLongitude,
        });
      }
      if (dependencies.geocodingService === undefined) {
        return sendError(reply, 503, 'GEOCODING_UNAVAILABLE', 'Geocoding is not enabled');
      }
      if (dependencies.addressCanonicalizer !== undefined) {
        const resolved = await dependencies.addressCanonicalizer.resolve({ address, shopDomain });
        if (resolved.status !== 'RESOLVED') {
          return sendAddressResolutionError(reply, resolved.status);
        }
        return sendData(reply, {
          address: resolved.address,
          detailAddress: resolved.detailAddress,
          jibunAddress: resolved.jibunAddress,
          latitude: resolved.latitude,
          longitude: resolved.longitude,
          postalCode: resolved.postalCode,
          rawAddress: resolved.rawAddress,
        });
      }
      const geocode = await dependencies.geocodingService.geocode({
        address: {
          address1: address,
          address2: null,
          city: null,
          countryCode: 'KR',
          postalCode: null,
          province: null,
        },
        shopDomain,
      });
      if (!geocode.ok) {
        return sendError(reply, 400, geocode.code, geocode.message);
      }
      return sendData(reply, {
        address,
        latitude: geocode.result.latitude,
        longitude: geocode.result.longitude,
      });
    }, ['dsv:settings:write']));

  app.post(`${apiRoot}/addresses/resolve`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const body = objectBody(request.body);
      const address = readBoundedText(body?.address, 500);
      if (body === null || !hasOnlyKeys(body, ['address']) || address === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'An address is required');
      }
      if (dependencies.addressCanonicalizer === undefined) {
        return sendError(reply, 503, 'ADDRESS_SERVICE_UNAVAILABLE', 'Address canonicalization is not enabled');
      }
      const resolved = await dependencies.addressCanonicalizer.resolve({ address, shopDomain });
      if (resolved.status === 'UNAVAILABLE') return sendAddressResolutionError(reply, resolved.status);
      return sendData(reply, resolved);
    }, ['dsv:destinations:write']));

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
          principal: {
            actorId,
            actorType: 'DSV_ADMIN',
            principalType: 'DSV_ADMIN',
            requestId: request.id,
          },
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

  app.patch(`${apiRoot}/conditions/:conditionId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const conditionId = readUuidParam(request, 'conditionId');
      const body = objectBody(request.body);
      const code = readBoundedText(body?.code, 80);
      const name = readBoundedText(body?.name, 160);
      const description = readBoundedText(body?.description, 1_000);
      if (conditionId === null || code === null || name === null || description === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid transport condition payload');
      }
      try {
        const condition = await dependencies.dispatchImportService.updateCondition({
          code,
          conditionId,
          description,
          name,
          shopDomain,
        });
        return sendData(reply, { condition });
      } catch (error) {
        return sendConditionMutationError(reply, error);
      }
    }, ['dsv:conditions:write']));

  app.delete(`${apiRoot}/conditions/:conditionId`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const conditionId = readUuidParam(request, 'conditionId');
      if (conditionId === null) return sendError(reply, 400, 'BAD_REQUEST', 'Condition id must be a UUID');
      try {
        await dependencies.dispatchImportService.deleteCondition({ conditionId, shopDomain });
        return sendData(reply, { conditionId });
      } catch (error) {
        return sendConditionMutationError(reply, error);
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

  app.post(`${apiRoot}/seller-orders/:sellerOrderId/assignment/unassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readDsvUnassignCommand(request);
      if (sellerOrderId === null) return sendError(reply, 400, 'BAD_REQUEST', 'sellerOrderId must be a UUID');
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order unassign payload');
      try {
        const assignmentResult = await dependencies.assignmentCommandService.unassign({
          actor: dsvAdminCommandActor(session, request),
          commandId: command.commandId,
          expectedVersion: command.expectedVersion,
          reason: command.reason ?? null,
          sellerOrderId,
          shopDomain: session.shopDomain,
        });
        return sendData(reply, { assignmentResult });
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${apiRoot}/seller-orders/:sellerOrderId/assignment/reassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readDsvReassignCommand(request);
      if (sellerOrderId === null) return sendError(reply, 400, 'BAD_REQUEST', 'sellerOrderId must be a UUID');
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order reassign payload');
      try {
        const assignmentResult = await dependencies.assignmentCommandService.reassign({
          actor: dsvAdminCommandActor(session, request),
          commandId: command.commandId,
          expectedVersion: command.expectedVersion,
          reason: command.reason ?? null,
          sellerOrderId,
          targetDriverId: command.targetDriverId,
          ...(command.targetRoutePlanId === undefined ? {} : { targetRoutePlanId: command.targetRoutePlanId }),
          ...(command.targetSequence === undefined ? {} : { targetSequence: command.targetSequence }),
          ...(command.targetVehicleId === undefined ? {} : { targetVehicleId: command.targetVehicleId }),
          shopDomain: session.shopDomain,
        });
        return sendData(reply, { assignmentResult });
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${versionedApiRoot}/seller-orders/:sellerOrderId/assignment/unassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readDsvUnassignCommand(request);
      if (sellerOrderId === null) return sendError(reply, 400, 'BAD_REQUEST', 'sellerOrderId must be a UUID');
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order unassign payload');
      try {
        const assignmentResult = await dependencies.assignmentCommandService.unassign({
          actor: dsvAdminCommandActor(session, request),
          commandId: command.commandId,
          expectedVersion: command.expectedVersion,
          reason: command.reason ?? null,
          sellerOrderId,
          shopDomain: session.shopDomain,
        });
        return sendData(reply, { assignmentResult });
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${versionedApiRoot}/seller-orders/:sellerOrderId/assignment/reassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const sellerOrderId = readUuidParam(request, 'sellerOrderId');
      const command = readDsvReassignCommand(request);
      if (sellerOrderId === null) return sendError(reply, 400, 'BAD_REQUEST', 'sellerOrderId must be a UUID');
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order reassign payload');
      try {
        const assignmentResult = await dependencies.assignmentCommandService.reassign({
          actor: dsvAdminCommandActor(session, request),
          commandId: command.commandId,
          expectedVersion: command.expectedVersion,
          reason: command.reason ?? null,
          sellerOrderId,
          targetDriverId: command.targetDriverId,
          ...(command.targetRoutePlanId === undefined ? {} : { targetRoutePlanId: command.targetRoutePlanId }),
          ...(command.targetSequence === undefined ? {} : { targetSequence: command.targetSequence }),
          ...(command.targetVehicleId === undefined ? {} : { targetVehicleId: command.targetVehicleId }),
          shopDomain: session.shopDomain,
        });
        return sendData(reply, { assignmentResult });
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${apiRoot}/dispatch-imports/:importId/apply`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor: actorId, shopDomain }) => {
      const importId = readUuidParam(request, 'importId');
      const command = readDispatchImportApplyCommand(request);
      if (importId === null) return sendError(reply, 400, 'BAD_REQUEST', 'importId must be a UUID');
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid dispatch import apply payload');

      const dispatchImport = await dependencies.dispatchImportService.getImport({ importId, shopDomain });
      if (dispatchImport === null) return sendError(reply, 404, 'NOT_FOUND', 'Dispatch import not found');

      try {
        const applyResult = await dispatchImportServiceWithApply(dependencies.dispatchImportService).apply({
          actor: actorId,
          commandId: command.commandId,
          expectedSourceHash: command.expectedSourceHash,
          importId,
          principal: {
            actorId,
            actorType: 'DSV_ADMIN',
            principalType: 'DSV_ADMIN',
            requestId: request.id,
          },
          shopDomain,
        });
        if (dispatchImport.status !== 'APPLIED') {
          void dependencies.dispatchImportNotificationService?.notifyApplied({
            actor: actorId,
            appliedAt: new Date(),
            fileName: dispatchImport.fileName,
            importId,
            planDate: dispatchImport.planDate,
            shopDomain,
            summary: applyResult.summary,
          }).catch((notificationError: unknown) => {
            request.log.error({
              error: notificationError,
              importId,
              shopDomain,
            }, 'dispatch import applied email notification failed');
          });
        }
        return sendData(reply, { applyResult });
      } catch (error) {
        return sendDispatchImportApplyError(reply, error);
      }
    }, ['dsv:imports:apply']));

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
  return { allowedShopDomains: dependencies.allowedShopDomains, subject: 'dsv-admin-login' };
}

function dsvAdminCommandActor(session: DsvControlSession, request: FastifyRequest): DsvAssignmentCommandBaseInput['actor'] {
  return {
    actorId: session.actor,
    actorType: 'DSV_ADMIN',
    principalType: 'DSV_ADMIN',
    requestId: request.id,
  };
}

async function readDsvSession(request: FastifyRequest, dependencies: DsvControlDependencies): Promise<DsvControlSession | null> {
  const session = verifyAdminWebSessionFromRequest({
    cookieName: dependencies.cookieName,
    request,
    sessionSecret: dependencies.sessionSecret,
  });
  if (session === null) return null;
  const subject = parseDsvAdminSessionSubject(session.subject);
  if (subject === null) return null;
  const shopDomain = subject.shopDomain;
  if (shopDomain === null || !canAccessShopDomain(actor(dependencies), shopDomain)) return null;
  const shopId = await dependencies.repository.resolveShopId(shopDomain);
  if (shopId === null) return null;
  const account = subject.kind === 'account'
    ? await dependencies.adminAccounts.resolveSession({
        accountId: subject.accountId,
        tokenVersion: subject.tokenVersion,
      })
    : null;
  if (subject.kind === 'account' && account === null) return null;
  const actorId = account?.accountId ?? 'legacy-env-admin';
  return {
    actor: actorId,
    principal: createDsvAdminPrincipal({
      actorId,
      ...(account?.displayName === undefined ? {} : { displayName: account.displayName }),
      ...(account === null ? {} : { scopes: account.scopes }),
      shopDomain,
      shopId,
    }),
    session,
    shopDomain,
  };
}

async function withDsvSession(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  handler: (session: DsvControlSession) => unknown,
  requiredScopes: readonly DsvScope[] = ['dsv:session:read'],
): Promise<unknown> {
  try {
    const session = await readDsvSession(request, dependencies);
    if (session === null) return sendError(reply, 401, 'UNAUTHORIZED', 'DSV login required');
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
  handler: (session: DsvControlSession) => unknown,
  requiredScopes: readonly DsvScope[],
): Promise<unknown> {
  return withDsvSession(request, reply, dependencies, (session) => {
    if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
      return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }
    return handler(session);
  }, requiredScopes);
}

function sendData<T>(reply: FastifyReply, data: T, statusCode = 200): unknown {
  return reply.code(statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'private, no-store').send({ data, error: null });
}

function sendConditionMutationError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvDispatchImportConflictError) return sendError(reply, 409, error.code, error.message);
  if (error instanceof DsvDispatchImportShopNotFoundError || error instanceof DsvTransportConditionNotFoundError) {
    return sendError(reply, 404, 'NOT_FOUND', error.message);
  }
  throw error;
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

function sendAddressResolutionError(
  reply: FastifyReply,
  status: Exclude<DsvAddressResolutionStatus, 'RESOLVED'>,
): unknown {
  if (status === 'UNAVAILABLE') {
    return sendError(reply, 503, 'ADDRESS_SERVICE_UNAVAILABLE', 'Address canonicalization is unavailable');
  }
  if (status === 'AMBIGUOUS') {
    return sendError(reply, 409, 'ADDRESS_AMBIGUOUS', 'Multiple canonical address candidates remain');
  }
  if (status === 'NOT_FOUND') {
    return sendError(reply, 422, 'ADDRESS_NOT_FOUND', 'A canonical road address and postal code could not be found');
  }
  return sendError(reply, 422, 'ADDRESS_COORDINATES_NOT_RESOLVED', 'The address was found but map coordinates could not be resolved');
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function operationSettingsData(settings: AdminStoreSettings): Record<string, boolean | number | string | null> {
  return {
    departureAddress: settings.defaultDepotAddress,
    departureLatitude: settings.defaultDepotLatitude,
    departureLongitude: settings.defaultDepotLongitude,
    ...normalizeDsvOperationalSettings(settings.dsvOperationalSettings),
    loadingStartTime: settings.routeOpsUiSettings.loadingStartTime ?? defaultLoadingStartTime,
    plannedDepartureTime: settings.routeOpsUiSettings.plannedDepartureTime ?? defaultPlannedDepartureTime,
  };
}

function operationFieldsFrom(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of [
    'dwellMinutes',
    'etaDelayMinutes',
    'forwardDelayAlerts',
    'gpsSilenceSeconds',
    'recordMissingProof',
    'showTemperatureAlerts',
    'temperatureLimit',
  ] as const) {
    if (Object.hasOwn(body, field)) result[field] = body[field];
  }
  return result;
}

function validDepartureLocation(address: string | null, latitude: number | null, longitude: number | null): boolean {
  if (address === null || latitude === null || longitude === null) {
    return address === null && latitude === null && longitude === null;
  }
  return address.length <= 500 && validCoordinates(latitude, longitude);
}

function validCoordinates(latitude: number | null, longitude: number | null): latitude is number {
  return latitude !== null
    && longitude !== null
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function normalizedAddress(value: string | null): string | null {
  return value === null ? null : value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function readDispatchImportInput(value: unknown): DsvDispatchImportInput | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['fileName', 'planDate', 'previewHash', 'rows'])) return null;
  const fileName = readBoundedText(body?.fileName, 255);
  const planDate = readDate(body?.planDate);
  const hasPreviewHash = Object.hasOwn(body, 'previewHash');
  const previewHash = hasPreviewHash ? readSha256(body.previewHash) : undefined;
  if (
    fileName === null || planDate === null || previewHash === null
    || !Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 500
  ) return null;
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
    const hasAddressResolutionStatus = Object.hasOwn(row ?? {}, 'addressResolutionStatus');
    const hasDetailAddress = Object.hasOwn(row ?? {}, 'detailAddress');
    const hasJibunAddress = Object.hasOwn(row ?? {}, 'jibunAddress');
    const hasPostalCode = Object.hasOwn(row ?? {}, 'postalCode');
    const hasRawAddress = Object.hasOwn(row ?? {}, 'rawAddress');
    const addressResolutionStatus = hasAddressResolutionStatus
      ? readAddressResolutionStatus(row?.addressResolutionStatus)
      : undefined;
    const detailAddress = hasDetailAddress
      ? readNullableText(row?.detailAddress)
      : undefined;
    const jibunAddress = hasJibunAddress
      ? readNullableText(row?.jibunAddress)
      : undefined;
    const postalCode = hasPostalCode
      ? readNullableText(row?.postalCode)
      : undefined;
    const rawAddress = hasRawAddress
      ? readText(row?.rawAddress)
      : undefined;
    if (
      rowNumber === null || shippedBoxes === null || driverName === null || vehiclePlate === null
      || destinationName === null || conditionCode === null || address === null || customerCode === null
      || sellerOrderKey === null || notes === undefined || latitude === undefined || longitude === undefined
      || addressResolutionStatus === null
      || (hasDetailAddress && detailAddress === undefined)
      || (hasJibunAddress && jibunAddress === undefined)
      || (hasPostalCode && postalCode === undefined)
      || rawAddress === null
    ) return null;
    rows.push({
      address,
      ...(addressResolutionStatus === undefined ? {} : { addressResolutionStatus }),
      conditionCode,
      customerCode,
      ...(detailAddress === undefined ? {} : { detailAddress }),
      destinationName,
      driverName,
      ...(jibunAddress === undefined ? {} : { jibunAddress }),
      latitude,
      longitude,
      notes,
      ...(postalCode === undefined ? {} : { postalCode }),
      ...(rawAddress === undefined ? {} : { rawAddress }),
      rowNumber,
      sellerOrderKey,
      shippedBoxes,
      vehiclePlate,
    });
  }
  return {
    fileName,
    planDate,
    ...(previewHash === undefined ? {} : { previewHash }),
    rows,
  };
}

function readAddressResolutionStatus(value: unknown): DsvAddressResolutionStatus | null {
  const statuses: readonly DsvAddressResolutionStatus[] = [
    'ADDRESS_ONLY',
    'AMBIGUOUS',
    'NOT_FOUND',
    'RESOLVED',
    'UNAVAILABLE',
  ];
  return typeof value === 'string' && includes(statuses, value)
    ? value
    : null;
}

function readDriverInput(value: unknown): DsvDriverInput | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['age', 'career', 'gender', 'name', 'phone', 'score', 'traits', 'zone'])) return null;
  const age = readInteger(body.age);
  const career = readBoundedText(body.career, 160);
  const gender = readBoundedText(body.gender, 40);
  const name = readBoundedText(body.name, 80);
  const phone = Object.hasOwn(body, 'phone') ? readBoundedTextAllowEmpty(body.phone, 40) : undefined;
  const score = readBoundedText(body.score, 40);
  const traits = readBoundedTextArray(body.traits, 20, 160);
  const zone = readBoundedText(body.zone, 160);
  if (age === null || age < 18 || age > 100 || career === null || gender === null || name === null || phone === null || score === null || traits === null || zone === null) return null;
  return { age, career, gender, name, ...(phone === undefined ? {} : { phone }), score, traits, zone };
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

function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function sendDispatchImportApplyError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvDispatchImportApplyError) {
    return sendError(reply, dispatchImportApplyErrorStatus(error.code), error.code, error.message);
  }
  if (error instanceof DsvDispatchImportShopNotFoundError) return sendError(reply, 404, 'NOT_FOUND', error.message);
  throw error;
}

function sendDsvAssignmentCommandError(reply: FastifyReply, error: unknown): unknown {
  const sourceCode = readDsvAssignmentErrorCode(error);
  if (sourceCode === null) throw error;
  const code = legacyDsvAssignmentErrorCode(sourceCode);
  return sendError(reply, dsvAssignmentErrorStatus(code), code, error instanceof Error ? error.message : code);
}

const dsvAssignmentCommandErrorCodes = [
  'COMMAND_IN_PROGRESS',
  'DUPLICATE_ACTIVE_DELIVERY',
  'FORBIDDEN',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'NOT_FOUND',
  'SELLER_ORDER_ALREADY_ACQUIRED',
  'SELLER_ORDER_ASSIGNMENT_CHANGED',
  'SELLER_ORDER_ASSIGNMENT_NOT_READY',
  'SELLER_ORDER_NOT_FOUND',
  'SELLER_ORDER_ROUTE_RECALCULATION_FAILED',
  'SELLER_ORDER_ROUTE_RECALCULATION_UNAVAILABLE',
  'SELLER_ORDER_ROUTE_SCOPE_REJECTED',
  'SELLER_ORDER_TARGET_VEHICLE_REQUIRED',
  'SELLER_ORDER_TRANSFER_CLOSED',
] as const;

type DsvAssignmentCommandErrorCode = typeof dsvAssignmentCommandErrorCodes[number];

function readDsvAssignmentErrorCode(error: unknown): DsvAssignmentCommandErrorCode | null {
  if (!(error instanceof DsvAssignmentCommandError) && (typeof error !== 'object' || error === null || !('code' in error))) return null;
  if (typeof error.code !== 'string') return null;
  return includes(dsvAssignmentCommandErrorCodes, error.code) ? error.code : null;
}

function legacyDsvAssignmentErrorCode(code: DsvAssignmentCommandErrorCode): DsvAssignmentCommandErrorCode {
  switch (code) {
    case 'SELLER_ORDER_NOT_FOUND':
      return 'NOT_FOUND';
    case 'SELLER_ORDER_ROUTE_SCOPE_REJECTED':
      return 'FORBIDDEN';
    default:
      return code;
  }
}

function dsvAssignmentErrorStatus(code: DsvAssignmentCommandErrorCode): number {
  switch (code) {
    case 'FORBIDDEN':
    case 'SELLER_ORDER_ROUTE_SCOPE_REJECTED':
      return 403;
    case 'NOT_FOUND':
    case 'SELLER_ORDER_NOT_FOUND':
      return 404;
    case 'COMMAND_IN_PROGRESS':
    case 'DUPLICATE_ACTIVE_DELIVERY':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
    case 'SELLER_ORDER_ALREADY_ACQUIRED':
    case 'SELLER_ORDER_ASSIGNMENT_CHANGED':
    case 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED':
    case 'SELLER_ORDER_TRANSFER_CLOSED':
      return 409;
    case 'SELLER_ORDER_ASSIGNMENT_NOT_READY':
      return 422;
    case 'SELLER_ORDER_ROUTE_RECALCULATION_UNAVAILABLE':
      return 503;
    case 'SELLER_ORDER_ROUTE_RECALCULATION_FAILED':
      return 500;
  }
}

function dispatchImportApplyErrorStatus(code: DsvDispatchImportApplyError['code']): number {
  switch (code) {
    case 'COMMAND_IN_PROGRESS':
    case 'DISPATCH_IMPORT_ALREADY_APPLIED':
    case 'DISPATCH_IMPORT_PREVIEW_STALE':
    case 'DUPLICATE_ACTIVE_DELIVERY':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
      return 409;
    case 'DISPATCH_IMPORT_CANONICAL_CONFLICT':
    case 'DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES':
    case 'DISPATCH_IMPORT_HAS_REVIEW_ROWS':
    case 'DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES':
    case 'DISPATCH_IMPORT_INACTIVE_CONDITION':
    case 'DISPATCH_IMPORT_NOT_READY':
    case 'DISPATCH_IMPORT_RESOURCE_AMBIGUOUS':
    case 'DISPATCH_IMPORT_RESOURCE_MISSING':
      return 422;
  }
}

function dispatchImportServiceWithApply(service: DsvDispatchImportService): DsvDispatchImportService & {
  apply(input: DsvDispatchImportApplyInput): Promise<DsvDispatchImportApplyResult>;
} {
  return service as DsvDispatchImportService & {
    apply(input: DsvDispatchImportApplyInput): Promise<DsvDispatchImportApplyResult>;
  };
}

function readDispatchImportApplyCommand(request: FastifyRequest): { commandId: string; expectedSourceHash: string } | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, ['commandId', 'expectedSourceHash'])) return null;
  const bodyCommandId = readBoundedText(body.commandId, 120);
  const headerCommandId = readBoundedText(request.headers[applyCommandIdHeader], 120);
  const expectedSourceHash = readSha256(body.expectedSourceHash);
  if (expectedSourceHash === null) return null;
  if (headerCommandId !== null && bodyCommandId !== null && headerCommandId !== bodyCommandId) return null;
  const commandId = headerCommandId ?? bodyCommandId;
  return commandId === null ? null : { commandId, expectedSourceHash };
}

function readDsvUnassignCommand(request: FastifyRequest): {
  commandId: string;
  expectedVersion: string;
  reason?: string;
} | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, ['commandId', 'expectedVersion', 'reason'])) return null;
  const base = readDsvAssignmentCommandBase(request, body);
  if (base === null) return null;
  const reason = readOptionalBoundedText(body.reason, 500);
  if (reason === null) return null;
  return { ...base, ...(reason === undefined ? {} : { reason }) };
}

function readDsvReassignCommand(request: FastifyRequest): {
  commandId: string;
  expectedVersion: string;
  reason?: string;
  targetDriverId: string;
  targetRoutePlanId?: string;
  targetSequence?: number;
  targetVehicleId?: string;
} | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, [
    'commandId',
    'expectedVersion',
    'reason',
    'targetDriverId',
    'targetRoutePlanId',
    'targetSequence',
    'targetVehicleId',
  ])) return null;
  const base = readDsvAssignmentCommandBase(request, body);
  const reason = readOptionalBoundedText(body.reason, 500);
  const targetDriverId = readUuidValue(body.targetDriverId);
  const targetRoutePlanId = Object.hasOwn(body, 'targetRoutePlanId') ? readUuidValue(body.targetRoutePlanId) : undefined;
  const targetSequence = Object.hasOwn(body, 'targetSequence') ? readNonNegativeInteger(body.targetSequence) : undefined;
  const targetVehicleId = Object.hasOwn(body, 'targetVehicleId') ? readUuidValue(body.targetVehicleId) : undefined;
  if (
    base === null || reason === null || targetDriverId === null || targetRoutePlanId === null
    || targetSequence === null || targetVehicleId === null
  ) return null;
  return {
    ...base,
    ...(reason === undefined ? {} : { reason }),
    targetDriverId,
    ...(targetRoutePlanId === undefined ? {} : { targetRoutePlanId }),
    ...(targetSequence === undefined ? {} : { targetSequence: targetSequence + 1 }),
    ...(targetVehicleId === undefined ? {} : { targetVehicleId }),
  };
}

function readDsvAssignmentCommandBase(request: FastifyRequest, body: Record<string, unknown>): {
  commandId: string;
  expectedVersion: string;
} | null {
  const bodyCommandId = readBoundedText(body.commandId, 120);
  const headerCommandId = readBoundedText(request.headers[assignmentCommandIdHeader], 120);
  const expectedVersion = readBoundedText(body.expectedVersion, 160);
  if (expectedVersion === null) return null;
  if (headerCommandId !== null && bodyCommandId !== null && headerCommandId !== bodyCommandId) return null;
  const commandId = headerCommandId ?? bodyCommandId;
  return commandId === null ? null : { commandId, expectedVersion };
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

function readPassword(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

function readUuidValue(value: unknown): string | null {
  const id = readTrimmed(value);
  return id !== null && uuidPattern.test(id) ? id : null;
}

function readSha256(value: unknown): string | null {
  const text = readTrimmed(value);
  return text !== null && /^[a-f0-9]{64}$/iu.test(text) ? text.toLowerCase() : null;
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

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
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
