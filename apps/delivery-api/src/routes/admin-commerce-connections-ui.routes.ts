import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminCommerceActor } from '../modules/commerce/admin-commerce-auth.js';
import type { AdminDriverRow, AdminDriverServiceContract } from '../modules/driver/admin-driver.types.js';
import type { SafeWooCommerceConnection } from '../modules/commerce/commerce-connection.service.js';
import type { AdminStoreSettings, SaveAdminStoreSettingsInput } from '../modules/commerce/admin-store-settings.service.js';
import {
  WooCommerceOnboardingError,
  type WooCommerceConnectionOnboardingService,
  type WooCommerceOnboardingResult
} from '../modules/commerce/woocommerce-connection-onboarding.service.js';
import type { CanonicalOrderRow } from '../modules/shopify/order-sync.mapper.js';
import type { ListCanonicalOrdersFilters } from '../modules/shopify/order-sync.repository.js';
import {
  deriveOperateDeliveryStatus,
  deriveOrderHealth,
  isOperateDeliveryStatus,
  isOrderHealth,
  type OperateDeliveryStatus,
  type OrderHealth
} from '../modules/shopify/order-operate-status.js';
import {
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanStopUpdateInvalidError,
  type CreateRoutePlanPayload,
  type RoutePlanDetail,
  type RoutePlanOrderInput,
  type RoutePlanRouteScopeInput,
  type RoutePlanService,
  type RoutePlanSummary
} from '../modules/route-plans/route-plan.types.js';
import { readAdminUiFormFields } from './admin-ui-form.js';
import {
  clearAdminWebSessionCookie,
  clearBroadLegacyAdminWebSessionCookies,
  clearLegacyAdminWebSessionCookie,
  createAdminWebSession,
  verifyAdminWebCsrfToken,
  verifyAdminWebLaunchToken,
  verifyAdminWebLoginSecret,
  verifyAdminWebSessionFromRequest,
  type AdminWebSession
} from './admin-ui-session.js';

const ADMIN_ROOT_PATH = '/admin';
const ADMIN_UI_ROOT_PATH = '/admin/ui';
const ADMIN_UI_LOGIN_PATH = `${ADMIN_UI_ROOT_PATH}/login`;
const ADMIN_UI_LOGOUT_PATH = `${ADMIN_UI_ROOT_PATH}/logout`;
const ADMIN_UI_PLUGIN_LAUNCH_PATH = `${ADMIN_UI_ROOT_PATH}/plugin-launch`;
const ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH = `${ADMIN_UI_ROOT_PATH}/assets/woocommerce-test.js`;
const ADMIN_UI_ROUTE_APP_SCRIPT_PATH = `${ADMIN_UI_ROOT_PATH}/assets/route-app.js`;
const ADMIN_UI_COMMERCE_CONNECTIONS_PATH = `${ADMIN_UI_ROOT_PATH}/commerce-connections`;
const ADMIN_UI_WOOCOMMERCE_PATH = `${ADMIN_UI_COMMERCE_CONNECTIONS_PATH}/woocommerce`;
const ADMIN_UI_APP_PATH = `${ADMIN_UI_ROOT_PATH}/app`;
const ADMIN_UI_APP_DASHBOARD_PATH = `${ADMIN_UI_APP_PATH}/dashboard`;
const ADMIN_UI_APP_ORDERS_PATH = `${ADMIN_UI_APP_PATH}/orders`;
const ADMIN_UI_APP_ROUTE_PLANS_PATH = `${ADMIN_UI_APP_PATH}/routes`;
const ADMIN_UI_APP_DRIVERS_PATH = `${ADMIN_UI_APP_PATH}/drivers`;
const ADMIN_UI_APP_SETTINGS_PATH = `${ADMIN_UI_APP_PATH}/settings`;
const ADMIN_UI_ORDERS_PATH = `${ADMIN_UI_ROOT_PATH}/orders`;
const ADMIN_UI_ROUTE_PLANS_PATH = `${ADMIN_UI_ROOT_PATH}/route-plans`;
const ADMIN_UI_DRIVERS_PATH = `${ADMIN_UI_ROOT_PATH}/drivers`;
const ADMIN_UI_SETTINGS_PATH = `${ADMIN_UI_ROOT_PATH}/settings`;
const LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH = `${ADMIN_UI_WOOCOMMERCE_PATH}/login`;
const LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH = `${ADMIN_UI_WOOCOMMERCE_PATH}/logout`;
const ADMIN_UI_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'"
].join('; ');

const ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT = `
(() => {
  const form = document.querySelector('[data-woo-credential-form]');
  const button = document.querySelector('[data-test-credentials-button]');
  const result = document.querySelector('[data-test-credential-result]');
  if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement) || result === null) return;

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const originalText = button.textContent ?? 'Test credentials only';
    button.disabled = true;
    button.textContent = 'Testing...';
    result.hidden = false;
    result.className = 'alert';
    result.textContent = 'Testing WooCommerce credentials without leaving this page...';

    try {
      const response = await fetch(button.formAction, {
        body: new FormData(form),
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'POST'
      });
      const payload = await response.json().catch(() => null);
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : 'WooCommerce credential test failed.';
      result.className = response.ok && payload !== null && payload.ok === true ? 'alert success' : 'alert error';
      result.textContent = message;
    } catch {
      result.className = 'alert error';
      result.textContent = 'Credential test failed before the server replied. The values are still on this page; check the network and try again.';
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
})();
`.trim();

const ADMIN_UI_ROUTE_APP_SCRIPT = `
(() => {
  function syncSelectedOrders(form) {
    const hidden = form.querySelector('input[name="selectedOrderGids"]');
    if (!(hidden instanceof HTMLInputElement)) return;
    const selected = Array.from(form.querySelectorAll('[data-order-selector]'))
      .filter((node) => node instanceof HTMLInputElement && node.checked)
      .map((node) => node instanceof HTMLInputElement ? node.value : '')
      .filter((value) => value !== '');
    hidden.value = selected.join('\\n');
    const count = form.querySelector('[data-selected-order-count]');
    if (count !== null) {
      count.textContent = String(selected.length);
    }
  }

  for (const form of document.querySelectorAll('[data-route-selection-form]')) {
    if (!(form instanceof HTMLFormElement)) continue;
    syncSelectedOrders(form);
    form.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.matches('[data-order-selector]')) {
        syncSelectedOrders(form);
      }
    });
    form.addEventListener('submit', () => syncSelectedOrders(form));
  }
})();
`.trim();

type SafeConnectionWithDelivery = SafeWooCommerceConnection & {
  webhook: SafeWooCommerceConnection['webhook'] & {
    deliveryPath: string;
    deliveryUrl: string;
  };
};

export type AdminCommerceConnectionsUiDependencies = {
  actor: AdminCommerceActor;
  cookieName?: string;
  driverService?: Pick<
    AdminDriverServiceContract,
    'createPendingDriver' | 'deleteDriver' | 'listDrivers' | 'regenerateInviteCode'
  >;
  loginSecret: string;
  now?: () => Date;
  onboardingService: Pick<
    WooCommerceConnectionOnboardingService,
    | 'createConnection'
    | 'getConnection'
    | 'listConnections'
    | 'rotateCredentials'
    | 'rotateWebhookSecret'
    | 'testConnection'
    | 'updateStatus'
  >;
  orderSyncService?: {
    listCanonicalOrders(input: {
      filters?: ListCanonicalOrdersFilters;
      shopDomain: string;
    }): Promise<CanonicalOrderRow[]>;
  };
  publicBaseUrl?: string;
  routePlanService?: Pick<
    RoutePlanService,
    'assignRoutePlanDriver' | 'createRoutePlan' | 'getRoutePlanDetail' | 'listRoutePlans' | 'updateRoutePlanStops'
  >;
  secureCookies: boolean;
  sessionSecret: string;
  sessionTtlMs?: number;
  settingsService?: {
    getSettings(input: { shopDomain: string }): Promise<AdminStoreSettings | null>;
    saveSettings(input: SaveAdminStoreSettingsInput): Promise<AdminStoreSettings>;
  };
};

export function registerAdminCommerceConnectionsUiRoutes(
  app: FastifyInstance,
  dependencies: AdminCommerceConnectionsUiDependencies
): void {
  app.get(ADMIN_ROOT_PATH, async (_request, reply) => redirect(reply, ADMIN_UI_ROOT_PATH));

  app.get(ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT)
  );

  app.get(ADMIN_UI_ROUTE_APP_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type('text/javascript; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(ADMIN_UI_ROUTE_APP_SCRIPT)
  );

  app.get(ADMIN_UI_PLUGIN_LAUNCH_PATH, async (request, reply) => {
    const token = readQueryString(request.query, 'token');
    if (token === null) {
      return sendHtml(reply, 401, renderLoginPage({ error: 'Invalid plugin launch token' }));
    }
    const launch = verifyAdminWebLaunchToken({
      token,
      sessionSecret: dependencies.sessionSecret,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now })
    });
    if (launch === null) {
      return sendHtml(reply, 401, renderLoginPage({ error: 'Invalid or expired plugin launch token' }));
    }
    const created = createAdminWebSession({
      sameSite: 'Lax',
      secure: dependencies.secureCookies,
      sessionSecret: dependencies.sessionSecret,
      subject: launch.subject,
      ...(dependencies.cookieName === undefined ? {} : { cookieName: dependencies.cookieName }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sessionTtlMs === undefined ? {} : { ttlMs: dependencies.sessionTtlMs })
    });
    return reply
      .code(303)
      .header('Set-Cookie', sessionSetCookieHeaders(dependencies, created.cookieHeader))
      .header('Location', launch.returnPath)
      .send('');
  });

  app.get(ADMIN_UI_ROOT_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(reply, session);
    }
    return sendHtml(reply, 200, renderDashboardPage({ actor: dependencies.actor, csrfToken: session.csrfToken }));
  });

  app.get(ADMIN_UI_COMMERCE_CONNECTIONS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
    }
    return sendHtml(reply, 200, renderCommerceConnectionsPage({ actor: dependencies.actor, csrfToken: session.csrfToken }));
  });

  app.get(ADMIN_UI_APP_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return redirectToAdminModule(reply, ADMIN_UI_APP_DASHBOARD_PATH, {
      shopDomain: readQueryString(request.query, 'shopDomain') ?? readWpPluginSessionShopDomain(session)
    });
  });

  app.get(ADMIN_UI_APP_DASHBOARD_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderAppDashboard(reply, request, dependencies, session, {
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.get(ADMIN_UI_APP_ORDERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderOrders(reply, request, dependencies, session, {
      deliveryArea: readQueryString(request.query, 'deliveryArea'),
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      operateDeliveryStatus: readQueryString(request.query, 'operateDeliveryStatus'),
      orderHealth: readQueryString(request.query, 'orderHealth'),
      search: readQueryString(request.query, 'search'),
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.get(ADMIN_UI_APP_ROUTE_PLANS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderRoutePlans(reply, request, dependencies, session, {
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      routePlanId: readQueryString(request.query, 'routePlanId'),
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.get(`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/new`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderRoutePlans(reply, request, dependencies, session, {
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.get<{ Params: { routePlanId: string } }>(`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderRoutePlans(reply, request, dependencies, session, {
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      routePlanId: request.params.routePlanId,
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleRoutePlanCreate(request, reply, dependencies, session);
  });

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/stops`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteStopsUpdate(request, reply, dependencies, session, request.params.routePlanId);
    }
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/driver`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteDriverAssignment(request, reply, dependencies, session, request.params.routePlanId);
    }
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/optimize`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteOptimize(request, reply, dependencies, session, request.params.routePlanId);
    }
  );

  app.get(ADMIN_UI_APP_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderDrivers(reply, request, dependencies, session, {
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(ADMIN_UI_APP_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleDriverCreate(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_APP_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderSettings(reply, request, dependencies, session, {
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(ADMIN_UI_APP_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleSettingsSave(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_ROUTE_PLANS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderRoutePlans(reply, request, dependencies, session, {
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      routePlanId: readQueryString(request.query, 'routePlanId'),
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(`${ADMIN_UI_ROUTE_PLANS_PATH}/create`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleRoutePlanCreate(request, reply, dependencies, session);
  });

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/stops`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteStopsUpdate(request, reply, dependencies, session, request.params.routePlanId);
    }
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/driver`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteDriverAssignment(request, reply, dependencies, session, request.params.routePlanId);
    }
  );

  app.get(ADMIN_UI_ORDERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderOrders(reply, request, dependencies, session, {
      deliveryArea: readQueryString(request.query, 'deliveryArea'),
      deliveryDate: readQueryString(request.query, 'deliveryDate'),
      operateDeliveryStatus: readQueryString(request.query, 'operateDeliveryStatus'),
      orderHealth: readQueryString(request.query, 'orderHealth'),
      search: readQueryString(request.query, 'search'),
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.get(ADMIN_UI_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderDrivers(reply, request, dependencies, session, {
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(ADMIN_UI_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleDriverCreate(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return renderSettings(reply, request, dependencies, session, {
      shopDomain: readQueryString(request.query, 'shopDomain'),
      ...optionalUiMessage('error', readQueryString(request.query, 'error')),
      ...optionalUiMessage('notice', readQueryString(request.query, 'notice'))
    });
  });

  app.post(ADMIN_UI_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleSettingsSave(request, reply, dependencies, session);
  });

  app.get(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH, async (_request, reply) => redirect(reply, ADMIN_UI_LOGIN_PATH));
  app.post(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH, async (_request, reply) => redirect(reply, ADMIN_UI_LOGIN_PATH));

  app.get(ADMIN_UI_LOGIN_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session !== null) {
      return redirect(reply, ADMIN_UI_ROOT_PATH);
    }
    return sendHtml(reply, 200, renderLoginPage());
  });

  app.post(ADMIN_UI_LOGIN_PATH, async (request, reply) => {
    try {
      const fields = await readAdminUiFormFields(request, {
        allowedFields: ['loginSecret'],
        maxFields: 1
      });
      const loginSecret = readRequiredField(fields, 'loginSecret', 'login secret');
      if (!verifyAdminWebLoginSecret({ candidate: loginSecret, expected: dependencies.loginSecret })) {
        request.log.warn(
          { event: 'clever_admin_ui_login_rejected', surface: 'admin_commerce_connections_ui' },
          'CLEVER admin UI login rejected'
        );
        return sendHtml(reply, 401, renderLoginPage({ error: 'Invalid admin login secret' }));
      }

      const created = createAdminWebSession({
        secure: dependencies.secureCookies,
        sessionSecret: dependencies.sessionSecret,
        subject: dependencies.actor.subject,
        ...(dependencies.cookieName === undefined ? {} : { cookieName: dependencies.cookieName }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.sessionTtlMs === undefined ? {} : { ttlMs: dependencies.sessionTtlMs })
      });
      return reply
        .code(303)
        .header('Set-Cookie', sessionSetCookieHeaders(dependencies, created.cookieHeader))
        .header('Location', ADMIN_UI_ROOT_PATH)
        .send('');
    } catch (error) {
      return sendUiError(reply, request, dependencies, null, error);
    }
  });

  app.get(ADMIN_UI_WOOCOMMERCE_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
    }

    const shopDomain = readQueryString(request.query, 'shopDomain');
    const notice = readQueryString(request.query, 'notice');
    const error = readQueryString(request.query, 'error');
    return renderHome(reply, request, dependencies, session, {
      currentShopDomain: shopDomain,
      ...(error === null ? {} : { error: truncateUiMessage(error) }),
      ...(error === null ? {} : { statusCode: 200 }),
      ...(notice === null ? {} : { notice: truncateUiMessage(notice) })
    });
  });

  app.get(ADMIN_UI_LOGOUT_PATH, async (_request, reply) => redirectWithClearedSession(reply, dependencies));
  app.post(ADMIN_UI_LOGOUT_PATH, async (request, reply) => handleLogout(request, reply, dependencies));
  app.get(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH, async (_request, reply) =>
    redirectWithClearedSession(reply, dependencies)
  );
  app.post(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH, async (request, reply) =>
    handleLogout(request, reply, dependencies)
  );

  app.post(`${ADMIN_UI_WOOCOMMERCE_PATH}/test`, async (request, reply) => {
    const session = readSession(request, dependencies);
    const jsonResponse = wantsJson(request);
    if (session === null) {
      if (jsonResponse) return sendJson(reply, 401, { message: 'Admin UI login required', ok: false });
      return redirect(reply, ADMIN_UI_LOGIN_PATH);
    }
    if (isWpPluginSession(session)) {
      const message = 'Connection setup requires CLEVER admin login.';
      if (jsonResponse) return sendJson(reply, 403, { message, ok: false });
      return redirectWpPluginSessionToOperate(reply, session, message);
    }

    let fields: Record<string, string> | null = null;
    let shopDomain: string | null = null;
    try {
      assertSameOriginMutation(request, dependencies);
      fields = await readAdminUiFormFields(request, {
        allowedFields: credentialFieldNames(),
        maxFields: 8
      });
      assertValidCsrf(session, fields.csrfToken);
      shopDomain = readOptionalField(fields, 'shopDomain');
      const result = await dependencies.onboardingService.testConnection({
        actor: dependencies.actor,
        ...readCredentialFields(fields)
      });
      const message = `WooCommerce credentials verified at ${result.checkedAt}`;
      if (jsonResponse) return sendJson(reply, 200, { message, ok: true });
      return redirectToWooCommerceHome(reply, {
        currentShopDomain: shopDomain,
        notice: message
      });
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      if (jsonResponse) {
        const statusCode = error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
        return sendJson(reply, statusCode, { message, ok: false });
      }
      return redirectToWooCommerceHome(reply, {
        currentShopDomain: shopDomain ?? readOptionalField(fields ?? {}, 'shopDomain'),
        error: message
      });
    }
  });

  app.post(ADMIN_UI_WOOCOMMERCE_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
    }

    let shopDomain: string | null = null;
    try {
      assertSameOriginMutation(request, dependencies);
      const fields = await readAdminUiFormFields(request, {
        allowedFields: credentialFieldNames(),
        maxFields: 8
      });
      assertValidCsrf(session, fields.csrfToken);
      shopDomain = readOptionalField(fields, 'shopDomain');
      const result = await dependencies.onboardingService.createConnection({
        actor: dependencies.actor,
        ...readCredentialFields(fields)
      });
      return renderHome(reply, request, dependencies, session, {
        currentShopDomain: result.connection.shopDomain,
        notice: 'WooCommerce connection saved.',
        webhookSetup: toWebhookSetup(request, dependencies, result)
      });
    } catch (error) {
      return sendUiError(reply, request, dependencies, session, error, shopDomain);
    }
  });

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ['csrfToken', 'shopDomain', 'wooConsumerKey', 'wooConsumerSecret'],
          maxFields: 4
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, 'shopDomain', 'shopDomain');
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain
        });
        const connection = await dependencies.onboardingService.rotateCredentials({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          consumerKey: readRequiredField(fields, 'wooConsumerKey', 'WooCommerce consumer key'),
          consumerSecret: readRequiredField(fields, 'wooConsumerSecret', 'WooCommerce consumer secret')
        });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: connection.shopDomain,
          notice: 'WooCommerce REST credentials rotated.'
        });
      } catch (error) {
        return sendUiError(reply, request, dependencies, session, error, shopDomain);
      }
    }
  );

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/webhook-secret`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ['csrfToken', 'shopDomain', 'webhookSecret'],
          maxFields: 3
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, 'shopDomain', 'shopDomain');
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain
        });
        const result = await dependencies.onboardingService.rotateWebhookSecret({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          webhookSecret: readOptionalField(fields, 'webhookSecret')
        });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: result.connection.shopDomain,
          notice: 'WooCommerce webhook secret rotated.',
          webhookSetup: toWebhookSetup(request, dependencies, result)
        });
      } catch (error) {
        return sendUiError(reply, request, dependencies, session, error, shopDomain);
      }
    }
  );

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/status`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(reply, session, 'Connection setup requires CLEVER admin login.');
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ['csrfToken', 'shopDomain', 'status'],
          maxFields: 3
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, 'shopDomain', 'shopDomain');
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain
        });
        const connection = await dependencies.onboardingService.updateStatus({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          status: readStatusField(fields.status)
        });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: connection.shopDomain,
          notice: `WooCommerce connection ${connection.status.toLowerCase()}.`
        });
      } catch (error) {
        return sendUiError(reply, request, dependencies, session, error, shopDomain);
      }
    }
  );
}

