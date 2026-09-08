import { describe, expect, test, vi } from 'vitest';

import { buildApp, type BuildAppOptions } from '../src/app.js';
import { createAdminWebSession } from '../src/routes/admin-ui-session.js';
import type {
  DsvV1ReadDependencies,
  DsvV1ReadQueryService,
  DsvV1SessionResolver,
} from '../src/routes/dsv-v1-read.routes.js';
import {
  DsvV1AuthenticationError,
  DsvV1ForbiddenError,
} from '../src/routes/dsv-v1-read.routes.js';
import {
  createDsvAdminPrincipal,
  createDsvCustomerUserPrincipalFromAccount,
  dsvOperatorScopes,
  DsvForbiddenError,
} from '../src/modules/dsv/dsv-principal.js';
import type { DsvScope } from '../src/modules/dsv/dsv-principal.js';
import { DsvV1ReadQueryError } from '../src/modules/dsv/dsv-v1-read-query.service.js';
import type { DsvV1CustomerDeliveryInquiryRow } from '../src/modules/dsv/dsv-v1-read.dto.js';
import {
  type DsvDispatchChangeRequestService,
} from '../src/modules/dsv/dsv-dispatch-change-request.service.js';
import {
  DsvTimeConstraintCommandError,
  type DsvTimeConstraintCommandService,
} from '../src/modules/dsv/dsv-time-constraint-command.service.js';
import {
  DsvOrderMessageError,
  type DsvOrderMessageService,
} from '../src/modules/dsv/dsv-order-message.service.js';
import type { RoutePlanDetail, RoutePlanSummary } from '../src/modules/route-plans/route-plan.types.js';
import type { RouteGeometryProvider } from '../src/modules/route-plans/route-plan.service.js';

const sessionSecret = '12345678901234567890123456789012';
const cookieName = 'clever_dsv_admin';
const shopId = '99999999-9999-4999-8999-999999999999';
const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const diagnosticLoadId = '11111111-1111-4111-8111-111111111111';
const diagnosticAttemptId = '22222222-2222-4222-8222-222222222222';
const diagnosticRetryAttemptId = '33333333-3333-4333-8333-333333333333';
const diagnosticAbortedAttemptId = '44444444-4444-4444-8444-444444444444';

