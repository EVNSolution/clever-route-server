import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import {
  createRoute,
  geocodeOrder,
  getOrderMetadataDiagnostics,
  getOrders,
  getSettings,
} from "../api";
import { Badge } from "../components/primitives";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import {
  buildOrderQuery,
  createDefaultOrderFilters,
  storeSettingsToDepotPoint,
  summarizeSelection,
  type OrderFilterState,
} from "../state";
import type {
  BootstrapPayload,
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
  StoreSettingsDto,
} from "../types";
import { readErrorMessage, today } from "../utils/format";

export const ORDERS_TABLE_COLUMN_COUNT = 9;

export function OrdersPage({
  bootstrap,
  navigate,
  setError,
}: {
  bootstrap: BootstrapPayload;
  navigate(path: string): void;
  setError(error: string | null): void;
}): ReactElement {
  const [orders, setOrders] = useState<CanonicalOrderDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState(createDefaultOrderFilters);
  const [routeDate, setRouteDate] = useState(today());
  const [routeName, setRouteName] = useState(`Route ${today()}`);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<StoreSettingsDto | null>(null);
  const [diagnosticsByOrder, setDiagnosticsByOrder] = useState<
    Record<string, DeliveryMetadataDiagnosticsDto | null>
  >({});
  const [geocodingOrderIds, setGeocodingOrderIds] = useState<Set<string>>(
    new Set(),
  );

  const query = useMemo(() => buildOrderQuery(filters), [filters]);
  const selection = useMemo(
    () => summarizeSelection(orders, selected),
    [orders, selected],
  );
  const depotPoint = useMemo(
    () => storeSettingsToDepotPoint(settings),
    [settings],
  );
  const plannedOrderIds = useMemo(
    () =>
      new Set(
        orders
          .filter(
            (order) =>
              order.routePlanId !== null ||
              order.planningStatus !== "UNPLANNED",
          )
          .map((order) => order.orderId),
      ),
    [orders],
  );

  const refreshOrders = async (): Promise<void> => {
    setLoading(true);
    try {
      const payload = await getOrders(query);
      setOrders(payload.orders);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshOrders();
  }, [query]);

  useEffect(() => {
    getSettings()
      .then((payload) => {
        setSettings(payload.settings);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  const create = async (): Promise<void> => {
    try {
      if (
        selection.blockers.length > 0 ||
        selection.readySelected.length !== selected.size
      ) {
        throw new Error(
          "Create route uses ready unplanned orders only. Remove unavailable orders from the plan.",
        );
      }
      const result = await createRoute({
        csrfToken: bootstrap.csrfToken,
        depotAddress: settings?.defaultDepotAddress ?? null,
        depotLatitude: settings?.defaultDepotLatitude ?? null,
        depotLongitude: settings?.defaultDepotLongitude ?? null,
        orderIds: [...selected],
        planDate: routeDate || today(),
        routeName,
      });
      navigate(
        `/admin/ui/app/routes/${encodeURIComponent(result.routePlan.id)}`,
      );
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };

  const loadDiagnostics = async (orderId: string): Promise<void> => {
    try {
      const payload = await getOrderMetadataDiagnostics(orderId);
      setDiagnosticsByOrder((current) => ({
        ...current,
        [orderId]: payload.diagnostics,
      }));
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };

  const geocodeAndAddOrder = async (orderId: string): Promise<void> => {
    setGeocodingOrderIds((current) => new Set([...current, orderId]));
    try {
      const payload = await geocodeOrder({
        csrfToken: bootstrap.csrfToken,
        orderId,
        save: true,
      });
      if (payload.order !== undefined) {
        setOrders((current) =>
          current.map((order) =>
            order.orderId === payload.order?.orderId ? payload.order : order,
          ),
        );
        if (isRoutePlanEligible(payload.order)) {
          setSelected((current) => new Set([...current, payload.order!.orderId]));
        }
      }
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setGeocodingOrderIds((current) => {
        const next = new Set(current);
        next.delete(orderId);
        return next;
      });
    }
  };

  const togglePlanOrder = (orderId: string): void => {
    const order = orders.find((candidate) => candidate.orderId === orderId);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else if (order !== undefined && isRoutePlanEligible(order)) {
        next.add(orderId);
      }
      return next;
    });
  };

  const addOrderToPlan = (orderId: string): void => {
    const order = orders.find((candidate) => candidate.orderId === orderId);
    if (order === undefined || !isRoutePlanEligible(order)) return;
    setSelected((current) =>
      current.has(orderId) ? current : new Set([...current, orderId]),
    );
  };

  return (
    <TabLayout
      title="Orders"
      primary={
        <RouteOpsMap
          bootstrap={bootstrap}
          depot={depotPoint}
          onOrderSelect={addOrderToPlan}
          orders={orders}
          plannedOrderIds={plannedOrderIds}
          subtitle="Imported WooCommerce stops by current filters"
          title="Orders map"
        />
      }
      secondary={
        <RoutePlanPanel
          invalidSelectionCount={selected.size - selection.readySelected.length}
          onClear={() => setSelected(new Set())}
          onCreate={() => void create()}
          routeDate={routeDate}
          routeName={routeName}
          selectedOrders={selection.readySelected}
          setRouteDate={setRouteDate}
          setRouteName={setRouteName}
          totalSelected={selected.size}
        />
      }
      lower={
        <>
          <div className="route-tabs" aria-label="Order planning filters">
            <button
              className={
                filters.status === "unplanned" &&
                filters.health !== "needs_review"
                  ? "active"
                  : ""
              }
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  health: "",
                  status: "unplanned",
                })
              }
              type="button"
            >
              Imported / Unplanned
            </button>
            <button
              className={filters.status === "planned" ? "active" : ""}
              onClick={() =>
                setFilters({ ...filters, health: "", status: "planned" })
              }
              type="button"
            >
              Planned
            </button>
            <button
              className={filters.health === "needs_review" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  health: "needs_review",
                  status: "",
                })
              }
              type="button"
            >
              Needs review
            </button>
          </div>
          <FilterBar filters={filters} onChange={setFilters} />
          <OrderTable
            diagnosticsByOrder={diagnosticsByOrder}
            geocodingOrderIds={geocodingOrderIds}
            loading={loading}
            onGeocodeAndAdd={(orderId) => void geocodeAndAddOrder(orderId)}
            onLoadDiagnostics={(orderId) => void loadDiagnostics(orderId)}
            onTogglePlanOrder={togglePlanOrder}
            orders={orders}
            selected={selected}
            setSelected={setSelected}
          />
        </>
      }
    />
  );
}

