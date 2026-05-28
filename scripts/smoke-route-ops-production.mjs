#!/usr/bin/env node
const baseUrl = requiredEnv('ROUTE_OPS_SMOKE_BASE_URL', 'https://clever-route.cleversystem.ai').replace(/\/+$/, '');
const shopDomain = requiredEnv('ROUTE_OPS_SMOKE_SHOP_DOMAIN', 'dev1.tomatonofood.com');
const loginSecret = requiredEnv('ROUTE_OPS_SMOKE_LOGIN_SECRET');
const expectPublicOpenFreeMap = process.env.ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP === 'true';
const expectedPublicHost = process.env.ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOST ?? 'tiles.openfreemap.org';

const summary = { baseUrl, shopDomain, checks: [] };
let cookieHeader = '';

try {
  await checkHealthz();
  await login();
  const appHtml = await checkAppShell('/admin/ui/app');
  await checkAssets(appHtml);
  await checkBootstrap();
  await checkOrdersPage();
  await checkOrdersApi();
  await checkVendorAssets();
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: sanitize(String(error?.message ?? error)), ...summary }, null, 2));
  process.exit(1);
}

function requiredEnv(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function sanitize(value) {
  return value.replaceAll(loginSecret, '<redacted>').replace(/clever_admin_ui=[^;\s]+/g, 'clever_admin_ui=<redacted>');
}

function record(name, data = {}) {
  summary.checks.push({ name, ...data });
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookieHeader) headers.set('cookie', cookieHeader);
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options, headers });
  return response;
}

async function expectStatus(name, response, expected) {
  if (response.status !== expected) {
    const body = await response.text().catch(() => '');
    throw new Error(`${name} expected ${expected}, got ${response.status}: ${sanitize(body.slice(0, 300))}`);
  }
}

async function checkHealthz() {
  const response = await request('/healthz');
  await expectStatus('healthz', response, 200);
  const data = await response.json();
  if (data.status !== 'ok') throw new Error(`healthz status was ${data.status}`);
  record('healthz', { status: response.status });
}

async function login() {
  const form = new FormData();
  form.set('loginSecret', loginSecret);
  const response = await request('/admin/ui/login', { method: 'POST', body: form });
  if (![302, 303].includes(response.status)) throw new Error(`login expected redirect, got ${response.status}`);
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookiePairs = setCookies.map((cookie) => cookie.split(';')[0]).filter(Boolean);
  if (cookiePairs.length === 0) throw new Error('login did not return a session cookie');
  cookieHeader = cookiePairs.join('; ');
  record('login', { status: response.status, cookie: '<redacted>' });
}

async function checkAppShell(path) {
  const response = await request(`${path}?shopDomain=${encodeURIComponent(shopDomain)}`);
  await expectStatus(path, response, 200);
  const csp = response.headers.get('content-security-policy') ?? '';
  const html = await response.text();
  if (!html.includes('data-route-ops-build="present"')) throw new Error(`${path} did not serve present Route Ops build`);
  assertCsp(csp);
  record(path, { status: response.status, csp: cspSummary(csp) });
  return html;
}

async function checkAssets(html) {
  const assets = [...html.matchAll(/(?:src|href)="(\/admin\/ui\/app\/assets\/[^"]+)"/g)].map((match) => match[1]);
  if (assets.length === 0) throw new Error('Route Ops app shell did not reference built assets');
  for (const asset of assets) {
    const response = await request(asset);
    await expectStatus(asset, response, 200);
  }
  record('built-assets', { count: assets.length });
}

async function checkBootstrap() {
  const response = await request(`/admin/ui/app/api/bootstrap?shopDomain=${encodeURIComponent(shopDomain)}`);
  await expectStatus('bootstrap', response, 200);
  assertCsp(response.headers.get('content-security-policy') ?? '');
  const body = await response.json();
  const data = body.data;
  if (!data || data.shopDomain !== shopDomain) throw new Error('bootstrap shopDomain mismatch');
  const mapConfig = data.mapConfig;
  if (expectPublicOpenFreeMap) {
    if (mapConfig.status !== 'configured' || mapConfig.providerMode !== 'public_allowlisted') {
      throw new Error(`expected public allowlisted mapConfig, got ${JSON.stringify(mapConfig)}`);
    }
    if (!mapConfig.allowedHosts?.includes(expectedPublicHost)) throw new Error(`expected allowed host ${expectedPublicHost}`);
  } else {
    if (mapConfig.status !== 'not_configured' || mapConfig.styleUrl !== null) {
      throw new Error(`expected not_configured mapConfig, got ${JSON.stringify(mapConfig)}`);
    }
  }
  record('bootstrap', { status: response.status, mapStatus: mapConfig.status, providerMode: mapConfig.providerMode ?? null });
}

async function checkOrdersPage() {
  await checkAppShell('/admin/ui/app/orders');
}

async function checkOrdersApi() {
  const response = await request(`/admin/ui/app/api/orders?shopDomain=${encodeURIComponent(shopDomain)}&status=unplanned`);
  await expectStatus('orders-api', response, 200);
  const body = await response.json();
  if (!body.data || !Array.isArray(body.data.orders)) throw new Error('orders-api did not return data.orders array');
  record('orders-api', { status: response.status, orders: body.data.orders.length });
}

async function checkVendorAssets() {
  const css = await request('/admin/ui/app/vendor/maplibre-gl.css');
  await expectStatus('vendor-css', css, 200);
  if (!(css.headers.get('content-type') ?? '').includes('text/css')) throw new Error('vendor css content-type mismatch');
  const style = await request('/admin/ui/app/vendor/openfreemap-clever-lite.json');
  await expectStatus('vendor-style', style, 200);
  if (!(style.headers.get('content-type') ?? '').includes('application/json')) throw new Error('vendor style content-type mismatch');
  record('vendor-assets', { status: 200 });
}

function assertCsp(csp) {
  if (!csp.includes("default-src 'none'")) throw new Error('missing strict CSP');
  if (expectPublicOpenFreeMap) {
    if (!csp.includes(`https://${expectedPublicHost}`)) throw new Error(`CSP missing expected public host ${expectedPublicHost}`);
  } else if (/openfreemap\.org|tiles\.openfreemap\.org/.test(csp)) {
    throw new Error(`CSP unexpectedly allowlists public OpenFreeMap host: ${csp}`);
  }
}

function cspSummary(csp) {
  return {
    hasDefaultNone: csp.includes("default-src 'none'"),
    hasPublicOpenFreeMap: /openfreemap\.org|tiles\.openfreemap\.org/.test(csp),
  };
}
