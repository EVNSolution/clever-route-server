import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
  type DsvAdminBatchDeleteInput,
  type DsvAdminBatchReassignInput,
  type DsvAdminBatchUnassignInput,
  type DsvAssignmentCommandBaseInput,
  type DsvBatchAssignmentResult,
  type DsvBatchDeleteResult,
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
  DsvTransportConditionTemperaturePolicyInput,
} from '../modules/dsv/dsv-dispatch-import.service.js';
import type {
  DsvManualEmailService,
} from '../modules/dsv/dsv-manual-email.service.js';
import {
  DsvManualEmailConfigurationError,
  DsvManualEmailSendError,
} from '../modules/dsv/dsv-manual-email.service.js';
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
import {
  DsvAdminAccountManagementError,
  type DsvAdminAccountAuthenticator,
  type DsvAdminAccountManager,
  type DsvAdminAccountStatus,
  type DsvAdminAccountSummary,
} from '../modules/dsv/dsv-admin-account.repository.js';
import {
  DsvAdminOperatorInvitationError,
  type DsvAdminOperatorAccountMetadata,
  type DsvAdminOperatorInvitationService,
} from '../modules/dsv/dsv-admin-account-invitations.service.js';
import {
  createCustomerSessionSubject,
  DsvCustomerAccountServiceError,
  type DsvCustomerAccountService,
} from '../modules/dsv/dsv-customer-account-invitations.service.js';
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
const operatorGuideFileName = 'CLEVER_DSV_관제_운영자_사용자_가이드_20260811.pdf';
const operatorGuidePath = fileURLToPath(new URL(`../../assets/dsv-guides/${operatorGuideFileName}`, import.meta.url));
const driverGuideFileName = 'CLEVER_Driver_설치_현장교육_가이드_Rev1.1.pdf';
const driverGuidePath = fileURLToPath(new URL(`../../assets/dsv-guides/${driverGuideFileName}`, import.meta.url));
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
  'manualEmailBody',
  'manualEmailSenderEmail',
  'manualEmailSubject',
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
  deleteMany(input: DsvAdminBatchDeleteInput): Promise<DsvBatchDeleteResult>;
  reassign(input: DsvAdminReassignCommandInput): Promise<DsvAssignmentResult>;
  reassignMany(input: DsvAdminBatchReassignInput): Promise<DsvBatchAssignmentResult>;
  unassign(input: DsvAssignmentCommandBaseInput): Promise<DsvAssignmentResult>;
  unassignMany(input: DsvAdminBatchUnassignInput): Promise<DsvBatchAssignmentResult>;
};

type DsvControlSession = {
  activeSessionId: string;
  actor: string;
  principal: DsvPrincipal;
  session: NonNullable<ReturnType<typeof verifyAdminWebSessionFromRequest>>;
  shopDomain: string;
};

export type DsvControlDependencies = {
  addressCanonicalizer?: DsvAddressCanonicalizer;
  adminAccountManagement?: DsvAdminAccountManager;
  adminAccounts: DsvAdminAccountAuthenticator;
  allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  assignmentCommandService?: DsvAdminAssignmentCommandService;
  cookieName: string;
  customerAccountService?: DsvCustomerAccountService;
  dispatchImportService: DsvDispatchImportService;
  geocodingService?: Pick<GeocodingService, 'geocode'>;
  manualEmailService: DsvManualEmailService;
  operatorInvitationService?: DsvAdminOperatorInvitationService;
  repository: DsvControlRepository;
  resourceService: DsvResourceService;
  secureCookies: boolean;
  sessionSecret: string;
  settingsService: Pick<PrismaAdminStoreSettingsService, 'getSettings' | 'saveSettings'>;
};