async function renderAppDashboard(
  reply: FastifyReply,
  _request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: { error?: string; notice?: string; shopDomain?: string | null }
): Promise<unknown> {
  const services = readRouteUiServices(dependencies);
  let currentShopDomain: string | null = null;
  let readyOrders: CanonicalOrderRow[] = [];
  let reviewOrders: CanonicalOrderRow[] = [];
  let routePlans: RoutePlanSummary[] = [];
  let drivers: AdminDriverRow[] = [];
  let settings: AdminStoreSettings | null = null;
  let error = input.error;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain) ?? readWpPluginSessionShopDomain(session);
    assertWpPluginShopAccess(session, currentShopDomain);
    if (services === null) {
      error = error ?? 'Route planning services are not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      [readyOrders, reviewOrders, routePlans, drivers] = await Promise.all([
        services.orderSyncService.listCanonicalOrders({
          filters: { planned: false, readiness: 'READY_TO_PLAN' },
          shopDomain: currentShopDomain
        }),
        services.orderSyncService.listCanonicalOrders({
          filters: { readiness: 'NEEDS_REVIEW' },
          shopDomain: currentShopDomain
        }),
        services.routePlanService.listRoutePlans({ shopDomain: currentShopDomain }),
        services.driverService === undefined
          ? Promise.resolve([])
          : services.driverService.listDrivers({ shopDomain: currentShopDomain })
      ]);
      if (dependencies.settingsService !== undefined) {
        try {
          settings = await dependencies.settingsService.getSettings({ shopDomain: currentShopDomain });
        } catch {
          settings = null;
        }
      }
    }
  } catch (loadError) {
    error = error ?? sanitizeErrorMessage(loadError);
  }

  return sendHtml(
    reply,
    200,
    renderAppDashboardPage({
      actor: dependencies.actor,
      csrfToken: session.csrfToken,
      currentShopDomain,
      drivers,
      readyOrders,
      reviewOrders,
      routePlans,
      settings,
      shopDomainLocked: isWpPluginSession(session),
      ...(error === undefined ? {} : { error: truncateUiMessage(error) }),
      ...(input.notice === undefined ? {} : { notice: truncateUiMessage(input.notice) })
    })
  );
}

async function renderOrders(
  reply: FastifyReply,
  _request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: {
    deliveryArea?: string | null;
    deliveryDate?: string | null;
    error?: string;
    notice?: string;
    operateDeliveryStatus?: string | null;
    orderHealth?: string | null;
    search?: string | null;
    shopDomain?: string | null;
  }
): Promise<unknown> {
  let currentShopDomain: string | null = null;
  let deliveryArea: string | null = null;
  let deliveryDate: string | null = null;
  let operateDeliveryStatus: OperateDeliveryStatus | null = null;
  let orderHealth: OrderHealth | null = null;
  let search: string | null = null;
  let orders: CanonicalOrderRow[] = [];
  let reviewOrders: CanonicalOrderRow[] = [];
  let error = input.error;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain) ?? readWpPluginSessionShopDomain(session);
    assertWpPluginShopAccess(session, currentShopDomain);
    deliveryDate = normalizeOptionalDate(input.deliveryDate);
    deliveryArea = normalizeOptionalText(input.deliveryArea, 'deliveryArea');
    operateDeliveryStatus = normalizeOperateDeliveryStatus(input.operateDeliveryStatus);
    orderHealth = normalizeOrderHealth(input.orderHealth);
    search = normalizeOptionalText(input.search, 'search');
    if (dependencies.orderSyncService === undefined) {
      error = error ?? 'Order list service is not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      const filters: ListCanonicalOrdersFilters = {
        ...(deliveryArea === null ? {} : { deliveryArea }),
        ...(deliveryDate === null ? {} : { deliveryDate }),
        ...(operateDeliveryStatus === null ? {} : { operateDeliveryStatus }),
        ...(orderHealth === null ? {} : { orderHealth }),
        ...(search === null ? {} : { search })
      };
      [orders, reviewOrders] = await Promise.all([
        dependencies.orderSyncService.listCanonicalOrders({
          filters,
          shopDomain: currentShopDomain
        }),
        dependencies.orderSyncService.listCanonicalOrders({
          filters: {
            ...(deliveryArea === null ? {} : { deliveryArea }),
            ...(deliveryDate === null ? {} : { deliveryDate }),
            ...(search === null ? {} : { search }),
            readiness: 'NEEDS_REVIEW'
          },
          shopDomain: currentShopDomain
        })
      ]);
    }
  } catch (loadError) {
    error = error ?? sanitizeErrorMessage(loadError);
  }

  return sendHtml(
    reply,
    200,
    renderOrdersPage({
      actor: dependencies.actor,
      csrfToken: session.csrfToken,
      currentShopDomain,
      deliveryArea,
      deliveryDate,
      operateDeliveryStatus,
      orderHealth,
      orders,
      reviewOrders,
      search,
      shopDomainLocked: isWpPluginSession(session),
      ...(error === undefined ? {} : { error: truncateUiMessage(error) }),
      ...(input.notice === undefined ? {} : { notice: truncateUiMessage(input.notice) })
    })
  );
}

async function renderDrivers(
  reply: FastifyReply,
  _request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: { error?: string; notice?: string; shopDomain?: string | null }
): Promise<unknown> {
  let currentShopDomain: string | null = null;
  let drivers: AdminDriverRow[] = [];
  let error = input.error;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain) ?? readWpPluginSessionShopDomain(session);
    assertWpPluginShopAccess(session, currentShopDomain);
    if (dependencies.driverService === undefined) {
      error = error ?? 'Driver management service is not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      drivers = await dependencies.driverService.listDrivers({ shopDomain: currentShopDomain });
    }
  } catch (loadError) {
    error = error ?? sanitizeErrorMessage(loadError);
  }

  return sendHtml(
    reply,
    200,
    renderDriversPage({
      actor: dependencies.actor,
      csrfToken: session.csrfToken,
      currentShopDomain,
      drivers,
      shopDomainLocked: isWpPluginSession(session),
      ...(error === undefined ? {} : { error: truncateUiMessage(error) }),
      ...(input.notice === undefined ? {} : { notice: truncateUiMessage(input.notice) })
    })
  );
}

async function handleDriverCreate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    if (dependencies.driverService === undefined) {
      throw new WooCommerceOnboardingError('BAD_REQUEST', 'Driver management service is not enabled in this runtime.', 400);
    }
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken', 'shopDomain', 'displayName', 'phone'],
      maxFields: 4
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    await dependencies.driverService.createPendingDriver({
      createdBy: dependencies.actor.subject,
      displayName: readOptionalField(fields, 'displayName'),
      inviteLink: null,
      phone: readRequiredField(fields, 'phone', 'driver phone'),
      shopDomain,
      source: 'clever-app-driver-invite'
    });
    return redirectToAdminModule(reply, ADMIN_UI_APP_DRIVERS_PATH, {
      notice: 'Driver invite created.',
      shopDomain
    });
  } catch (error) {
    return redirectToAdminModule(reply, ADMIN_UI_APP_DRIVERS_PATH, {
      error: sanitizeErrorMessage(error),
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

async function renderSettings(
  reply: FastifyReply,
  _request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: { error?: string; notice?: string; shopDomain?: string | null }
): Promise<unknown> {
  let currentShopDomain: string | null = null;
  let settings: AdminStoreSettings | null = null;
  let error = input.error;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain) ?? readWpPluginSessionShopDomain(session);
    assertWpPluginShopAccess(session, currentShopDomain);
    if (dependencies.settingsService === undefined) {
      error = error ?? 'Store settings service is not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      settings = await dependencies.settingsService.getSettings({ shopDomain: currentShopDomain });
    }
  } catch (loadError) {
    error = error ?? sanitizeErrorMessage(loadError);
  }

  return sendHtml(
    reply,
    200,
    renderSettingsPage({
      actor: dependencies.actor,
      csrfToken: session.csrfToken,
      currentShopDomain,
      shopDomainLocked: isWpPluginSession(session),
      settings,
      ...(error === undefined ? {} : { error: truncateUiMessage(error) }),
      ...(input.notice === undefined ? {} : { notice: truncateUiMessage(input.notice) })
    })
  );
}

async function handleSettingsSave(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    if (dependencies.settingsService === undefined) {
      throw new WooCommerceOnboardingError('BAD_REQUEST', 'Store settings service is not enabled in this runtime.', 400);
    }
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken', 'shopDomain', 'defaultDepotAddress', 'defaultDepotLatitude', 'defaultDepotLongitude', 'locale'],
      maxFields: 6
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    await dependencies.settingsService.saveSettings({
      defaultDepotAddress: readOptionalField(fields, 'defaultDepotAddress'),
      defaultDepotLatitude: readOptionalCoordinate(fields.defaultDepotLatitude),
      defaultDepotLongitude: readOptionalCoordinate(fields.defaultDepotLongitude),
      locale: readLocaleField(fields.locale),
      shopDomain
    });
    return redirectToAdminModule(reply, ADMIN_UI_APP_SETTINGS_PATH, {
      notice: 'Store settings saved.',
      shopDomain
    });
  } catch (error) {
    return redirectToAdminModule(reply, ADMIN_UI_APP_SETTINGS_PATH, {
      error: sanitizeErrorMessage(error),
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

async function renderRoutePlans(
  reply: FastifyReply,
  _request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: {
    deliveryDate?: string | null;
    error?: string;
    notice?: string;
    routePlanId?: string | null;
    shopDomain?: string | null;
    statusCode?: number;
  }
): Promise<unknown> {
  const services = readRouteUiServices(dependencies);
  let error = input.error;
  let currentShopDomain: string | null = null;
  let deliveryDate: string | null = null;
  let routePlans: RoutePlanSummary[] = [];
  let readyOrders: CanonicalOrderRow[] = [];
  let reviewOrders: CanonicalOrderRow[] = [];
  let routeDetail: RoutePlanDetail | null = null;
  let settings: AdminStoreSettings | null = null;
  let drivers: AdminDriverRow[] = [];

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain) ?? readWpPluginSessionShopDomain(session);
    assertWpPluginShopAccess(session, currentShopDomain);
    deliveryDate = normalizeOptionalDate(input.deliveryDate);
    if (services === null) {
      error = error ?? 'Route planning services are not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      [routePlans, drivers] = await Promise.all([
        services.routePlanService.listRoutePlans({
          ...(deliveryDate === null ? {} : { deliveryDate }),
          shopDomain: currentShopDomain
        }),
        services.driverService === undefined
          ? Promise.resolve([])
          : services.driverService.listDrivers({ shopDomain: currentShopDomain })
      ]);
      routePlans = filterRoutePlansByDate(routePlans, deliveryDate);
      if (input.routePlanId !== null && input.routePlanId !== undefined && input.routePlanId.trim() !== '') {
        routeDetail = await services.routePlanService.getRoutePlanDetail({
          routePlanId: input.routePlanId.trim(),
          shopDomain: currentShopDomain
        });
        if (routeDetail === null) {
          error = error ?? 'Route plan not found for this shop.';
        } else if (!routePlanMatchesDate(routeDetail.routePlan, deliveryDate)) {
          routeDetail = null;
          error = error ?? 'Route plan is not for the selected delivery date.';
        }
      }

      const filters = (readiness: 'NEEDS_REVIEW' | 'READY_TO_PLAN'): ListCanonicalOrdersFilters => ({
        ...(deliveryDate === null ? {} : { deliveryDate }),
        planned: false,
        readiness
      });
      [readyOrders, reviewOrders] = await Promise.all([
        services.orderSyncService.listCanonicalOrders({
          filters: filters('READY_TO_PLAN'),
          shopDomain: currentShopDomain
        }),
        services.orderSyncService.listCanonicalOrders({
          filters: filters('NEEDS_REVIEW'),
          shopDomain: currentShopDomain
        })
      ]);
      if (dependencies.settingsService !== undefined) {
        try {
          settings = await dependencies.settingsService.getSettings({ shopDomain: currentShopDomain });
        } catch {
          settings = null;
        }
      }
    }
  } catch (loadError) {
    error = error ?? sanitizeErrorMessage(loadError);
  }

  return sendHtml(
    reply,
    input.statusCode ?? 200,
    renderRoutePlansPage({
      actor: dependencies.actor,
      csrfToken: session.csrfToken,
      currentShopDomain,
      deliveryDate,
      drivers,
      readyOrders,
      reviewOrders,
      routeDetail,
      routePlans,
      servicesEnabled: services !== null,
      settings,
      shopDomainLocked: isWpPluginSession(session),
      ...(error === undefined ? {} : { error: truncateUiMessage(error) }),
      ...(input.notice === undefined ? {} : { notice: truncateUiMessage(input.notice) })
    })
  );
}

