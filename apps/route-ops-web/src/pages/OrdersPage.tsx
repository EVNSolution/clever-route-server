import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { createRoute, getOrders } from '../api';
import { BlockerList, Badge, MiniOrderList } from '../components/primitives';
import { TabLayout } from '../components/TabLayout';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { buildOrderQuery, createDefaultOrderFilters, summarizeSelection, type OrderFilterState } from '../state';
import type { BootstrapPayload, CanonicalOrderDto } from '../types';
import { readErrorMessage, today } from '../utils/format';

export function OrdersPage({ bootstrap, navigate, setError }: { bootstrap: BootstrapPayload; navigate(path: string): void; setError(error: string | null): void }): ReactElement {
  const [orders, setOrders] = useState<CanonicalOrderDto[]>([]);
  const [reviewBlockers, setReviewBlockers] = useState<CanonicalOrderDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState(createDefaultOrderFilters);
  const [routeDate, setRouteDate] = useState(today());
  const [routeName, setRouteName] = useState(`Route ${today()}`);
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => buildOrderQuery(filters), [filters]);
  const selection = useMemo(() => summarizeSelection(orders, selected), [orders, selected]);
  const plannedOrderIds = useMemo(
    () => new Set(orders.filter((order) => order.routePlanId !== null || order.planningStatus !== 'UNPLANNED').map((order) => order.orderId)),
    [orders]
  );

  useEffect(() => {
    setLoading(true);
    getOrders(query)
      .then((payload) => {
        setOrders(payload.orders);
        setReviewBlockers(payload.reviewBlockers);
        setError(null);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [query, setError]);

  const create = async (): Promise<void> => {
    try {
      if (selection.blockers.length > 0 || selection.readySelected.length !== selected.size) {
        throw new Error('Cannot create a partial route. Resolve blockers or select only ready unplanned orders.');
      }
      const result = await createRoute({
        csrfToken: bootstrap.csrfToken,
        depotAddress: null,
        depotLatitude: null,
        depotLongitude: null,
        orderIds: [...selected],
        planDate: routeDate || today(),
        routeName
      });
      navigate(`/admin/ui/app/routes/${encodeURIComponent(result.routePlan.id)}`);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };

  const addSelectedOrder = (orderId: string): void => {
    setSelected((current) => new Set([...current, orderId]));
  };

  return (
    <TabLayout
      title="Orders"
      primary={<RouteOpsMap bootstrap={bootstrap} onOrderSelect={addSelectedOrder} orders={orders} plannedOrderIds={plannedOrderIds} subtitle="Imported WooCommerce stops by current filters" title="Orders map" />}
      secondary={<div className="panel side-panel">
        <span className="eyebrow">New route</span>
        <h2>Create from selected orders</h2>
        <p>{selection.readySelected.length} ready unplanned order(s) selected.</p>
        {selection.blockers.length === 0 ? null : <BlockerList blockers={selection.blockers} />}
        <label>Route date<input type="date" value={routeDate} onChange={(event) => setRouteDate(event.target.value)} /></label>
        <label>Route name<input value={routeName} onChange={(event) => setRouteName(event.target.value)} /></label>
        <button className="primary full" disabled={selected.size === 0} onClick={() => void create()} type="button">Create route</button>
        <div className="divider" />
        <span className="eyebrow">Needs review</span>
        <h3>Delivery metadata blockers</h3>
        <MiniOrderList empty="No orders currently need delivery metadata review." orders={reviewBlockers} />
      </div>}
      lower={<>
        <div className="route-tabs" aria-label="Order planning filters">
          <button className={filters.status === 'unplanned' && filters.health !== 'needs_review' ? 'active' : ''} onClick={() => setFilters({ ...filters, deliveryStatus: '', health: '', status: 'unplanned' })} type="button">Imported / Unplanned</button>
          <button className={filters.status === 'planned' ? 'active' : ''} onClick={() => setFilters({ ...filters, health: '', status: 'planned' })} type="button">Planned</button>
          <button className={filters.health === 'needs_review' ? 'active' : ''} onClick={() => setFilters({ ...filters, deliveryStatus: '', health: 'needs_review', status: '' })} type="button">Needs review</button>
        </div>
        <FilterBar filters={filters} onChange={setFilters} />
        <OrderTable orders={orders} selected={selected} setSelected={setSelected} loading={loading} />
      </>}
    />
  );
}

function FilterBar({ filters, onChange }: { filters: OrderFilterState; onChange(filters: OrderFilterState): void }): ReactElement {
  return <article className="panel filter-panel"><label>Delivery date<input type="date" value={filters.deliveryDate} onChange={(event) => onChange({ ...filters, deliveryDate: event.target.value })} /></label><label>Area / region<input placeholder="Toronto" value={filters.deliveryArea} onChange={(event) => onChange({ ...filters, deliveryArea: event.target.value })} /></label><label>Delivery status<select value={filters.deliveryStatus} onChange={(event) => onChange({ ...filters, deliveryStatus: event.target.value })}><option value="">All</option><option value="ready">Ready</option><option value="needs_review">Needs review</option><option value="completed">Completed</option></select></label><label>Order health<select value={filters.health} onChange={(event) => onChange({ ...filters, health: event.target.value })}><option value="">All</option><option value="normal">Normal</option><option value="needs_review">Needs review</option></select></label><label>Search<input placeholder="#1001, email, phone" value={filters.search} onChange={(event) => onChange({ ...filters, search: event.target.value })} /></label></article>;
}

function OrderTable(input: { loading: boolean; orders: CanonicalOrderDto[]; selected: Set<string>; setSelected(selected: Set<string>): void }): ReactElement {
  if (input.loading) return <article className="panel"><p>Loading imported WooCommerce orders…</p></article>;
  return <article className="panel"><div className="panel-heading"><div><span className="eyebrow">Orders</span><h2>Imported order list</h2></div><Badge>{input.orders.length} orders</Badge></div><table className="ops-table"><thead><tr><th /><th>Order</th><th>Recipient</th><th>Date</th><th>Area</th><th>Status</th><th>Route</th></tr></thead><tbody>{input.orders.map((order) => <tr key={order.orderId} className={order.blockerReasons.length > 0 ? 'needs-review' : ''}><td><input checked={input.selected.has(order.orderId)} onChange={(event) => { const next = new Set(input.selected); if (event.target.checked) next.add(order.orderId); else next.delete(order.orderId); input.setSelected(next); }} type="checkbox" /></td><td><strong>{order.orderName}</strong><small>{order.sourcePlatform ?? 'source'} · {order.sourceOrderNumber ?? order.sourceOrderId}</small></td><td>{order.recipientName ?? '—'}</td><td>{order.deliveryDate ?? 'Review'}</td><td>{order.deliveryArea ?? '—'}</td><td><Badge>{order.health}</Badge></td><td>{order.routePlanName ?? order.planningStatus}</td></tr>)}</tbody></table></article>;
}
