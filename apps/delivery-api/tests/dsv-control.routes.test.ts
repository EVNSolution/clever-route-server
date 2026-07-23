import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DestinationTipConflictError } from '../src/modules/dsv/dsv-control.repository.js';
import type { DsvControlRepository } from '../src/modules/dsv/dsv-control.repository.js';
import {
  DsvDispatchImportApplyError,
  DsvDispatchImportConflictError,
  DsvDispatchImportValidationError,
  type DsvDispatchImportApplyResult,
  type DsvDispatchImportPreview,
  type DsvDispatchImportService,
} from '../src/modules/dsv/dsv-dispatch-import.service.js';
import { dsvAdminScopes } from '../src/modules/dsv/dsv-principal.js';
import { DsvAssignmentCommandError } from '../src/modules/dsv/dsv-assignment-command.service.js';
import type { DsvAdminAssignmentCommandService, DsvControlDependencies } from '../src/routes/dsv-control.routes.js';
import type { DsvResourceService } from '../src/modules/dsv/dsv-resource.service.js';
import { defaultRouteOpsUiSettings } from '../src/modules/route-ops/route-ops-ui-settings.js';
import { defaultRouteScopeConfig } from '../src/modules/route-ops/route-scope-config.js';
import type { AdminStoreSettings, SaveAdminStoreSettingsInput } from '../src/modules/commerce/admin-store-settings.service.js';

const stopId = '11111111-1111-4111-8111-111111111111';
const destinationId = '22222222-2222-4222-8222-222222222222';
const tipId = '33333333-3333-4333-8333-333333333333';
const shopId = '99999999-9999-4999-8999-999999999999';
const importId = '44444444-4444-4444-8444-444444444444';
const sourceHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const previewHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sellerOrderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const routeVersionId = 'abababab-abab-4aba-8aba-abababababab';
const nextRouteVersionId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
const targetDriverId = '66666666-6666-4666-8666-666666666666';
const targetVehicleId = '77777777-7777-4777-8777-777777777777';
const targetRoutePlanId = '12121212-1212-4121-8121-121212121212';

