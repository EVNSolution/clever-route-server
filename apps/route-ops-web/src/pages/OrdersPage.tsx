import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, ReactElement } from "react";

import {
  bulkGeocodeOrders,
  createRoute,
  getBulkGeocodeJob,
  getOrderMetadataDiagnostics,
  getOrders,
  getWooOrderSyncRun,
  getSettings,
  patchOrderMetadata,
  requestWooOrderSync,
} from "../api";
import { Badge } from "../components/primitives";
import {
  getOrderDetailLabels,
  getOrderFieldLabels,
  getOrdersCopy,
  resolveLocale,
} from "../i18n";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import type { OrderMapMarkerState } from "../maps/geojson";
import {
  applyClientOrderFilters,
  buildOrderFetchQuery,
  buildOrderQuery,
  createDefaultOrderFilters,
  formatOrderWorksetUnavailableReasons,
  getOrderWorksetUnavailableReasons,
  isAddressReviewRequired,
  isDeliveryDateReviewRequired,
  isOrderWorksetEligible,
  storeSettingsToDepotPoint,
  summarizeOrderWorkset,
  summarizeSelection,
  type OrderFilterState,
  type OrderWorksetContext,
} from "../state";
import type {
  BootstrapPayload,
  BulkGeocodeJobDto,
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
  StoreSettingsDto,
  WooSyncRunDto,
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
  locale: string | null | undefined = settings?.locale,
): EditableMetadataField[] {
  const t = getOrdersCopy(locale);
  const orderFieldLabels = getOrderFieldLabels(locale);
  const config = normalizeRouteScopeConfig(settings?.routeScopeConfig);
  const serviceTypeChoices = activeRouteScopeValues(config.serviceTypes);
  const deliverySessionChoices = activeRouteScopeValues(
    config.deliverySessions,
  );
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
      helpText: t.editableHelp.deliveryDate,
      key: "deliveryDate",
      label: orderFieldLabels.deliveryDate,
    },
    {
      choices: serviceTypeChoices,
      helpText: t.editableHelp.serviceType(routeScopeValueSummary(config.serviceTypes), eveningService?.example ?? "EVENING_DELIVERY for a 5PM-9PM delivery route."),
      key: "serviceType",
      label: orderFieldLabels.serviceType,
      placeholder: eveningService?.value ?? "EVENING_DELIVERY",
    },
    {
      choices: deliverySessionChoices,
      helpText: t.editableHelp.deliverySession(routeScopeValueSummary(config.deliverySessions), eveningSession?.example ?? "EVENING for a 5PM-9PM route."),
      key: "deliverySession",
      label: orderFieldLabels.deliverySession,
      placeholder: eveningSession?.value ?? "EVENING",
    },
    {
      helpText: t.editableHelp.timeWindow(config.timeWindow.helpText, config.timeWindow.startExample),
      key: "timeWindowStart",
      label: orderFieldLabels.timeWindowStart,
      placeholder: config.timeWindow.startExample,
    },
    {
      helpText: t.editableHelp.timeWindow(config.timeWindow.helpText, config.timeWindow.endExample),
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
  const initialCopy = getOrdersCopy(bootstrap.locale);
  const [routeDate, setRouteDate] = useState(today());
  const [routeName, setRouteName] = useState(() => initialCopy.defaultRouteName(today()));
  const [autoAppliedDeliveryDateFilter, setAutoAppliedDeliveryDateFilter] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [refreshingOrders, setRefreshingOrders] = useState(false);
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
  const [wooSyncStatus, setWooSyncStatus] = useState<string | null>(null);
  const [wooSyncing, setWooSyncing] = useState(false);
  const locale = resolveLocale(settings?.locale ?? bootstrap.locale);
  const t = getOrdersCopy(locale);
  const pendingScrollRestoreRef = useRef<{
    x: number;
    y: number;
  } | null>(null);

  const query = useMemo(() => buildOrderQuery(filters), [filters]);
  const fetchQuery = useMemo(() => buildOrderFetchQuery(filters), [filters]);
  const visibleOrders = useMemo(
    () => applyClientOrderFilters(orders, filters),
    [orders, filters],
  );
  const routeDraft = useMemo(
    () => buildRouteDraftSelection(orders, selected, locale),
    [locale, orders, selected],
  );
  const activeMapDeliveryDate = useMemo(
    () => resolveRouteMapDeliveryDate(filters.deliveryDate, routeDraft.deliveryDate),
    [filters.deliveryDate, routeDraft.deliveryDate],
  );
  const worksetContext = useMemo<OrderWorksetContext>(
    () => ({
      routeDate: activeMapDeliveryDate,
      routeScopeKey: routeDraft.routeScopeKey,
      scope: filters.scope,
    }),
    [activeMapDeliveryDate, filters.scope, routeDraft.routeScopeKey],
  );
  const selection = useMemo(
    () => summarizeSelection(orders, selected),
    [orders, selected],
  );
  const selectedRoutePlanOrders = useMemo(
    () => orderSelectedOrdersByDraft(selection.readySelected, selected),
    [selected, selection.readySelected],
  );
  const depotPoint = useMemo(
    () => storeSettingsToDepotPoint(settings, locale),
    [locale, settings],
  );
  const mapOrders = useMemo(
    () => buildRouteMapOrders(orders, visibleOrders, activeMapDeliveryDate),
    [activeMapDeliveryDate, orders, visibleOrders],
  );
  const orderMarkerStates = useMemo(
    () =>
      buildOrderMapMarkerStates({
        filters,
        orders: mapOrders,
        selectedOrderIds: selected,
        worksetContext,
      }),
    [filters, mapOrders, selected, worksetContext],
  );

  const refreshOrders = async (): Promise<void> => {
    if (ordersLoaded) {
      pendingScrollRestoreRef.current = captureWindowScroll();
      setRefreshingOrders(true);
    } else {
      setLoading(true);
    }
    try {
      const payload = await getOrders(fetchQuery);
      setOrders(payload.orders);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setOrdersLoaded(true);
      setLoading(false);
      setRefreshingOrders(false);
    }
  };

  useEffect(() => {
    void refreshOrders();
  }, [fetchQuery]);

  useLayoutEffect(() => {
    const snapshot = pendingScrollRestoreRef.current;
    if (snapshot === null) return;
    pendingScrollRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      window.scrollTo(snapshot.x, snapshot.y);
    });
  }, [orders, loading, refreshingOrders]);

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
          t.createRouteReadyOnly,
        );
      }
      const routeDraftBlocker = getRouteDraftCreateBlocker(
        selectedRoutePlanOrders,
        routeDate || today(),
        locale,
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
      setBulkGeocodeStatus(formatBulkGeocodeStatus(job, locale));
      for (
        let attempt = 0;
        attempt < 60 && !isBulkGeocodeTerminal(job);
        attempt += 1
      ) {
        await sleep(1_000);
        job = (await getBulkGeocodeJob(job.jobId)).geocode;
        setBulkGeocodeStatus(formatBulkGeocodeStatus(job, locale));
      }
      await refreshOrders();
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setBulkGeocoding(false);
    }
  };

  const syncWooOrders = async (): Promise<void> => {
    setWooSyncing(true);
    setWooSyncStatus(null);
    try {
      const accepted = await requestWooOrderSync({
        csrfToken: bootstrap.csrfToken,
        pageSize: 100,
      });
      let syncRun = accepted.syncRun;
      setWooSyncStatus(formatWooSyncStatus(syncRun, locale));
      for (
        let attempt = 0;
        attempt < 90 && !isWooSyncTerminal(syncRun);
        attempt += 1
      ) {
        await sleep(1_000);
        const payload = await getWooOrderSyncRun(syncRun.syncRunId);
        if (payload.syncRun === null) break;
        syncRun = payload.syncRun;
        setWooSyncStatus(formatWooSyncStatus(syncRun, locale));
      }
      await refreshOrders();
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setWooSyncing(false);
    }
  };

  const applyPlanDateLock = (deliveryDate: string): void => {
    setRouteDate(deliveryDate);
    setRouteName((current) =>
      current.trim() === "" || /^(Route|경로) \d{4}-\d{2}-\d{2}$/u.test(current)
        ? t.defaultRouteName(deliveryDate)
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
    const draft = buildRouteDraftSelection(orders, requestedSelected, locale);
    setSelected(new Set(draft.orderIds));
    if (draft.deliveryDate === null) {
      if (requestedSelected.size === 0) clearPlan();
      else
        setError(
          draft.warning ?? t.selectRouteReady,
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
      mapOrders.find((candidate) => candidate.orderId === orderId) ??
      visibleOrders.find((candidate) => candidate.orderId === orderId) ??
      orders.find((candidate) => candidate.orderId === orderId);
    if (order === undefined) return;
    const reasons = formatOrderWorksetUnavailableReasons(
      getOrderWorksetUnavailableReasons(order, worksetContext),
      locale,
    );
    const isSubfilterBlocked = isOrderBlockedByRouteSubfilters(order, filters);
    if (!isOrderWorksetEligible(order, worksetContext) || isSubfilterBlocked) {
      const reasonLabels = isSubfilterBlocked
        ? formatOrderWorksetUnavailableReasons(
            [{ code: "different_route_scope", label: "" }],
            locale,
          ).map((reason) => reason.label)
        : reasons.map((reason) => reason.label);
      setError(
        t.orderUnavailable(
          reasonLabels.join(", ") ||
            t.routeConstraintFallback,
        ),
      );
      return;
    }
    const next = new Set(selected);
    next.add(orderId);
    applyPlanSelection(next);
  };

  const reorderPlanOrder = (draggedOrderId: string, targetOrderId: string): void => {
    const nextOrderIds = moveSelectedOrderBefore([...selected], draggedOrderId, targetOrderId);
    applyPlanSelection(new Set(nextOrderIds));
  };

  return (
    <TabLayout
      title={t.title}
      primary={
        <RouteOpsMap
          bootstrap={bootstrap}
          depot={depotPoint}
          onOrderSelect={addOrderToPlan}
          orderMarkerStates={orderMarkerStates}
          orders={mapOrders}
          subtitle={t.mapSubtitle}
          title={t.mapTitle}
        />
      }
      secondary={
          <RoutePlanPanel
          invalidSelectionCount={selected.size - selectedRoutePlanOrders.length}
          onClear={clearPlan}
          onCreate={() => void create()}
          onReorder={reorderPlanOrder}
          routeDate={routeDate}
          routeName={routeName}
          selectedOrders={selectedRoutePlanOrders}
          setRouteDate={setRouteDate}
          setRouteName={setRouteName}
          locale={locale}
          totalSelected={selected.size}
        />
      }
      lower={
        <>
          <div className="order-mode-tabs" aria-label={t.modeLabel}>
            <button
              className={filters.scope === "planning" ? "active" : ""}
              onClick={() => setFilters({ ...filters, scope: "planning" })}
              type="button"
            >
              {t.planning}
            </button>
            <button
              className={filters.scope === "history" ? "active" : ""}
              onClick={() => setFilters({ ...filters, scope: "history" })}
              type="button"
            >
              {t.history}
            </button>
          </div>
          <div className="route-tabs" aria-label={t.statusTabsLabel}>
            <button
              className={filters.tab === "all" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  tab: "all",
                })
              }
              type="button"
            >
              {t.all}
            </button>
            <button
              className={filters.tab === "unplanned" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  tab: "unplanned",
                })
              }
              type="button"
            >
              {t.unplanned}
            </button>
            <button
              className={filters.tab === "planned" ? "active" : ""}
              onClick={() =>
                setFilters({ ...filters, tab: "planned" })
              }
              type="button"
            >
              {t.planned}
            </button>
            <button
              className={filters.tab === "needs_review" ? "active" : ""}
              onClick={() =>
                setFilters({
                  ...filters,
                  deliveryStatus: "",
                  tab: "needs_review",
                })
              }
              type="button"
            >
              {t.needsReview}
            </button>
          </div>
          <FilterBar
            filters={filters}
            locale={locale}
            onChange={setFilters}
            settings={settings}
          />
          <OrderTable
            bulkGeocodeStatus={bulkGeocodeStatus}
            bulkGeocoding={bulkGeocoding}
            diagnosticsByOrder={diagnosticsByOrder}
            expandedOrderIds={expandedOrderIds}
            loading={loading}
            onBulkGeocode={() => void bulkGeocodeCurrentView()}
            onCloseDetail={closeOrderDetail}
            onSaveMetadata={saveOrderMetadata}
            onWooSync={() => void syncWooOrders()}
            onToggleDetail={toggleOrderDetail}
            onTogglePlanOrder={togglePlanOrder}
            orders={visibleOrders}
            locale={locale}
            refreshing={refreshingOrders}
            selected={selected}
            setSelected={applyPlanSelection}
            settings={settings}
            worksetContext={worksetContext}
            wooSyncing={wooSyncing}
            wooSyncStatus={wooSyncStatus}
          />
        </>
      }
    />
  );
}

