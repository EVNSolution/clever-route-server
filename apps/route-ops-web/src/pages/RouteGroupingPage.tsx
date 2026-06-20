import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import {
  generateRouteGroupingChildRoutes,
  getDrivers,
  getRouteGrouping,
  getSettings,
  resolveRouteGroupingAssignments,
  saveRouteGroupingPolygons,
} from "../api";
import { Badge } from "../components/primitives";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { ROUTE_GROUPING_POLYGON_COLORS, appendPolygonVertex, closePolygonDraft, polygonDraftToGeoJson, removeLastPolygonVertex, routeGroupingPolygonColor } from "../routeGrouping";
import { storeSettingsToDepotPoint } from "../state";
import type { BootstrapPayload, CanonicalOrderDto, DriverDto, RouteGroupingDetailDto, StoreSettingsDto } from "../types";
import { readErrorMessage } from "../utils/format";

type PolygonDraft = { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> };

export function RouteGroupingPage({
  bootstrap,
  navigate,
  routeGroupId,
  setError,
}: {
  bootstrap: BootstrapPayload;
  navigate(path: string): void;
  routeGroupId: string;
  setError(error: string | null): void;
}): ReactElement {
  const [grouping, setGrouping] = useState<RouteGroupingDetailDto | null>(null);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [settings, setSettings] = useState<StoreSettingsDto | null>(null);
  const [activeDriverId, setActiveDriverId] = useState("");
  const [draft, setDraft] = useState<PolygonDraft>({ closed: false, vertices: [] });
  const [draftColor, setDraftColor] = useState(routeGroupingPolygonColor(0));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRouteGrouping(routeGroupId)
      .then((payload) => {
        setGrouping(payload.routeGroup);
        setError(null);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)));
    getDrivers()
      .then((payload) => setDrivers(payload.drivers))
      .catch((error: unknown) => setError(readErrorMessage(error)));
    getSettings()
      .then((payload) => setSettings(payload.settings))
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [routeGroupId, setError]);

  const mapOrders = useMemo(
    () => grouping?.assignments.map(assignmentToOrder) ?? [],
    [grouping?.assignments],
  );
  const depotPoint = useMemo(
    () => storeSettingsToDepotPoint(settings, bootstrap.locale),
    [bootstrap.locale, settings],
  );
  const unresolved = grouping?.assignments.filter((assignment) => assignment.assignmentStatus !== "ASSIGNED") ?? [];
  const draftReady = draft.closed && draft.vertices.length >= 3;

  useEffect(() => {
    if (grouping === null || draft.vertices.length > 0) return;
    setDraftColor(routeGroupingPolygonColor(grouping.polygons.length));
  }, [draft.vertices.length, grouping]);

  async function saveDraftPolygon(): Promise<void> {
    const geometry = polygonDraftToGeoJson(draft);
    if (geometry === null || grouping === null) return;
    setBusy(true);
    try {
      const payload = await saveRouteGroupingPolygons({
        csrfToken: bootstrap.csrfToken,
        polygons: [
          ...grouping.polygons.map((polygon) => ({
            closed: polygon.closed,
            color: polygon.color,
            driverId: polygon.driverId,
            geometry: polygon.geometry,
            label: polygon.label,
          })),
          {
            closed: true,
            color: draftColor,
            driverId: activeDriverId === "" ? null : activeDriverId,
            geometry,
            label: driverLabel(activeDriverId, drivers),
          },
        ],
        routeGroupId,
      });
      setGrouping(payload.routeGroup);
      setDraft({ closed: false, vertices: [] });
      setDraftColor(routeGroupingPolygonColor(payload.routeGroup.polygons.length));
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function resolveAllToDriver(driverId: string): Promise<void> {
    if (grouping === null || driverId === "") return;
    setBusy(true);
    try {
      const payload = await resolveRouteGroupingAssignments({
        assignments: unresolved.map((assignment) => ({ assignedDriverId: driverId, orderId: assignment.orderId })),
        csrfToken: bootstrap.csrfToken,
        routeGroupId,
      });
      setGrouping(payload.routeGroup);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function generateChildren(confirmRisk = false): Promise<void> {
    setBusy(true);
    try {
      const payload = await generateRouteGroupingChildRoutes({ confirmRisk, csrfToken: bootstrap.csrfToken, routeGroupId });
      setGrouping(payload.routeGroup);
      setError(null);
    } catch (error) {
      if (!confirmRisk && window.confirm(`Route grouping has warnings. Continue?\n${readErrorMessage(error)}`)) {
        setBusy(false);
        await generateChildren(true);
        return;
      }
      setError(readErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <TabLayout
      title={grouping?.name ?? "Driver split"}
      primaryExpanded
      primary={
        <RouteOpsMap
          bootstrap={bootstrap}
          depot={depotPoint}
          fitOrdersToBounds
          orders={mapOrders}
          polygonDraft={draft}
          polygonDraftColor={draftColor}
          polygonMode
          polygons={grouping?.polygons ?? []}
          onPolygonFinish={() => setDraft((current) => closePolygonDraft(current))}
          onPolygonVertex={(coordinate) => setDraft((current) => appendPolygonVertex(current, coordinate))}
          subtitle="Draw driver areas directly on the map. Click to add points, double-click or Close polygon to finish."
          title={grouping?.name ?? "Driver split"}
        />
      }
      secondary={null}
      lower={
        <div className="route-group-lower-stack">
          <article className="panel route-group-split-editor">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">SPLIT EDIT</span>
                <h2>Driver areas</h2>
                <p>{grouping?.totalOrders ?? 0} orders · {grouping?.unresolvedOrders ?? 0} unresolved</p>
              </div>
              <Badge>{grouping?.displayStatus ?? "Loading"}</Badge>
            </div>
            <div className="route-group-editor-grid">
              <label>
                Driver
                <select value={activeDriverId} onChange={(event) => setActiveDriverId(event.target.value)}>
                  <option value="">Unassigned</option>
                  {drivers.map((driver) => (
                    <option key={driver.id} value={driver.id}>{driver.displayName}</option>
                  ))}
                </select>
              </label>
              <fieldset className="route-group-color-fieldset">
                <legend>Area color</legend>
                <div className="route-group-color-palette" role="radiogroup" aria-label="Area color">
                  {ROUTE_GROUPING_POLYGON_COLORS.map((color) => (
                    <button
                      aria-checked={draftColor === color}
                      aria-label={`Use color ${color}`}
                      className={draftColor === color ? "route-group-color-chip selected" : "route-group-color-chip"}
                      key={color}
                      onClick={() => setDraftColor(color)}
                      role="radio"
                      style={{ "--route-group-color": color } as CSSProperties}
                      type="button"
                    />
                  ))}
                </div>
              </fieldset>
              <div className="route-group-draft-status">
                <span>Points</span>
                <strong>{draft.vertices.length}</strong>
                <span>{draft.closed ? "Closed" : draft.vertices.length >= 3 ? "Ready to close" : "Add 3+ points"}</span>
              </div>
            </div>
            <div className="button-row route-group-editor-actions">
              <button disabled={draft.vertices.length === 0 || busy} onClick={() => setDraft((current) => removeLastPolygonVertex(current))} type="button">Undo point</button>
              <button disabled={draft.vertices.length < 3 || draft.closed || busy} onClick={() => setDraft((current) => closePolygonDraft(current))} type="button">Close polygon</button>
              <button disabled={!draftReady || busy} onClick={() => void saveDraftPolygon()} type="button">Save polygon</button>
              <button disabled={draft.vertices.length === 0 || busy} onClick={() => setDraft({ closed: false, vertices: [] })} type="button">Clear draft</button>
              <button className="primary" disabled={(grouping?.unresolvedOrders ?? 1) > 0 || busy} onClick={() => void generateChildren()} type="button">Generate child routes</button>
            </div>
          </article>
          <article className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">ASSIGNMENTS</span><h2>Manual resolution</h2></div>
            <select value="" onChange={(event) => void resolveAllToDriver(event.target.value)} disabled={unresolved.length === 0 || busy}>
              <option value="">Resolve unresolved to…</option>
              {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.displayName}</option>)}
            </select>
          </div>
          <table className="ops-table">
            <thead><tr><th>Order</th><th>Status</th><th>Driver</th><th>Route</th></tr></thead>
            <tbody>
              {(grouping?.assignments ?? []).map((assignment) => (
                <tr key={assignment.orderId}>
                  <td><strong>{assignment.orderName}</strong></td>
                  <td><Badge>{assignment.assignmentStatus}</Badge></td>
                  <td>{driverLabel(assignment.assignedDriverId ?? "", drivers)}</td>
                  <td>{grouping?.children.find((child) => child.driverId === assignment.assignedDriverId)?.routePlanId === null ? "—" : null}</td>
                </tr>
              ))}
              {(grouping?.children ?? []).map((child) => (
                <tr key={child.routePlanId ?? `${child.driverId}-${child.childVersion}`}>
                  <td colSpan={2}>{child.driverName ?? "Unassigned"} · {child.displayStatus}</td>
                  <td>{child.stopsCount} stops</td>
                  <td>{child.routePlanId === null ? "—" : <button type="button" onClick={() => navigate(`/admin/ui/app/routes/${encodeURIComponent(child.routePlanId ?? "")}`)}>Open</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </article>
        </div>
      }
    />
  );
}

function assignmentToOrder(assignment: RouteGroupingDetailDto["assignments"][number]): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: assignment.coordinates,
    deliveryArea: null,
    deliveryDate: null,
    deliverySession: null,
    deliveryStatus: "PENDING",
    geocodeStatus: "RESOLVED",
    health: "ready",
    orderId: assignment.orderId,
    orderName: assignment.orderName,
    phone: null,
    planningStatus: "PLANNED",
    recipientName: null,
    routePlanId: null,
    routePlanName: null,
    serviceType: null,
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    sourceCreatedAt: null,
    sourceCreatedDate: null,
    sourceOrderId: assignment.sourceOrderId,
    sourceOrderNumber: assignment.sourceOrderId,
    sourcePlatform: null,
    sourceUpdatedAt: null,
    sourceUpdatedDate: null,
    status: null,
    stopId: assignment.deliveryStopId,
    timeWindowEnd: null,
    timeWindowStart: null,
  };
}

function driverLabel(driverId: string, drivers: DriverDto[]): string {
  if (driverId === "") return "Unassigned";
  return drivers.find((driver) => driver.id === driverId)?.displayName ?? driverId;
}
