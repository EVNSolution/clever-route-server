import type { AdminCommerceActor } from "../modules/commerce/admin-commerce-auth.js";
import type { SafeWooCommerceConnection } from "../modules/commerce/commerce-connection.service.js";
import { DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES } from "../modules/wordpress-plugin/wordpress-plugin-auth.service.js";
import type { AdminWebSession } from "./admin-ui-session.js";

export type SafeConnectionWithDelivery = SafeWooCommerceConnection & {
  webhook: SafeWooCommerceConnection["webhook"] & {
    deliveryPath: string;
    deliveryUrl: string;
  };
};

export type WebhookSetupView = {
  deliveryPath: string;
  deliveryUrl: string;
  oneTimeSecret: string | null;
};

export type PairingCodeSetupView = {
  code: string;
  expiresAt: string;
  siteUrl: string;
};

type AdminUiShellPaths = {
  appDashboardPath: string;
  appDriversPath: string;
  appOrdersPath: string;
  appRoutePlansPath: string;
  appSettingsPath: string;
  commerceConnectionsPath: string;
  loginPath: string;
  logoutPath: string;
  rootPath: string;
  routeAppScriptPath: string;
  storeSessionsPath: string;
  woocommercePath: string;
  woocommerceTestScriptPath: string;
};

type AdminUiShellRendererDependencies = {
  assertSafeConnectionForRender: (connection: SafeWooCommerceConnection) => void;
  paths: AdminUiShellPaths;
  readWpPluginSessionShopDomain: (session: AdminWebSession) => string | null;
};

export function createAdminUiShellRenderer({
  assertSafeConnectionForRender,
  paths,
  readWpPluginSessionShopDomain,
}: AdminUiShellRendererDependencies) {
function renderLoginPage(input: { error?: string; returnTo?: string } = {}): string {
  return renderDocument({
    body: `<main class="shell narrow">
      <section class="card">
        <p class="eyebrow">CLEVER Route Admin</p>
        <h1>CLEVER Admin login</h1>
        <p class="muted">Use the dedicated admin web login secret. The internal JSON API bearer token is not accepted here.</p>
        ${input.error === undefined ? "" : `<p class="alert error">${escapeHtml(input.error)}</p>`}
        <form method="post" action="${paths.loginPath}" enctype="multipart/form-data" class="stack">
          <input type="hidden" name="returnTo" value="${escapeHtml(input.returnTo ?? paths.rootPath)}" />
          <label>Admin web login secret
            <input type="password" name="loginSecret" autocomplete="off" required />
          </label>
          <button type="submit">Log in</button>
        </form>
      </section>
    </main>`,
    title: "CLEVER Route Admin Login",
  });
}

function renderRouteOpsWorkspaceEntryRequiredPage(): string {
  return renderDocument({
    body: `<main class="shell narrow">
      <section class="card">
        <p class="eyebrow">CLEVER Route Admin</p>
        <h1>Store session entry required</h1>
        <p class="muted">Direct Route Ops workspace links do not open a password prompt and do not create a store session. Sign in through the CLEVER admin entry, then use Store sessions to choose the customer shop domain.</p>
        <div class="actions">
          <a class="button-link" href="${paths.loginPath}">Open admin login</a>
        </div>
      </section>
    </main>`,
    title: "CLEVER Route Store Session Required",
  });
}

function renderDashboardPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
}): string {
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: "dashboard",
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle:
          "Use this server-admin entry for internal store sessions and WooCommerce credential health. Customer WordPress sessions remain scoped to one store.",
        title: "CLEVER Route Admin",
      })}
      <section class="dashboard-grid" aria-label="Server admin modules">
        ${renderModuleCard({
          description:
            "Internal-only entry for choosing a connected shop domain and opening that store's Route Ops workspace.",
          href: paths.storeSessionsPath,
          status: "Ready",
          title: "Store sessions",
        })}
        ${renderModuleCard({
          description:
            "Create, test, rotate, and monitor customer WooCommerce REST API and webhook credentials.",
          href: paths.woocommercePath,
          status: "Ready",
          title: "WooCommerce connection setup",
        })}
      </section>
    </main>`,
    title: "CLEVER Route Admin",
  });
}

function renderStoreSessionsPage(input: {
  actor: AdminCommerceActor;
  connections: readonly SafeConnectionWithDelivery[];
  csrfToken: string;
  currentShopDomain: string | null;
  error?: string;
}): string {
  const currentShopDomain = input.currentShopDomain ?? "";
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: "store-sessions",
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle:
          "Internal CLEVER admin entry for selecting a connected customer store. This page is not available to WordPress-launched customer sessions.",
        title: "Store sessions",
      })}
      ${input.error === undefined ? "" : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      <section class="setup-layout">
        <article class="card">
          <p class="eyebrow">Internal store access</p>
          <h2>Choose store domain</h2>
          <p class="muted">Enter the customer shopDomain, then open the Route Ops workspace from the verified connection result. Direct workspace links without an admin session are rejected.</p>
          <form method="get" action="${paths.storeSessionsPath}" class="stack">
            <label>Customer shop domain
              <span class="field-help">No protocol or path. Example: tomatonofood.com.</span>
              <input type="text" name="shopDomain" value="${escapeHtml(currentShopDomain)}" placeholder="tomatonofood.com" required />
            </label>
            <button type="submit">Load store session</button>
          </form>
        </article>
        <article class="card">
          <p class="eyebrow">Boundary</p>
          <h2>Admin-only, not customer-facing</h2>
          <p class="muted">Customers should continue launching from the WordPress plugin. Those sessions are limited to their own shopDomain and cannot use this picker to switch stores.</p>
        </article>
      </section>
      <section class="card">
        <h2>Store workspace entry</h2>
        ${input.currentShopDomain === null ? '<p class="muted">Enter a shop domain to load its saved WooCommerce connection and workspace links.</p>' : renderStoreSessionEntries(input.connections)}
      </section>
    </main>`,
    title: "CLEVER Route Store Sessions",
  });
}

