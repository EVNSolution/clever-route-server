import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import {
  generateRouteGroupingChildRoutes,
  getDrivers,
  getRouteGrouping,
  getSettings,
  saveRouteGroupingPolygons,
} from "../api";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { appendPolygonVertex, closePolygonDraft, polygonDraftToGeoJson, removeLastPolygonVertex } from "../routeGrouping";
import { storeSettingsToDepotPoint } from "../state";
import type { BootstrapPayload, CanonicalOrderDto, DriverDto, RouteGroupingAssignmentDto, RouteGroupingDetailDto, RouteGroupingPolygonDto, StoreSettingsDto } from "../types";
import { formatOrderItemLine, getOrderItemDisplayKey, getOrderItems } from "../orderItems";
import { readErrorMessage } from "../utils/format";

type PolygonDraft = { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> };

export function RouteGroupingPage({
  bootstrap,
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
  const [isEditing, setIsEditing] = useState(false);
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
  const draftReady = draft.closed && draft.vertices.length >= 3;
  const mapHeaderAction = renderMapHeaderAction();

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
            color: null,
            driverId: activeDriverId === "" ? null : activeDriverId,
            geometry,
            label: driverLabel(activeDriverId, drivers),
          },
        ],
        routeGroupId,
      });
      setGrouping(payload.routeGroup);
      resetDraft();
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

  function startEdit(): void {
    setDraft({ closed: false, vertices: [] });
    setIsEditing(true);
  }

  function resetDraft(): void {
    setDraft({ closed: false, vertices: [] });
    setIsEditing(false);
  }

  function renderMapHeaderAction(): ReactNode {
    if (!isEditing) return <button onClick={startEdit} type="button">Edit</button>;
    return (
      <div className="route-group-map-edit-actions">
        <select value={activeDriverId} onChange={(event) => setActiveDriverId(event.target.value)} aria-label="Driver">
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>{driver.displayName}</option>
          ))}
        </select>
        <button disabled={draft.vertices.length === 0 || busy} onClick={() => setDraft((current) => removeLastPolygonVertex(current))} type="button">Undo</button>
        <button disabled={draft.vertices.length < 3 || draft.closed || busy} onClick={() => setDraft((current) => closePolygonDraft(current))} type="button">Close</button>
        <button disabled={!draftReady || busy} onClick={() => void saveDraftPolygon()} type="button">Save</button>
        <button disabled={busy} onClick={resetDraft} type="button">Cancel</button>
      </div>
    );
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
          headerAction={mapHeaderAction}
          orders={mapOrders}
          polygonDraft={isEditing ? draft : undefined}
          polygonMode={isEditing}
          polygons={grouping?.polygons ?? []}
          onPolygonFinish={() => setDraft((current) => closePolygonDraft(current))}
          onPolygonVertex={(coordinate) => setDraft((current) => appendPolygonVertex(current, coordinate))}
          title={grouping?.name ?? "Driver split"}
        />
      }
      secondary={null}
      lower={
        <div className="route-group-lower-stack">
          {grouping !== null && grouping.polygons.length > 0 ? (
            <RouteGroupingAreasCard
              assignments={grouping.assignments}
              busy={busy}
              drivers={drivers}
              onGenerate={() => void generateChildren()}
              polygons={grouping.polygons}
              unresolvedOrders={grouping.unresolvedOrders}
            />
          ) : null}
          <RouteGroupingOrderItemsCard assignments={grouping?.assignments ?? []} />
        </div>
      }
    />
  );
}

function RouteGroupingAreasCard({
  assignments,
  busy,
  drivers,
  onGenerate,
  polygons,
  unresolvedOrders,
}: {
  assignments: RouteGroupingAssignmentDto[];
  busy: boolean;
  drivers: DriverDto[];
  onGenerate(): void;
  polygons: RouteGroupingPolygonDto[];
  unresolvedOrders: number;
}): ReactElement {
  return (
    <article className="panel route-group-areas-card">
      <div className="route-group-area-list">
        {polygons.map((polygon) => {
          const assignedCount = assignments.filter((assignment) => assignment.assignedPolygonId === polygon.id).length;
          return (
            <div className="route-group-area-row" key={polygon.id}>
              <span className="route-group-area-swatch" style={{ background: polygon.color ?? "#2563eb" }} />
              <strong>{driverLabel(polygon.driverId ?? "", drivers)}</strong>
              <span className="route-group-area-dots" aria-hidden="true">{areaDots(assignedCount)}</span>
              <span>{assignedCount}</span>
            </div>
          );
        })}
      </div>
      <button className="primary" disabled={unresolvedOrders > 0 || busy} onClick={onGenerate} type="button">Generate</button>
    </article>
  );
}

function RouteGroupingOrderItemsCard({ assignments }: { assignments: RouteGroupingAssignmentDto[] }): ReactElement {
  return (
    <article className="panel route-group-order-items-card">
      <table className="ops-table route-group-order-items-table">
        <thead><tr><th>Order</th><th>Items</th></tr></thead>
        <tbody>
          {assignments.map((assignment) => {
            const items = getOrderItems(assignment.items);
            return (
              <tr key={assignment.orderId}>
                <td><strong>{assignment.orderName}</strong></td>
                <td>
                  {items.length === 0 ? "—" : (
                    <ul className="route-group-order-items-list">
                      {items.map((item, index) => (
                        <li key={getOrderItemDisplayKey(item, index)}>{formatOrderItemLine(item)}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}

function areaDots(count: number): string {
  if (count <= 0) return "—";
  const visible = Math.min(count, 12);
  return Array.from({ length: visible }, () => "○").join("-") + (count > visible ? "+" : "");
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
    items: assignment.items,
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
