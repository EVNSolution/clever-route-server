import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { assignDriver, deleteRoute, getDrivers, getRouteDetail, getRoutes, publishRoute, saveStopSequence } from '../api';
import { Badge, Kpi } from '../components/primitives';
import { TabLayout } from '../components/TabLayout';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { deriveRouteStats, geometryLabel, hasStopSequenceChanged, moveStop, moveStopBefore } from '../state';
import type { BootstrapPayload, DriverDto, RoutePlanDetailDto, RoutePlanSummaryDto, RouteStopDto } from '../types';
import { readErrorMessage } from '../utils/format';

export function getDriverOptionLabel(driver: DriverDto): string {
  const appAccess = driver.appLinked || driver.authStatus === 'APP_LINKED' ? 'App linked' : 'Invite pending';
  return `${driver.displayName} · ${appAccess}`;
}

export function getRouteDriverDisplay(routePlan: Pick<RoutePlanSummaryDto, 'driverId'> | null, drivers: DriverDto[]): string {
  if (routePlan?.driverId == null) return 'Unassigned';
  const driver = drivers.find((item) => item.id === routePlan.driverId);
  return driver === undefined ? routePlan.driverId : getDriverOptionLabel(driver);
}

export function isRouteVisibleToLinkedDriver(routePlan: Pick<RoutePlanSummaryDto, 'driverId' | 'status'>, drivers: DriverDto[]): boolean {
  if (routePlan.driverId === null) return false;
  const driver = drivers.find((item) => item.id === routePlan.driverId);
  const isDriverLinked = driver?.appLinked === true || driver?.authStatus === 'APP_LINKED';
  return isDriverLinked && ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'].includes(routePlan.status);
}

export function getRoutePublishNotice(routePlan: Pick<RoutePlanSummaryDto, 'driverId' | 'status' | 'stopsCount'> | null, drivers: DriverDto[]): { tone: 'green' | 'orange' | 'neutral'; text: string } | null {
  if (routePlan === null) return null;
  const driver = routePlan.driverId === null ? null : drivers.find((item) => item.id === routePlan.driverId) ?? null;
  const isPublished = ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'].includes(routePlan.status);
  if (routePlan.status === 'DRAFT') {
    if (routePlan.driverId === null) return { tone: 'orange', text: 'Draft route — assign a driver, then publish to make it visible in the driver app.' };
    if (routePlan.stopsCount === 0) return { tone: 'orange', text: 'Draft route — add stops before publishing.' };
    return { tone: 'orange', text: 'Draft route — driver is assigned, but the route is not visible in the driver app until you publish it.' };
  }
  if (isPublished && driver !== null && (driver.appLinked || driver.authStatus === 'APP_LINKED')) {
    return { tone: 'green', text: 'Published route — visible to the linked driver after the app refreshes.' };
  }
  if (isPublished && routePlan.driverId !== null) {
    return { tone: 'neutral', text: 'Published route — the assigned driver can see it after app authentication.' };
  }
  return null;
}

