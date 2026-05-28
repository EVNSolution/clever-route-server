import type { ReactElement } from 'react';

import { hideSetupActions } from '../state';
import type { BootstrapPayload } from '../types';

export function DashboardPage({ bootstrap, navigate }: { bootstrap: BootstrapPayload; navigate(path: string): void }): ReactElement {
  return (
    <section className="workspace-grid compact">
      <article className="panel hero-panel">
        <span className="eyebrow">Today</span>
        <h2>Daily route command center</h2>
        <p>Open Orders to review WooCommerce stops, create a date route, then manage sequence and drivers in Route Builder.</p>
        <div className="button-row">
          <button className="primary" onClick={() => navigate('/admin/ui/app/orders')} type="button">Open orders</button>
          <button onClick={() => navigate('/admin/ui/app/routes')} type="button">View routes</button>
        </div>
      </article>
      <article className="panel">
        <span className="eyebrow">Session</span>
        <h2>{bootstrap.shopDomain ?? 'No shop selected'}</h2>
        <p>{hideSetupActions(bootstrap) ? 'Locked to the WordPress shop that launched this workspace.' : 'Internal admin can select a shop through approved admin surfaces.'}</p>
      </article>
    </section>
  );
}
