import type { ReactElement, ReactNode } from 'react';

import type { BootstrapPayload } from '../types';
import { providerModeLabel } from '../maps/provider';

export type RouteOpsPage = 'dashboard' | 'drivers' | 'orders' | 'routes' | 'settings';

export type NavItem = { label: string; page: RouteOpsPage; path: string };

export function AppShell({
  activePage,
  bootstrap,
  children,
  error,
  navItems,
  navigate,
  title
}: {
  activePage: RouteOpsPage;
  bootstrap: BootstrapPayload;
  children: ReactNode;
  error: string | null;
  navItems: NavItem[];
  navigate(path: string): void;
  title: string;
}): ReactElement {
  return (
    <div className="ops-shell" data-clever-route-ops-app>
      <aside className="ops-sidebar" aria-label="Operate navigation">
        <div className="brand-mark"><span>CR</span><strong>clever route</strong></div>
        <nav>
          {navItems.map((item) => (
            <button
              className={activePage === item.page ? 'active' : ''}
              key={item.path}
              onClick={() => navigate(item.path)}
              type="button"
            >
              <span className="nav-dot" />{item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="store-label">Store</span>
          <strong>{bootstrap.shopDomain ?? 'Select shop'}</strong>
          <small>{bootstrap.mode === 'plugin' ? 'WordPress launch session' : 'CLEVER internal admin'}</small>
        </div>
      </aside>
      <main className="ops-main">
        <header className="ops-topbar">
          <div>
            <span className="eyebrow">CLEVER Route App</span>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <StatusPill label="Map" status={bootstrap.mapConfig.status} title={providerModeLabel(bootstrap.mapConfig.providerMode)} />
            <StatusPill label="Router" status={bootstrap.routerConfig.status} />
            <span className="session-pill">{bootstrap.mode === 'plugin' ? 'No extra login' : 'Internal admin'}</span>
          </div>
        </header>
        {error === null ? null : <div className="alert error">{error}</div>}
        {children}
      </main>
    </div>
  );
}

export function StatusPill({ label, status, title }: { label: string; status: string; title?: string }): ReactElement {
  return <span className={`status-pill ${status === 'configured' ? 'ok' : 'warn'}`} title={title}>{label}: {status.replace('_', ' ')}</span>;
}