export function RoutesPage({ bootstrap, navigate, routePlanId, setError }: { bootstrap: BootstrapPayload; navigate(path: string): void; routePlanId: string | null; setError(error: string | null): void }): ReactElement {
  const [routes, setRoutes] = useState<RoutePlanSummaryDto[]>([]);
  const [detail, setDetail] = useState<RoutePlanDetailDto | null>(null);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [deletingRouteId, setDeletingRouteId] = useState<string | null>(null);

  const refreshRoutes = useCallback(async (): Promise<void> => {
    try {
      const payload = await getRoutes('');
      setRoutes(payload.routePlans);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  }, [setError]);

  useEffect(() => {
    void refreshRoutes();
    getDrivers().then((payload) => setDrivers(payload.drivers)).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [refreshRoutes, setError]);

  useEffect(() => {
    if (routePlanId === null) {
      setDetail(null);
      return;
    }
    getRouteDetail(routePlanId).then((payload) => { setDetail(payload); setError(null); }).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [routePlanId, setError]);

  if (routePlanId !== null) {
    return <RouteBuilder bootstrap={bootstrap} deletingRouteId={deletingRouteId} detail={detail} drivers={drivers} navigate={navigate} onDeleteRoute={(id) => void deleteRoutePlan(id)} onRefreshRoutes={() => void refreshRoutes()} setDetail={setDetail} setError={setError} />;
  }

  async function deleteRoutePlan(routeId: string): Promise<void> {
    const route = routes.find((item) => item.id === routeId) ?? detail?.routePlan ?? null;
    const routeName = route?.name ?? 'this route';
    if (!window.confirm(`Delete ${routeName}? Orders will return to the unplanned list.`)) return;
    setDeletingRouteId(routeId);
    try {
      await deleteRoute(routeId, bootstrap.csrfToken);
      setRoutes((current) => current.filter((item) => item.id !== routeId));
      if (routePlanId === routeId) {
        setDetail(null);
        navigate('/admin/ui/app/routes');
      }
      await refreshRoutes();
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setDeletingRouteId(null);
    }
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
        <table className="ops-table"><thead><tr><th>Name</th><th>Status</th><th>Stops</th><th>Date</th><th>Driver</th><th /></tr></thead><tbody>{routes.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td><Badge>{item.status}</Badge></td><td>{item.stopsCount}</td><td>{item.deliveryDate ?? item.planDate}</td><td>{getRouteDriverDisplay(item, drivers)}</td><td><div className="route-row-actions"><button onClick={() => navigate(`/admin/ui/app/routes/${encodeURIComponent(item.id)}`)} type="button">Open</button><button className="danger subtle" disabled={deletingRouteId === item.id} onClick={() => void deleteRoutePlan(item.id)} type="button">{deletingRouteId === item.id ? 'Deleting…' : 'Delete'}</button></div></td></tr>)}</tbody></table>
      </article>
    </section>
  );
}

function RouteBuilder(input: {
  bootstrap: BootstrapPayload;
  deletingRouteId: string | null;
  detail: RoutePlanDetailDto | null;
  drivers: DriverDto[];
  navigate(path: string): void;
  onDeleteRoute(routePlanId: string): void;
  onRefreshRoutes(): void;
  setDetail(detail: RoutePlanDetailDto): void;
  setError(error: string | null): void;
}): ReactElement {
  const [draftStops, setDraftStops] = useState<RouteStopDto[]>([]);
  const [draftDriverId, setDraftDriverId] = useState('');
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const [isSavingDriver, setIsSavingDriver] = useState(false);
  const [isSavingSequence, setIsSavingSequence] = useState(false);
  const [isPublishingRoute, setIsPublishingRoute] = useState(false);
  const detail = input.detail;
  useEffect(() => setDraftStops(detail?.stops ?? []), [detail]);
  useEffect(() => setDraftDriverId(detail?.routePlan.driverId ?? ''), [detail?.routePlan.driverId]);
  const stats = deriveRouteStats(detail);
  const hasSequenceChanges = hasStopSequenceChanged(detail?.stops, draftStops);
  const hasDriverChanges = detail !== null && draftDriverId !== (detail.routePlan.driverId ?? '');
  const publishNotice = getRoutePublishNotice(detail?.routePlan ?? null, input.drivers);
  const canPublishRoute = detail !== null && detail.routePlan.status === 'DRAFT' && detail.routePlan.driverId !== null && detail.routePlan.stopsCount > 0;

  const save = async (): Promise<void> => {
    if (detail === null || !hasSequenceChanges || isSavingSequence) return;
    setIsSavingSequence(true);
    try {
      const updated = await saveStopSequence(detail.routePlan.id, input.bootstrap.csrfToken, draftStops.map((stop) => ({ deliveryStopId: stop.deliveryStopId, sourceOrderId: stop.sourceOrderId })));
      input.setDetail(updated);
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsSavingSequence(false);
    }
  };

  const assign = async (): Promise<void> => {
    if (detail === null || !hasDriverChanges || isSavingDriver) return;
    setIsSavingDriver(true);
    try {
      input.setDetail(await assignDriver(detail.routePlan.id, input.bootstrap.csrfToken, draftDriverId === '' ? null : draftDriverId));
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsSavingDriver(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (detail === null || !canPublishRoute || isPublishingRoute) return;
    setIsPublishingRoute(true);
    try {
      input.setDetail(await publishRoute(detail.routePlan.id, input.bootstrap.csrfToken));
      input.onRefreshRoutes();
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsPublishingRoute(false);
    }
  };

  return (
    <TabLayout
      title="Route Builder"
      primary={<RouteOpsMap bootstrap={input.bootstrap} detail={detail} subtitle={geometryLabel(detail, input.bootstrap.routerConfig.status)} title={detail?.routePlan.name ?? 'Route Builder'} />}
      secondary={<div className="panel side-panel wide">
        <div className="panel-heading"><div><span className="eyebrow">Route Builder</span><h2>{detail?.routePlan.name ?? 'Loading route…'}</h2></div><div className="route-row-actions"><button onClick={() => input.navigate('/admin/ui/app/routes')} type="button">All routes</button><button className="danger subtle" disabled={detail === null || input.deletingRouteId === detail.routePlan.id} onClick={() => { if (detail !== null) input.onDeleteRoute(detail.routePlan.id); }} type="button">{detail !== null && input.deletingRouteId === detail.routePlan.id ? 'Deleting…' : 'Delete'}</button></div></div>
        {publishNotice === null ? null : <div className={`route-publish-notice ${publishNotice.tone}`}>{publishNotice.text}</div>}
        <label>Assigned driver<select value={draftDriverId} onChange={(event) => setDraftDriverId(event.target.value)}><option value="">Unassigned</option>{input.drivers.map((driver) => <option key={driver.id} value={driver.id}>{getDriverOptionLabel(driver)}</option>)}</select></label>
        <div className="button-row"><button aria-label="save assigned driver" className="primary route-save-button" disabled={!hasDriverChanges || isSavingDriver} onClick={() => void assign()} type="button">{isSavingDriver ? 'saving driver…' : 'save driver'}</button><small className="muted">{getRouteDriverDisplay(detail?.routePlan ?? null, input.drivers)}</small></div>
        <div className="button-row"><button aria-label="publish route" className="primary route-save-button" disabled={!canPublishRoute || isPublishingRoute} onClick={() => void publish()} type="button">{isPublishingRoute ? 'publishing…' : 'Publish route'}</button><small className="muted">{detail === null ? 'Load route before publishing.' : isRouteVisibleToLinkedDriver(detail.routePlan, input.drivers) ? 'Driver app visible' : 'Not visible to driver app yet'}</small></div>
        <div className="button-row"><button aria-label="save route stop sequence" className="primary route-save-button" disabled={!hasSequenceChanges || isSavingSequence} onClick={() => void save()} type="button">{isSavingSequence ? 'saving…' : 'save'}</button></div>
        <ol className="stop-list">{draftStops.map((stop, index) => <li className={draggingStopId === stop.deliveryStopId ? 'dragging' : ''} draggable key={stop.deliveryStopId} onDragEnd={() => setDraggingStopId(null)} onDragOver={(event) => event.preventDefault()} onDragStart={() => setDraggingStopId(stop.deliveryStopId)} onDrop={(event) => { event.preventDefault(); if (draggingStopId !== null) setDraftStops(moveStopBefore(draftStops, draggingStopId, stop.deliveryStopId)); setDraggingStopId(null); }}><span className="stop-number">{stop.sequence}</span><div><strong>{stop.orderName}</strong><small>{stop.recipientName ?? 'No recipient'} · {stop.addressLabel}</small></div><div className="stop-actions"><button aria-label={`Move ${stop.orderName} up`} disabled={index === 0} onClick={() => setDraftStops(moveStop(draftStops, stop.deliveryStopId, -1))} type="button">↑</button><button aria-label={`Move ${stop.orderName} down`} disabled={index === draftStops.length - 1} onClick={() => setDraftStops(moveStop(draftStops, stop.deliveryStopId, 1))} type="button">↓</button></div></li>)}</ol>
      </div>}
      lower={<div className="summary-strip compact-kpis"><Kpi label="Stops" value={stats.stops} /><Kpi label="Completed" value={stats.completed} /><Kpi label="Attempted" value={stats.attempted} /><Kpi label="Missing coords" value={stats.missingCoordinates} /></div>}
    />
  );
}