describe('DSV control routes', () => {
  test('requires a DSV session before returning selected delivery context', async () => {
    const { app, repository } = await createHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'DSV login required' },
      });
      expect(repository.getDeliveryStopContext).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('binds the authenticated session to an allowed shop and returns items with destination tips', async () => {
    const { app, repository } = await createHarness();
    try {
      const login = await loginToDsv(app);
      expect(login.response.statusCode).toBe(200);
      expect(login.response.headers['set-cookie']).toContain('Path=/api/dsv/');
      expect(login.response.json()).toMatchObject({
        data: { shopDomain: 'tomatonofood.com' },
        error: null,
      });

      const response = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        data: {
          deliveryStopId: stopId,
          destination: { destinationId, name: '강남세브란스병원' },
          items: [{ name: '진단키트', quantity: 2 }],
          tips: [{ tipId, title: '후문 이용' }],
        },
        error: null,
      });
      expect(repository.getDeliveryStopContext).toHaveBeenCalledWith({
        deliveryStopId: stopId,
        shopDomain: 'tomatonofood.com',
      });
    } finally {
      await app.close();
    }
  });

  test('DSV_ADMIN legacy session resolves the authenticated shop domain to canonical Shop.id without changing session response', async () => {
    const { app, repository } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: '/api/dsv/auth/session',
      });
      const body = response.json<{
        data: { csrfToken: string; expiresAt: string; shopDomain: string };
        error: null;
      }>();

      expect(response.statusCode).toBe(200);
      expect(body).toEqual({
        data: {
          csrfToken: login.csrfToken,
          expiresAt: body.data.expiresAt,
          shopDomain: 'tomatonofood.com',
        },
        error: null,
      });
      expect(repository.resolveShopId).toHaveBeenCalledWith('tomatonofood.com');
      await expect(repository.resolveShopId.mock.results.at(-1)?.value).resolves.toBe(shopId);
      expect(Number.isNaN(Date.parse(body.data.expiresAt))).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('requires CSRF for tip writes and reports optimistic revision conflicts', async () => {
    const { app, repository } = await createHarness();
    repository.updateDestinationTip.mockRejectedValueOnce(new DestinationTipConflictError(4));
    try {
      const login = await loginToDsv(app);
      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie },
        method: 'POST',
        payload: {
          body: '지하 1층 하역장으로 진입합니다.',
          category: 'access',
          severity: 'warning',
          title: '후문 이용',
        },
        url: `/api/dsv/destinations/${destinationId}/tips`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(repository.createDestinationTip).not.toHaveBeenCalled();

      const conflict = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'PATCH',
        payload: { body: '수정된 내용', revision: 3 },
        url: `/api/dsv/destinations/${destinationId}/tips/${tipId}`,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        data: null,
        error: {
          code: 'TIP_REVISION_CONFLICT',
          details: { currentRevision: 4 },
          message: 'Destination tip was changed by another operator',
        },
      });
    } finally {
      await app.close();
    }
  });

  test('does not reveal a disallowed or missing shop during login', async () => {
    const { app } = await createHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { id: 'operator', password: 'correct-password', shopDomain: 'other.example' },
        url: '/api/dsv/auth/login',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Customer workspace not found' },
      });
    } finally {
      await app.close();
    }
  });

  test('reports an actionable error when the DSV migration is missing', async () => {
    const { app, repository } = await createHarness();
    repository.getDeliveryStopContext.mockRejectedValueOnce({ code: 'P2021' });
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        data: null,
        error: { code: 'DSV_SCHEMA_NOT_READY' },
      });
    } finally {
      await app.close();
    }
  });

  test('reads and updates common operation times with session and CSRF scope', async () => {
    const { app, settingsService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const read = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: '/api/dsv/settings/operations',
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        data: { loadingStartTime: null, plannedDepartureTime: null },
        error: null,
      });

      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie },
        method: 'PATCH',
        payload: { loadingStartTime: '07:40', plannedDepartureTime: '08:20' },
        url: '/api/dsv/settings/operations',
      });
      expect(missingCsrf.statusCode).toBe(403);

      const update = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'PATCH',
        payload: { loadingStartTime: '07:40', plannedDepartureTime: '08:20' },
        url: '/api/dsv/settings/operations',
      });
      expect(update.statusCode).toBe(200);
      const savedInput = settingsService.saveSettings.mock.calls[0]?.[0];
      expect(savedInput?.routeOpsUiSettings).toMatchObject({
        loadingStartTime: '07:40',
        plannedDepartureTime: '08:20',
      });
      expect(savedInput?.shopDomain).toBe('tomatonofood.com');

      const invalid = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'PATCH',
        payload: { plannedDepartureTime: '25:00' },
        url: '/api/dsv/settings/operations',
      });
      expect(invalid.statusCode).toBe(400);
      expect(settingsService.saveSettings).toHaveBeenCalledTimes(1);

      const unsupported = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'PATCH',
        payload: { plannedDepartureTime: '08:30', timeZone: 'Asia/Seoul' },
        url: '/api/dsv/settings/operations',
      });
      expect(unsupported.statusCode).toBe(400);
      expect(settingsService.saveSettings).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test('previews and commits a validated dispatch import within the DSV session scope', async () => {
    const { app, dispatchImportService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const payload = dispatchPayload();
      const preview = await app.inject({
        headers: { cookie: login.cookie },
        method: 'POST',
        payload,
        url: '/api/dsv/dispatch-imports/preview',
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ data: { canCommit: true, summary: { totalRows: 1 } }, error: null });
      expect(dispatchImportService.preview).toHaveBeenCalledWith({ ...payload, shopDomain: 'tomatonofood.com' });

      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie },
        method: 'POST',
        payload,
        url: '/api/dsv/dispatch-imports',
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(dispatchImportService.commit).not.toHaveBeenCalled();

      const committed = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload,
        url: '/api/dsv/dispatch-imports',
      });
      expect(committed.statusCode).toBe(201);
      expect(committed.json()).toMatchObject({ data: { dispatchImport: { rowCount: 1, status: 'READY' } }, error: null });
      expect(dispatchImportService.commit).toHaveBeenCalledWith({
        ...payload,
        actor: 'operator',
        shopDomain: 'tomatonofood.com',
      });
      const loginBody = login.response.json<{
        data: { csrfToken: string; expiresAt: string; shopDomain: string };
        error: null;
      }>();
      expect(loginBody).toEqual({
        data: {
          csrfToken: login.csrfToken,
          expiresAt: loginBody.data.expiresAt,
          shopDomain: 'tomatonofood.com',
        },
        error: null,
      });
      expect(Number.isNaN(Date.parse(loginBody.data.expiresAt))).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('returns row-level preview details when dispatch import commit is blocked', async () => {
    const { app, dispatchImportService } = await createHarness();
    dispatchImportService.commit.mockRejectedValueOnce(new DsvDispatchImportValidationError(invalidPreview()));
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: dispatchPayload(),
        url: '/api/dsv/dispatch-imports',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        data: null,
        error: {
          code: 'DISPATCH_IMPORT_INVALID',
          details: { preview: { canCommit: false, summary: { errorRows: 1 } } },
        },
      });
    } finally {
      await app.close();
    }
  });

  test('preserves a validated preview hash when staging and rejects malformed or unknown stage fields', async () => {
    const { app, dispatchImportService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'x-csrf-token': login.csrfToken };

      const malformed = await app.inject({
        headers,
        method: 'POST',
        payload: { ...dispatchPayload(), previewHash: 'not-a-sha256' },
        url: '/api/dsv/dispatch-imports',
      });
      expect(malformed.statusCode).toBe(400);

      const unknown = await app.inject({
        headers,
        method: 'POST',
        payload: { ...dispatchPayload(), previewHash, unsupported: true },
        url: '/api/dsv/dispatch-imports',
      });
      expect(unknown.statusCode).toBe(400);

      const staged = await app.inject({
        headers,
        method: 'POST',
        payload: { ...dispatchPayload(), previewHash: previewHash.toUpperCase() },
        url: '/api/dsv/dispatch-imports',
      });
      expect(staged.statusCode).toBe(201);
      expect(staged.json()).toMatchObject({
        data: { dispatchImport: { rowCount: 1, status: 'READY' } },
        error: null,
      });
      expect(dispatchImportService.commit).toHaveBeenCalledOnce();
      expect(dispatchImportService.commit).toHaveBeenCalledWith({
        ...dispatchPayload(),
        actor: 'operator',
        previewHash,
        shopDomain: 'tomatonofood.com',
      });
    } finally {
      await app.close();
    }
  });

  test('maps stale staged previews to the stable service conflict envelope', async () => {
    const { app, dispatchImportService } = await createHarness();
    dispatchImportService.commit.mockRejectedValueOnce(new DsvDispatchImportConflictError('DISPATCH_IMPORT_PREVIEW_STALE'));
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { ...dispatchPayload(), previewHash },
        url: '/api/dsv/dispatch-imports',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'DISPATCH_IMPORT_PREVIEW_STALE',
          message: '배차 파일 미리보기 결과가 현재 기준과 다릅니다.',
        },
      });
    } finally {
      await app.close();
    }
  });

  test('applies a staged dispatch import with CSRF, apply scope, idempotency key, and canonical principal metadata', async () => {
    const { app, dispatchImportService } = await createHarness();
    try {
      const login = await loginToDsv(app);

      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'apply-command-1' },
        method: 'POST',
        payload: { commandId: 'apply-command-1', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(dispatchImportService.apply).not.toHaveBeenCalled();

      const applied = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'apply-command-1', 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { commandId: 'apply-command-1', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({
        data: {
          applyResult: {
            commandId: 'apply-command-1',
            importId,
            sourceHash,
            status: 'APPLIED',
            summary: { appliedRows: 1, newRows: 1, noOpRows: 0 },
          },
        },
        error: null,
      });
      const applyInput = dispatchImportService.apply.mock.calls[0]?.[0];
      expect(applyInput).toMatchObject({
        actor: 'operator',
        commandId: 'apply-command-1',
        expectedSourceHash: sourceHash,
        importId,
        principal: {
          actorId: 'operator',
          actorType: 'DSV_ADMIN',
          principalType: 'DSV_ADMIN',
        },
        shopDomain: 'tomatonofood.com',
      });
      expect(applyInput?.principal?.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  test('rejects apply when the DSV admin principal lacks the explicit apply scope', async () => {
    const originalScopes = [...dsvAdminScopes];
    const mutableAdminScopes = dsvAdminScopes as unknown as string[];
    mutableAdminScopes.splice(0, mutableAdminScopes.length, ...originalScopes.filter((scope) => scope !== 'dsv:imports:apply'));
    const { app, dispatchImportService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'apply-command-1', 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { commandId: 'apply-command-1', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        data: null,
        error: {
          code: 'DSV_FORBIDDEN',
          details: {
            principalType: 'DSV_ADMIN',
            requiredScopes: ['dsv:imports:apply'],
            shopId,
          },
        },
      });
      expect(dispatchImportService.apply).not.toHaveBeenCalled();
    } finally {
      mutableAdminScopes.splice(0, mutableAdminScopes.length, ...originalScopes);
      await app.close();
    }
  });

  test('maps dispatch import apply replay and conflict errors to stable legacy envelopes', async () => {
    const { app, dispatchImportService } = await createHarness();
    dispatchImportService.apply
      .mockResolvedValueOnce(applyResult({ commandId: 'apply-replay', outcome: 'NO_OP' }))
      .mockRejectedValueOnce(new DsvDispatchImportApplyError('IDEMPOTENCY_PAYLOAD_MISMATCH'))
      .mockRejectedValueOnce(new DsvDispatchImportApplyError('COMMAND_IN_PROGRESS'))
      .mockRejectedValueOnce(new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES'));
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'x-csrf-token': login.csrfToken };

      const replay = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-replay', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        data: { applyResult: { commandId: 'apply-replay', summary: { noOpRows: 1 } } },
        error: null,
      });

      const payloadMismatch = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-conflict', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(payloadMismatch.statusCode).toBe(409);
      expect(payloadMismatch.json()).toMatchObject({
        data: null,
        error: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' },
      });

      const inProgress = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-progress', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(inProgress.statusCode).toBe(409);
      expect(inProgress.json()).toMatchObject({
        data: null,
        error: { code: 'COMMAND_IN_PROGRESS' },
      });

      const blocked = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-blocked', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json()).toMatchObject({
        data: null,
        error: { code: 'DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES' },
      });
    } finally {
      await app.close();
    }
  });

  test('validates apply command payload strictly and reports missing imports separately from invalid staged imports', async () => {
    const { app, dispatchImportService } = await createHarness();
    dispatchImportService.getImport.mockResolvedValueOnce(null);
    dispatchImportService.apply.mockRejectedValueOnce(new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY'));
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'idempotency-key': 'apply-command-1', 'x-csrf-token': login.csrfToken };

      const headerBodyMismatch = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'different-command', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(headerBodyMismatch.statusCode).toBe(400);

      const notFound = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-command-1', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toMatchObject({ data: null, error: { code: 'NOT_FOUND' } });

      const notReady = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'apply-command-1', expectedSourceHash: sourceHash },
        url: `/api/dsv/dispatch-imports/${importId}/apply`,
      });
      expect(notReady.statusCode).toBe(422);
      expect(notReady.json()).toMatchObject({ data: null, error: { code: 'DISPATCH_IMPORT_NOT_READY' } });
    } finally {
      await app.close();
    }
  });

  test('unassigns a SellerOrder through the DSV admin command boundary with CSRF, dispatch write scope, and canonical principal metadata', async () => {
    const { app, assignmentCommandService } = await createHarness();
    try {
      const login = await loginToDsv(app);

      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'assignment-command-1' },
        method: 'POST',
        payload: { commandId: 'assignment-command-1', expectedVersion: routeVersionId, reason: 'manual dispatch correction' },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/unassign`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(assignmentCommandService.unassign).not.toHaveBeenCalled();

      const response = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'assignment-command-1', 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { commandId: 'assignment-command-1', expectedVersion: routeVersionId, reason: 'manual dispatch correction' },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/unassign`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          assignmentResult: {
            assignmentStatus: 'UNASSIGNED',
            commandId: 'assignment-command-1',
            sellerOrderId,
          },
        },
        error: null,
      });
      const input = assignmentCommandService.unassign.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        actor: {
          actorId: 'operator',
          actorType: 'DSV_ADMIN',
          principalType: 'DSV_ADMIN',
        },
        commandId: 'assignment-command-1',
        expectedVersion: routeVersionId,
        reason: 'manual dispatch correction',
        sellerOrderId,
        shopDomain: 'tomatonofood.com',
      });
      expect(input?.actor.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  test('reassigns a SellerOrder through the DSV admin command boundary without accepting tenant or actor overrides', async () => {
    const { app, assignmentCommandService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'idempotency-key': 'assignment-command-2', 'x-csrf-token': login.csrfToken };

      const override = await app.inject({
        headers,
        method: 'POST',
        payload: {
          actor: 'intruder',
          commandId: 'assignment-command-2',
          expectedVersion: routeVersionId,
          shopId: 'other-shop',
          targetDriverId,
          targetRoutePlanId,
          targetSequence: 3,
          targetVehicleId,
        },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(override.statusCode).toBe(400);
      expect(assignmentCommandService.reassign).not.toHaveBeenCalled();

      const response = await app.inject({
        headers,
        method: 'POST',
        payload: {
          commandId: 'assignment-command-2',
          expectedVersion: routeVersionId,
          reason: 'manual dispatch correction',
          targetDriverId,
          targetRoutePlanId,
          targetSequence: 0,
          targetVehicleId,
        },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          assignmentResult: {
            assignmentStatus: 'ASSIGNED',
            commandId: 'assignment-command-2',
            sellerOrderId,
          },
        },
        error: null,
      });
      const input = assignmentCommandService.reassign.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        actor: {
          actorId: 'operator',
          actorType: 'DSV_ADMIN',
          principalType: 'DSV_ADMIN',
        },
        commandId: 'assignment-command-2',
        expectedVersion: routeVersionId,
        reason: 'manual dispatch correction',
        sellerOrderId,
        shopDomain: 'tomatonofood.com',
        targetDriverId,
        targetRoutePlanId,
        targetSequence: 1,
        targetVehicleId,
      });
      expect(input?.actor.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  test('registers v1 and legacy admin assignment commands to the same service with optional target fields', async () => {
    const { app, assignmentCommandService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'idempotency-key': 'assignment-command-v1', 'x-csrf-token': login.csrfToken };

      const response = await app.inject({
        headers,
        method: 'POST',
        payload: {
          commandId: 'assignment-command-v1',
          expectedVersion: routeVersionId,
          targetDriverId,
        },
        url: `/api/dsv/v1/seller-orders/${sellerOrderId}/assignment/reassign`,
      });

      expect(response.statusCode).toBe(200);
      expect(assignmentCommandService.reassign).toHaveBeenCalledWith(expect.objectContaining({
        commandId: 'assignment-command-v1',
        expectedVersion: routeVersionId,
        sellerOrderId,
        shopDomain: 'tomatonofood.com',
        targetDriverId,
      }));
      const input = assignmentCommandService.reassign.mock.calls.at(-1)?.[0];
      expect(input).not.toHaveProperty('targetRoutePlanId');
      expect(input).not.toHaveProperty('targetSequence');
      expect(input).not.toHaveProperty('targetVehicleId');
    } finally {
      await app.close();
    }
  });

  test('validates admin assignment command payloads strictly and requires matching command IDs', async () => {
    const { app, assignmentCommandService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'idempotency-key': 'assignment-command-1', 'x-csrf-token': login.csrfToken };

      const mismatch = await app.inject({
        headers,
        method: 'POST',
        payload: { commandId: 'different-command', expectedVersion: routeVersionId },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/unassign`,
      });
      expect(mismatch.statusCode).toBe(400);

      const malformedTarget = await app.inject({
        headers,
        method: 'POST',
        payload: {
          commandId: 'assignment-command-1',
          expectedVersion: routeVersionId,
          targetDriverId,
          targetRoutePlanId: 'not-a-uuid',
        },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(malformedTarget.statusCode).toBe(400);
      expect(assignmentCommandService.unassign).not.toHaveBeenCalled();
      expect(assignmentCommandService.reassign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps admin assignment command conflicts to stable legacy envelopes', async () => {
    const { app, assignmentCommandService } = await createHarness();
    assignmentCommandService.reassign
      .mockRejectedValueOnce(new DsvAssignmentCommandError('SELLER_ORDER_ASSIGNMENT_CHANGED'))
      .mockRejectedValueOnce(new DsvAssignmentCommandError('COMMAND_IN_PROGRESS'))
      .mockRejectedValueOnce(new DsvAssignmentCommandError('DUPLICATE_ACTIVE_DELIVERY'));
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'x-csrf-token': login.csrfToken };
      const payload = {
        expectedVersion: routeVersionId,
        targetDriverId,
        targetRoutePlanId,
        targetSequence: 3,
      };

      const changed = await app.inject({
        headers,
        method: 'POST',
        payload: { ...payload, commandId: 'assignment-changed' },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ data: null, error: { code: 'SELLER_ORDER_ASSIGNMENT_CHANGED' } });

      const inProgress = await app.inject({
        headers,
        method: 'POST',
        payload: { ...payload, commandId: 'assignment-progress' },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(inProgress.statusCode).toBe(409);
      expect(inProgress.json()).toMatchObject({ data: null, error: { code: 'COMMAND_IN_PROGRESS' } });

      const notReady = await app.inject({
        headers,
        method: 'POST',
        payload: { ...payload, commandId: 'assignment-not-ready' },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/reassign`,
      });
      expect(notReady.statusCode).toBe(409);
      expect(notReady.json()).toMatchObject({ data: null, error: { code: 'DUPLICATE_ACTIVE_DELIVERY' } });
    } finally {
      await app.close();
    }
  });

  test('rejects admin assignment commands when the DSV admin principal lacks dispatch write scope', async () => {
    const originalScopes = [...dsvAdminScopes];
    const mutableAdminScopes = dsvAdminScopes as unknown as string[];
    mutableAdminScopes.splice(0, mutableAdminScopes.length, ...originalScopes.filter((scope) => scope !== 'dsv:dispatches:write'));
    const { app, assignmentCommandService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie, 'idempotency-key': 'assignment-command-1', 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { commandId: 'assignment-command-1', expectedVersion: routeVersionId },
        url: `/api/dsv/seller-orders/${sellerOrderId}/assignment/unassign`,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        data: null,
        error: {
          code: 'DSV_FORBIDDEN',
          details: {
            principalType: 'DSV_ADMIN',
            requiredScopes: ['dsv:dispatches:write'],
            shopId,
          },
        },
      });
      expect(assignmentCommandService.unassign).not.toHaveBeenCalled();
    } finally {
      mutableAdminScopes.splice(0, mutableAdminScopes.length, ...originalScopes);
      await app.close();
    }
  });

  test('registers transport conditions explicitly before upload', async () => {
    const { app, dispatchImportService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'POST',
        payload: { code: 'TS03', description: '계약 조건에 따른 운송', name: 'TS03' },
        url: '/api/dsv/conditions',
      });
      expect(response.statusCode).toBe(201);
      const conditionInput = dispatchImportService.createCondition.mock.calls[0]?.[0];
      expect(conditionInput).toMatchObject({
        actor: 'operator',
        code: 'TS03',
        description: '계약 조건에 따른 운송',
        name: 'TS03',
        principal: {
          actorId: 'operator',
          actorType: 'DSV_ADMIN',
          principalType: 'DSV_ADMIN',
        },
        shopDomain: 'tomatonofood.com',
      });
      expect(conditionInput?.principal?.requestId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  test('manages DSV drivers, vehicles, and vehicle assignments inside the authenticated shop', async () => {
    const { app, resourceService } = await createHarness();
    try {
      const login = await loginToDsv(app);
      const headers = { cookie: login.cookie, 'x-csrf-token': login.csrfToken };
      const resources = await app.inject({ headers: { cookie: login.cookie }, method: 'GET', url: '/api/dsv/resources' });
      expect(resources.statusCode).toBe(200);
      expect(resources.json()).toMatchObject({ data: { assignments: [], drivers: [], vehicles: [] }, error: null });

      const driverPayload = { age: 42, career: '냉장 의약품 6년', gender: '남성', name: '김도윤', score: 'A+', traits: ['병원 하역장 숙련'], zone: '강남 서초' };
      const createdDriver = await app.inject({ headers, method: 'POST', payload: driverPayload, url: '/api/dsv/drivers' });
      expect(createdDriver.statusCode).toBe(201);
      expect(resourceService.createDriver).toHaveBeenCalledWith({ ...driverPayload, shopDomain: 'tomatonofood.com' });

      const vehiclePayload = { note: '군포복합물류센터', plate: '21사 6101', type: '냉장탑차' };
      const createdVehicle = await app.inject({ headers, method: 'POST', payload: vehiclePayload, url: '/api/dsv/vehicles' });
      expect(createdVehicle.statusCode).toBe(201);
      expect(resourceService.createVehicle).toHaveBeenCalledWith({ ...vehiclePayload, shopDomain: 'tomatonofood.com' });

      const assignment = await app.inject({
        headers,
        method: 'POST',
        payload: { driverId: '66666666-6666-4666-8666-666666666666' },
        url: '/api/dsv/vehicles/77777777-7777-4777-8777-777777777777/drivers',
      });
      expect(assignment.statusCode).toBe(201);
      expect(resourceService.assignDriver).toHaveBeenCalledWith({
        actor: 'operator',
        driverId: '66666666-6666-4666-8666-666666666666',
        shopDomain: 'tomatonofood.com',
        vehicleId: '77777777-7777-4777-8777-777777777777',
      });
    } finally {
      await app.close();
    }
  });
});

