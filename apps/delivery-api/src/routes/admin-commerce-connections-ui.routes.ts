import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminCommerceActor } from '../modules/commerce/admin-commerce-auth.js';
import type { SafeWooCommerceConnection } from '../modules/commerce/commerce-connection.service.js';
import {
  WooCommerceOnboardingError,
  type WooCommerceConnectionOnboardingService,
  type WooCommerceOnboardingResult
} from '../modules/commerce/woocommerce-connection-onboarding.service.js';
import type { CanonicalOrderRow } from '../modules/shopify/order-sync.mapper.js';
import type { ListCanonicalOrdersFilters } from '../modules/shopify/order-sync.repository.js';
import {
  RoutePlanOrderAlreadyPlannedError,
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
  verifyAdminWebLoginSecret,
  verifyAdminWebSessionFromRequest,
  type AdminWebSession
} from './admin-ui-session.js';

const ADMIN_ROOT_PATH = '/admin';
const ADMIN_UI_ROOT_PATH = '/admin/ui';
const ADMIN_UI_LOGIN_PATH = `${ADMIN_UI_ROOT_PATH}/login`;
const ADMIN_UI_LOGOUT_PATH = `${ADMIN_UI_ROOT_PATH}/logout`;
const ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH = `${ADMIN_UI_ROOT_PATH}/assets/woocommerce-test.js`;
const ADMIN_UI_COMMERCE_CONNECTIONS_PATH = `${ADMIN_UI_ROOT_PATH}/commerce-connections`;
const ADMIN_UI_WOOCOMMERCE_PATH = `${ADMIN_UI_COMMERCE_CONNECTIONS_PATH}/woocommerce`;
const ADMIN_UI_ROUTE_PLANS_PATH = `${ADMIN_UI_ROOT_PATH}/route-plans`;
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

type SafeConnectionWithDelivery = SafeWooCommerceConnection & {
  webhook: SafeWooCommerceConnection['webhook'] & {
    deliveryPath: string;
    deliveryUrl: string;
  };
};