export function registerDsvControlRoutes(app: FastifyInstance, dependencies: DsvControlDependencies): void {
  registerDsvAdminOperatorInvitationRoutes(app, dependencies);
  registerDsvCustomerAccountRoutes(app, dependencies);

  app.post(`${apiRoot}/auth/login`, {
    config: {
      rateLimit: {
        groupId: 'dsv-admin-login',
        keyGenerator: (request) => dsvLoginRateLimitKey(request.body, 'admin'),
        max: 5,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const id = readTrimmed(body?.id);
    const password = readPassword(body?.password);
    const shopDomain = normalizeShopDomain(readTrimmed(body?.shopDomain));
    if (id === null || password === null || shopDomain === null) {
      return sendError(reply, 400, 'BAD_REQUEST', 'ID, password, and shopDomain are required');
    }
    const account = await dependencies.adminAccounts.authenticate({ loginId: id, password });
    if (account === null) {
      return sendError(reply.header('Set-Cookie', clearAdminWebSessionCookie({
        cookieName: dependencies.cookieName,
        path: cookiePath,
        secure: dependencies.secureCookies,
      })), 401, 'UNAUTHORIZED', '로그인 정보가 올바르지 않습니다.');
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
        activeSessionId: account.activeSessionId,
        shopDomain,
      }),
    });
    request.log.info({
      accountId: account.accountId,
      event: 'dsv_admin_session_rotated',
      requestId: request.id,
      shopDomain,
    }, 'DSV admin session rotated');
    return sendData(reply.header('Set-Cookie', cookieHeader), {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      shopDomain,
    });
  });

  app.post(`${apiRoot}/auth/logout`, (request, reply) =>
    withDsvSession(request, reply, dependencies, async (session) => {
      if (!verifyAdminWebCsrfToken({ session: session.session, token: request.headers['x-csrf-token'] as string | undefined })) {
        return sendError(reply, 403, 'FORBIDDEN', 'Invalid CSRF token');
      }
      const clearedReply = reply.header('Set-Cookie', clearAdminWebSessionCookie({
        cookieName: dependencies.cookieName,
        path: cookiePath,
        secure: dependencies.secureCookies,
      }));
      await dependencies.adminAccounts.invalidateSession({
        accountId: session.actor,
        activeSessionId: session.activeSessionId,
      });
      return sendData(clearedReply, { loggedOut: true });
    }));

  app.get(`${apiRoot}/auth/session`, (request, reply) =>
    withDsvSession(request, reply, dependencies, (session) => sendData(reply, {
      csrfToken: session.session.csrfToken,
      expiresAt: new Date(session.session.expiresAt).toISOString(),
      shopDomain: session.shopDomain,
    })));

  app.get(`${apiRoot}/admin-accounts`, (request, reply) =>
    withDsvSession(request, reply, dependencies, async () => {
      if (dependencies.adminAccountManagement === undefined) {
        return sendError(reply, 503, 'ADMIN_ACCOUNT_MANAGEMENT_UNAVAILABLE', '계정 관리 기능을 사용할 수 없습니다.');
      }
      const accounts = await dependencies.adminAccountManagement.list();
      return sendData(reply, { accounts: accounts.map(adminAccountData) });
    }, ['dsv:accounts:read']));

  app.post(`${apiRoot}/admin-accounts/invitations`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, shopDomain }) => {
      const service = requireOperatorInvitationService(dependencies);
      const input = readOperatorInvitationBody(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid operator invitation payload');
      try {
        const invitation = await service.createInvitation({
          actorId: actor,
          email: input.email,
          requestId: request.id,
          shopDomain,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.message === undefined ? {} : { message: input.message }),
        });
        return sendData(reply, { invitation: operatorInvitationData(invitation) }, 201);
      } catch (error) {
        return sendOperatorInvitationError(reply, error);
      }
    }, ['dsv:accounts:write']));

  app.patch<{ Params: { accountId: string } }>(`${apiRoot}/admin-accounts/:accountId/status`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, principal }) => {
      if (dependencies.adminAccountManagement === undefined) {
        return sendError(reply, 503, 'ADMIN_ACCOUNT_MANAGEMENT_UNAVAILABLE', '계정 관리 기능을 사용할 수 없습니다.');
      }
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', '계정 식별자가 올바르지 않습니다.');
      const status = readAdminAccountStatus(request.body);
      if (status === null) return sendError(reply, 400, 'BAD_REQUEST', '계정 상태가 올바르지 않습니다.');
      if (actor === request.params.accountId && status === 'DISABLED') {
        return sendError(reply, 409, 'ADMIN_ACCOUNT_SELF_DISABLE_FORBIDDEN', '현재 로그인한 계정은 비활성화할 수 없습니다.');
      }
      try {
        const account = await dependencies.adminAccountManagement.setStatus({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopId: principal.shopId,
          status,
        });
        return sendData(reply, { account: adminAccountData(account) });
      } catch (error) {
        return sendAdminAccountManagementError(reply, error);
      }
    }, ['dsv:accounts:write']));

  app.delete<{ Params: { accountId: string } }>(`${apiRoot}/admin-accounts/:accountId`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, principal }) => {
      if (dependencies.adminAccountManagement === undefined) {
        return sendError(reply, 503, 'ADMIN_ACCOUNT_MANAGEMENT_UNAVAILABLE', '계정 관리 기능을 사용할 수 없습니다.');
      }
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', '계정 식별자가 올바르지 않습니다.');
      if (actor === request.params.accountId) {
        return sendError(reply, 409, 'ADMIN_ACCOUNT_SELF_DELETE_FORBIDDEN', '현재 로그인한 계정은 삭제할 수 없습니다.');
      }
      try {
        await dependencies.adminAccountManagement.delete({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopId: principal.shopId,
        });
        return sendData(reply, { deletedAccountId: request.params.accountId });
      } catch (error) {
        return sendAdminAccountManagementError(reply, error);
      }
    }, ['dsv:accounts:write']));

  app.delete<{ Params: { accountId: string } }>(`${apiRoot}/admin-accounts/:accountId/session`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, principal }) => {
      if (dependencies.adminAccountManagement === undefined) {
        return sendError(reply, 503, 'ADMIN_ACCOUNT_MANAGEMENT_UNAVAILABLE', '계정 관리 기능을 사용할 수 없습니다.');
      }
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', '계정 식별자가 올바르지 않습니다.');
      if (actor === request.params.accountId) {
        return sendError(reply, 409, 'ADMIN_ACCOUNT_SELF_SESSION_REVOKE_FORBIDDEN', '현재 로그인한 계정은 여기서 로그아웃할 수 없습니다.');
      }
      try {
        const result = await dependencies.adminAccountManagement.revokeSession({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopId: principal.shopId,
        });
        return sendData(reply, { accountId: request.params.accountId, revoked: result.revoked });
      } catch (error) {
        return sendAdminAccountManagementError(reply, error);
      }
    }, ['dsv:accounts:write']));

  app.patch(`${apiRoot}/auth/credentials`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      const service = requireOperatorInvitationService(dependencies);
      const input = readOperatorCredentialsBody(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid credential update payload');
      try {
        const account = await service.updateCredentials({
          accountId: session.actor,
          currentPassword: input.currentPassword,
          requestId: request.id,
          shopDomain: session.shopDomain,
          ...(input.loginId === undefined ? {} : { loginId: input.loginId }),
          ...(input.password === undefined ? {} : { password: input.password }),
        });
        return await sendDsvAdminSession(reply, dependencies, account, session.shopDomain);
      } catch (error) {
        return sendOperatorInvitationError(reply, error);
      }
    }, ['dsv:session:read']));

  app.get<{ Params: { customerId: string } }>(`${apiRoot}/customers/:customerId/accounts`, (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const service = requireCustomerAccountService(dependencies);
      if (!uuidPattern.test(request.params.customerId)) return sendError(reply, 400, 'BAD_REQUEST', 'customerId must be a UUID');
      return sendData(reply, {
        accounts: await service.listAccounts({ customerId: request.params.customerId, shopDomain }),
      });
    }, ['dsv:customers:read']));

  app.post<{ Params: { customerId: string } }>(`${apiRoot}/customers/:customerId/accounts/invitations`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, shopDomain }) => {
      const service = requireCustomerAccountService(dependencies);
      if (!uuidPattern.test(request.params.customerId)) return sendError(reply, 400, 'BAD_REQUEST', 'customerId must be a UUID');
      const input = readCustomerAccountInvitationBody(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid customer account invitation payload');
      try {
        return sendData(reply, await service.createSignupInvitation({
          actorId: actor,
          customerId: request.params.customerId,
          email: input.email,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.loginId === undefined ? {} : { loginId: input.loginId }),
          ...(input.generateLoginId === true ? { generateLoginId: true } : {}),
          requestId: request.id,
          shopDomain,
        }), 201);
      } catch (error) {
        return sendCustomerAccountServiceError(reply, error);
      }
    }, ['dsv:customers:write']));

  app.post<{ Params: { accountId: string } }>(`${apiRoot}/customer-accounts/:accountId/reinvite`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, shopDomain }) => {
      const service = requireCustomerAccountService(dependencies);
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', 'accountId must be a UUID');
      try {
        return sendData(reply, await service.reinvite({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopDomain,
        }));
      } catch (error) {
        return sendCustomerAccountServiceError(reply, error);
      }
    }, ['dsv:customers:write']));

  app.post<{ Params: { accountId: string } }>(`${apiRoot}/customer-accounts/:accountId/password-reset`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, shopDomain }) => {
      const service = requireCustomerAccountService(dependencies);
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', 'accountId must be a UUID');
      try {
        return sendData(reply, await service.requestPasswordReset({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopDomain,
        }));
      } catch (error) {
        return sendCustomerAccountServiceError(reply, error);
      }
    }, ['dsv:customers:write']));

  app.patch<{ Params: { accountId: string } }>(`${apiRoot}/customer-accounts/:accountId/status`, (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ actor, shopDomain }) => {
      const service = requireCustomerAccountService(dependencies);
      if (!uuidPattern.test(request.params.accountId)) return sendError(reply, 400, 'BAD_REQUEST', 'accountId must be a UUID');
      const status = readCustomerAccountStatus(request.body);
      if (status === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid customer account status');
      try {
        return sendData(reply, await service.setStatus({
          accountId: request.params.accountId,
          actorId: actor,
          requestId: request.id,
          shopDomain,
          status,
        }));
      } catch (error) {
        return sendCustomerAccountServiceError(reply, error);
      }
    }, ['dsv:customers:write']));

  app.get(`${apiRoot}/settings/operations`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const settings = await dependencies.settingsService.getSettings({ shopDomain });
      return settings === null
        ? sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found')
        : sendData(reply, operationSettingsData(settings));
    }, ['dsv:settings:read']));

  app.get<{ Querystring: { download?: string } }>(`${apiRoot}/guides/operator`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async () => sendGuide(request, reply, {
      asciiFileName: 'CLEVER_DSV_Operator_User_Guide_20260811.pdf',
      fileName: operatorGuideFileName,
      path: operatorGuidePath,
    }), ['dsv:settings:read']));

  app.get<{ Querystring: { download?: string } }>(`${apiRoot}/guides/driver`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async () => sendGuide(request, reply, {
      asciiFileName: 'CLEVER_Driver_App_Guide_Checklist_Rev1.1.pdf',
      fileName: driverGuideFileName,
      path: driverGuidePath,
    }), ['dsv:settings:read']));

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
          ...(hasLoadingStartTime ? { loadingStartTime: loadingStartTime ?? defaultLoadingStartTime } : {}),
          ...(hasPlannedDepartureTime ? { plannedDepartureTime: plannedDepartureTime ?? defaultPlannedDepartureTime } : {}),
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

  app.get(`${apiRoot}/manual-email`, async (request, reply) =>
    withDsvSession(request, reply, dependencies, async ({ shopDomain }) => {
      const settings = await dependencies.settingsService.getSettings({ shopDomain });
      if (settings === null) return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
      const operationSettings = normalizeDsvOperationalSettings(settings.dsvOperationalSettings);
      return sendData(reply, dependencies.manualEmailService.getConfig({
        senderEmail: operationSettings.manualEmailSenderEmail,
        subject: operationSettings.manualEmailSubject,
        textContent: operationSettings.manualEmailBody,
      }));
    }, ['dsv:settings:read']));

  app.post(`${apiRoot}/manual-email`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const input = readManualEmailInput(request.body);
      if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid manual email payload');
      try {
        const settings = await dependencies.settingsService.getSettings({ shopDomain });
        if (settings === null) return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
        const senderEmail = normalizeDsvOperationalSettings(settings.dsvOperationalSettings).manualEmailSenderEmail;
        if (senderEmail === null) throw new DsvManualEmailConfigurationError();
        const result = await dependencies.manualEmailService.send({ ...input, senderEmail });
        return sendData(reply, result);
      } catch (error) {
        if (error instanceof DsvManualEmailConfigurationError) {
          return sendError(reply, 503, 'MANUAL_EMAIL_NOT_CONFIGURED', '수동 이메일 발송 설정이 완료되지 않았습니다.');
        }
        if (error instanceof DsvManualEmailSendError) {
          return sendError(reply, 502, 'MANUAL_EMAIL_SEND_FAILED', '이메일 발송에 실패했습니다.');
        }
        throw error;
      }
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

  app.post(`${apiRoot}/drivers/signup-invite`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      try {
        const invite = await dependencies.resourceService.issueDriverSignupInvite({ shopDomain });
        return sendData(reply, { invite }, 201);
      } catch (error) {
        return sendResourceError(reply, error);
      }
    }, ['dsv:resources:write']));

  app.post(`${apiRoot}/drivers/:driverId/signup-invite`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async ({ shopDomain }) => {
      const driverId = readUuidParam(request, 'driverId');
      if (driverId === null) return sendError(reply, 400, 'BAD_REQUEST', 'driverId must be a UUID');
      try {
        const invite = await dependencies.resourceService.issueDriverSignupInvite({ driverId, shopDomain });
        return sendData(reply, { invite }, 201);
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
      const temperaturePolicy = readConditionTemperaturePolicy(body);
      if (code === null || name === null || description === null || temperaturePolicy === null) {
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
          ...temperaturePolicy,
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
      const temperaturePolicy = readConditionTemperaturePolicy(body);
      if (conditionId === null || code === null || name === null || description === null || temperaturePolicy === null) {
        return sendError(reply, 400, 'BAD_REQUEST', 'Invalid transport condition payload');
      }
      try {
        const condition = await dependencies.dispatchImportService.updateCondition({
          code,
          conditionId,
          description,
          name,
          shopDomain,
          ...temperaturePolicy,
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

  app.post(`${versionedApiRoot}/seller-order-assignments/reassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const command = readDsvBatchReassignCommand(request);
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order batch reassign payload');
      try {
        const result = await dependencies.assignmentCommandService.reassignMany({
          actor: dsvAdminCommandActor(session, request),
          items: command.items,
          reason: command.reason ?? null,
          shopDomain: session.shopDomain,
          targetDriverId: command.targetDriverId,
          ...(command.targetRoutePlanId === undefined ? {} : { targetRoutePlanId: command.targetRoutePlanId }),
          ...(command.targetVehicleId === undefined ? {} : { targetVehicleId: command.targetVehicleId }),
        });
        return sendData(reply, result);
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${versionedApiRoot}/seller-order-assignments/unassign`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const command = readDsvBatchUnassignCommand(request);
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order batch unassign payload');
      try {
        const result = await dependencies.assignmentCommandService.unassignMany({
          actor: dsvAdminCommandActor(session, request),
          items: command.items,
          reason: command.reason ?? null,
          shopDomain: session.shopDomain,
        });
        return sendData(reply, result);
      } catch (error) {
        return sendDsvAssignmentCommandError(reply, error);
      }
    }, ['dsv:dispatches:write']));

  app.post(`${versionedApiRoot}/seller-order-deletions`, async (request, reply) =>
    withDsvMutation(request, reply, dependencies, async (session) => {
      if (dependencies.assignmentCommandService === undefined) {
        return sendError(reply, 503, 'DSV_ASSIGNMENT_SERVICE_UNAVAILABLE', 'DSV assignment command service is not configured');
      }
      const command = readDsvBatchDeleteCommand(request);
      if (command === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid seller order batch deletion payload');
      try {
        const result = await dependencies.assignmentCommandService.deleteMany({
          actor: dsvAdminCommandActor(session, request),
          commandId: command.commandId,
          items: command.items,
          reason: command.reason ?? null,
          shopDomain: session.shopDomain,
        });
        return sendData(reply, result);
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

function registerDsvAdminOperatorInvitationRoutes(app: FastifyInstance, dependencies: DsvControlDependencies): void {
  app.post(`${apiRoot}/admin/auth/invitations/validate`, {
    config: {
      rateLimit: {
        groupId: 'dsv-admin-invitation-validate',
        max: 20,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const service = requireOperatorInvitationService(dependencies);
    const input = readInviteTokenBody(request.body);
    if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid invitation validation payload');
    const metadata = await service.validateInvitation(input);
    return metadata === null
      ? sendError(reply, 401, 'INVALID_TOKEN', 'Invitation token is invalid')
      : sendData(reply, {
          displayName: metadata.displayName,
          email: metadata.email,
          expiresAt: metadata.expiresAt.toISOString(),
        });
  });

  app.post(`${apiRoot}/admin/auth/complete`, {
    config: {
      rateLimit: {
        groupId: 'dsv-admin-account-complete',
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const service = requireOperatorInvitationService(dependencies);
    const input = readOperatorCompleteBody(request.body);
    if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid operator account completion payload');
    try {
      const account = await service.complete({ ...input, requestId: request.id });
      return await sendDsvAdminSession(reply, dependencies, account, input.shopDomain);
    } catch (error) {
      return sendOperatorInvitationError(reply, error);
    }
  });
}

function registerDsvCustomerAccountRoutes(app: FastifyInstance, dependencies: DsvControlDependencies): void {
  app.post(`${apiRoot}/customer/auth/invitations/validate`, {
    config: {
      rateLimit: {
        groupId: 'dsv-customer-invitation-validate',
        max: 20,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const service = requireCustomerAccountService(dependencies);
    const input = readCustomerInviteTokenBody(request.body);
    if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid invitation validation payload');
    const metadata = await service.validateInvitation(input);
    return metadata === null
      ? sendError(reply, 401, 'INVALID_TOKEN', 'Invitation token is invalid')
      : sendData(reply, {
          customerName: metadata.customerName,
          displayName: metadata.displayName,
          email: metadata.email,
          expiresAt: metadata.expiresAt.toISOString(),
          loginId: metadata.loginId,
          purpose: metadata.purpose,
        });
  });

  app.post(`${apiRoot}/customer/auth/complete`, {
    config: {
      rateLimit: {
        groupId: 'dsv-customer-account-complete',
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const service = requireCustomerAccountService(dependencies);
    const input = readCustomerCompleteBody(request.body);
    if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid customer account completion payload');
    try {
      const identity = await service.complete({ ...input, requestId: request.id });
      return sendCustomerSession(reply, dependencies, identity);
    } catch (error) {
      return sendCustomerAccountServiceError(reply, error);
    }
  });

  app.post(`${apiRoot}/customer/auth/login`, {
    config: {
      rateLimit: {
        groupId: 'dsv-customer-login',
        keyGenerator: (request) => dsvLoginRateLimitKey(request.body, 'customer'),
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const service = requireCustomerAccountService(dependencies);
    const input = readCustomerLoginBody(request.body);
    if (input === null) return sendError(reply, 400, 'BAD_REQUEST', 'ID, password, and shopDomain are required');
    const identity = await service.login({ ...input, requestId: request.id });
    if (identity === null) return sendError(reply, 401, 'UNAUTHORIZED', '로그인 정보가 올바르지 않습니다.');
    request.log.info({
      accountId: identity.accountId,
      event: 'dsv_customer_session_rotated',
      requestId: request.id,
      shopDomain: identity.shopDomain,
    }, 'DSV customer session rotated');
    return sendCustomerSession(reply, dependencies, identity);
  });
}

function sendCustomerSession(
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  identity: { accountId: string; activeSessionId: string; customerId: string; shopDomain: string; shopId: string },
): unknown {
  const { cookieHeader, session } = createAdminWebSession({
    cookieName: dependencies.cookieName,
    path: cookiePath,
    sameSite: 'Lax',
    secure: dependencies.secureCookies,
    sessionSecret: dependencies.sessionSecret,
    subject: createCustomerSessionSubject({
      accountId: identity.accountId,
      activeSessionId: identity.activeSessionId,
    }),
  });
  return sendData(reply.header('Set-Cookie', cookieHeader), {
    accountId: identity.accountId,
    csrfToken: session.csrfToken,
    customerId: identity.customerId,
    expiresAt: new Date(session.expiresAt).toISOString(),
    shopDomain: identity.shopDomain,
    shopId: identity.shopId,
  });
}

async function sendDsvAdminSession(
  reply: FastifyReply,
  dependencies: DsvControlDependencies,
  account: DsvAdminOperatorAccountMetadata,
  shopDomain: string,
): Promise<unknown> {
  const { cookieHeader, session } = createAdminWebSession({
    cookieName: dependencies.cookieName,
    path: cookiePath,
    sameSite: 'Lax',
    secure: dependencies.secureCookies,
    sessionSecret: dependencies.sessionSecret,
    subject: createDsvAdminSessionSubject({
      accountId: account.id,
      activeSessionId: account.activeSessionId,
      shopDomain,
    }),
  });
  const shopId = await dependencies.repository.resolveShopId(shopDomain);
  if (shopId === null) return sendError(reply, 404, 'NOT_FOUND', 'Customer workspace not found');
  return sendData(reply.header('Set-Cookie', cookieHeader), {
    account: adminOperatorAccountData(account),
    actorId: account.id,
    csrfToken: session.csrfToken,
    ...(account.displayName === null ? {} : { displayName: account.displayName }),
    expiresAt: new Date(session.expiresAt).toISOString(),
    principalType: 'DSV_ADMIN',
    scopes: [...account.scopes],
    shopDomain,
    shopId,
  });
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
  if (subject === null || subject.kind !== 'account') return null;
  const shopDomain = subject.shopDomain;
  if (shopDomain === null || !canAccessShopDomain(actor(dependencies), shopDomain)) return null;
  const shopId = await dependencies.repository.resolveShopId(shopDomain);
  if (shopId === null) return null;
  const account = await dependencies.adminAccounts.resolveSession({
    accountId: subject.accountId,
    activeSessionId: subject.activeSessionId,
  });
  if (account === null) return null;
  const actorId = account.accountId;
  return {
    activeSessionId: subject.activeSessionId,
    actor: actorId,
    principal: createDsvAdminPrincipal({
      actorId,
      ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
      scopes: account.scopes,
      mustChangePassword: account.mustChangePassword,
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

async function sendGuide(
  request: FastifyRequest<{ Querystring: { download?: string } }>,
  reply: FastifyReply,
  guide: { asciiFileName: string; fileName: string; path: string },
): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(guide.path)).size;
  } catch {
    return sendError(reply, 503, 'DSV_GUIDE_UNAVAILABLE', '사용자 가이드 파일을 사용할 수 없습니다.');
  }

  const disposition = request.query.download === '1' ? 'attachment' : 'inline';
  const range = parseByteRange(request.headers.range, size);
  reply
    .type('application/pdf')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-store')
    .header('Content-Disposition', `${disposition}; filename="${guide.asciiFileName}"; filename*=UTF-8''${encodeURIComponent(guide.fileName)}`);

  if (range === null) {
    return reply.code(200).header('Content-Length', size).send(createReadStream(guide.path));
  }
  if (range === 'invalid') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  return reply
    .code(206)
    .header('Content-Length', range.end - range.start + 1)
    .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    .send(createReadStream(guide.path, range));
}

function parseByteRange(value: string | undefined, size: number): { end: number; start: number } | 'invalid' | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return 'invalid';

  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { end: size - 1, start: Math.max(0, size - suffixLength) };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return 'invalid';
  return { end: Math.min(requestedEnd, size - 1), start };
}

function sendConditionMutationError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvDispatchImportConflictError) return sendError(reply, 409, error.code, error.message);
  if (error instanceof DsvDispatchImportShopNotFoundError || error instanceof DsvTransportConditionNotFoundError) {
    return sendError(reply, 404, 'NOT_FOUND', error.message);
  }
  throw error;
}

function sendAdminAccountManagementError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DsvAdminAccountManagementError) {
    if (error.code === 'ADMIN_ACCOUNT_LOGIN_ID_EXISTS') {
      return sendError(reply, 409, error.code, '이미 사용 중인 아이디입니다.');
    }
    if (error.code === 'ADMIN_ACCOUNT_DELETE_REQUIRES_DISABLED') {
      return sendError(reply, 409, error.code, '비활성 계정만 삭제할 수 있습니다.');
    }
    return sendError(reply, 404, error.code, '계정을 찾을 수 없습니다.');
  }
  throw error;
}

function sendCustomerAccountServiceError(reply: FastifyReply, error: unknown): unknown {
  if (!(error instanceof DsvCustomerAccountServiceError)) throw error;
  if (error.code === 'NOT_FOUND') return sendError(reply, 404, error.code, error.message);
  if (error.code === 'ACCOUNT_EXISTS' || error.code === 'LOGIN_ID_EXISTS') return sendError(reply, 409, error.code, error.message);
  if (error.code === 'INVALID_TOKEN') return sendError(reply, 401, error.code, error.message);
  if (error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'INVITATION_LINK_NOT_CONFIGURED') {
    return sendError(reply, 503, error.code, error.message);
  }
  return sendError(reply, 400, error.code, error.message);
}

function sendOperatorInvitationError(reply: FastifyReply, error: unknown): unknown {
  if (!(error instanceof DsvAdminOperatorInvitationError)) throw error;
  if (error.code === 'NOT_FOUND') return sendError(reply, 404, error.code, error.message);
  if (error.code === 'ACCOUNT_EXISTS' || error.code === 'LOGIN_ID_EXISTS') return sendError(reply, 409, error.code, error.message);
  if (error.code === 'INVALID_TOKEN' || error.code === 'CURRENT_PASSWORD_INVALID') return sendError(reply, 401, error.code, error.message);
  if (error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'INVITATION_LINK_NOT_CONFIGURED') {
    return sendError(reply, 503, error.code, error.message);
  }
  return sendError(reply, 400, error.code, error.message);
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

function requireCustomerAccountService(dependencies: DsvControlDependencies): DsvCustomerAccountService {
  if (dependencies.customerAccountService === undefined) {
    throw new DsvCustomerAccountServiceError('NOT_FOUND', 'Customer account service is not configured');
  }
  return dependencies.customerAccountService;
}

function requireOperatorInvitationService(dependencies: DsvControlDependencies): DsvAdminOperatorInvitationService {
  if (dependencies.operatorInvitationService === undefined) {
    throw new DsvAdminOperatorInvitationError('NOT_FOUND', 'Operator invitation service is not configured');
  }
  return dependencies.operatorInvitationService;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dsvLoginRateLimitKey(value: unknown, surface: 'admin' | 'customer'): string {
  const loginId = readTrimmed(objectBody(value)?.id)?.toLowerCase() ?? '';
  const digest = createHash('sha256').update(loginId).digest('base64url');
  return `dsv-${surface}-login:${digest}`;
}

function readOperatorInvitationBody(value: unknown): { displayName?: string; email: string; message?: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['displayName', 'email', 'message'])) return null;
  const email = readBoundedText(body.email, 320);
  const displayName = Object.hasOwn(body, 'displayName') ? readOptionalBoundedText(body.displayName, 120) : undefined;
  const message = Object.hasOwn(body, 'message') ? readOptionalBoundedText(body.message, 1000) : undefined;
  if (email === null || displayName === null || message === null) return null;
  return {
    email,
    ...(displayName === undefined ? {} : { displayName }),
    ...(message === undefined ? {} : { message }),
  };
}

function readOperatorCredentialsBody(value: unknown): { currentPassword: string; loginId?: string; password?: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['currentPassword', 'loginId', 'password'])) return null;
  const currentPassword = readPassword(body.currentPassword);
  const loginId = Object.hasOwn(body, 'loginId') ? readOptionalBoundedText(body.loginId, 80) : undefined;
  const password = Object.hasOwn(body, 'password') ? readOptionalPassword(body.password) : undefined;
  if (currentPassword === null || loginId === null || password === null || (loginId === undefined && password === undefined)) return null;
  return {
    currentPassword,
    ...(loginId === undefined ? {} : { loginId }),
    ...(password === undefined ? {} : { password }),
  };
}

function readAdminAccountStatus(value: unknown): DsvAdminAccountStatus | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['status'])) return null;
  return body.status === 'ACTIVE' || body.status === 'DISABLED' ? body.status : null;
}

function readCustomerAccountInvitationBody(value: unknown): { displayName?: string; email: string; generateLoginId?: true; loginId?: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['displayName', 'email', 'generateLoginId', 'loginId'])) return null;
  const email = readBoundedText(body.email, 320);
  const displayName = Object.hasOwn(body, 'displayName') ? readOptionalBoundedText(body.displayName, 120) : undefined;
  const loginId = Object.hasOwn(body, 'loginId') ? readOptionalBoundedText(body.loginId, 80) : undefined;
  const generateLoginId = body.generateLoginId === true ? true : undefined;
  if (
    email === null
    || displayName === null
    || loginId === null
    || ((loginId === undefined) === (generateLoginId !== true))
  ) {
    return null;
  }
  return {
    email,
    ...(displayName === undefined ? {} : { displayName }),
    ...(generateLoginId === true ? { generateLoginId } : {}),
    ...(loginId === undefined ? {} : { loginId }),
  };
}

function readCustomerAccountStatus(value: unknown): 'ACTIVE' | 'DISABLED' | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['status'])) return null;
  return body.status === 'ACTIVE' || body.status === 'DISABLED' ? body.status : null;
}

function readCustomerInviteTokenBody(value: unknown): { shopDomain: string; token: string } | null {
  return readInviteTokenBody(value);
}

function readInviteTokenBody(value: unknown): { shopDomain: string; token: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['shopDomain', 'token'])) return null;
  const shopDomain = normalizeShopDomain(readTrimmed(body.shopDomain));
  const token = readBoundedText(body.token, 200);
  return shopDomain === null || token === null ? null : { shopDomain, token };
}

function readOperatorCompleteBody(value: unknown): { loginId: string; password: string; shopDomain: string; token: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['loginId', 'password', 'shopDomain', 'token'])) return null;
  const shopDomain = normalizeShopDomain(readTrimmed(body.shopDomain));
  const token = readBoundedText(body.token, 200);
  const loginId = readBoundedText(body.loginId, 80);
  const password = readCustomerPassword(body.password);
  if (shopDomain === null || token === null || loginId === null || password === null) return null;
  return { loginId, password, shopDomain, token };
}

function readCustomerCompleteBody(value: unknown): { password: string; shopDomain: string; token: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['password', 'shopDomain', 'token'])) return null;
  const shopDomain = normalizeShopDomain(readTrimmed(body.shopDomain));
  const token = readBoundedText(body.token, 200);
  const password = readCustomerPassword(body.password);
  if (shopDomain === null || token === null || password === null) return null;
  return { password, shopDomain, token };
}