async function handleRoutePlanCreate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession
): Promise<unknown> {
  let shopDomain: string | null = null;
  let planDate: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: [
        'csrfToken',
        'shopDomain',
        'planDate',
        'routeName',
        'depotAddress',
        'depotLatitude',
        'depotLongitude',
        'selectedOrderGids'
      ],
      maxFields: 8
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    planDate = normalizeRequiredDate(readRequiredField(fields, 'planDate', 'plan date'));
    const selectedOrderGids = readSelectedOrderGids(readRequiredField(fields, 'selectedOrderGids', 'selected orders'));
    const candidateOrders = await services.orderSyncService.listCanonicalOrders({
      filters: { deliveryDate: planDate },
      shopDomain
    });
    const selectedOrders = selectRouteReadyOrders({
      orders: candidateOrders,
      planDate,
      selectedOrderGids
    });

    const payload = buildCreateRoutePlanPayload({
      depotAddress: readOptionalField(fields, 'depotAddress'),
      depotLatitude: readOptionalCoordinate(fields.depotLatitude),
      depotLongitude: readOptionalCoordinate(fields.depotLongitude),
      orders: selectedOrders,
      planDate,
      routeName: readRequiredField(fields, 'routeName', 'route name')
    });
    const routePlan = await services.routePlanService.createRoutePlan({
      createdBy: dependencies.actor.subject,
      payload,
      shopDomain
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: planDate,
      notice: `Route created from ${selectedOrders.length} selected ready orders.`,
      routePlanId: routePlan.id,
      shopDomain
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      ...(planDate === null ? {} : { deliveryDate: planDate }),
      error: sanitizeRouteUiError(error),
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

async function handleRouteStopsUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken', 'shopDomain', 'stopOrder'],
      maxFields: 3
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    const detail = await services.routePlanService.getRoutePlanDetail({ routePlanId, shopDomain });
    if (detail === null) {
      return redirectToRoutePlans(reply, {
        error: 'Route plan not found for this shop.',
        shopDomain
      });
    }
    const stops = readStopOrderLines(readRequiredField(fields, 'stopOrder', 'stop order'), detail);
    await services.routePlanService.updateRoutePlanStops({
      payload: { stops },
      routePlanId,
      shopDomain
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice: 'Route stop order saved.',
      routePlanId,
      shopDomain
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

async function handleRouteDriverAssignment(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken', 'shopDomain', 'driverId'],
      maxFields: 3
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    const detail = await services.routePlanService.assignRoutePlanDriver({
      payload: { driverId: readOptionalField(fields, 'driverId') },
      routePlanId,
      shopDomain
    });
    if (detail === null) {
      return redirectToRoutePlans(reply, {
        error: 'Route plan not found for this shop.',
        shopDomain
      });
    }
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice: detail.routePlan.driverId === null ? 'Route driver assignment removed.' : 'Route driver assigned.',
      routePlanId,
      shopDomain
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

async function handleRouteOptimize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken', 'shopDomain'],
      maxFields: 2
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    assertWpPluginShopAccess(session, shopDomain);
    const detail = await services.routePlanService.getRoutePlanDetail({ routePlanId, shopDomain });
    if (detail === null) {
      return redirectToRoutePlans(reply, {
        error: 'Route plan not found for this shop.',
        shopDomain
      });
    }
    const optimized = buildOptimizedStopOrder(detail);
    await services.routePlanService.updateRoutePlanStops({
      payload: { stops: optimized.stops },
      routePlanId,
      shopDomain
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice:
        optimized.missingCoordinateStops === 0
          ? 'CLEVER v1 optimized sequence saved.'
          : `CLEVER v1 optimized sequence saved; ${optimized.missingCoordinateStops} stop(s) without coordinates stayed at the end.`,
      routePlanId,
      shopDomain
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain })
    });
  }
}

function readSession(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies
): AdminWebSession | null {
  const session = verifyAdminWebSessionFromRequest({
    request,
    sessionSecret: dependencies.sessionSecret,
    ...(dependencies.cookieName === undefined ? {} : { cookieName: dependencies.cookieName }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now })
  });
  if (session === null) return null;
  return session;
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies
): Promise<unknown> {
  const session = readSession(request, dependencies);
  if (session === null) {
    return redirectWithClearedSession(reply, dependencies);
  }

  try {
    assertSameOriginMutation(request, dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ['csrfToken'],
      maxFields: 1
    });
    assertValidCsrf(session, fields.csrfToken);
    return redirectWithClearedSession(reply, dependencies);
  } catch (error) {
    return sendUiError(reply, request, dependencies, session, error);
  }
}

function redirectWithClearedSession(
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies
): unknown {
  return reply
    .code(303)
    .header('Set-Cookie', sessionClearCookieHeaders(dependencies))
    .header('Location', ADMIN_UI_LOGIN_PATH)
    .send('');
}

function sessionSetCookieHeaders(
  dependencies: AdminCommerceConnectionsUiDependencies,
  sessionCookieHeader: string
): string[] {
  return [sessionCookieHeader, ...clearLegacySessionCookieHeaders(dependencies)];
}

function sessionClearCookieHeaders(dependencies: AdminCommerceConnectionsUiDependencies): string[] {
  return [
    clearAdminWebSessionCookie({
      secure: dependencies.secureCookies,
      ...(dependencies.cookieName === undefined ? {} : { cookieName: dependencies.cookieName })
    }),
    ...clearLegacySessionCookieHeaders(dependencies)
  ];
}

function clearLegacySessionCookieHeaders(dependencies: AdminCommerceConnectionsUiDependencies): string[] {
  const input = {
    secure: dependencies.secureCookies,
    ...(dependencies.cookieName === undefined ? {} : { cookieName: dependencies.cookieName })
  };
  return [clearLegacyAdminWebSessionCookie(input), ...clearBroadLegacyAdminWebSessionCookies(input)];
}

async function renderHome(
  reply: FastifyReply,
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: {
    currentShopDomain?: string | null;
    error?: string;
    notice?: string;
    statusCode?: number;
    webhookSetup?: WebhookSetupView;
  }
): Promise<unknown> {
  let connections: SafeConnectionWithDelivery[] = [];
  let error = input.error;
  let statusCode = input.statusCode;
  let currentShopDomain: string | null = null;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.currentShopDomain);
  } catch (normalizeError) {
    error = error ?? sanitizeErrorMessage(normalizeError);
    statusCode = statusCode ?? (normalizeError instanceof WooCommerceOnboardingError ? normalizeError.httpStatus : 400);
  }

  if (currentShopDomain !== null) {
    try {
      const listed = await dependencies.onboardingService.listConnections({
        actor: dependencies.actor,
        shopDomain: currentShopDomain
      });
      connections = listed.map((connection) => withWebhookDelivery(request, dependencies, connection));
    } catch (loadError) {
      error = error ?? sanitizeErrorMessage(loadError);
    }
  }

  return sendHtml(
    reply,
    error === undefined ? 200 : statusCode ?? 400,
    renderHomePage({
      actor: dependencies.actor,
      connections,
      csrfToken: session.csrfToken,
      currentShopDomain,
      ...(error === undefined ? {} : { error }),
      ...(input.notice === undefined ? {} : { notice: input.notice }),
      ...(input.webhookSetup === undefined ? {} : { webhookSetup: input.webhookSetup })
    })
  );
}

function sendUiError(
  reply: FastifyReply,
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession | null,
  error: unknown,
  currentShopDomain?: string | null
): unknown {
  const status = error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
  if (!(error instanceof WooCommerceOnboardingError)) {
    request.log.error({ event: 'admin_commerce_connection_ui_failed' }, 'admin commerce connection UI failed');
  }
  if (session === null) {
    return sendHtml(reply, status, renderLoginPage({ error: sanitizeErrorMessage(error) }));
  }
  return renderHome(reply, request, dependencies, session, {
    error: sanitizeErrorMessage(error),
    statusCode: status,
    ...(currentShopDomain === undefined ? {} : { currentShopDomain })
  });
}

function sendHtml(reply: FastifyReply, statusCode: number, body: string): unknown {
  return reply
    .code(statusCode)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', ADMIN_UI_CSP)
    .send(body);
}

function sendJson(reply: FastifyReply, statusCode: number, body: { message: string; ok: boolean }): unknown {
  return reply
    .code(statusCode)
    .type('application/json; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(body);
}

function redirect(reply: FastifyReply, location: string): unknown {
  return reply.code(303).header('Location', location).send('');
}

function redirectToWooCommerceHome(
  reply: FastifyReply,
  input: { currentShopDomain?: string | null; error?: string; notice?: string }
): unknown {
  const params = new URLSearchParams();
  if (input.currentShopDomain !== undefined && input.currentShopDomain !== null && input.currentShopDomain.trim() !== '') {
    params.set('shopDomain', input.currentShopDomain.trim());
  }
  if (input.error !== undefined && input.error.trim() !== '') {
    params.set('error', truncateUiMessage(input.error));
  }
  if (input.notice !== undefined && input.notice.trim() !== '') {
    params.set('notice', truncateUiMessage(input.notice));
  }
  const query = params.toString();
  return redirect(reply, query === '' ? ADMIN_UI_WOOCOMMERCE_PATH : `${ADMIN_UI_WOOCOMMERCE_PATH}?${query}`);
}

function redirectToAdminModule(
  reply: FastifyReply,
  path: string,
  input: { deliveryDate?: string | null; error?: string; notice?: string; shopDomain?: string | null }
): unknown {
  const params = new URLSearchParams();
  if (input.shopDomain !== undefined && input.shopDomain !== null && input.shopDomain.trim() !== '') {
    params.set('shopDomain', input.shopDomain.trim());
  }
  if (input.deliveryDate !== undefined && input.deliveryDate !== null && input.deliveryDate.trim() !== '') {
    params.set('deliveryDate', input.deliveryDate.trim());
  }
  if (input.error !== undefined && input.error.trim() !== '') {
    params.set('error', truncateUiMessage(input.error));
  }
  if (input.notice !== undefined && input.notice.trim() !== '') {
    params.set('notice', truncateUiMessage(input.notice));
  }
  const query = params.toString();
  return redirect(reply, query === '' ? path : `${path}?${query}`);
}

function redirectWpPluginSessionToOperate(
  reply: FastifyReply,
  session: AdminWebSession,
  error?: string
): unknown {
  return redirectToAdminModule(reply, ADMIN_UI_APP_ORDERS_PATH, {
    ...(error === undefined ? {} : { error }),
    shopDomain: readWpPluginSessionShopDomain(session)
  });
}

function assertValidCsrf(session: AdminWebSession, token: string | null | undefined): void {
  if (!verifyAdminWebCsrfToken({ session, token })) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Invalid admin UI CSRF token', 400);
  }
}

function assertSameOriginMutation(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies
): void {
  const fetchSite = readHeader(request.headers['sec-fetch-site'])?.toLowerCase();
  const expectedOrigin = normalizeOrigin(resolveBaseUrl(request, dependencies));
  const origin = readHeader(request.headers.origin)?.replace(/\/+$/u, '');
  const referer = readHeader(request.headers.referer);

  if (
    fetchSite !== undefined &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'same-site' &&
    fetchSite !== 'none'
  ) {
    request.log.warn(
      {
        event: 'admin_ui_fetch_metadata_false_positive',
        fetchSite,
        originMatches: origin === undefined ? null : normalizeOrigin(origin) === expectedOrigin,
        refererMatches: referer === undefined ? null : normalizeOrigin(referer) === expectedOrigin
      },
      'Admin UI browser metadata did not match the canonical origin; CSRF remains the mutation gate'
    );
  }

  // Browser origin/fetch metadata is inconsistent in Safari and behind
  // reverse proxies, especially after form-resubmission prompts. The admin UI
  // uses SameSite=Strict HttpOnly sessions plus per-session CSRF tokens as the
  // authoritative mutation gate, so metadata is diagnostic only.
}

