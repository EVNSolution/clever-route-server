import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getBootstrap } from './api';
import { AppShell, type NavItem, type RouteOpsPage } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { DriversPage } from './pages/DriversPage';
import { OrdersPage } from './pages/OrdersPage';
import { RoutesPage } from './pages/RoutesPage';
import { SettingsPage } from './pages/SettingsPage';
import { getAppCopy, resolveLocale } from './i18n';
import type { BootstrapPayload } from './types';
import { readErrorMessage } from './utils/format';

type Page = RouteOpsPage;

type AppRoute = {
  page: Page;
  routePlanId: string | null;
};

function buildNavItems(locale: string | null | undefined): NavItem[] {
  const t = getAppCopy(locale);
  return [
    { label: t.nav.dashboard, page: 'dashboard', path: '/admin/ui/app/dashboard' },
    { label: t.nav.orders, page: 'orders', path: '/admin/ui/app/orders' },
    { label: t.nav.routes, page: 'routes', path: '/admin/ui/app/routes' },
    { label: t.nav.drivers, page: 'drivers', path: '/admin/ui/app/drivers' },
    { label: t.nav.settings, page: 'settings', path: '/admin/ui/app/settings' }
  ];
}

export function App(): ReactElement {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    getBootstrap()
      .then((payload) => {
        setBootstrap(payload);
        setError(null);
      })
      .catch((loadError: unknown) => setError(readErrorMessage(loadError)));
  }, []);

  const navigate = (path: string): void => {
    window.history.pushState({}, '', withExistingSearch(path));
    setRoute(parseRoute(path));
  };

  if (bootstrap === null) return <BootFrame error={error} />;

  return (
    <AppShell activePage={route.page} bootstrap={bootstrap} error={error} navItems={buildNavItems(bootstrap.locale)} navigate={navigate} title={pageTitle(route, bootstrap.locale)}>
      <PageBody bootstrap={bootstrap} navigate={navigate} route={route} setError={setError} />
    </AppShell>
  );
}

function BootFrame({ error }: { error: string | null }): ReactElement {
  const t = getAppCopy(readBrowserLocale());
  return (
    <main className="boot-frame">
      <div className="boot-card">
        <span className="eyebrow">{t.brandEyebrow}</span>
        <h1>{t.bootTitle}</h1>
        {error === null ? <p>{t.bootMessage}</p> : <div className="alert error">{error}</div>}
      </div>
    </main>
  );
}

function readBrowserLocale(): string | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.language;
}

function PageBody(input: {
  bootstrap: BootstrapPayload;
  navigate(path: string): void;
  route: AppRoute;
  setError(error: string | null): void;
}): ReactElement {
  if (input.route.page === 'orders') return <OrdersPage bootstrap={input.bootstrap} navigate={input.navigate} setError={input.setError} />;
  if (input.route.page === 'routes') return <RoutesPage bootstrap={input.bootstrap} navigate={input.navigate} routePlanId={input.route.routePlanId} setError={input.setError} />;
  if (input.route.page === 'drivers') return <DriversPage bootstrap={input.bootstrap} setError={input.setError} />;
  if (input.route.page === 'settings') return <SettingsPage bootstrap={input.bootstrap} setError={input.setError} />;
  return <DashboardPage bootstrap={input.bootstrap} navigate={input.navigate} />;
}

function parseRoute(pathname: string): AppRoute {
  const match = /^\/admin\/ui\/app\/routes\/([^/]+)/u.exec(pathname);
  if (match?.[1] !== undefined) return { page: 'routes', routePlanId: decodeURIComponent(match[1]) };
  if (pathname.includes('/drivers')) return { page: 'drivers', routePlanId: null };
  if (pathname.includes('/orders')) return { page: 'orders', routePlanId: null };
  if (pathname.includes('/routes')) return { page: 'routes', routePlanId: null };
  if (pathname.includes('/settings')) return { page: 'settings', routePlanId: null };
  return { page: 'dashboard', routePlanId: null };
}

function pageTitle(route: AppRoute, locale: string | null | undefined): string {
  const t = getAppCopy(resolveLocale(locale)).pageTitle;
  if (route.page === 'orders') return t.orders;
  if (route.page === 'routes' && route.routePlanId !== null) return t.routeBuilder;
  if (route.page === 'routes') return t.routes;
  if (route.page === 'drivers') return t.drivers;
  if (route.page === 'settings') return t.settings;
  return t.dashboard;
}

function withExistingSearch(path: string): string {
  const search = window.location.search;
  if (search === '') return path;
  return `${path}${search}`;
}
