import type { ReactElement, ReactNode } from 'react';

import type { BootstrapPayload } from '../types';

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
        </header>
        {error === null ? null : <div className="alert error">{error}</div>}
        {children}
      </main>
    </div>
  );
}
