import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  getBootstrap,
  getNotifications,
  markNotificationRead,
} from './api';
import { AppShell, type NavItem, type RouteOpsPage } from './components/AppShell';
import type { TopbarNotificationItem } from './components/TopbarNotifications';
import { DashboardPage } from './pages/DashboardPage';
import { DriversPage } from './pages/DriversPage';
import { OrdersPage } from './pages/OrdersPage';
import { RoutesPage } from './pages/RoutesPage';
import { RouteGroupingPage } from './pages/RouteGroupingPage';
import { SettingsPage } from './pages/SettingsPage';
import { getAppCopy, resolveLocale } from './i18n';
import type { AdminNotificationDto, BootstrapPayload } from './types';
import { readErrorMessage } from './utils/format';

type Page = RouteOpsPage;

type AppRoute = {
  page: Page;
  routeGroupId: string | null;
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
  const [notifications, setNotifications] = useState<TopbarNotificationItem[]>([]);
  const [notificationLoadError, setNotificationLoadError] = useState<string | null>(null);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
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

  useEffect(() => {
    if (bootstrap === null) return undefined;
    if (bootstrap.shopDomain === null) {
      setNotifications([]);
      setNotificationLoadError(null);
      setNotificationUnreadCount(0);
      return undefined;
    }
    let cancelled = false;
    const loadNotifications = async (): Promise<void> => {
      try {
        const payload = await getNotifications('limit=30');
        if (!cancelled) {
          setNotifications(
            payload.notifications.map((item) =>
              toTopbarNotificationItem(item, bootstrap.locale),
            ),
          );
          setNotificationUnreadCount(payload.unreadCount);
          setNotificationLoadError(null);
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setNotificationLoadError(
            getAppCopy(bootstrap.locale).notifications.loadFailed(
              readErrorMessage(loadError),
            ),
          );
        }
      }
    };
    void loadNotifications();
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  const navigate = (path: string): void => {
    window.history.pushState({}, '', withExistingSearch(path));
    setRoute(parseRoute(path));
  };

  const handleNotificationOpen = (item: TopbarNotificationItem): void => {
    if (bootstrap === null || item.read === true) return;
    void markNotificationRead({
      csrfToken: bootstrap.csrfToken,
      notificationId: item.id,
    })
      .then(() => {
        setNotifications((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? { ...currentItem, read: true }
            : currentItem,
          ),
        );
        setNotificationUnreadCount((current) =>
          item.read === true ? current : Math.max(0, current - 1),
        );
      })
      .catch(() => undefined);
  };

  if (bootstrap === null) return <BootFrame error={error} />;

  return (
    <AppShell activePage={route.page} bootstrap={bootstrap} error={error} navItems={buildNavItems(bootstrap.locale)} navigate={navigate} notificationLoadError={notificationLoadError} notificationUnreadCount={notificationUnreadCount} notifications={notifications} onNotificationOpen={handleNotificationOpen} title={pageTitle(route, bootstrap.locale)}>
      <PageBody bootstrap={bootstrap} navigate={navigate} route={route} setError={setError} />
    </AppShell>
  );
}

export function toTopbarNotificationItem(
  notification: AdminNotificationDto,
  locale: string | null | undefined,
): TopbarNotificationItem {
  const t = getAppCopy(locale).notifications;
  const orderName = readNotificationPayloadString(notification.payload, 'orderName');
  if (notification.type === 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED') {
    return {
      body: t.wooAssignedRouteAddressChangedBody(orderName),
      createdAt: notification.createdAt,
      href: notification.href,
      id: notification.id,
      read: notification.readAt !== null,
      title: t.wooAssignedRouteAddressChangedTitle,
      tone: notification.severity,
    };
  }
  return {
    body: notification.body,
    createdAt: notification.createdAt,
    href: notification.href,
    id: notification.id,
    read: notification.readAt !== null,
    title: notification.title,
    tone: notification.severity,
  };
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
  if (input.route.page === 'routes' && input.route.routeGroupId !== null) return <RouteGroupingPage bootstrap={input.bootstrap} navigate={input.navigate} routeGroupId={input.route.routeGroupId} setError={input.setError} />;
  if (input.route.page === 'routes') return <RoutesPage bootstrap={input.bootstrap} navigate={input.navigate} routePlanId={input.route.routePlanId} setError={input.setError} />;
  if (input.route.page === 'drivers') return <DriversPage bootstrap={input.bootstrap} setError={input.setError} />;
  if (input.route.page === 'settings') return <SettingsPage bootstrap={input.bootstrap} setError={input.setError} />;
  return <DashboardPage bootstrap={input.bootstrap} navigate={input.navigate} />;
}

function parseRoute(pathname: string): AppRoute {
  const groupMatch = /^\/admin\/ui\/app\/route-groups\/([^/]+)/u.exec(pathname);
  if (groupMatch?.[1] !== undefined) return { page: 'routes', routeGroupId: decodeURIComponent(groupMatch[1]), routePlanId: null };
  const match = /^\/admin\/ui\/app\/routes\/([^/]+)/u.exec(pathname);
  if (match?.[1] !== undefined) return { page: 'routes', routeGroupId: null, routePlanId: decodeURIComponent(match[1]) };
  if (pathname.includes('/drivers')) return { page: 'drivers', routeGroupId: null, routePlanId: null };
  if (pathname.includes('/orders')) return { page: 'orders', routeGroupId: null, routePlanId: null };
  if (pathname.includes('/routes')) return { page: 'routes', routeGroupId: null, routePlanId: null };
  if (pathname.includes('/settings')) return { page: 'settings', routeGroupId: null, routePlanId: null };
  return { page: 'dashboard', routeGroupId: null, routePlanId: null };
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

function readNotificationPayloadString(
  payload: AdminNotificationDto['payload'],
  field: string,
): string | null {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = payload[field];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function withExistingSearch(path: string): string {
  const search = window.location.search;
  if (search === '') return path;
  return `${path}${search}`;
}