function renderStoreSessionEntries(
  connections: readonly SafeConnectionWithDelivery[],
): string {
  if (connections.length === 0) {
    return '<p class="muted">No WooCommerce connection is saved for this shop domain.</p>';
  }
  return `<div class="connections">${connections.map(renderStoreSessionEntry).join("")}</div>`;
}

function renderStoreSessionEntry(connection: SafeConnectionWithDelivery): string {
  assertSafeConnectionForRender(connection);
  const readiness = connectionReadiness(connection);
  const shopDomain = connection.shopDomain;
  return `<article class="connection">
    <div class="connection-header">
      <div>
        <p class="eyebrow">Store session</p>
        <h3>${escapeHtml(connection.label ?? shopDomain)}</h3>
      </div>
      <span class="pill ${readiness.className}">${escapeHtml(readiness.label)}</span>
    </div>
    <p class="muted">${escapeHtml(readiness.description)}</p>
    <dl>
      <dt>Shop domain</dt><dd>${escapeHtml(shopDomain)}</dd>
      <dt>Site URL</dt><dd>${escapeHtml(connection.siteUrl)}</dd>
      <dt>Status</dt><dd>${escapeHtml(connection.status)}</dd>
      <dt>Last REST sync</dt><dd>${escapeHtml(connection.lastRestSyncAt ?? "Not recorded yet")}</dd>
      <dt>Last webhook</dt><dd>${escapeHtml(connection.lastWebhookAt ?? "No order webhook received yet")}</dd>
    </dl>
    <div class="actions">
      <a class="button-link" href="${escapeHtml(withShopDomainQuery(paths.appOrdersPath, shopDomain))}">Open orders</a>
      <a class="button-link secondary-link" href="${escapeHtml(withShopDomainQuery(paths.appRoutePlansPath, shopDomain))}">Open routes</a>
      <a class="button-link secondary-link" href="${escapeHtml(withShopDomainQuery(paths.appDriversPath, shopDomain))}">Open drivers</a>
      <a class="button-link muted-link" href="${escapeHtml(withShopDomainQuery(paths.woocommercePath, shopDomain))}">Connection setup</a>
    </div>
  </article>`;
}