describe('DSV v1 read routes', () => {
  test('returns exact v1 session envelope for admin and customer browser sessions', async () => {
    const { app, queryService, sessionResolver } = await createHarness();
    try {
      const admin = signedCookie(`dsv-shop:tomatonofood.com`);
      const adminResponse = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(adminResponse.statusCode).toBe(200);
      expect(adminResponse.headers['cache-control']).toBe('private, no-store');
      const adminBody = expectDsvV1Metadata(adminResponse);
      expectDsvAdminSessionData(adminBody.data);

      const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
      const customerResponse = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(customerResponse.statusCode).toBe(200);
      expectDsvV1Envelope(customerResponse, {
        csrfToken: customer.csrfToken,
        customerId,
        principalType: 'CUSTOMER_USER',
        scopes: ['dsv:session:read', 'dsv:customer-deliveries:read'],
        shopId,
      });
      expect(sessionResolver.resolve).toHaveBeenCalledWith('dsv-shop:tomatonofood.com');
      expect(sessionResolver.resolve).toHaveBeenCalledWith(`dsv-customer-account:${accountId}:1`);
      expect(queryService.listDispatches).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps missing, invalid, expired, unknown, and inactive sessions to stable auth errors', async () => {
    const { app, sessionResolver } = await createHarness();
    sessionResolver.resolve.mockRejectedValueOnce(new DsvV1AuthenticationError());
    sessionResolver.resolve.mockRejectedValueOnce(new DsvV1ForbiddenError('DSV customer account is inactive'));
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/dsv/v1/session' });
      expect(missing.statusCode).toBe(401);
      expectDsvV1Error(missing, { code: 'UNAUTHENTICATED', message: 'DSV session required' });

      const invalid = await app.inject({
        headers: { cookie: `${cookieName}=not-signed` },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(invalid.statusCode).toBe(401);

      const expired = signedCookie(`dsv-customer-account:${accountId}:1`, -1);
      const expiredResponse = await app.inject({
        headers: { cookie: expired.cookie },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(expiredResponse.statusCode).toBe(401);

      const unknown = signedCookie('dsv-unknown:subject');
      const unknownResponse = await app.inject({
        headers: { cookie: unknown.cookie },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(unknownResponse.statusCode).toBe(401);

      const inactive = signedCookie(`dsv-customer-account:${accountId}:1`);
      const inactiveResponse = await app.inject({
        headers: { cookie: inactive.cookie },
        method: 'GET',
        url: '/api/dsv/v1/session',
      });
      expect(inactiveResponse.statusCode).toBe(403);
      expectDsvV1Error(inactiveResponse, { code: 'FORBIDDEN', message: 'DSV customer account is inactive' });
    } finally {
      await app.close();
    }
  });

  test('records allowlisted dispatch-load success, failure, and aborted diagnostics', async () => {
    const logLines: string[] = [];
    const { app } = await createHarness({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    try {
      const success = await app.inject({
        headers,
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload(),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(success.statusCode).toBe(200);
      expectDsvV1Envelope(success, { accepted: true });

      const failure = await app.inject({
        headers,
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload({
          apiVersion: 'invalid',
          attemptId: diagnosticRetryAttemptId,
          attemptKind: 'retry',
          contentType: 'application/json',
          errorCode: 'LIST_PARSER_INVALID',
          failedResource: 'destinations',
          failureStage: 'parser',
          httpStatus: 200,
          outcome: 'failure',
          responseRequestId: 'server-request.safe:123',
        }),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(failure.statusCode).toBe(200);
      expectDsvV1Envelope(failure, { accepted: true });

      const minimalFailure = await app.inject({
        headers,
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload({
          attemptId: '123e4567-e89b-42d3-a456-426614174003',
          attemptKind: 'retry',
          errorCode: 'NETWORK_ERROR',
          failedResource: 'dispatches',
          failureStage: 'transport',
          outcome: 'failure',
        }),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(minimalFailure.statusCode).toBe(200);
      expectDsvV1Envelope(minimalFailure, { accepted: true });

      const aborted = await app.inject({
        headers,
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload({
          attemptId: diagnosticAbortedAttemptId,
          durationMs: 7,
          outcome: 'aborted',
        }),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(aborted.statusCode).toBe(200);
      expectDsvV1Envelope(aborted, { accepted: true });

      const attempts = dispatchLoadAttemptLogs(logLines);
      expect(attempts).toHaveLength(4);
      expect(attempts[0]).toMatchObject({
        attemptId: diagnosticAttemptId,
        attemptKind: 'initial',
        durationMs: 42,
        event: 'dsv_dispatch_load_attempt',
        loadId: diagnosticLoadId,
        outcome: 'success',
        serviceDate: '2026-09-08',
        source: 'browser',
      });
      expect(typeof attempts[0]?.requestId).toBe('string');
      expect(attempts[1]).toMatchObject({
        apiVersion: 'invalid',
        attemptId: diagnosticRetryAttemptId,
        attemptKind: 'retry',
        contentType: 'application/json',
        errorCode: 'LIST_PARSER_INVALID',
        failedResource: 'destinations',
        failureStage: 'parser',
        httpStatus: 200,
        loadId: diagnosticLoadId,
        outcome: 'failure',
        responseRequestId: 'server-request.safe:123',
      });
      expect(attempts[2]).toMatchObject({
        attemptId: '123e4567-e89b-42d3-a456-426614174003',
        errorCode: 'NETWORK_ERROR',
        failedResource: 'dispatches',
        failureStage: 'transport',
        outcome: 'failure',
      });
      expect(attempts[2]).not.toHaveProperty('apiVersion');
      expect(attempts[2]).not.toHaveProperty('contentType');
      expect(attempts[2]).not.toHaveProperty('httpStatus');
      expect(attempts[2]).not.toHaveProperty('responseRequestId');
      expect(attempts[3]).toMatchObject({
        attemptId: diagnosticAbortedAttemptId,
        outcome: 'aborted',
      });
      for (const attempt of attempts) {
        expect(attempt).not.toHaveProperty('actorId');
        expect(attempt).not.toHaveProperty('body');
        expect(attempt).not.toHaveProperty('cookie');
        expect(attempt).not.toHaveProperty('errorMessage');
        expect(attempt).not.toHaveProperty('headers');
        expect(attempt).not.toHaveProperty('shopId');
      }
    } finally {
      await app.close();
    }
  });

  test('requires an authenticated admin dispatch reader and valid CSRF for dispatch-load diagnostics', async () => {
    const { app } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      const missingSession = await app.inject({
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload(),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(missingSession.statusCode).toBe(401);

      const customerSession = await app.inject({
        headers: { cookie: customer.cookie, 'x-csrf-token': customer.csrfToken },
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload(),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(customerSession.statusCode).toBe(403);

      for (const csrfToken of [undefined, 'wrong-csrf-token']) {
        const csrfResponse = await app.inject({
          headers: {
            cookie: admin.cookie,
            ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
          },
          method: 'POST',
          payload: dispatchLoadDiagnosticPayload(),
          url: '/api/dsv/v1/diagnostics/dispatch-load',
        });
        expect(csrfResponse.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }

    const restricted = await createHarness({ adminScopes: ['dsv:session:read'] });
    const restrictedAdmin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const missingScope = await restricted.app.inject({
        headers: { cookie: restrictedAdmin.cookie, 'x-csrf-token': restrictedAdmin.csrfToken },
        method: 'POST',
        payload: dispatchLoadDiagnosticPayload(),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(missingScope.statusCode).toBe(403);
    } finally {
      await restricted.app.close();
    }
  });

  test('rejects invalid dispatch-load diagnostic payloads without logging raw input or search queries', async () => {
    const logLines: string[] = [];
    const { app } = await createHarness({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    const base = dispatchLoadDiagnosticPayload();
    const failure = dispatchLoadDiagnosticPayload({
      errorCode: 'NETWORK_ERROR',
      failedResource: 'dispatches',
      failureStage: 'transport',
      outcome: 'failure',
    });
    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ['non-v4 load UUID', { ...base, loadId: '11111111-1111-1111-8111-111111111111' }],
      ['invalid attempt UUID', { ...base, attemptId: 'not-a-uuid' }],
      ['wrong UUID type', { ...base, loadId: 1 }],
      ['invalid attempt kind', { ...base, attemptKind: 'automatic' }],
      ['invalid outcome', { ...base, outcome: 'error' }],
      ['impossible service date', { ...base, serviceDate: '2026-02-29' }],
      ['invalid service date type', { ...base, serviceDate: 20260908 }],
      ['negative duration', { ...base, durationMs: -1 }],
      ['fractional duration', { ...base, durationMs: 1.5 }],
      ['excess duration', { ...base, durationMs: 300_001 }],
      ['invalid source', { ...base, source: 'server' }],
      ['success with failure resource', { ...base, failedResource: 'dispatches' }],
      ['aborted with HTTP metadata', { ...base, httpStatus: 499, outcome: 'aborted' }],
      ['failure missing resource', { ...failure, failedResource: undefined }],
      ['failure missing stage', { ...failure, failureStage: undefined }],
      ['failure missing code', { ...failure, errorCode: undefined }],
      ['invalid failed resource', { ...failure, failedResource: 'routes' }],
      ['invalid failure stage', { ...failure, failureStage: 'timeout' }],
      ['invalid error code', { ...failure, errorCode: 'RAW_ERROR' }],
      ['invalid HTTP status', { ...failure, httpStatus: 99 }],
      ['invalid content type', { ...failure, contentType: 'application/xml' }],
      ['invalid API version', { ...failure, apiVersion: 'dsv.v2' }],
      ['unsafe response request ID', { ...failure, responseRequestId: 'unsafe request id' }],
      ['long response request ID', { ...failure, responseRequestId: 'x'.repeat(121) }],
      ['unknown raw error field', { ...failure, errorMessage: 'Private Customer 010-1234-5678 at 742 Secret Street' }],
    ];

    try {
      for (const [label, payload] of invalidPayloads) {
        const response = await app.inject({
          headers,
          method: 'POST',
          payload,
          url: '/api/dsv/v1/diagnostics/dispatch-load',
        });
        expect(response.statusCode, label).toBe(400);
      }

      const unsupportedQuery = await app.inject({
        headers,
        method: 'POST',
        payload: base,
        url: '/api/dsv/v1/diagnostics/dispatch-load?destinationName=Private%20Customer',
      });
      expect(unsupportedQuery.statusCode).toBe(400);

      const wrongContentType = await app.inject({
        headers: { ...headers, 'content-type': 'text/plain' },
        method: 'POST',
        payload: JSON.stringify(base),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(wrongContentType.statusCode).toBeGreaterThanOrEqual(400);

      const malformedJson = await app.inject({
        headers: { ...headers, 'content-type': 'application/json' },
        method: 'POST',
        payload: '{"loadId":',
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(malformedJson.statusCode).toBe(400);

      const oversized = await app.inject({
        headers: { ...headers, 'content-type': 'application/json' },
        method: 'POST',
        payload: JSON.stringify({ ...base, padding: 'private-oversized-payload'.repeat(220) }),
        url: '/api/dsv/v1/diagnostics/dispatch-load',
      });
      expect(oversized.statusCode).toBe(413);

      expect(dispatchLoadAttemptLogs(logLines)).toHaveLength(0);
      const serializedLogs = logLines.join('\n');
      for (const secret of [
        'Private Customer',
        'Private%20Customer',
        '010-1234-5678',
        '742 Secret Street',
        'private-oversized-payload',
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });

  test('registers v1 read endpoints with strict query policies and v1 envelopes', async () => {
    const { app, queryService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      for (const path of [
        '/dispatches?serviceDate=2026-07-23',
        '/control?serviceDate=2026-07-23',
        '/map/profile',
        '/records?serviceDate=2026-07-23&limit=50&page=2',
        '/drivers',
        '/vehicles',
        '/customers',
        '/destinations',
        '/conditions',
      ]) {
        const registered = await app.inject({
          headers: { cookie: admin.cookie },
          method: 'GET',
          url: `/api/dsv/v1${path}`,
        });
        expect(registered.statusCode, path).toBe(200);
        expectDsvV1Metadata(registered);
      }

      expect(queryService.listRecords).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN', shopId }),
        { limit: 50, page: 2, serviceDate: '2026-07-23' },
      );

      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/dispatches?serviceDate=2026-07-23&limit=25&cursor=opaque&orderNumber=%20123%20&destinationName=%EB%AA%85%EB%8F%99%20%20%EC%9D%98%EC%9B%90',
      });
      expect(response.statusCode).toBe(200);
      expectDsvV1Envelope(response, {
        items: [{
          assignmentStatus: 'ASSIGNED',
          customerId: 'customer-a',
          deliveryStopId: 'stop-1',
          destinationId: 'destination-a',
          etaStatus: 'READY',
          eventSummary: [
            { occurredAt: '2026-07-23T01:00:00.000Z', type: 'STOP_ARRIVED' },
            { occurredAt: '2026-07-23T01:30:00.000Z', type: 'STOP_FAILED' },
          ],
          sellerOrderId: 'order-1',
          sellerOrderKey: 'SO-001',
        }],
        page: { hasMore: false },
      });
      expect(queryService.listDispatches).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN', shopId }),
        {
          cursor: 'opaque',
          destinationName: '명동 의원',
          limit: 25,
          orderNumber: '123',
          serviceDate: '2026-07-23',
        },
      );

      queryService.listVehicles.mockResolvedValueOnce({
        items: [{
          displayName: 'Truck A',
          driverAssignments: [{ assignmentId: 'assignment-1', driverId: 'driver-1' }],
          status: 'ACTIVE',
          telematicsCapabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
          telematicsSerialNumber: '012-5273-8978',
          vehicleId: 'vehicle-1',
          vehiclePlate: '11A1111',
        }],
        page: { hasMore: false },
      });
      const vehicles = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/vehicles?limit=10',
      });
      expect(vehicles.statusCode).toBe(200);
      expectDsvV1Envelope(vehicles, {
        items: [{
          displayName: 'Truck A',
          driverAssignments: [{ assignmentId: 'assignment-1', driverId: 'driver-1' }],
          status: 'ACTIVE',
          telematicsCapabilities: ['LOCATION', 'TEMPERATURE', 'TACHOMETER'],
          telematicsSerialNumber: '012-5273-8978',
          vehicleId: 'vehicle-1',
          vehiclePlate: '11A1111',
        }],
        page: { hasMore: false },
      });
      const vehicleBody = parseJsonBody<{ data: { items: Array<{ driverAssignments: unknown }> } }>(vehicles);
      expect(JSON.stringify(vehicleBody.data.items[0]?.driverAssignments)).not.toMatch(
        /kind|displayName|phone|vehicleId/u
      );

      const mapProfile = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/map/profile',
      });
      expect(mapProfile.statusCode).toBe(200);
      expectDsvV1Envelope(mapProfile, dsvMapProfile());

      const unsupported = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/dispatches?sort=createdAt',
      });
      expect(unsupported.statusCode).toBe(400);
      expectDsvV1Error(unsupported, { code: 'BAD_REQUEST', message: 'Unsupported query parameter' });

      for (const path of [
        '/session?extra=1',
        '/dispatches?extra=1',
        '/control?extra=1',
        '/map/profile?extra=1',
        '/records?extra=1',
        '/drivers?extra=1',
        '/vehicles?extra=1',
        '/customers?extra=1',
        '/destinations?extra=1',
        '/conditions?extra=1',
        '/customer/deliveries?extra=1',
      ]) {
        const rejected = await app.inject({
          headers: { cookie: admin.cookie },
          method: 'GET',
          url: `/api/dsv/v1${path}`,
        });
        expect(rejected.statusCode, path).toBe(400);
        expectDsvV1Error(rejected, { code: 'BAD_REQUEST', message: 'Unsupported query parameter' });
      }

      const invalidLimit = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/drivers?limit=101',
      });
      expect(invalidLimit.statusCode).toBe(400);

      const invalidSearch = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/dispatches?orderNumber=${'1'.repeat(121)}`,
      });
      expect(invalidSearch.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  test('serves cached control route geometry without invoking a routing provider', async () => {
    const { app, routePlanService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    routePlanService.listRoutePlans.mockResolvedValueOnce([routePlanSummary()]);
    routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail());
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/control/routes?serviceDate=2026-07-23',
      });
      expect(response.statusCode).toBe(200);
      expectDsvV1Envelope(response, {
        routes: [{
          coordinates: [[126.9, 37.5], [127, 37.6]],
          generatedAt: '2026-07-23T00:01:00.000Z',
          geometryStatus: 'fresh',
          legDurationsSeconds: [420],
          routePlanId: 'route-plan-1',
        }],
        serviceDate: '2026-07-23',
      });
      expect(routePlanService.listRoutePlans).toHaveBeenCalledWith({
        appId: 'clever',
        deliveryDate: '2026-07-23',
        shopDomain: 'tomatonofood.com',
      });
    } finally {
      await app.close();
    }
  });

  test('omits store review route plans from control geometry for operators', async () => {
    const storeReviewAccess = createStoreReviewAccess((principal, resources) => {
      if (resources.routePlanIds?.includes('22222222-2222-4222-8222-222222222222') === true) {
        return Promise.reject(new DsvForbiddenError({ principal, requiredScopes: ['dsv:accounts:read'] }));
      }
      return Promise.resolve();
    });
    const { app, routePlanService } = await createHarness({
      adminScopes: dsvOperatorScopes,
      storeReviewAccess,
    });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    routePlanService.listRoutePlans.mockResolvedValueOnce([
      { ...routePlanSummary(), id: '11111111-1111-4111-8111-111111111111' },
      { ...routePlanSummary(), id: '22222222-2222-4222-8222-222222222222' },
    ]);
    routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
      routePlan: { ...routePlanSummary(), id: '11111111-1111-4111-8111-111111111111' },
    }));
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/control/routes?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      expect(parseJsonBody<{ data: { routes: Array<{ routePlanId: string }> } }>(response).data.routes)
        .toEqual([expect.objectContaining({ routePlanId: '11111111-1111-4111-8111-111111111111' })]);
      expect(routePlanService.getRoutePlanDetail).toHaveBeenCalledTimes(1);
      expect(storeReviewAccess.assertAccessible).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN' }),
        { routePlanIds: ['22222222-2222-4222-8222-222222222222'] },
      );
    } finally {
      await app.close();
    }
  });

  test('blocks operator writes to store review orders before command services run', async () => {
    const protectedOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const storeReviewAccess = createStoreReviewAccess((principal, resources) => {
      if (resources.orderIds?.includes(protectedOrderId) === true) {
        return Promise.reject(new DsvForbiddenError({ principal, requiredScopes: ['dsv:accounts:read'] }));
      }
      return Promise.resolve();
    });
    const createOrderMessage = vi.fn<DsvOrderMessageService['create']>();
    const orderMessageService: DsvOrderMessageService = {
      create: createOrderMessage,
      listCustomerMessages: vi.fn(),
      markDriverMessageRead: vi.fn(),
      updateCustomerNotificationSettings: vi.fn(),
    };
    const confirmTimeConstraint = vi.fn<DsvTimeConstraintCommandService['confirm']>();
    const timeConstraintCommandService: DsvTimeConstraintCommandService = {
      clear: vi.fn(),
      confirm: confirmTimeConstraint,
    };
    const { app } = await createHarness({
      adminScopes: dsvOperatorScopes,
      orderMessageService,
      storeReviewAccess,
      timeConstraintCommandService,
    });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const message = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: { audience: 'DRIVER', body: '운행 전 확인', commandId: 'message-command-1' },
        url: `/api/dsv/v1/seller-orders/${protectedOrderId}/messages`,
      });
      expect(message.statusCode).toBe(403);
      expect(createOrderMessage).not.toHaveBeenCalled();

      const confirm = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-confirm',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'UNASSIGNED',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: `/api/dsv/v1/seller-orders/${protectedOrderId}/time-constraint/confirm`,
      });
      expect(confirm.statusCode).toBe(403);
      expect(confirmTimeConstraint).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('blocks operator dispatch changes through order and change-request ids', async () => {
    const protectedOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const protectedChangeRequestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const storeReviewAccess = createStoreReviewAccess((principal, resources) => {
      if (
        resources.orderIds?.includes(protectedOrderId) === true
        || resources.changeRequestIds?.includes(protectedChangeRequestId) === true
      ) {
        return Promise.reject(new DsvForbiddenError({ principal, requiredScopes: ['dsv:accounts:read'] }));
      }
      return Promise.resolve();
    });
    const cancelDispatchChange = vi.fn<DsvDispatchChangeRequestService['cancel']>();
    const recoverDispatch = vi.fn<DsvDispatchChangeRequestService['recoverCancelledToUnassigned']>();
    const requestActiveRemoval = vi.fn<DsvDispatchChangeRequestService['requestActiveRemoval']>();
    const dispatchChangeRequestService: DsvDispatchChangeRequestService = {
      cancel: cancelDispatchChange,
      recoverCancelledToUnassigned: recoverDispatch,
      requestActiveRemoval,
    };
    const { app } = await createHarness({
      adminScopes: dsvOperatorScopes,
      dispatchChangeRequestService,
      storeReviewAccess,
    });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const activeRemoval = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'remove-command',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'route-version-1',
        },
        url: `/api/dsv/v1/seller-orders/${protectedOrderId}/active-removal/request`,
      });
      expect(activeRemoval.statusCode).toBe(403);

      const recovery = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: { commandId: 'recover-command' },
        url: `/api/dsv/v1/seller-orders/${protectedOrderId}/recover-unassigned`,
      });
      expect(recovery.statusCode).toBe(403);

      const cancellation = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: { commandId: 'cancel-command', expectedVersion: 'PENDING_ACK' },
        url: `/api/dsv/v1/dispatch-change-requests/${protectedChangeRequestId}/cancel`,
      });
      expect(cancellation.statusCode).toBe(403);
      expect(requestActiveRemoval).not.toHaveBeenCalled();
      expect(recoverDispatch).not.toHaveBeenCalled();
      expect(cancelDispatchChange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('exposes strict DSV v1 time constraint confirm and clear commands', async () => {
    const timeConstraintCommandService = {
      clear: vi.fn(() => Promise.resolve(timeConstraintCommandResult('CLEARED'))),
      confirm: vi.fn(() => Promise.resolve(timeConstraintCommandResult('CONFIRMED'))),
    };
    const { app } = await createHarness({ timeConstraintCommandService });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const missingCsrf = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'POST',
        payload: {
          commandId: 'cmd-confirm',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'UNASSIGNED',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(missingCsrf.statusCode).toBe(403);

      const invalidExtraField = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-confirm',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'UNASSIGNED',
          sourceNote: '오전 11시 배송',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(invalidExtraField.statusCode).toBe(400);

      const confirmed = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-confirm',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'UNASSIGNED',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(confirmed.statusCode).toBe(200);
      expectDsvV1Envelope(confirmed, timeConstraintCommandResult('CONFIRMED'));
      expect(timeConstraintCommandService.confirm).toHaveBeenCalledWith(expect.objectContaining({
        commandId: 'cmd-confirm',
        deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedVersion: 'UNASSIGNED',
        sellerOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        shopDomain: 'tomatonofood.com',
        timeWindowEnd: '11:00',
        timeWindowStart: '10:30',
      }));

      timeConstraintCommandService.confirm.mockRejectedValueOnce(
        new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED'),
      );
      const reassigned = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-reassigned',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(reassigned.statusCode).toBe(409);
      expectDsvV1Error(reassigned, {
        code: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
        message: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
      });

      const cleared = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-clear',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: 'UNASSIGNED',
          reason: 'reviewed',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/clear',
      });
      expect(cleared.statusCode).toBe(200);
      expectDsvV1Envelope(cleared, timeConstraintCommandResult('CLEARED'));
      expect(timeConstraintCommandService.clear).toHaveBeenCalledWith(expect.objectContaining({
        commandId: 'cmd-clear',
        reason: 'reviewed',
      }));
    } finally {
      await app.close();
    }
  });

  test('passes missing and JSON-null v1 time constraint expectedVersion to the service as 409 conflicts', async () => {
    const timeConstraintCommandService = {
      clear: vi.fn<DsvTimeConstraintCommandService['clear']>(() => Promise.reject(new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED'))),
      confirm: vi.fn<DsvTimeConstraintCommandService['confirm']>(() => Promise.reject(new DsvTimeConstraintCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED'))),
    };
    const { app } = await createHarness({ timeConstraintCommandService });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const missing = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-missing-version',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(missing.statusCode).toBe(409);
      expectDsvV1Error(missing, {
        code: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
        message: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
      });
      expect(timeConstraintCommandService.confirm.mock.calls[0]?.[0]?.commandId).toBe('cmd-missing-version');
      expect(timeConstraintCommandService.confirm.mock.calls[0]?.[0]?.expectedVersion).toBeUndefined();

      const jsonNull = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-null-version',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: null,
          reason: 'reviewed',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/clear',
      });
      expect(jsonNull.statusCode).toBe(409);
      expectDsvV1Error(jsonNull, {
        code: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
        message: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
      });
      expect(timeConstraintCommandService.clear).toHaveBeenCalledWith(expect.objectContaining({
        commandId: 'cmd-null-version',
        expectedVersion: null,
      }));
    } finally {
      await app.close();
    }
  });

  test('rejects malformed v1 time constraint expectedVersion values before calling the service', async () => {
    const timeConstraintCommandService = {
      clear: vi.fn<DsvTimeConstraintCommandService['clear']>(() => Promise.resolve(timeConstraintCommandResult('CLEARED'))),
      confirm: vi.fn<DsvTimeConstraintCommandService['confirm']>(() => Promise.resolve(timeConstraintCommandResult('CONFIRMED'))),
    };
    const { app } = await createHarness({ timeConstraintCommandService });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const malformedConfirm = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-malformed-confirm',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: { value: 'UNASSIGNED' },
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/confirm',
      });
      expect(malformedConfirm.statusCode).toBe(400);

      const malformedClear = await app.inject({
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: {
          commandId: 'cmd-malformed-clear',
          deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          expectedVersion: { value: 'UNASSIGNED' },
          reason: 'reviewed',
        },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/time-constraint/clear',
      });
      expect(malformedClear.statusCode).toBe(400);
      expect(timeConstraintCommandService.confirm).not.toHaveBeenCalled();
      expect(timeConstraintCommandService.clear).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps order message idempotency payload mismatch to a stable 409 response', async () => {
    const orderMessageService: DsvOrderMessageService = {
      create: vi.fn().mockRejectedValue(new DsvOrderMessageError('IDEMPOTENCY_PAYLOAD_MISMATCH')),
      listCustomerMessages: vi.fn(),
      markDriverMessageRead: vi.fn(),
      updateCustomerNotificationSettings: vi.fn(),
    };
    const { app } = await createHarness({ orderMessageService });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
        method: 'POST',
        payload: { audience: 'DRIVER', body: '운행 전 확인', commandId: 'message-command-1' },
        url: '/api/dsv/v1/seller-orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/messages',
      });

      expect(response.statusCode).toBe(409);
      expectDsvV1Error(response, {
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      });
    } finally {
      await app.close();
    }
  });

  test('enforces admin-only management endpoints and customer-only inquiry without /resources path', async () => {
    const { app, queryService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      for (const path of [
        '/dispatches',
        '/control',
        '/records',
        '/drivers',
        '/vehicles',
        `/vehicles/${shopId}/temperature-history`,
        `/vehicles/${shopId}/gps-trail-history`,
        '/customers',
        '/destinations',
        '/conditions',
      ]) {
        const response = await app.inject({
          headers: { cookie: customer.cookie },
          method: 'GET',
          url: `/api/dsv/v1${path}`,
        });
        expect(response.statusCode, path).toBe(403);
      }

      const customerMapProfile = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/map/profile',
      });
      expect(customerMapProfile.statusCode).toBe(200);
      expectDsvV1Envelope(customerMapProfile, dsvMapProfile());

      const noResources = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/resources',
      });
      expect(noResources.statusCode).toBe(404);

      const adminInquiry = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries',
      });
      expect(adminInquiry.statusCode).toBe(403);

      const adminCustomerInquiry = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/customers/deliveries?customerId=${customerId}&serviceDate=2026-07-23`,
      });
      expect(adminCustomerInquiry.statusCode).toBe(200);
      expect(queryService.listCustomerDeliveriesForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN', shopId }),
        customerId,
        { customerId, serviceDate: '2026-07-23' },
      );

      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [
          {
            deliveryStatus: 'PENDING',
            destinationDisplayName: 'Shared Destination X',
            destinationId: 'destination-shared',
            etaStatus: 'READY',
            eventRows: [],
            proofRows: [],
            sellerOrderId: 'order-a',
            sellerOrderKey: 'SO-A',
            shippedBoxes: 6,
          },
          {
            deliveryStatus: 'DELIVERED',
            destinationDisplayName: 'Shared Destination X',
            destinationId: 'destination-shared',
            etaStatus: 'READY',
            eventRows: [{ eventType: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' }],
            proofRows: [],
            sellerOrderId: 'order-b',
            sellerOrderKey: 'SO-B',
            shippedBoxes: 4,
          },
        ],
        page: { hasMore: false },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      const customerInquiry = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?window=today&limit=10',
      });
      expect(customerInquiry.statusCode).toBe(200);
      expectDsvV1Envelope(customerInquiry, {
        items: [
          {
            deliveryStatus: 'PENDING',
            destinationDisplayName: 'Shared Destination X',
            destinationId: 'destination-shared',
            etaStatus: 'READY',
            eventSummary: [],
            proofStatus: 'NONE',
            sellerOrderId: 'order-a',
            sellerOrderKey: 'SO-A',
            shippedBoxes: 6,
          },
          {
            deliveryStatus: 'DELIVERED',
            destinationDisplayName: 'Shared Destination X',
            destinationId: 'destination-shared',
            etaStatus: 'READY',
            eventSummary: [{ type: 'STOP_DELIVERED', occurredAt: '2026-07-23T03:00:00.000Z' }],
            proofStatus: 'NONE',
            sellerOrderId: 'order-b',
            sellerOrderKey: 'SO-B',
            shippedBoxes: 4,
          },
        ],
        page: { hasMore: false },
        routes: [],
      });
      expect(queryService.listCustomerDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({ customerId, principalType: 'CUSTOMER_USER', shopId }),
        { limit: 10, window: 'today' },
      );

      const overrideAttempt = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: `/api/dsv/v1/customer/deliveries?customerId=${customerId}`,
      });
      expect(overrideAttempt.statusCode).toBe(400);
      expectDsvV1Error(overrideAttempt, { code: 'BAD_REQUEST', message: 'Unsupported query parameter' });
    } finally {
      await app.close();
    }
  });

  test('returns vehicle temperature history with control read scope and parsed ISO window', async () => {
    const { app, queryService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const vehicleId = '77777777-7777-4777-8777-777777777777';
    queryService.listVehicleTemperatureHistory.mockResolvedValueOnce({
      samples: [{
        observedAt: '2026-08-04T01:16:00.000Z',
        temperatureA: -18.5,
        temperatureB: null,
      }],
      vehicleId,
    });
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/vehicles/${vehicleId}/temperature-history?from=2026-08-04T00%3A00%3A00.000Z&to=2026-08-04T02%3A00%3A00.000Z&limit=12`,
      });

      expect(response.statusCode).toBe(200);
      expectDsvV1Envelope(response, {
        samples: [{
          observedAt: '2026-08-04T01:16:00.000Z',
          temperatureA: -18.5,
          temperatureB: null,
        }],
        vehicleId,
      });
      expect(queryService.listVehicleTemperatureHistory).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN', shopId }),
        {
          from: new Date('2026-08-04T00:00:00.000Z'),
          limit: 12,
          to: new Date('2026-08-04T02:00:00.000Z'),
          vehicleId,
        },
      );

      const invalid = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/vehicles/${vehicleId}/temperature-history?limit=289`,
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  test('returns vehicle GPS trail history with control read scope and parsed service date', async () => {
    const { app, queryService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const vehicleId = '77777777-7777-4777-8777-777777777777';
    queryService.listVehicleGpsTrailHistory.mockResolvedValueOnce({
      serviceDate: '2026-08-04',
      sessions: [{
        completedAt: '2026-08-04T02:00:00.000Z',
        completionEventId: 'event-complete',
        endpoint: { endedAt: '2026-08-04T02:15:00.000Z', reason: 'DEPOT_RETURNED' },
        restart: null,
        routePlanId: 'route-a',
        segments: [{
          roadMatchedGeometry: {
            anchors: [
              { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-04T01:16:00.000Z' },
            ],
            coordinates: [[[127, 37.5], [127.001, 37.501]]],
            type: 'MultiLineString',
          },
          samples: [{
            distanceTodayKm: 12.4,
            ignitionOn: true,
            latitude: 37.5,
            longitude: 127,
            observedAt: '2026-08-04T01:16:00.000Z',
            speedKph: 30,
          }],
        }],
        sessionIndex: 0,
        startedAt: '2026-08-04T00:30:00.000Z',
        startEventId: 'event-start',
        startSource: 'ROUTE_STARTED',
      }],
      timezone: 'Asia/Seoul',
      vehicleId,
    });
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/vehicles/${vehicleId}/gps-trail-history?serviceDate=2026-08-04`,
      });

      expect(response.statusCode).toBe(200);
      expectDsvV1Envelope(response, {
        serviceDate: '2026-08-04',
        sessions: [{
          completedAt: '2026-08-04T02:00:00.000Z',
          completionEventId: 'event-complete',
          endpoint: { endedAt: '2026-08-04T02:15:00.000Z', reason: 'DEPOT_RETURNED' },
          restart: null,
          routePlanId: 'route-a',
          segments: [{
            roadMatchedGeometry: {
              anchors: [
                { coordinateIndex: 0, lineIndex: 0, observedAt: '2026-08-04T01:16:00.000Z' },
              ],
              coordinates: [[[127, 37.5], [127.001, 37.501]]],
              type: 'MultiLineString',
            },
            samples: [{
              distanceTodayKm: 12.4,
              ignitionOn: true,
              latitude: 37.5,
              longitude: 127,
              observedAt: '2026-08-04T01:16:00.000Z',
              speedKph: 30,
            }],
          }],
          sessionIndex: 0,
          startedAt: '2026-08-04T00:30:00.000Z',
          startEventId: 'event-start',
          startSource: 'ROUTE_STARTED',
        }],
        timezone: 'Asia/Seoul',
        vehicleId,
      });
      expect(queryService.listVehicleGpsTrailHistory).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: 'DSV_ADMIN', shopId }),
        { serviceDate: '2026-08-04', vehicleId },
      );

      const invalid = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: `/api/dsv/v1/vehicles/${vehicleId}/gps-trail-history?serviceDate=2026-8-4`,
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  test('returns route geometry from a vehicle before the first customer stop without route or stop metadata', async () => {
    const { app, queryService, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [
          customerDeliveryRow({
            customerDisplayName: 'Tomato Customer',
            routePlanId: 'route-plan-1',
            sellerOrderId: 'order-customer-first',
            sellerOrderKey: 'SO-C1',
            vehicleId: 'vehicle-1',
            vehicleLatitude: 37.5,
            vehicleLongitude: 126.905,
          }),
        ],
        page: { hasMore: true, nextCursor: 'next-customer-page' },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        {
          routePlanId: 'route-plan-1',
          sellerOrderId: 'order-customer-first',
          vehicleId: 'vehicle-1',
          vehicleLatitude: 37.5,
          vehicleLongitude: 126.905,
        },
        {
          routePlanId: 'route-plan-1',
          sellerOrderId: 'order-customer-last',
          vehicleId: 'vehicle-1',
          vehicleLatitude: 37.5,
          vehicleLongitude: 126.905,
        },
      ]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: {
          coordinates: [[126.9, 37.5], [126.91, 37.5], [126.92, 37.5], [126.93, 37.5], [126.94, 37.5]],
          type: 'LineString',
        },
        routeStopPoints: [
          routeStopPoint({ deliveryStopId: 'other-before-stop', sequence: 1, shopifyOrderGid: 'other-before', snappedCoordinates: [126.91, 37.5] }),
          routeStopPoint({ deliveryStopId: 'customer-first-stop', sequence: 2, shopifyOrderGid: 'order-customer-first', snappedCoordinates: [126.92, 37.5] }),
          routeStopPoint({ deliveryStopId: 'customer-last-stop', sequence: 3, shopifyOrderGid: 'order-customer-last', snappedCoordinates: [126.93, 37.5] }),
          routeStopPoint({ deliveryStopId: 'other-after-stop', sequence: 4, shopifyOrderGid: 'other-after', snappedCoordinates: [126.94, 37.5] }),
        ],
        stops: [
          routeDetailStop({ deliveryStopId: 'other-before-stop', orderId: 'other-before', orderName: 'OTHER-BEFORE', sequence: 1 }),
          routeDetailStop({ deliveryStopId: 'customer-first-stop', orderId: 'order-customer-first', orderName: 'SO-C1', sequence: 2 }),
          routeDetailStop({ deliveryStopId: 'customer-last-stop', orderId: 'order-customer-last', orderName: 'SO-C2', sequence: 3 }),
          routeDetailStop({ deliveryStopId: 'other-after-stop', orderId: 'other-after', orderName: 'OTHER-AFTER', sequence: 4 }),
        ],
      }));

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      const body = expectDsvV1Metadata(response);
      expect(body.data).toMatchObject({
        customerDisplayName: 'Tomato Customer',
        departureLocation: { latitude: 37.5, longitude: 126.9 },
        routes: [{
          coordinates: [[126.905, 37.5], [126.91, 37.5], [126.92, 37.5], [126.93, 37.5]],
          vehicleId: 'vehicle-1',
        }],
      });
      expect(routePlanService.getRoutePlanDetail).toHaveBeenCalledWith({
        appId: 'clever',
        routePlanId: 'route-plan-1',
        shopDomain: 'tomatonofood.com',
      });
      expect(queryService.listCustomerRouteScope).toHaveBeenCalledWith(
        expect.objectContaining({ customerId, principalType: 'CUSTOMER_USER', shopId }),
        '2026-07-23',
      );
      const serialized = JSON.stringify(body.data);
      expect(serialized).not.toContain('route-plan-1');
      expect(serialized).not.toContain('other-before');
      expect(serialized).not.toContain('other-after');
      expect(serialized).not.toContain('other-before-stop');
      expect(serialized).not.toContain('other-after-stop');
      expect(serialized).not.toContain('126.94');
      expect(serialized).not.toContain('shopifyOrderGid');
      expect(serialized).not.toContain('deliveryStopId');
    } finally {
      await app.close();
    }
  });

  test('returns the current-day customer trail only for the scoped route plan and prefers confident road-matched lines', async () => {
    const { app, queryService, routeGeometryProvider, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [customerDeliveryRow({ routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-first', vehicleId: 'vehicle-1' })],
        page: { hasMore: false },
        serviceDate: '2026-08-09',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-first', vehicleId: 'vehicle-1', vehicleLatitude: 37.5, vehicleLongitude: 126.92 },
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-last', vehicleId: 'vehicle-1', vehicleLatitude: 37.5, vehicleLongitude: 126.92 },
      ]);
      queryService.listCustomerGpsTrailHistories.mockResolvedValueOnce([{
        serviceDate: '2026-08-09',
        sessions: [{
          completedAt: null,
          completionEventId: null,
          endpoint: { endedAt: '2026-08-09T01:02:00.000Z', reason: 'LAST_VALID_SAMPLE' },
          restart: null,
          routePlanId: 'route-plan-1',
          segments: [{
            roadMatchedGeometry: {
              coordinates: [
                [[126.905, 37.5], [126.915, 37.5]],
                [[126.918, 37.5], [126.94, 37.5]],
              ],
              type: 'MultiLineString',
            },
            samples: [
              { distanceTodayKm: null, ignitionOn: true, latitude: 37.5, longitude: 126.9, observedAt: '2026-08-09T01:00:00.000Z', speedKph: 10 },
              { distanceTodayKm: null, ignitionOn: true, latitude: 37.5, longitude: 126.91, observedAt: '2026-08-09T01:01:00.000Z', speedKph: 10 },
              { distanceTodayKm: null, ignitionOn: true, latitude: 37.5, longitude: 126.92, observedAt: '2026-08-09T01:02:00.000Z', speedKph: 10 },
            ],
            trailMarker: { kind: 'START', latitude: 37.5, longitude: 126.9, observedAt: '2026-08-09T01:00:00.000Z' },
          }],
          sessionIndex: 0,
          startedAt: '2026-08-09T01:00:00.000Z',
          startEventId: 'start-1',
          startSource: 'ROUTE_STARTED',
        }],
        timezone: 'Asia/Seoul',
        vehicleId: 'vehicle-1',
      }]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: null,
        routeStopPoints: [
          routeStopPoint({ deliveryStopId: 'customer-first-stop', sequence: 1, shopifyOrderGid: 'order-customer-first', snappedCoordinates: [126.91, 37.5] }),
          routeStopPoint({ deliveryStopId: 'customer-last-stop', sequence: 2, shopifyOrderGid: 'order-customer-last', snappedCoordinates: [126.93, 37.5] }),
        ],
        stops: [
          routeDetailStop({ deliveryStopId: 'customer-first-stop', orderId: 'order-customer-first', sequence: 1 }),
          routeDetailStop({ deliveryStopId: 'customer-last-stop', orderId: 'order-customer-last', sequence: 2 }),
        ],
      }));
      routeGeometryProvider.buildRoute.mockRejectedValueOnce(new Error('OSRM unavailable'));

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?includeGpsTrails=true&serviceDate=2026-08-09',
      });

      expect(response.statusCode).toBe(200);
      expect(expectDsvV1Metadata(response).data).toMatchObject({
        routes: [],
        trails: [{
          segments: [
            { coordinates: [[126.91, 37.5], [126.915, 37.5]] },
            { coordinates: [[126.918, 37.5], [126.93, 37.5]] },
          ],
          vehicleId: 'vehicle-1',
        }],
      });
      const serialized = JSON.stringify(expectDsvV1Metadata(response).data);
      expect(serialized).not.toContain('126.905');
      expect(serialized).not.toContain('126.94');
      expect(serialized).not.toContain('126.9,37.5');
      expect(queryService.listCustomerGpsTrailHistories).toHaveBeenCalledWith(
        expect.objectContaining({ customerId, principalType: 'CUSTOMER_USER', shopId }),
        '2026-08-09',
        expect.arrayContaining([expect.objectContaining({ routePlanId: 'route-plan-1' })]),
      );
      expect(JSON.stringify(expectDsvV1Metadata(response).data)).not.toContain('route-plan-1');
    } finally {
      await app.close();
    }
  });

  test('falls back customer-scoped route geometry to depot when assigned vehicle has no live position', async () => {
    const { app, queryService, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [
          customerDeliveryRow({
            customerDisplayName: 'Tomato Customer',
            routePlanId: 'route-plan-1',
            sellerOrderId: 'order-customer-first',
            sellerOrderKey: 'SO-C1',
            vehicleId: 'vehicle-1',
            vehicleLatitude: null,
            vehicleLongitude: null,
          }),
        ],
        page: { hasMore: false },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        {
          routePlanId: 'route-plan-1',
          sellerOrderId: 'order-customer-first',
          vehicleId: 'vehicle-1',
          vehicleLatitude: null,
          vehicleLongitude: null,
        },
        {
          routePlanId: 'route-plan-1',
          sellerOrderId: 'order-customer-last',
          vehicleId: 'vehicle-1',
          vehicleLatitude: null,
          vehicleLongitude: null,
        },
      ]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: {
          coordinates: [[126.9, 37.5], [126.91, 37.5], [126.92, 37.5], [126.93, 37.5], [126.94, 37.5]],
          type: 'LineString',
        },
        routeStopPoints: [
          routeStopPoint({ deliveryStopId: 'other-before-stop', sequence: 1, shopifyOrderGid: 'other-before', snappedCoordinates: [126.905, 37.5] }),
          routeStopPoint({ deliveryStopId: 'customer-first-stop', sequence: 2, shopifyOrderGid: 'order-customer-first', snappedCoordinates: [126.91, 37.5] }),
          routeStopPoint({ deliveryStopId: 'customer-last-stop', sequence: 3, shopifyOrderGid: 'order-customer-last', snappedCoordinates: [126.92, 37.5] }),
          routeStopPoint({ deliveryStopId: 'other-after-stop', sequence: 4, shopifyOrderGid: 'other-after', snappedCoordinates: [126.94, 37.5] }),
        ],
        stops: [
          routeDetailStop({ deliveryStopId: 'other-before-stop', orderId: 'other-before', orderName: 'OTHER-BEFORE', sequence: 1 }),
          routeDetailStop({ deliveryStopId: 'customer-first-stop', orderId: 'order-customer-first', orderName: 'SO-C1', sequence: 2 }),
          routeDetailStop({ deliveryStopId: 'customer-last-stop', orderId: 'order-customer-last', orderName: 'SO-C2', sequence: 3 }),
          routeDetailStop({ deliveryStopId: 'other-after-stop', orderId: 'other-after', orderName: 'OTHER-AFTER', sequence: 4 }),
        ],
      }));

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      const body = expectDsvV1Metadata(response);
      expect(body.data).toMatchObject({
        customerDisplayName: 'Tomato Customer',
        departureLocation: { latitude: 37.5, longitude: 126.9 },
        routes: [{
          coordinates: [[126.9, 37.5], [126.91, 37.5], [126.92, 37.5]],
          vehicleId: 'vehicle-1',
        }],
      });
      const serialized = JSON.stringify(body.data);
      expect(serialized).not.toContain('route-plan-1');
      expect(serialized).not.toContain('other-before');
      expect(serialized).not.toContain('other-before-stop');
      expect(serialized).not.toContain('other-after');
      expect(serialized).not.toContain('other-after-stop');
      expect(serialized).not.toContain('126.94');
      expect(serialized).not.toContain('shopifyOrderGid');
      expect(serialized).not.toContain('deliveryStopId');
    } finally {
      await app.close();
    }
  });

  test('rebuilds a missing customer route through OSRM in the existing stop order', async () => {
    const { app, queryService, routeGeometryProvider, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [customerDeliveryRow({ routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-first', vehicleId: 'vehicle-1' })],
        page: { hasMore: false },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-first', vehicleId: 'vehicle-1', vehicleLatitude: null, vehicleLongitude: null },
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer-last', vehicleId: 'vehicle-1', vehicleLatitude: null, vehicleLongitude: null },
      ]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: null,
        stops: [
          routeDetailStop({ deliveryStopId: 'other-stop', orderId: 'other-order', sequence: 1 }),
          routeDetailStop({ coordinates: { latitude: 37.52, longitude: 126.92 }, deliveryStopId: 'customer-first-stop', orderId: 'order-customer-first', sequence: 2 }),
          routeDetailStop({ coordinates: { latitude: 37.53, longitude: 126.93 }, deliveryStopId: 'customer-last-stop', orderId: 'order-customer-last', sequence: 3 }),
        ],
      }));
      routeGeometryProvider.buildRoute.mockResolvedValueOnce({
        routeGeometry: { coordinates: [[126.9, 37.5], [126.905, 37.51], [126.92, 37.52], [126.93, 37.53]], type: 'LineString' },
        routeMetrics: null,
        routeStopPoints: [],
      });

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      expect(expectDsvV1Metadata(response).data).toMatchObject({
        routes: [{
          coordinates: [[126.9, 37.5], [126.905, 37.51], [126.92, 37.52], [126.93, 37.53]],
          vehicleId: 'vehicle-1',
        }],
      });
      expect(routeGeometryProvider.buildRoute).toHaveBeenCalledOnce();
      const scopedDetail = routeGeometryProvider.buildRoute.mock.calls[0]?.[0];
      expect(scopedDetail?.routePlan.depot).toEqual({ latitude: 37.5, longitude: 126.9 });
      expect(scopedDetail?.routePlan.routeEndMode).toBe('END_AT_LAST_STOP');
      expect(scopedDetail?.stops.map((stop) => stop.orderId)).toEqual(['order-customer-first', 'order-customer-last']);
    } finally {
      await app.close();
    }
  });

  test('rebuilds through OSRM when cached geometry cannot be cut from the live vehicle position', async () => {
    const { app, queryService, routeGeometryProvider, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [customerDeliveryRow({ routePlanId: 'route-plan-1', sellerOrderId: 'order-customer', vehicleId: 'vehicle-1' })],
        page: { hasMore: false },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer', vehicleId: 'vehicle-1', vehicleLatitude: 37.6, vehicleLongitude: 127.1 },
      ]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: { coordinates: [[126.9, 37.5], [126.92, 37.52]], type: 'LineString' },
        stops: [routeDetailStop({ coordinates: { latitude: 37.52, longitude: 126.92 }, orderId: 'order-customer' })],
      }));
      routeGeometryProvider.buildRoute.mockResolvedValueOnce({
        routeGeometry: { coordinates: [[127.1, 37.6], [127, 37.56], [126.92, 37.52]], type: 'LineString' },
        routeMetrics: null,
        routeStopPoints: [],
      });

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      expect(expectDsvV1Metadata(response).data).toMatchObject({
        routes: [{ coordinates: [[127.1, 37.6], [127, 37.56], [126.92, 37.52]], vehicleId: 'vehicle-1' }],
      });
      expect(routeGeometryProvider.buildRoute.mock.calls[0]?.[0].routePlan.depot).toEqual({ latitude: 37.6, longitude: 127.1 });
    } finally {
      await app.close();
    }
  });

  test('does not synthesize a straight customer route when OSRM regeneration fails', async () => {
    const { app, queryService, routeGeometryProvider, routePlanService } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listCustomerDeliveries.mockResolvedValueOnce({
        items: [customerDeliveryRow({ routePlanId: 'route-plan-1', sellerOrderId: 'order-customer', vehicleId: 'vehicle-1' })],
        page: { hasMore: false },
        serviceDate: '2026-07-23',
        timezone: 'Asia/Seoul',
      });
      queryService.listCustomerRouteScope.mockResolvedValueOnce([
        { routePlanId: 'route-plan-1', sellerOrderId: 'order-customer', vehicleId: 'vehicle-1', vehicleLatitude: null, vehicleLongitude: null },
      ]);
      routePlanService.getRoutePlanDetail.mockResolvedValueOnce(routePlanDetail({
        routeGeometry: null,
        stops: [routeDetailStop({ orderId: 'order-customer' })],
      }));
      routeGeometryProvider.buildRoute.mockRejectedValueOnce(new Error('OSRM unavailable'));

      const response = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      expect(expectDsvV1Metadata(response).data).toMatchObject({ routes: [] });
      expect(routeGeometryProvider.buildRoute).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('maps typed query cursor, service date window, and timezone errors to v1 error envelopes', async () => {
    const { app, queryService } = await createHarness();
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      queryService.listDrivers.mockRejectedValueOnce(new DsvV1ReadQueryError(
        'BAD_REQUEST',
        'cursor is invalid.',
        { field: 'cursor', internal: { sql: 'select * from private_table' } },
      ));
      const invalidCursor = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/drivers?cursor=not-a-query-cursor',
      });
      expect(invalidCursor.statusCode).toBe(400);
      expectDsvV1Error(invalidCursor, {
        code: 'BAD_REQUEST',
        details: { field: 'cursor' },
        message: 'cursor is invalid.',
      });
      expect(JSON.stringify(invalidCursor.json())).not.toContain('private_table');

      queryService.listDispatches.mockRejectedValueOnce(new DsvV1ReadQueryError(
        'BAD_REQUEST',
        'cursor does not match the requested filters.',
      ));
      const mismatchedCursor = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/dispatches?serviceDate=2026-07-23&cursor=other-filter-cursor',
      });
      expect(mismatchedCursor.statusCode).toBe(400);
      expectDsvV1Error(mismatchedCursor, {
        code: 'BAD_REQUEST',
        message: 'cursor does not match the requested filters.',
      });

      queryService.listCustomerDeliveries.mockRejectedValueOnce(new DsvV1ReadQueryError(
        'BAD_REQUEST',
        'window and serviceDate resolve to different service dates.',
        { resolvedServiceDate: '2026-07-24', serviceDate: '2026-07-23', window: 'tomorrow' },
      ));
      const windowMismatch = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'GET',
        url: '/api/dsv/v1/customer/deliveries?serviceDate=2026-07-23&window=tomorrow',
      });
      expect(windowMismatch.statusCode).toBe(400);
      expectDsvV1Error(windowMismatch, {
        code: 'BAD_REQUEST',
        details: { resolvedServiceDate: '2026-07-24', serviceDate: '2026-07-23', window: 'tomorrow' },
        message: 'window and serviceDate resolve to different service dates.',
      });

      queryService.listControl.mockRejectedValueOnce(new DsvV1ReadQueryError(
        'DEPENDENCY_UNAVAILABLE',
        'Active commerce connection has invalid timezone.',
        { timezone: 'Invalid/Zone' },
      ));
      const timezoneDependency = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/control?serviceDate=2026-07-23',
      });
      expect(timezoneDependency.statusCode).toBe(503);
      expectDsvV1Error(timezoneDependency, {
        code: 'DEPENDENCY_UNAVAILABLE',
        details: { timezone: 'Invalid/Zone' },
        message: 'Active commerce connection has invalid timezone.',
      });
    } finally {
      await app.close();
    }
  });

  test('fails closed when DSV map profile is not configured', async () => {
    const { app } = await createHarness({ mapProfile: false });
    const admin = signedCookie('dsv-shop:tomatonofood.com');
    try {
      const response = await app.inject({
        headers: { cookie: admin.cookie },
        method: 'GET',
        url: '/api/dsv/v1/map/profile',
      });
      expect(response.statusCode).toBe(503);
      expectDsvV1Error(response, {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'DSV map profile is not configured',
      });
    } finally {
      await app.close();
    }
  });

  test('logout requires CSRF, invalidates the server session, and clears only the configured DSV cookie', async () => {
    const { app, sessionResolver } = await createHarness();
    const customer = signedCookie(`dsv-customer-account:${accountId}:1`);
    try {
      const missingCsrf = await app.inject({
        headers: { cookie: customer.cookie },
        method: 'POST',
        url: '/api/dsv/v1/session/logout',
      });
      expect(missingCsrf.statusCode).toBe(403);

      const logout = await app.inject({
        headers: { cookie: customer.cookie, 'x-csrf-token': customer.csrfToken },
        method: 'POST',
        url: '/api/dsv/v1/session/logout',
      });
      expect(logout.statusCode).toBe(200);
      expectDsvV1Envelope(logout, { ok: true });
      expect(logout.headers['set-cookie']).toContain(`${cookieName}=;`);
      expect(logout.headers['set-cookie']).toContain('Path=/api/dsv/');
      expect(logout.headers['set-cookie']).not.toContain('clever_admin_ui');
      expect(sessionResolver.invalidate).toHaveBeenCalledWith(`dsv-customer-account:${accountId}:1`);
    } finally {
      await app.close();
    }
  });
});

function timeConstraintCommandResult(status: 'CLEARED' | 'CONFIRMED') {
  return {
    auditEventId: `audit-${status.toLowerCase()}`,
    commandId: `cmd-${status.toLowerCase()}`,
    deliveryStopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    rawNote: '오전 11시 배송',
    recalculation: {
      reason: status === 'CLEARED' ? 'TIME_CONSTRAINT_CLEARED' as const : 'UNASSIGNED_ORDER' as const,
      retryable: false,
      routePlanId: null,
      status: 'NOT_REQUIRED' as const,
    },
    reviewStatus: status,
    routeConstraintStatus: status === 'CONFIRMED' ? 'NOT_EVALUATED' as const : 'NOT_APPLICABLE' as const,
    sellerOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sellerOrderKey: '2018330248',
    timeConstraint: status === 'CONFIRMED'
      ? {
          auditEventId: 'audit-confirmed',
          confirmedAt: '2026-08-03T09:50:00.000Z',
          status: 'CONFIRMED' as const,
          timeWindowEnd: '11:00',
          timeWindowStart: '10:30',
        }
      : null,
  };
}

async function createHarness(options: {
  adminScopes?: readonly DsvScope[];
  dispatchChangeRequestService?: DsvDispatchChangeRequestService;
  logger?: BuildAppOptions['logger'];
  mapProfile?: false;
  orderMessageService?: DsvOrderMessageService;
  storeReviewAccess?: DsvV1ReadDependencies['storeReviewAccess'];
  timeConstraintCommandService?: DsvTimeConstraintCommandService;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  queryService: MockQueryService;
  routeGeometryProvider: MockRouteGeometryProvider;
  routePlanService: MockRoutePlanService;
  sessionResolver: MockSessionResolver;
}> {
  const queryService = createQueryService();
  const routeGeometryProvider = createRouteGeometryProvider();
  const routePlanService = createRoutePlanService();
  const sessionResolver = createSessionResolver(options.adminScopes);
  const dependencies: DsvV1ReadDependencies = {
    cookieName,
    ...(options.dispatchChangeRequestService === undefined ? {} : { dispatchChangeRequestService: options.dispatchChangeRequestService }),
    ...(options.mapProfile === false ? {} : { mapProfile: dsvMapProfile() }),
    queryService,
    routeGeometryProvider,
    routePlanService,
    secureCookies: false,
    sessionResolver,
    sessionSecret,
    ...(options.orderMessageService === undefined ? {} : { orderMessageService: options.orderMessageService }),
    storeReviewAccess: options.storeReviewAccess ?? createStoreReviewAccess(() => Promise.resolve()),
    ...(options.timeConstraintCommandService === undefined ? {} : { timeConstraintCommandService: options.timeConstraintCommandService }),
  };
  return {
    app: await buildApp({
      dsvV1Read: dependencies,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    queryService,
    routeGeometryProvider,
    routePlanService,
    sessionResolver,
  };
}

type MockRouteGeometryProvider = {
  buildRoute: ReturnType<typeof vi.fn<RouteGeometryProvider['buildRoute']>>;
};

function createRouteGeometryProvider(): MockRouteGeometryProvider {
  return {
    buildRoute: vi.fn(() => Promise.resolve({ routeGeometry: null, routeMetrics: null, routeStopPoints: [] })),
  };
}

function dsvMapProfile(): NonNullable<DsvV1ReadDependencies['mapProfile']> {
  return {
    attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    bounds: [124.5, 33, 132, 39.5],
    initialView: {
      center: [126.995, 37.43],
      zoom: 10.35,
    },
    profileId: 'dsv-korea-v1',
    providerMode: 'public_allowlisted',
    regionCode: 'KR',
    styleUrl: '/map/styles/dsv-korea-v1.json',
    version: '2026-07',
  };
}

type MockQueryService = {
  [Key in keyof DsvV1ReadQueryService]: ReturnType<typeof vi.fn<DsvV1ReadQueryService[Key]>>;
};

function createQueryService(): MockQueryService {
  const list = { items: [], page: { hasMore: false } };
  return {
    listConditions: vi.fn(() => Promise.resolve(list)),
    listControl: vi.fn(() => Promise.resolve({
      assignedCount: 0,
      failedEtaCount: 0,
      pendingEtaCount: 0,
      readyEtaCount: 0,
      serviceDate: '2026-07-23',
      timezone: 'Asia/Seoul',
      totalDispatchCount: 0,
      unassignedCount: 0,
    })),
    listCustomerDeliveries: vi.fn(() => Promise.resolve({ items: [], page: { hasMore: false }, serviceDate: '2026-07-23', timezone: 'Asia/Seoul' })),
    listCustomerDeliveriesForAdmin: vi.fn(() => Promise.resolve({ items: [], page: { hasMore: false }, serviceDate: '2026-07-23', timezone: 'Asia/Seoul' })),
    listCustomerGpsTrailHistories: vi.fn(() => Promise.resolve([])),
    listCustomerGpsTrailHistoriesForAdmin: vi.fn(() => Promise.resolve([])),
    listCustomerRouteScope: vi.fn(() => Promise.resolve([])),
    listCustomerRouteScopeForAdmin: vi.fn(() => Promise.resolve([])),
    listCustomers: vi.fn(() => Promise.resolve(list)),
    listDestinations: vi.fn(() => Promise.resolve(list)),
    listDispatches: vi.fn(() => Promise.resolve({
      items: [{
        assignmentStatus: 'ASSIGNED',
        customerId: 'customer-a',
        deliveryStopId: 'stop-1',
        destinationId: 'destination-a',
        etaStatus: 'READY',
        eventRows: [
          { eventType: 'STOP_ARRIVED', occurredAt: '2026-07-23T01:00:00.000Z' },
          { eventType: 'STOP_FAILED', occurredAt: '2026-07-23T01:30:00.000Z' },
          { eventType: 'LOCATION_UPDATED', occurredAt: '2026-07-23T01:15:00.000Z' },
        ],
        sellerOrderId: 'order-1',
        sellerOrderKey: 'SO-001',
      }],
      page: { hasMore: false },
    })),
    listDrivers: vi.fn(() => Promise.resolve(list)),
    listRecords: vi.fn(() => Promise.resolve({
      items: [],
      page: { currentPage: 1, hasMore: false, pageSize: 50, totalItems: 0, totalPages: 0 },
    })),
    listVehicleGpsTrailHistory: vi.fn(() => Promise.resolve({ serviceDate: '2026-07-23', sessions: [], timezone: 'Asia/Seoul', vehicleId: 'vehicle-a' })),
    listVehicleTemperatureHistory: vi.fn(() => Promise.resolve({ samples: [], vehicleId: 'vehicle-a' })),
    listVehicles: vi.fn(() => Promise.resolve(list)),
    resolveTenantDates: vi.fn(() => Promise.resolve({
      dayAfterTomorrow: '2026-07-25',
      timezone: 'Asia/Seoul',
      today: '2026-07-23',
      tomorrow: '2026-07-24',
    })),
  };
}

type MockRoutePlanService = {
  getRoutePlanDetail: ReturnType<typeof vi.fn<NonNullable<DsvV1ReadDependencies['routePlanService']>['getRoutePlanDetail']>>;
  listRoutePlans: ReturnType<typeof vi.fn<NonNullable<DsvV1ReadDependencies['routePlanService']>['listRoutePlans']>>;
};

function createRoutePlanService(): MockRoutePlanService {
  return {
    getRoutePlanDetail: vi.fn(() => Promise.resolve(null)),
    listRoutePlans: vi.fn(() => Promise.resolve([])),
  };
}

function routePlanSummary(): RoutePlanSummary {
  return {
    createdAt: '2026-07-23T00:00:00.000Z',
    deliveryAreas: [],
    deliveryDays: [],
    depot: { latitude: 37.5, longitude: 126.9 },
    id: 'route-plan-1',
    missingCoordinates: 0,
    name: '2026-07-23 route',
    planDate: '2026-07-23',
    routeEndMode: 'END_AT_LAST_STOP',
    status: 'PUBLISHED',
    stopsCount: 1,
    updatedAt: '2026-07-23T00:01:00.000Z',
  };
}

function customerDeliveryRow(overrides: Partial<DsvV1CustomerDeliveryInquiryRow> = {}): DsvV1CustomerDeliveryInquiryRow {
  return { ...customerDeliveryDefaults(), ...overrides };
}

function customerDeliveryDefaults(): DsvV1CustomerDeliveryInquiryRow {
  return {
    deliveryStatus: 'PENDING',
    destinationDisplayName: 'Shared Destination X',
    destinationId: 'destination-shared',
    etaStatus: 'READY' as const,
    eventRows: [],
    proofRows: [],
    sellerOrderId: 'order-a',
    sellerOrderKey: 'SO-A',
    shippedBoxes: 1,
  };
}

function routePlanDetail(overrides: Partial<RoutePlanDetail> = {}): RoutePlanDetail {
  return {
    routeGeometry: { coordinates: [[126.9, 37.5], [127, 37.6]], type: 'LineString' },
    routeGeometryGeneratedAt: '2026-07-23T00:01:00.000Z',
    routeGeometryStatus: 'fresh',
    routeMetrics: { distanceMeters: 1000, durationSeconds: 420 },
    routePlan: routePlanSummary(),
    routeStopPoints: [{
      deliveryStopId: 'stop-1',
      durationFromPreviousSeconds: 420,
      inputCoordinates: [127, 37.6],
      name: null,
      sequence: 1,
      shopifyOrderGid: 'order-1',
      snapDistanceMeters: 0,
      snappedCoordinates: [127, 37.6],
    }],
    stops: [],
    ...overrides,
  };
}

function routeStopPoint(overrides: Partial<RoutePlanDetail['routeStopPoints'][number]> = {}): RoutePlanDetail['routeStopPoints'][number] {
  return {
    deliveryStopId: 'stop-1',
    durationFromPreviousSeconds: 420,
    inputCoordinates: [126.92, 37.5],
    name: null,
    sequence: 1,
    shopifyOrderGid: 'order-1',
    snapDistanceMeters: 0,
    snappedCoordinates: [126.92, 37.5],
    ...overrides,
  };
}

function routeDetailStop(overrides: Partial<RoutePlanDetail['stops'][number]> = {}): RoutePlanDetail['stops'][number] {
  return {
    address: {
      address1: null,
      address2: null,
      city: null,
      countryCode: null,
      postalCode: null,
      province: null,
    },
    attributes: [],
    coordinates: { latitude: 37.5, longitude: 126.92 },
    deliveryArea: null,
    deliveryDay: null,
    deliveryStopId: 'stop-1',
    financialStatus: null,
    fulfillmentStatus: null,
    orderId: 'order-1',
    orderName: 'SO-1',
    paymentStatus: null,
    recipientName: null,
    sequence: 1,
    shopifyOrderGid: 'order-1',
    status: 'PENDING',
    ...overrides,
  };
}

type MockSessionResolver = {
  [Key in keyof DsvV1SessionResolver]: ReturnType<typeof vi.fn<DsvV1SessionResolver[Key]>>;
};

function createSessionResolver(adminScopes?: readonly DsvScope[]): MockSessionResolver {
  return {
    invalidate: vi.fn(() => Promise.resolve()),
    resolve: vi.fn((subject) => {
      if (subject === 'dsv-shop:tomatonofood.com') {
        return Promise.resolve(createDsvAdminPrincipal({
          ...(adminScopes === undefined ? {} : { scopes: adminScopes }),
          shopDomain: 'tomatonofood.com',
          shopId,
        }));
      }
      if (subject === `dsv-customer-account:${accountId}:1`) {
        return Promise.resolve(createDsvCustomerUserPrincipalFromAccount({
          account: {
            customerId,
            shopId,
            status: 'ACTIVE',
          },
          shopDomain: 'tomatonofood.com',
        }));
      }
      return Promise.reject(new DsvV1AuthenticationError());
    }),
  };
}

function createStoreReviewAccess(
  implementation: DsvV1ReadDependencies['storeReviewAccess']['assertAccessible'],
): DsvV1ReadDependencies['storeReviewAccess'] {
  return { assertAccessible: vi.fn(implementation) };
}

function signedCookie(subject: string, ttlMs = 60_000): { cookie: string; csrfToken: string } {
  const { cookieHeader, session } = createAdminWebSession({
    cookieName,
    path: '/api/dsv/',
    secure: false,
    sessionSecret,
    subject,
    ttlMs,
  });
  return {
    cookie: cookieHeader.split(';')[0] ?? '',
    csrfToken: session.csrfToken,
  };
}

function dispatchLoadDiagnosticPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: diagnosticAttemptId,
    attemptKind: 'initial',
    durationMs: 42,
    loadId: diagnosticLoadId,
    outcome: 'success',
    serviceDate: '2026-09-08',
    source: 'browser',
    ...overrides,
  };
}

function dispatchLoadAttemptLogs(logLines: readonly string[]): Array<Record<string, unknown>> {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((log) => log.event === 'dsv_dispatch_load_attempt');
}

type JsonResponse = {
  json<Body = unknown>(): Body;
};

type DsvV1EnvelopeBody = {
  data: unknown;
  meta: { apiVersion: 'dsv.v1' };
  requestId: string;
};

type DsvV1ErrorBody = {
  error: {
    code: string;
    details?: Record<string, unknown>;
    message: string;
    requestId: string;
  };
};

function parseJsonBody<Body>(response: JsonResponse): Body {
  return response.json<Body>();
}

function expectDsvV1Envelope(response: JsonResponse, data: unknown): void {
  const body = parseJsonBody<DsvV1EnvelopeBody>(response);
  expect(body.requestId).toEqual(expect.any(String));
  expect(body).toEqual({
    data,
    meta: { apiVersion: 'dsv.v1' },
    requestId: body.requestId,
  });
}

function expectDsvV1Metadata(response: JsonResponse): DsvV1EnvelopeBody {
  const body = parseJsonBody<DsvV1EnvelopeBody>(response);
  expect(body.requestId).toEqual(expect.any(String));
  expect(body).toMatchObject({
    meta: { apiVersion: 'dsv.v1' },
    requestId: body.requestId,
  });
  return body;
}

function expectDsvV1Error(response: JsonResponse, error: Omit<DsvV1ErrorBody['error'], 'requestId'>): void {
  const body = parseJsonBody<DsvV1ErrorBody>(response);
  expect(body.error.requestId).toEqual(expect.any(String));
  expect(body).toEqual({
    error: {
      ...error,
      requestId: body.error.requestId,
    },
  });
}

function expectDsvAdminSessionData(data: unknown): void {
  const record = expectJsonRecord(data);
  expect(Object.keys(record).sort()).toEqual(['actorId', 'csrfToken', 'principalType', 'scopes', 'shopId']);
  expect(record.actorId).toBe('legacy-env-admin');
  expect(record.csrfToken).toEqual(expect.any(String));
  expect(record.principalType).toBe('DSV_ADMIN');
  expect(record.scopes).toEqual(expect.arrayContaining(['dsv:session:read', 'dsv:dispatches:read']));
  expect(record.shopId).toBe(shopId);
}

function expectJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected JSON object');
  }
  return value as Record<string, unknown>;
}