function RoutePlanPanel(input: {
  invalidSelectionCount: number;
  locale?: string | null;
  onClear(): void;
  onCreate(): void;
  onReorder(draggedOrderId: string, targetOrderId: string): void;
  routeDate: string;
  routeName: string;
  selectedOrders: CanonicalOrderDto[];
  setRouteDate(value: string): void;
  setRouteName(value: string): void;
  totalSelected: number;
}): ReactElement {
  const t = getOrdersCopy(input.locale);
  const canCreate =
    input.selectedOrders.length > 0 && input.invalidSelectionCount === 0;
  return (
    <div
      className="panel side-panel route-plan-panel"
      aria-label={t.addPlanPanelLabel}
    >
      <div className="panel-heading compact-heading route-plan-header">
        <div>
          <span className="eyebrow">{t.newRoute}</span>
          <h2>{t.addPlan}</h2>
        </div>
        <Badge>{input.selectedOrders.length} {t.orders}</Badge>
      </div>
      <p className="muted">{t.planInstructions}</p>
      <label>
        {t.routeDate}
        <input
          type="date"
          value={input.routeDate}
          onChange={(event) => input.setRouteDate(event.target.value)}
        />
      </label>
      <label>
        {t.routeName}
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
          {t.createRoute}
        </button>
        <button
          disabled={input.totalSelected === 0}
          onClick={input.onClear}
          type="button"
        >
          {t.clearPlan}
        </button>
      </div>
      <div className="route-plan-draft" aria-label={t.addPlanOrdersLabel}>
        {input.selectedOrders.length === 0 ? (
          <p className="route-plan-empty">{t.planEmpty}</p>
        ) : (
          input.selectedOrders.map((order, index) => (
            <div
              className="route-plan-item route-plan-item--draggable"
              draggable
              key={order.orderId}
              onDragOver={(event) => event.preventDefault()}
              onDragStart={(event) => writeRoutePlanDragData(event, order.orderId)}
              onDrop={(event) => {
                const draggedOrderId = readRoutePlanDragData(event);
                if (draggedOrderId !== null) input.onReorder(draggedOrderId, order.orderId);
              }}
            >
              <strong>
                {index + 1}. {order.orderName}
              </strong>
              <small>
                {order.recipientName ?? t.recipientFallback} ·{" "}
                {order.deliveryArea ?? t.areaFallback} · {order.deliveryDate ?? t.dateFallback}
              </small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function writeRoutePlanDragData(event: DragEvent<HTMLDivElement>, orderId: string): void {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", orderId);
  event.dataTransfer.setData("application/x-clever-route-order-id", orderId);
}

function readRoutePlanDragData(event: DragEvent<HTMLDivElement>): string | null {
  event.preventDefault();
  const orderId =
    event.dataTransfer.getData("application/x-clever-route-order-id") ||
    event.dataTransfer.getData("text/plain");
  const trimmed = orderId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function FilterBar({
  filters,
  locale,
  onChange,
  settings,
}: {
  filters: OrderFilterState;
  locale?: string | null;
  onChange(filters: OrderFilterState): void;
  settings?: StoreSettingsDto | null;
}): ReactElement {
  const t = getOrdersCopy(locale);
  const config = normalizeRouteScopeConfig(settings?.routeScopeConfig);
  const serviceTypes = activeRouteScopeValues(config.serviceTypes);
  const deliverySessions = activeRouteScopeValues(config.deliverySessions);
  const resetFilters = (): void =>
    onChange({
      ...createDefaultOrderFilters(),
      scope: filters.scope,
      tab: filters.tab,
    });
  return (
    <article className="panel filter-panel">
      <div className="filter-panel-header">
        <div>
          <span className="eyebrow">{t.filtersEyebrow}</span>
          <h3>{t.filtersTitle}</h3>
        </div>
        <button onClick={resetFilters} type="button">
          {t.clearFilters}
        </button>
      </div>
      <label className="filter-field filter-field--date">
        {t.deliveryDate}
        <input
          type="date"
          value={filters.deliveryDate}
          onChange={(event) =>
            onChange({ ...filters, deliveryDate: event.target.value })
          }
        />
      </label>
      <label className="filter-field filter-field--area">
        {t.areaRegion}
        <input
          placeholder={t.areaPlaceholder}
          value={filters.deliveryArea}
          onChange={(event) =>
            onChange({ ...filters, deliveryArea: event.target.value })
          }
        />
      </label>
      <label className="filter-field filter-field--status">
        {t.deliveryStatus}
        <select
          value={filters.deliveryStatus}
          onChange={(event) =>
            onChange({ ...filters, deliveryStatus: event.target.value })
          }
        >
          <option value="">{t.allOption}</option>
          <option value="ready">{t.ready}</option>
          <option value="needs_review">{t.needsReview}</option>
          <option value="completed">{t.completed}</option>
        </select>
      </label>
      <label className="filter-field filter-field--service">
        {t.serviceType}
        <select
          value={filters.serviceType}
          onChange={(event) =>
            onChange({ ...filters, serviceType: event.target.value })
          }
        >
          <option value="">{t.allOption}</option>
          {serviceTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {formatFilterOptionLabel(option.label, locale)}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field filter-field--session">
        {t.deliverySession}
        <select
          value={filters.deliverySession}
          onChange={(event) =>
            onChange({ ...filters, deliverySession: event.target.value })
          }
        >
          <option value="">{t.allOption}</option>
          {deliverySessions.map((option) => (
            <option key={option.value} value={option.value}>
              {formatFilterOptionLabel(option.label, locale)}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field filter-field--search">
        {t.search}
        <input
          placeholder={t.searchPlaceholder}
          value={filters.search}
          onChange={(event) =>
            onChange({ ...filters, search: event.target.value })
          }
        />
      </label>
    </article>
  );
}

function formatFilterOptionLabel(value: string, locale: string | null | undefined = 'en-CA'): string {
  const normalized = value.trim();
  const labels = resolveLocale(locale) === "ko-KR"
    ? new Map<string, string>([
        ["day", "주간"],
        ["delivery", "배송"],
        ["evening", "저녁"],
        ["evening delivery", "저녁 배송"],
        ["pickup", "픽업"],
      ])
    : new Map<string, string>([
        ["day", "Day"],
        ["delivery", "Delivery"],
        ["evening", "Evening"],
        ["evening delivery", "Evening Delivery"],
        ["pickup", "Pickup"],
      ]);
  const builtInLabel = labels.get(normalized.toLowerCase());
  return builtInLabel ?? normalized;
}

function formatBulkGeocodeStatus(job: BulkGeocodeJobDto, locale: string | null | undefined = 'en-CA'): string {
  const t = getOrdersCopy(locale).bulkStatus;
  const status = job.status;
  const counts = job.counts;
  const countEntries: Array<[string, number | undefined]> = [
    [t.matched, counts.matched],
    [t.attempted, counts.attempted],
    [t.resolved, counts.succeeded],
    [t.failed, counts.failed],
    [t.noAddress, counts.noAddress],
    [t.skippedByPolicy, counts.skippedByPolicy],
    [t.alreadyHadCoordinates, counts.skippedAlreadyGeocoded],
  ];
  const parts = countEntries
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([label, value]) => `${value} ${label}`);
  const suffix = parts.length === 0 ? "" : `: ${parts.join(", ")}`;
  const policy =
    job.policyLimit?.reached === true
      ? t.policyReached(job.policyLimit.attemptedLimit ?? "configured")
      : "";
  const statusLabel = resolveLocale(locale) === "ko-KR"
    ? ({ accepted: "접수됨", completed: "완료됨", failed: "실패", running: "진행 중" } as const)[status]
    : humanizeToken(status);
  return `${getOrdersCopy(locale).bulkGeocode} ${statusLabel}${suffix}.${policy}`;
}

function isBulkGeocodeTerminal(job: BulkGeocodeJobDto): boolean {
  return job.status === "completed" || job.status === "failed";
}

function formatWooSyncStatus(run: WooSyncRunDto, locale: string | null | undefined = 'en-CA'): string {
  const t = getOrdersCopy(locale).wooSyncStatus;
  const statusLabel =
    run.status === "QUEUED"
      ? t.queued
      : run.status === "RUNNING"
        ? t.running
        : run.status === "SUCCEEDED"
          ? t.succeeded
          : t.failed;
  if (run.result === null) {
    return `${getOrdersCopy(locale).wooSync}: ${statusLabel}`;
  }
  const sync = run.result.sync;
  return t.summary(statusLabel, {
    created: sync.created,
    needsReview: sync.needsReview,
    readyToPlan: sync.readyToPlan,
    received: sync.received,
    updated: sync.updated,
  });
}

function isWooSyncTerminal(run: WooSyncRunDto): boolean {
  return run.status === "FAILED" || run.status === "SUCCEEDED";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function captureWindowScroll(): { x: number; y: number } {
  return { x: window.scrollX, y: window.scrollY };
}

export function OrderTable(input: {
  bulkGeocodeStatus?: string | null;
  bulkGeocoding?: boolean;
  detailModes?: Record<string, "review" | "edit">;
  diagnosticsByOrder: Record<string, DeliveryMetadataDiagnosticsDto | null>;
  expandedOrderIds?: ReadonlySet<string>;
  loading: boolean;
  locale?: string | null;
  onBulkGeocode?(): void;
  onCloseDetail?(orderId: string): void;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  onWooSync?(): void;
  orders: CanonicalOrderDto[];
  refreshing?: boolean;
  selected: Set<string>;
  setSelected(selected: Set<string>): void;
  settings?: StoreSettingsDto | null;
  worksetContext?: OrderWorksetContext;
  wooSyncing?: boolean;
  wooSyncStatus?: string | null;
}): ReactElement {
  const t = getOrdersCopy(input.locale);
  const worksetContext = input.worksetContext ?? {};
  const worksetSummary = summarizeOrderWorkset(
    input.orders,
    input.selected,
    worksetContext,
    input.locale,
  );
  const selectableOrderIds = worksetSummary.selectableOrderIds;
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

  if (input.loading && input.orders.length === 0)
    return (
      <article className="panel">
        <p>{t.loadingOrders}</p>
      </article>
    );
  return (
    <article className="panel orders-table-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{t.tableEyebrow}</span>
          <h2>{t.tableTitle}</h2>
        </div>
        <div className="orders-heading-actions">
          <Badge>{input.orders.length} {t.orders}</Badge>
          <span className="orders-selection-summary">
            {t.selectedSummary(visibleSelectedCount, worksetSummary.selectableCount, worksetSummary.unavailableCount)}
          </span>
          {input.loading || input.refreshing === true ? (
            <span className="orders-refresh-status" role="status">
              {t.updating}
            </span>
          ) : null}
          <button
            disabled={input.wooSyncing === true}
            onClick={() => input.onWooSync?.()}
            type="button"
          >
            {input.wooSyncing === true ? t.wooSyncing : t.wooSync}
          </button>
          <button
            disabled={input.bulkGeocoding === true}
            onClick={() => input.onBulkGeocode?.()}
            type="button"
          >
            {input.bulkGeocoding === true ? t.bulkGeocoding : t.bulkGeocode}
          </button>
        </div>
      </div>
      {worksetSummary.reasonLabels.length === 0 ? null : (
        <p className="orders-workset-note">
          {t.unavailablePrefix} {worksetSummary.reasonLabels.join(" · ")}
        </p>
      )}
      {input.bulkGeocodeStatus === undefined ||
      input.bulkGeocodeStatus === null ? null : (
        <p className="orders-bulk-status" role="status">
          {input.bulkGeocodeStatus}
        </p>
      )}
      {input.wooSyncStatus === undefined || input.wooSyncStatus === null ? null : (
        <p className="orders-bulk-status" role="status">
          {input.wooSyncStatus}
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
                aria-label={t.selectAllEligible}
                  checked={allFilteredSelected}
                  disabled={selectableOrderIds.length === 0}
                  onChange={(event) =>
                    toggleFilteredSelection(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>{t.columns.select}</span>
              </th>
              <th scope="col">{t.columns.order}</th>
              <th scope="col">{t.columns.customer}</th>
              <th scope="col">{t.columns.method}</th>
              <th scope="col">{t.columns.day}</th>
              <th scope="col">{t.columns.area}</th>
              <th scope="col">{t.columns.route}</th>
              <th scope="col">{t.columns.status}</th>
              <th scope="col">{t.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {input.orders.length === 0 ? (
              <tr className="orders-empty-row">
                <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>
                  {t.noOrders}
                </td>
              </tr>
            ) : (
              input.orders.map((order) => (
                <OrderTableRow
                  detailMode={input.detailModes?.[order.orderId] ?? "review"}
                  diagnostics={input.diagnosticsByOrder[order.orderId]}
                  expanded={input.expandedOrderIds?.has(order.orderId) ?? false}
                  key={order.orderId}
                  locale={input.locale}
                  onCloseDetail={input.onCloseDetail}
                  onSaveMetadata={input.onSaveMetadata}
                  onToggleDetail={input.onToggleDetail}
                  onTogglePlanOrder={input.onTogglePlanOrder}
                  order={order}
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
  locale?: string | null;
  onCloseDetail?(orderId: string): void;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  order: CanonicalOrderDto;
  selectedOrders: Set<string>;
  setSelected(selected: Set<string>): void;
  settings?: StoreSettingsDto | null;
  worksetContext?: OrderWorksetContext;
}): ReactElement {
  const { order } = input;
  const t = getOrdersCopy(input.locale);
  const selected = input.selectedOrders.has(order.orderId);
  const unavailableReasons = formatOrderWorksetUnavailableReasons(
    getOrderWorksetUnavailableReasons(
      order,
      input.worksetContext,
    ),
    input.locale,
  );
  const canPlan =
    unavailableReasons.length === 0 &&
    isOrderWorksetEligible(order, input.worksetContext);
  const day = formatDeliveryDayLabel(order, input.locale);
  const method = formatMethodStatusLabel(order, input.locale);
  const payment = formatPaymentStatusLabel(order, input.locale);
  const receivedLabel = formatOrderReceivedLabelParts(order, input.locale);
  const status = formatOperationalStatus(order, input.locale);
  const orderLabel = getOrderAccessibleLabel(order);
  const planActionLabel = t.planOrderAction(
    selected ? "Remove" : "Add",
    orderLabel,
  );
  const detailPanelId = `order-detail-${sanitizeId(order.orderId)}`;
  const detailLabel = t.detailToggle(input.expanded, orderLabel);
  const statusTooltipId = status.meaning === null
    ? undefined
    : `order-status-${sanitizeId(order.orderId)}-help`;
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
            aria-label={t.selectOrder(orderLabel)}
            checked={selected}
            disabled={!canPlan && !selected}
            onChange={() => input.onTogglePlanOrder(order.orderId)}
            type="checkbox"
          />
        </td>
        <td className="orders-order-cell">
          <strong className="order-primary">{order.orderName}</strong>
          <small className="order-subtle order-received-label">
            <span>{receivedLabel.created}</span>
            {receivedLabel.updated === null ? null : (
              <span>{receivedLabel.updated}</span>
            )}
          </small>
        </td>
        <td className="orders-customer-cell">
          <strong className="order-primary">
            {order.recipientName ?? "—"}
          </strong>
          {order.phone === null ? null : (
            <small className="order-subtle">{order.phone}</small>
          )}
        </td>
        <td className="orders-method-cell">
          <span
            aria-label={`${t.columns.method} ${method.label}; ${t.payment} ${payment.label}`}
            className="order-pill-stack"
          >
            <span className={`order-pill ${method.toneClass}`}>
              {method.label}
            </span>
            <span className={`order-pill ${payment.toneClass}`}>
              {payment.label}
            </span>
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
          <span className="order-compact-value">{formatRouteLabel(order, input.locale)}</span>
        </td>
        <td className="orders-status-cell">
          <span className="order-status-tooltip-wrap">
            <span
              aria-describedby={statusTooltipId}
              aria-label={
                status.meaning === null
                  ? status.label
                  : `${status.label}. ${status.meaning}`
              }
              className={`order-pill ${status.toneClass}`}
              tabIndex={status.meaning === null ? undefined : 0}
              title={status.meaning ?? undefined}
            >
              {status.label}
            </span>
            {status.meaning === null ? null : (
              <span
                className="order-status-tooltip"
                id={statusTooltipId}
                role="tooltip"
              >
                {status.meaning}
              </span>
            )}
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
              {selected ? t.remove : t.add}
            </button>
            <button
              aria-controls={detailPanelId}
              aria-expanded={input.expanded}
              aria-label={detailLabel}
              onClick={() => input.onToggleDetail?.(order.orderId)}
              type="button"
            >
              {t.detail}
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
                input.onSaveMetadata === undefined
                  ? undefined
                  : (patch: OrderMetadataPatch) =>
                      input.onSaveMetadata!(order.orderId, patch)
              }
              order={order}
              locale={input.locale}
              settings={input.settings}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function formatMethodLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string {
  if (isPresent(order.serviceType)) return humanizeToken(order.serviceType, locale);
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession, locale);
  return "—";
}

export function formatMethodStatusLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  label: string;
  toneClass: string;
} {
  const label = formatMethodLabel(order, locale);
  return {
    label,
    toneClass: label === "—" ? "order-pill--review" : "order-pill--neutral",
  };
}

export function formatPaymentStatusLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  detail: string | null;
  label: string;
  toneClass: string;
} {
  const t = getOrdersCopy(locale);
  const detail = formatPaymentMethodEvidence(order);
  switch (order.normalizedPaymentStatus ?? null) {
    case "PAID_CONFIRMED":
      return {
        detail,
        label: t.paymentStatusLabels.PAID_CONFIRMED,
        toneClass: "order-pill--ready",
      };
    case "CASH_COLLECT_REQUIRED":
      return {
        detail,
        label: t.paymentStatusLabels.CASH_COLLECT_REQUIRED,
        toneClass: "order-pill--review",
      };
    case "TRANSFER_CHECK_PENDING":
      return {
        detail,
        label: t.paymentStatusLabels.TRANSFER_CHECK_PENDING,
        toneClass: "order-pill--review",
      };
    case "ONLINE_PAYMENT_PENDING_OR_FAILED":
      return {
        detail,
        label: t.paymentStatusLabels.ONLINE_PAYMENT_PENDING_OR_FAILED,
        toneClass: "order-pill--review",
      };
    case "NOT_DELIVERABLE_OR_EXCEPTION":
      return {
        detail,
        label: t.paymentStatusLabels.NOT_DELIVERABLE_OR_EXCEPTION,
        toneClass: "order-pill--review",
      };
    case "UNKNOWN_REVIEW":
      return {
        detail,
        label: t.paymentStatusLabels.UNKNOWN_REVIEW,
        toneClass: "order-pill--review",
      };
    case null:
      return {
        detail,
        label: t.paymentUnavailable,
        toneClass: "order-pill--neutral",
      };
  }
}

export function formatDeliveryDayLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  detail: string | null;
  label: string;
  toneClass: string;
} {
  const t = getOrdersCopy(locale);
  if (order.deliveryDate === null) {
    return {
      detail: formatTimeWindow(order, locale),
      label: t.review,
      toneClass: "order-pill--review",
    };
  }
  const weekday = weekdayCode(order.deliveryDate) ?? order.deliveryDate;
  const timeWindow = formatTimeWindow(order, locale);
  return {
    detail:
      [order.deliveryDate, timeWindow].filter(isPresent).join(" · ") || null,
    label: compactDayLabel(weekday, order.timeWindowStart),
    toneClass: "order-pill--day",
  };
}

export function formatOperationalStatus(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  detail: string | null;
  label: string;
  meaning: string | null;
  toneClass: string;
} {
  const t = getOrdersCopy(locale);
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return {
      detail: order.routePlanName ?? humanizeToken(order.planningStatus, locale),
      label: t.statusLabels.planned,
      meaning: null,
      toneClass: "order-pill--neutral",
    };
  }
  if (isAddressReviewRequired(order)) {
    return {
      detail: t.statusDetails.verifyAddress,
      label: t.statusLabels.addressReview,
      meaning: t.statusMeanings.addressReview,
      toneClass: "order-pill--review",
    };
  }
  if (isDeliveryDateReviewRequired(order)) {
    return {
      detail: t.statusDetails.verifyDeliveryDate,
      label: t.statusLabels.deliveryDateReview,
      meaning: t.statusMeanings.deliveryDateReview,
      toneClass: "order-pill--review",
    };
  }
  const blockerLabel = mostSpecificBlockerLabel(order, locale);
  if (blockerLabel !== null) {
    return {
      detail: geocodeDetail(order, locale),
      label: blockerLabel,
      meaning: statusMeaningForOrder(order, locale),
      toneClass: "order-pill--review",
    };
  }
  if (order.deliveryDate === null) {
    return {
      detail: null,
      label: t.statusLabels.missingDeliveryDate,
      meaning: t.statusMeanings.missingDeliveryDate,
      toneClass: "order-pill--review",
    };
  }
  if (!hasResolvedCoordinates(order)) {
    const canGeocode = hasGeocodableAddress(order);
    return {
      detail: canGeocode ? t.statusDetails.useBulkGeocode : t.statusDetails.enterAddressOrCoordinates,
      label: canGeocode ? t.statusLabels.needCoordinates : t.statusLabels.missingAddress,
      meaning: canGeocode
        ? t.statusMeanings.missingCoordinates
        : t.statusMeanings.missingAddress,
      toneClass: "order-pill--review",
    };
  }
  if (order.metadataResolved !== true)
    return {
      detail: geocodeDetail(order, locale),
      label: t.statusLabels.metadataReview,
      meaning: t.statusMeanings.metadataReview,
      toneClass: "order-pill--review",
    };
  if (order.routeEligible === true) {
    return {
      detail: geocodeDetail(order, locale),
      label: t.statusLabels.ready,
      meaning: null,
      toneClass: "order-pill--ready",
    };
  }
  return {
    detail: t.statusDetails.reviewRouteConstraints,
    label: t.statusLabels.notRouteEligible,
    meaning: t.statusMeanings.notRouteEligible,
    toneClass: "order-pill--neutral",
  };
}

function statusMeaningForOrder(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string | null {
  const t = getOrdersCopy(locale).statusMeanings;
  const blockers = new Set(order.blockerReasons);
  if (blockers.has("missing_delivery_date") || order.deliveryDate === null)
    return t.missingDeliveryDate;
  if (blockers.has("missing_delivery_area")) return t.metadataReview;
  if (blockers.has("missing_route_scope")) return t.missingDeliveryRouteScope;
  if (
    [
      "delivery_day_unparsed",
      "ambiguous_delivery_day",
      "delivery_date_weekday_mismatch",
      "delivery_date_weekday_unverified",
    ].some((reason) => blockers.has(reason))
  )
    return t.deliveryDayUnclear;
  if (blockers.has("missing_time_window")) return t.deliveryTimeUnclear;
  if (
    ["delivery_time_window_unparsed", "ambiguous_delivery_time_window"].some(
      (reason) => blockers.has(reason),
    )
  )
    return t.deliveryTimeUnclear;
  if (blockers.has("missing_coordinates"))
    return hasGeocodableAddress(order) ? t.missingCoordinates : t.missingAddress;
  return t.metadataReview;
}

export function formatOrderReceivedLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string {
  const label = formatOrderReceivedLabelParts(order, locale);
  return label.updated === null
    ? label.created
    : `${label.created}\n${label.updated}`;
}

export function formatOrderReceivedLabelParts(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): { created: string; updated: string | null } {
  const created = formatSourceDateLabel(order.sourceCreatedDate, locale);
  if (created === null) return { created: "—", updated: null };
  const updated =
    isPresent(order.sourceUpdatedDate) &&
    order.sourceUpdatedDate !== order.sourceCreatedDate
      ? formatSourceDateLabel(order.sourceUpdatedDate, locale)
      : null;
  if (updated === null) return { created, updated: null };
  const marker = resolveLocale(locale) === "ko-KR" ? "수정" : "updated";
  return { created, updated: `${marker} ${updated}` };
}

function getOrderAccessibleLabel(order: CanonicalOrderDto): string {
  return (
    [order.orderName, order.sourceOrderNumber ?? order.sourceOrderId]
      .filter(isPresent)
      .join(" ") || order.orderId
  );
}

function formatSourceDateLabel(
  dateString: string | null | undefined,
  locale: string | null | undefined,
): string | null {
  const normalized = normalizeYmd(dateString);
  if (normalized === null) return null;
  const weekday = weekdayCode(normalized, locale);
  return weekday === null ? normalized : `${normalized} ${weekday}`;
}

function formatAreaLabel(order: CanonicalOrderDto): string {
  return (
    order.deliveryArea ??
    order.shippingAddress.city ??
    order.shippingAddress.province ??
    "—"
  );
}

function formatPaymentMethodEvidence(order: CanonicalOrderDto): string | null {
  const methodTitle = order.paymentMethodTitle?.trim() ?? "";
  const methodId = order.paymentMethodId?.trim() ?? "";
  const family = order.paymentMethodFamily?.trim() ?? "";
  const method =
    methodTitle.length > 0 &&
    methodId.length > 0 &&
    methodTitle.toLowerCase() !== methodId.toLowerCase()
      ? `${methodTitle} · ${methodId}`
      : methodTitle || methodId || null;
  return [method, family || null].filter(isPresent).join(" · ") || null;
}

function formatRouteLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string {
  if (order.routePlanName !== null) return order.routePlanName;
  if (order.planningStatus === "UNPLANNED") return getOrdersCopy(locale).unplanned;
  return humanizeToken(order.planningStatus, locale);
}

export function getRouteRepairPrompt(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  canGeocode: boolean;
  routeDetail: string;
  statusDetail: string | null;
  statusLabel: string;
} {
  const t = getOrdersCopy(locale);
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.alreadyPlanned,
      statusDetail: order.routePlanName ?? humanizeToken(order.planningStatus, locale),
      statusLabel: t.statusLabels.planned,
    };
  }
  if (isRoutePlanEligible(order)) {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.routeEligible,
      statusDetail: null,
      statusLabel: t.statusLabels.ready,
    };
  }
  if (isAddressReviewRequired(order)) {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.addressReview,
      statusDetail: t.statusDetails.verifyAddress,
      statusLabel: t.statusLabels.addressReview,
    };
  }
  if (isDeliveryDateReviewRequired(order)) {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.deliveryDateReview,
      statusDetail: t.statusDetails.verifyDeliveryDate,
      statusLabel: t.statusLabels.deliveryDateReview,
    };
  }
  if (order.deliveryDate === null) {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.missingDeliveryDate,
      statusDetail: t.statusDetails.enterDeliveryDate,
      statusLabel: t.statusLabels.missingDeliveryDate,
    };
  }
  if (order.metadataResolved !== true) {
    return {
      canGeocode: false,
      routeDetail: t.statusLabels.needsMetadata,
      statusDetail: geocodeDetail(order, locale),
      statusLabel: t.statusLabels.metadataReview,
    };
  }
  if (!hasResolvedCoordinates(order)) {
    const canGeocode = hasGeocodableAddress(order);
    return {
      canGeocode,
      routeDetail: canGeocode ? t.statusLabels.needCoordinates : t.statusLabels.needAddress,
      statusDetail: canGeocode
        ? t.statusDetails.useBulkGeocode
        : t.statusDetails.enterAddressOrCoordinates,
      statusLabel: canGeocode ? t.statusLabels.needCoordinates : t.statusLabels.missingAddress,
    };
  }
  return {
    canGeocode: false,
    routeDetail: t.statusLabels.notRouteEligible,
    statusDetail: t.statusDetails.reviewRouteConstraints,
    statusLabel: t.statusLabels.notRouteEligible,
  };
}

function geocodeDetail(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string | null {
  if (
    order.geocodeStatus === "RESOLVED" ||
    order.geocodeStatus === "NOT_REQUIRED"
  )
    return null;
  const code =
    order.geocodeDiagnostics?.code ??
    order.geocodeDiagnostics?.messageKey ??
    null;
  if (code === "GEOCODER_NO_RESULT" && isAddressReviewRequired(order)) {
    return getOrdersCopy(locale).statusDetails.verifyAddress;
  }
  if (code !== null) return geocodeMessageForCode(code, locale);
  return getOrderDetailLabels(locale).geocodeStatus[order.geocodeStatus];
}

function geocodeMessageForCode(code: string, locale: string | null | undefined = 'en-CA'): string {
  const t = getOrdersCopy(locale).geocodeMessages;
  switch (code) {
    case "BLANK_ADDRESS":
      return t.blankAddress;
    case "GEOCODER_NO_RESULT":
      return t.noResult;
    case "GEOCODER_PROVIDER_RATE_LIMITED":
      return t.rateLimited;
    case "GEOCODER_PROVIDER_TIMEOUT":
      return t.timeout;
    case "GEOCODER_PROVIDER_HTTP_ERROR":
    case "GEOCODER_PROVIDER_ERROR":
      return t.providerFailed;
    case "GEOCODER_NOT_CONFIGURED":
    case "GEOCODER_DISABLED":
      return t.notConfigured;
    case "GEOCODER_INVALID_RESULT":
      return t.invalidResult;
    default:
      return humanizeToken(code, locale);
  }
}

function formatTimeWindow(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string | null {
  if (isPresent(order.timeWindowStart) && isPresent(order.timeWindowEnd)) {
    return `${formatTime(order.timeWindowStart)}–${formatTime(order.timeWindowEnd)}`;
  }
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession, locale);
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

function weekdayCode(
  dateString: string,
  locale: string | null | undefined = "en-CA",
): string | null {
  const normalized = normalizeYmd(dateString);
  if (normalized === null) return null;
  const parts = normalized.split("-").map((part) => Number.parseInt(part, 10));
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
  const labels =
    resolveLocale(locale) === "ko-KR"
      ? ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]
      : ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return labels[date.getUTCDay()] ?? null;
}

function normalizeYmd(value: string | null | undefined): string | null {
  if (!isPresent(value)) return null;
  const match = /^(\d{4}-\d{2}-\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const [, ymd] = match;
  return ymd ?? null;
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

function humanizeToken(value: string, locale: string | null | undefined = 'en-CA'): string {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/gu, " ");
  const builtInLabel = new Map<string, string>(
    resolveLocale(locale) === "ko-KR"
      ? [
          ["day", "주간"],
          ["delivery", "배송"],
          ["evening", "저녁"],
          ["evening delivery", "저녁 배송"],
          ["pickup", "픽업"],
          ["planned", "배정됨"],
          ["unplanned", "미배정"],
          ["completed", "완료됨"],
          ["cancelled", "취소됨"],
          ["needs review", "리뷰 필요"],
        ]
      : [],
  ).get(normalized);
  if (builtInLabel !== undefined) return builtInLabel;
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

function mostSpecificBlockerLabel(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): string | null {
  const t = getOrdersCopy(locale);
  const blockers = new Set(order.blockerReasons);
  if (isAddressReviewRequired(order)) return t.statusLabels.addressReview;
  if (isDeliveryDateReviewRequired(order)) return t.statusLabels.deliveryDateReview;
  if (blockers.has("missing_delivery_date") || order.deliveryDate === null)
    return t.statusLabels.missingDeliveryDate;
  if (blockers.has("missing_delivery_area")) return t.statusLabels.missingDeliveryArea;
  if (blockers.has("missing_route_scope")) return t.statusLabels.missingRouteScope;
  if (
    [
      "delivery_day_unparsed",
      "ambiguous_delivery_day",
      "delivery_date_weekday_mismatch",
      "delivery_date_weekday_unverified",
    ].some((reason) => blockers.has(reason))
  )
    return t.statusLabels.deliveryDayUnclear;
  if (blockers.has("missing_time_window")) return t.statusLabels.missingTimeWindow;
  if (
    ["delivery_time_window_unparsed", "ambiguous_delivery_time_window"].some(
      (reason) => blockers.has(reason),
    )
  )
    return t.statusLabels.deliveryTimeUnclear;
  if (blockers.has("missing_coordinates"))
    return hasGeocodableAddress(order) ? t.statusLabels.needCoordinates : t.statusLabels.missingAddress;
  return null;
}

export function formatBlockerReason(reason: string, locale: string | null | undefined = 'en-CA'): string {
  const labels = getOrderDetailLabels(locale).blockerReasons;
  return (
    labels[
      reason as keyof typeof labels
    ] ?? getOrdersCopy(locale).routeConstraintFallback
  );
}

export function formatDiagnosticPathLabel(path: string, locale: string | null | undefined = 'en-CA'): string {
  const labels = getOrderDetailLabels(locale).diagnosticPaths;
  return (
    labels[
      path as keyof typeof labels
    ] ?? getOrdersCopy(locale).diagnosticMetadata
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
  locale,
  settings,
}: {
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  id: string;
  initialEditMode?: boolean;
  locale?: string | null;
  onClose(): void;
  onSaveMetadata?(patch: OrderMetadataPatch): Promise<void>;
  order: CanonicalOrderDto;
  settings?: StoreSettingsDto | null;
}): ReactElement {
  const canPersistMetadata = onSaveMetadata !== undefined;
  const [editMode, setEditMode] = useState(initialEditMode ?? false);
  const [draft, setDraft] = useState<OrderMetadataPatch>(() =>
    metadataPatchFromOrder(order),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onSave = onSaveMetadata;
  const t = getOrdersCopy(locale);
  const status = formatOperationalStatus(order, locale);
  const payment = formatPaymentStatusLabel(order, locale);
  const blockers = order.blockerReasons.map((reason) =>
    formatBlockerReason(reason, locale),
  );
  const editableFields = useMemo(
    () => buildEditableMetadataFields(settings, locale),
    [locale, settings],
  );
  const repairFields = getOrderRepairFields(order, editableFields);
  const hasActionableRepair = repairFields.length > 0;
  const repairTitle = formatRepairCardTitle(repairFields, order, locale);
  const addressSummary = formatAddressSummary(order, locale);
  const coordinateSummary = formatCoordinateSummary(order, locale);

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
          <span className="eyebrow">{t.detailEyebrow}</span>
          <h3 id={`${panelId}-heading`}>{t.detailsFor(order.orderName)}</h3>
        </div>
        <div className="orders-actions">
          {editMode ? null : (
            <button onClick={() => setEditMode(true)} type="button">
              {t.editAllFields}
            </button>
          )}
          <button onClick={onClose} type="button">
            {t.close}
          </button>
        </div>
      </div>

      <section
        aria-label={hasActionableRepair ? t.fieldsToFix : t.orderReadiness}
        className={[
          "order-detail-repair-card",
          hasActionableRepair ? "order-detail-repair-card--attention" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="order-detail-repair-copy">
          <span className="eyebrow">
            {hasActionableRepair ? t.needsReview : t.orderSummary}
          </span>
          <h4>{hasActionableRepair ? repairTitle : status.label}</h4>
          <p>
            {hasActionableRepair
              ? t.repairInstruction
              : (status.detail ?? t.noFixes)}
          </p>
          {blockers.length === 0 ? null : (
            <div
              className="order-detail-repair-pills"
              aria-label={t.currentBlockers}
            >
              {blockers.map((blocker) => (
                <span className="order-pill order-pill--review" key={blocker}>
                  {blocker}
                </span>
              ))}
            </div>
          )}
        </div>
        {hasActionableRepair ? (
          <form className="order-detail-repair-form" onSubmit={submitDraft}>
            <div className="order-detail-repair-fields">
              {repairFields.map((field) => (
                <OrderDetailFieldInput
                  field={field}
                  idPrefix={panelId}
                  instance="repair"
                  key={field.key}
                  locale={locale}
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
                {saving ? t.saving : t.saveFixes}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <div className="order-detail-summary-grid">
        <section className="order-detail-summary-card">
          <h4>{t.destination}</h4>
          <p>{addressSummary.primary}</p>
          {addressSummary.secondary === null ? null : (
            <small>{addressSummary.secondary}</small>
          )}
        </section>
        <section className="order-detail-summary-card">
          <h4>{t.coordinates}</h4>
          <p>{coordinateSummary.primary}</p>
          {coordinateSummary.secondary === null ? null : (
            <small>{coordinateSummary.secondary}</small>
          )}
        </section>
        <section className="order-detail-summary-card">
          <h4>{t.delivery}</h4>
          <dl className="order-detail-mini-list">
            <div>
              <dt>{t.date}</dt>
              <dd>{order.deliveryDate ?? t.required}</dd>
            </div>
            <div>
              <dt>{t.area}</dt>
              <dd>{order.deliveryArea ?? t.required}</dd>
            </div>
            <div>
              <dt>{t.service}</dt>
              <dd>
                {isPresent(order.serviceType)
                  ? humanizeToken(order.serviceType, locale)
                  : isPresent(order.deliverySession)
                    ? humanizeToken(order.deliverySession, locale)
                    : t.required}
              </dd>
            </div>
            <div>
              <dt>{t.window}</dt>
              <dd>{formatTimeWindow(order, locale) ?? t.reviewIfRequired}</dd>
            </div>
          </dl>
        </section>
        <section className="order-detail-summary-card">
          <h4>{t.payment}</h4>
          <dl className="order-detail-mini-list">
            <div>
              <dt>{t.paymentStatus}</dt>
              <dd>
                <span className={`order-pill ${payment.toneClass}`}>
                  {payment.label}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t.paymentMethod}</dt>
              <dd>{formatPaymentMethodEvidence(order) ?? t.required}</dd>
            </div>
            <div>
              <dt>Woo</dt>
              <dd>{order.wooOrderStatus ?? t.required}</dd>
            </div>
            <div>
              <dt>{t.paymentReason}</dt>
              <dd>
                {order.paymentReviewReason ??
                  order.normalizedPaymentReason ??
                  t.reviewIfRequired}
              </dd>
            </div>
            <div>
              <dt>{t.paymentPaidAt}</dt>
              <dd>{order.paidAt ?? t.reviewIfRequired}</dd>
            </div>
            <div>
              <dt>{t.paymentTransaction}</dt>
              <dd>{order.transactionId ?? t.reviewIfRequired}</dd>
            </div>
          </dl>
        </section>
      </div>

      {editMode ? (
        <form className="order-detail-edit" onSubmit={submitDraft}>
          <h4>{t.editAllOrderFields}</h4>
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
                locale={locale}
                onChange={setDraftField}
                value={draft[field.key]}
              />
            ))}
          </div>
          <div className="orders-actions">
            <button disabled={!canPersistMetadata || saving} type="submit">
              {saving ? t.saving : t.save}
            </button>
            <button onClick={onClose} type="button">
              {t.cancel}
            </button>
          </div>
        </form>
      ) : null}
      <details className="order-technical-diagnostics">
        <summary>{t.technicalDiagnostics}</summary>
        {diagnostics === undefined ? (
          <p>{t.loadingDetail}</p>
        ) : diagnostics === null ? (
          <p>{t.noDiagnostics}</p>
        ) : (
          <>
            <p>{t.diagnosticsStatus}: {humanizeToken(diagnostics.status, locale)}</p>
            {diagnostics.current.reviewReasons.length === 0 ? null : (
              <div className="order-technical-diagnostics-block">
                <strong>{t.currentBlockers}</strong>
                <ul>
                  {diagnostics.current.reviewReasons.map((reason) => (
                    <li key={reason}>{formatBlockerReason(reason, locale)}</li>
                  ))}
                </ul>
              </div>
            )}
            {Object.entries(diagnostics.matchedMappingPaths).some(
              ([, path]) => path !== null,
            ) ? (
              <div className="order-technical-diagnostics-block">
                <strong>{t.matchedMappingPaths}</strong>
                <dl>
                  {Object.entries(diagnostics.matchedMappingPaths).map(
                    ([field, path]) =>
                      path === null ? null : (
                        <div key={field}>
                          <dt>{humanizeToken(field, locale)}</dt>
                          <dd>{formatDiagnosticPathLabel(path, locale)}</dd>
                        </div>
                      ),
                  )}
                </dl>
              </div>
            ) : null}
            <ul>
              {diagnostics.candidates.slice(0, 8).map((candidate) => (
                <li key={`${candidate.path}-${candidate.valuePreview}`}>
                  {formatDiagnosticPathLabel(candidate.path, locale)}:{" "}
                  {candidate.valuePreview}
                  <small> · {humanizeToken(candidate.parseStatus, locale)}</small>
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
  locale,
  onChange,
  value,
}: {
  field: EditableMetadataField;
  idPrefix: string;
  instance: "repair" | "edit";
  locale?: string | null;
  onChange(key: keyof OrderMetadataPatch, value: string): void;
  value: string | null;
}): ReactElement {
  const t = getOrdersCopy(locale);
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
              aria-label={t.fieldHelp(field.label)}
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
          locale={locale}
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
  locale,
  onChange,
  value,
}: {
  field: EditableMetadataField;
  inputId: string;
  labelId: string;
  locale?: string | null;
  onChange(key: keyof OrderMetadataPatch, value: string): void;
  value: string | null;
}): ReactElement {
  const choices = field.choices ?? [];
  const t = getOrdersCopy(locale);
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
        {t.selectChoice(field.label)}
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
      field.choices !== undefined &&
      !isActiveChoiceValue(field, draft[field.key]),
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

  if (
    blockers.has("missing_delivery_date") ||
    order.deliveryDate === null ||
    isDeliveryDateReviewRequired(order)
  ) {
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
  if (
    blockers.has("missing_coordinates") &&
    (!hasGeocodableAddress(order) || isAddressReviewRequired(order))
  ) {
    addField("address1");
    addField("city");
    addField("province");
    addField("postalCode");
    addField("countryCode");
  }

  return fields;
}

function formatRepairCardTitle(
  fields: EditableMetadataField[],
  order: CanonicalOrderDto,
  locale: string | null | undefined = 'en-CA',
): string {
  const t = getOrdersCopy(locale).repairTitles;
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

  if (categories.length > 1) return t.aggregate;
  if (keys.has("deliveryDate")) {
    return isDeliveryDateReviewRequired(order)
      ? t.deliveryDateReview
      : t.deliveryDate;
  }
  if (keys.has("deliveryArea")) return t.deliveryArea;
  if (keys.has("serviceType") || keys.has("deliverySession")) {
    return t.routeScope;
  }
  if (keys.has("timeWindowStart") || keys.has("timeWindowEnd")) {
    return t.timeWindow;
  }
  if (categories[0] === "address") {
    return isAddressReviewRequired(order) ? t.addressReview : t.address;
  }
  return t.fallback;
}

function formatAddressSummary(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  primary: string;
  secondary: string | null;
} {
  const t = getOrdersCopy(locale);
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
    primary: street || t.addressRequired,
    secondary: locality || null,
  };
}

function formatCoordinateSummary(order: CanonicalOrderDto, locale: string | null | undefined = 'en-CA'): {
  primary: string;
  secondary: string | null;
} {
  const t = getOrdersCopy(locale);
  if (hasResolvedCoordinates(order)) {
    return {
      primary: `${order.coordinates.latitude?.toFixed(6)}, ${order.coordinates.longitude?.toFixed(6)}`,
      secondary: t.coordinatesReady,
    };
  }
  if (isAddressReviewRequired(order)) {
    return {
      primary: t.statusLabels.addressReview,
      secondary: t.statusDetails.verifyAddress,
    };
  }
  if (hasGeocodableAddress(order)) {
    return {
      primary: t.coordinatesNeeded,
      secondary: t.useBulkGeocodeFromList,
    };
  }
  return {
    primary: t.addressRequired,
    secondary: t.enterAddressBeforeGeocoding,
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}

function resolveRouteMapDeliveryDate(filterDeliveryDate: string | null | undefined, draftDeliveryDate: string | null): string | null {
  const normalizedFilterDate = normalizeRouteFilterValue(filterDeliveryDate);
  return normalizedFilterDate ?? draftDeliveryDate;
}

function buildRouteMapOrders(
  orders: CanonicalOrderDto[],
  visibleOrders: CanonicalOrderDto[],
  deliveryDate: string | null,
): CanonicalOrderDto[] {
  if (deliveryDate === null) return visibleOrders;
  return orders.filter((order) => order.deliveryDate === deliveryDate);
}

function orderSelectedOrdersByDraft(
  selectedOrders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>,
): CanonicalOrderDto[] {
  const ordersById = new Map(selectedOrders.map((order) => [order.orderId, order]));
  return [...selectedOrderIds]
    .map((orderId) => ordersById.get(orderId))
    .filter((order): order is CanonicalOrderDto => order !== undefined);
}

export function moveSelectedOrderBefore(
  orderIds: string[],
  draggedOrderId: string,
  targetOrderId: string,
): string[] {
  if (draggedOrderId === targetOrderId) return orderIds;
  const next = orderIds.filter((orderId) => orderId !== draggedOrderId);
  const targetIndex = next.indexOf(targetOrderId);
  if (targetIndex === -1 || !orderIds.includes(draggedOrderId)) return orderIds;
  next.splice(targetIndex, 0, draggedOrderId);
  return next;
}

function buildOrderMapMarkerStates(input: {
  filters: OrderFilterState;
  orders: CanonicalOrderDto[];
  selectedOrderIds: ReadonlySet<string>;
  worksetContext: OrderWorksetContext;
}): ReadonlyMap<string, OrderMapMarkerState> {
  const selectedSequenceByOrderId = new Map(
    [...input.selectedOrderIds].map((orderId, index) => [orderId, index + 1]),
  );
  const markerStates = new Map<string, OrderMapMarkerState>();
  for (const order of input.orders) {
    const sequence = selectedSequenceByOrderId.get(order.orderId) ?? null;
    const needsReview = isRouteMapReviewOrder(order);
    const isCandidate = sequence !== null || isRouteMapCandidate(order);
    const routeScopeBlocked =
      isOrderDifferentFromActiveRouteScope(order, input.worksetContext) ||
      isOrderBlockedByRouteSubfilters(order, input.filters);
    markerStates.set(order.orderId, {
      markerOpacity: isCandidate && routeScopeBlocked ? 0.5 : 1,
      pinKind: needsReview ? "review" : isCandidate ? "candidate" : "unplanned",
      sequence,
    });
  }
  return markerStates;
}

function isRouteMapCandidate(order: CanonicalOrderDto): boolean {
  return (
    isRoutePlanEligible(order) &&
    order.deliveryDate !== null &&
    isPresent(order.serviceType) &&
    isPresent(order.deliverySession) &&
    hasResolvedCoordinates(order)
  );
}

function isRouteMapReviewOrder(order: CanonicalOrderDto): boolean {
  return (
    order.health === "needs_review" ||
    order.metadataResolved === false ||
    order.routeEligible === false ||
    order.blockerReasons.length > 0 ||
    order.deliveryDate === null ||
    !isPresent(order.serviceType) ||
    !isPresent(order.deliverySession) ||
    !hasResolvedCoordinates(order)
  );
}

function isOrderDifferentFromActiveRouteScope(
  order: CanonicalOrderDto,
  context: OrderWorksetContext,
): boolean {
  if (
    context.routeDate !== undefined &&
    context.routeDate !== null &&
    order.deliveryDate !== null &&
    order.deliveryDate !== context.routeDate
  ) {
    return true;
  }
  if (context.routeScopeKey === undefined || context.routeScopeKey === null) {
    return false;
  }
  const orderRouteScopeKey = getRouteDraftScopeKey(order);
  return orderRouteScopeKey !== null && orderRouteScopeKey !== context.routeScopeKey;
}

function isOrderBlockedByRouteSubfilters(
  order: CanonicalOrderDto,
  filters: Pick<OrderFilterState, "deliverySession" | "serviceType">,
): boolean {
  const serviceType = normalizeRouteFilterValue(filters.serviceType);
  if (serviceType !== null && order.serviceType !== serviceType) return true;
  const deliverySession = normalizeRouteFilterValue(filters.deliverySession);
  return deliverySession !== null && order.deliverySession !== deliverySession;
}

function normalizeRouteFilterValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "all") return null;
  return trimmed;
}

export function buildRouteDraftSelection(
  orders: CanonicalOrderDto[],
  requestedSelectedOrderIds: ReadonlySet<string>,
  locale: string | null | undefined = 'en-CA',
): {
  deliveryDate: string | null;
  orderIds: string[];
  routeScopeKey: string | null;
  warning: string | null;
} {
  const t = getOrdersCopy(locale).routeDraft;
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
          : t.selectReady,
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
      : t.onlySameScope;

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
  locale: string | null | undefined = 'en-CA',
): string | null {
  const t = getOrdersCopy(locale).routeDraft;
  if (selectedOrders.length === 0) return null;
  if (selectedOrders.some((order) => order.deliveryDate !== routeDate)) {
    return t.dateMustMatch;
  }
  const scopeKeys = new Set(
    selectedOrders.map((order) => getRouteDraftScopeKey(order)),
  );
  if (scopeKeys.size !== 1 || scopeKeys.has(null)) {
    return t.selectedMustShareScope;
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