function renderWpPluginSessionLandingPage(input: {
  session: AdminWebSession;
}): string {
  const shopDomain = readWpPluginSessionShopDomain(input.session);
  const ordersHref =
    shopDomain === null
      ? paths.loginPath
      : withShopDomainQuery(paths.appOrdersPath, shopDomain);
  return renderDocument({
    body: `<main class="shell narrow">
      <section class="card">
        <p class="eyebrow">CLEVER Route WordPress launch session</p>
        <h1>Store workspace session active</h1>
        <p class="muted">This browser has a WordPress-launched session scoped to one store. The main CLEVER Route URL does not automatically open a tenant workspace.</p>
        <dl>
          <dt>Store</dt>
          <dd>${escapeHtml(shopDomain ?? "Unknown store")}</dd>
          <dt>Access</dt>
          <dd>Store-scoped, not full admin</dd>
        </dl>
        <div class="actions">
          <a class="button-link" href="${escapeHtml(ordersHref)}">Continue to this store</a>
          <a class="button-link muted-link" href="${paths.logoutPath}">Log out</a>
        </div>
      </section>
    </main>`,
    title: "CLEVER Route Store Session",
  });
}

function renderCommerceConnectionsPage(input: {
  actor: AdminCommerceActor;
  csrfToken: string;
}): string {
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: "commerce",
        actor: input.actor,
        csrfToken: input.csrfToken,
        subtitle:
          "Commerce sources are managed as modules below the server admin dashboard.",
        title: "Commerce Connections",
      })}
      <section class="dashboard-grid" aria-label="Commerce modules">
        ${renderModuleCard({
          description:
            "Connect a customer WordPress/WooCommerce store, keep credentials write-only, and copy webhook setup details.",
          href: paths.woocommercePath,
          status: "Ready",
          title: "WooCommerce",
        })}
      </section>
    </main>`,
    title: "CLEVER Route Commerce Connections",
  });
}

function renderAdminHero(input: {
  active:
    | "commerce"
    | "dashboard"
    | "drivers"
    | "orders"
    | "route-plans"
    | "settings"
    | "store-sessions"
    | "woocommerce";
  allowConnectionSetup?: boolean;
  actor: AdminCommerceActor;
  csrfToken: string;
  currentShopDomain?: string | null;
  subtitle: string;
  title: string;
}): string {
  const primaryLinks = [
    renderNavLink(
      "Dashboard",
      withShopDomainQuery(paths.appDashboardPath, input.currentShopDomain),
      input.active === "dashboard",
    ),
    renderNavLink(
      "Orders",
      withShopDomainQuery(paths.appOrdersPath, input.currentShopDomain),
      input.active === "orders",
    ),
    renderNavLink(
      "Routes",
      withShopDomainQuery(
        paths.appRoutePlansPath,
        input.currentShopDomain,
      ),
      input.active === "route-plans",
    ),
    renderNavLink(
      "Drivers",
      withShopDomainQuery(paths.appDriversPath, input.currentShopDomain),
      input.active === "drivers",
    ),
    renderNavLink(
      "Settings",
      withShopDomainQuery(paths.appSettingsPath, input.currentShopDomain),
      input.active === "settings",
    ),
  ];

  if (input.allowConnectionSetup === false) {
    const shopLabel =
      input.currentShopDomain?.trim() === "" ||
      input.currentShopDomain === undefined ||
      input.currentShopDomain === null
        ? "No shop selected"
        : input.currentShopDomain;
    return `<aside class="app-sidebar" aria-label="CLEVER Route navigation">
      <a class="app-logo" href="${withShopDomainQuery(paths.appDashboardPath, input.currentShopDomain)}" aria-label="CLEVER Route dashboard">
        <span class="app-logo-mark">C</span><strong>clever route</strong>
      </a>
      <nav class="app-nav" aria-label="Operate navigation">
        ${primaryLinks.join("")}
      </nav>
      <div class="app-sidebar-foot">
        <span class="operator-dot" aria-hidden="true"></span>
        <span>${escapeHtml(shopLabel)}</span>
      </div>
    </aside>
    <header class="app-topbar">
      <span>Route operations workspace · WordPress launch</span>
      <a href="${paths.logoutPath}">Log out</a>
    </header>
    <section class="app-page-header">
      <div>
        <p class="eyebrow">CLEVER Route App</p>
        <h1>${escapeHtml(input.title)}</h1>
        <p class="muted">${escapeHtml(input.subtitle)}</p>
      </div>
      <span class="shop-chip">${escapeHtml(shopLabel)}</span>
    </section>`;
  }

  return `<header class="hero">
    <div>
      <p class="eyebrow">CLEVER Route Admin</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p class="muted">${escapeHtml(input.subtitle)} Signed in as ${escapeHtml(input.actor.subject)}.</p>
      <nav class="utility-nav" aria-label="Admin utility navigation">
        ${renderNavLink("Server admin", paths.rootPath, false)}
        ${renderNavLink("Store sessions", paths.storeSessionsPath, input.active === "store-sessions")}
        ${renderNavLink("Connection setup", withShopDomainQuery(paths.woocommercePath, input.currentShopDomain), input.active === "commerce" || input.active === "woocommerce")}
      </nav>
    </div>
    <a class="button-link" href="${paths.logoutPath}">Log out</a>
  </header>`;
}

function renderNavLink(label: string, href: string, active: boolean): string {
  return `<a class="${active ? "active" : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function withShopDomainQuery(
  path: string,
  shopDomain: string | null | undefined,
): string {
  if (
    shopDomain === undefined ||
    shopDomain === null ||
    shopDomain.trim() === ""
  )
    return path;
  return `${path}?${new URLSearchParams({ shopDomain: shopDomain.trim() }).toString()}`;
}

