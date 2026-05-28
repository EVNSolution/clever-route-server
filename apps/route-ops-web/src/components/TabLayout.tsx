import type { ReactElement, ReactNode } from 'react';

export function TabLayout({
  lower,
  primary,
  primaryExpanded = false,
  secondary,
  title
}: {
  lower?: ReactNode;
  primary: ReactNode;
  primaryExpanded?: boolean;
  secondary: ReactNode;
  title: string;
}): ReactElement {
  return (
    <section className={primaryExpanded ? 'tab-layout primary-expanded' : 'tab-layout'} aria-label={title} data-tab-layout>
      <div className="tab-primary" data-tab-region="primary">{primary}</div>
      <aside className="tab-secondary" data-tab-region="secondary" hidden={primaryExpanded}>{secondary}</aside>
      {lower === undefined ? null : <div className="tab-lower" data-tab-region="lower">{lower}</div>}
    </section>
  );
}
