import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import {
  createRoute,
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
            loading={loading}
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

function OrderTable(input: {
  diagnosticsByOrder: Record<string, DeliveryMetadataDiagnosticsDto | null>;
  loading: boolean;
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
    <article className="panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Orders</span>
          <h2>Imported order list</h2>
        </div>
        <Badge>{input.orders.length} orders</Badge>
      </div>
      <table className="ops-table">
        <thead>
          <tr>
            <th />
            <th>Order</th>
            <th>Recipient</th>
            <th>Date</th>
            <th>Area</th>
            <th>Status</th>
            <th>Route</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {input.orders.flatMap((order) => {
            const selected = input.selected.has(order.orderId);
            const canPlan = isRoutePlanEligible(order);
            const diagnostics = input.diagnosticsByOrder[order.orderId];
            return [
              <tr
                key={order.orderId}
                className={
                  order.blockerReasons.length > 0 ? "needs-review" : ""
                }
              >
                <td>
                  <input
                    checked={selected}
                    disabled={!canPlan && !selected}
                    onChange={(event) => {
                      const next = new Set(input.selected);
                      if (event.target.checked && canPlan)
                        next.add(order.orderId);
                      else next.delete(order.orderId);
                      input.setSelected(next);
                    }}
                    type="checkbox"
                  />
                </td>
                <td>
                  <strong>{order.orderName}</strong>
                  <small>
                    {order.sourcePlatform ?? "source"} ·{" "}
                    {order.sourceOrderNumber ?? order.sourceOrderId}
                  </small>
                </td>
                <td>{order.recipientName ?? "—"}</td>
                <td>{order.deliveryDate ?? "Review"}</td>
                <td>{order.deliveryArea ?? "—"}</td>
                <td>
                  <Badge>
                    {order.metadataResolved
                      ? order.routeEligible
                        ? "route eligible"
                        : "metadata ok"
                      : "metadata review"}
                  </Badge>
                  <small>{order.geocodeStatus}</small>
                </td>
                <td>{order.routePlanName ?? order.planningStatus}</td>
                <td>
                  <button
                    className={selected ? "active" : ""}
                    disabled={!canPlan && !selected}
                    onClick={() => input.onTogglePlanOrder(order.orderId)}
                    type="button"
                  >
                    {selected ? "Remove" : "Add"}
                  </button>
                  <button
                    onClick={() => input.onLoadDiagnostics(order.orderId)}
                    type="button"
                  >
                    Diagnostics
                  </button>
                </td>
              </tr>,
              diagnostics === undefined ? null : (
                <tr
                  className="diagnostics-row"
                  key={`${order.orderId}-diagnostics`}
                >
                  <td colSpan={8}>
                    <DeliveryDiagnostics diagnostics={diagnostics} />
                  </td>
                </tr>
              ),
            ].filter((row): row is ReactElement => row !== null);
          })}
        </tbody>
      </table>
    </article>
  );
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