function RoutePlanPanel(input: {
  invalidSelectionCount: number;
  onClear(): void;
  onCreate(): void;
  routeDate: string;
  routeName: string;
  selectedOrders: CanonicalOrderDto[];
  setRouteDate(value: string): void;
  setRouteName(value: string): void;
  totalSelected: number;
}): ReactElement {
  const canCreate =
    input.selectedOrders.length > 0 && input.invalidSelectionCount === 0;
  return (
    <div
      className="panel side-panel route-plan-panel"
      aria-label="New route add plan"
    >
      <div className="panel-heading compact-heading route-plan-header">
        <div>
          <span className="eyebrow">New route</span>
          <h2>Add plan</h2>
        </div>
        <Badge>{input.selectedOrders.length} orders</Badge>
      </div>
      <p className="muted">
        Use the map or order list to add ready unplanned orders, then create the
        route.
      </p>
      <label>
        Route date
        <input
          type="date"
          value={input.routeDate}
          onChange={(event) => input.setRouteDate(event.target.value)}
        />
      </label>
      <label>
        Route name
        <input
          value={input.routeName}
          onChange={(event) => input.setRouteName(event.target.value)}
        />
      </label>
      <div className="button-row route-plan-actions">
        <button
          className="primary"
          disabled={!canCreate}
          onClick={input.onCreate}
          type="button"
        >
          Create route
        </button>
        <button
          disabled={input.totalSelected === 0}
          onClick={input.onClear}
          type="button"
        >
          Clear
        </button>
      </div>
      <div className="route-plan-draft" aria-label="Add plan orders">
        {input.selectedOrders.length === 0 ? (
          <p className="route-plan-empty">Plan is empty.</p>
        ) : (
          input.selectedOrders.map((order, index) => (
            <div className="route-plan-item" key={order.orderId}>
              <strong>
                {index + 1}. {order.orderName}
              </strong>
              <small>
                {order.recipientName ?? "Recipient"} ·{" "}
                {order.deliveryArea ?? "Area"} · {order.deliveryDate ?? "Date"}
              </small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: OrderFilterState;
  onChange(filters: OrderFilterState): void;
}): ReactElement {
  return (
    <article className="panel filter-panel">
      <label>
        Delivery date
        <input
          type="date"
          value={filters.deliveryDate}
          onChange={(event) =>
            onChange({ ...filters, deliveryDate: event.target.value })
          }
        />
      </label>
      <label>
        Area / region
        <input
          placeholder="Toronto"
          value={filters.deliveryArea}
          onChange={(event) =>
            onChange({ ...filters, deliveryArea: event.target.value })
          }
        />
      </label>
      <label>
        Delivery status
        <select
          value={filters.deliveryStatus}
          onChange={(event) =>
            onChange({ ...filters, deliveryStatus: event.target.value })
          }
        >
          <option value="">All</option>
          <option value="ready">Ready</option>
          <option value="needs_review">Needs review</option>
          <option value="completed">Completed</option>
        </select>
      </label>
      <label>
        Order health
        <select
          value={filters.health}
          onChange={(event) =>
            onChange({ ...filters, health: event.target.value })
          }
        >
          <option value="">All</option>
          <option value="normal">Normal</option>
          <option value="needs_review">Needs review</option>
        </select>
      </label>
      <label>
        Search
        <input
          placeholder="#1001, email, phone"
          value={filters.search}
          onChange={(event) =>
            onChange({ ...filters, search: event.target.value })
          }
        />
      </label>
    </article>
  );
}

export function OrderTable(input: {
  diagnosticsByOrder: Record<string, DeliveryMetadataDiagnosticsDto | null>;
  geocodingOrderIds?: ReadonlySet<string>;
  loading: boolean;
  onGeocodeAndAdd?(orderId: string): void;
  onLoadDiagnostics(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  orders: CanonicalOrderDto[];
  selected: Set<string>;
  setSelected(selected: Set<string>): void;
}): ReactElement {
  if (input.loading)
    return (
      <article className="panel">
        <p>Loading imported WooCommerce orders…</p>
      </article>
    );
  return (
    <article className="panel orders-table-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Orders</span>
          <h2>Imported order list</h2>
        </div>
        <Badge>{input.orders.length} orders</Badge>
      </div>
      <div
        className="orders-table-scroll"
        data-column-count={ORDERS_TABLE_COLUMN_COUNT}
      >
        <table className="orders-compact-table">
          <thead>
            <tr>
              <th className="orders-select-col" scope="col">
                Select
              </th>
              <th scope="col">Order</th>
              <th scope="col">Customer</th>
              <th scope="col">Method</th>
              <th scope="col">Day</th>
              <th scope="col">Area</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {input.orders.length === 0 ? (
              <tr className="orders-empty-row">
                <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
                  No imported orders match the current filters.
                </td>
              </tr>
            ) : (
              input.orders.map((order) => (
                <OrderTableRow
                  diagnostics={input.diagnosticsByOrder[order.orderId]}
                  geocoding={input.geocodingOrderIds?.has(order.orderId) ?? false}
                  key={order.orderId}
                  onGeocodeAndAdd={input.onGeocodeAndAdd}
                  onLoadDiagnostics={input.onLoadDiagnostics}
                  onTogglePlanOrder={input.onTogglePlanOrder}
                  order={order}
                  selectedOrders={input.selected}
                  setSelected={input.setSelected}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function OrderTableRow(input: {
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  geocoding: boolean;
  onGeocodeAndAdd?(orderId: string): void;
  onLoadDiagnostics(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  order: CanonicalOrderDto;
  selectedOrders: Set<string>;
  setSelected(selected: Set<string>): void;
}): ReactElement {
  const { order } = input;
  const selected = input.selectedOrders.has(order.orderId);
  const canPlan = isRoutePlanEligible(order);
  const day = formatDeliveryDayLabel(order);
  const routeRepair = getRouteRepairPrompt(order);
  const status = formatOperationalStatus(order);
  const orderLabel = getOrderAccessibleLabel(order);
  const planActionLabel = `${
    selected ? "Remove" : "Add"
  } order ${orderLabel} ${selected ? "from" : "to"} route plan`;
  const geocodeActionLabel = `Geocode and add order ${orderLabel} to route plan`;
  const diagnosticsLabel = `Load diagnostics for order ${orderLabel}`;
  return (
    <>
      <tr
        className={[
          "orders-row",
          order.blockerReasons.length > 0 ? "orders-row--needs-review" : "",
          !canPlan && !selected ? "orders-row--not-eligible" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <td className="orders-select-cell">
          <input
            aria-label={`Select order ${orderLabel}`}
            checked={selected}
            disabled={!canPlan && !selected}
            onChange={(event) => {
              const next = new Set(input.selectedOrders);
              if (event.target.checked && canPlan) next.add(order.orderId);
              else next.delete(order.orderId);
              input.setSelected(next);
            }}
            type="checkbox"
          />
        </td>
        <td className="orders-order-cell">
          <strong className="order-primary">{order.orderName}</strong>
          <small className="order-subtle">{formatOrderSource(order)}</small>
        </td>
        <td className="orders-customer-cell">
          <strong className="order-primary">
            {order.recipientName ?? "—"}
          </strong>
          {order.phone === null ? null : (
            <small className="order-subtle">{order.phone}</small>
          )}
          {order.blockerReasons.length === 0 ? null : (
            <span className="order-pill order-pill--review">Review</span>
          )}
        </td>
        <td>
          <span className="order-compact-value">
            {formatMethodLabel(order)}
          </span>
        </td>
        <td className="orders-day-cell">
          <span className={`order-pill ${day.toneClass}`}>{day.label}</span>
          {day.detail === null ? null : (
            <small className="order-subtle">{day.detail}</small>
          )}
        </td>
        <td>
          <span className="order-compact-value">{formatAreaLabel(order)}</span>
        </td>
        <td>
          <span className="order-compact-value">{formatRouteLabel(order)}</span>
          <small className="order-subtle">{routeRepair.routeDetail}</small>
        </td>
        <td>
          <span className={`order-pill ${status.toneClass}`}>
            {status.label}
          </span>
          {status.detail === null ? null : (
            <small className="order-subtle">{status.detail}</small>
          )}
        </td>
        <td>
          <div className="orders-actions">
            <button
              aria-label={planActionLabel}
              className={selected ? "active" : ""}
              disabled={!canPlan && !selected}
              onClick={() => input.onTogglePlanOrder(order.orderId)}
              type="button"
            >
              {selected ? "Remove" : "Add"}
            </button>
            <button
              aria-label={diagnosticsLabel}
              onClick={() => input.onLoadDiagnostics(order.orderId)}
              type="button"
            >
              Diagnostics
            </button>
            {routeRepair.canGeocode ? (
              <button
                aria-label={geocodeActionLabel}
                disabled={input.geocoding || input.onGeocodeAndAdd === undefined}
                onClick={() => input.onGeocodeAndAdd?.(order.orderId)}
                type="button"
              >
                {input.geocoding ? "Geocoding…" : "Geocode & add"}
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {input.diagnostics === undefined ? null : (
        <tr className="diagnostics-row">
          <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
            <DeliveryDiagnostics diagnostics={input.diagnostics} />
          </td>
        </tr>
      )}
    </>
  );
}

export function formatMethodLabel(order: CanonicalOrderDto): string {
  if (isPresent(order.serviceType)) return humanizeToken(order.serviceType);
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession);
  return "—";
}

export function formatDeliveryDayLabel(order: CanonicalOrderDto): {
  detail: string | null;
  label: string;
  toneClass: string;
} {
  if (order.deliveryDate === null) {
    return {
      detail: formatTimeWindow(order),
      label: "Review",
      toneClass: "order-pill--review",
    };
  }
  const weekday = weekdayCode(order.deliveryDate) ?? order.deliveryDate;
  const timeWindow = formatTimeWindow(order);
  return {
    detail:
      [order.deliveryDate, timeWindow].filter(isPresent).join(" · ") || null,
    label: compactDayLabel(weekday, order.timeWindowStart),
    toneClass: "order-pill--day",
  };
}

export function formatOperationalStatus(order: CanonicalOrderDto): {
  detail: string | null;
  label: string;
  toneClass: string;
} {
  if (order.metadataResolved !== true) {
    return {
      detail: geocodeDetail(order),
      label: "Metadata review",
      toneClass: "order-pill--review",
    };
  }
  if (order.routeEligible === true) {
    return {
      detail: geocodeDetail(order),
      label: "Ready",
      toneClass: "order-pill--ready",
    };
  }
  const repair = getRouteRepairPrompt(order);
  return {
    detail: repair.statusDetail,
    label: repair.statusLabel,
    toneClass: "order-pill--neutral",
  };
}

function formatOrderSource(order: CanonicalOrderDto): string {
  const source = [
    order.sourcePlatform,
    order.sourceOrderNumber ?? order.sourceOrderId,
  ]
    .filter(isPresent)
    .join(" · ");
  return source || "—";
}

function getOrderAccessibleLabel(order: CanonicalOrderDto): string {
  return [order.orderName, order.sourceOrderNumber ?? order.sourceOrderId]
    .filter(isPresent)
    .join(" ") || order.orderId;
}

function formatAreaLabel(order: CanonicalOrderDto): string {
  return (
    order.deliveryArea ??
    order.shippingAddress.city ??
    order.shippingAddress.province ??
    "—"
  );
}

function formatRouteLabel(order: CanonicalOrderDto): string {
  return order.routePlanName ?? humanizeToken(order.planningStatus);
}

export function getRouteRepairPrompt(order: CanonicalOrderDto): {
  canGeocode: boolean;
  routeDetail: string;
  statusDetail: string | null;
  statusLabel: string;
} {
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return {
      canGeocode: false,
      routeDetail: "Already planned",
      statusDetail: order.routePlanName ?? humanizeToken(order.planningStatus),
      statusLabel: "Planned",
    };
  }
  if (isRoutePlanEligible(order)) {
    return {
      canGeocode: false,
      routeDetail: "Route eligible",
      statusDetail: null,
      statusLabel: "Ready",
    };
  }
  if (order.metadataResolved !== true) {
    return {
      canGeocode: false,
      routeDetail: "Needs metadata",
      statusDetail: geocodeDetail(order),
      statusLabel: "Metadata review",
    };
  }
  if (!hasResolvedCoordinates(order)) {
    const canGeocode = hasGeocodableAddress(order);
    return {
      canGeocode,
      routeDetail: canGeocode ? "Need coordinates" : "Need address",
      statusDetail: canGeocode
        ? "Geocode shipping address"
        : "Enter address or coordinates",
      statusLabel: canGeocode ? "Need coordinates" : "Need address",
    };
  }
  return {
    canGeocode: false,
    routeDetail: "Not route eligible",
    statusDetail: "Review route constraints",
    statusLabel: "Metadata ok",
  };
}

function geocodeDetail(order: CanonicalOrderDto): string | null {
  if (
    order.geocodeStatus === "RESOLVED" ||
    order.geocodeStatus === "NOT_REQUIRED"
  )
    return null;
  return humanizeToken(order.geocodeStatus);
}

function formatTimeWindow(order: CanonicalOrderDto): string | null {
  if (isPresent(order.timeWindowStart) && isPresent(order.timeWindowEnd)) {
    return `${formatTime(order.timeWindowStart)}–${formatTime(order.timeWindowEnd)}`;
  }
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession);
  return null;
}

function compactDayLabel(
  weekday: string,
  timeWindowStart: string | null,
): string {
  if (!isPresent(timeWindowStart)) return weekday;
  const compactTime = formatTime(timeWindowStart).replace(/\s/g, "");
  return `${weekday}${compactTime}`;
}

function weekdayCode(dateString: string): string | null {
  const parts = dateString.split("-").map((part) => Number.parseInt(part, 10));
  const [year, month, day] = parts;
  if (
    parts.length !== 3 ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.valueOf())) return null;
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][
    date.getUTCDay()
  ] ?? null;
}

function formatTime(value: string): string {
  const [hourText, minuteText] = value.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "0", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${hour12}${period}`
    : `${hour12}:${String(minute).padStart(2, "0")}${period}`;
}

function humanizeToken(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

function hasResolvedCoordinates(order: CanonicalOrderDto): boolean {
  return (
    typeof order.coordinates.latitude === "number" &&
    Number.isFinite(order.coordinates.latitude) &&
    typeof order.coordinates.longitude === "number" &&
    Number.isFinite(order.coordinates.longitude)
  );
}

function hasGeocodableAddress(order: CanonicalOrderDto): boolean {
  return [
    order.shippingAddress.address1,
    order.shippingAddress.city,
    order.shippingAddress.province,
    order.shippingAddress.postalCode,
  ].some(isPresent);
}

function DeliveryDiagnostics({
  diagnostics,
}: {
  diagnostics: DeliveryMetadataDiagnosticsDto | null;
}): ReactElement {
  if (diagnostics === null)
    return (
      <div className="metadata-diagnostics">
        <p>No delivery metadata diagnostics saved for this order yet.</p>
      </div>
    );
  return (
    <div className="metadata-diagnostics">
      <strong>Delivery metadata diagnostics</strong>
      <p>
        Status: {diagnostics.status} · matched paths:{" "}
        {Object.entries(diagnostics.matchedMappingPaths)
          .filter(([, value]) => value !== null)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ") || "none"}
      </p>
      <ul>
        {diagnostics.candidates.slice(0, 8).map((candidate) => (
          <li key={`${candidate.path}-${candidate.valuePreview}`}>
            {candidate.path}: {candidate.valuePreview}{" "}
            <small>
              {candidate.parseStatus}
              {candidate.weekday === null || candidate.weekday === undefined
                ? ""
                : ` · ${candidate.weekday}`}
              {candidate.timeWindowStart === null ||
              candidate.timeWindowStart === undefined ||
              candidate.timeWindowEnd === null ||
              candidate.timeWindowEnd === undefined
                ? ""
                : ` · ${candidate.timeWindowStart}-${candidate.timeWindowEnd}`}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function isRoutePlanEligible(order: CanonicalOrderDto): boolean {
  return (
    order.routeEligible === true ||
    (order.routeEligible !== false &&
      order.blockerReasons.length === 0 &&
      order.planningStatus === "UNPLANNED" &&
      order.routePlanId === null)
  );
}
