import type { ReactElement, ReactNode } from 'react';

import { getAppCopy } from '../i18n';
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
  const t = getAppCopy(bootstrap.locale);
  return (
    <div className={`ops-shell ops-shell--${activePage}`} data-clever-route-ops-app>
      <aside className="ops-sidebar" aria-label={t.navigationLabel}>
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
          <span className="store-label">{t.storeLabel}</span>
          <strong>{bootstrap.shopDomain ?? t.selectShop}</strong>
          <small>{bootstrap.mode === 'plugin' ? t.wordpressSession : t.internalAdmin}</small>
        </div>
      </aside>
      <main className="ops-main">
        <header className="ops-topbar">
          <div>
            <span className="eyebrow">{t.brandEyebrow}</span>
            <h1>{title}</h1>
          </div>
        </header>
        {error === null ? null : <div className="alert error">{error}</div>}
        {children}
      </main>
    </div>
  );
}