async function createHarness(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  assignmentCommandService: MockAssignmentCommandService;
  dispatchImportService: MockDispatchImportService;
  repository: MockRepository;
  resourceService: MockResourceService;
  settingsService: ReturnType<typeof createSettingsService>;
}> {
  const repository = createRepository();
  const assignmentCommandService = createAssignmentCommandService();
  const dispatchImportService = createDispatchImportService();
  const settingsService = createSettingsService();
  const resourceService = createResourceService();
  const dependencies: DsvControlDependencies = {
    allowedShopDomains: ['tomatonofood.com'],
    assignmentCommandService,
    cookieName: 'clever_dsv_admin',
    dispatchImportService,
    loginId: 'operator',
    loginSecret: 'correct-password',
    repository,
    resourceService,
    secureCookies: false,
    sessionSecret: '12345678901234567890123456789012',
    settingsService,
  };
  return { app: await buildApp({ dsvControl: dependencies }), assignmentCommandService, dispatchImportService, repository, resourceService, settingsService };
}

type MockAssignmentCommandService = {
  [Key in keyof DsvAdminAssignmentCommandService]: ReturnType<typeof vi.fn<DsvAdminAssignmentCommandService[Key]>>;
};

function createAssignmentCommandService(): MockAssignmentCommandService {
  return {
    reassign: vi.fn((input) => Promise.resolve(assignmentResult({
      assignmentStatus: 'ASSIGNED',
      commandId: input.commandId,
    }))),
    unassign: vi.fn((input) => Promise.resolve(assignmentResult({
      assignmentStatus: 'UNASSIGNED',
      commandId: input.commandId,
    }))),
  };
}

