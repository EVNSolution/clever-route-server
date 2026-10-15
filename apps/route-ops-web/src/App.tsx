import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  acknowledgeNotification,
  getBootstrap,
  getNotifications,
  markNotificationRead,
  openNotificationChangeStream,
  type NotificationChangeStreamSubscription,
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
    const notificationRefresh = startNotificationRefresh({ loadNotifications });
    return () => {
      cancelled = true;
      notificationRefresh.close();
    };
  }, [bootstrap]);

  const navigate = useCallback((path: string): void => {
    window.history.pushState({}, '', withExistingSearch(path));
    setRoute(parseRoute(path));
  }, []);

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

  const handleNotificationAcknowledge = (item: TopbarNotificationItem): void => {
    if (bootstrap === null || item.acknowledgedAt != null || item.resolvedAt != null) return;
    void acknowledgeNotification({
      csrfToken: bootstrap.csrfToken,
      notificationId: item.id,
    })
      .then((payload) => {
        setNotifications((current) => current.map((currentItem) =>
          currentItem.id === item.id
            ? toTopbarNotificationItem(payload.notification, bootstrap.locale)
            : currentItem,
        ));
      })
      .catch((acknowledgeError: unknown) => setNotificationLoadError(
        getAppCopy(bootstrap.locale).notifications.acknowledgeFailed(
          readErrorMessage(acknowledgeError),
        ),
      ));
  };

  if (bootstrap === null) return <BootFrame error={error} />;

  return (
    <AppShell activePage={route.page} bootstrap={bootstrap} error={error} navItems={buildNavItems(bootstrap.locale)} navigate={navigate} notificationLoadError={notificationLoadError} notificationUnreadCount={notificationUnreadCount} notifications={notifications} onNotificationAcknowledge={handleNotificationAcknowledge} onNotificationOpen={handleNotificationOpen} title={pageTitle(route, bootstrap.locale)}>
      <PageBody bootstrap={bootstrap} navigate={navigate} route={route} setError={setError} />
    </AppShell>
  );
}


export type NotificationRefreshController = {
  close(): void;
};

export function startNotificationRefresh(input: {
  loadNotifications: () => Promise<void>;
  openStream?: typeof openNotificationChangeStream;
}): NotificationRefreshController {
  let closed = false;
  let inFlight = false;
  let queued = false;

  const run = (): void => {
    if (closed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        do {
          queued = false;
          await input.loadNotifications();
        } while (queued && !closed);
      } finally {
        inFlight = false;
        if (queued && !closed) run();
      }
    })();
  };

  const openStream = input.openStream ?? openNotificationChangeStream;
  const notificationStream: NotificationChangeStreamSubscription | null =
    openStream({
      onNotificationsChanged: run,
      onReconnected: run,
    });
  run();

  return {
    close() {
      closed = true;
      notificationStream?.close();
    },
  };
}

export function toTopbarNotificationItem(
  notification: AdminNotificationDto,
  locale: string | null | undefined,
): TopbarNotificationItem {
  const t = getAppCopy(locale).notifications;
  const orderName = readNotificationPayloadString(notification.payload, 'orderName');
  if (notification.type === 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED') {
    return {
      acknowledgedAt: notification.acknowledgedAt,
      alertCycleId: notification.alertCycleId,
      body: t.wooAssignedRouteAddressChangedBody(orderName),
      createdAt: notification.createdAt,
      href: notification.href,
      id: notification.id,
      read: notification.readAt !== null,
      resolvedAt: notification.resolvedAt,
      title: t.wooAssignedRouteAddressChangedTitle,
      tone: notification.severity,
    };
  }
  return {
    acknowledgedAt: notification.acknowledgedAt,
    alertCycleId: notification.alertCycleId,
    body: notification.body,
    createdAt: notification.createdAt,
    href: notification.href,
    id: notification.id,
    read: notification.readAt !== null,
    resolvedAt: notification.resolvedAt,
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

// Tabs the user has opened stay mounted and are only hidden, so coming back
// shows the last screen at once instead of waiting for every list to reload.
// The route-group editor is never kept: it is a draft workspace, not a tab.
export function PageBody(input: {
  bootstrap: BootstrapPayload;
  navigate(path: string): void;
  route: AppRoute;
  setError(error: string | null): void;
}): ReactElement {
  const { bootstrap, navigate, route, setError } = input;
  const grouping = route.page === 'routes' && route.routeGroupId !== null;
  const activeTab = grouping ? null : route.page;
  const [opened, setOpened] = useState<ReadonlySet<Page>>(() => new Set());
  const [lastRoutePlanId, setLastRoutePlanId] = useState<string | null>(null);
  if (activeTab !== null && !opened.has(activeTab)) setOpened(new Set(opened).add(activeTab));
  if (activeTab === 'routes' && route.routePlanId !== lastRoutePlanId) setLastRoutePlanId(route.routePlanId);
  const tab = (page: Page, element: ReactElement): ReactElement | null =>
    page === activeTab || opened.has(page)
      ? <div key={page} hidden={page !== activeTab} style={page === activeTab ? { display: 'contents' } : undefined}>{element}</div>
      : null;
  return (
    <>
      {grouping ? <RouteGroupingPage bootstrap={bootstrap} navigate={navigate} routeGroupId={route.routeGroupId as string} setError={setError} /> : null}
      {tab('dashboard', <DashboardPage bootstrap={bootstrap} navigate={navigate} />)}
      {tab('orders', <OrdersPage active={activeTab === 'orders'} bootstrap={bootstrap} navigate={navigate} setError={setError} />)}
      {tab('routes', <RoutesPage active={activeTab === 'routes'} bootstrap={bootstrap} navigate={navigate} routePlanId={activeTab === 'routes' ? route.routePlanId : lastRoutePlanId} setError={setError} />)}
      {tab('drivers', <DriversPage active={activeTab === 'drivers'} bootstrap={bootstrap} setError={setError} />)}
      {tab('settings', <SettingsPage bootstrap={bootstrap} setError={setError} />)}
    </>
  );
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
