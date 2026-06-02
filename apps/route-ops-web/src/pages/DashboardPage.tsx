import type { ReactElement } from 'react';

import { getDashboardCopy } from '../i18n';
import { hideSetupActions } from '../state';
import type { BootstrapPayload } from '../types';

export function DashboardPage({ bootstrap, navigate }: { bootstrap: BootstrapPayload; navigate(path: string): void }): ReactElement {
  const t = getDashboardCopy(bootstrap.locale);
  return (
    <section className="workspace-grid compact">
      <article className="panel hero-panel">
        <span className="eyebrow">{t.today}</span>
        <h2>{t.title}</h2>
        <p>{t.description}</p>
        <div className="button-row">
          <button className="primary" onClick={() => navigate('/admin/ui/app/orders')} type="button">{t.openOrders}</button>
          <button onClick={() => navigate('/admin/ui/app/routes')} type="button">{t.viewRoutes}</button>
        </div>
      </article>
      <article className="panel">
        <span className="eyebrow">{t.session}</span>
        <h2>{bootstrap.shopDomain ?? t.noShopSelected}</h2>
        <p>{hideSetupActions(bootstrap) ? t.pluginSession : t.internalSession}</p>
      </article>
    </section>
  );
}
