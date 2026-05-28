import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { assignDriver, getDrivers, getRouteDetail, getRoutes, optimizeRoute, saveStopSequence } from '../api';
import { Badge, Kpi } from '../components/primitives';
import { TabLayout } from '../components/TabLayout';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { deriveRouteStats, geometryLabel, moveStop, moveStopBefore } from '../state';
import type { BootstrapPayload, DriverDto, RoutePlanDetailDto, RoutePlanSummaryDto, RouteStopDto } from '../types';
import { readErrorMessage } from '../utils/format';

export function RoutesPage({ bootstrap, navigate, routePlanId, setError }: { bootstrap: BootstrapPayload; navigate(path: string): void; routePlanId: string | null; setError(error: string | null): void }): ReactElement {
  const [routes, setRoutes] = useState<RoutePlanSummaryDto[]>([]);
  const [detail, setDetail] = useState<RoutePlanDetailDto | null>(null);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);

  useEffect(() => {
    getRoutes('').then((payload) => { setRoutes(payload.routePlans); setError(null); }).catch((error: unknown) => setError(readErrorMessage(error)));
    getDrivers().then((payload) => setDrivers(payload.drivers)).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  useEffect(() => {
    if (routePlanId === null) {
      setDetail(null);
      return;
    }
    getRouteDetail(routePlanId).then((payload) => { setDetail(payload); setError(null); }).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [routePlanId, setError]);

  if (routePlanId !== null) {
    return <RouteBuilder bootstrap={bootstrap} detail={detail} drivers={drivers} navigate={navigate} setDetail={setDetail} setError={setError} />;
  }

  return (
    <section className="workspace-stack">
      <div className="summary-strip">
        <Kpi label="Routes" value={routes.length} />
        <Kpi label="Stops" value={routes.reduce((sum, item) => sum + item.stopsCount, 0)} />
        <Kpi label="Missing coordinates" value={routes.reduce((sum, item) => sum + item.missingCoordinates, 0)} />
      </div>
      <article className="panel">
        <div className="panel-heading"><div><span className="eyebrow">Routes</span><h2>Recent route plans</h2></div><button className="primary" onClick={() => navigate('/admin/ui/app/orders')} type="button">Create route</button></div>
        <table className="ops-table"><thead><tr><th>Name</th><th>Status</th><th>Stops</th><th>Date</th><th>Driver</th><th /></tr></thead><tbody>{routes.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td><Badge>{item.status}</Badge></td><td>{item.stopsCount}</td><td>{item.deliveryDate ?? item.planDate}</td><td>{item.driverId ?? 'Unassigned'}</td><td><button onClick={() => navigate(`/admin/ui/app/routes/${encodeURIComponent(item.id)}`)} type="button">Open</button></td></tr>)}</tbody></table>
      </article>
    </section>
  );
}

function RouteBuilder(input: {
  bootstrap: BootstrapPayload;
  detail: RoutePlanDetailDto | null;
  drivers: DriverDto[];
  navigate(path: string): void;
  setDetail(detail: RoutePlanDetailDto): void;
  setError(error: string | null): void;
}): ReactElement {
  const [draftStops, setDraftStops] = useState<RouteStopDto[]>([]);
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const detail = input.detail;
  useEffect(() => setDraftStops(detail?.stops ?? []), [detail]);
  const stats = deriveRouteStats(detail);

  const save = async (): Promise<void> => {
    if (detail === null) return;
    try {
      const updated = await saveStopSequence(detail.routePlan.id, input.bootstrap.csrfToken, draftStops.map((stop) => ({ deliveryStopId: stop.deliveryStopId, sourceOrderId: stop.sourceOrderId })));
      input.setDetail(updated);
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    }
  };

  const optimize = async (): Promise<void> => {
    if (detail === null) return;
    try {
      input.setDetail(await optimizeRoute(detail.routePlan.id, input.bootstrap.csrfToken));
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    }
  };

  const assign = async (driverId: string): Promise<void> => {
    if (detail === null) return;
    try {
      input.setDetail(await assignDriver(detail.routePlan.id, input.bootstrap.csrfToken, driverId === '' ? null : driverId));
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    }
  };

  return (
    <TabLayout
      title="Route Builder"
      primary={<RouteOpsMap bootstrap={input.bootstrap} detail={detail} subtitle={geometryLabel(detail, input.bootstrap.routerConfig.status)} title={detail?.routePlan.name ?? 'Route Builder'} />}
      secondary={<div className="panel side-panel wide">
        <div className="panel-heading"><div><span className="eyebrow">Route Builder</span><h2>{detail?.routePlan.name ?? 'Loading route…'}</h2></div><button onClick={() => input.navigate('/admin/ui/app/routes')} type="button">All routes</button></div>
        <label>Assigned driver<select value={detail?.routePlan.driverId ?? ''} onChange={(event) => void assign(event.target.value)}><option value="">Unassigned</option>{input.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.displayName}</option>)}</select></label>
        <div className="button-row"><button className="primary" onClick={() => void save()} type="button">Save sequence</button><button onClick={() => void optimize()} type="button">Optimize sequence · CLEVER v1</button></div>
        <ol className="stop-list">{draftStops.map((stop) => <li className={draggingStopId === stop.deliveryStopId ? 'dragging' : ''} draggable key={stop.deliveryStopId} onDragEnd={() => setDraggingStopId(null)} onDragOver={(event) => event.preventDefault()} onDragStart={() => setDraggingStopId(stop.deliveryStopId)} onDrop={(event) => { event.preventDefault(); if (draggingStopId !== null) setDraftStops(moveStopBefore(draftStops, draggingStopId, stop.deliveryStopId)); setDraggingStopId(null); }}><span className="stop-number">{stop.sequence}</span><div><strong>{stop.orderName}</strong><small>{stop.recipientName ?? 'No recipient'} · {stop.addressLabel}</small></div><div className="stop-actions"><button onClick={() => setDraftStops(moveStop(draftStops, stop.deliveryStopId, -1))} type="button">↑</button><button onClick={() => setDraftStops(moveStop(draftStops, stop.deliveryStopId, 1))} type="button">↓</button></div></li>)}</ol>
      </div>}
      lower={<div className="summary-strip compact-kpis"><Kpi label="Stops" value={stats.stops} /><Kpi label="Completed" value={stats.completed} /><Kpi label="Attempted" value={stats.attempted} /><Kpi label="Missing coords" value={stats.missingCoordinates} /></div>}
    />
  );
}
