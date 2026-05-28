import type { ReactElement, ReactNode } from 'react';

import type { CanonicalOrderDto } from '../types';

export function Kpi({ label, value }: { label: string; value: number }): ReactElement {
  return <div className="kpi"><span>{label}</span><strong>{value}</strong></div>;
}

export function Badge({ children }: { children: ReactNode }): ReactElement {
  return <span className="badge">{children}</span>;
}

export function BlockerList({ blockers }: { blockers: string[] }): ReactElement {
  return <div className="alert warning"><strong>Resolve before routing</strong><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>;
}

export function MiniOrderList({ empty, onSelect, orders }: { empty: string; onSelect?(order: CanonicalOrderDto): void; orders: CanonicalOrderDto[] }): ReactElement {
  if (orders.length === 0) return <p className="muted">{empty}</p>;
  return <ul className="mini-list">{orders.map((order) => <li key={order.orderId}><strong>{order.orderName}</strong><small>{order.blockerReasons.join(', ') || order.deliveryDate}</small>{onSelect === undefined ? null : <button onClick={() => onSelect(order)} type="button">Edit</button>}</li>)}</ul>;
}
