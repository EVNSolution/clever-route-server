import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AdminCommerceActor } from '../src/modules/commerce/admin-commerce-auth.js';
import { loadAdminCommerceConnectionsUiDependencies } from '../src/modules/commerce/admin-commerce-connections.dependencies.js';
import type { SafeWooCommerceConnection } from '../src/modules/commerce/commerce-connection.service.js';
import type { AdminCommerceConnectionsDependencies } from '../src/routes/admin-commerce-connections.routes.js';
import type { AdminCommerceConnectionsUiDependencies } from '../src/routes/admin-commerce-connections-ui.routes.js';
import { MIN_ADMIN_WEB_SECRET_BYTES, verifyAdminWebLoginSecret } from '../src/routes/admin-ui-session.js';

const adminApiToken = `api_${'a'.repeat(48)}`;
const webLoginSecret = `web_login_${'b'.repeat(48)}`;
const webSessionSecret = `web_session_${'c'.repeat(48)}`;
const csrfFieldPattern = /name="csrfToken" value="([^"]+)"/u;

describe('Admin WooCommerce connection UI routes', () => {
  test('does not register UI dependencies without dedicated strong web secrets or through JWT fallback', () => {
    const base = createBaseAdminCommerceDependencies();

    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: { CLEVER_ADMIN_API_TOKEN: adminApiToken, JWT_SECRET: webSessionSecret } as never,
        nodeEnv: 'production'
      })
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_API_TOKEN: adminApiToken,
          CLEVER_ADMIN_WEB_LOGIN_SECRET: 'short',
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret
        },
        nodeEnv: 'production'
      })
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_API_TOKEN: adminApiToken,
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: 'short'
        },
        nodeEnv: 'production'
      })
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret
        },
        nodeEnv: 'production'
      })
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: 'https://clever-route.cleversystem.ai'
        },
        nodeEnv: 'production'
      })
    ).toBeDefined();
  });


  test('keeps the delivery-api design contract scoped and trademark-safe', () => {
    const designPath = new URL('../DESIGN.md', import.meta.url);
    expect(existsSync(designPath)).toBe(true);
    const design = readFileSync(designPath, 'utf8');

    expect(design).toContain('applies only to the Fastify SSR browser admin UI');
    expect(design).toContain('Do not use Apple logos, Apple product imagery, Apple marks, copied Apple layouts/assets, or external Apple-hosted assets.');
    expect(design).toContain('Guided setup pages');
    expect(design).toContain('one consolidated credential form');
    expect(design).toContain('checklist before secret fields');
    expect(design).not.toContain('Apple 2030');
    expect(design).not.toContain('the Apple logo centers');
    expect(design).not.toContain('Add to Bag');
  });

  test('keeps /admin API namespace separate from exact /admin browser redirect', async () => {
    const base = createBaseAdminCommerceDependencies();
    const uiDependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: 'https://clever-route.cleversystem.ai'
      },
      nodeEnv: 'test'
    });
    expect(uiDependencies).toBeDefined();
    if (uiDependencies === undefined) throw new Error('Expected admin UI dependencies');
    const app = await buildApp({
      adminCommerceConnections: base.dependencies,
      adminCommerceConnectionsUi: uiDependencies
    });

    try {
      const exactAdmin = await app.inject({ method: 'GET', url: '/admin' });
      const jsonApi = await app.inject({ method: 'GET', url: '/admin/commerce-connections/woocommerce' });
      const unknownAdmin = await app.inject({ method: 'GET', url: '/admin/some-unknown-path' });

      expect(exactAdmin.statusCode).toBe(303);
      expect(exactAdmin.headers.location).toBe('/admin/ui');
      expect(jsonApi.statusCode).toBe(401);
      expect(jsonApi.headers.location).toBeUndefined();
      expect(jsonApi.headers['content-type']).toContain('application/json');
      expect(JSON.parse(jsonApi.body)).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing CLEVER admin bearer token' }
      });
      expect(unknownAdmin.statusCode).toBe(404);
      expect(unknownAdmin.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test('compares web login secret safely and never accepts the API token by default', () => {
    expect(MIN_ADMIN_WEB_SECRET_BYTES).toBe(32);
    expect(verifyAdminWebLoginSecret({ candidate: webLoginSecret, expected: webLoginSecret })).toBe(true);
    expect(verifyAdminWebLoginSecret({ candidate: adminApiToken, expected: webLoginSecret })).toBe(false);
    expect(verifyAdminWebLoginSecret({ candidate: webLoginSecret, expected: 'short' })).toBe(false);
  });

  test('requires login, renders the canonical dashboard, and scopes session cookies to admin UI', async () => {
    const { app } = await createUiHarness();

    try {
      const adminEntry = await app.inject({ method: 'GET', url: '/admin' });
      expect(adminEntry.statusCode).toBe(303);
      expect(adminEntry.headers.location).toBe('/admin/ui');

      const dashboardRedirect = await app.inject({ method: 'GET', url: '/admin/ui' });
      expect(dashboardRedirect.statusCode).toBe(303);
      expect(dashboardRedirect.headers.location).toBe('/admin/ui/login');

      const redirected = await app.inject({ method: 'GET', url: '/admin/ui/commerce-connections/woocommerce' });
      expect(redirected.statusCode).toBe(303);
      expect(redirected.headers.location).toBe('/admin/ui/login');

      const legacyLogin = await app.inject({ method: 'GET', url: '/admin/ui/commerce-connections/woocommerce/login' });
      expect(legacyLogin.statusCode).toBe(303);
      expect(legacyLogin.headers.location).toBe('/admin/ui/login');
      const legacyLoginPost = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/login',
        ...multipartRequest({ loginSecret: webLoginSecret })
      });
      expect(legacyLoginPost.statusCode).toBe(303);
      expect(legacyLoginPost.headers.location).toBe('/admin/ui/login');
      expect(legacyLoginPost.headers['set-cookie']).toBeUndefined();

      const loginPage = await app.inject({ method: 'GET', url: '/admin/ui/login' });
      expect(loginPage.statusCode).toBe(200);
      expect(loginPage.body).toContain('CLEVER Admin login');
      expect(loginPage.body).not.toContain(adminApiToken);

      const apiTokenLogin = await app.inject({
        method: 'POST',
        url: '/admin/ui/login',
        ...multipartRequest({ loginSecret: adminApiToken })
      });
      expect(apiTokenLogin.statusCode).toBe(401);
      expect(apiTokenLogin.headers['set-cookie']).toBeUndefined();
      expect(apiTokenLogin.body).not.toContain(adminApiToken);

      const login = await app.inject({
        method: 'POST',
        url: '/admin/ui/login',
        ...multipartRequest({ loginSecret: webLoginSecret })
      });
      expect(login.statusCode).toBe(303);
      expect(login.headers.location).toBe('/admin/ui');
      const setCookies = readSetCookies(login);
      expect(setCookies).toHaveLength(4);
      const cookie = setCookies[0] ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/admin/ui');
      expect(cookie).not.toContain('Secure');
      expectCookieClearPaths(setCookies, [
        '/admin/ui/commerce-connections/woocommerce',
        '/admin',
        '/'
      ]);

      const dashboard = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui'
      });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.body).toContain('WooCommerce connection setup');
      expect(dashboard.body).toContain('/admin/ui/commerce-connections/woocommerce');
      expect(dashboard.body).toContain('Open CLEVER Route');
      expect(dashboard.body).toContain('-apple-system');

      const commerce = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/commerce-connections'
      });
      expect(commerce.statusCode).toBe(200);
      expect(commerce.body).toContain('Commerce Connections');

      const logout = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/logout'
      });
      expect(logout.statusCode).toBe(303);
      expect(logout.headers.location).toBe('/admin/ui/login');
      expectCookieClearPaths(readSetCookies(logout), [
        '/admin/ui',
        '/admin/ui/commerce-connections/woocommerce',
        '/admin',
        '/'
      ]);

      const malformedCookie = await app.inject({
        headers: { cookie: 'clever_admin_ui=%' },
        method: 'GET',
        url: '/admin/ui/commerce-connections/woocommerce'
      });
      expect(malformedCookie.statusCode).toBe(303);
      expect(malformedCookie.headers.location).toBe('/admin/ui/login');
    } finally {
      await app.close();
    }
  });

  test('renders the protected Open CLEVER Route page with ready and review order states', async () => {
    const listCanonicalOrders = vi.fn<NonNullable<AdminCommerceConnectionsUiDependencies['orderSyncService']>['listCanonicalOrders']>(
      (input) => {
        if (input.filters?.readiness === 'READY_TO_PLAN') return Promise.resolve([canonicalOrder()]);
        if (input.filters?.readiness === 'NEEDS_REVIEW') return Promise.resolve([canonicalOrder({ readiness: 'NEEDS_REVIEW', reviewReasons: ['missing_delivery_date'] })]);
        return Promise.resolve([]);
      }
    );
    const listRoutePlans = vi.fn<NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>['listRoutePlans']>(
      () => Promise.resolve([routePlanSummary()])
    );
    const { app } = await createUiHarness({
      orderSyncService: { listCanonicalOrders },
      routePlanService: {
        createRoutePlan: vi.fn(),
        getRoutePlanDetail: vi.fn(),
        listRoutePlans,
        updateRoutePlanStops: vi.fn()
      }
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/route-plans?shopDomain=tenant-a.example.test&deliveryDate=2026-05-26'
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Open CLEVER Route');
      expect(response.body).toContain('Create route for date');
      expect(response.body).toContain('Ready to plan');
      expect(response.body).toContain('Needs review');
      expect(response.body).toContain('Manual route order');
      expect(response.body).toContain('Route draft');
      expect(response.body).toContain('missing_delivery_date');
      expect(listRoutePlans).toHaveBeenCalledWith({ shopDomain: 'tenant-a.example.test' });
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { deliveryDate: '2026-05-26', planned: false, readiness: 'READY_TO_PLAN' },
        shopDomain: 'tenant-a.example.test'
      });
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { deliveryDate: '2026-05-26', planned: false, readiness: 'NEEDS_REVIEW' },
        shopDomain: 'tenant-a.example.test'
      });
    } finally {
      await app.close();
    }
  });

  test('creates a date route from all ready unplanned orders in the admin web UI', async () => {
    const createRoutePlan = vi.fn<NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>['createRoutePlan']>(
      () => Promise.resolve(routePlanSummary())
    );
    const { app } = await createUiHarness({
      orderSyncService: { listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])) },
      routePlanService: {
        createRoutePlan,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn()
      }
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/route-plans/create',
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          depotAddress: 'Toronto depot',
          depotLatitude: '43.6532',
          depotLongitude: '-79.3832',
          planDate: '2026-05-26',
          routeName: '2026-05-26 Toronto route',
          shopDomain: 'tenant-a.example.test'
        })
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('/admin/ui/route-plans?');
      expect(response.headers.location).toContain('routePlanId=route-plan-id');
      expect(createRoutePlan).toHaveBeenCalledOnce();
      const createInput = createRoutePlan.mock.calls[0]?.[0];
      expect(createInput).toBeDefined();
      expect(createInput?.createdBy).toBe('web-operator');
      expect(createInput?.shopDomain).toBe('tenant-a.example.test');
      expect(createInput?.payload).toEqual(expect.objectContaining({
          depot: { address: 'Toronto depot', latitude: 43.6532, longitude: -79.3832 },
          name: '2026-05-26 Toronto route',
          orders: [
            expect.objectContaining({
              deliveryDate: '2026-05-26',
              name: '#1001',
              routeScopeKey: '2026-05-26|DELIVERY||',
              shopifyOrderGid: 'gid://woocommerce/Order/1001'
            })
          ],
          planDate: '2026-05-26',
          routeScope: {
            deliveryDate: '2026-05-26',
            deliverySession: 'DAY',
            routeScopeKey: '2026-05-26|DELIVERY||',
            serviceType: 'DELIVERY',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        }));
    } finally {
      await app.close();
    }
  });

  test('updates route stop order from the protected route detail page', async () => {
    const detail = routePlanDetail();
    const getRoutePlanDetail = vi.fn<NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>['getRoutePlanDetail']>(
      () => Promise.resolve(detail)
    );
    const updateRoutePlanStops = vi.fn<NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>['updateRoutePlanStops']>(
      () => Promise.resolve(detail)
    );
    const { app } = await createUiHarness({
      orderSyncService: { listCanonicalOrders: vi.fn(() => Promise.resolve([])) },
      routePlanService: {
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops
      }
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/route-plans/route-plan-id/stops',
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: 'tenant-a.example.test',
          stopOrder: 'gid://woocommerce/Order/1002\ngid://woocommerce/Order/1001'
        })
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('routePlanId=route-plan-id');
      expect(updateRoutePlanStops).toHaveBeenCalledWith({
        payload: {
          stops: [
            { deliveryStopId: 'stop-2', sequence: 1, shopifyOrderGid: 'gid://woocommerce/Order/1002' },
            { deliveryStopId: 'stop-1', sequence: 2, shopifyOrderGid: 'gid://woocommerce/Order/1001' }
          ]
        },
        routePlanId: 'route-plan-id',
        shopDomain: 'tenant-a.example.test'
      });
    } finally {
      await app.close();
    }
  });

  test('renders guided Woo onboarding copy with one credential entry form', async () => {
    const { app } = await createUiHarness();

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/commerce-connections/woocommerce'
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Connect a WooCommerce store');
      expect(response.body).toContain('What you need from WordPress');
      expect(response.body).toContain('WooCommerce → Settings → Advanced → REST API');
      expect(response.body).toContain('WooCommerce → Settings → Advanced → Webhooks');
      expect(response.body).toContain('Test credentials only');
      expect(response.body).toContain('Save connection');
      expect(response.body).toContain('/admin/ui/assets/woocommerce-test.js');
      expect(response.body).toContain('data-woo-credential-form');
      expect(response.body).toContain('data-test-credentials-button');
      expect(response.body).toContain('data-test-credential-result');
      expect(response.body).toContain('Order created');
      expect(response.body).toContain('Order updated');
      expect(response.body).toContain('initial WooCommerce ping is not the final CLEVER readiness signal');
      expect(response.body).toContain('CLEVER will generate a one-time secret after save');
      expect(response.body).toContain('Customer shop domain');
      expect(response.body).toContain('No https:// and no path. Example: estherlist.com.');
      expect(response.body).toContain('WordPress/WooCommerce site URL');
      expect(response.body).toContain('Example: https://estherlist.com or https://estherlist.com/shop.');
      expect(response.body).not.toContain('Current shop context');
      expect(response.body).not.toContain('Test Woo credentials');
      expect(response.body).not.toContain('Create Woo connection');
      expect(countOccurrences(response.body, 'name="wooConsumerKey"')).toBe(1);
      expect(countOccurrences(response.body, 'name="wooConsumerSecret"')).toBe(1);
      expect(response.body).toContain('formaction="/admin/ui/commerce-connections/woocommerce/test"');

      const script = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/assets/woocommerce-test.js'
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toContain('text/javascript');
      expect(script.body).toContain('new FormData(form)');
      expect(script.body).toContain("Accept: 'application/json'");
    } finally {
      await app.close();
    }
  });

  test('derives the UI actor from admin env and never verifies the JSON API bearer token for browser flows', async () => {
    const base = createBaseAdminCommerceDependencies();
    const uiDependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: '*',
        CLEVER_ADMIN_API_ACTOR: 'web-operator',
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: 'https://clever-route.cleversystem.ai'
      },
      nodeEnv: 'test'
    });
    expect(uiDependencies).toBeDefined();
    if (uiDependencies === undefined) throw new Error('Expected admin UI dependencies');
    const app = await buildApp({ adminCommerceConnectionsUi: uiDependencies });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }))
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('/admin/ui/commerce-connections/woocommerce?');
      expect(response.headers.location).toContain('shopDomain=tenant-a.example.test');
      expect(response.headers.location).toContain('notice=');
      expect(base.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { allowedShopDomains: '*', subject: 'web-operator' },
          consumerKey: 'ck_SHOULD_NOT_RENDER',
          consumerSecret: 'cs_SHOULD_NOT_RENDER',
          shopDomain: 'tenant-a.example.test'
        })
      );
      expect(base.adminTokenVerifier.verify).not.toHaveBeenCalled();
      expect(String(response.headers.location)).toContain('WooCommerce+credentials+verified+at+2026-05-24T00%3A00%3A00.000Z');
      expect(String(response.headers.location)).not.toContain('ck_SHOULD_NOT_RENDER');
      expect(String(response.headers.location)).not.toContain('cs_SHOULD_NOT_RENDER');
    } finally {
      await app.close();
    }
  });

  test('supports in-place JSON credential tests so typed secrets stay in the browser form', async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          accept: 'application/json'
        })
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(JSON.parse(response.body)).toEqual({
        message: 'WooCommerce credentials verified at 2026-05-24T00:00:00.000Z',
        ok: true
      });
      expect(response.body).not.toContain('ck_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('cs_SHOULD_NOT_RENDER');
      expect(testConnection).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test('requires CSRF before create/test service calls', async () => {
    const { app, createConnection } = await createUiHarness();

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken: 'tampered-token' }))
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Invalid admin UI CSRF token');
      expect(createConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('uses CSRF as the browser mutation gate when origin metadata is unreliable', async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          origin: 'https://evil.example.test',
          'sec-fetch-site': 'cross-site'
        })
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('notice=');
      expect(testConnection).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test('redirects test credential posts after accepting Safari/proxy origin metadata variants', async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          origin: 'https://clever-route.cleversystem.ai',
          'sec-fetch-site': 'same-site'
        })
      });
      const missingOrigin = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          'sec-fetch-site': 'same-site'
        })
      });
      const defaultPortOrigin = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          origin: 'https://clever-route.cleversystem.ai:443',
          'sec-fetch-site': 'same-origin'
        })
      });
      const defaultPortReferer = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), undefined, {
          referer: 'https://clever-route.cleversystem.ai:443/admin/ui/commerce-connections/woocommerce',
          'sec-fetch-site': 'same-origin'
        })
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('notice=');
      expect(missingOrigin.statusCode).toBe(303);
      expect(missingOrigin.headers.location).toContain('notice=');
      expect(defaultPortOrigin.statusCode).toBe(303);
      expect(defaultPortOrigin.headers.location).toContain('notice=');
      expect(defaultPortReferer.statusCode).toBe(303);
      expect(defaultPortReferer.headers.location).toContain('notice=');
      expect(testConnection).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });

  test('creates a connection, shows one-time webhook setup, and never renders submitted Woo secrets', async () => {
    const { app } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }))
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('WooCommerce connection saved.');
      expect(response.body).toContain('Copy this generated webhook secret now');
      expect(response.body).toContain('https://clever-route.cleversystem.ai/woocommerce/webhooks/11111111-1111-4111-8111-111111111111/orders');
      expect(response.body).toContain('generated-whsec');
      expect(countOccurrences(response.body, 'generated-whsec')).toBe(1);
      expect(response.body).not.toContain('ck_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('cs_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain(adminApiToken);
    } finally {
      await app.close();
    }
  });

  test('renders connection readiness states from safe metadata only', async () => {
    const { app } = await createUiHarness({
      listConnections: vi.fn(() =>
        Promise.resolve([
          safeConnection({ id: '11111111-1111-4111-8111-111111111111', lastWebhookAt: null, verification: { lastVerifiedAt: null, status: null } }),
          safeConnection({ id: '22222222-2222-4222-8222-222222222222', lastWebhookAt: null }),
          safeConnection({ id: '33333333-3333-4333-8333-333333333333', lastWebhookAt: '2026-05-24T01:00:00.000Z' }),
          safeConnection({ id: '44444444-4444-4444-8444-444444444444', status: 'DISABLED' })
        ])
      )
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-a.example.test'
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Test REST credentials');
      expect(response.body).toContain('Create/verify Woo webhook');
      expect(response.body).toContain('Ready');
      expect(response.body).toContain('Disabled');
      expect(response.body).toContain('Last webhook');
      expect(response.body).toContain('Last REST sync');
      expect(response.body).not.toContain('generated-whsec');
      expect(response.body).not.toContain('ck_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('cs_SHOULD_NOT_RENDER');
    } finally {
      await app.close();
    }
  });

  test('rejects ciphertext-bearing renderer payloads instead of exposing repository records', async () => {
    const unsafeConnection = {
      ...safeConnection(),
      consumerKey: 'ck_RAW_SHOULD_NOT_RENDER',
      consumerKeyCiphertext: 'ciphertext_SHOULD_NOT_RENDER',
      consumerSecret: 'cs_RAW_SHOULD_NOT_RENDER',
      consumerSecretCiphertext: 'ciphertext_SHOULD_NOT_RENDER',
      webhookSecret: 'whsec_RAW_SHOULD_NOT_RENDER',
      webhookSecretCiphertext: 'ciphertext_SHOULD_NOT_RENDER'
    } as SafeWooCommerceConnection;
    const { app } = await createUiHarness({ listConnections: vi.fn(() => Promise.resolve([unsafeConnection])) });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-a.example.test'
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('Unsafe commerce connection render payload');
      expect(response.body).not.toContain('ciphertext_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('ck_RAW_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('cs_RAW_SHOULD_NOT_RENDER');
      expect(response.body).not.toContain('whsec_RAW_SHOULD_NOT_RENDER');
    } finally {
      await app.close();
    }
  });

  test('rejects invalid shopDomain query as a safe 400 UI error', async () => {
    const listConnections = vi.fn(() => Promise.resolve([safeConnection()]));
    const { app } = await createUiHarness({ listConnections });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: 'GET',
        url: '/admin/ui/commerce-connections/woocommerce?shopDomain=bad_domain'
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('shopDomain is invalid');
      expect(listConnections).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects tampered hidden shopDomain before connection-id mutations', async () => {
    const getConnection = vi.fn(() => Promise.resolve(safeConnection({ shopDomain: 'tenant-b.example.test' })));
    const rotateCredentials = vi.fn(() => Promise.resolve(safeConnection()));
    const rotateWebhookSecret = vi.fn(() => Promise.resolve({ connection: safeConnection(), webhookSetup: { oneTimeSecret: 'new-whsec' } }));
    const updateStatus = vi.fn(() => Promise.resolve(safeConnection({ status: 'DISABLED' })));
    const { app } = await createUiHarness({ getConnection, rotateCredentials, rotateWebhookSecret, updateStatus });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const credentialResponse = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/credentials',
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: 'tenant-a.example.test',
          wooConsumerKey: 'ck_rotated_SHOULD_NOT_RENDER',
          wooConsumerSecret: 'cs_rotated_SHOULD_NOT_RENDER'
        })
      });
      const webhookResponse = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/webhook-secret',
        ...authenticatedMultipartRequest(cookie, { csrfToken, shopDomain: 'tenant-a.example.test', webhookSecret: '' })
      });
      const statusResponse = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/status',
        ...authenticatedMultipartRequest(cookie, { csrfToken, shopDomain: 'tenant-a.example.test', status: 'DISABLED' })
      });

      expect(credentialResponse.statusCode).toBe(403);
      expect(webhookResponse.statusCode).toBe(403);
      expect(statusResponse.statusCode).toBe(403);
      expect(rotateCredentials).not.toHaveBeenCalled();
      expect(rotateWebhookSecret).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(`${credentialResponse.body}${webhookResponse.body}${statusResponse.body}`).not.toContain('ck_rotated_SHOULD_NOT_RENDER');
      expect(getConnection).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  test('rejects file uploads and unexpected fields before service calls', async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, credentialFormFields({ csrfToken }), {
          file: { content: 'not allowed', filename: 'secret.txt', name: 'attachment' }
        })
      });
      const unexpected = await app.inject({
        method: 'POST',
        url: '/admin/ui/commerce-connections/woocommerce/test',
        ...authenticatedMultipartRequest(cookie, { ...credentialFormFields({ csrfToken }), unexpected: 'value' })
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain('error=');
      expect(unexpected.statusCode).toBe(303);
      expect(unexpected.headers.location).toContain('error=');
      expect(testConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

async function createUiHarness(overrides: Partial<{
  actor: AdminCommerceActor;
  createConnection: ReturnType<typeof vi.fn>;
  getConnection: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  orderSyncService: AdminCommerceConnectionsUiDependencies['orderSyncService'];
  rotateCredentials: ReturnType<typeof vi.fn>;
  rotateWebhookSecret: ReturnType<typeof vi.fn>;
  routePlanService: AdminCommerceConnectionsUiDependencies['routePlanService'];
  testConnection: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
}> = {}) {
  const listConnections = overrides.listConnections ?? vi.fn(() => Promise.resolve([safeConnection()]));
  const testConnection = overrides.testConnection ?? vi.fn(() => Promise.resolve({ checkedAt: '2026-05-24T00:00:00.000Z', status: 'VERIFIED' as const }));
  const createConnection = overrides.createConnection ?? vi.fn(() => Promise.resolve({ connection: safeConnection(), webhookSetup: { oneTimeSecret: 'generated-whsec' } }));
  const getConnection = overrides.getConnection ?? vi.fn(() => Promise.resolve(safeConnection()));
  const rotateCredentials = overrides.rotateCredentials ?? vi.fn(() => Promise.resolve(safeConnection()));
  const rotateWebhookSecret = overrides.rotateWebhookSecret ?? vi.fn(() => Promise.resolve({ connection: safeConnection(), webhookSetup: { oneTimeSecret: 'new-whsec' } }));
  const updateStatus = overrides.updateStatus ?? vi.fn(() => Promise.resolve(safeConnection({ status: 'DISABLED' })));
  const onboardingService: AdminCommerceConnectionsUiDependencies['onboardingService'] = {
    createConnection: createConnection as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['createConnection'],
    getConnection: getConnection as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['getConnection'],
    listConnections: listConnections as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['listConnections'],
    rotateCredentials: rotateCredentials as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['rotateCredentials'],
    rotateWebhookSecret: rotateWebhookSecret as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['rotateWebhookSecret'],
    testConnection: testConnection as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['testConnection'],
    updateStatus: updateStatus as unknown as AdminCommerceConnectionsUiDependencies['onboardingService']['updateStatus']
  };
  const dependencies: AdminCommerceConnectionsUiDependencies = {
    actor: overrides.actor ?? { allowedShopDomains: '*', subject: 'web-operator' },
    loginSecret: webLoginSecret,
    onboardingService,
    ...(overrides.orderSyncService === undefined ? {} : { orderSyncService: overrides.orderSyncService }),
    publicBaseUrl: 'https://clever-route.cleversystem.ai',
    ...(overrides.routePlanService === undefined ? {} : { routePlanService: overrides.routePlanService }),
    secureCookies: false,
    sessionSecret: webSessionSecret
  };
  return {
    app: await buildApp({ adminCommerceConnectionsUi: dependencies }),
    createConnection,
    getConnection,
    listConnections,
    rotateCredentials,
    rotateWebhookSecret,
    testConnection,
    updateStatus
  };
}

function createBaseAdminCommerceDependencies() {
  const testConnection = vi.fn(() => Promise.resolve({ checkedAt: '2026-05-24T00:00:00.000Z', status: 'VERIFIED' as const }));
  const adminTokenVerifier = {
    verify: vi.fn(() => ({ allowedShopDomains: '*' as const, subject: 'api-operator' }))
  };
  const dependencies: AdminCommerceConnectionsDependencies = {
    adminTokenVerifier,
    onboardingService: {
      createConnection: vi.fn(() => Promise.resolve({ connection: safeConnection(), webhookSetup: { oneTimeSecret: 'generated-whsec' } })),
      getConnection: vi.fn(() => Promise.resolve(safeConnection())),
      listConnections: vi.fn(() => Promise.resolve([safeConnection()])),
      rotateCredentials: vi.fn(() => Promise.resolve(safeConnection())),
      rotateWebhookSecret: vi.fn(() => Promise.resolve({ connection: safeConnection(), webhookSetup: { oneTimeSecret: 'new-whsec' } })),
      testConnection,
      updateStatus: vi.fn(() => Promise.resolve(safeConnection({ status: 'DISABLED' })))
    },
    publicBaseUrl: 'https://clever-route.cleversystem.ai'
  };
  return { adminTokenVerifier, dependencies, testConnection };
}

async function loginAndReadCsrf(app: Awaited<ReturnType<typeof buildApp>>): Promise<{ cookie: string; csrfToken: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/admin/ui/login',
    ...multipartRequest({ loginSecret: webLoginSecret })
  });
  expect(login.statusCode).toBe(303);
  const cookie = readSetCookie(login);
  const home = await app.inject({
    headers: { cookie },
    method: 'GET',
    url: '/admin/ui/commerce-connections/woocommerce'
  });
  expect(home.statusCode).toBe(200);
  const { csrfToken } = readCsrfFromHtml(home.body);
  return { cookie, csrfToken };
}

function readSetCookie(response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>>): string {
  return readSetCookies(response)[0] ?? '';
}

function readSetCookies(response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>>): string[] {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) return header;
  return typeof header === 'string' ? [header] : [];
}

