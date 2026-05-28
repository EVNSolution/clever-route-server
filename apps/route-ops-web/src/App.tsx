import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getBootstrap } from './api';
import { AppShell, type NavItem, type RouteOpsPage } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { DriversPage } from './pages/DriversPage';
import { OrdersPage } from './pages/OrdersPage';
import { RoutesPage } from './pages/RoutesPage';
import { SettingsPage } from './pages/SettingsPage';
import type { BootstrapPayload } from './types';
import { readErrorMessage } from './utils/format';

type Page = RouteOpsPage;

type AppRoute = {
  page: Page;
  routePlanId: string | null;
};

const navItems: NavItem[] = [
  { label: 'Dashboard', page: 'dashboard', path: '/admin/ui/app/dashboard' },
  { label: 'Orders', page: 'orders', path: '/admin/ui/app/orders' },
  { label: 'Routes', page: 'routes', path: '/admin/ui/app/routes' },
  { label: 'Drivers & Vehicles', page: 'drivers', path: '/admin/ui/app/drivers' },
  { label: 'Settings', page: 'settings', path: '/admin/ui/app/settings' }
];

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
    <AppShell activePage={route.page} bootstrap={bootstrap} error={error} navItems={navItems} navigate={navigate} title={pageTitle(route)}>
      <PageBody bootstrap={bootstrap} navigate={navigate} route={route} setError={setError} />
    </AppShell>
  );
}

function BootFrame({ error }: { error: string | null }): ReactElement {
  return (
    <main className="boot-frame">
      <div className="boot-card">
        <span className="eyebrow">CLEVER Route App</span>
        <h1>Loading route operations…</h1>
        {error === null ? <p>Checking the WordPress launch session and operator workspace.</p> : <div className="alert error">{error}</div>}
      </div>
    </main>
  );
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

function pageTitle(route: AppRoute): string {
  if (route.page === 'orders') return 'Orders';
  if (route.page === 'routes' && route.routePlanId !== null) return 'Route Builder';
  if (route.page === 'routes') return 'Routes';
  if (route.page === 'drivers') return 'Drivers & Vehicles';
  if (route.page === 'settings') return 'Settings';
  return 'Dashboard';
}

function withExistingSearch(path: string): string {
  const search = window.location.search;
  if (search === '') return path;
  return `${path}${search}`;
}