function readCustomerLoginBody(value: unknown): { id: string; password: string; shopDomain: string } | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['id', 'password', 'shopDomain'])) return null;
  const id = readBoundedText(body.id, 80);
  const password = readCustomerPassword(body.password);
  const shopDomain = normalizeShopDomain(readTrimmed(body.shopDomain));
  return id === null || password === null || shopDomain === null ? null : { id, password, shopDomain };
}

function adminAccountData(account: DsvAdminAccountSummary): Record<string, unknown> {
  return {
    createdAt: account.createdAt.toISOString(),
    displayName: account.displayName,
    failedLoginAttempts: account.failedLoginAttempts,
    id: account.id,
    lastAuthenticatedAt: account.lastAuthenticatedAt?.toISOString() ?? null,
    lockedUntil: account.lockedUntil?.toISOString() ?? null,
    loginId: account.loginId,
    mustChangePassword: account.mustChangePassword,
    scopes: account.scopes,
    status: account.status,
    updatedAt: account.updatedAt.toISOString(),
  };
}

function operatorInvitationData(invitation: {
  createdAt: Date;
  displayName: string | null;
  email: string;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
}): Record<string, unknown> {
  return {
    createdAt: invitation.createdAt.toISOString(),
    displayName: invitation.displayName,
    email: invitation.email,
    expiresAt: invitation.expiresAt.toISOString(),
    id: invitation.id,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
  };
}