function expectCookieClearPaths(cookies: string[], paths: string[]): void {
  for (const path of paths) {
    expect(cookies.some((cookie) => cookie.includes('Max-Age=0') && cookie.includes(`Path=${path}`))).toBe(true);
  }
}

function readCsrfFromHtml(body: string): { csrfToken: string } {
  const match = csrfFieldPattern.exec(body);
  if (match?.[1] === undefined) throw new Error('Expected CSRF token in admin UI HTML');
  return { csrfToken: match[1] };
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

function safeConnection(overrides: Partial<SafeWooCommerceConnection> = {}): SafeWooCommerceConnection {
  return {
    credential: { fingerprint: 'ck:abc123', rotatedAt: '2026-05-24T00:00:00.000Z', status: 'stored' },
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Woo main',
    lastRestSyncAt: null,
    lastWebhookAt: null,
    shopDomain: 'tenant-a.example.test',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE',
    timezone: 'America/Toronto',
    verification: { lastVerifiedAt: '2026-05-24T00:00:00.000Z', status: 'VERIFIED' },
    webhook: { rotatedAt: '2026-05-24T00:00:00.000Z', status: 'stored' },
    ...overrides
  };
}

function canonicalOrder(overrides: Partial<Awaited<ReturnType<NonNullable<AdminCommerceConnectionsUiDependencies['orderSyncService']>['listCanonicalOrders']>>[number]> = {}) {
  return {
    cancelledAt: null,
    currencyCode: 'CAD',
    deliveryArea: 'Toronto',
    deliveryBatchEndDate: null,
    deliveryBatchStartDate: null,
    deliveryDate: '2026-05-26',
    deliveryDateSource: 'EXPLICIT_ATTRIBUTE' as const,
    deliveryDayRaw: 'Tuesday',
    deliverySession: 'DAY' as const,
    deliveryStopId: 'stop-1',
    deliveryWeekday: 'TUESDAY' as const,
    email: 'customer@example.test',
    financialStatus: 'paid',
    fulfillmentStatus: 'unfulfilled',
    geocodeStatus: 'RESOLVED' as const,
    hasCoordinates: true,
    latitude: 43.6532,
    longitude: -79.3832,
    name: '#1001',
    orderCreatedAt: '2026-05-25T12:00:00.000Z',
    orderDateLocal: '2026-05-25',
    orderId: 'order-1',
    phone: '+14165550100',
    pickup: false,
    planningGroupKey: '2026-05-26|DELIVERY|||Toronto',
    planningStatus: 'UNPLANNED' as const,
    processedAt: '2026-05-25T12:00:00.000Z',
    readiness: 'READY_TO_PLAN' as const,
    recipientName: 'Jane Customer',
    reviewReasons: [] as string[],
    routeScopeKey: '2026-05-26|DELIVERY||',
    serviceType: 'DELIVERY' as const,
    shippingAddress: {
      address1: '100 King St W',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      postalCode: 'M5H 1J9',
      province: 'ON'
    },
    shopifyOrderGid: 'gid://woocommerce/Order/1001',
    shopifyOrderLegacyId: '1001',
    sourceOrderId: '1001',
    sourceOrderNumber: '1001',
    sourcePlatform: 'WOOCOMMERCE' as const,
    sourceSiteUrl: 'https://woo.example.test',
    sourceUpdatedAt: '2026-05-25T12:00:00.000Z',
    timeWindowEnd: null,
    timeWindowStart: null,
    totalPriceAmount: '45.00',
    updatedAtShopify: '2026-05-25T12:00:00.000Z',
    ...overrides
  };
}

function routePlanSummary() {
  return {
    createdAt: '2026-05-26T12:00:00.000Z',
    deliveryAreas: ['Toronto'],
    deliveryDate: '2026-05-26',
    deliveryDays: ['Tuesday'],
    depot: { latitude: 43.6532, longitude: -79.3832 },
    driver: null,
    driverId: null,
    id: 'route-plan-id',
    missingCoordinates: 0,
    name: 'Route draft',
    planDate: '2026-05-26',
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-26T12:00:00.000Z'
  };
}

function routePlanDetail() {
  return {
    routeGeometry: null,
    routePlan: routePlanSummary(),
    routeStopPoints: [],
    stops: [
      {
        address: canonicalOrder().shippingAddress,
        attributes: [],
        coordinates: { latitude: 43.6532, longitude: -79.3832 },
        deliveryArea: 'Toronto',
        deliveryDay: 'Tuesday',
        deliveryStopId: 'stop-1',
        financialStatus: 'paid',
        fulfillmentStatus: 'unfulfilled',
        orderId: 'order-1',
        orderName: '#1001',
        paymentStatus: 'paid',
        recipientName: 'Jane Customer',
        sequence: 1,
        shopifyOrderGid: 'gid://woocommerce/Order/1001',
        status: 'PENDING'
      },
      {
        address: canonicalOrder().shippingAddress,
        attributes: [],
        coordinates: { latitude: 43.7, longitude: -79.4 },
        deliveryArea: 'Toronto',
        deliveryDay: 'Tuesday',
        deliveryStopId: 'stop-2',
        financialStatus: 'paid',
        fulfillmentStatus: 'unfulfilled',
        orderId: 'order-2',
        orderName: '#1002',
        paymentStatus: 'paid',
        recipientName: 'John Customer',
        sequence: 2,
        shopifyOrderGid: 'gid://woocommerce/Order/1002',
        status: 'PENDING'
      }
    ]
  };
}

function credentialFormFields(input: { csrfToken: string }): Record<string, string> {
  return {
    csrfToken: input.csrfToken,
    label: 'Woo main',
    shopDomain: 'tenant-a.example.test',
    siteUrl: 'https://woo.example.test',
    timezone: 'America/Toronto',
    webhookSecret: '',
    wooConsumerKey: 'ck_SHOULD_NOT_RENDER',
    wooConsumerSecret: 'cs_SHOULD_NOT_RENDER'
  };
}

function multipartRequest(
  fields: Record<string, string>,
  options: { file?: { content: string; filename: string; name: string } } = {}
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `admin-ui-boundary-${Math.random().toString(36).slice(2)}`;
  const chunks = Object.entries(fields).map(([name, value]) => fieldPart(boundary, name, value));
  if (options.file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${options.file.name}"; filename="${options.file.filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n' +
          `${options.file.content}\r\n`,
        'utf8'
      )
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks)
  };
}

function authenticatedMultipartRequest(
  cookie: string,
  fields: Record<string, string>,
  options: { file?: { content: string; filename: string; name: string } } = {},
  headers: Record<string, string> = {}
): { headers: Record<string, string>; payload: Buffer } {
  const request = multipartRequest(fields, options);
  return {
    headers: { ...request.headers, ...headers, cookie },
    payload: request.payload
  };
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8'
  );
}
