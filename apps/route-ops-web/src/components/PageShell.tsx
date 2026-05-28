import type { ReactElement, ReactNode } from 'react';

export function PageShell({ actions, children, eyebrow, title }: { actions?: ReactNode; children: ReactNode; eyebrow?: string; title: string }): ReactElement {
  return (
    <section className="page-shell">
      <div className="page-heading">
        <div>
          {eyebrow === undefined ? null : <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {actions === undefined ? null : <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