async function requireConnectionMatchesShop(input: {
  actor: AdminCommerceActor;
  connectionId: string;
  dependencies: AdminCommerceConnectionsUiDependencies;
  shopDomain: string;
}): Promise<SafeWooCommerceConnection> {
  const expectedShopDomain = normalizeRequiredShopDomain(input.shopDomain);
  const connection = await input.dependencies.onboardingService.getConnection({
    actor: input.actor,
    connectionId: input.connectionId
  });
  if (connection.shopDomain !== expectedShopDomain) {
    throw new WooCommerceOnboardingError(
      'FORBIDDEN',
      'Connection shopDomain does not match the current admin UI context',
      403
    );
  }
  return connection;
}

function readCredentialFields(fields: Record<string, string>): {
  consumerKey: string;
  consumerSecret: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecret: string | null;
} {
  return {
    consumerKey: readRequiredField(fields, 'wooConsumerKey', 'WooCommerce consumer key'),
    consumerSecret: readRequiredField(fields, 'wooConsumerSecret', 'WooCommerce consumer secret'),
    label: readOptionalField(fields, 'label'),
    shopDomain: readRequiredField(fields, 'shopDomain', 'shopDomain'),
    siteUrl: readRequiredField(fields, 'siteUrl', 'WooCommerce site URL'),
    timezone: readOptionalField(fields, 'timezone'),
    webhookSecret: readOptionalField(fields, 'webhookSecret')
  };
}

function credentialFieldNames(): readonly string[] {
  return [
    'csrfToken',
    'label',
    'shopDomain',
    'siteUrl',
    'timezone',
    'wooConsumerKey',
    'wooConsumerSecret',
    'webhookSecret'
  ];
}

function readRequiredField(fields: Record<string, string>, field: string, label: string): string {
  const value = fields[field];
  if (value === undefined || value.trim() === '') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${label} is required`, 400);
  }
  return value.trim();
}

function readOptionalField(fields: Record<string, string>, field: string): string | null {
  const value = fields[field];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

function readStatusField(value: string | undefined): 'ACTIVE' | 'DISABLED' {
  if (value === 'ACTIVE' || value === 'DISABLED') return value;
  throw new WooCommerceOnboardingError('BAD_REQUEST', 'status must be ACTIVE or DISABLED', 400);
}

function readQueryString(query: unknown, field: string): string | null {
  if (query === null || typeof query !== 'object') return null;
  const value = (query as Record<string, unknown>)[field];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function truncateUiMessage(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 320 ? trimmed : `${trimmed.slice(0, 317)}...`;
}

function optionalUiMessage<K extends 'error' | 'notice'>(key: K, value: string | null): { [P in K]?: string } {
  return value === null ? {} : ({ [key]: truncateUiMessage(value) } as { [P in K]?: string });
}

function normalizeOptionalShopDomain(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return normalizeRequiredShopDomain(value);
}

function normalizeRequiredShopDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '');
  if (normalized === '' || normalized.length > 255 || !/^[a-z0-9.-]+$/u.test(normalized)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'shopDomain is invalid', 400);
  }
  return normalized;
}

function assertWpPluginShopAccess(session: AdminWebSession, requestedShopDomain: string | null): void {
  const authorizedShopDomain = readWpPluginSessionShopDomain(session);
  if (authorizedShopDomain === null || requestedShopDomain === null) return;
  if (requestedShopDomain !== authorizedShopDomain) {
    throw new WooCommerceOnboardingError(
      'FORBIDDEN',
      'WordPress-launched admin session is limited to its connected shopDomain.',
      403
    );
  }
}

function readWpPluginSessionShopDomain(session: AdminWebSession): string | null {
  const prefix = 'wordpress-plugin:';
  if (!session.subject.startsWith(prefix)) return null;
  return normalizeOptionalShopDomain(session.subject.slice(prefix.length));
}

function isWpPluginSession(session: AdminWebSession): boolean {
  return readWpPluginSessionShopDomain(session) !== null;
}

function withWebhookDelivery(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  connection: SafeWooCommerceConnection
): SafeConnectionWithDelivery {
  assertSafeConnectionForRender(connection);
  const deliveryPath = `/woocommerce/webhooks/${connection.id}/orders`;
  return {
    ...connection,
    webhook: {
      ...connection.webhook,
      deliveryPath,
      deliveryUrl: `${resolveBaseUrl(request, dependencies)}${deliveryPath}`
    }
  };
}

function toWebhookSetup(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  result: WooCommerceOnboardingResult
): WebhookSetupView {
  const connection = withWebhookDelivery(request, dependencies, result.connection);
  return {
    deliveryPath: connection.webhook.deliveryPath,
    deliveryUrl: connection.webhook.deliveryUrl,
    oneTimeSecret: result.webhookSetup?.oneTimeSecret ?? null
  };
}

function resolveBaseUrl(request: FastifyRequest, dependencies: AdminCommerceConnectionsUiDependencies): string {
  const configured = dependencies.publicBaseUrl?.trim().replace(/\/+$/u, '');
  if (configured !== undefined && configured !== '') return configured;

  const forwardedHost = readHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? readHeader(request.headers.host) ?? 'localhost';
  const forwardedProto = readHeader(request.headers['x-forwarded-proto']);
  const proto = forwardedProto ?? 'http';
  return `${proto}://${host}`.replace(/\/+$/u, '');
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim().replace(/\/+$/u, '');
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function wantsJson(request: FastifyRequest): boolean {
  return readHeader(request.headers.accept)?.toLowerCase().includes('application/json') ?? false;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof WooCommerceOnboardingError) return error.message;
  return 'Admin UI request failed';
}

function assertSafeConnectionForRender(connection: SafeWooCommerceConnection): void {
  const unsafe = connection as Record<string, unknown>;
  for (const field of [
    'consumerKey',
    'consumerKeyCiphertext',
    'consumerSecret',
    'consumerSecretCiphertext',
    'webhookSecret',
    'webhookSecretCiphertext'
  ]) {
    if (Object.prototype.hasOwnProperty.call(unsafe, field)) {
      throw new WooCommerceOnboardingError('BAD_REQUEST', 'Unsafe commerce connection render payload', 400);
    }
  }
}

type WebhookSetupView = {
  deliveryPath: string;
  deliveryUrl: string;
  oneTimeSecret: string | null;
};

type RouteUiServices = {
  driverService?: NonNullable<AdminCommerceConnectionsUiDependencies['driverService']>;
  orderSyncService: NonNullable<AdminCommerceConnectionsUiDependencies['orderSyncService']>;
  routePlanService: NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>;
};

function readRouteUiServices(dependencies: AdminCommerceConnectionsUiDependencies): RouteUiServices | null {
  if (dependencies.orderSyncService === undefined || dependencies.routePlanService === undefined) {
    return null;
  }
  return {
    ...(dependencies.driverService === undefined ? {} : { driverService: dependencies.driverService }),
    orderSyncService: dependencies.orderSyncService,
    routePlanService: dependencies.routePlanService
  };
}

function requireRouteUiServices(dependencies: AdminCommerceConnectionsUiDependencies): RouteUiServices {
  const services = readRouteUiServices(dependencies);
  if (services === null) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Route planning services are not enabled in this runtime.', 400);
  }
  return services;
}

function readSelectedOrderGids(value: string): string[] {
  const gids = value
    .split(/[\r\n,]+/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (gids.length === 0) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Select at least one ready order before creating a route.', 400);
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const gid of gids) {
    if (seen.has(gid)) {
      duplicates.push(gid);
      continue;
    }
    seen.add(gid);
  }
  if (duplicates.length > 0) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Selected orders contain duplicates. Clear the selection and try again.', 400);
  }
  return gids;
}

function selectRouteReadyOrders(input: {
  orders: readonly CanonicalOrderRow[];
  planDate: string;
  selectedOrderGids: readonly string[];
}): CanonicalOrderRow[] {
  const ordersByGid = new Map(input.orders.map((order) => [order.shopifyOrderGid, order]));
  const blockers: string[] = [];
  const selected: CanonicalOrderRow[] = [];

  for (const gid of input.selectedOrderGids) {
    const order = ordersByGid.get(gid);
    if (order === undefined) {
      blockers.push(`${gid}: not found for this shop/date`);
      continue;
    }
    const orderBlockers = readRouteCreationBlockers(order, input.planDate);
    if (orderBlockers.length > 0) {
      blockers.push(`${order.sourceOrderNumber ?? order.name}: ${orderBlockers.join(', ')}`);
      continue;
    }
    selected.push(order);
  }

  if (blockers.length > 0) {
    throw new WooCommerceOnboardingError(
      'BAD_REQUEST',
      `Cannot create a partial route. Fix or remove blocked selected orders first: ${blockers.join('; ')}`,
      400
    );
  }

  return selected;
}

function readRouteCreationBlockers(order: CanonicalOrderRow, planDate: string): string[] {
  const blockers: string[] = [];
  if (order.deliveryDate !== planDate) {
    blockers.push('delivery date does not match the route date');
  }
  if (order.readiness !== 'READY_TO_PLAN') {
    const reasons = order.reviewReasons.length === 0 ? 'needs delivery metadata review' : order.reviewReasons.join(', ');
    blockers.push(`needs review (${reasons})`);
  }
  if (order.planningStatus !== 'UNPLANNED' || order.routePlanId !== null) {
    blockers.push('already assigned to a route');
  }
  if (!order.hasCoordinates || order.latitude === null || order.longitude === null) {
    blockers.push('missing delivery coordinates');
  }
  return blockers;
}

function buildCreateRoutePlanPayload(input: {
  depotAddress: string | null;
  depotLatitude: number | null;
  depotLongitude: number | null;
  orders: CanonicalOrderRow[];
  planDate: string;
  routeName: string;
}): CreateRoutePlanPayload {
  const orders = input.orders.map((order) => toRoutePlanOrderInput(order));
  return {
    depot: {
      address: input.depotAddress,
      latitude: input.depotLatitude,
      longitude: input.depotLongitude
    },
    name: input.routeName,
    orders,
    planDate: input.planDate,
    ...readSharedRouteScope(orders, input.planDate)
  };
}

function toRoutePlanOrderInput(order: CanonicalOrderRow): RoutePlanOrderInput {
  return {
    attributes: [
      ...(order.sourcePlatform === undefined ? [] : [{ key: 'sourcePlatform', value: order.sourcePlatform }]),
      ...(order.sourceOrderNumber === undefined || order.sourceOrderNumber === null
        ? []
        : [{ key: 'sourceOrderNumber', value: order.sourceOrderNumber }])
    ],
    currencyCode: order.currencyCode,
    deliveryArea: order.deliveryArea,
    deliveryDate: order.deliveryDate,
    deliveryDay: order.deliveryDayRaw ?? order.deliveryWeekday,
    deliverySession: order.deliverySession,
    email: order.email,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    latitude: order.latitude,
    longitude: order.longitude,
    name: order.name,
    phone: order.phone,
    planningGroupKey: order.planningGroupKey,
    processedAt: order.processedAt === null ? null : new Date(order.processedAt),
    rawPayload: {
      deliveryDate: order.deliveryDate,
      deliverySession: order.deliverySession,
      planningGroupKey: order.planningGroupKey,
      routeScopeKey: order.routeScopeKey,
      serviceType: order.serviceType,
      sourceOrderId: order.sourceOrderId ?? null,
      sourceOrderNumber: order.sourceOrderNumber ?? null,
      sourcePlatform: order.sourcePlatform ?? null,
      sourceSiteUrl: order.sourceSiteUrl ?? null,
      timeWindowEnd: order.timeWindowEnd,
      timeWindowStart: order.timeWindowStart
    },
    recipientName: order.recipientName,
    routeScopeKey: order.routeScopeKey,
    serviceType: order.serviceType,
    shippingAddress: order.shippingAddress,
    shopifyOrderGid: order.shopifyOrderGid,
    timeWindowEnd: order.timeWindowEnd,
    timeWindowStart: order.timeWindowStart,
    totalPriceAmount: order.totalPriceAmount
  };
}

function readSharedRouteScope(
  orders: RoutePlanOrderInput[],
  planDate: string
): { routeScope?: RoutePlanRouteScopeInput } {
  const first = orders[0];
  if (
    first === undefined ||
    first.routeScopeKey === null ||
    first.routeScopeKey === undefined ||
    first.deliveryDate !== planDate ||
    first.deliverySession === null ||
    first.deliverySession === undefined ||
    first.serviceType === null ||
    first.serviceType === undefined
  ) {
    return {};
  }
  if (
    orders.some(
      (order) =>
        order.routeScopeKey !== first.routeScopeKey ||
        order.deliveryDate !== first.deliveryDate ||
        order.deliverySession !== first.deliverySession ||
        order.serviceType !== first.serviceType ||
        order.timeWindowStart !== first.timeWindowStart ||
        order.timeWindowEnd !== first.timeWindowEnd
    )
  ) {
    return {};
  }
  return {
    routeScope: {
      deliveryDate: planDate,
      deliverySession: first.deliverySession,
      routeScopeKey: first.routeScopeKey,
      serviceType: first.serviceType,
      timeWindowEnd: first.timeWindowEnd ?? null,
      timeWindowStart: first.timeWindowStart ?? null
    }
  };
}

function readStopOrderLines(
  value: string,
  detail: RoutePlanDetail
): Array<{ deliveryStopId: string; sequence: number; shopifyOrderGid: string }> {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const byGid = new Map(detail.stops.map((stop) => [stop.shopifyOrderGid, stop]));
  if (lines.length !== detail.stops.length) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Stop order must include every current route stop exactly once.', 400);
  }
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const shopifyOrderGid = line.split(/\s+/u)[0] ?? '';
    const stop = byGid.get(shopifyOrderGid);
    if (stop === undefined || seen.has(shopifyOrderGid)) {
      throw new WooCommerceOnboardingError('BAD_REQUEST', 'Stop order contains an unknown or duplicate order id.', 400);
    }
    seen.add(shopifyOrderGid);
    return {
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid
    };
  });
}