function adminOperatorAccountData(account: DsvAdminOperatorAccountMetadata): Record<string, unknown> {
  return {
    createdAt: account.createdAt.toISOString(),
    displayName: account.displayName,
    email: account.email,
    id: account.id,
    lastAuthenticatedAt: account.lastAuthenticatedAt?.toISOString() ?? null,
    loginId: account.loginId,
    mustChangePassword: account.mustChangePassword,
    scopes: account.scopes,
    status: account.status,
    updatedAt: account.updatedAt.toISOString(),
  };
}

function readManualEmailInput(value: unknown): {
  commandId: string;
  recipients: string[];
  subject: string;
  textContent: string;
} | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyKeys(body, ['commandId', 'confirmed', 'recipients', 'subject', 'textContent'])) return null;
  const commandId = readTrimmed(body.commandId);
  const subject = readBoundedText(body.subject, 200);
  const textContent = readBoundedText(body.textContent, 10_000);
  if (
    commandId === null
    || !uuidPattern.test(commandId)
    || body.confirmed !== true
    || subject === null
    || textContent === null
    || !Array.isArray(body.recipients)
    || body.recipients.length === 0
    || body.recipients.length > 10
  ) return null;
  const recipients = body.recipients.map((recipient) => readTrimmed(recipient));
  if (recipients.some((recipient) => recipient === null || !isEmailAddress(recipient))) return null;
  return {
    commandId,
    recipients: recipients as string[],
    subject,
    textContent,
  };
}

