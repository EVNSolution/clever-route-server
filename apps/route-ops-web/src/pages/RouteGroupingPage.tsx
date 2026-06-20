import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
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
  const mapHeaderAction = !isEditing ? <button onClick={startEdit} type="button">Edit</button> : undefined;
  const mapEditOverlay = isEditing ? renderMapEditOverlay() : undefined;
  const groupedOrderMarkerStates = useMemo(() => buildGroupedOrderMarkerStates(grouping), [grouping]);

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

  async function assignPolygonDriver(polygonId: string, driverId: string): Promise<void> {
    if (grouping === null || driverId === "") return;
    const driverName = driverLabel(driverId, drivers);
    setBusy(true);
    try {
      const payload = await saveRouteGroupingPolygons({
        csrfToken: bootstrap.csrfToken,
        polygons: grouping.polygons.map((polygon) => ({
          closed: polygon.closed,
          color: polygon.color,
          driverId: polygon.id === polygonId ? driverId : polygon.driverId,
          geometry: polygon.geometry,
          label: polygon.id === polygonId ? driverName : polygon.label,
        })),
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

  function startEdit(): void {
    setDraft({ closed: false, vertices: [] });
    setIsEditing(true);
  }

  function resetDraft(): void {
    setDraft({ closed: false, vertices: [] });
    setIsEditing(false);
  }

  function renderMapEditOverlay(): ReactNode {
    return (
      <div className="route-group-map-edit-overlay" role="group" aria-label="Polygon edit tools">
        <label className="route-group-map-driver-select">
          <span>Driver</span>
          <select value={activeDriverId} onChange={(event) => setActiveDriverId(event.target.value)} aria-label="Driver">
            <option value="">Unassigned</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>{driver.displayName}</option>
            ))}
          </select>
        </label>
        <div className="route-group-map-icon-tools">
          <button aria-label="Undo last point" disabled={draft.vertices.length === 0 || busy} onClick={() => setDraft((current) => removeLastPolygonVertex(current))} title="Undo last point" type="button">↶</button>
          <button aria-label="Close polygon" disabled={draft.vertices.length < 3 || draft.closed || busy} onClick={() => setDraft((current) => closePolygonDraft(current))} title="Close polygon" type="button">◇</button>
          <button aria-label="Save polygon" disabled={!draftReady || busy} onClick={() => void saveDraftPolygon()} title="Save polygon" type="button">✓</button>
          <button aria-label="Cancel polygon edit" disabled={busy} onClick={resetDraft} title="Cancel" type="button">×</button>
        </div>
        <span className="route-group-map-edit-help">Click points · double-click to finish</span>
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
          className="route-group-map-panel"
          fitOrdersToBounds
          headerAction={mapHeaderAction}
          mapOverlayAction={mapEditOverlay}
          orderMarkerStates={groupedOrderMarkerStates}
          orders={mapOrders}
          polygonDraft={isEditing ? draft : undefined}
          polygonMode={isEditing}
          polygons={isEditing ? grouping?.polygons ?? [] : []}
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
              onAssignDriver={(polygonId, driverId) => void assignPolygonDriver(polygonId, driverId)}
              polygons={grouping.polygons}
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
  onAssignDriver,
  polygons,
}: {
  assignments: RouteGroupingAssignmentDto[];
  busy: boolean;
  drivers: DriverDto[];
  onAssignDriver(polygonId: string, driverId: string): void;
  polygons: RouteGroupingPolygonDto[];
}): ReactElement {
  const assignmentsByPolygonId = new Map<string, RouteGroupingAssignmentDto[]>();
  for (const assignment of assignments) {
    if (assignment.assignedPolygonId === null) continue;
    const current = assignmentsByPolygonId.get(assignment.assignedPolygonId) ?? [];
    current.push(assignment);
    assignmentsByPolygonId.set(assignment.assignedPolygonId, current);
  }
  const maxAssignedCount = Math.max(1, ...polygons.map((polygon) => assignmentsByPolygonId.get(polygon.id)?.length ?? 0));
  const duplicateDriverPolygonIds = getRouteGroupingDuplicateDriverPolygonIds(polygons);

  return (
    <article className="panel route-group-areas-card" style={{ "--route-group-area-columns": String(maxAssignedCount) } as CSSProperties}>
      <div className="route-group-area-list">
        {polygons.map((polygon) => {
          const color = polygon.color ?? "#2563eb";
          const polygonAssignments = assignmentsByPolygonId.get(polygon.id) ?? [];
          const effectiveDriverId = duplicateDriverPolygonIds.has(polygon.id) ? null : polygon.driverId;
          const label = driverLabel(effectiveDriverId ?? "", drivers);
          const canAssignDriver = effectiveDriverId === null;
          const assignableDrivers = getRouteGroupingAssignableDrivers(polygon, polygons, drivers);
          return (
            <div className="route-group-area-row" key={polygon.id}>
              {canAssignDriver ? (
                <label className="route-group-area-driver route-group-area-driver--assignable">
                  <span className="route-group-area-swatch" style={{ background: color }} />
                  <select
                    aria-label={`Assign driver to ${label} group`}
                    className="route-group-area-driver-select"
                    disabled={busy || assignableDrivers.length === 0}
                    onChange={(event) => {
                      if (event.target.value !== "") onAssignDriver(polygon.id, event.target.value);
                    }}
                    value=""
                  >
                    <option value="">{assignableDrivers.length === 0 ? "All drivers used" : label}</option>
                    {assignableDrivers.map((driver) => (
                      <option key={driver.id} value={driver.id}>{driver.displayName}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="route-group-area-driver">
                  <span className="route-group-area-swatch" style={{ background: color }} />
                  <strong>{label}</strong>
                </span>
              )}
              <span className="route-group-area-track" style={{ "--route-group-area-color": color } as CSSProperties}>
                <span className="route-group-area-store-node" aria-label="Store start" title="Store start">
                  <span aria-hidden="true">⌂</span>
                </span>
                <span className="route-group-area-orders" aria-label={`${label} orders`}>
                  {polygonAssignments.map((assignment, index) => (
                    <span className="route-group-area-order-node" key={assignment.orderId}>
                      <button className="route-group-area-order-token" style={{ background: color, borderColor: color }} title={assignment.orderName} type="button">
                        {index + 1}
                      </button>
                    </span>
                  ))}
                </span>
                <span className="route-group-area-finish" style={{ borderColor: color, color }}>Finish</span>
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}


export function getRouteGroupingAssignableDrivers(
  polygon: Pick<RouteGroupingPolygonDto, "driverId" | "id">,
  polygons: Array<Pick<RouteGroupingPolygonDto, "driverId" | "id">>,
  drivers: DriverDto[],
): DriverDto[] {
  const usedDriverIds = new Set(
    polygons
      .filter((current) => current.id !== polygon.id)
      .map((current) => current.driverId)
      .filter((driverId): driverId is string => driverId !== null && driverId !== undefined),
  );
  return drivers.filter((driver) => !usedDriverIds.has(driver.id));
}

export function getRouteGroupingDuplicateDriverPolygonIds(
  polygons: Array<Pick<RouteGroupingPolygonDto, "driverId" | "id">>,
): ReadonlySet<string> {
  const seenDriverIds = new Set<string>();
  const duplicatePolygonIds = new Set<string>();
  for (const polygon of polygons) {
    if (polygon.driverId === null) continue;
    if (seenDriverIds.has(polygon.driverId)) {
      duplicatePolygonIds.add(polygon.id);
      continue;
    }
    seenDriverIds.add(polygon.driverId);
  }
  return duplicatePolygonIds;
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

function buildGroupedOrderMarkerStates(grouping: RouteGroupingDetailDto | null): ReadonlyMap<string, { markerColor?: string; markerOpacity?: number; pinKind?: "candidate" }> {
  if (grouping === null) return new Map();
  const polygonColorById = new Map(grouping.polygons.map((polygon) => [polygon.id, polygon.color ?? "#2563eb"]));
  return new Map(
    grouping.assignments.flatMap((assignment) => {
      if (assignment.assignedPolygonId === null) return [];
      const color = polygonColorById.get(assignment.assignedPolygonId);
      if (color === undefined) return [];
      return [[assignment.orderId, { markerColor: color, markerOpacity: 1, pinKind: "candidate" as const }]];
    }),
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