type MockResourceService = {
  [Key in keyof DsvResourceService]: ReturnType<typeof vi.fn<DsvResourceService[Key]>>;
};

function createResourceService(): MockResourceService {
  const driver = { age: 42, career: '냉장 의약품 6년', gender: '남성', id: '66666666-6666-4666-8666-666666666666', name: '김도윤', score: 'A+', traits: ['병원 하역장 숙련'], zone: '강남 서초' };
  const vehicle = { id: '77777777-7777-4777-8777-777777777777', note: '군포복합물류센터', plate: '21사 6101', type: '냉장탑차' };
  const assignment = { driverId: driver.id, id: '88888888-8888-4888-8888-888888888888', kind: '기본 배정' as const, vehicleId: vehicle.id };
  return {
    assignDriver: vi.fn(() => Promise.resolve(assignment)),
    createDriver: vi.fn(() => Promise.resolve(driver)),
    createVehicle: vi.fn(() => Promise.resolve(vehicle)),
    deleteDriver: vi.fn(() => Promise.resolve()),
    deleteVehicle: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve({ assignments: [], drivers: [], vehicles: [] })),
    unassignDriver: vi.fn(() => Promise.resolve()),
    updateDriver: vi.fn(() => Promise.resolve(driver)),
    updateVehicle: vi.fn(() => Promise.resolve(vehicle)),
  };
}