function readConditionTemperaturePolicy(
  body: Record<string, unknown> | null,
): DsvTransportConditionTemperaturePolicyInput | null {
  if (body === null) return null;
  const hasTemperatureAlertEnabled = Object.prototype.hasOwnProperty.call(body, 'temperatureAlertEnabled');
  const hasTemperatureMinC = Object.prototype.hasOwnProperty.call(body, 'temperatureMinC');
  const hasTemperatureMaxC = Object.prototype.hasOwnProperty.call(body, 'temperatureMaxC');
  const temperatureAlertEnabled = readOptionalBoolean(body.temperatureAlertEnabled);
  const temperatureMinC = readOptionalTemperatureC(body.temperatureMinC);
  const temperatureMaxC = readOptionalTemperatureC(body.temperatureMaxC);
  if (
    (hasTemperatureAlertEnabled && temperatureAlertEnabled === null)
    || (hasTemperatureMinC && temperatureMinC === undefined)
    || (hasTemperatureMaxC && temperatureMaxC === undefined)
  ) return null;
  if (
    temperatureMinC !== undefined
    && temperatureMinC !== null
    && temperatureMaxC !== undefined
    && temperatureMaxC !== null
    && temperatureMinC > temperatureMaxC
  ) return null;
  return {
    ...(temperatureAlertEnabled === undefined || temperatureAlertEnabled === null ? {} : { temperatureAlertEnabled }),
    ...(temperatureMaxC === undefined ? {} : { temperatureMaxC }),
    ...(temperatureMinC === undefined ? {} : { temperatureMinC }),
  };
}

function readOptionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function readOptionalTemperatureC(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100) return undefined;
  return Math.round(value * 100) / 100;
}

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
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
    'manualEmailBody',
    'manualEmailSenderEmail',
    'manualEmailSubject',
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
  const requiredKeys = ['age', 'career', 'gender', 'name', 'score', 'traits', 'zone'];
  if (
    body === null
    || !hasOnlyAllowedKeys(body, [...requiredKeys, 'phone'])
    || !requiredKeys.every((key) => Object.hasOwn(body, key))
  ) return null;
  const age = readInteger(body.age);
  const career = readBoundedText(body.career, 160);
  const gender = readBoundedText(body.gender, 40);
  const name = readBoundedText(body.name, 80);
  const phone = Object.hasOwn(body, 'phone') ? readBoundedTextAllowEmpty(body.phone, 40) : undefined;
  const score = readBoundedText(body.score, 40);
  const traits = readBoundedTextArray(body.traits, 20, 160);
  const zone = readBoundedText(body.zone, 160);
  if (age === null || (age !== 0 && age < 18) || age > 100 || career === null || gender === null || name === null || phone === null || score === null || traits === null || zone === null) return null;
  return { age, career, gender, name, ...(phone === undefined ? {} : { phone }), score, traits, zone };
}

function readVehicleInput(value: unknown): DsvVehicleInput | null {
  const body = objectBody(value);
  if (body === null || !hasOnlyAllowedKeys(body, ['note', 'plate', 'telematicsSerialNumber', 'type'])) return null;
  const note = readBoundedTextAllowEmpty(body.note, 1_000);
  const plate = readBoundedText(body.plate, 40);
  const telematicsSerialNumber = Object.hasOwn(body, 'telematicsSerialNumber')
    ? readBoundedTextAllowEmpty(body.telematicsSerialNumber, 160)
    : undefined;
  const type = readBoundedText(body.type, 160);
  return note === null || plate === null || telematicsSerialNumber === null || type === null
    ? null
    : { note, plate, ...(telematicsSerialNumber === undefined ? {} : { telematicsSerialNumber }), type };
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

function readDsvBatchReassignCommand(request: FastifyRequest): {
  items: Array<{ commandId: string; expectedVersion: string; sellerOrderId: string }>;
  reason?: string;
  targetDriverId: string;
  targetRoutePlanId?: string;
  targetVehicleId?: string;
} | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, [
    'items',
    'reason',
    'targetDriverId',
    'targetRoutePlanId',
    'targetVehicleId',
  ])) return null;
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) return null;

  const reason = readOptionalBoundedText(body.reason, 500);
  const targetDriverId = readUuidValue(body.targetDriverId);
  const targetRoutePlanId = Object.hasOwn(body, 'targetRoutePlanId') ? readUuidValue(body.targetRoutePlanId) : undefined;
  const targetVehicleId = Object.hasOwn(body, 'targetVehicleId') ? readUuidValue(body.targetVehicleId) : undefined;
  if (reason === null || targetDriverId === null || targetRoutePlanId === null || targetVehicleId === null) return null;

  const items: Array<{ commandId: string; expectedVersion: string; sellerOrderId: string }> = [];
  const sellerOrderIds = new Set<string>();
  for (const value of body.items) {
    const item = objectBody(value);
    if (item === null || !hasOnlyAllowedKeys(item, ['commandId', 'expectedVersion', 'sellerOrderId'])) return null;
    const commandId = readBoundedText(item.commandId, 120);
    const expectedVersion = readBoundedText(item.expectedVersion, 160);
    const sellerOrderId = readUuidValue(item.sellerOrderId);
    if (commandId === null || expectedVersion === null || sellerOrderId === null || sellerOrderIds.has(sellerOrderId)) return null;
    sellerOrderIds.add(sellerOrderId);
    items.push({ commandId, expectedVersion, sellerOrderId });
  }

  return {
    items,
    ...(reason === undefined ? {} : { reason }),
    targetDriverId,
    ...(targetRoutePlanId === undefined ? {} : { targetRoutePlanId }),
    ...(targetVehicleId === undefined ? {} : { targetVehicleId }),
  };
}

