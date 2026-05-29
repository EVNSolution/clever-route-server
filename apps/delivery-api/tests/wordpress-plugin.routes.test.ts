import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginHealth,
  WordPressPluginMappingConfig,
  WordPressPluginRoutePlanDetail,
  WordPressPluginRoutePlanSummary,
  WordPressPluginSyncRun
} from '../src/modules/wordpress-plugin/wordpress-plugin.types.js';
import type { WordPressPluginDependencies } from '../src/routes/wordpress-plugin.routes.js';

describe('WordPress plugin routes', () => {
  test('pairs a plugin with a one-time code without requiring Shopify session auth', async () => {
    const { dependencies, pairPlugin } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          hposEnabled: true,
          pairingCode: 'pair-code',
          pluginVersion: '0.1.0',
          siteUrl: 'https://woo.example.test',
          wooVersion: '10.3.0',
          wpVersion: '6.9.0'
        },
        url: '/wordpress/plugin/pair'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          connectionId: 'connection-id',
          expiresAt: '2026-05-22T01:45:00.000Z',
          siteUrl: 'https://woo.example.test',
          token: 'crp_token_plaintext_once',
          tokenPrefix: 'crp_token_prefix'
        },
        error: null
      });
      expect(pairPlugin).toHaveBeenCalledWith({
        hposEnabled: true,
        pairingCode: 'pair-code',
        pluginVersion: '0.1.0',
        siteUrl: 'https://woo.example.test',
        wooVersion: '10.3.0',
        wpVersion: '6.9.0'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects malformed pairing site URLs before calling pairing service', async () => {
    const { dependencies, pairPlugin } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: {
          pairingCode: 'pair-code',
          siteUrl: 'https://'
        },
        url: '/wordpress/plugin/pair'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid WordPress plugin pairing payload' }
      });
      expect(pairPlugin).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid tokens and never accepts tenant identity from query params', async () => {
    const { authenticateToken, dependencies, readHealth } = createDependencies({ validToken: false });
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer bad-token' },
        method: 'GET',
        url: '/wordpress/plugin/health?shopDomain=other-shop.test'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid plugin token' }
      });
      expect(authenticateToken).toHaveBeenCalledWith('bad-token');
      expect(readHealth).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('serves health/list/detail DTOs with freshness through plugin token auth', async () => {
    const { dependencies, findRoutePlanDetail, listRoutePlans, readHealth } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const health = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/health'
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ data: healthPayload(), error: null });

      const list = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/route-plans?status=optimized&from=2026-05-21'
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        data: {
          freshness: freshness(),
          routePlans: [routePlanSummary()]
        },
        error: null
      });
      expect(listRoutePlans).toHaveBeenCalledWith(
        expect.objectContaining({
          context: pluginContext(),
          filters: { driverId: null, from: '2026-05-21', status: 'optimized', to: null }
        })
      );
      const listRoutePlansInput = listRoutePlans.mock.calls[0]?.[0];
      expect(listRoutePlansInput?.now).toBeInstanceOf(Date);

      const detail = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/route-plans/11111111-1111-4111-8111-111111111111'
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({
        data: {
          detail: routePlanDetail(),
          freshness: freshness()
        },
        error: null
      });
      expect(findRoutePlanDetail).toHaveBeenCalledWith(
        expect.objectContaining({ context: pluginContext(), routePlanId: '11111111-1111-4111-8111-111111111111' })
      );
      expect(readHealth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('rejects malformed route-plan detail ids before repository lookup', async () => {
    const { dependencies, findRoutePlanDetail } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/route-plans/not-a-uuid'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Route plan id must be a UUID' }
      });
      expect(findRoutePlanDetail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid route-plan filters instead of broadening the result set', async () => {
    const { dependencies, listRoutePlans } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      for (const url of [
        '/wordpress/plugin/route-plans?driverId=not-a-uuid',
        '/wordpress/plugin/route-plans?from=not-a-date',
        '/wordpress/plugin/route-plans?to=2026-02-31',
        '/wordpress/plugin/route-plans?status=unsupported'
      ]) {
        const response = await app.inject({
          headers: { authorization: 'Bearer valid-token' },
          method: 'GET',
          url
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          data: null,
          error: { code: 'BAD_REQUEST', message: 'Invalid route plan filters' }
        });
      }
      expect(listRoutePlans).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('sync/request persists a run and returns quickly while server-side Woo REST backfill runs in the background', async () => {
    const { dependencies, processSyncRun, requestSync } = createDependencies();
    let resolveProcess!: (value: WordPressPluginSyncRun) => void;
    processSyncRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        })
    );
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const sync = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'POST',
        payload: { modifiedAfter: '2026-05-21T00:00:00.000Z', pageSize: 25, status: 'processing' },
        url: '/wordpress/plugin/sync/request'
      });
      expect(sync.statusCode).toBe(202);
      expect(sync.json()).toEqual({
        data: syncRequestResponse(),
        error: null
      });
      expect(requestSync).toHaveBeenCalledWith({
        context: pluginContext(),
        payload: { modifiedAfter: new Date('2026-05-21T00:00:00.000Z'), pageSize: 25, status: 'processing' }
      });
      expect(processSyncRun).toHaveBeenCalledWith({
        context: pluginContext(),
        syncRunId: '11111111-1111-4111-8111-111111111111'
      });

      resolveProcess(syncRun({ status: 'SUCCEEDED' }));
      await Promise.resolve();
    } finally {
      await app.close();
    }
  });

  test('sync/request does not start duplicate background syncs for the same connection', async () => {
    const { dependencies, processSyncRun, requestSync } = createDependencies();
    requestSync
      .mockResolvedValueOnce(syncRequestAccepted())
      .mockResolvedValueOnce(
        syncRequestAccepted({
          alreadyRunning: true,
          message: 'A sync is already queued or running in the background. Returning the active sync run.',
          startBackgroundProcessing: false,
          syncRun: syncRun({ startedAt: '2026-05-25T03:00:01.000Z', status: 'RUNNING' })
        })
      );
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const first = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'POST',
        payload: { pageSize: 25, status: 'processing' },
        url: '/wordpress/plugin/sync/request'
      });
      const second = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'POST',
        payload: { pageSize: 25, status: 'processing' },
        url: '/wordpress/plugin/sync/request'
      });

      expect(first.statusCode).toBe(202);
      expect(first.json()).toEqual({ data: syncRequestResponse(), error: null });
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual({
        data: syncRequestResponse({
          alreadyRunning: true,
          message: 'A sync is already queued or running in the background. Returning the active sync run.',
          syncRun: syncRun({ startedAt: '2026-05-25T03:00:01.000Z', status: 'RUNNING' })
        }),
        error: null
      });
      expect(requestSync).toHaveBeenCalledTimes(2);
      expect(processSyncRun).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('sync/latest and sync/requests expose durable sync-run state scoped by the plugin token', async () => {
    const { dependencies, readLatestSyncRun, readSyncRun } = createDependencies();
    readLatestSyncRun.mockResolvedValueOnce(syncRun({ status: 'RUNNING' }));
    readSyncRun.mockResolvedValueOnce(syncRun({ status: 'SUCCEEDED' }));
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const latest = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/sync/latest'
      });
      expect(latest.statusCode).toBe(200);
      expect(latest.json()).toEqual({ data: { syncRun: syncRun({ status: 'RUNNING' }) }, error: null });
      expect(readLatestSyncRun).toHaveBeenCalledWith({ context: pluginContext() });

      const byId = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/sync/requests/11111111-1111-4111-8111-111111111111'
      });
      expect(byId.statusCode).toBe(200);
      expect(byId.json()).toEqual({ data: { syncRun: syncRun({ status: 'SUCCEEDED' }) }, error: null });
      expect(readSyncRun).toHaveBeenCalledWith({
        context: pluginContext(),
        syncRunId: '11111111-1111-4111-8111-111111111111'
      });
    } finally {
      await app.close();
    }
  });

  test('sync/requests rejects malformed ids and 404s missing runs', async () => {
    const { dependencies, readSyncRun } = createDependencies();
    readSyncRun.mockResolvedValueOnce(null);
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const malformed = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/sync/requests/not-a-uuid'
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Sync run id must be a UUID' }
      });
      expect(readSyncRun).not.toHaveBeenCalled();

      const missing = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/sync/requests/22222222-2222-4222-8222-222222222222'
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Sync run not found' }
      });
    } finally {
      await app.close();
    }
  });

  test('issues a short-lived CLEVER admin launch URL for authenticated plugin access', async () => {
    const { createAdminLaunch, dependencies } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'POST',
        payload: { section: 'orders' },
        url: '/wordpress/plugin/admin-launch'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          expiresAt: '2026-05-26T06:10:00.000Z',
          launchUrl: 'https://clever-route.cleversystem.ai/admin/ui/plugin-launch?token=launch-token'
        },
        error: null
      });
      expect(createAdminLaunch).toHaveBeenCalledWith({
        context: pluginContext(),
        section: 'orders'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects malformed sync modifiedAfter values before Woo REST backfill', async () => {
    const { dependencies, requestSync } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      for (const payload of [
        { modifiedAfter: 123, pageSize: 25, status: 'processing' },
        { modifiedAfter: '2026-02-31T00:00:00.000Z', pageSize: 25, status: 'processing' },
        { modifiedAfter: '2026-05-21T00:00:00', pageSize: 25, status: 'processing' }
      ]) {
        const response = await app.inject({
          headers: { authorization: 'Bearer valid-token' },
          method: 'POST',
          payload,
          url: '/wordpress/plugin/sync/request'
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          data: null,
          error: { code: 'BAD_REQUEST', message: 'Invalid sync request payload' }
        });
      }
      expect(requestSync).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('mapping is read-only and route result mutation endpoints are absent in MVP', async () => {
    const { dependencies } = createDependencies();
    const app = await buildApp({ wordPressPlugin: dependencies });

    try {
      const mapping = await app.inject({
        headers: { authorization: 'Bearer valid-token' },
        method: 'GET',
        url: '/wordpress/plugin/mapping'
      });
      expect(mapping.statusCode).toBe(200);
      const mappingBody = mapping.json<{ data: { mapping: { editable: boolean } } }>();
      expect(mappingBody.data.mapping).toEqual(expect.objectContaining({ editable: false }));

      for (const request of [
        { method: 'POST', url: '/wordpress/plugin/route-plans' },
        { method: 'PATCH', url: '/wordpress/plugin/route-plans/11111111-1111-4111-8111-111111111111/stops' },
        { method: 'PATCH', url: '/wordpress/plugin/route-plans/11111111-1111-4111-8111-111111111111/driver' }
      ] as const) {
        const response = await app.inject({
          headers: { authorization: 'Bearer valid-token' },
          method: request.method,
          payload: {},
          url: request.url
        });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});

function createDependencies(input: { validToken?: boolean } = {}): {
  authenticateToken: ReturnType<typeof vi.fn<WordPressPluginDependencies['authService']['authenticateToken']>>;
  createAdminLaunch: ReturnType<typeof vi.fn<NonNullable<WordPressPluginDependencies['adminLaunchService']>['createAdminLaunch']>>;
  dependencies: WordPressPluginDependencies;
  findRoutePlanDetail: ReturnType<typeof vi.fn<WordPressPluginDependencies['routeResultService']['findRoutePlanDetail']>>;
  listRoutePlans: ReturnType<typeof vi.fn<WordPressPluginDependencies['routeResultService']['listRoutePlans']>>;
  pairPlugin: ReturnType<typeof vi.fn<WordPressPluginDependencies['authService']['pairPlugin']>>;
  processSyncRun: ReturnType<typeof vi.fn<WordPressPluginDependencies['syncService']['processSyncRun']>>;
  readHealth: ReturnType<typeof vi.fn<WordPressPluginDependencies['routeResultService']['readHealth']>>;
  readLatestSyncRun: ReturnType<typeof vi.fn<WordPressPluginDependencies['syncService']['readLatestSyncRun']>>;
  readSyncRun: ReturnType<typeof vi.fn<WordPressPluginDependencies['syncService']['readSyncRun']>>;
  requestSync: ReturnType<typeof vi.fn<WordPressPluginDependencies['syncService']['requestSync']>>;
} {
  const authenticateToken = vi.fn<WordPressPluginDependencies['authService']['authenticateToken']>(() =>
    Promise.resolve(input.validToken === false ? null : pluginContext())
  );
  const pairPlugin = vi.fn<WordPressPluginDependencies['authService']['pairPlugin']>(() =>
    Promise.resolve({
      connectionId: 'connection-id',
      expiresAt: '2026-05-22T01:45:00.000Z',
      siteUrl: 'https://woo.example.test',
      token: 'crp_token_plaintext_once',
      tokenPrefix: 'crp_token_prefix'
    })
  );
  const readHealth = vi.fn<WordPressPluginDependencies['routeResultService']['readHealth']>(() =>
    Promise.resolve(healthPayload())
  );
  const listRoutePlans = vi.fn<WordPressPluginDependencies['routeResultService']['listRoutePlans']>(() =>
    Promise.resolve({ freshness: freshness(), routePlans: [routePlanSummary()] })
  );
  const findRoutePlanDetail = vi.fn<WordPressPluginDependencies['routeResultService']['findRoutePlanDetail']>(() =>
    Promise.resolve({ detail: routePlanDetail(), freshness: freshness() })
  );
  const requestSync = vi.fn<WordPressPluginDependencies['syncService']['requestSync']>(() =>
    Promise.resolve(syncRequestAccepted())
  );
  const processSyncRun = vi.fn<WordPressPluginDependencies['syncService']['processSyncRun']>(() =>
    Promise.resolve(syncRun({ status: 'SUCCEEDED' }))
  );
  const readLatestSyncRun = vi.fn<WordPressPluginDependencies['syncService']['readLatestSyncRun']>(() =>
    Promise.resolve(syncRun({ status: 'RUNNING' }))
  );
  const readSyncRun = vi.fn<WordPressPluginDependencies['syncService']['readSyncRun']>(() =>
    Promise.resolve(syncRun({ status: 'SUCCEEDED' }))
  );
  const createAdminLaunch = vi.fn<NonNullable<WordPressPluginDependencies['adminLaunchService']>['createAdminLaunch']>(
    () =>
      Promise.resolve({
        expiresAt: '2026-05-26T06:10:00.000Z',
        launchUrl: 'https://clever-route.cleversystem.ai/admin/ui/plugin-launch?token=launch-token'
      })
  );
  return {
    authenticateToken,
    createAdminLaunch,
    dependencies: {
      adminLaunchService: { createAdminLaunch },
      authService: { authenticateToken, pairPlugin },
      mappingService: {
        readMapping: vi.fn(() =>
          Promise.resolve<WordPressPluginMappingConfig>({
            addressPreference: 'shipping',
            deliveryAreaMetaKey: 'delivery_area',
            deliveryDateMetaKey: 'delivery_date',
            deliveryTimeMetaKey: 'delivery_time',
            editable: false,
            notesField: 'customer_note',
            phonePreference: 'billing_then_shipping',
            preview: { address: 'redacted', phone: 'redacted', recipientName: 'redacted' }
          })
        )
      },
      routeResultService: { findRoutePlanDetail, listRoutePlans, readHealth },
      syncService: { processSyncRun, readLatestSyncRun, readSyncRun, requestSync }
    },
    findRoutePlanDetail,
    listRoutePlans,
    pairPlugin,
    processSyncRun,
    readHealth,
    readLatestSyncRun,
    readSyncRun,
    requestSync
  };
}

function pluginContext(): WordPressPluginConnectionContext {
  return {
    connectionId: 'connection-id',
    label: 'Woo test',
    shopDomain: 'woo.example.test',
    shopId: 'shop-id',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE',
    tokenId: 'token-id',
    tokenPrefix: 'crp_token_prefix'
  };
}

function freshness() {
  return {
    lastRestSyncAt: '2026-05-21T11:00:00.000Z',
    lastRouteUpdatedAt: '2026-05-21T12:00:00.000Z',
    lastWebhookAt: '2026-05-21T10:00:00.000Z',
    serverTime: '2026-05-22T01:30:00.000Z'
  };
}

function healthPayload(): WordPressPluginHealth {
  return {
    connection: {
      connectionId: 'connection-id',
      label: 'Woo test',
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test',
      state: 'connected',
      tokenPrefix: 'crp_token_prefix'
    },
    freshness: freshness(),
    latestSyncRun: syncRun({ status: 'SUCCEEDED' })
  };
}

function syncRequestAccepted(
  input: Partial<Awaited<ReturnType<WordPressPluginDependencies['syncService']['requestSync']>>> = {}
): Awaited<ReturnType<WordPressPluginDependencies['syncService']['requestSync']>> {
  return {
    alreadyRunning: false,
    message: 'Sync accepted. Processing is running in the background.',
    startBackgroundProcessing: true,
    syncRun: syncRun({ status: 'QUEUED' }),
    ...input
  };
}

function syncRequestResponse(
  input: Partial<Awaited<ReturnType<WordPressPluginDependencies['syncService']['requestSync']>>> = {}
): Omit<Awaited<ReturnType<WordPressPluginDependencies['syncService']['requestSync']>>, 'startBackgroundProcessing'> {
  const accepted = syncRequestAccepted(input);
  return {
    alreadyRunning: accepted.alreadyRunning,
    message: accepted.message,
    syncRun: accepted.syncRun
  };
}

function syncRun(input: Partial<WordPressPluginSyncRun> = {}): WordPressPluginSyncRun {
  return {
    acceptedAt: '2026-05-25T03:00:00.000Z',
    completedAt: input.status === 'SUCCEEDED' ? '2026-05-25T03:00:05.000Z' : null,
    errorMessage: null,
    request: { modifiedAfter: null, pageSize: 100, status: null },
    result:
      input.status === 'SUCCEEDED'
        ? {
            geocode: { failed: 0, notRequired: 0, pending: 0, resolved: 1 },
            pagesRead: 1,
            sync: { created: 1, needsReview: 0, readyToPlan: 1, received: 1, skipped: 0, unchanged: 0, updated: 0 },
            warnings: []
          }
        : null,
    startedAt: input.status === 'QUEUED' ? null : '2026-05-25T03:00:01.000Z',
    status: 'QUEUED',
    syncRunId: '11111111-1111-4111-8111-111111111111',
    ...input
  };
}

function routePlanSummary(): WordPressPluginRoutePlanSummary {
  return {
    createdAt: '2026-05-21T09:00:00.000Z',
    deliveryDate: '2026-05-21',
    driver: { displayName: 'Driver One', id: 'driver-id', status: 'ACTIVE' },
    durationSeconds: 3600,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Morning route',
    planDate: '2026-05-21',
    status: 'optimized',
    stopCount: 1,
    totalDistanceMeters: 12345,
    updatedAt: '2026-05-21T12:00:00.000Z'
  };
}

function routePlanDetail(): WordPressPluginRoutePlanDetail {
  return {
    routePlan: routePlanSummary(),
    stops: [
      {
        address: {
          address1: '100 Test St',
          address2: null,
          city: 'Markham',
          countryCode: 'CA',
          postalCode: 'L3R 0A1',
          province: 'ON'
        },
        deliveryDate: '2026-05-21',
        deliveryStopId: 'stop-id',
        estimatedArrivalAt: '2026-05-21T13:00:00.000Z',
        order: {
          id: 'order-id',
          name: '#123',
          sourceOrderId: '123',
          sourceOrderNumber: '123',
          sourcePlatform: 'WOOCOMMERCE',
          sourceSiteUrl: 'https://woo.example.test'
        },
        recipientName: 'Jane Customer',
        sequence: 1,
        status: 'pending',
        timeWindowEnd: null,
        timeWindowStart: null
      }
    ]
  };
}
