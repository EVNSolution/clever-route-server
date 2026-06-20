import { Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";

import {
  getDrivers,
  getRouteGrouping,
  getSettings,
  saveRouteGroupingPolygons,
} from "../api";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { ROUTE_START_ICON_PATH } from "../components/maps/mapIcons";
import { appendPolygonVertex, closePolygonDraft, insertPolygonVertex, movePolygonVertex, polygonDraftToGeoJson, readEditablePolygonVertices, removeLastPolygonVertex } from "../routeGrouping";
import { storeSettingsToDepotPoint } from "../state";
import type { BootstrapPayload, CanonicalOrderDto, DriverDto, RouteGroupingAssignmentDto, RouteGroupingDetailDto, RouteGroupingPolygonDto, StoreSettingsDto } from "../types";
import { formatOrderItemLine, getOrderItemDisplayKey, getOrderItems } from "../orderItems";
import { readErrorMessage } from "../utils/format";

type PolygonDraft = { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> };
type OverlayDragState = { originX: number; originY: number; pointerId: number; startX: number; startY: number };

const EDIT_OVERLAY_MIN_X = -84;
const EDIT_OVERLAY_MAX_X = 760;
const EDIT_OVERLAY_MIN_Y = 0;
const EDIT_OVERLAY_MAX_Y = 420;

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
  const [editingPolygonId, setEditingPolygonId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editOverlayOffset, setEditOverlayOffset] = useState({ x: 0, y: 0 });
  const overlayDragRef = useRef<OverlayDragState | null>(null);

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
  const editingPolygon = editingPolygonId === null ? null : grouping?.polygons.find((polygon) => polygon.id === editingPolygonId) ?? null;
  const draftColor = editingPolygon?.color ?? "#2563eb";
  const mapHeaderAction = !isEditing ? <button onClick={startEdit} type="button">Edit</button> : undefined;
  const mapEditOverlay = isEditing ? renderMapEditOverlay() : undefined;
  const visiblePolygons = useMemo(() => buildVisiblePolygons(grouping, isEditing ? editingPolygonId : undefined), [editingPolygonId, grouping, isEditing]);
  const groupedOrderMarkerStates = useMemo(() => buildGroupedOrderMarkerStates(grouping, isEditing ? editingPolygonId : undefined), [editingPolygonId, grouping, isEditing]);

  async function saveDraftPolygon(): Promise<void> {
    const geometry = polygonDraftToGeoJson(draft);
    if (geometry === null || grouping === null) return;
    const nextPolygon = {
      closed: true,
      color: editingPolygon?.color ?? null,
      driverId: activeDriverId === "" ? null : activeDriverId,
      geometry,
      id: editingPolygonId,
      label: driverLabel(activeDriverId, drivers),
    };
    const basePolygons = releaseDriverFromOtherRouteGroupingPolygons(
      grouping.polygons.map(toRouteGroupingPolygonPayload),
      editingPolygonId,
      nextPolygon.driverId,
    );
    const polygons =
      editingPolygonId === null
        ? [...basePolygons, nextPolygon]
        : basePolygons.map((polygon) => polygon.id === editingPolygonId ? nextPolygon : polygon);
    setBusy(true);
    try {
      const payload = await saveRouteGroupingPolygons({
        csrfToken: bootstrap.csrfToken,
        expectedUpdatedAt: grouping.updatedAt,
        polygons,
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
        expectedUpdatedAt: grouping.updatedAt,
        polygons: grouping.polygons.map((polygon) => ({
          closed: polygon.closed,
          color: polygon.color,
          driverId: polygon.id === polygonId ? driverId : polygon.driverId,
          geometry: polygon.geometry,
          id: polygon.id,
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

  async function deleteEditingPolygon(): Promise<void> {
    if (grouping === null || editingPolygonId === null) return;
    setBusy(true);
    try {
      const payload = await saveRouteGroupingPolygons({
        csrfToken: bootstrap.csrfToken,
        deletePolygonIds: [editingPolygonId],
        expectedUpdatedAt: grouping.updatedAt,
        polygons: grouping.polygons
          .filter((polygon) => polygon.id !== editingPolygonId)
          .map(toRouteGroupingPolygonPayload),
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

  function startEdit(): void {
    setEditingPolygonId(null);
    setActiveDriverId("");
    setDraft({ closed: false, vertices: [] });
    setEditOverlayOffset({ x: 0, y: 0 });
    setIsEditing(true);
  }

  function startEditPolygon(polygon: RouteGroupingPolygonDto): void {
    setEditingPolygonId(polygon.id);
    setActiveDriverId(polygon.driverId ?? "");
    setDraft({ closed: polygon.closed, vertices: readEditablePolygonVertices(polygon.geometry) });
    setEditOverlayOffset({ x: 0, y: 0 });
    setIsEditing(true);
  }

  function resetDraft(): void {
    setDraft({ closed: false, vertices: [] });
    setEditingPolygonId(null);
    setIsEditing(false);
    overlayDragRef.current = null;
  }

  function handleEditOverlayDragStart(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    overlayDragRef.current = {
      originX: editOverlayOffset.x,
      originY: editOverlayOffset.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleEditOverlayDragMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = overlayDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setEditOverlayOffset({
      x: clamp(drag.originX + event.clientX - drag.startX, EDIT_OVERLAY_MIN_X, EDIT_OVERLAY_MAX_X),
      y: clamp(drag.originY + event.clientY - drag.startY, EDIT_OVERLAY_MIN_Y, EDIT_OVERLAY_MAX_Y),
    });
  }

  function handleEditOverlayDragEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = overlayDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    overlayDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function renderMapEditOverlay(): ReactNode {
    return (
      <div
        className="route-group-map-edit-overlay"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        role="group"
        aria-label="Polygon edit tools"
        style={{ "--route-group-edit-x": `${editOverlayOffset.x}px`, "--route-group-edit-y": `${editOverlayOffset.y}px` } as CSSProperties}
      >
        <button
          aria-label="Move edit tools"
          className="route-group-map-edit-grab"
          onPointerCancel={handleEditOverlayDragEnd}
          onPointerDown={handleEditOverlayDragStart}
          onPointerMove={handleEditOverlayDragMove}
          onPointerUp={handleEditOverlayDragEnd}
          title="Move edit tools"
          type="button"
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
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
          {editingPolygonId === null ? (
            <button aria-label="Undo last point" className="route-group-map-tool-button route-group-map-tool-button--icon" disabled={draft.vertices.length === 0 || busy} onClick={() => setDraft((current) => removeLastPolygonVertex(current))} title="Undo last point" type="button">
              <Undo2 aria-hidden="true" className="route-group-tool-icon" strokeWidth={2.4} />
            </button>
          ) : null}
          <button aria-label="Save polygon" className="route-group-map-tool-button route-group-map-tool-button--primary" disabled={!draftReady || busy} onClick={() => void saveDraftPolygon()} title="Save polygon" type="button">
            <span aria-hidden="true">✓</span>
            <span>Save</span>
          </button>
          <button aria-label="Cancel polygon edit" className="route-group-map-tool-button" disabled={busy} onClick={resetDraft} title="Cancel" type="button">
            <span aria-hidden="true">×</span>
            <span>Cancel</span>
          </button>
          {editingPolygonId === null ? null : (
            <button aria-label="Delete polygon" className="route-group-map-tool-button route-group-map-tool-button--danger" disabled={busy} onClick={() => void deleteEditingPolygon()} title="Delete polygon" type="button">
              <span aria-hidden="true">⌫</span>
              <span>Delete</span>
            </button>
          )}
        </div>
        <span className="route-group-map-edit-help">{editingPolygonId === null ? "Double-click to finish" : "Drag points · double-click line"}</span>
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
          polygonDraftColor={draftColor}
          polygonFocusKey={isEditing ? editingPolygonId ?? "new" : null}
          polygonMode={isEditing}
          polygons={visiblePolygons}
          onPolygonFinish={() => setDraft((current) => closePolygonDraft(current))}
          onPolygonVertex={(coordinate) => setDraft((current) => appendPolygonVertex(current, coordinate))}
          onPolygonVertexInsert={(index, coordinate) => setDraft((current) => insertPolygonVertex(current, index, coordinate))}
          onPolygonVertexMove={(index, coordinate) => setDraft((current) => movePolygonVertex(current, index, coordinate))}
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
              onEditPolygon={startEditPolygon}
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
  onEditPolygon,
  polygons,
}: {
  assignments: RouteGroupingAssignmentDto[];
  busy: boolean;
  drivers: DriverDto[];
  onAssignDriver(polygonId: string, driverId: string): void;
  onEditPolygon(polygon: RouteGroupingPolygonDto): void;
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
                  <svg className="route-group-area-store-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <path d={ROUTE_START_ICON_PATH} />
                  </svg>
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
                <button
                  aria-label={`Edit ${label} polygon`}
                  className="route-group-area-edit-button"
                  disabled={busy}
                  onClick={() => onEditPolygon(polygon)}
                  title="Edit polygon"
                  type="button"
                >
                  <span aria-hidden="true" className="route-group-area-edit-glyph" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}


function toRouteGroupingPolygonPayload(polygon: RouteGroupingPolygonDto): {
  closed: boolean;
  color: string | null;
  driverId: string | null;
  geometry: unknown;
  id: string;
  label: string;
} {
  return {
    closed: polygon.closed,
    color: polygon.color,
    driverId: polygon.driverId,
    geometry: polygon.geometry,
    id: polygon.id,
    label: polygon.label,
  };
}



export function releaseDriverFromOtherRouteGroupingPolygons<T extends { driverId: string | null; id: string; label: string }>(
  polygons: T[],
  targetPolygonId: string | null,
  driverId: string | null,
): T[] {
  if (driverId === null) return polygons;
  return polygons.map((polygon) => {
    if (polygon.id === targetPolygonId || polygon.driverId !== driverId) return polygon;
    return { ...polygon, driverId: null, label: "Unassigned" };
  });
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

function buildVisiblePolygons(grouping: RouteGroupingDetailDto | null, editingPolygonId: string | null | undefined): RouteGroupingPolygonDto[] {
  if (grouping === null) return [];
  if (editingPolygonId === undefined) return [];
  return grouping.polygons
    .filter((polygon) => polygon.id !== editingPolygonId)
    .map((polygon) => ({ ...polygon, color: "#94a3b8" }));
}

function buildGroupedOrderMarkerStates(grouping: RouteGroupingDetailDto | null, editingPolygonId?: string | null): ReadonlyMap<string, { markerColor?: string; markerOpacity?: number; pinKind?: "candidate" }> {
  if (grouping === null) return new Map();
  const polygonColorById = new Map(grouping.polygons.map((polygon) => [polygon.id, polygon.color ?? "#2563eb"]));
  return new Map(
    grouping.assignments.flatMap((assignment) => {
      if (assignment.assignedPolygonId === null) return [];
      const color = polygonColorById.get(assignment.assignedPolygonId);
      if (color === undefined) return [];
      const markerColor = editingPolygonId === undefined
        ? color
        : assignment.assignedPolygonId === editingPolygonId ? color : "#94a3b8";
      return [[assignment.orderId, { markerColor, markerOpacity: 1, pinKind: "candidate" as const }]];
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function driverLabel(driverId: string, drivers: DriverDto[]): string {
  if (driverId === "") return "Unassigned";
  return drivers.find((driver) => driver.id === driverId)?.displayName ?? driverId;
}