function buildOptimizedStopOrder(detail: RoutePlanDetail): {
  missingCoordinateStops: number;
  stops: Array<{ deliveryStopId: string; sequence: number; shopifyOrderGid: string }>;
} {
  const sortableStops = detail.stops
    .map((stop) => ({ coordinates: readStopCoordinates(stop), stop }))
    .filter((entry): entry is { coordinates: { latitude: number; longitude: number }; stop: RoutePlanDetail['stops'][number] } =>
      entry.coordinates !== null
    )
    .sort((left, right) => left.stop.sequence - right.stop.sequence || left.stop.shopifyOrderGid.localeCompare(right.stop.shopifyOrderGid));
  const missingStops = detail.stops
    .filter((stop) => readStopCoordinates(stop) === null)
    .sort((left, right) => left.sequence - right.sequence || left.shopifyOrderGid.localeCompare(right.shopifyOrderGid));

  const depot = readDepotCoordinates(detail.routePlan);
  let origin = depot ?? sortableStops[0]?.coordinates ?? null;
  const ordered: RoutePlanDetail['stops'][number][] = [];
  const remaining = [...sortableStops];

  while (remaining.length > 0) {
    if (origin === null) {
      ordered.push(...remaining.map((entry) => entry.stop));
      remaining.length = 0;
      break;
    }
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) continue;
      const distance = haversineMeters(origin, candidate.coordinates);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance &&
          candidate.stop.shopifyOrderGid.localeCompare(remaining[nearestIndex]?.stop.shopifyOrderGid ?? '') < 0)
      ) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    }
    const [next] = remaining.splice(nearestIndex, 1);
    if (next === undefined) break;
    ordered.push(next.stop);
    origin = next.coordinates;
  }

  const stops = [...ordered, ...missingStops].map((stop, index) => ({
    deliveryStopId: stop.deliveryStopId,
    sequence: index + 1,
    shopifyOrderGid: stop.shopifyOrderGid
  }));

  return { missingCoordinateStops: missingStops.length, stops };
}

function readDepotCoordinates(routePlan: RoutePlanSummary): { latitude: number; longitude: number } | null {
  const latitude = routePlan.depot.latitude;
  const longitude = routePlan.depot.longitude;
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function readStopCoordinates(stop: RoutePlanDetail['stops'][number]): { latitude: number; longitude: number } | null {
  const latitude = stop.coordinates.latitude;
  const longitude = stop.coordinates.longitude;
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function haversineMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number {
  const earthRadiusMeters = 6_371_000;
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const deltaLatitude = toRadians(right.latitude - left.latitude);
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeOptionalDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return normalizeRequiredDate(value);
}

function normalizeOptionalText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (trimmed.length > 128) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${field} is too long`, 400);
  }
  return trimmed;
}

function normalizeOperateDeliveryStatus(value: string | null | undefined): OperateDeliveryStatus | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (isOperateDeliveryStatus(trimmed)) return trimmed;
  throw new WooCommerceOnboardingError('BAD_REQUEST', 'delivery status filter is invalid', 400);
}

function normalizeOrderHealth(value: string | null | undefined): OrderHealth | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (isOrderHealth(trimmed)) return trimmed;
  throw new WooCommerceOnboardingError('BAD_REQUEST', 'order health filter is invalid', 400);
}

function normalizeRequiredDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'date must be YYYY-MM-DD', 400);
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'date must be a real calendar date', 400);
  }
  return trimmed;
}

function readOptionalCoordinate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -180 || parsed > 180) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'coordinate must be a finite number', 400);
  }
  return parsed;
}

function readLocaleField(value: string | undefined): string {
  const locale = value?.trim() || 'en-CA';
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(locale)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'language must be a locale such as en-CA or ko-KR', 400);
  }
  return locale;
}

function sanitizeRouteUiError(error: unknown): string {
  if (error instanceof RoutePlanOrderAlreadyPlannedError) {
    return 'Some selected orders are already assigned to a route. Refresh the page and try again.';
  }
  if (error instanceof RoutePlanDriverAssignInvalidError) {
    return error.message;
  }
  if (error instanceof RoutePlanStopUpdateInvalidError) {
    return error.message;
  }
  return sanitizeErrorMessage(error);
}

function redirectToRoutePlans(
  reply: FastifyReply,
  input: {
    deliveryDate?: string | null;
    error?: string;
    notice?: string;
    routePlanId?: string | null;
    shopDomain?: string | null;
  }
): unknown {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value.trim() !== '') {
      params.set(key, key === 'error' || key === 'notice' ? truncateUiMessage(value) : value);
    }
  }
  const query = params.toString();
  if (input.routePlanId !== undefined && input.routePlanId !== null && input.routePlanId.trim() !== '') {
    const routePlanId = input.routePlanId.trim();
    params.delete('routePlanId');
    const routeQuery = params.toString();
    return redirect(
      reply,
      routeQuery === ''
        ? `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${encodeURIComponent(routePlanId)}`
        : `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${encodeURIComponent(routePlanId)}?${routeQuery}`
    );
  }
  return redirect(reply, query === '' ? ADMIN_UI_APP_ROUTE_PLANS_PATH : `${ADMIN_UI_APP_ROUTE_PLANS_PATH}?${query}`);
}

function filterRoutePlansByDate(
  routePlans: readonly RoutePlanSummary[],
  deliveryDate: string | null
): RoutePlanSummary[] {
  if (deliveryDate === null) return [...routePlans];
  return routePlans.filter((routePlan) => routePlanMatchesDate(routePlan, deliveryDate));
}

function routePlanMatchesDate(routePlan: RoutePlanSummary, deliveryDate: string | null): boolean {
  return deliveryDate === null || routePlan.planDate === deliveryDate || routePlan.deliveryDate === deliveryDate;
}

function renderShopDomainControl(input: {
  currentShopDomain: string;
  locked: boolean;
  placeholder?: string;
}): string {
  if (input.locked) {
    const displayValue = input.currentShopDomain === '' ? 'No connected WordPress shop' : input.currentShopDomain;
    return `<label>Customer shop domain
      <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
      <span class="readonly-field">${escapeHtml(displayValue)}</span>
      <span class="field-help">Locked to the WordPress shop that launched this workspace.</span>
    </label>`;
  }

  return `<label>Customer shop domain
    <input type="text" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" placeholder="${escapeHtml(input.placeholder ?? 'dev1.tomatonofood.com')}" required />
  </label>`;
}

function renderAppDashboardPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  drivers: readonly AdminDriverRow[];
  error?: string;
  notice?: string;
  readyOrders: readonly CanonicalOrderRow[];
  reviewOrders: readonly CanonicalOrderRow[];
  routePlans: readonly RoutePlanSummary[];
  settings: AdminStoreSettings | null;
  shopDomainLocked: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  const today = new Date().toISOString().slice(0, 10);
  return renderDocument({
    body: `<main class="shell app-shell">
      ${renderAdminHero({
        active: 'dashboard',
        allowConnectionSetup: !input.shopDomainLocked,
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Daily route operations for the WordPress store launched from the CLEVER Route plugin.',
        title: 'Route dashboard'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      <section class="app-kpis" aria-label="Route operation summary">
        ${renderKpiCard('Ready orders', String(input.readyOrders.length), 'Selectable Woo orders not assigned to a route.')}
        ${renderKpiCard('Needs review', String(input.reviewOrders.length), 'Orders blocked by delivery metadata issues.')}
        ${renderKpiCard('Routes', String(input.routePlans.length), 'Saved route drafts and active route plans.')}
        ${renderKpiCard('Drivers', String(input.drivers.length), 'Delivery people available for assignment.')}
      </section>
      <section class="dashboard-grid" aria-label="Route app actions">
        ${renderModuleCard({
          description: 'Filter WooCommerce orders by date, area, delivery status, and health. Select ready rows before route creation.',
          href: withShopDomainQuery(ADMIN_UI_APP_ORDERS_PATH, currentShopDomain),
          status: 'Ready',
          title: '1. Orders'
        })}
        ${renderModuleCard({
          description: 'Create a route from selected orders, review the route canvas, reorder stops, optimize, and assign a driver.',
          href: `${withShopDomainQuery(ADMIN_UI_APP_ROUTE_PLANS_PATH, currentShopDomain)}${currentShopDomain === '' ? '?' : '&'}deliveryDate=${today}`,
          status: 'Ready',
          title: '2. Routes'
        })}
        ${renderModuleCard({
          description: 'Create driver invites and keep the assignment list ready for route dispatch.',
          href: withShopDomainQuery(ADMIN_UI_APP_DRIVERS_PATH, currentShopDomain),
          status: 'Ready',
          title: '3. Drivers'
        })}
        ${renderModuleCard({
          description: `Store/depot: ${input.settings?.defaultDepotAddress ?? 'not configured yet'}. Set address, coordinates, and operator language.`,
          href: withShopDomainQuery(ADMIN_UI_APP_SETTINGS_PATH, currentShopDomain),
          status: 'Ready',
          title: '4. Settings'
        })}
      </section>
    </main>`,
    title: 'CLEVER Route App Dashboard'
  });
}

function renderRoutePlansPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  deliveryDate: string | null;
  drivers: readonly AdminDriverRow[];
  error?: string;
  notice?: string;
  readyOrders: readonly CanonicalOrderRow[];
  reviewOrders: readonly CanonicalOrderRow[];
  routeDetail: RoutePlanDetail | null;
  routePlans: readonly RoutePlanSummary[];
  servicesEnabled: boolean;
  settings: AdminStoreSettings | null;
  shopDomainLocked: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  const deliveryDate = input.deliveryDate ?? new Date().toISOString().slice(0, 10);
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'route-plans',
        allowConnectionSetup: !input.shopDomainLocked,
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Create and operate route drafts from selected WooCommerce orders. WordPress stays as setup/status; route building lives here.',
        title: 'Routes'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      ${input.servicesEnabled ? '' : '<p class="alert error">Route planning services are not enabled in this runtime.</p>'}
      <section class="setup-layout">
        <div class="setup-main">
          <article class="card">
            <p class="eyebrow">Route workspace</p>
            <h2>Create route for date</h2>
            <p class="muted">Choose a customer shop and delivery date, then select exact ready orders. CLEVER opens a Route Builder with map canvas, stop sequence, driver assignment, and v1 optimization.</p>
            <form method="get" action="${ADMIN_UI_APP_ROUTE_PLANS_PATH}" class="stack guided-form">
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <label>Delivery date
                <input type="date" name="deliveryDate" value="${escapeHtml(deliveryDate)}" required />
              </label>
              <button type="submit">Load route workspace</button>
            </form>
          </article>
          ${renderRouteCreateCard({
            csrfToken: input.csrfToken,
            currentShopDomain,
            deliveryDate,
            disabled: !input.servicesEnabled || input.currentShopDomain === null || input.readyOrders.length === 0,
            readyOrders: input.readyOrders,
            settings: input.settings
          })}
          ${renderRouteDetailCard({
            csrfToken: input.csrfToken,
            currentShopDomain,
            drivers: input.drivers,
            routeDetail: input.routeDetail
          })}
        </div>
        <aside class="setup-aside">
          ${renderRouteStatsCard(input.readyOrders, input.reviewOrders)}
          ${renderRoutePlansList(input.routePlans, input.currentShopDomain, input.deliveryDate)}
        </aside>
      </section>
      ${renderOrdersPreview(input.readyOrders, input.reviewOrders)}
    </main>`,
    title: 'CLEVER Route Open Route'
  });
}

function renderOrdersPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  deliveryArea: string | null;
  deliveryDate: string | null;
  error?: string;
  notice?: string;
  operateDeliveryStatus: OperateDeliveryStatus | null;
  orderHealth: OrderHealth | null;
  orders: readonly CanonicalOrderRow[];
  reviewOrders: readonly CanonicalOrderRow[];
  search: string | null;
  shopDomainLocked: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  const deliveryArea = input.deliveryArea ?? '';
  const deliveryDate = input.deliveryDate ?? '';
  const operateDeliveryStatus = input.operateDeliveryStatus ?? '';
  const orderHealth = input.orderHealth ?? '';
  const search = input.search ?? '';
  const defaultRouteDate =
    input.deliveryDate ?? input.orders.find((order) => order.deliveryDate !== null)?.deliveryDate ?? new Date().toISOString().slice(0, 10);
  const selectableOrders = input.orders.filter(
    (order) =>
      order.deliveryDate === defaultRouteDate &&
      order.readiness === 'READY_TO_PLAN' &&
      order.planningStatus === 'UNPLANNED' &&
      order.routePlanId === null
  );
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'orders',
        allowConnectionSetup: !input.shopDomainLocked,
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Review WooCommerce orders before route creation. Orders needing delivery metadata review stay visible here before they can be routed.',
        title: 'Orders'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      <section class="setup-layout">
        <div class="setup-main">
          <article class="card">
            <p class="eyebrow">Orders</p>
            <h2>Order list</h2>
            <p class="muted">Load the customer shop to inspect imported WooCommerce orders, routing readiness, and review blockers.</p>
            <form method="get" action="${ADMIN_UI_APP_ORDERS_PATH}" class="stack guided-form">
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <label>Delivery date
                <input type="date" name="deliveryDate" value="${escapeHtml(deliveryDate)}" />
              </label>
              <label>Area / region
                <input type="text" name="deliveryArea" value="${escapeHtml(deliveryArea)}" placeholder="Toronto" />
              </label>
              <label>Delivery status
                <select name="operateDeliveryStatus">
                  ${renderSelectOption(operateDeliveryStatus, '', 'All delivery statuses')}
                  ${renderSelectOption(operateDeliveryStatus, 'preparing', 'Preparing / needs work')}
                  ${renderSelectOption(operateDeliveryStatus, 'ready', 'Ready to route')}
                  ${renderSelectOption(operateDeliveryStatus, 'in_progress', 'In progress / planned')}
                  ${renderSelectOption(operateDeliveryStatus, 'completed', 'Completed')}
                </select>
              </label>
              <label>Order health
                <select name="orderHealth">
                  ${renderSelectOption(orderHealth, '', 'All health states')}
                  ${renderSelectOption(orderHealth, 'normal', 'Normal')}
                  ${renderSelectOption(orderHealth, 'needs_review', 'Needs review')}
                </select>
              </label>
              <label>Search
                <input type="search" name="search" value="${escapeHtml(search)}" placeholder="#1001, email, phone" />
              </label>
              <button type="submit">Filter orders</button>
            </form>
          </article>
          <article class="card">
            <p class="eyebrow">Operate orders</p>
            <h2>Filtered order list</h2>
            ${renderOrderRows(input.orders, currentShopDomain === '' ? 'Enter a shop domain to load orders.' : 'No orders match the current filters.')}
          </article>
        </div>
        <aside class="setup-aside">
          <article class="card">
            <p class="eyebrow">Needs review</p>
            <h2>Delivery metadata blockers</h2>
            <p class="muted">These orders are blocked from automatic route creation until the delivery date/session/address mapping is fixed.</p>
            ${renderOrderRows(input.reviewOrders, 'No orders currently need delivery metadata review.')}
          </article>
          ${renderRouteCreateCard({
            csrfToken: input.csrfToken,
            currentShopDomain,
            deliveryDate: defaultRouteDate,
            disabled: currentShopDomain === '' || selectableOrders.length === 0,
            readyOrders: selectableOrders,
            settings: null
          })}
          <article class="card">
            <p class="eyebrow">Route Builder</p>
            <h2>Open saved routes</h2>
            <p class="muted">After creating a route draft, review map canvas, optimize, reorder stops, and assign drivers from Routes.</p>
            <a class="button-link" href="${buildRoutePlansHref(currentShopDomain, input.deliveryDate)}">Open Routes</a>
          </article>
        </aside>
      </section>
    </main>`,
    title: 'CLEVER Route Orders'
  });
}

function renderDriversPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  drivers: readonly AdminDriverRow[];
  error?: string;
  notice?: string;
  shopDomainLocked: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'drivers',
        allowConnectionSetup: !input.shopDomainLocked,
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Manage the delivery people connected to a customer shop. Invite codes are generated server-side and never expose the connector token.',
        title: 'Drivers'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      <section class="setup-layout">
        <div class="setup-main">
          <article class="card">
            <p class="eyebrow">Drivers</p>
            <h2>Driver management</h2>
            <form method="get" action="${ADMIN_UI_APP_DRIVERS_PATH}" class="stack guided-form">
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <button type="submit">Load drivers</button>
            </form>
          </article>
          <article class="card">
            <p class="eyebrow">Driver list</p>
            <h2>Delivery people</h2>
            ${renderDriverRows(input.drivers, currentShopDomain === '' ? 'Enter a shop domain to load drivers.' : 'No drivers saved for this shop.')}
          </article>
        </div>
        <aside class="setup-aside">
          <article class="card">
            <p class="eyebrow">Invite</p>
            <h2>Add a driver</h2>
            <form method="post" action="${ADMIN_UI_APP_DRIVERS_PATH}" enctype="multipart/form-data" class="stack guided-form">
              <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <label>Driver name
                <input type="text" name="displayName" placeholder="Alex Driver" />
              </label>
              <label>Phone
                <input type="tel" name="phone" placeholder="+14165550123" required />
              </label>
              <button type="submit">Create driver invite</button>
            </form>
          </article>
        </aside>
      </section>
    </main>`,
    title: 'CLEVER Route Drivers'
  });
}

function renderSettingsPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  error?: string;
  notice?: string;
  settings: AdminStoreSettings | null;
  shopDomainLocked: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? input.settings?.shopDomain ?? '';
  const defaultDepotAddress = input.settings?.defaultDepotAddress ?? '';
  const defaultDepotLatitude = formatNullableNumber(input.settings?.defaultDepotLatitude ?? null);
  const defaultDepotLongitude = formatNullableNumber(input.settings?.defaultDepotLongitude ?? null);
  const locale = input.settings?.locale ?? 'en-CA';
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'settings',
        allowConnectionSetup: !input.shopDomainLocked,
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Configure store-level routing defaults used by the CLEVER route workspace.',
        title: 'Settings'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      <section class="setup-layout">
        <div class="setup-main">
          <article class="card">
            <p class="eyebrow">Settings</p>
            <h2>Store settings</h2>
            <p class="muted">Set defaults that make route creation faster: store/depot address, coordinates, and operator language.</p>
            <form method="get" action="${ADMIN_UI_APP_SETTINGS_PATH}" class="stack guided-form">
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <button type="submit">Load settings</button>
            </form>
          </article>
          <article class="card">
            <p class="eyebrow">Store defaults</p>
            <h2>Store address and language</h2>
            <form method="post" action="${ADMIN_UI_APP_SETTINGS_PATH}" enctype="multipart/form-data" class="stack guided-form">
              <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
              ${renderShopDomainControl({ currentShopDomain, locked: input.shopDomainLocked })}
              <label>Store address
                <input type="text" name="defaultDepotAddress" value="${escapeHtml(defaultDepotAddress)}" placeholder="123 Depot St, Toronto, ON" />
              </label>
              <div class="split-fields">
                <label>Depot latitude<input type="text" name="defaultDepotLatitude" value="${escapeHtml(defaultDepotLatitude)}" placeholder="43.6532" /></label>
                <label>Depot longitude<input type="text" name="defaultDepotLongitude" value="${escapeHtml(defaultDepotLongitude)}" placeholder="-79.3832" /></label>
              </div>
              <label>Language
                <select name="locale">
                  ${renderLocaleOption(locale, 'en-CA', 'English (Canada)')}
                  ${renderLocaleOption(locale, 'fr-CA', 'French (Canada)')}
                  ${renderLocaleOption(locale, 'ko-KR', 'Korean')}
                </select>
              </label>
              <button type="submit">Save settings</button>
            </form>
          </article>
        </div>
        <aside class="setup-aside">
          <article class="card">
            <p class="eyebrow">Usage</p>
            <h2>Where this appears</h2>
            <p class="muted">The route creation page can use this address as the dispatch/depot default. Language controls future operator-facing copy for this shop.</p>
          </article>
        </aside>
      </section>
    </main>`,
    title: 'CLEVER Route Settings'
  });
}

function renderRouteCreateCard(input: {
  csrfToken: string;
  currentShopDomain: string;
  deliveryDate: string;
  disabled: boolean;
  readyOrders: readonly CanonicalOrderRow[];
  settings: AdminStoreSettings | null;
}): string {
  const defaultDepotAddress = input.settings?.defaultDepotAddress ?? '';
  const defaultDepotLatitude = formatNullableNumber(input.settings?.defaultDepotLatitude ?? null);
  const defaultDepotLongitude = formatNullableNumber(input.settings?.defaultDepotLongitude ?? null);
  return `<article class="card">
    <p class="eyebrow">Manual route draft</p>
    <h2>Create from ready orders</h2>
    <p class="muted">${input.readyOrders.length} ready unplanned orders are available for this date. Select the exact Woo orders to route. If any selected order becomes invalid, CLEVER blocks the whole route so no partial draft is created.</p>
    <form method="post" action="${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create" enctype="multipart/form-data" class="stack guided-form" data-route-selection-form>
      <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
      <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
      <input type="hidden" name="selectedOrderGids" value="${escapeHtml(input.readyOrders.map((order) => order.shopifyOrderGid).join('\n'))}" />
      <label>Route date
        <input type="date" name="planDate" value="${escapeHtml(input.deliveryDate)}" required />
      </label>
      <label>Route name
        <input type="text" name="routeName" value="${escapeHtml(`${input.deliveryDate} CLEVER route`)}" required />
      </label>
      <label>Depot address
        <input type="text" name="depotAddress" value="${escapeHtml(defaultDepotAddress)}" placeholder="Optional dispatch/depot address" />
      </label>
      <div class="split-fields">
        <label>Depot latitude<input type="text" name="depotLatitude" value="${escapeHtml(defaultDepotLatitude)}" placeholder="43.6532" /></label>
        <label>Depot longitude<input type="text" name="depotLongitude" value="${escapeHtml(defaultDepotLongitude)}" placeholder="-79.3832" /></label>
      </div>
      ${renderSelectableOrderList(input.readyOrders)}
      <button type="submit" ${input.disabled ? 'disabled' : ''}>Create route from <span data-selected-order-count>${input.readyOrders.length}</span> selected ready orders</button>
    </form>
  </article>`;
}

function renderRouteDetailCard(input: {
  csrfToken: string;
  currentShopDomain: string;
  drivers: readonly AdminDriverRow[];
  routeDetail: RoutePlanDetail | null;
}): string {
  if (input.routeDetail === null) {
    return `<article class="card">
      <p class="eyebrow">Manual route order</p>
      <h2>No route selected</h2>
      <p class="muted">Open a route draft from the list to review stops and edit the sequence.</p>
    </article>`;
  }
  const stopOrder = input.routeDetail.stops.map((stop) => stop.shopifyOrderGid).join('\n');
  return `<article class="card">
    <p class="eyebrow">Route Builder</p>
    <h2>${escapeHtml(input.routeDetail.routePlan.name)}</h2>
    <p class="muted">Local route canvas uses saved stop coordinates and never calls a public routing provider. The Optimize action is CLEVER v1 deterministic sequence optimization, not traffic-aware routing.</p>
    <div class="route-builder">
      <section class="route-map-panel" aria-label="Route map canvas">
        ${renderRouteCanvas(input.routeDetail)}
      </section>
      <section class="route-control-panel" aria-label="Route controls">
        ${renderRouteBuilderStats(input.routeDetail)}
        ${renderRouteDriverAssignmentForm({
          csrfToken: input.csrfToken,
          currentDriverId: input.routeDetail.routePlan.driverId ?? null,
          currentShopDomain: input.currentShopDomain,
          drivers: input.drivers,
          routePlanId: input.routeDetail.routePlan.id
        })}
        <form method="post" action="${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${escapeHtml(input.routeDetail.routePlan.id)}/optimize" enctype="multipart/form-data" class="stack guided-form compact-form">
          <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
          <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
          <button type="submit">Optimize sequence · CLEVER v1</button>
        </form>
      </section>
    </div>
    <p class="muted">Reorder the order IDs below, one per line. Keep every line exactly once, then save.</p>
    <form method="post" action="${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${escapeHtml(input.routeDetail.routePlan.id)}/stops" enctype="multipart/form-data" class="stack guided-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
      <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
      <label>Stop order
        <textarea name="stopOrder" rows="8" spellcheck="false" required>${escapeHtml(stopOrder)}</textarea>
      </label>
      <button type="submit">Save route stop order</button>
    </form>
    ${renderRouteStopsTable(input.routeDetail.stops)}
  </article>`;
}

function renderRouteDriverAssignmentForm(input: {
  csrfToken: string;
  currentDriverId: string | null;
  currentShopDomain: string;
  drivers: readonly AdminDriverRow[];
  routePlanId: string;
}): string {
  return `<form method="post" action="${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${escapeHtml(input.routePlanId)}/driver" enctype="multipart/form-data" class="stack guided-form compact-form">
    <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
    <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
    <label>Assigned driver
      <select name="driverId">
        ${renderSelectOption(input.currentDriverId ?? '', '', 'No driver assigned')}
        ${input.drivers
          .map((driver) => renderSelectOption(input.currentDriverId ?? '', driver.id, `${driver.displayName} · ${driver.status}`))
          .join('')}
      </select>
    </label>
    <button type="submit">Save driver assignment</button>
  </form>`;
}

function renderRouteBuilderStats(detail: RoutePlanDetail): string {
  return `<dl class="compact-list route-stats">
    <dt>Status</dt><dd>${escapeHtml(detail.routePlan.status)}</dd>
    <dt>Stops</dt><dd>${detail.stops.length}</dd>
    <dt>Missing coordinates</dt><dd>${detail.routePlan.missingCoordinates}</dd>
    <dt>Delivery areas</dt><dd>${escapeHtml(detail.routePlan.deliveryAreas.join(', ') || '—')}</dd>
  </dl>`;
}

function renderRouteCanvas(detail: RoutePlanDetail): string {
  const plotted = detail.stops
    .map((stop) => ({ coordinates: readStopCoordinates(stop), stop }))
    .filter((entry): entry is { coordinates: { latitude: number; longitude: number }; stop: RoutePlanDetail['stops'][number] } =>
      entry.coordinates !== null
    );
  const depot = readDepotCoordinates(detail.routePlan);
  if (plotted.length === 0 && depot === null) {
    return '<div class="route-canvas-empty">No coordinates yet. Fix delivery metadata before spatial route review.</div>';
  }

  const points = [
    ...(depot === null ? [] : [{ label: 'D', latitude: depot.latitude, longitude: depot.longitude, title: 'Depot' }]),
    ...plotted.map((entry) => ({
      label: String(entry.stop.sequence),
      latitude: entry.coordinates.latitude,
      longitude: entry.coordinates.longitude,
      title: entry.stop.orderName
    }))
  ];
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const latitudeSpan = Math.max(maxLatitude - minLatitude, 0.01);
  const longitudeSpan = Math.max(maxLongitude - minLongitude, 0.01);
  const width = 720;
  const height = 420;
  const padding = 44;
  const project = (point: { latitude: number; longitude: number }): { x: number; y: number } => ({
    x: padding + ((point.longitude - minLongitude) / longitudeSpan) * (width - padding * 2),
    y: height - padding - ((point.latitude - minLatitude) / latitudeSpan) * (height - padding * 2)
  });
  const projectedStops = plotted.map((entry) => ({ ...project(entry.coordinates), stop: entry.stop }));
  const routeLine = projectedStops.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const depotPoint = depot === null ? null : project(depot);
  const missingCount = detail.stops.length - plotted.length;

  return `<svg class="route-canvas" data-route-map viewBox="0 0 ${width} ${height}" role="img" aria-label="Local route canvas with numbered stops">
    <rect x="0" y="0" width="${width}" height="${height}" rx="26" fill="#f5f5f7"></rect>
    <path d="M40 340 C180 260 210 150 360 180 S570 125 680 72" fill="none" stroke="#d2d2d7" stroke-width="16" stroke-linecap="round" opacity="0.72"></path>
    ${routeLine === '' ? '' : `<polyline points="${routeLine}" fill="none" stroke="#0071e3" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>`}
    ${
      depotPoint === null
        ? ''
        : `<g><circle cx="${depotPoint.x.toFixed(1)}" cy="${depotPoint.y.toFixed(1)}" r="15" fill="#1d1d1f"></circle><text x="${depotPoint.x.toFixed(1)}" y="${(depotPoint.y + 5).toFixed(1)}" text-anchor="middle" fill="white" font-size="13" font-weight="700">D</text></g>`
    }
    ${projectedStops
      .map(
        (point) => `<g>
          <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="15" fill="#0071e3"></circle>
          <text x="${point.x.toFixed(1)}" y="${(point.y + 5).toFixed(1)}" text-anchor="middle" fill="white" font-size="13" font-weight="700">${point.stop.sequence}</text>
          <title>${escapeHtml(point.stop.orderName)}</title>
        </g>`
      )
      .join('')}
    <text x="28" y="${height - 24}" fill="#6e6e73" font-size="13">Local canvas · ${detail.stops.length} stops${missingCount === 0 ? '' : ` · ${missingCount} missing coordinates`}</text>
  </svg>`;
}

function renderRouteStatsCard(
  readyOrders: readonly CanonicalOrderRow[],
  reviewOrders: readonly CanonicalOrderRow[]
): string {
  return `<article class="card">
    <p class="eyebrow">Order readiness</p>
    <h2>Planning status</h2>
    <dl class="compact-list">
      <dt>Ready to plan</dt><dd>${readyOrders.length}</dd>
      <dt>Needs review</dt><dd>${reviewOrders.length}</dd>
    </dl>
    <p class="muted">If Needs review is high, fix Woo delivery metadata mapping before route creation.</p>
  </article>`;
}

function renderRoutePlansList(
  routePlans: readonly RoutePlanSummary[],
  currentShopDomain: string | null,
  deliveryDate: string | null
): string {
  if (currentShopDomain === null) {
    return `<article class="card"><p class="eyebrow">Routes</p><h2>Load a shop first</h2><p class="muted">Enter the shop domain to show existing route drafts.</p></article>`;
  }
  if (routePlans.length === 0) {
    return `<article class="card"><p class="eyebrow">Routes</p><h2>No routes yet</h2><p class="muted">Create the first route from ready orders.</p></article>`;
  }
  return `<article class="card">
    <p class="eyebrow">Routes</p>
    <h2>Existing route drafts</h2>
    <div class="route-list">
      ${routePlans
        .map((routePlan) => {
          const params = new URLSearchParams({ shopDomain: currentShopDomain });
          if (deliveryDate !== null) params.set('deliveryDate', deliveryDate);
          return `<a class="route-row" href="${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${encodeURIComponent(routePlan.id)}?${params.toString()}">
            <strong>${escapeHtml(routePlan.name)}</strong>
            <span>${escapeHtml(routePlan.planDate)} · ${routePlan.stopsCount} stops · ${escapeHtml(routePlan.status)}</span>
          </a>`;
        })
        .join('')}
    </div>
  </article>`;
}

function renderOrdersPreview(
  readyOrders: readonly CanonicalOrderRow[],
  reviewOrders: readonly CanonicalOrderRow[]
): string {
  return `<section class="dashboard-grid">
    <article class="card">
      <p class="eyebrow">Ready to plan</p>
      <h2>Ready orders</h2>
      ${renderOrderRows(readyOrders, 'No ready orders for this date.')}
    </article>
    <article class="card">
      <p class="eyebrow">Needs review</p>
      <h2>Blocked orders</h2>
      ${renderOrderRows(reviewOrders, 'No blocked orders for this date.')}
    </article>
  </section>`;
}

function renderDriverRows(drivers: readonly AdminDriverRow[], emptyMessage: string): string {
  if (drivers.length === 0) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Invite code</th><th>Last seen</th></tr></thead><tbody>
    ${drivers
      .map(
        (driver) => `<tr>
          <td>${escapeHtml(driver.displayName)}</td>
          <td>${escapeHtml(driver.phone ?? '')}</td>
          <td>${escapeHtml(driver.status)}</td>
          <td>${escapeHtml(driver.inviteCode ?? '')}</td>
          <td>${escapeHtml(driver.lastSeenAt ?? 'Not seen yet')}</td>
        </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

