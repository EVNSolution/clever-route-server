import type { ReactElement, ReactNode } from 'react';

import type { OperationalPillModel, OperationalPillTone } from '../operationalStatus';

export function Kpi({ label, value }: { label: string; value: number }): ReactElement {
  return <div className="kpi"><span>{label}</span><strong>{value}</strong></div>;
}

export function Badge({ children }: { children: ReactNode }): ReactElement {
  return <span className="badge">{children}</span>;
}

export function OperationalPill({
  ariaLabel,
  children,
  tone = 'neutral',
}: {
  ariaLabel?: string;
  children: ReactNode;
  tone?: OperationalPillTone;
}): ReactElement {
  return <span aria-label={ariaLabel} className={`operational-pill operational-pill--${tone}`}>{children}</span>;
}

export function OperationalPillGroup({
  ariaLabel,
  pills,
}: {
  ariaLabel: string;
  pills: OperationalPillModel[];
}): ReactElement {
  return <div aria-label={ariaLabel} className="operational-pill-group" role="group">{pills.map((pill) => <OperationalPill ariaLabel={pill.ariaLabel} key={pill.key} tone={pill.tone}>{pill.label}</OperationalPill>)}</div>;
}