function renderModuleCard(input: {
  description: string;
  href: string;
  status: "Planned" | "Ready";
  title: string;
}): string {
  const isReady = input.status === "Ready";
  return `<article class="card module-card">
    <div class="module-card-header">
      <h2>${escapeHtml(input.title)}</h2>
      <span class="pill ${isReady ? "ready" : "planned"}">${escapeHtml(input.status)}</span>
    </div>
    <p class="muted">${escapeHtml(input.description)}</p>
    <a class="button-link ${isReady ? "" : "muted-link"}" href="${escapeHtml(input.href)}">${isReady ? "Open" : "View placeholder"}</a>
  </article>`;
}

function renderHomePage(input: {
  actor: AdminCommerceActor;
  connections: readonly SafeConnectionWithDelivery[];
  csrfToken: string;
  currentShopDomain: string | null;
  canGeneratePairingCode: boolean;
  error?: string;
  notice?: string;
  pairingCodeSetup?: PairingCodeSetupView;
  webhookSetup?: WebhookSetupView;
}): string {
  const currentShopDomain = input.currentShopDomain ?? "";
  return renderDocument({
    body: `<main class="shell">
      ${renderAdminHero({
        active: "woocommerce",
        actor: input.actor,
        csrfToken: input.csrfToken,
        currentShopDomain: input.currentShopDomain,
        subtitle:
          "Add the store REST API key once, then copy the CLEVER webhook details into WooCommerce so new orders are sent to the route server immediately. This page stores encrypted Woo credentials in CLEVER and does not install anything into WordPress by itself.",
        title: "Connect a WooCommerce store",
      })}
      ${input.notice === undefined ? "" : `<p class="alert success">${escapeHtml(input.notice)}</p>`}
      ${input.error === undefined ? "" : `<p class="alert error">${escapeHtml(input.error)}</p>`}
      ${renderWebhookSetup(input.webhookSetup)}
      ${renderPairingCodeSetup(input.pairingCodeSetup)}
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
            <form method="get" action="${paths.woocommercePath}" class="stack">
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
        ${input.currentShopDomain === null ? '<p class="muted">Enter a shop domain to load connections.</p>' : renderConnections({
          canGeneratePairingCode: input.canGeneratePairingCode,
          connections: input.connections,
          csrfToken: input.csrfToken,
        })}
      </section>
    </main>`,
    title: "CLEVER Route WooCommerce Admin",
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
  return `<form method="post" action="${paths.woocommercePath}" enctype="multipart/form-data" class="stack guided-form" data-woo-credential-form>
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
    <p class="field-note">Test credentials only validates the entered REST API key without saving and keeps the values on this page. Save connection validates, stores encrypted credentials, and prepares webhook setup.</p>
    <p class="alert" data-test-credential-result hidden></p>
    <div class="actions">
      <button type="submit" class="secondary" formaction="${paths.woocommercePath}/test" data-test-credentials-button>Test credentials only</button>
      <button type="submit">Save connection</button>
    </div>
  </form>`;
}

function renderConnections(input: {
  canGeneratePairingCode: boolean;
  connections: readonly SafeConnectionWithDelivery[];
  csrfToken: string;
}): string {
  if (input.connections.length === 0)
    return '<p class="muted">No WooCommerce connections saved for this shop.</p>';
  return `<div class="connections">${input.connections
    .map((connection) =>
      renderConnection({
        canGeneratePairingCode: input.canGeneratePairingCode,
        connection,
        csrfToken: input.csrfToken,
      }),
    )
    .join("")}</div>`;
}

function renderConnection(input: {
  canGeneratePairingCode: boolean;
  connection: SafeConnectionWithDelivery;
  csrfToken: string;
}): string {
  const { connection, csrfToken } = input;
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
      <dt>Credential</dt><dd>${escapeHtml(connection.credential.status)}${connection.credential.fingerprint === null ? "" : ` (${escapeHtml(connection.credential.fingerprint)})`}</dd>
      <dt>Verification</dt><dd>${escapeHtml(connection.verification.status ?? "not verified")} ${escapeHtml(connection.verification.lastVerifiedAt ?? "")}</dd>
      <dt>Last REST sync</dt><dd>${escapeHtml(connection.lastRestSyncAt ?? "Not recorded yet")}</dd>
      <dt>Last webhook</dt><dd>${escapeHtml(connection.lastWebhookAt ?? "No order webhook received yet")}</dd>
      <dt>Next action</dt><dd>${escapeHtml(readiness.label)}</dd>
      <dt>Webhook delivery URL</dt><dd><code>${escapeHtml(connection.webhook.deliveryUrl)}</code></dd>
    </dl>
    <details>
      <summary>Rotate REST credentials</summary>
      <form method="post" action="${paths.woocommercePath}/${escapeHtml(connection.id)}/credentials" enctype="multipart/form-data" class="stack compact">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
        <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
        <label>New Woo Consumer Key<input type="password" name="wooConsumerKey" autocomplete="off" required /></label>
        <label>New Woo Consumer Secret<input type="password" name="wooConsumerSecret" autocomplete="off" required /></label>
        <button type="submit">Rotate credentials</button>
      </form>
    </details>
    <details>
      <summary>Rotate webhook secret</summary>
      <form method="post" action="${paths.woocommercePath}/${escapeHtml(connection.id)}/webhook-secret" enctype="multipart/form-data" class="stack compact">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
        <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
        <label>New webhook secret (optional; leave blank to generate)<input type="password" name="webhookSecret" autocomplete="off" /></label>
        <button type="submit">Rotate webhook secret</button>
      </form>
    </details>
    ${renderPairingCodeAction({
      canGeneratePairingCode: input.canGeneratePairingCode,
      connection,
      csrfToken,
    })}
    <form method="post" action="${paths.woocommercePath}/${escapeHtml(connection.id)}/status" enctype="multipart/form-data" class="inline-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
      <input type="hidden" name="shopDomain" value="${escapeHtml(connection.shopDomain)}" />
      <input type="hidden" name="status" value="${connection.status === "ACTIVE" ? "DISABLED" : "ACTIVE"}" />
      <button type="submit" class="secondary">${connection.status === "ACTIVE" ? "Disable" : "Activate"}</button>
    </form>
  </article>`;
}

function renderPairingCodeAction(input: {
  canGeneratePairingCode: boolean;
  connection: SafeConnectionWithDelivery;
  csrfToken: string;
}): string {
  if (!input.canGeneratePairingCode) {
    return `<details>
      <summary>Generate WordPress plugin pairing code</summary>
      <p class="field-note">WordPress plugin pairing code generation is not enabled in this runtime.</p>
    </details>`;
  }

  return `<details>
      <summary>Generate WordPress plugin pairing code</summary>
      <form method="post" action="${paths.woocommercePath}/${escapeHtml(input.connection.id)}/pairing-code" enctype="multipart/form-data" class="stack compact">
        <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}" />
        <input type="hidden" name="shopDomain" value="${escapeHtml(input.connection.shopDomain)}" />
        <p class="field-note">Creates a ${DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES}-minute one-time code for this site URL. Paste it into WordPress → WooCommerce → CLEVER Route → Setup.</p>
        <button type="submit">Generate pairing code</button>
      </form>
    </details>`;
}

function connectionReadiness(connection: SafeConnectionWithDelivery): {
  className: "action" | "disabled" | "ready" | "warning";
  description: string;
  label:
    | "Create/verify Woo webhook"
    | "Disabled"
    | "Ready"
    | "Test REST credentials";
} {
  if (connection.status === "DISABLED") {
    return {
      className: "disabled",
      description:
        "This connection is saved but disabled. Activate it before expecting webhook or REST processing.",
      label: "Disabled",
    };
  }

  if (
    connection.verification.status !== "VERIFIED" ||
    connection.verification.lastVerifiedAt === null
  ) {
    return {
      className: "warning",
      description:
        "REST credentials have not been verified yet. Test the WooCommerce REST API key before webhook setup.",
      label: "Test REST credentials",
    };
  }

  if (connection.lastWebhookAt === null) {
    return {
      className: "action",
      description:
        "REST credentials are verified. Create or verify the WooCommerce order webhooks next.",
      label: "Create/verify Woo webhook",
    };
  }

  return {
    className: "ready",
    description:
      "REST credentials are verified and CLEVER has received a signed WooCommerce order webhook.",
    label: "Ready",
  };
}

function renderPairingCodeSetup(setup: PairingCodeSetupView | undefined): string {
  if (setup === undefined) return "";
  return `<section class="card setup">
    <h2>WordPress plugin pairing code</h2>
    <p class="muted">Copy the generated pairing code now, then paste it into WordPress → WooCommerce → CLEVER Route → Setup.</p>
    <dl class="compact-list">
      <dt>One-time pairing code</dt><dd><code>${escapeHtml(setup.code)}</code></dd>
      <dt>Site URL</dt><dd>${escapeHtml(setup.siteUrl)}</dd>
      <dt>Expires at</dt><dd>${escapeHtml(setup.expiresAt)}</dd>
    </dl>
    <p class="muted">This code is shown only in this response. Refreshing or loading the connection list later will not show the plaintext code again; generate a new code if this one is expired or lost.</p>
  </section>`;
}

function renderWebhookSetup(setup: WebhookSetupView | undefined): string {
  if (setup === undefined) return "";
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
	    .app-shell { background: #f7f7f4; margin: 0; min-height: 100vh; padding: 0 28px 42px 248px; width: 100%; max-width: none; }
	    .app-shell .app-sidebar { background: #edede8; border-right: 1px solid #deded8; bottom: 0; display: flex; flex-direction: column; gap: 18px; left: 0; padding: 24px 18px; position: fixed; top: 0; width: 220px; z-index: 4; }
	    .app-logo { align-items: center; color: #1f1f1f; display: flex; gap: 9px; margin-bottom: 10px; text-decoration: none; }
	    .app-logo-mark { align-items: center; background: #1f1f1f; border-radius: 10px; color: white; display: inline-flex; font-weight: 800; height: 30px; justify-content: center; width: 30px; }
	    .app-logo strong { font-size: 18px; letter-spacing: -0.04em; text-transform: lowercase; }
	    .app-nav { display: grid; gap: 4px; }
	    .app-nav a { border-radius: 0; color: #3f403d; display: block; font-weight: 750; padding: 10px 12px; text-decoration: none; }
	    .app-nav a.active { background: #dcdad4; color: #111; }
	    .app-sidebar-foot { align-items: center; color: #4f504d; display: flex; gap: 8px; font-size: 13px; margin-top: auto; overflow-wrap: anywhere; }
	    .operator-dot { background: #111; border-radius: 999px; height: 9px; width: 9px; }
	    .app-topbar { align-items: center; background: #30302f; color: #f6f6f2; display: flex; font-size: 14px; justify-content: space-between; margin: 0 -28px 26px; min-height: 58px; padding: 0 28px; }
	    .app-topbar a { background: #f6f6f2; border-radius: 9px; color: #30302f; font-weight: 750; padding: 7px 13px; text-decoration: none; }
	    .app-page-header { align-items: flex-start; display: flex; justify-content: space-between; gap: 20px; margin: 0 0 24px; }
	    .app-page-header h1 { font-size: clamp(28px, 3.2vw, 42px); letter-spacing: -0.04em; margin-bottom: 8px; }
	    .app-page-header .muted { max-width: 820px; margin: 0; }
	    .shop-chip { background: #fff; border: 1px solid #deded8; border-radius: 999px; color: #4f504d; font-size: 13px; font-weight: 750; padding: 8px 13px; white-space: nowrap; }
	    .app-shell .card, .app-shell .kpi-card { background: #fff; border-color: #deded8; border-radius: 14px; box-shadow: none; padding: 16px; }
	    .app-shell .card { margin-bottom: 16px; }
	    .app-shell h2 { font-size: 20px; letter-spacing: -0.025em; }
	    .app-shell .setup-layout { grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.45fr); }
	    .app-shell .guided-form { align-items: end; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px 12px; }
	    .app-shell .guided-form label { font-size: 13px; gap: 4px; }
	    .app-shell input, .app-shell textarea, .app-shell select { border-radius: 9px; font-size: 14px; padding: 8px 10px; }
	    .app-shell button, .app-shell .button-link { border-radius: 9px; min-height: 36px; padding: 8px 12px; }
	    .app-shell table { font-size: 13px; }
	    .app-shell th, .app-shell td { padding: 9px 10px; }
	    .app-shell .table-wrap { border: 1px solid #e4e4df; border-radius: 12px; }
	    .app-shell .table-wrap table tr:last-child td { border-bottom: 0; }
	    .app-shell .route-builder { grid-template-columns: minmax(0, 1.65fr) minmax(280px, 0.35fr); }
	    .app-shell .route-canvas { border-radius: 14px; }
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
	    .field-note, .field-help { color: var(--muted); font-size: 14px; margin: 0; }
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
    @media (max-width: 820px) { .hero, .connection-header, .app-page-header { display: grid; } .setup-layout, .split-fields, .route-builder, .app-shell .setup-layout, .app-shell .route-builder { grid-template-columns: 1fr; } .app-shell { padding: 0 16px 32px; } .app-shell .app-sidebar { border-bottom: 1px solid #deded8; border-right: 0; flex-direction: row; gap: 10px; height: auto; overflow-x: auto; padding: 10px 14px; position: sticky; width: auto; } .app-logo strong, .app-sidebar-foot { display: none; } .app-nav { display: flex; gap: 4px; } .app-nav a { white-space: nowrap; } .app-topbar { margin: 0 -16px 18px; padding: 0 16px; } dl { grid-template-columns: 1fr; } }
  </style>
  <script src="${paths.woocommerceTestScriptPath}" defer></script>
  <script src="${paths.routeAppScriptPath}" defer></script>
</head>
<body>
${input.body}
</body>
</html>`;
}



  return {
    renderCommerceConnectionsPage,
    renderDashboardPage,
    renderHomePage,
    renderLoginPage,
    renderRouteOpsWorkspaceEntryRequiredPage,
    renderStoreSessionsPage,
    renderWpPluginSessionLandingPage,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