function renderLocaleOption(currentLocale: string, value: string, label: string): string {
  return `<option value="${escapeHtml(value)}" ${currentLocale === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function renderSelectOption(currentValue: string, value: string, label: string): string {
  return `<option value="${escapeHtml(value)}" ${currentValue === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function buildRoutePlansHref(currentShopDomain: string, deliveryDate: string | null): string {
  if (currentShopDomain === '') return ADMIN_UI_APP_ROUTE_PLANS_PATH;
  const params = new URLSearchParams({ shopDomain: currentShopDomain });
  if (deliveryDate !== null && deliveryDate.trim() !== '') params.set('deliveryDate', deliveryDate);
  return `${ADMIN_UI_APP_ROUTE_PLANS_PATH}?${params.toString()}`;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function renderSelectableOrderList(orders: readonly CanonicalOrderRow[]): string {
  if (orders.length === 0) {
    return '<p class="muted">No ready orders are available for selection.</p>';
  }
  return `<div class="selectable-orders" aria-label="Selectable ready orders">
    ${orders
      .slice(0, 100)
      .map((order) => {
        const label = `${order.sourceOrderNumber ?? order.name} · ${order.recipientName ?? 'Recipient'} · ${order.deliveryArea ?? 'No area'}`;
        return `<label class="selectable-row">
          <input type="checkbox" value="${escapeHtml(order.shopifyOrderGid)}" data-order-selector checked />
          <span>
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(order.shippingAddress.address1 ?? 'No address')} · ${escapeHtml(order.shopifyOrderGid)}</small>
          </span>
        </label>`;
      })
      .join('')}
    ${orders.length > 100 ? `<p class="muted">Showing 100 of ${orders.length} ready orders. Filter by date/area before selecting more.</p>` : ''}
  </div>`;
}

function renderOrderRows(orders: readonly CanonicalOrderRow[], emptyMessage: string): string {
  if (orders.length === 0) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Delivery date</th><th>Recipient</th><th>Area</th><th>Health</th><th>Delivery status</th><th>Planning</th><th>Reasons</th></tr></thead><tbody>
    ${orders
      .slice(0, 50)
      .map((order) => {
        const deliveryStatus = deriveOperateDeliveryStatus(order);
        const orderHealth = deriveOrderHealth(order);
        return `<tr>
          <td>${escapeHtml(order.sourceOrderNumber ?? order.name)}</td>
          <td>${escapeHtml(order.deliveryDate ?? '')}</td>
          <td>${escapeHtml(order.recipientName ?? '')}</td>
          <td>${escapeHtml(order.deliveryArea ?? '')}</td>
          <td><span class="pill ${orderHealth === 'normal' ? 'ready' : 'planned'}">${escapeHtml(orderHealth)}</span></td>
          <td><span class="pill ${deliveryStatus === 'ready' || deliveryStatus === 'completed' ? 'ready' : 'planned'}">${escapeHtml(deliveryStatus)}</span></td>
          <td>${escapeHtml(renderPlanningSummary(order))}</td>
          <td>${escapeHtml(order.reviewReasons.join(', '))}</td>
        </tr>`;
      })
      .join('')}
  </tbody></table>${orders.length > 50 ? `<p class="muted">Showing 50 of ${orders.length} orders.</p>` : ''}</div>`;
}

function renderPlanningSummary(order: CanonicalOrderRow): string {
  if (order.routePlanName !== null) return `${order.planningStatus} · ${order.routePlanName}`;
  if (order.routePlanId !== null) return `${order.planningStatus} · ${order.routePlanId}`;
  return order.planningStatus;
}

function renderRouteStopsTable(stops: RoutePlanDetail['stops']): string {
  if (stops.length === 0) return '<p class="muted">No stops in this route.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Order</th><th>Recipient</th><th>Area</th><th>Order ID for reorder</th></tr></thead><tbody>
    ${stops
      .map(
        (stop) => `<tr>
          <td>${stop.sequence}</td>
          <td>${escapeHtml(stop.orderName)}</td>
          <td>${escapeHtml(stop.recipientName ?? '')}</td>
          <td>${escapeHtml(stop.deliveryArea ?? '')}</td>
          <td><code>${escapeHtml(stop.shopifyOrderGid)}</code></td>
        </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

function renderLoginPage(input: { error?: string } = {}): string {
  return renderDocument({
    body: `<main class="shell narrow">
      <section class="card">
        <p class="eyebrow">CLEVER Route Admin</p>
        <h1>CLEVER Admin login</h1>
        <p class="muted">Use the dedicated admin web login secret. The internal JSON API bearer token is not accepted here.</p>
        ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
        <form method="post" action="${ADMIN_UI_LOGIN_PATH}" enctype="multipart/form-data" class="stack">
          <label>Admin web login secret
            <input type="password" name="loginSecret" autocomplete="off" required />
          </label>
          <button type="submit">Log in</button>
        </form>
      </section>
    </main>`,
    title: 'CLEVER Route Admin Login'
  });
}

function renderDashboardPage(input: { actor: AdminCommerceActor; csrfToken: string }): string {
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'dashboard',
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle: 'Start from the server admin dashboard, then open the specific module you need.',
        title: 'CLEVER Route Admin'
      })}
      <section class="dashboard-grid" aria-label="Admin modules">
        ${renderModuleCard({
          description: 'Review imported WooCommerce orders, readiness, and delivery metadata blockers before route creation.',
          href: ADMIN_UI_APP_ORDERS_PATH,
          status: 'Ready',
          title: 'Orders'
        })}
        ${renderModuleCard({
          description: 'Create date-based route drafts from ready WooCommerce orders and manually adjust stop sequence.',
          href: ADMIN_UI_APP_ROUTE_PLANS_PATH,
          status: 'Ready',
          title: 'Routes'
        })}
        ${renderModuleCard({
          description: 'Create driver invites and review delivery-person status for a customer shop.',
          href: ADMIN_UI_APP_DRIVERS_PATH,
          status: 'Ready',
          title: 'Drivers'
        })}
        ${renderModuleCard({
          description: 'Set customer store address/depot defaults and operator language.',
          href: ADMIN_UI_APP_SETTINGS_PATH,
          status: 'Ready',
          title: 'Settings'
        })}
        ${renderModuleCard({
          description: 'Create, test, rotate, and monitor customer WooCommerce REST API and webhook credentials.',
          href: ADMIN_UI_WOOCOMMERCE_PATH,
          status: 'Ready',
          title: 'WooCommerce connection setup'
        })}
      </section>
    </main>`,
    title: 'CLEVER Route Admin'
  });
}

function renderCommerceConnectionsPage(input: { actor: AdminCommerceActor; csrfToken: string }): string {
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'commerce',
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle: 'Commerce sources are managed as modules below the server admin dashboard.',
        title: 'Commerce Connections'
      })}
      <section class="dashboard-grid" aria-label="Commerce modules">
        ${renderModuleCard({
          description: 'Connect a customer WordPress/WooCommerce store, keep credentials write-only, and copy webhook setup details.',
          href: ADMIN_UI_WOOCOMMERCE_PATH,
          status: 'Ready',
          title: 'WooCommerce'
        })}
      </section>
    </main>`,
    title: 'CLEVER Route Commerce Connections'
  });
}

function renderAdminHero(input: {
  active: 'commerce' | 'dashboard' | 'drivers' | 'orders' | 'route-plans' | 'settings' | 'woocommerce';
  allowConnectionSetup?: boolean;
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain?: string | null;
  subtitle: string;
  title: string;
}): string {
  const surfaceLabel = input.allowConnectionSetup === false ? 'CLEVER Route App' : 'CLEVER Route Admin';
  const primaryLinks = [
    renderNavLink('Dashboard', withShopDomainQuery(ADMIN_UI_APP_DASHBOARD_PATH, input.currentShopDomain), input.active === 'dashboard'),
    renderNavLink('Orders', withShopDomainQuery(ADMIN_UI_APP_ORDERS_PATH, input.currentShopDomain), input.active === 'orders'),
    renderNavLink('Routes', withShopDomainQuery(ADMIN_UI_APP_ROUTE_PLANS_PATH, input.currentShopDomain), input.active === 'route-plans'),
    renderNavLink('Drivers', withShopDomainQuery(ADMIN_UI_APP_DRIVERS_PATH, input.currentShopDomain), input.active === 'drivers'),
    renderNavLink('Settings', withShopDomainQuery(ADMIN_UI_APP_SETTINGS_PATH, input.currentShopDomain), input.active === 'settings')
  ].join('');
  return `<header class="hero">
    <div>
      <p class="eyebrow">${surfaceLabel}</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p class="muted">${escapeHtml(input.subtitle)} Signed in as ${escapeHtml(input.actor.subject)}.</p>
      <nav class="page-nav" aria-label="Operate navigation">
        ${primaryLinks}
      </nav>
      <nav class="utility-nav" aria-label="Admin utility navigation">
        ${renderNavLink('Server admin', ADMIN_UI_ROOT_PATH, false)}
        ${input.allowConnectionSetup === false ? '' : renderNavLink('Connection setup', withShopDomainQuery(ADMIN_UI_WOOCOMMERCE_PATH, input.currentShopDomain), input.active === 'commerce' || input.active === 'woocommerce')}
      </nav>
    </div>
    <a class="button-link" href="${ADMIN_UI_LOGOUT_PATH}">Log out</a>
  </header>`;
}

function renderNavLink(label: string, href: string, active: boolean): string {
  return `<a class="${active ? 'active' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function withShopDomainQuery(path: string, shopDomain: string | null | undefined): string {
  if (shopDomain === undefined || shopDomain === null || shopDomain.trim() === '') return path;
  return `${path}?${new URLSearchParams({ shopDomain: shopDomain.trim() }).toString()}`;
}

function renderKpiCard(label: string, value: string, description: string): string {
  return `<article class="kpi-card">
    <p class="eyebrow">${escapeHtml(label)}</p>
    <strong>${escapeHtml(value)}</strong>
    <span>${escapeHtml(description)}</span>
  </article>`;
}

function renderModuleCard(input: {
  description: string;
  href: string;
  status: 'Planned' | 'Ready';
  title: string;
}): string {
  const isReady = input.status === 'Ready';
  return `<article class="card module-card">
    <div class="module-card-header">
      <h2>${escapeHtml(input.title)}</h2>
      <span class="pill ${isReady ? 'ready' : 'planned'}">${escapeHtml(input.status)}</span>
    </div>
    <p class="muted">${escapeHtml(input.description)}</p>
    <a class="button-link ${isReady ? '' : 'muted-link'}" href="${escapeHtml(input.href)}">${isReady ? 'Open' : 'View placeholder'}</a>
  </article>`;
}

function renderHomePage(input: {
  actor: AdminCommerceActor;
  connections: readonly SafeConnectionWithDelivery[];
  csrfToken: string;
  currentShopDomain: string | null;
  error?: string;
  notice?: string;
  webhookSetup?: WebhookSetupView;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'woocommerce',
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle: 'Add the store REST API key once, then copy the CLEVER webhook details into WooCommerce so new orders are sent to the route server immediately. This page stores encrypted Woo credentials in CLEVER and does not install anything into WordPress by itself.',
        title: 'Connect a WooCommerce store'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      ${renderWebhookSetup(input.webhookSetup)}
      <section class="setup-layout">
        <div class="setup-main">
          ${renderWooSetupChecklist()}
          <article class="card">
            <p class="eyebrow">Step 2</p>
            <h2>Enter WooCommerce REST credentials</h2>
            <p class="muted">Use one consolidated credential form for both validation and save. Secrets are accepted by CLEVER, encrypted, and never echoed back into the browser.</p>
            ${renderWooCredentialForm({ csrfToken: input.csrfToken, currentShopDomain })}
          </article>
        </div>
        <aside class="setup-aside">
          <article class="card">
            <p class="eyebrow">Existing stores</p>
            <h2>Find existing connections</h2>
            <p class="muted">Load a shop domain to review readiness, webhook metadata, and safe credential fingerprints.</p>
            <form method="get" action="${ADMIN_UI_WOOCOMMERCE_PATH}" class="stack">
              <label>Customer shop domain
                <span class="field-help">No protocol or path. Example: estherlist.com. Use this to find the customer connection group.</span>
                <input type="text" name="shopDomain" value="${escapeHtml(currentShopDomain)}" placeholder="estherlist.com" required />
              </label>
              <button type="submit" class="secondary">Load connections</button>
            </form>
          </article>
          ${renderWebhookInstructions()}
        </aside>
      </section>
      <section class="card">
        <h2>Connections</h2>
        ${input.currentShopDomain === null ? '<p class="muted">Enter a shop domain to load connections.</p>' : renderConnections(input.connections, input.csrfToken)}
      </section>
    </main>`,
    title: 'CLEVER Route WooCommerce Admin'
  });
}

function renderWooSetupChecklist(): string {
  return `<article class="card">
    <p class="eyebrow">Step 1</p>
    <h2>What you need from WordPress</h2>
    <ol class="checklist">
      <li><strong>REST API key:</strong> open <span>WooCommerce → Settings → Advanced → REST API</span>, then create a Read/Write key for CLEVER.</li>
      <li><strong>Webhook page:</strong> after saving here, open <span>WooCommerce → Settings → Advanced → Webhooks</span>.</li>
      <li><strong>Webhook topics:</strong> create active webhooks for <span>Order created</span> and <span>Order updated</span> using the CLEVER delivery URL.</li>
      <li><strong>Secret handling:</strong> CLEVER will generate a one-time secret after save unless you type your own. Copy it immediately.</li>
    </ol>
    <p class="muted">The initial WooCommerce ping is not the final CLEVER readiness signal. Readiness becomes green only after CLEVER accepts a signed order.created/order.updated payload.</p>
  </article>`;
}

