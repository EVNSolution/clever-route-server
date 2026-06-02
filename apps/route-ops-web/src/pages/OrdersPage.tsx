import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";

import {
  bulkGeocodeOrders,
  createRoute,
  getBulkGeocodeJob,
  getOrderMetadataDiagnostics,
  getOrders,
  getSettings,
  patchOrderMetadata,
} from "../api";
import { Badge } from "../components/primitives";
import { orderDetailLabels, orderFieldLabels } from "../i18n";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import {
  applyClientOrderFilters,
  buildOrderFetchQuery,
  buildOrderQuery,
  createDefaultOrderFilters,
  getOrderWorksetUnavailableReasons,
  isOrderWorksetEligible,
  storeSettingsToDepotPoint,
  summarizeOrderWorkset,
  summarizeSelection,
  type OrderFilterState,
  type OrderScopeFilter,
  type OrderWorksetContext,
} from "../state";
import type {
  BootstrapPayload,
  BulkGeocodeJobDto,
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
  StoreSettingsDto,
} from "../types";
import {
  activeRouteScopeValues,
  normalizeRouteScopeConfig,
  routeScopeValueSummary,
} from "../routeScopeConfig";
import { readErrorMessage, today } from "../utils/format";

export const ORDERS_TABLE_COLUMN_COUNT = 9;
export type OrderMetadataPatch = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  postalCode: string | null;
  province: string | null;
  serviceType: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

export type EditableMetadataField = {
  choices?: StoreSettingsDto["routeScopeConfig"]["serviceTypes"];
  helpText?: string;
  key: keyof OrderMetadataPatch;
  label: string;
  placeholder?: string;
};

const EDITABLE_METADATA_FIELD_KEYS: Array<keyof OrderMetadataPatch> = [
  "address1",
  "address2",
  "city",
  "province",
  "postalCode",
  "countryCode",
  "deliveryArea",
  "deliveryDate",
  "serviceType",
  "deliverySession",
  "timeWindowStart",
  "timeWindowEnd",
];

export function buildEditableMetadataFields(
  settings: StoreSettingsDto | null | undefined,
): EditableMetadataField[] {
  const config = normalizeRouteScopeConfig(settings?.routeScopeConfig);
  const serviceTypeChoices = activeRouteScopeValues(config.serviceTypes);
  const deliverySessionChoices = activeRouteScopeValues(config.deliverySessions);
  const eveningService =
    serviceTypeChoices.find((value) => value.value === "EVENING_DELIVERY") ??
    serviceTypeChoices[0];
  const eveningSession =
    deliverySessionChoices.find((value) => value.value === "EVENING") ??
    deliverySessionChoices[0];
  return [
    { key: "address1", label: orderFieldLabels.address1 },
    { key: "address2", label: orderFieldLabels.address2 },
    { key: "city", label: orderFieldLabels.city },
    { key: "province", label: orderFieldLabels.province },
    { key: "postalCode", label: orderFieldLabels.postalCode },
    { key: "countryCode", label: orderFieldLabels.countryCode },
    { key: "deliveryArea", label: orderFieldLabels.deliveryArea },
    {
      helpText: "Enter the route date as YYYY-MM-DD, for example 2026-05-29.",
      key: "deliveryDate",
      label: orderFieldLabels.deliveryDate,
    },
    {
      choices: serviceTypeChoices,
      helpText: `Allowed values: ${routeScopeValueSummary(config.serviceTypes)}. Example: ${eveningService?.example ?? "EVENING_DELIVERY for a 5PM-9PM delivery route."}`,
      key: "serviceType",
      label: orderFieldLabels.serviceType,
      placeholder: eveningService?.value ?? "EVENING_DELIVERY",
    },
    {
      choices: deliverySessionChoices,
      helpText: `Allowed values: ${routeScopeValueSummary(config.deliverySessions)}. Example: ${eveningSession?.example ?? "EVENING for a 5PM-9PM route."}`,
      key: "deliverySession",
      label: orderFieldLabels.deliverySession,
      placeholder: eveningSession?.value ?? "EVENING",
    },
    {
      helpText: `${config.timeWindow.helpText} Example: ${config.timeWindow.startExample}.`,
      key: "timeWindowStart",
      label: orderFieldLabels.timeWindowStart,
      placeholder: config.timeWindow.startExample,
    },
    {
      helpText: `${config.timeWindow.helpText} Example: ${config.timeWindow.endExample}.`,
      key: "timeWindowEnd",
      label: orderFieldLabels.timeWindowEnd,
      placeholder: config.timeWindow.endExample,
    },
  ];
}