export type AdminCommerceConnectionsUiDependencies = {
  actor: AdminCommerceActor;
  cookieName?: string;
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
    'createRoutePlan' | 'getRoutePlanDetail' | 'listRoutePlans' | 'updateRoutePlanStops'
  >;
  secureCookies: boolean;
  sessionSecret: string;
  sessionTtlMs?: number;
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

  app.get(ADMIN_UI_ROOT_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return sendHtml(reply, 200, renderDashboardPage({ actor: dependencies.actor, csrfToken: session.csrfToken }));
  });

  app.get(ADMIN_UI_COMMERCE_CONNECTIONS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return sendHtml(reply, 200, renderCommerceConnectionsPage({ actor: dependencies.actor, csrfToken: session.csrfToken }));
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

  for (const placeholder of [
    { path: `${ADMIN_UI_ROOT_PATH}/settings`, title: 'Settings' },
    { path: `${ADMIN_UI_ROOT_PATH}/orders`, title: 'Orders' },
    { path: `${ADMIN_UI_ROOT_PATH}/drivers`, title: 'Drivers' }
  ] as const) {
    app.get(placeholder.path, async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return sendHtml(
        reply,
        200,
        renderPlaceholderPage({
          actor: dependencies.actor,
          csrfToken: session.csrfToken,
          title: placeholder.title
        })
      );
    });
  }

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

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.shopDomain);
    deliveryDate = normalizeOptionalDate(input.deliveryDate);
    if (services === null) {
      error = error ?? 'Route planning services are not enabled in this runtime.';
    } else if (currentShopDomain !== null) {
      routePlans = await services.routePlanService.listRoutePlans({ shopDomain: currentShopDomain });
      if (input.routePlanId !== null && input.routePlanId !== undefined && input.routePlanId.trim() !== '') {
        routeDetail = await services.routePlanService.getRoutePlanDetail({
          routePlanId: input.routePlanId.trim(),
          shopDomain: currentShopDomain
        });
        if (routeDetail === null) {
          error = error ?? 'Route plan not found for this shop.';
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
      readyOrders,
      reviewOrders,
      routeDetail,
      routePlans,
      servicesEnabled: services !== null,
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
      allowedFields: ['csrfToken', 'shopDomain', 'planDate', 'routeName', 'depotAddress', 'depotLatitude', 'depotLongitude'],
      maxFields: 7
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(readRequiredField(fields, 'shopDomain', 'shopDomain'));
    planDate = normalizeRequiredDate(readRequiredField(fields, 'planDate', 'plan date'));
    const readyOrders = await services.orderSyncService.listCanonicalOrders({
      filters: { deliveryDate: planDate, planned: false, readiness: 'READY_TO_PLAN' },
      shopDomain
    });
    if (readyOrders.length === 0) {
      return redirectToRoutePlans(reply, {
        deliveryDate: planDate,
        error: 'No ready unplanned orders exist for this date. Review mapping first or choose another date.',
        shopDomain
      });
    }

    const payload = buildCreateRoutePlanPayload({
      depotAddress: readOptionalField(fields, 'depotAddress'),
      depotLatitude: readOptionalCoordinate(fields.depotLatitude),
      depotLongitude: readOptionalCoordinate(fields.depotLongitude),
      orders: readyOrders,
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
      notice: `Route created from ${readyOrders.length} ready orders.`,
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
  orderSyncService: NonNullable<AdminCommerceConnectionsUiDependencies['orderSyncService']>;
  routePlanService: NonNullable<AdminCommerceConnectionsUiDependencies['routePlanService']>;
};

function readRouteUiServices(dependencies: AdminCommerceConnectionsUiDependencies): RouteUiServices | null {
  if (dependencies.orderSyncService === undefined || dependencies.routePlanService === undefined) {
    return null;
  }
  return {
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

function normalizeOptionalDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return normalizeRequiredDate(value);
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

function sanitizeRouteUiError(error: unknown): string {
  if (error instanceof RoutePlanOrderAlreadyPlannedError) {
    return 'Some selected orders are already assigned to a route. Refresh the page and try again.';
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
  return redirect(reply, query === '' ? ADMIN_UI_ROUTE_PLANS_PATH : `${ADMIN_UI_ROUTE_PLANS_PATH}?${query}`);
}

function renderRoutePlansPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain: string | null;
  deliveryDate: string | null;
  error?: string;
  notice?: string;
  readyOrders: readonly CanonicalOrderRow[];
  reviewOrders: readonly CanonicalOrderRow[];
  routeDetail: RoutePlanDetail | null;
  routePlans: readonly RoutePlanSummary[];
  servicesEnabled: boolean;
}): string {
  const currentShopDomain = input.currentShopDomain ?? '';
  const deliveryDate = input.deliveryDate ?? new Date().toISOString().slice(0, 10);
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'route-plans',
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle: 'Server-owned route workspace for WooCommerce orders. WordPress stays as setup/status; route creation and ordering live here.',
        title: 'Open CLEVER Route'
      })}
      ${input.notice === undefined ? '' : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? '' : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      ${input.servicesEnabled ? '' : '<p class="alert error">Route planning services are not enabled in this runtime.</p>'}
      <section class="setup-layout">
        <div class="setup-main">
          <article class="card">
            <p class="eyebrow">Route workspace</p>
            <h2>Create route for date</h2>
            <p class="muted">Choose a customer shop and delivery date. CLEVER will create a manual route from all ready, unplanned orders for that date.</p>
            <form method="get" action="${ADMIN_UI_ROUTE_PLANS_PATH}" class="stack guided-form">
              <label>Customer shop domain
                <input type="text" name="shopDomain" value="${escapeHtml(currentShopDomain)}" placeholder="dev1.tomatonofood.com" required />
              </label>
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
            readyCount: input.readyOrders.length
          })}
          ${renderRouteDetailCard({
            csrfToken: input.csrfToken,
            currentShopDomain,
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

function renderRouteCreateCard(input: {
  csrfToken: string;
  currentShopDomain: string;
  deliveryDate: string;
  disabled: boolean;
  readyCount: number;
}): string {
  return `<article class="card">
    <p class="eyebrow">Manual route draft</p>
    <h2>Create from ready orders</h2>
    <p class="muted">${input.readyCount} ready unplanned orders are available for this date. Orders needing review are blocked until delivery metadata mapping is fixed.</p>
    <form method="post" action="${ADMIN_UI_ROUTE_PLANS_PATH}/create" enctype="multipart/form-data" class="stack guided-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
      <input type="hidden" name="shopDomain" value="${escapeHtml(input.currentShopDomain)}" />
      <label>Route date
        <input type="date" name="planDate" value="${escapeHtml(input.deliveryDate)}" required />
      </label>
      <label>Route name
        <input type="text" name="routeName" value="${escapeHtml(`${input.deliveryDate} CLEVER route`)}" required />
      </label>
      <label>Depot address
        <input type="text" name="depotAddress" placeholder="Optional dispatch/depot address" />
      </label>
      <div class="split-fields">
        <label>Depot latitude<input type="text" name="depotLatitude" placeholder="43.6532" /></label>
        <label>Depot longitude<input type="text" name="depotLongitude" placeholder="-79.3832" /></label>
      </div>
      <button type="submit" ${input.disabled ? 'disabled' : ''}>Create route from all ready orders</button>
    </form>
  </article>`;
}

function renderRouteDetailCard(input: {
  csrfToken: string;
  currentShopDomain: string;
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
    <p class="eyebrow">Manual route order</p>
    <h2>${escapeHtml(input.routeDetail.routePlan.name)}</h2>
    <p class="muted">Reorder the order IDs below, one per line. Keep every line exactly once, then save.</p>
    <form method="post" action="${ADMIN_UI_ROUTE_PLANS_PATH}/${escapeHtml(input.routeDetail.routePlan.id)}/stops" enctype="multipart/form-data" class="stack guided-form">
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
          const params = new URLSearchParams({ routePlanId: routePlan.id, shopDomain: currentShopDomain });
          if (deliveryDate !== null) params.set('deliveryDate', deliveryDate);
          return `<a class="route-row" href="${ADMIN_UI_ROUTE_PLANS_PATH}?${params.toString()}">
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

function renderOrderRows(orders: readonly CanonicalOrderRow[], emptyMessage: string): string {
  if (orders.length === 0) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Recipient</th><th>Area</th><th>Reasons</th></tr></thead><tbody>
    ${orders
      .slice(0, 50)
      .map(
        (order) => `<tr>
          <td>${escapeHtml(order.name)}</td>
          <td>${escapeHtml(order.recipientName ?? '')}</td>
          <td>${escapeHtml(order.deliveryArea ?? '')}</td>
          <td>${escapeHtml(order.reviewReasons.join(', '))}</td>
        </tr>`
      )
      .join('')}
  </tbody></table>${orders.length > 50 ? `<p class="muted">Showing 50 of ${orders.length} orders.</p>` : ''}</div>`;
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
          description: 'Create, test, rotate, and monitor customer WooCommerce REST API and webhook credentials.',
          href: ADMIN_UI_WOOCOMMERCE_PATH,
          status: 'Ready',
          title: 'WooCommerce connection setup'
        })}
        ${renderModuleCard({
          description: 'Create date-based route drafts from ready WooCommerce orders and manually adjust stop sequence.',
          href: ADMIN_UI_ROUTE_PLANS_PATH,
          status: 'Ready',
          title: 'Open CLEVER Route'
        })}
        ${renderModuleCard({
          description: 'Manage future operator settings, tenant controls, and protected admin preferences.',
          href: `${ADMIN_UI_ROOT_PATH}/settings`,
          status: 'Planned',
          title: 'Settings'
        })}
        ${renderModuleCard({
          description: 'Future order and driver operational views will live under this same admin shell.',
          href: `${ADMIN_UI_ROOT_PATH}/orders`,
          status: 'Planned',
          title: 'Orders & Drivers'
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

function renderPlaceholderPage(input: { actor: AdminCommerceActor; csrfToken: string; title: string }): string {
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: 'dashboard',
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle: 'This protected page is reserved for the next admin module implementation.',
        title: input.title
      })}
      <section class="card">
        <p class="eyebrow">Planned module</p>
        <h2>${escapeHtml(input.title)} is not enabled yet.</h2>
        <p class="muted">The route is intentionally protected inside the CLEVER admin shell so future work can attach here without changing the URL structure again.</p>
        <a class="button-link" href="${ADMIN_UI_ROOT_PATH}">Back to dashboard</a>
      </section>
    </main>`,
    title: `CLEVER Route ${input.title}`
  });
}

function renderAdminHero(input: {
  active: 'commerce' | 'dashboard' | 'route-plans' | 'woocommerce';
  actor: AdminCommerceActor;
  csrfToken: string;
  subtitle: string;
  title: string;
}): string {
  return `<header class="hero">
    <div>
      <p class="eyebrow">CLEVER Route Admin</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p class="muted">${escapeHtml(input.subtitle)} Signed in as ${escapeHtml(input.actor.subject)}.</p>
      <nav class="page-nav" aria-label="Admin navigation">
        ${renderNavLink('Dashboard', ADMIN_UI_ROOT_PATH, input.active === 'dashboard')}
        ${renderNavLink('Commerce', ADMIN_UI_COMMERCE_CONNECTIONS_PATH, input.active === 'commerce' || input.active === 'woocommerce')}
        ${renderNavLink('Route Plans', ADMIN_UI_ROUTE_PLANS_PATH, input.active === 'route-plans')}
        ${renderNavLink('Settings', `${ADMIN_UI_ROOT_PATH}/settings`, false)}
      </nav>
    </div>
    <a class="button-link" href="${ADMIN_UI_LOGOUT_PATH}">Log out</a>
  </header>`;
}

function renderNavLink(label: string, href: string, active: boolean): string {
  return `<a class="${active ? 'active' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
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
	    .setup-layout { align-items: start; display: grid; gap: 20px; grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr); }
	    .setup-main, .setup-aside { min-width: 0; }
	    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 700; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.08em; }
	    h1, h2, h3 { line-height: 1.15; margin: 0 0 12px; }
	    h1 { font-size: clamp(34px, 5vw, 56px); letter-spacing: -0.045em; }
	    h2 { letter-spacing: -0.022em; }
	    .muted { color: var(--muted); }
	    .page-nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
	    .page-nav a, .button-link { border-radius: 999px; color: var(--accent); display: inline-flex; font-weight: 700; padding: 8px 12px; text-decoration: none; }
	    .page-nav a { background: rgba(0, 113, 227, 0.09); }
	    .page-nav a.active { background: var(--accent); color: white; }
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
	    .guided-form { margin-top: 18px; }
	    .checklist { display: grid; gap: 12px; margin: 0 0 14px; padding-left: 22px; }
	    .checklist li { padding-left: 4px; }
	    .checklist span { font-weight: 700; }
	    .helper, .field-help { color: var(--muted); font-size: 14px; margin: 0; }
	    .field-help { font-weight: 400; }
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
    @media (max-width: 820px) { .hero, .connection-header { display: grid; } .setup-layout, .split-fields { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
  </style>
  <script src="${ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH}" defer></script>
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