function readDsvBatchUnassignCommand(request: FastifyRequest): {
  items: Array<{ commandId: string; expectedVersion: string; sellerOrderId: string }>;
  reason?: string;
} | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, ['items', 'reason'])) return null;
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) return null;

  const reason = readOptionalBoundedText(body.reason, 500);
  if (reason === null) return null;

  const items: Array<{ commandId: string; expectedVersion: string; sellerOrderId: string }> = [];
  const sellerOrderIds = new Set<string>();
  for (const value of body.items) {
    const item = objectBody(value);
    if (item === null || !hasOnlyAllowedKeys(item, ['commandId', 'expectedVersion', 'sellerOrderId'])) return null;
    const commandId = readBoundedText(item.commandId, 120);
    const expectedVersion = readBoundedText(item.expectedVersion, 160);
    const sellerOrderId = readUuidValue(item.sellerOrderId);
    if (commandId === null || expectedVersion === null || sellerOrderId === null || sellerOrderIds.has(sellerOrderId)) return null;
    sellerOrderIds.add(sellerOrderId);
    items.push({ commandId, expectedVersion, sellerOrderId });
  }

  return {
    items,
    ...(reason === undefined ? {} : { reason }),
  };
}

function readDsvBatchDeleteCommand(request: FastifyRequest): {
  commandId: string;
  items: Array<{ expectedVersion: string; sellerOrderId: string }>;
  reason?: string;
} | null {
  const body = objectBody(request.body);
  if (body === null || !hasOnlyAllowedKeys(body, ['commandId', 'items', 'reason'])) return null;
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) return null;

  const bodyCommandId = readBoundedText(body.commandId, 120);
  const headerCommandId = readBoundedText(request.headers[assignmentCommandIdHeader], 120);
  const reason = readOptionalBoundedText(body.reason, 500);
  if (reason === null || (headerCommandId !== null && bodyCommandId !== null && headerCommandId !== bodyCommandId)) return null;
  const commandId = headerCommandId ?? bodyCommandId;
  if (commandId === null) return null;

  const items: Array<{ expectedVersion: string; sellerOrderId: string }> = [];
  const sellerOrderIds = new Set<string>();
  for (const value of body.items) {
    const item = objectBody(value);
    if (item === null || !hasOnlyAllowedKeys(item, ['expectedVersion', 'sellerOrderId'])) return null;
    const expectedVersion = readBoundedText(item.expectedVersion, 160);
    const sellerOrderId = readUuidValue(item.sellerOrderId);
    if (expectedVersion === null || sellerOrderId === null || sellerOrderIds.has(sellerOrderId)) return null;
    sellerOrderIds.add(sellerOrderId);
    items.push({ expectedVersion, sellerOrderId });
  }

  return { commandId, items, ...(reason === undefined ? {} : { reason }) };
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

function readCustomerPassword(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readOptionalPassword(value: unknown): string | null | undefined {
  return value === undefined ? undefined : readCustomerPassword(value);
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