function editableMetadataField(
  key: keyof OrderMetadataPatch,
  fields: EditableMetadataField[],
): EditableMetadataField {
  const field = fields.find((candidate) => candidate.key === key);
  if (field === undefined) {
    throw new Error(`Unknown editable order metadata field: ${key}`);
  }
  return field;
}

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
  const [autoAppliedDeliveryDateFilter, setAutoAppliedDeliveryDateFilter] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<StoreSettingsDto | null>(null);
  const [diagnosticsByOrder, setDiagnosticsByOrder] = useState<
    Record<string, DeliveryMetadataDiagnosticsDto | null>
  >({});
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(
    new Set(),
  );
  const [bulkGeocodeStatus, setBulkGeocodeStatus] = useState<string | null>(
    null,
  );
  const [bulkGeocoding, setBulkGeocoding] = useState(false);

  const query = useMemo(() => buildOrderQuery(filters), [filters]);
  const fetchQuery = useMemo(() => buildOrderFetchQuery(filters), [filters]);
  const visibleOrders = useMemo(
    () => applyClientOrderFilters(orders, filters),
    [orders, filters],
  );
  const routeActionsReadOnly = filters.scope === "history";
  const worksetContext = useMemo<OrderWorksetContext>(
    () => ({ scope: filters.scope }),
    [filters.scope],
  );
  const selection = useMemo(
    () => summarizeSelection(orders, selected),
    [orders, selected],
  );
  const depotPoint = useMemo(
    () => storeSettingsToDepotPoint(settings),
    [settings],
  );
  const plannedOrderIds = useMemo(() => {
    const highlighted = new Set(selected);
    for (const order of visibleOrders) {
      if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
        highlighted.add(order.orderId);
      }
    }
    return highlighted;
  }, [selected, visibleOrders]);

  const refreshOrders = async (): Promise<void> => {
    setLoading(true);
    try {
      const payload = await getOrders(fetchQuery);
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
  }, [fetchQuery]);

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
      const routeDraftBlocker = getRouteDraftCreateBlocker(
        selection.readySelected,
        routeDate || today(),
      );
      if (routeDraftBlocker !== null) throw new Error(routeDraftBlocker);
      const result = await createRoute({
        csrfToken: bootstrap.csrfToken,
        depotAddress: settings?.defaultDepotAddress ?? null,
        depotLatitude: settings?.defaultDepotLatitude ?? null,
        depotLongitude: settings?.defaultDepotLongitude ?? null,
        orderIds: [...selected],
        planDate: routeDate || today(),
        routeName,
        scope: filters.scope,
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
      setOrders((current) =>
        current.map((order) =>
          order.orderId === payload.order.orderId ? payload.order : order,
        ),
      );
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };

  const toggleOrderDetail = (orderId: string): void => {
    let shouldLoad = false;
    setExpandedOrderIds((current) => {
      const next = new Set(current);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
        shouldLoad = diagnosticsByOrder[orderId] === undefined;
      }
      return next;
    });
    if (shouldLoad) void loadDiagnostics(orderId);
  };

  const closeOrderDetail = (orderId: string): void => {
    setExpandedOrderIds((current) => {
      const next = new Set(current);
      next.delete(orderId);
      return next;
    });
  };

  const saveOrderMetadata = async (
    orderId: string,
    patch: OrderMetadataPatch,
  ): Promise<void> => {
    try {
      const payload = await patchOrderMetadata({
        csrfToken: bootstrap.csrfToken,
        orderId,
        patch: compactMetadataPatch(patch),
        scope: filters.scope,
      });
      setOrders((current) =>
        current.map((order) =>
          order.orderId === payload.order.orderId ? payload.order : order,
        ),
      );
      setDiagnosticsByOrder((current) => {
        const next = { ...current };
        delete next[orderId];
        return next;
      });
      await loadDiagnostics(orderId);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
      throw error;
    }
  };

  const bulkGeocodeCurrentView = async (): Promise<void> => {
    setBulkGeocoding(true);
    setBulkGeocodeStatus(null);
    try {
      const payload = await bulkGeocodeOrders({
        csrfToken: bootstrap.csrfToken,
        query,
      });
      let job = payload.geocode;
      setBulkGeocodeStatus(formatBulkGeocodeStatus(job));
      for (
        let attempt = 0;
        attempt < 60 && !isBulkGeocodeTerminal(job);
        attempt += 1
      ) {
        await sleep(1_000);
        job = (await getBulkGeocodeJob(job.jobId)).geocode;
        setBulkGeocodeStatus(formatBulkGeocodeStatus(job));
      }
      await refreshOrders();
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setBulkGeocoding(false);
    }
  };

  const applyPlanDateLock = (deliveryDate: string): void => {
    setRouteDate(deliveryDate);
    setRouteName((current) =>
      current.trim() === "" || /^Route \d{4}-\d{2}-\d{2}$/u.test(current)
        ? `Route ${deliveryDate}`
        : current,
    );
    setAutoAppliedDeliveryDateFilter(deliveryDate);
    setFilters((current) =>
      current.deliveryDate === deliveryDate
        ? current
        : { ...current, deliveryDate },
    );
  };

  const clearPlan = (): void => {
    setSelected(new Set());
    setError(null);
    const autoDate = autoAppliedDeliveryDateFilter;
    setAutoAppliedDeliveryDateFilter(null);
    if (autoDate !== null) {
      setFilters((current) =>
        current.deliveryDate === autoDate
          ? { ...current, deliveryDate: "" }
          : current,
      );
    }
  };

  const applyPlanSelection = (requestedSelected: Set<string>): void => {
    const draft = buildRouteDraftSelection(orders, requestedSelected);
    setSelected(new Set(draft.orderIds));
    if (draft.deliveryDate === null) {
      if (requestedSelected.size === 0) clearPlan();
      else
        setError(
          draft.warning ?? "Select route-ready orders with a delivery date.",
        );
      return;
    }
    applyPlanDateLock(draft.deliveryDate);
    setError(draft.warning);
  };

  const togglePlanOrder = (orderId: string): void => {
    const next = new Set(selected);
    if (next.has(orderId)) next.delete(orderId);
    else next.add(orderId);
    applyPlanSelection(next);
  };

  const addOrderToPlan = (orderId: string): void => {
    const order =
      visibleOrders.find((candidate) => candidate.orderId === orderId) ??
      orders.find((candidate) => candidate.orderId === orderId);
    if (order === undefined) return;
    const reasons = getOrderWorksetUnavailableReasons(order, worksetContext);
    if (!isOrderWorksetEligible(order, worksetContext)) {
      setError(
        `Order is not available for this plan: ${
          reasons.map((reason) => reason.label).join(", ") ||
          "Review route constraints"
        }.`,
      );
      return;
    }
    const next = new Set(selected);
    next.add(orderId);
    applyPlanSelection(next);
  };

  return (
    <TabLayout
      title="Orders"
      primary={
        <RouteOpsMap
          bootstrap={bootstrap}
          depot={depotPoint}
          onOrderSelect={routeActionsReadOnly ? undefined : addOrderToPlan}
          orders={visibleOrders}
          plannedOrderIds={plannedOrderIds}
          subtitle="Imported WooCommerce stops by current filters"
          title="Orders map"
        />
      }
      secondary={
        <RoutePlanPanel
          invalidSelectionCount={selected.size - selection.readySelected.length}
          onClear={clearPlan}
          onCreate={() => void create()}
          readOnly={routeActionsReadOnly}
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
              className={filters.tab === "all" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  health: "",
                  tab: "all",
                })
              }
              type="button"
            >
              All
            </button>
            <button
              className={filters.tab === "unplanned" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  health: "",
                  tab: "unplanned",
                })
              }
              type="button"
            >
              Unplanned
            </button>
            <button
              className={filters.tab === "planned" ? "active" : ""}
              onClick={() =>
                setFilters({ ...filters, health: "", tab: "planned" })
              }
              type="button"
            >
              Planned
            </button>
            <button
              className={filters.tab === "needs_review" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  health: "",
                  tab: "needs_review",
                })
              }
              type="button"
            >
              Needs Review
            </button>
          </div>
          <FilterBar filters={filters} onChange={setFilters} settings={settings} />
          <OrderTable
            bulkGeocodeStatus={bulkGeocodeStatus}
            bulkGeocoding={bulkGeocoding}
            diagnosticsByOrder={diagnosticsByOrder}
            expandedOrderIds={expandedOrderIds}
            loading={loading}
            onBulkGeocode={() => void bulkGeocodeCurrentView()}
            onCloseDetail={closeOrderDetail}
            onSaveMetadata={saveOrderMetadata}
            onToggleDetail={toggleOrderDetail}
            onTogglePlanOrder={togglePlanOrder}
            orders={visibleOrders}
            readOnly={routeActionsReadOnly}
            selected={selected}
            setSelected={applyPlanSelection}
            settings={settings}
            worksetContext={worksetContext}
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
  readOnly?: boolean;
  routeDate: string;
  routeName: string;
  selectedOrders: CanonicalOrderDto[];
  setRouteDate(value: string): void;
  setRouteName(value: string): void;
  totalSelected: number;
}): ReactElement {
  const canCreate =
    input.readOnly !== true &&
    input.selectedOrders.length > 0 &&
    input.invalidSelectionCount === 0;
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
        {input.readOnly === true
          ? "History scope is read-only. Switch back to planning to create a route."
          : "Use the map or order list to add ready unplanned orders, then create the route."}
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
          Clear plan
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
  settings,
}: {
  filters: OrderFilterState;
  onChange(filters: OrderFilterState): void;
  settings?: StoreSettingsDto | null;
}): ReactElement {
  const config = normalizeRouteScopeConfig(settings?.routeScopeConfig);
  const serviceTypes = activeRouteScopeValues(config.serviceTypes);
  const deliverySessions = activeRouteScopeValues(config.deliverySessions);
  const resetFilters = (): void => onChange(createDefaultOrderFilters());
  const setScope = (scope: OrderScopeFilter): void => {
    onChange({
      ...filters,
      health: "",
      scope,
      tab:
        scope === "history"
          ? "all"
          : filters.tab === "all"
            ? "unplanned"
            : filters.tab,
    });
  };
  return (
    <article className="panel filter-panel">
      <label className="filter-field filter-field--scope">
        Scope
        <select
          value={filters.scope}
          onChange={(event) => setScope(event.target.value as OrderScopeFilter)}
        >
          <option value="planning">Planning orders</option>
          <option value="history">History / all orders</option>
        </select>
      </label>
      <label className="filter-field filter-field--date">
        Delivery date
        <input
          type="date"
          value={filters.deliveryDate}
          onChange={(event) =>
            onChange({ ...filters, deliveryDate: event.target.value })
          }
        />
      </label>
      <label className="filter-field filter-field--area">
        Area / region
        <input
          placeholder="Toronto"
          value={filters.deliveryArea}
          onChange={(event) =>
            onChange({ ...filters, deliveryArea: event.target.value })
          }
        />
      </label>
      <label className="filter-field filter-field--status">
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
      <label className="filter-field filter-field--health">
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
      <label className="filter-field filter-field--service">
        Service type
        <select
          value={filters.serviceType}
          onChange={(event) =>
            onChange({ ...filters, serviceType: event.target.value })
          }
        >
          <option value="">All</option>
          {serviceTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {formatFilterOptionLabel(option.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field filter-field--session">
        Delivery session
        <select
          value={filters.deliverySession}
          onChange={(event) =>
            onChange({ ...filters, deliverySession: event.target.value })
          }
        >
          <option value="">All</option>
          {deliverySessions.map((option) => (
            <option key={option.value} value={option.value}>
              {formatFilterOptionLabel(option.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field filter-field--search">
        Search
        <input
          placeholder="#1001, email, phone"
          value={filters.search}
          onChange={(event) =>
            onChange({ ...filters, search: event.target.value })
          }
        />
      </label>
      <div className="filter-actions">
        <button onClick={resetFilters} type="button">
          Clear filters
        </button>
      </div>
    </article>
  );
}

function formatFilterOptionLabel(value: string): string {
  const normalized = value.trim();
  const builtInLabel = new Map<string, string>([
    ["day", "Day"],
    ["delivery", "Delivery"],
    ["evening", "Evening"],
    ["evening delivery", "Evening Delivery"],
    ["pickup", "Pickup"],
  ]).get(normalized.toLowerCase());
  return builtInLabel ?? normalized;
}

function formatBulkGeocodeStatus(job: BulkGeocodeJobDto): string {
  const status = job.status;
  const counts = job.counts;
  const parts = [
    ["matched", counts.matched],
    ["attempted", counts.attempted],
    ["resolved", counts.succeeded],
    ["failed", counts.failed],
    ["no address", counts.noAddress],
    ["skipped by policy", counts.skippedByPolicy],
    ["already had coordinates", counts.skippedAlreadyGeocoded],
  ]
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([label, value]) => `${value} ${label}`);
  const suffix = parts.length === 0 ? "" : `: ${parts.join(", ")}`;
  const policy =
    job.policyLimit?.reached === true
      ? ` Public geocoder cap reached (${job.policyLimit.attemptedLimit ?? "configured"} attempts).`
      : "";
  return `Bulk geocode ${humanizeToken(status)}${suffix}.${policy}`;
}

function isBulkGeocodeTerminal(job: BulkGeocodeJobDto): boolean {
  return job.status === "completed" || job.status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function OrderTable(input: {
  bulkGeocodeStatus?: string | null;
  bulkGeocoding?: boolean;
  detailModes?: Record<string, "review" | "edit">;
  diagnosticsByOrder: Record<string, DeliveryMetadataDiagnosticsDto | null>;
  expandedOrderIds?: ReadonlySet<string>;
  loading: boolean;
  onBulkGeocode?(): void;
  onCloseDetail?(orderId: string): void;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  orders: CanonicalOrderDto[];
  readOnly?: boolean;
  selected: Set<string>;
  setSelected(selected: Set<string>): void;
  settings?: StoreSettingsDto | null;
  worksetContext?: OrderWorksetContext;
}): ReactElement {
  const worksetContext = input.worksetContext ?? {};
  const worksetSummary = summarizeOrderWorkset(
    input.orders,
    input.selected,
    worksetContext,
  );
  const selectableOrderIds =
    input.readOnly === true ? [] : worksetSummary.selectableOrderIds;
  const visibleOrderIds = input.orders.map((order) => order.orderId);
  const selectedFilteredCount = selectableOrderIds.filter((orderId) =>
    input.selected.has(orderId),
  ).length;
  const visibleSelectedCount = visibleOrderIds.filter((orderId) =>
    input.selected.has(orderId),
  ).length;
  const allFilteredSelected =
    selectableOrderIds.length > 0 &&
    selectedFilteredCount === selectableOrderIds.length;
  const selectFilteredOrders = (): void => {
    input.setSelected(new Set([...input.selected, ...selectableOrderIds]));
  };
  const clearFilteredOrders = (): void => {
    const next = new Set(input.selected);
    for (const orderId of visibleOrderIds) next.delete(orderId);
    input.setSelected(next);
  };
  const toggleFilteredSelection = (checked: boolean): void => {
    if (checked) selectFilteredOrders();
    else clearFilteredOrders();
  };

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
        <div className="orders-heading-actions">
          <Badge>{input.orders.length} orders</Badge>
          <span className="orders-selection-summary">
            {visibleSelectedCount} selected · {worksetSummary.selectableCount}{" "}
            selectable · {worksetSummary.unavailableCount} unavailable
          </span>
          <button
            disabled={visibleSelectedCount === 0}
            onClick={clearFilteredOrders}
            type="button"
          >
            Clear selection
          </button>
          <button
            disabled={input.bulkGeocoding === true || input.readOnly === true}
            onClick={() => input.onBulkGeocode?.()}
            type="button"
            title={
              input.readOnly === true ? "History scope is read-only." : undefined
            }
          >
            {input.bulkGeocoding === true ? "Bulk geocoding…" : "Bulk geocode"}
          </button>
        </div>
      </div>
      {input.readOnly === true ? (
        <p className="orders-workset-note">
          History scope is read-only. Switch to planning to select orders, bulk
          geocode, or create routes.
        </p>
      ) : worksetSummary.reasonLabels.length === 0 ? null : (
        <p className="orders-workset-note">
          Unavailable: {worksetSummary.reasonLabels.join(" · ")}
        </p>
      )}
      {input.bulkGeocodeStatus === undefined ||
      input.bulkGeocodeStatus === null ? null : (
        <p className="orders-bulk-status" role="status">
          {input.bulkGeocodeStatus}
        </p>
      )}
      <div
        className="orders-table-scroll"
        data-column-count={ORDERS_TABLE_COLUMN_COUNT}
      >
        <table className="orders-compact-table">
          <thead>
            <tr>
              <th className="orders-select-col" scope="col">
                <input
                  aria-label="Select all eligible orders in current workset"
                  checked={allFilteredSelected}
                  disabled={selectableOrderIds.length === 0}
                  onChange={(event) =>
                    toggleFilteredSelection(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>Select</span>
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
                  detailMode={input.detailModes?.[order.orderId] ?? "review"}
                  diagnostics={input.diagnosticsByOrder[order.orderId]}
                  expanded={input.expandedOrderIds?.has(order.orderId) ?? false}
                  key={order.orderId}
                  onCloseDetail={input.onCloseDetail}
                  onSaveMetadata={input.onSaveMetadata}
                  onToggleDetail={input.onToggleDetail}
                  onTogglePlanOrder={input.onTogglePlanOrder}
                  order={order}
                  readOnly={input.readOnly === true}
                  selectedOrders={input.selected}
                  setSelected={input.setSelected}
                  settings={input.settings}
                  worksetContext={worksetContext}
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
  detailMode: "review" | "edit";
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  expanded: boolean;
  onCloseDetail?(orderId: string): void;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  order: CanonicalOrderDto;
  readOnly?: boolean;
  selectedOrders: Set<string>;
  setSelected(selected: Set<string>): void;
  settings?: StoreSettingsDto | null;
  worksetContext?: OrderWorksetContext;
}): ReactElement {
  const { order } = input;
  const selected = input.selectedOrders.has(order.orderId);
  const unavailableReasons = getOrderWorksetUnavailableReasons(
    order,
    input.worksetContext,
  );
  const canPlan =
    input.readOnly !== true &&
    unavailableReasons.length === 0 &&
    isOrderWorksetEligible(order, input.worksetContext);
  const day = formatDeliveryDayLabel(order);
  const status = formatOperationalStatus(order);
  const orderLabel = getOrderAccessibleLabel(order);
  const planActionLabel = `${
    selected ? "Remove" : "Add"
  } order ${orderLabel} ${selected ? "from" : "to"} route plan`;
  const detailPanelId = `order-detail-${sanitizeId(order.orderId)}`;
  const detailLabel = `${input.expanded ? "Hide" : "Show"} details for order ${orderLabel}`;
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
            onChange={() => input.onTogglePlanOrder(order.orderId)}
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
              title={
                canPlan || selected
                  ? undefined
                  : unavailableReasons.map((reason) => reason.label).join(", ")
              }
            >
              {selected ? "Remove" : "Add"}
            </button>
            <button
              aria-controls={detailPanelId}
              aria-expanded={input.expanded}
              aria-label={detailLabel}
              onClick={() => input.onToggleDetail?.(order.orderId)}
              type="button"
            >
              Detail
            </button>
          </div>
        </td>
      </tr>
      {input.expanded ? (
        <tr className="order-detail-row">
          <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
            <OrderDetailPanel
              diagnostics={input.diagnostics}
              id={detailPanelId}
              initialEditMode={input.detailMode === "edit"}
              onClose={() => input.onCloseDetail?.(order.orderId)}
              onSaveMetadata={
                input.readOnly === true || input.onSaveMetadata === undefined
                  ? undefined
                  : (patch: OrderMetadataPatch) =>
                      input.onSaveMetadata!(order.orderId, patch)
              }
              order={order}
              readOnly={input.readOnly === true}
              settings={input.settings}
            />
          </td>
        </tr>
      ) : null}
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
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return {
      detail: order.routePlanName ?? humanizeToken(order.planningStatus),
      label: "Planned",
      toneClass: "order-pill--neutral",
    };
  }
  const blockerLabel = mostSpecificBlockerLabel(order);
  if (blockerLabel !== null) {
    return {
      detail: geocodeDetail(order),
      label: blockerLabel,
      toneClass: "order-pill--review",
    };
  }
  if (order.deliveryDate === null) {
    return {
      detail: geocodeDetail(order),
      label: "Missing delivery date",
      toneClass: "order-pill--review",
    };
  }
  if (!hasResolvedCoordinates(order)) {
    const canGeocode = hasGeocodableAddress(order);
    return {
      detail: canGeocode ? "use bulk geocode" : "Enter address or coordinates",
      label: canGeocode ? "Need coordinates" : "Missing address",
      toneClass: "order-pill--review",
    };
  }
  if (order.metadataResolved !== true)
    return {
      detail: geocodeDetail(order),
      label: "Metadata review",
      toneClass: "order-pill--review",
    };
  if (order.routeEligible === true) {
    return {
      detail: geocodeDetail(order),
      label: "Ready",
      toneClass: "order-pill--ready",
    };
  }
  return {
    detail: "Review route constraints",
    label: "Not route eligible",
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
  return (
    [order.orderName, order.sourceOrderNumber ?? order.sourceOrderId]
      .filter(isPresent)
      .join(" ") || order.orderId
  );
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
  if (order.routePlanName !== null) return order.routePlanName;
  if (order.planningStatus === "UNPLANNED") return "Unplanned";
  return humanizeToken(order.planningStatus);
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
      statusDetail: canGeocode ? "use bulk geocode" : "Enter address or coordinates",
      statusLabel: canGeocode ? "Need coordinates" : "Missing address",
    };
  }
  return {
    canGeocode: false,
    routeDetail: "Not route eligible",
    statusDetail: "Review route constraints",
    statusLabel: "Not route eligible",
  };
}

function geocodeDetail(order: CanonicalOrderDto): string | null {
  if (
    order.geocodeStatus === "RESOLVED" ||
    order.geocodeStatus === "NOT_REQUIRED"
  )
    return null;
  const code = order.geocodeDiagnostics?.code ?? order.geocodeDiagnostics?.messageKey ?? null;
  if (code !== null) return geocodeMessageForCode(code);
  return orderDetailLabels.geocodeStatus[order.geocodeStatus];
}

function geocodeMessageForCode(code: string): string {
  switch (code) {
    case "BLANK_ADDRESS":
      return "Address is missing or incomplete";
    case "GEOCODER_NO_RESULT":
      return "use bulk geocode";
    case "GEOCODER_PROVIDER_RATE_LIMITED":
      return "Geocoder is rate limited; try bulk geocode later";
    case "GEOCODER_PROVIDER_TIMEOUT":
      return "Geocoder timed out";
    case "GEOCODER_PROVIDER_HTTP_ERROR":
    case "GEOCODER_PROVIDER_ERROR":
      return "Geocoder provider failed";
    case "GEOCODER_NOT_CONFIGURED":
    case "GEOCODER_DISABLED":
      return "Geocoder is not configured";
    case "GEOCODER_INVALID_RESULT":
      return "Geocoder returned an invalid result";
    default:
      return humanizeToken(code);
  }
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
  return (
    ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getUTCDay()] ?? null
  );
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

function mostSpecificBlockerLabel(order: CanonicalOrderDto): string | null {
  const blockers = new Set(order.blockerReasons);
  if (blockers.has("missing_delivery_date") || order.deliveryDate === null)
    return "Missing delivery date";
  if (blockers.has("missing_delivery_area")) return "Missing delivery area";
  if (blockers.has("missing_route_scope")) return "Missing route scope";
  if (
    [
      "delivery_day_unparsed",
      "ambiguous_delivery_day",
      "delivery_date_weekday_mismatch",
      "delivery_date_weekday_unverified",
    ].some((reason) => blockers.has(reason))
  )
    return "Delivery day unclear";
  if (blockers.has("missing_time_window")) return "Missing time window";
  if (
    ["delivery_time_window_unparsed", "ambiguous_delivery_time_window"].some(
      (reason) => blockers.has(reason),
    )
  )
    return "Delivery time unclear";
  if (blockers.has("missing_coordinates"))
    return hasGeocodableAddress(order) ? "Need coordinates" : "Missing address";
  return null;
}

export function formatBlockerReason(reason: string): string {
  return (
    orderDetailLabels.blockerReasons[
      reason as keyof typeof orderDetailLabels.blockerReasons
    ] ?? "Review route constraints"
  );
}

export function formatDiagnosticPathLabel(path: string): string {
  return (
    orderDetailLabels.diagnosticPaths[
      path as keyof typeof orderDetailLabels.diagnosticPaths
    ] ?? "Order metadata"
  );
}

function metadataPatchFromOrder(order: CanonicalOrderDto): OrderMetadataPatch {
  return {
    address1: order.shippingAddress.address1,
    address2: order.shippingAddress.address2,
    city: order.shippingAddress.city,
    countryCode: order.shippingAddress.countryCode,
    deliveryArea: order.deliveryArea,
    deliveryDate: order.deliveryDate,
    deliverySession: order.deliverySession,
    postalCode: order.shippingAddress.postalCode,
    province: order.shippingAddress.province,
    serviceType: order.serviceType,
    timeWindowEnd: order.timeWindowEnd,
    timeWindowStart: order.timeWindowStart,
  };
}

function compactMetadataPatch(
  patch: OrderMetadataPatch,
): Record<string, string | null> {
  return Object.fromEntries(
    EDITABLE_METADATA_FIELD_KEYS.map((key) => [key, patch[key]]),
  );
}

function OrderDetailPanel({
  diagnostics,
  id: panelId,
  initialEditMode,
  onClose,
  onSaveMetadata,
  order,
  readOnly,
  settings,
}: {
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  id: string;
  initialEditMode?: boolean;
  onClose(): void;
  onSaveMetadata?(patch: OrderMetadataPatch): Promise<void>;
  order: CanonicalOrderDto;
  readOnly?: boolean;
  settings?: StoreSettingsDto | null;
}): ReactElement {
  const canEditMetadata = readOnly !== true;
  const canPersistMetadata = canEditMetadata && onSaveMetadata !== undefined;
  const [editMode, setEditMode] = useState(
    canEditMetadata && (initialEditMode ?? false),
  );
  const [draft, setDraft] = useState<OrderMetadataPatch>(() =>
    metadataPatchFromOrder(order),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onSave = onSaveMetadata;
  const status = formatOperationalStatus(order);
  const blockers = order.blockerReasons.map(formatBlockerReason);
  const editableFields = useMemo(
    () => buildEditableMetadataFields(settings),
    [settings],
  );
  const repairFields = getOrderRepairFields(order, editableFields);
  const hasActionableRepair = repairFields.length > 0;
  const repairTitle = formatRepairCardTitle(repairFields);
  const addressSummary = formatAddressSummary(order);
  const coordinateSummary = formatCoordinateSummary(order);

  const setDraftField = (
    key: keyof OrderMetadataPatch,
    value: string,
  ): void => {
    setDraft((current) => ({
      ...current,
      [key]: value.trim().length === 0 ? null : value,
    }));
  };
  const saveDraft = (): void => {
    if (onSave === undefined || saving) return;
    const patch = normalizeOrderMetadataPatchForFields(draft, editableFields);
    setSaving(true);
    setSaveError(null);
    void onSave(patch)
      .then(() => {
        setEditMode(false);
      })
      .catch((error: unknown) => {
        setSaveError(readErrorMessage(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };
  const submitDraft = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    saveDraft();
  };
  const repairSaveDisabled =
    !canPersistMetadata ||
    saving ||
    hasUnselectedRequiredChoiceField(repairFields, draft);

  return (
    <div
      aria-labelledby={`${panelId}-heading`}
      className="order-detail-panel"
      id={panelId}
    >
      <div className="order-detail-header">
        <div>
          <span className="eyebrow">Detail</span>
          <h3 id={`${panelId}-heading`}>Order details for {order.orderName}</h3>
        </div>
        <div className="orders-actions">
          {editMode || !canEditMetadata ? null : (
            <button onClick={() => setEditMode(true)} type="button">
              Edit all fields
            </button>
          )}
          <button onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>

      <section
        aria-label={hasActionableRepair ? "Fields to fix" : "Order readiness"}
        className={[
          "order-detail-repair-card",
          hasActionableRepair ? "order-detail-repair-card--attention" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="order-detail-repair-copy">
          <span className="eyebrow">
            {hasActionableRepair ? "Needs review" : "Order summary"}
          </span>
          <h4>{hasActionableRepair ? repairTitle : status.label}</h4>
          <p>
            {hasActionableRepair
              ? readOnly === true
                ? "History scope is read-only. Switch to planning to edit this order."
                : "Update the highlighted field, then save this order."
              : (status.detail ?? "No required fixes for this order.")}
          </p>
          {blockers.length === 0 ? null : (
            <div
              className="order-detail-repair-pills"
              aria-label="Current blockers"
            >
              {blockers.map((blocker) => (
                <span className="order-pill order-pill--review" key={blocker}>
                  {blocker}
                </span>
              ))}
            </div>
          )}
        </div>
        {hasActionableRepair && canEditMetadata ? (
          <form className="order-detail-repair-form" onSubmit={submitDraft}>
            <div className="order-detail-repair-fields">
              {repairFields.map((field) => (
                <OrderDetailFieldInput
                  field={field}
                  idPrefix={panelId}
                  instance="repair"
                  key={field.key}
                  onChange={setDraftField}
                  value={draft[field.key]}
                />
              ))}
            </div>
            {saveError === null ? null : (
              <p className="order-detail-error" role="alert">
                {saveError}
              </p>
            )}
            <div className="orders-actions">
              <button disabled={repairSaveDisabled} type="submit">
                {saving ? "Saving…" : "Save fixes"}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <div className="order-detail-summary-grid">
        <section className="order-detail-summary-card">
          <h4>Destination</h4>
          <p>{addressSummary.primary}</p>
          {addressSummary.secondary === null ? null : (
            <small>{addressSummary.secondary}</small>
          )}
        </section>
        <section className="order-detail-summary-card">
          <h4>Coordinates</h4>
          <p>{coordinateSummary.primary}</p>
          {coordinateSummary.secondary === null ? null : (
            <small>{coordinateSummary.secondary}</small>
          )}
        </section>
        <section className="order-detail-summary-card">
          <h4>Delivery</h4>
          <dl className="order-detail-mini-list">
            <div>
              <dt>Date</dt>
              <dd>{order.deliveryDate ?? "Required"}</dd>
            </div>
            <div>
              <dt>Area</dt>
              <dd>{order.deliveryArea ?? "Required"}</dd>
            </div>
            <div>
              <dt>Service</dt>
              <dd>
                {order.serviceType ?? order.deliverySession ?? "Required"}
              </dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{formatTimeWindow(order) ?? "Review if required"}</dd>
            </div>
          </dl>
        </section>
      </div>

      {editMode && canEditMetadata ? (
        <form className="order-detail-edit" onSubmit={submitDraft}>
          <h4>Edit all order fields</h4>
          {saveError === null ? null : (
            <p className="order-detail-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="order-detail-edit-grid">
            {editableFields.map((field) => (
              <OrderDetailFieldInput
                field={field}
                idPrefix={panelId}
                instance="edit"
                key={field.key}
                onChange={setDraftField}
                value={draft[field.key]}
              />
            ))}
          </div>
          <div className="orders-actions">
            <button disabled={!canPersistMetadata || saving} type="submit">
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={onClose} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <details className="order-technical-diagnostics">
        <summary>Technical diagnostics</summary>
        {diagnostics === undefined ? (
          <p>Loading order detail…</p>
        ) : diagnostics === null ? (
          <p>No saved detail diagnostics yet.</p>
        ) : (
          <>
            <p>Status: {humanizeToken(diagnostics.status)}</p>
            <ul>
              {diagnostics.candidates.slice(0, 8).map((candidate) => (
                <li key={`${candidate.path}-${candidate.valuePreview}`}>
                  {formatDiagnosticPathLabel(candidate.path)}:{" "}
                  {candidate.valuePreview}
                  <small> · {humanizeToken(candidate.parseStatus)}</small>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}

function OrderDetailFieldInput({
  field,
  idPrefix,
  instance,
  onChange,
  value,
}: {
  field: EditableMetadataField;
  idPrefix: string;
  instance: "repair" | "edit";
  onChange(key: keyof OrderMetadataPatch, value: string): void;
  value: string | null;
}): ReactElement {
  const [helpOpen, setHelpOpen] = useState(false);
  const inputId = `${idPrefix}-${instance}-${field.key}`;
  const helpId = `${inputId}-help`;
  const labelId = `${inputId}-label`;
  const selectedChoiceValue = getSelectedChoiceValue(field, value);
  return (
    <div className="order-detail-field">
      <span className="order-detail-field-label-row">
        <label
          className="order-detail-field-label"
          htmlFor={field.choices === undefined ? inputId : undefined}
          id={labelId}
        >
          {field.label}
        </label>
        {field.helpText === undefined ? null : (
          <span className="order-detail-field-help-wrap">
            <button
              aria-describedby={helpId}
              aria-expanded={helpOpen}
              aria-label={`${field.label} help`}
              className={`order-detail-field-help${helpOpen ? " is-open" : ""}`}
              onBlur={() => setHelpOpen(false)}
              onClick={() => setHelpOpen((current) => !current)}
              type="button"
            >
              i
            </button>
            <span
              className="order-detail-field-tooltip"
              id={helpId}
              role="tooltip"
            >
              {field.helpText}
            </span>
          </span>
        )}
      </span>
      {field.choices === undefined ? (
        <input
          aria-label={field.label}
          id={inputId}
          name={field.key}
          onChange={(event) => onChange(field.key, event.target.value)}
          placeholder={field.placeholder}
          type={field.key === "deliveryDate" ? "date" : "text"}
          value={value ?? ""}
        />
      ) : (
        <OrderDetailChoiceDropdown
          field={field}
          inputId={inputId}
          labelId={labelId}
          onChange={onChange}
          value={selectedChoiceValue}
        />
      )}
    </div>
  );
}

export function OrderDetailChoiceDropdown({
  field,
  inputId,
  labelId,
  onChange,
  value,
}: {
  field: EditableMetadataField;
  inputId: string;
  labelId: string;
  onChange(key: keyof OrderMetadataPatch, value: string): void;
  value: string | null;
}): ReactElement {
  const choices = field.choices ?? [];
  return (
    <select
      aria-labelledby={labelId}
      className="order-detail-choice-dropdown"
      data-choice-field={field.key}
      id={inputId}
      name={field.key}
      onChange={(event) => onChange(field.key, event.target.value)}
      value={value ?? ""}
    >
      <option disabled value="">
        Select {field.label.toLowerCase()}
      </option>
      {choices.map((choice) => (
        <option
          data-choice-value={choice.value}
          key={choice.value}
          title={choice.example ?? choice.description ?? choice.value}
          value={choice.value}
        >
          {formatChoiceOptionLabel(choice)}
        </option>
      ))}
    </select>
  );
}

function formatChoiceOptionLabel(
  choice: StoreSettingsDto["routeScopeConfig"]["serviceTypes"][number],
): string {
  if (choice.label === choice.value) return choice.label;
  return `${choice.label} · ${choice.value}`;
}

export function normalizeOrderMetadataPatchForFields(
  patch: OrderMetadataPatch,
  fields: EditableMetadataField[],
): OrderMetadataPatch {
  const normalized = { ...patch };
  for (const field of fields) {
    if (field.choices === undefined) continue;
    if (!isActiveChoiceValue(field, normalized[field.key])) {
      normalized[field.key] = null;
    }
  }
  return normalized;
}

function hasUnselectedRequiredChoiceField(
  fields: EditableMetadataField[],
  draft: OrderMetadataPatch,
): boolean {
  return fields.some(
    (field) =>
      field.choices !== undefined && !isActiveChoiceValue(field, draft[field.key]),
  );
}

function getSelectedChoiceValue(
  field: EditableMetadataField,
  value: string | null,
): string | null {
  return isActiveChoiceValue(field, value) ? value : null;
}

function isActiveChoiceValue(
  field: EditableMetadataField,
  value: string | null,
): value is string {
  if (field.choices === undefined || value === null) return false;
  return field.choices.some((choice) => choice.value === value);
}

function getOrderRepairFields(
  order: CanonicalOrderDto,
  editableFields: EditableMetadataField[],
): EditableMetadataField[] {
  const blockers = new Set(order.blockerReasons);
  const fields: EditableMetadataField[] = [];
  const addField = (key: keyof OrderMetadataPatch): void => {
    if (fields.some((field) => field.key === key)) return;
    fields.push(editableMetadataField(key, editableFields));
  };

  if (blockers.has("missing_delivery_date") || order.deliveryDate === null) {
    addField("deliveryDate");
  }
  if (blockers.has("missing_delivery_area") || !isPresent(order.deliveryArea)) {
    addField("deliveryArea");
  }
  if (
    blockers.has("missing_route_scope") ||
    (!isPresent(order.serviceType) && !isPresent(order.deliverySession))
  ) {
    addField("serviceType");
    addField("deliverySession");
  }
  if (
    blockers.has("missing_time_window") ||
    blockers.has("delivery_time_window_unparsed") ||
    blockers.has("ambiguous_delivery_time_window")
  ) {
    addField("timeWindowStart");
    addField("timeWindowEnd");
  }
  if (blockers.has("missing_coordinates") && !hasGeocodableAddress(order)) {
    addField("address1");
    addField("city");
    addField("province");
    addField("postalCode");
    addField("countryCode");
  }

  return fields;
}

function formatRepairCardTitle(fields: EditableMetadataField[]): string {
  const keys = new Set(fields.map((field) => field.key));
  const categories = [
    keys.has("deliveryDate") ? "deliveryDate" : null,
    keys.has("deliveryArea") ? "deliveryArea" : null,
    keys.has("serviceType") || keys.has("deliverySession")
      ? "routeScope"
      : null,
    keys.has("timeWindowStart") || keys.has("timeWindowEnd")
      ? "timeWindow"
      : null,
    keys.has("address1") ||
    keys.has("city") ||
    keys.has("province") ||
    keys.has("postalCode") ||
    keys.has("countryCode")
      ? "address"
      : null,
  ].filter(isPresent);

  if (categories.length > 1) return "Fix required order details";
  if (keys.has("deliveryDate")) return "Delivery date required";
  if (keys.has("deliveryArea")) return "Delivery area required";
  if (keys.has("serviceType") || keys.has("deliverySession")) {
    return "Route scope required";
  }
  if (keys.has("timeWindowStart") || keys.has("timeWindowEnd")) {
    return "Time window needs review";
  }
  if (categories[0] === "address") return "Destination address required";
  return "Fix required fields";
}

function formatAddressSummary(order: CanonicalOrderDto): {
  primary: string;
  secondary: string | null;
} {
  const street = [
    order.shippingAddress.address1,
    order.shippingAddress.address2,
  ]
    .filter(isPresent)
    .join(", ");
  const locality = [
    order.shippingAddress.city,
    order.shippingAddress.province,
    order.shippingAddress.postalCode,
    order.shippingAddress.countryCode,
  ]
    .filter(isPresent)
    .join(", ");
  return {
    primary: street || "Address required",
    secondary: locality || null,
  };
}

function formatCoordinateSummary(order: CanonicalOrderDto): {
  primary: string;
  secondary: string | null;
} {
  if (hasResolvedCoordinates(order)) {
    return {
      primary: `${order.coordinates.latitude?.toFixed(6)}, ${order.coordinates.longitude?.toFixed(6)}`,
      secondary: "Ready for the map",
    };
  }
  if (hasGeocodableAddress(order)) {
    return {
      primary: "Coordinates needed",
      secondary: "Use Bulk geocode from the order list.",
    };
  }
  return {
    primary: "Address required",
    secondary: "Enter enough destination detail before geocoding.",
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}

export function buildRouteDraftSelection(
  orders: CanonicalOrderDto[],
  requestedSelectedOrderIds: ReadonlySet<string>,
): {
  deliveryDate: string | null;
  orderIds: string[];
  routeScopeKey: string | null;
  warning: string | null;
} {
  const ordersById = new Map(orders.map((order) => [order.orderId, order]));
  const requestedOrders = [...requestedSelectedOrderIds]
    .map((orderId) => ordersById.get(orderId))
    .filter((order): order is CanonicalOrderDto => order !== undefined);
  const routeReadyOrders = requestedOrders.filter(isRoutePlanEligible);
  const anchor = routeReadyOrders.find(
    (order) => getRouteDraftScopeKey(order) !== null,
  );

  if (anchor === undefined || anchor.deliveryDate === null) {
    return {
      deliveryDate: null,
      orderIds: [],
      routeScopeKey: null,
      warning:
        requestedSelectedOrderIds.size === 0
          ? null
          : "Select route-ready orders with a delivery date and route scope.",
    };
  }

  const anchorScopeKey = getRouteDraftScopeKey(anchor);
  const selectedOrders = routeReadyOrders.filter(
    (order) =>
      order.deliveryDate === anchor.deliveryDate &&
      getRouteDraftScopeKey(order) === anchorScopeKey,
  );
  const warning =
    selectedOrders.length === requestedOrders.length
      ? null
      : "Only orders with the same delivery date and delivery session were added to the plan.";

  return {
    deliveryDate: anchor.deliveryDate,
    orderIds: selectedOrders.map((order) => order.orderId),
    routeScopeKey: anchorScopeKey,
    warning,
  };
}

export function getRouteDraftCreateBlocker(
  selectedOrders: CanonicalOrderDto[],
  routeDate: string,
): string | null {
  if (selectedOrders.length === 0) return null;
  if (selectedOrders.some((order) => order.deliveryDate !== routeDate)) {
    return "Route date must match the selected orders delivery date.";
  }
  const scopeKeys = new Set(
    selectedOrders.map((order) => getRouteDraftScopeKey(order)),
  );
  if (scopeKeys.size !== 1 || scopeKeys.has(null)) {
    return "Selected orders must share the same delivery date and delivery session.";
  }
  return null;
}

export function getRouteDraftScopeKey(order: CanonicalOrderDto): string | null {
  if (
    !isPresent(order.deliveryDate) ||
    !isPresent(order.serviceType) ||
    !isPresent(order.deliverySession)
  ) {
    return null;
  }
  return [
    order.deliveryDate,
    order.serviceType,
    order.deliverySession,
    order.timeWindowStart ?? "",
    order.timeWindowEnd ?? "",
  ].join("|");
}

function isRoutePlanEligible(order: CanonicalOrderDto): boolean {
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return false;
  }
  return (
    order.routeEligible === true ||
    (order.routeEligible !== false &&
      order.blockerReasons.length === 0 &&
      order.planningStatus === "UNPLANNED")
  );
}