function renderWebhookInstructions(): string {
  return `<article class="card">
    <p class="eyebrow">Webhook reminder</p>
    <h2>Finish inside WooCommerce</h2>
    <p class="muted">This server page prepares credentials and webhook values. You still paste the delivery URL and secret into WooCommerce admin for the customer store.</p>
    <dl class="compact-list">
      <dt>Status</dt><dd>Active</dd>
      <dt>Topics</dt><dd>Order created, Order updated</dd>
      <dt>Delivery URL</dt><dd>Shown after save and on each connection card</dd>
      <dt>Secret</dt><dd>Generated once or supplied by the operator</dd>
    </dl>
  </article>`;
}

function renderWooCredentialForm(input: {
  csrfToken: string;
  currentShopDomain: string;
}): string {
  return `<form method="post" action="${ADMIN_UI_WOOCOMMERCE_PATH}" enctype="multipart/form-data" class="stack guided-form" data-woo-credential-form>
    <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
    <label>Label
      <input type="text" name="label" maxlength="128" placeholder="Customer main Woo" />
    </label>
    <label>Customer shop domain
      <span class="field-help">No https:// and no path. Example: estherlist.com. This groups one customer/store in CLEVER.</span>
      <input type="text" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" placeholder="estherlist.com" required />
    </label>
    <label>WordPress/WooCommerce site URL
      <span class="field-help">Include https:// and the WordPress install path if WooCommerce is not at the root. Example: https://estherlist.com or https://estherlist.com/shop.</span>
      <input type="url" name="siteUrl" placeholder="https://estherlist.com" required />
    </label>
    <label>Timezone
      <input type="text" name="timezone" placeholder="America/Toronto" />
    </label>
    <label>Woo Consumer Key
      <input type="password" name="wooConsumerKey" autocomplete="off" required />
    </label>
    <label>Woo Consumer Secret
      <input type="password" name="wooConsumerSecret" autocomplete="off" required />
    </label>
    <label>Webhook secret (optional; leave blank to generate)
      <input type="password" name="webhookSecret" autocomplete="off" />
    </label>
    <p class="helper">Test credentials only validates the entered REST API key without saving and keeps the values on this page. Save connection validates, stores encrypted credentials, and prepares webhook setup.</p>
    <p class="alert" data-test-credential-result hidden></p>
    <div class="actions">
      <button type="submit" class="secondary" formaction="${ADMIN_UI_WOOCOMMERCE_PATH}/test" data-test-credentials-button>Test credentials only</button>
      <button type="submit">Save connection</button>
    </div>
  </form>`;
}

function renderConnections(connections: readonly SafeConnectionWithDelivery[], csrfToken: string): string {
  if (connections.length === 0) return '<p class="muted">No WooCommerce connections saved for this shop.</p>';
  return `<div class="connections">${connections.map((connection) => renderConnection(connection, csrfToken)).join('')}</div>`;
}

function renderConnection(connection: SafeConnectionWithDelivery, csrfToken: string): string {
  assertSafeConnectionForRender(connection);
  const readiness = connectionReadiness(connection);
  return `<article class="connection">
    <div class="connection-header">
      <div>
        <p class="eyebrow">WooCommerce store</p>
        <h3>${escapeHtml(connection.label ?? connection.shopDomain)}</h3>
      </div>
      <span class="pill ${readiness.className}">${escapeHtml(readiness.label)}</span>
    </div>
    <p class="muted">${escapeHtml(readiness.description)}</p>
    <dl>
      <dt>Shop domain</dt><dd>${escapeHtml(connection.shopDomain)}</dd>
      <dt>Site URL</dt><dd>${escapeHtml(connection.siteUrl)}</dd>
      <dt>Status</dt><dd>${escapeHtml(connection.status)}</dd>
      <dt>Credential</dt><dd>${escapeHtml(connection.credential.status)}${connection.credential.fingerprint === null ? '' : ` (${escapeHtml(connection.credential.fingerprint)})`}</dd>
      <dt>Verification</dt><dd>${escapeHtml(connection.verification.status ?? 'not verified')} ${escapeHtml(connection.verification.lastVerifiedAt ?? '')}</dd>
      <dt>Last REST sync</dt><dd>${escapeHtml(connection.lastRestSyncAt ?? 'Not recorded yet')}</dd>
      <dt>Last webhook</dt><dd>${escapeHtml(connection.lastWebhookAt ?? 'No order webhook received yet')}</dd>
      <dt>Next action</dt><dd>${escapeHtml(readiness.label)}</dd>
      <dt>Webhook delivery URL</dt><dd><code>${escapeHtml(connection.webhook.deliveryUrl)}</code></dd>
    </dl>
    <details>
      <summary>Rotate REST credentials</summary>
      <form method="post" action="${ADMIN_UI_WOOCOMMERCE_PATH}/${escapeHtml(connection.id)}/credentials" enctype="multipart/form-data" class="stack compact">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
        <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
        <label>New Woo Consumer Key<input type="password" name="wooConsumerKey" autocomplete="off" required /></label>
        <label>New Woo Consumer Secret<input type="password" name="wooConsumerSecret" autocomplete="off" required /></label>
        <button type="submit">Rotate credentials</button>
      </form>
    </details>
    <details>
      <summary>Rotate webhook secret</summary>
      <form method="post" action="${ADMIN_UI_WOOCOMMERCE_PATH}/${escapeHtml(connection.id)}/webhook-secret" enctype="multipart/form-data" class="stack compact">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
        <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
        <label>New webhook secret (optional; leave blank to generate)<input type="password" name="webhookSecret" autocomplete="off" /></label>
        <button type="submit">Rotate webhook secret</button>
      </form>
    </details>
    <form method="post" action="${ADMIN_UI_WOOCOMMERCE_PATH}/${escapeHtml(connection.id)}/status" enctype="multipart/form-data" class="inline-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
      <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
      <input type="hidden" name="status" value="${connection.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}" />
      <button type="submit" class="secondary">${connection.status === 'ACTIVE' ? 'Disable' : 'Activate'}</button>
    </form>
  </article>`;
}

function connectionReadiness(connection: SafeConnectionWithDelivery): {
  className: 'action' | 'disabled' | 'ready' | 'warning';
  description: string;
  label: 'Create/verify Woo webhook' | 'Disabled' | 'Ready' | 'Test REST credentials';
} {
  if (connection.status === 'DISABLED') {
    return {
      className: 'disabled',
      description: 'This connection is saved but disabled. Activate it before expecting webhook or REST processing.',
      label: 'Disabled'
    };
  }

  if (connection.verification.status !== 'VERIFIED' || connection.verification.lastVerifiedAt === null) {
    return {
      className: 'warning',
      description: 'REST credentials have not been verified yet. Test the WooCommerce REST API key before webhook setup.',
      label: 'Test REST credentials'
    };
  }

  if (connection.lastWebhookAt === null) {
    return {
      className: 'action',
      description: 'REST credentials are verified. Create or verify the WooCommerce order webhooks next.',
      label: 'Create/verify Woo webhook'
    };
  }

  return {
    className: 'ready',
    description: 'REST credentials are verified and CLEVER has received a signed WooCommerce order webhook.',
    label: 'Ready'
  };
}

function renderWebhookSetup(setup: WebhookSetupView | undefined): string {
  if (setup === undefined) return '';
  return `<section class="card setup">
    <h2>WooCommerce webhook setup</h2>
    <p class="muted">Copy these values into WooCommerce → Settings → Advanced → Webhooks for active Order created and Order updated webhooks.</p>
    <dl class="compact-list">
      <dt>Delivery URL</dt><dd><code>${escapeHtml(setup.deliveryUrl)}</code></dd>
      <dt>Delivery path</dt><dd><code>${escapeHtml(setup.deliveryPath)}</code></dd>
      <dt>Status</dt><dd>Active</dd>
      <dt>Topics</dt><dd>Order created, Order updated</dd>
    </dl>
    ${setup.oneTimeSecret === null ? '<p class="muted">Webhook secret was supplied by the operator and will not be displayed.</p>' : `<p class="one-time">Copy this generated webhook secret now: <code>${escapeHtml(setup.oneTimeSecret)}</code></p><p class="muted">This secret is shown only in this response. It is not displayed again after refresh or later connection views.</p>`}
  </section>`;
}

function renderDocument(input: { body: string; title: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>
	    :root { color-scheme: light; --bg: #f5f5f7; --card: rgba(255, 255, 255, 0.92); --ink: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #0071e3; --danger: #b42318; --success: #067647; }
	    * { box-sizing: border-box; }
	    [hidden] { display: none !important; }
	    body { margin: 0; background: radial-gradient(circle at top left, #ffffff 0, var(--bg) 42rem); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
	    .shell { width: min(100% - 40px, 1180px); margin: 0 auto; padding: 44px 0; }
	    .shell.narrow { width: min(100% - 32px, 560px); }
	    .hero, .card, .connection { background: var(--card); border: 1px solid rgba(210, 210, 215, 0.78); border-radius: 24px; padding: 28px; margin-bottom: 20px; box-shadow: 0 18px 45px rgba(0, 0, 0, 0.055); backdrop-filter: blur(18px); }
	    .hero { display: flex; gap: 20px; align-items: flex-start; justify-content: space-between; }
	    .dashboard-grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
	    .app-kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 20px; }
	    .kpi-card { background: rgba(255, 255, 255, 0.72); border: 1px solid rgba(210, 210, 215, 0.78); border-radius: 20px; padding: 18px; }
	    .kpi-card strong { display: block; font-size: 34px; letter-spacing: -0.04em; }
	    .kpi-card span { color: var(--muted); font-size: 13px; }
	    .setup-layout { align-items: start; display: grid; gap: 20px; grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr); }
	    .setup-main, .setup-aside { min-width: 0; }
	    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 700; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.08em; }
	    h1, h2, h3 { line-height: 1.15; margin: 0 0 12px; }
	    h1 { font-size: clamp(34px, 5vw, 56px); letter-spacing: -0.045em; }
	    h2 { letter-spacing: -0.022em; }
	    .muted { color: var(--muted); }
	    .page-nav, .utility-nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
	    .utility-nav { margin-top: 10px; }
	    .page-nav a, .utility-nav a, .button-link { border-radius: 999px; color: var(--accent); display: inline-flex; font-weight: 700; padding: 8px 12px; text-decoration: none; }
	    .page-nav a { background: rgba(0, 113, 227, 0.09); }
	    .page-nav a.active { background: var(--accent); color: white; }
	    .utility-nav a { background: #ececf0; color: var(--muted); }
	    .utility-nav a.active { color: var(--accent); }
	    .button-link { background: rgba(0, 113, 227, 0.11); margin-top: 10px; }
	    .button-link.muted-link { color: var(--muted); background: #ececf0; }
	    .module-card { display: flex; flex-direction: column; justify-content: space-between; min-height: 210px; }
	    .module-card-header { align-items: start; display: flex; gap: 12px; justify-content: space-between; }
	    .pill { border-radius: 999px; font-size: 12px; font-weight: 700; padding: 4px 9px; }
	    .pill.ready { background: #e9f7ef; color: var(--success); }
	    .pill.planned { background: #ececf0; color: var(--muted); }
	    .pill.action { background: #e8f2ff; color: var(--accent); }
	    .pill.warning { background: #fff7e6; color: #9a6700; }
	    .pill.disabled { background: #ececf0; color: var(--muted); }
	    .stack { display: grid; gap: 12px; }
	    .compact { margin-top: 12px; }
	    .compact-form { border: 1px solid var(--line); border-radius: 16px; margin: 12px 0 18px; padding: 14px; }
	    .guided-form { margin-top: 18px; }
	    .checklist { display: grid; gap: 12px; margin: 0 0 14px; padding-left: 22px; }
	    .checklist li { padding-left: 4px; }
	    .checklist span { font-weight: 700; }
	    .helper, .field-help { color: var(--muted); font-size: 14px; margin: 0; }
	    .field-help { font-weight: 400; }
	    .readonly-field { background: #f5f5f7; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); font-weight: 650; padding: 10px 12px; }
	    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
	    label { display: grid; gap: 6px; font-weight: 650; }
	    input, textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); font: inherit; padding: 10px 12px; }
    textarea { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
    .split-fields { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    button { background: var(--accent); border: 0; border-radius: 10px; color: white; cursor: pointer; font: inherit; font-weight: 700; padding: 10px 14px; }
    button:disabled { cursor: progress; opacity: 0.62; }
    button.secondary { background: #e8edff; color: var(--accent); }
    .alert { border-radius: 12px; padding: 12px 14px; }
    .alert.error { background: #fff1f0; color: var(--danger); }
    .alert.success { background: #ecfdf3; color: var(--success); }
    code { background: #eef2ff; border-radius: 6px; padding: 2px 5px; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 8px 12px; }
    .compact-list { grid-template-columns: minmax(90px, 140px) 1fr; }
    dt { color: var(--muted); font-weight: 700; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .connection-header { align-items: start; display: flex; gap: 12px; justify-content: space-between; }
    details { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 14px; }
    .inline-form { margin-top: 14px; }
    .one-time { color: var(--danger); font-weight: 700; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .route-list { display: grid; gap: 10px; }
    .route-row { border: 1px solid var(--line); border-radius: 14px; color: var(--ink); display: grid; padding: 12px; text-decoration: none; }
    .route-row span { color: var(--muted); }
    .selectable-orders { border: 1px solid var(--line); border-radius: 16px; display: grid; gap: 0; max-height: 360px; overflow: auto; }
    .selectable-row { align-items: start; border-bottom: 1px solid var(--line); display: grid; gap: 10px; grid-template-columns: auto 1fr; padding: 10px 12px; }
    .selectable-row:last-child { border-bottom: 0; }
    .selectable-row input { margin-top: 4px; width: auto; }
    .selectable-row small { color: var(--muted); display: block; font-weight: 400; overflow-wrap: anywhere; }
    .route-builder { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.25fr) minmax(260px, 0.75fr); margin: 18px 0; }
    .route-map-panel, .route-control-panel { min-width: 0; }
    .route-canvas { border: 1px solid var(--line); border-radius: 26px; display: block; width: 100%; }
    .route-canvas-empty { align-items: center; background: #f5f5f7; border: 1px dashed var(--line); border-radius: 26px; color: var(--muted); display: flex; min-height: 280px; justify-content: center; padding: 20px; text-align: center; }
    .route-stats { background: #f5f5f7; border: 1px solid var(--line); border-radius: 16px; margin: 0 0 12px; padding: 14px; }
    @media (max-width: 820px) { .hero, .connection-header { display: grid; } .setup-layout, .split-fields, .route-builder { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
  </style>
  <script src="${ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH}" defer></script>
  <script src="${ADMIN_UI_ROUTE_APP_SCRIPT_PATH}" defer></script>
</head>
<body>
${input.body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