function createSettingsService() {
  const current: AdminStoreSettings = {
    defaultDepotAddress: null,
    defaultDepotLatitude: null,
    defaultDepotLongitude: null,
    locale: 'ko-KR',
    routeOpsUiSettings: defaultRouteOpsUiSettings(),
    routeScopeConfig: defaultRouteScopeConfig(),
    shopDomain: 'tomatonofood.com',
  };
  return {
    getSettings: vi.fn<(input: { shopDomain: string }) => Promise<AdminStoreSettings | null>>(() => Promise.resolve(current)),
    saveSettings: vi.fn<(input: SaveAdminStoreSettingsInput) => Promise<AdminStoreSettings>>((input) => Promise.resolve({
      ...current,
      ...input,
      routeOpsUiSettings: input.routeOpsUiSettings ?? current.routeOpsUiSettings,
      routeScopeConfig: input.routeScopeConfig ?? current.routeScopeConfig,
    })),
  };
}

type MockRepository = {
  [Key in keyof DsvControlRepository]: ReturnType<typeof vi.fn<DsvControlRepository[Key]>>;
};

function createRepository(): MockRepository {
  const tip = {
    body: '도착 전에 연락합니다.',
    category: 'access' as const,
    createdAt: '2026-07-10T00:00:00.000Z',
    destinationId,
    revision: 1,
    severity: 'warning' as const,
    source: { deliveryStopId: stopId, kind: 'delivery_record' as const, recordedAt: '2026-07-10T00:00:00.000Z' },
    status: 'active' as const,
    tipId,
    title: '후문 이용',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  return {
    createDestinationTip: vi.fn(() => Promise.resolve(tip)),
    getDeliveryStopContext: vi.fn(() => Promise.resolve({
      deliveryStopId: stopId,
      destination: { address: '서울 강남구', destinationId, name: '강남세브란스병원' },
      items: [{ name: '진단키트', orderItemId: 'item-id', quantity: 2, sku: 'KIT-1', temperatureBand: null }],
      tips: [tip],
    })),
    hasShop: vi.fn((shopDomain) => Promise.resolve(shopDomain === 'tomatonofood.com')),
    listDestinationTips: vi.fn(() => Promise.resolve([tip])),
    resolveShopId: vi.fn((shopDomain) => Promise.resolve(shopDomain === 'tomatonofood.com' ? shopId : null)),
    updateDestinationTip: vi.fn(() => Promise.resolve(tip)),
  };
}

type MockDispatchImportService = {
  [Key in keyof DsvDispatchImportService]: ReturnType<typeof vi.fn<DsvDispatchImportService[Key]>>;
} & {
  apply: ReturnType<typeof vi.fn<(input: {
    actor: string;
    commandId: string;
    expectedSourceHash: string;
    importId: string;
    principal?: {
      actorId?: string | null;
      actorType?: string;
      principalType?: 'DSV_ADMIN' | 'IMPORT_WORKER' | 'SYSTEM_WORKER';
      requestId?: string;
    };
    shopDomain: string;
  }) => Promise<DsvDispatchImportApplyResult>>>;
};

function createDispatchImportService(): MockDispatchImportService {
  const preview = validPreview();
  const dispatchImport = {
    createdAt: '2026-07-22T00:00:00.000Z',
    fileName: preview.fileName,
    id: importId,
    planDate: preview.planDate,
    rowCount: 1,
    rows: preview.rows,
    sourceHash,
    status: 'READY' as const,
  };
  return {
    apply: vi.fn((input) => Promise.resolve(applyResult({ commandId: input.commandId }))),
    commit: vi.fn(() => Promise.resolve(dispatchImport)),
    createCondition: vi.fn(() => Promise.resolve({
      code: 'TS03',
      createdAt: '2026-07-22T00:00:00.000Z',
      description: '계약 조건에 따른 운송',
      id: '55555555-5555-4555-8555-555555555555',
      name: 'TS03',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })),
    getImport: vi.fn(() => Promise.resolve(dispatchImport)),
    listConditions: vi.fn(() => Promise.resolve([])),
    preview: vi.fn(() => Promise.resolve(preview)),
  };
}

function dispatchPayload() {
  return {
    fileName: 'dsv-fixed-dispatch-10.csv',
    planDate: '2026-07-23',
    rows: [{
      address: '서울 강남구 테헤란로 152',
      conditionCode: 'Cold',
      customerCode: 'CUSTOMER-A',
      destinationName: '역삼 진단센터',
      driverName: '김도윤',
      latitude: 37.500643,
      longitude: 127.036545,
      notes: null,
      rowNumber: 2,
      sellerOrderKey: 'DSV-DEMO-001',
      shippedBoxes: 2,
      vehiclePlate: '21사 6101',
    }],
  };
}

function validPreview(): DsvDispatchImportPreview {
  const source = dispatchPayload();
  return {
    canCommit: true,
    conditionCandidates: [],
    fileName: source.fileName,
    planDate: source.planDate,
    rows: source.rows.map((row) => ({
      ...row,
      driverId: '66666666-6666-4666-8666-666666666666',
      issues: [],
      status: 'READY' as const,
      vehicleId: '77777777-7777-4777-8777-777777777777',
    })),
    summary: { errorRows: 0, readyRows: 1, reviewRows: 0, totalRows: 1 },
  };
}

function assignmentResult(input: {
  assignmentStatus: 'ASSIGNED' | 'UNASSIGNED';
  commandId: string;
}): Awaited<ReturnType<DsvAdminAssignmentCommandService['unassign']>> {
  return {
    assignmentStatus: input.assignmentStatus,
    auditEventId: 'cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd',
    commandId: input.commandId,
    etaStatus: input.assignmentStatus === 'UNASSIGNED' ? 'NOT_REQUIRED' : 'PENDING',
    newRouteVersionId: nextRouteVersionId,
    previousRouteVersionId: routeVersionId,
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    routePlanId: input.assignmentStatus === 'UNASSIGNED' ? null : targetRoutePlanId,
    sellerOrderId,
  };
}

function applyResult(input: {
  commandId: string;
  outcome?: 'NEW' | 'NO_OP';
}): DsvDispatchImportApplyResult {
  const outcome = input.outcome ?? 'NEW';
  return {
    commandId: input.commandId,
    importId,
    previewHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    rows: [{
      customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      deliveryStopId: stopId,
      destinationId,
      outcome,
      rowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      rowNumber: 2,
      sellerOrderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sellerOrderKey: 'DSV-DEMO-001',
    }],
    sourceHash,
    status: 'APPLIED',
    summary: {
      appliedRows: 1,
      newRows: outcome === 'NEW' ? 1 : 0,
      noOpRows: outcome === 'NO_OP' ? 1 : 0,
    },
  };
}

function invalidPreview(): DsvDispatchImportPreview {
  const preview = validPreview();
  return {
    ...preview,
    canCommit: false,
    conditionCandidates: ['Cold'],
    rows: preview.rows.map((row) => ({
      ...row,
      issues: [{ code: 'CONDITION_UNREGISTERED', field: 'conditionCode', message: '운송조건을 먼저 등록해야 합니다.', severity: 'error' }],
      status: 'NEEDS_REVIEW' as const,
    })),
    summary: { errorRows: 1, readyRows: 0, reviewRows: 0, totalRows: 1 },
  };
}

async function loginToDsv(app: Awaited<ReturnType<typeof buildApp>>): Promise<{
  cookie: string;
  csrfToken: string;
  response: Awaited<ReturnType<typeof app.inject>>;
}> {
  const response = await app.inject({
    method: 'POST',
    payload: { id: 'operator', password: 'correct-password', shopDomain: 'tomatonofood.com' },
    url: '/api/dsv/auth/login',
  });
  const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
  const csrfToken = response.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return { cookie, csrfToken, response };
}
