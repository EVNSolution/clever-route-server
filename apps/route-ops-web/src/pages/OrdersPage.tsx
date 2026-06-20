import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";

import {
  createRouteGrouping,
  getOrderCustomerNoteContext,
  getOrderMetadataDiagnostics,
  getOrders,
  getWooOrderSyncRun,
  getSettings,
  patchDeliveryCustomerAdminMemo,
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
  formatOrderItemLine,
  formatOrderItemName,
  formatOrderItemOptions,
  getOrderItemDisplayKey,
  getOrderItems,
} from "../orderItems";
import {
  applyClientOrderFilters,
  buildOrderFetchQuery,
  createDefaultOrderFilters,
  deriveOrderFilterOptions,
  deriveOrderSourceValueOptions,
  getOrderRouteType,
  isAddressReviewRequired,
  isDeliveryDateReviewRequired,
  storeSettingsToDepotPoint,
  reconcileOrderFilters,
  pruneOrderFilters,
  type OrderFacetedFilterKey,
  type OrderFilterOptionSets,
  type OrderFilterState,
  type OrderRouteTypeFilter,
  type OrderSourceValueOptions,
  type OrderWorksetContext,
} from "../state";
import type {
  BootstrapPayload,
  CanonicalOrderDto,
  DeliveryMetadataDiagnosticsDto,
  OrderCustomerNoteContextDto,
  StoreSettingsDto,
  WooSyncRunDto,
} from "../types";
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

export type MetadataChoice = {
  description?: string | null;
  example?: string | null;
  label: string;
  value: string;
};

export type EditableMetadataField = {
  choices?: MetadataChoice[];
  helpText?: string;
  key: keyof OrderMetadataPatch;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
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

export function buildNextPlanSelection(
  selected: ReadonlySet<string>,
  orderId: string,
): { action: "add" | "remove"; selected: Set<string> } {
  const next = new Set(selected);
  if (next.has(orderId)) {
    next.delete(orderId);
    return { action: "remove", selected: next };
  }
  next.add(orderId);
  return { action: "add", selected: next };
}

export function buildEditableMetadataFields(
  sourceValues: OrderSourceValueOptions | null | undefined,
  locale?: string | null,
  order?: CanonicalOrderDto | null,
): EditableMetadataField[] {
  const t = getOrdersCopy(locale);
  const orderFieldLabels = getOrderFieldLabels(locale);
  const serviceTypeChoices = buildMetadataChoices(
    sourceValues?.serviceTypes ?? [],
    order?.serviceType,
    locale,
  );
  const deliverySessionChoices = buildMetadataChoices(
    sourceValues?.deliverySessions ?? [],
    order?.deliverySession,
    locale,
  );
  const serviceTypeEditable = shouldUseOrderChoiceInput(
    serviceTypeChoices,
    order?.serviceType,
  );
  const deliverySessionEditable = shouldUseOrderChoiceInput(
    deliverySessionChoices,
    order?.deliverySession,
  );
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
      choices: serviceTypeEditable ? serviceTypeChoices : undefined,
      helpText: t.editableHelp.serviceType,
      key: "serviceType",
      label: orderFieldLabels.serviceType,
      placeholder: serviceTypeChoices[0]?.value ?? "",
      readOnly: !serviceTypeEditable,
    },
    {
      choices: deliverySessionEditable ? deliverySessionChoices : undefined,
      helpText: t.editableHelp.deliverySession,
      key: "deliverySession",
      label: orderFieldLabels.deliverySession,
      placeholder: deliverySessionChoices[0]?.value ?? "",
      readOnly: !deliverySessionEditable,
    },
    {
      helpText: t.editableHelp.timeWindow,
      key: "timeWindowStart",
      label: orderFieldLabels.timeWindowStart,
    },
    {
      helpText: t.editableHelp.timeWindow,
      key: "timeWindowEnd",
      label: orderFieldLabels.timeWindowEnd,
    },
  ];
}

function buildMetadataChoices(
  sourceValues: string[],
  currentValue: string | null | undefined,
  locale: string | null | undefined,
): MetadataChoice[] {
  const values = Array.from(
    new Set(
      [...sourceValues, currentValue]
        .map((value) => value?.trim() ?? "")
        .filter((value) => value !== ""),
    ),
  ).sort((first, second) => first.localeCompare(second));
  return values.map((value) => ({
    example: value,
    label: humanizeToken(value, locale),
    value,
  }));
}

function shouldUseOrderChoiceInput(
  choices: MetadataChoice[],
  currentValue: string | null | undefined,
): boolean {
  const normalizedCurrent = currentValue?.trim() ?? "";
  if (choices.length > 1) return true;
  return normalizedCurrent === "" && choices.length === 1;
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
  const initialRouteDate = useMemo(() => today(), []);
  const [orders, setOrders] = useState<CanonicalOrderDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<OrderFilterState>(() =>
    createDefaultOrderFilters(),
  );
  const [filterOrder, setFilterOrder] = useState<OrderFacetedFilterKey[]>([]);
  const initialCopy = getOrdersCopy(bootstrap.locale);
  const [routeDate, setRouteDate] = useState(initialRouteDate);
  const [routeName, setRouteName] = useState(() =>
    initialCopy.defaultRouteName(initialRouteDate),
  );
  const [plannedOrderIds, setPlannedOrderIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [refreshingOrders, setRefreshingOrders] = useState(false);
  const [settings, setSettings] = useState<StoreSettingsDto | null>(null);
  const [diagnosticsByOrder, setDiagnosticsByOrder] = useState<
    Record<string, DeliveryMetadataDiagnosticsDto | null>
  >({});
  const [customerNoteContextByOrder, setCustomerNoteContextByOrder] = useState<
    Record<string, OrderCustomerNoteContextDto | null>
  >({});
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(
    new Set(),
  );
  const [wooSyncStatus, setWooSyncStatus] = useState<string | null>(null);
  const [wooSyncing, setWooSyncing] = useState(false);
  const locale = resolveLocale(settings?.locale ?? bootstrap.locale);
  const t = getOrdersCopy(locale);
  const pendingScrollRestoreRef = useRef<{
    x: number;
    y: number;
  } | null>(null);

  const fetchQuery = useMemo(() => buildOrderFetchQuery(filters), [filters]);
  const visibleOrders = useMemo(
    () => applyClientOrderFilters(orders, filters),
    [orders, filters],
  );
  const filterOptions = useMemo(
    () => deriveOrderFilterOptions(orders, filters, filterOrder),
    [orders, filters, filterOrder],
  );
  const orderSourceOptions = useMemo(
    () => deriveOrderSourceValueOptions(orders),
    [orders],
  );
  useEffect(() => {
    const reconciled = pruneOrderFilters({
      filters,
      order: filterOrder,
      orders,
    });
    if (reconciled.order.join("|") !== filterOrder.join("|")) {
      setFilterOrder(reconciled.order);
    }
    if (!areOrderFiltersEqual(filters, reconciled.filters)) {
      setFilters(reconciled.filters);
    }
  }, [filterOrder, filters, orders]);

  const changeFilters = (
    changedField: OrderFacetedFilterKey,
    nextFilters: OrderFilterState,
  ): void => {
    const reconciled = reconcileOrderFilters({
      changedField,
      filters: nextFilters,
      orders,
      previousOrder: filterOrder,
    });
    setFilterOrder(reconciled.order);
    setFilters(reconciled.filters);
  };

  const tableOrders = useMemo(() => visibleOrders, [visibleOrders]);
  const worksetContext = useMemo<OrderWorksetContext>(
    () => ({
      scope: filters.scope,
    }),
    [filters.scope],
  );
  const plannedOrders = useMemo(
    () => orderSelectedOrdersByDraft(orders, plannedOrderIds),
    [orders, plannedOrderIds],
  );
  const selectedVisibleOrderIds = useMemo(
    () => buildVisibleSelectedOrderIds(tableOrders, selected),
    [selected, tableOrders],
  );
  const routeCreateReasons = useMemo(
    () => getRouteDraftCreateReasons(plannedOrders, locale),
    [locale, plannedOrders],
  );
  const depotPoint = useMemo(
    () => storeSettingsToDepotPoint(settings, locale),
    [locale, settings],
  );
  const mapOrders = useMemo(() => plannedOrders, [plannedOrders]);
  const orderMarkerStates = useMemo(
    () =>
      buildOrderMapMarkerStates({
        filters,
        orders: mapOrders,
        selectedOrderIds: plannedOrderIds,
        worksetContext,
      }),
    [filters, mapOrders, plannedOrderIds, worksetContext],
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

  const createGrouping = async (): Promise<void> => {
    try {
      const routeDraftBlockers = getRouteDraftCreateReasons(plannedOrders, locale);
      if (routeDraftBlockers.length > 0)
        throw new Error(routeDraftBlockers.join(" "));
      const createOrderIds = plannedOrders.map((order) => order.orderId);
      const planDate =
        getRouteDraftSingleDeliveryDate(plannedOrders) ??
        (routeDate || today());
      const result = await createRouteGrouping({
        csrfToken: bootstrap.csrfToken,
        groupingName: routeName,
        orderIds: createOrderIds,
        planDate,
      });
      navigate(`/admin/ui/app/route-groups/${encodeURIComponent(result.routeGroup.id)}`);
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

  const loadCustomerNoteContext = async (orderId: string): Promise<void> => {
    try {
      const payload = await getOrderCustomerNoteContext({
        csrfToken: bootstrap.csrfToken,
        orderId,
      });
      setCustomerNoteContextByOrder((current) => ({
        ...current,
        [orderId]: payload,
      }));
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
      setCustomerNoteContextByOrder((current) => ({
        ...current,
        [orderId]: null,
      }));
    }
  };

  const toggleOrderDetail = (orderId: string): void => {
    let shouldLoadDiagnostics = false;
    let shouldLoadCustomerNoteContext = false;
    setExpandedOrderIds((current) => {
      const next = new Set(current);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
        shouldLoadDiagnostics = diagnosticsByOrder[orderId] === undefined;
        shouldLoadCustomerNoteContext =
          customerNoteContextByOrder[orderId] === undefined;
      }
      return next;
    });
    if (shouldLoadDiagnostics) void loadDiagnostics(orderId);
    if (shouldLoadCustomerNoteContext) void loadCustomerNoteContext(orderId);
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

  const saveDeliveryCustomerAdminMemo = async (
    orderId: string,
    profileId: string,
    adminMemo: string | null,
  ): Promise<void> => {
    try {
      const payload = await patchDeliveryCustomerAdminMemo({
        adminMemo,
        csrfToken: bootstrap.csrfToken,
        profileId,
      });
      setCustomerNoteContextByOrder((current) => {
        const context = current[orderId];
        if (context === undefined || context === null) return current;
        return {
          ...current,
          [orderId]: {
            ...context,
            deliveryCustomer:
              context.deliveryCustomer === null
                ? context.deliveryCustomer
                : {
                    ...context.deliveryCustomer,
                    adminMemo: payload.deliveryCustomer.adminMemo,
                    profileId: payload.deliveryCustomer.profileId,
                  },
          },
        };
      });
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
      throw error;
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

  const clearPlan = (): void => {
    setPlannedOrderIds(new Set());
    setSelected(new Set());
    setError(null);
  };

  const setTableSelection = (nextSelected: Set<string>): void => {
    setSelected(nextSelected);
  };

  const togglePlanOrder = (orderId: string): void => {
    setTableSelection(buildNextPlanSelection(selected, orderId).selected);
  };

  const addSelectionToPlan = (): void => {
    const nextPlanIds = new Set(selectedVisibleOrderIds);
    setPlannedOrderIds(nextPlanIds);
    const nextPlannedOrders = orderSelectedOrdersByDraft(orders, nextPlanIds);
    const singleDate = getRouteDraftSingleDeliveryDate(nextPlannedOrders);
    if (singleDate !== null) {
      setRouteDate(singleDate);
      setRouteName((current) =>
        current.trim() === "" ||
        /^(Route|경로) \d{4}-\d{2}-\d{2}$/u.test(current)
          ? t.defaultRouteName(singleDate)
          : current,
      );
    }
    setError(null);
  };

  return (
    <TabLayout
      title={t.title}
      primary={
        <RouteOpsMap
          bootstrap={bootstrap}
          depot={depotPoint}
          orderMarkerStates={orderMarkerStates}
          orders={mapOrders}
        />
      }
      secondary={
        <RoutePlanPanel
          createReasons={routeCreateReasons}
          onClear={clearPlan}
          onCreate={() => void createGrouping()}
          planDateLabel={formatRouteDraftDateLabel(plannedOrders, locale)}
          planTypeLabel={formatRouteDraftTypeLabel(plannedOrders, locale)}
          routeName={routeName}
          selectedOrders={plannedOrders}
          setRouteName={setRouteName}
          locale={locale}
        />
      }
      lower={
        <>
          <FilterBar
            filterOptions={filterOptions}
            filters={filters}
            locale={locale}
            onChange={changeFilters}
          />
          <OrderTable
            addPlanDisabled={selectedVisibleOrderIds.length === 0}
            customerNoteContextByOrder={customerNoteContextByOrder}
            diagnosticsByOrder={diagnosticsByOrder}
            expandedOrderIds={expandedOrderIds}
            loading={loading}
            onAddPlan={addSelectionToPlan}
            onCloseDetail={closeOrderDetail}
            onSaveCustomerAdminMemo={saveDeliveryCustomerAdminMemo}
            onSaveMetadata={saveOrderMetadata}
            onWooSync={() => void syncWooOrders()}
            onToggleDetail={toggleOrderDetail}
            onTogglePlanOrder={togglePlanOrder}
            orders={tableOrders}
            locale={locale}
            refreshing={refreshingOrders}
            selected={selected}
            setSelected={setTableSelection}
            sourceOptions={orderSourceOptions}
            worksetContext={worksetContext}
            wooSyncing={wooSyncing}
            wooSyncStatus={wooSyncStatus}
          />
        </>
      }
    />
  );
}

export function RoutePlanPanel(input: {
  createReasons: string[];
  locale?: string | null;
  onClear(): void;
  onCreate(): void;
  planDateLabel: string;
  planTypeLabel: string;
  routeName: string;
  selectedOrders: CanonicalOrderDto[];
  setRouteName(value: string): void;
}): ReactElement {
  const t = getOrdersCopy(input.locale);
  const canCreate = input.selectedOrders.length > 0;
  return (
    <div
      className="panel side-panel route-plan-panel"
      aria-label={t.routeDraftPanelLabel}
    >
      <div className="panel-heading compact-heading route-plan-header">
        <div>
          <h2>{t.routeDraftTitle}</h2>
        </div>
        <Badge>
          {input.selectedOrders.length} {t.orders}
        </Badge>
      </div>
      <label>
        {t.routeName}
        <input
          value={input.routeName}
          onChange={(event) => input.setRouteName(event.target.value)}
        />
      </label>
      <dl className="route-plan-summary">
        <div>
          <dt>{t.routeDate}</dt>
          <dd>{input.planDateLabel}</dd>
        </div>
        <div>
          <dt>{t.type}</dt>
          <dd>{input.planTypeLabel}</dd>
        </div>
        <div>
          <dt>{t.totalOrders}</dt>
          <dd>{input.selectedOrders.length}</dd>
        </div>
      </dl>
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
          disabled={input.selectedOrders.length === 0}
          onClick={input.onClear}
          type="button"
        >
          {t.clearPlan}
        </button>
      </div>
      {input.createReasons.length === 0 ? null : (
        <ul
          className="route-plan-validation"
          aria-label={t.routeValidationReasons}
        >
          {input.createReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {input.selectedOrders.length === 0 ? (
        <p className="route-plan-empty">{t.planEmpty}</p>
      ) : null}
    </div>
  );
}

function FilterBar({
  filterOptions,
  filters,
  locale,
  onChange,
}: {
  filterOptions: OrderFilterOptionSets;
  filters: OrderFilterState;
  locale?: string | null;
  onChange(field: OrderFacetedFilterKey, filters: OrderFilterState): void;
}): ReactElement {
  const t = getOrdersCopy(locale);
  const weekdays = getWeekdayFilterOptions(locale).filter(
    (
      option,
    ): option is {
      label: string;
      value: NonNullable<OrderFilterState["weekday"]>;
    } => option.value !== "" && filterOptions.weekdays.includes(option.value),
  );
  const routeTypes = buildActualTypeFilterOptions(
    filterOptions.routeTypes,
    locale,
  );
  const areaOptionsWithSelected =
    filters.deliveryArea !== "" &&
    !filterOptions.deliveryAreas.includes(filters.deliveryArea)
      ? [filters.deliveryArea, ...filterOptions.deliveryAreas]
      : filterOptions.deliveryAreas;
  const routeTypesWithSelected =
    filters.routeType !== "" &&
    !routeTypes.some((option) => option.value === filters.routeType)
      ? [
          {
            label: humanizeToken(filters.routeType, locale),
            value: filters.routeType,
          },
          ...routeTypes,
        ]
      : routeTypes;
  const weekdaysWithSelected =
    filters.weekday !== "" &&
    !weekdays.some((option) => option.value === filters.weekday)
      ? [
          getWeekdayFilterOptions(locale).find(
            (option) => option.value === filters.weekday,
          ) ?? { label: filters.weekday, value: filters.weekday },
          ...weekdays,
        ]
      : weekdays;
  return (
    <article className="panel filter-panel">
      <label className="filter-field filter-field--date">
        {t.deliveryDate}
        <FilterValueControl
          active={filters.deliveryDate !== ""}
          clearLabel={t.clearFilter(t.deliveryDate)}
          onClear={() =>
            onChange("deliveryDate", { ...filters, deliveryDate: "" })
          }
        >
          <OrderDatePicker
            enabledDates={filterOptions.deliveryDates}
            locale={locale}
            onSelect={(deliveryDate) =>
              onChange("deliveryDate", { ...filters, deliveryDate })
            }
            selectedDate={filters.deliveryDate}
          />
        </FilterValueControl>
      </label>
      <label className="filter-field filter-field--weekday">
        {t.weekday}
        <FilterValueControl
          active={filters.weekday !== ""}
          clearLabel={t.clearFilter(t.weekday)}
          onClear={() => onChange("weekday", { ...filters, weekday: "" })}
        >
          <select
            value={filters.weekday}
            onChange={(event) =>
              onChange("weekday", {
                ...filters,
                weekday: event.target.value as OrderFilterState["weekday"],
              })
            }
          >
            <option value="">{t.allOption}</option>
            {weekdaysWithSelected.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FilterValueControl>
      </label>
      <label className="filter-field filter-field--type">
        {t.type}
        <FilterValueControl
          active={filters.routeType !== ""}
          clearLabel={t.clearFilter(t.type)}
          onClear={() => onChange("routeType", { ...filters, routeType: "" })}
        >
          <select
            value={filters.routeType}
            onChange={(event) =>
              onChange("routeType", {
                ...filters,
                routeType: event.target.value,
              })
            }
          >
            <option value="">{t.allOption}</option>
            {routeTypesWithSelected.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FilterValueControl>
      </label>
      <label className="filter-field filter-field--area">
        {t.areaRegion}
        <FilterValueControl
          active={filters.deliveryArea !== ""}
          clearLabel={t.clearFilter(t.areaRegion)}
          onClear={() =>
            onChange("deliveryArea", { ...filters, deliveryArea: "" })
          }
        >
          <select
            value={filters.deliveryArea}
            onChange={(event) =>
              onChange("deliveryArea", {
                ...filters,
                deliveryArea: event.target.value,
              })
            }
          >
            <option value="">{t.allOption}</option>
            {areaOptionsWithSelected.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </FilterValueControl>
      </label>
    </article>
  );
}

function areOrderFiltersEqual(
  first: OrderFilterState,
  second: OrderFilterState,
): boolean {
  return (
    first.deliveryArea === second.deliveryArea &&
    first.deliveryDate === second.deliveryDate &&
    first.deliverySession === second.deliverySession &&
    first.deliveryStatus === second.deliveryStatus &&
    first.routeType === second.routeType &&
    first.scope === second.scope &&
    first.search === second.search &&
    first.serviceType === second.serviceType &&
    first.status === second.status &&
    first.tab === second.tab &&
    first.weekday === second.weekday
  );
}

function OrderDatePicker({
  enabledDates,
  locale,
  onSelect,
  selectedDate,
}: {
  enabledDates: string[];
  locale?: string | null;
  onSelect(date: string): void;
  selectedDate: string;
}): ReactElement {
  const t = getOrdersCopy(locale);
  const initialMonth = selectedDate || enabledDates[0] || today();
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    monthKey(initialMonth),
  );
  const enabled = useMemo(() => new Set(enabledDates), [enabledDates]);
  useEffect(() => {
    if (selectedDate !== "") {
      setVisibleMonth(monthKey(selectedDate));
    }
  }, [selectedDate]);
  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const selectedLabel = selectedDate === "" ? t.dateFallback : selectedDate;
  return (
    <span className="order-date-picker">
      <button
        aria-expanded={open}
        className="order-date-picker-toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {selectedLabel}
      </button>
      {open ? (
        <span className="order-date-calendar" role="dialog">
          <span className="order-date-calendar-header">
            <button
              aria-label="Previous month"
              onClick={() => setVisibleMonth(shiftMonth(visibleMonth, -1))}
              type="button"
            >
              ‹
            </button>
            <strong>{formatMonthLabel(visibleMonth, locale)}</strong>
            <button
              aria-label="Next month"
              onClick={() => setVisibleMonth(shiftMonth(visibleMonth, 1))}
              type="button"
            >
              ›
            </button>
          </span>
          <span className="order-date-calendar-weekdays">
            {getWeekdayFilterOptions(locale).map((weekday) => (
              <span key={weekday.value}>{weekday.label.slice(0, 3)}</span>
            ))}
          </span>
          <span className="order-date-calendar-grid">
            {days.map((day) => {
              const disabled = day.date === null || !enabled.has(day.date);
              const selected = day.date !== null && day.date === selectedDate;
              return (
                <button
                  aria-pressed={selected}
                  className={[
                    "order-date-calendar-day",
                    day.inMonth ? "" : "is-outside-month",
                    disabled ? "is-disabled" : "",
                    selected ? "is-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={disabled}
                  key={`${day.date ?? "blank"}-${day.index}`}
                  onClick={() => {
                    if (day.date === null) return;
                    onSelect(day.date);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {day.label}
                </button>
              );
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

type CalendarDay = {
  date: string | null;
  inMonth: boolean;
  index: number;
  label: string;
};

function monthKey(dateValue: string): string {
  return dateValue.slice(0, 7);
}

function shiftMonth(month: string, offset: number): string {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(
  month: string,
  locale: string | null | undefined,
): string {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function buildCalendarDays(month: string): CalendarDay[] {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leading = first.getUTCDay();
  const days: CalendarDay[] = [];
  for (let index = 0; index < leading; index += 1) {
    days.push({ date: null, inMonth: false, index, label: "" });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    days.push({
      date,
      inMonth: true,
      index: leading + day,
      label: String(day),
    });
  }
  return days;
}

function FilterValueControl(input: {
  active: boolean;
  children: ReactElement;
  clearLabel: string;
  onClear(): void;
}): ReactElement {
  return (
    <span className="filter-control">
      {input.children}
      {input.active ? (
        <button
          aria-label={input.clearLabel}
          className="filter-clear-x"
          onClick={input.onClear}
          type="button"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function formatFilterOptionLabel(
  value: string,
  locale: string | null | undefined = "en-CA",
): string {
  const normalized = value.trim();
  const labels =
    resolveLocale(locale) === "ko-KR"
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

function formatWooSyncStatus(
  run: WooSyncRunDto,
  locale: string | null | undefined = "en-CA",
): string {
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
  addPlanDisabled?: boolean;
  customerNoteContextByOrder?: Record<string, OrderCustomerNoteContextDto | null>;
  detailModes?: Record<string, "review" | "edit">;
  diagnosticsByOrder: Record<string, DeliveryMetadataDiagnosticsDto | null>;
  expandedOrderIds?: ReadonlySet<string>;
  loading: boolean;
  locale?: string | null;
  onAddPlan?(): void;
  onCloseDetail?(orderId: string): void;
  onSaveCustomerAdminMemo?(
    orderId: string,
    profileId: string,
    adminMemo: string | null,
  ): Promise<void>;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  onWooSync?(): void;
  orders: CanonicalOrderDto[];
  refreshing?: boolean;
  selected: Set<string>;
  setSelected(selected: Set<string>): void;
  sourceOptions?: OrderSourceValueOptions | null;
  worksetContext?: OrderWorksetContext;
  wooSyncing?: boolean;
  wooSyncStatus?: string | null;
}): ReactElement {
  const t = getOrdersCopy(input.locale);
  const worksetContext = input.worksetContext ?? {};
  const visibleOrderIds = input.orders.map((order) => order.orderId);
  const selectedFilteredCount = visibleOrderIds.filter((orderId) =>
    input.selected.has(orderId),
  ).length;
  const visibleSelectedCount = visibleOrderIds.filter((orderId) =>
    input.selected.has(orderId),
  ).length;
  const allFilteredSelected =
    visibleOrderIds.length > 0 &&
    selectedFilteredCount === visibleOrderIds.length;
  const selectFilteredOrders = (): void => {
    input.setSelected(new Set([...input.selected, ...visibleOrderIds]));
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
          <h2>{t.tableTitle}</h2>
        </div>
        <div className="orders-heading-actions">
          <Badge>
            {input.orders.length} {t.orders}
          </Badge>
          <span className="orders-selection-summary">
            {t.selectedSummary(visibleSelectedCount, input.orders.length, 0)}
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
            disabled={input.addPlanDisabled === true}
            onClick={() => input.onAddPlan?.()}
            type="button"
          >
            {t.addPlanAction}
          </button>
        </div>
      </div>
      {input.wooSyncStatus === undefined ||
      input.wooSyncStatus === null ? null : (
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
                  disabled={visibleOrderIds.length === 0}
                  onChange={(event) =>
                    toggleFilteredSelection(event.target.checked)
                  }
                  type="checkbox"
                />
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
                <td colSpan={ORDERS_TABLE_COLUMN_COUNT}>{t.noOrders}</td>
              </tr>
            ) : (
              input.orders.map((order) => (
                <OrderTableRow
                  customerNoteContext={
                    input.customerNoteContextByOrder?.[order.orderId]
                  }
                  detailMode={input.detailModes?.[order.orderId] ?? "review"}
                  diagnostics={input.diagnosticsByOrder[order.orderId]}
                  expanded={input.expandedOrderIds?.has(order.orderId) ?? false}
                  key={order.orderId}
                  locale={input.locale}
                  onCloseDetail={input.onCloseDetail}
                  onSaveCustomerAdminMemo={input.onSaveCustomerAdminMemo}
                  onSaveMetadata={input.onSaveMetadata}
                  onToggleDetail={input.onToggleDetail}
                  onTogglePlanOrder={input.onTogglePlanOrder}
                  order={order}
                  selectedOrders={input.selected}
                  setSelected={input.setSelected}
                  sourceOptions={input.sourceOptions}
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
  customerNoteContext?: OrderCustomerNoteContextDto | null;
  detailMode: "review" | "edit";
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  expanded: boolean;
  locale?: string | null;
  onCloseDetail?(orderId: string): void;
  onSaveCustomerAdminMemo?(
    orderId: string,
    profileId: string,
    adminMemo: string | null,
  ): Promise<void>;
  onSaveMetadata?(orderId: string, patch: OrderMetadataPatch): Promise<void>;
  onToggleDetail?(orderId: string): void;
  onTogglePlanOrder(orderId: string): void;
  order: CanonicalOrderDto;
  selectedOrders: Set<string>;
  setSelected(selected: Set<string>): void;
  sourceOptions?: OrderSourceValueOptions | null;
  worksetContext?: OrderWorksetContext;
}): ReactElement {
  const { order } = input;
  const t = getOrdersCopy(input.locale);
  const selected = input.selectedOrders.has(order.orderId);
  const day = formatDeliveryDayLabel(order, input.locale);
  const method = formatMethodStatusLabel(order, input.locale);
  const payment = formatPaymentStatusLabel(order, input.locale);
  const receivedLabel = formatOrderReceivedLabelParts(order, input.locale);
  const tableStatus = formatTableReadinessStatus(order, input.locale);
  const orderLabel = getOrderAccessibleLabel(order);
  const planActionLabel = t.planOrderAction(
    selected ? "Remove" : "Add",
    orderLabel,
  );
  const detailPanelId = `order-detail-${sanitizeId(order.orderId)}`;
  const detailLabel = t.detailToggle(input.expanded, orderLabel);
  return (
    <>
      <tr
        className={[
          "orders-row",
          order.blockerReasons.length > 0 ? "orders-row--needs-review" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <td className="orders-select-cell">
          <input
            aria-label={t.selectOrder(orderLabel)}
            checked={selected}
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
        <td className="orders-area-cell">
          <span className="order-compact-value">{formatAreaLabel(order)}</span>
        </td>
        <td className="orders-route-cell">
          <span className="order-compact-value">
            {formatRouteLabel(order, input.locale)}
          </span>
        </td>
        <td className="orders-status-cell">
          <span
            aria-label={tableStatus.label}
            className={`order-pill ${tableStatus.toneClass}`}
          >
            {tableStatus.label}
          </span>
        </td>
        <td>
          <div className="orders-actions">
            <button
              aria-label={planActionLabel}
              className={selected ? "active" : ""}
              onClick={() => input.onTogglePlanOrder(order.orderId)}
              type="button"
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
              customerNoteContext={input.customerNoteContext}
              diagnostics={input.diagnostics}
              id={detailPanelId}
              initialEditMode={input.detailMode === "edit"}
              onClose={() => input.onCloseDetail?.(order.orderId)}
              onSaveCustomerAdminMemo={
                input.onSaveCustomerAdminMemo === undefined
                  ? undefined
                  : (profileId: string, adminMemo: string | null) =>
                      input.onSaveCustomerAdminMemo!(
                        order.orderId,
                        profileId,
                        adminMemo,
                      )
              }
              onSaveMetadata={
                input.onSaveMetadata === undefined
                  ? undefined
                  : (patch: OrderMetadataPatch) =>
                      input.onSaveMetadata!(order.orderId, patch)
              }
              order={order}
              locale={input.locale}
              sourceOptions={input.sourceOptions}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function formatMethodLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string {
  if (isPresent(order.serviceType))
    return humanizeToken(order.serviceType, locale);
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession, locale);
  return "—";
}

export function formatMethodStatusLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
  label: string;
  toneClass: string;
} {
  const label = formatMethodLabel(order, locale);
  return {
    label,
    toneClass: label === "—" ? "order-pill--review" : "order-pill--neutral",
  };
}

export function formatPaymentStatusLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
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

export function formatDeliveryDayLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
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
  const sessionBucket = formatDeliverySessionBucket(order.deliverySession, locale);
  const timeWindow = sessionBucket ?? formatTimeWindow(order, locale);
  return {
    detail: [weekday, timeWindow].filter(isPresent).join(", ") || null,
    label: order.deliveryDate,
    toneClass: "order-pill--day",
  };
}

export function formatOperationalStatus(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
  detail: string | null;
  label: string;
  meaning: string | null;
  toneClass: string;
} {
  const t = getOrdersCopy(locale);
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return {
      detail:
        order.routePlanName ?? humanizeToken(order.planningStatus, locale),
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
      detail: canGeocode
        ? t.statusDetails.useBulkGeocode
        : t.statusDetails.enterAddressOrCoordinates,
      label: canGeocode
        ? t.statusLabels.needCoordinates
        : t.statusLabels.missingAddress,
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

export function formatTableReadinessStatus(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): { label: string; toneClass: string } {
  const t = getOrdersCopy(locale);
  const isReady = isTableReadyOrder(order);
  return isReady
    ? { label: t.statusLabels.ready, toneClass: "order-pill--ready" }
    : { label: t.statusLabels.notReady, toneClass: "order-pill--review" };
}

function isTableReadyOrder(order: CanonicalOrderDto): boolean {
  if (order.routePlanId !== null || order.planningStatus !== "UNPLANNED") {
    return false;
  }
  if (isAddressReviewRequired(order) || isDeliveryDateReviewRequired(order)) {
    return false;
  }
  return (
    order.blockerReasons.length === 0 &&
    order.deliveryDate !== null &&
    hasResolvedCoordinates(order) &&
    order.metadataResolved === true &&
    order.routeEligible === true
  );
}

function statusMeaningForOrder(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string | null {
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
    return hasGeocodableAddress(order)
      ? t.missingCoordinates
      : t.missingAddress;
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

function formatRouteLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string {
  if (order.routePlanName !== null) return order.routePlanName;
  if (order.planningStatus === "UNPLANNED")
    return getOrdersCopy(locale).unplanned;
  return humanizeToken(order.planningStatus, locale);
}

export function getRouteRepairPrompt(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
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
      statusDetail:
        order.routePlanName ?? humanizeToken(order.planningStatus, locale),
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
      routeDetail: canGeocode
        ? t.statusLabels.needCoordinates
        : t.statusLabels.needAddress,
      statusDetail: canGeocode
        ? t.statusDetails.useBulkGeocode
        : t.statusDetails.enterAddressOrCoordinates,
      statusLabel: canGeocode
        ? t.statusLabels.needCoordinates
        : t.statusLabels.missingAddress,
    };
  }
  return {
    canGeocode: false,
    routeDetail: t.statusLabels.notRouteEligible,
    statusDetail: t.statusDetails.reviewRouteConstraints,
    statusLabel: t.statusLabels.notRouteEligible,
  };
}

function geocodeDetail(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string | null {
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

function geocodeMessageForCode(
  code: string,
  locale: string | null | undefined = "en-CA",
): string {
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

function formatTimeWindow(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string | null {
  if (isPresent(order.timeWindowStart) && isPresent(order.timeWindowEnd)) {
    return `${formatTime(order.timeWindowStart)}–${formatTime(order.timeWindowEnd)}`;
  }
  if (isPresent(order.deliverySession))
    return humanizeToken(order.deliverySession, locale);
  return null;
}

function formatDeliverySessionBucket(
  deliverySession: string | null,
  locale: string | null | undefined = "en-CA",
): string | null {
  if (!isPresent(deliverySession)) return null;
  const bucket = deliverySession.replace(/[_-]?delivery$/iu, "");
  return humanizeToken(bucket, locale);
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

function humanizeToken(
  value: string,
  locale: string | null | undefined = "en-CA",
): string {
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

function mostSpecificBlockerLabel(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): string | null {
  const t = getOrdersCopy(locale);
  const blockers = new Set(order.blockerReasons);
  if (isAddressReviewRequired(order)) return t.statusLabels.addressReview;
  if (isDeliveryDateReviewRequired(order))
    return t.statusLabels.deliveryDateReview;
  if (blockers.has("missing_delivery_date") || order.deliveryDate === null)
    return t.statusLabels.missingDeliveryDate;
  if (blockers.has("missing_delivery_area"))
    return t.statusLabels.missingDeliveryArea;
  if (blockers.has("missing_route_scope"))
    return t.statusLabels.missingRouteScope;
  if (
    [
      "delivery_day_unparsed",
      "ambiguous_delivery_day",
      "delivery_date_weekday_mismatch",
      "delivery_date_weekday_unverified",
    ].some((reason) => blockers.has(reason))
  )
    return t.statusLabels.deliveryDayUnclear;
  if (blockers.has("missing_time_window"))
    return t.statusLabels.missingTimeWindow;
  if (
    ["delivery_time_window_unparsed", "ambiguous_delivery_time_window"].some(
      (reason) => blockers.has(reason),
    )
  )
    return t.statusLabels.deliveryTimeUnclear;
  if (blockers.has("missing_coordinates"))
    return hasGeocodableAddress(order)
      ? t.statusLabels.needCoordinates
      : t.statusLabels.missingAddress;
  return null;
}

export function formatBlockerReason(
  reason: string,
  locale: string | null | undefined = "en-CA",
): string {
  const labels = getOrderDetailLabels(locale).blockerReasons;
  return (
    labels[reason as keyof typeof labels] ??
    getOrdersCopy(locale).routeConstraintFallback
  );
}

export function formatDiagnosticPathLabel(
  path: string,
  locale: string | null | undefined = "en-CA",
): string {
  const labels = getOrderDetailLabels(locale).diagnosticPaths;
  return (
    labels[path as keyof typeof labels] ??
    getOrdersCopy(locale).diagnosticMetadata
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
  customerNoteContext,
  diagnostics,
  id: panelId,
  initialEditMode,
  onClose,
  onSaveCustomerAdminMemo,
  onSaveMetadata,
  order,
  locale,
  sourceOptions,
}: {
  customerNoteContext: OrderCustomerNoteContextDto | null | undefined;
  diagnostics: DeliveryMetadataDiagnosticsDto | null | undefined;
  id: string;
  initialEditMode?: boolean;
  locale?: string | null;
  onClose(): void;
  onSaveCustomerAdminMemo?(
    profileId: string,
    adminMemo: string | null,
  ): Promise<void>;
  onSaveMetadata?(patch: OrderMetadataPatch): Promise<void>;
  order: CanonicalOrderDto;
  sourceOptions?: OrderSourceValueOptions | null;
}): ReactElement {
  const canPersistMetadata = onSaveMetadata !== undefined;
  const [editMode, setEditMode] = useState(initialEditMode ?? false);
  const [draft, setDraft] = useState<OrderMetadataPatch>(() =>
    metadataPatchFromOrder(order),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const deliveryCustomer = customerNoteContext?.deliveryCustomer ?? null;
  const customerNote = customerNoteContext?.customerNote ?? order.customerNote ?? null;
  const [adminMemoDraft, setAdminMemoDraft] = useState(
    () => deliveryCustomer?.adminMemo ?? "",
  );
  const [memoSaveError, setMemoSaveError] = useState<string | null>(null);
  const [memoSaveStatus, setMemoSaveStatus] = useState<string | null>(null);
  const [memoSaving, setMemoSaving] = useState(false);
  useEffect(() => {
    setAdminMemoDraft(deliveryCustomer?.adminMemo ?? "");
    setMemoSaveError(null);
    setMemoSaveStatus(null);
  }, [deliveryCustomer?.adminMemo, deliveryCustomer?.profileId]);
  const onSave = onSaveMetadata;
  const t = getOrdersCopy(locale);
  const fieldLabels = getOrderFieldLabels(locale);
  const status = formatOperationalStatus(order, locale);
  const blockers = order.blockerReasons.map((reason) =>
    formatBlockerReason(reason, locale),
  );
  const editableFields = useMemo(
    () => buildEditableMetadataFields(sourceOptions, locale, order),
    [locale, order, sourceOptions],
  );
  const repairFields = getOrderRepairFields(order, editableFields);
  const hasActionableRepair = repairFields.length > 0;
  const showRepairCard = hasActionableRepair || blockers.length > 0;
  const repairTitle = formatRepairCardTitle(repairFields, order, locale);
  const addressSummary = formatAddressSummary(order, locale);
  const orderItems = getOrderItems(order.items);
  const orderedItemLabels = orderItems.map(formatOrderItemLine);

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
  const saveAdminMemo = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      deliveryCustomer === null ||
      onSaveCustomerAdminMemo === undefined ||
      memoSaving
    )
      return;
    setMemoSaving(true);
    setMemoSaveError(null);
    setMemoSaveStatus(null);
    void onSaveCustomerAdminMemo(
      deliveryCustomer.profileId,
      adminMemoDraft.trim().length === 0 ? null : adminMemoDraft,
    )
      .then(() => {
        setMemoSaveStatus(t.memoSaved);
      })
      .catch((error: unknown) => {
        setMemoSaveError(readErrorMessage(error));
      })
      .finally(() => {
        setMemoSaving(false);
      });
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

      {showRepairCard ? (
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
              {hasActionableRepair ? t.needsReview : t.orderReadiness}
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
      ) : null}

      <div className="order-detail-summary-grid">
        <section className="order-detail-summary-card order-detail-summary-card--primary">
          <h4>{fieldLabels["line_items[0].name"]}</h4>
          {orderedItemLabels.length === 0 ? (
            <p>{order.orderName}</p>
          ) : (
            <ul className="order-detail-item-list">
              {orderedItemLabels.map((label, labelIndex) => (
                <li key={`${label}:${labelIndex}`}>{label}</li>
              ))}
            </ul>
          )}
          <small>
            {order.sourceOrderNumber ??
              order.sourceOrderId ??
              t.reviewIfRequired}
          </small>
        </section>
        <section className="order-detail-summary-card">
          <h4>{t.destination}</h4>
          <p>{addressSummary.primary}</p>
          {addressSummary.secondary === null ? null : (
            <small>{addressSummary.secondary}</small>
          )}
        </section>
      </div>

      <section className="order-detail-notes-grid" aria-label={t.customerOrderNote}>
        <article className="order-detail-note-card">
          <h4>{t.customerOrderNote}</h4>
          {customerNote === null ? (
            <p className="order-detail-muted">{t.customerOrderNoteEmpty}</p>
          ) : (
            <p className="order-detail-note-text">{customerNote}</p>
          )}
        </article>
        <form className="order-detail-note-card" onSubmit={saveAdminMemo}>
          <h4>{t.customerAdminMemo}</h4>
          <p className="order-detail-muted">{t.customerAdminMemoHint}</p>
          {customerNoteContext === undefined ? (
            <p>{t.loadingDetail}</p>
          ) : deliveryCustomer === null ? (
            <p className="order-detail-muted">
              {t.customerAdminMemoUnavailable}
            </p>
          ) : (
            <>
              <textarea
                aria-label={t.customerAdminMemo}
                onChange={(event) => setAdminMemoDraft(event.target.value)}
                placeholder={t.customerAdminMemoPlaceholder}
                rows={4}
                value={adminMemoDraft}
              />
              {memoSaveError === null ? null : (
                <p className="order-detail-error" role="alert">
                  {memoSaveError}
                </p>
              )}
              {memoSaveStatus === null ? null : (
                <p className="order-detail-success" role="status">
                  {memoSaveStatus}
                </p>
              )}
              <div className="orders-actions">
                <button
                  disabled={
                    onSaveCustomerAdminMemo === undefined || memoSaving
                  }
                  type="submit"
                >
                  {memoSaving ? t.saving : t.saveMemo}
                </button>
              </div>
            </>
          )}
        </form>
      </section>

      <section className="order-detail-items-card" aria-label={t.itemsTitle}>
        <h4>{t.itemsTitle}</h4>
        {orderItems.length === 0 ? (
          <p className="order-detail-items-empty">{t.noItems}</p>
        ) : (
          <div className="order-detail-items-table-scroll">
            <table className="order-detail-items-table">
              <thead>
                <tr>
                  <th>{t.item}</th>
                  <th>{t.itemOptions}</th>
                  <th>{t.sku}</th>
                  <th>{t.quantity}</th>
                </tr>
              </thead>
              <tbody>
                {orderItems.map((item, itemIndex) => (
                  <tr
                    key={getOrderItemDisplayKey(item, itemIndex)}
                  >
                    <td>{formatOrderItemName(item)}</td>
                    <td>{formatOrderItemOptions(item) || "—"}</td>
                    <td>{item.sku ?? "—"}</td>
                    <td>{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
            <p>
              {t.diagnosticsStatus}: {humanizeToken(diagnostics.status, locale)}
            </p>
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
                  <small>
                    {" "}
                    · {humanizeToken(candidate.parseStatus, locale)}
                  </small>
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
      {field.readOnly === true ? (
        <span
          aria-label={field.label}
          className="order-detail-readonly-value"
          data-readonly-field={field.key}
          id={inputId}
        >
          {value === null || value.trim() === ""
            ? "—"
            : humanizeToken(value, locale)}
        </span>
      ) : field.choices === undefined ? (
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

function formatChoiceOptionLabel(choice: MetadataChoice): string {
  if (choice.label === choice.value) return choice.label;
  return `${choice.label} · ${choice.value}`;
}

export function normalizeOrderMetadataPatchForFields(
  patch: OrderMetadataPatch,
  fields: EditableMetadataField[],
): OrderMetadataPatch {
  const normalized = { ...patch };
  for (const field of fields) {
    if (field.readOnly === true || field.choices === undefined) continue;
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
      field.readOnly !== true &&
      field.choices !== undefined &&
      !isActiveChoiceValue(field, draft[field.key]),
  );
}

function getSelectedChoiceValue(
  field: EditableMetadataField,
  value: string | null,
): string | null {
  if (field.readOnly === true) return value;
  return isActiveChoiceValue(field, value) ? value : null;
}

function isActiveChoiceValue(
  field: EditableMetadataField,
  value: string | null,
): value is string {
  if (field.readOnly === true || field.choices === undefined || value === null)
    return false;
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
  locale: string | null | undefined = "en-CA",
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

function formatAddressSummary(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
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

function formatCoordinateSummary(
  order: CanonicalOrderDto,
  locale: string | null | undefined = "en-CA",
): {
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

export function filterOrdersByRoutePlan(
  orders: CanonicalOrderDto[],
  routePlanId: string | null,
): CanonicalOrderDto[] | null {
  if (routePlanId === null) return null;
  return orders.filter((order) => order.routePlanId === routePlanId);
}

export function buildRouteDetailPath(routePlanId: string): string {
  return `/admin/ui/app/routes/${encodeURIComponent(routePlanId)}`;
}

function orderSelectedOrdersByDraft(
  selectedOrders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>,
): CanonicalOrderDto[] {
  const ordersById = new Map(
    selectedOrders.map((order) => [order.orderId, order]),
  );
  return [...selectedOrderIds]
    .map((orderId) => ordersById.get(orderId))
    .filter((order): order is CanonicalOrderDto => order !== undefined);
}

export function buildOrderMapMarkerStates(input: {
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
    if (
      input.filters.scope === "history" ||
      input.worksetContext.scope === "history"
    ) {
      markerStates.set(order.orderId, {
        markerOpacity: 1,
        pinKind: "history",
        sequence: null,
      });
      continue;
    }
    const isPlanned = isRouteMapPlanned(order);
    const needsReview = isRouteMapReviewOrder(order);
    markerStates.set(order.orderId, {
      markerOpacity: 1,
      pinKind: isPlanned
        ? "candidate"
        : needsReview
          ? "review"
          : sequence !== null
            ? "candidate"
            : "unplanned",
      sequence,
    });
  }
  return markerStates;
}

function isRouteMapPlanned(order: CanonicalOrderDto): boolean {
  return order.routePlanId !== null || order.planningStatus !== "UNPLANNED";
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

function normalizeRouteFilterValue(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "all") return null;
  return trimmed;
}

function getWeekdayFilterOptions(
  locale: string | null | undefined,
): Array<{ label: string; value: NonNullable<OrderFilterState["weekday"]> }> {
  return resolveLocale(locale) === "ko-KR"
    ? [
        { label: "일", value: "sun" },
        { label: "월", value: "mon" },
        { label: "화", value: "tue" },
        { label: "수", value: "wed" },
        { label: "목", value: "thu" },
        { label: "금", value: "fri" },
        { label: "토", value: "sat" },
      ]
    : [
        { label: "Sunday", value: "sun" },
        { label: "Monday", value: "mon" },
        { label: "Tuesday", value: "tue" },
        { label: "Wednesday", value: "wed" },
        { label: "Thursday", value: "thu" },
        { label: "Friday", value: "fri" },
        { label: "Saturday", value: "sat" },
      ];
}

function buildActualTypeFilterOptions(
  values: string[],
  locale: string | null | undefined,
): Array<{ label: string; value: string }> {
  return values.map((value) => ({
    label: humanizeToken(value, locale),
    value,
  }));
}

function formatRouteDraftDateLabel(
  selectedOrders: CanonicalOrderDto[],
  locale: string | null | undefined,
): string {
  const t = getOrdersCopy(locale);
  if (selectedOrders.length === 0) return t.dateFallback;
  const date = getRouteDraftSingleDeliveryDate(selectedOrders);
  if (date !== null) return date;
  return hasMissingRouteDate(selectedOrders)
    ? t.routeDraft.missingRequiredShort
    : t.mixed;
}

function formatRouteDraftTypeLabel(
  selectedOrders: CanonicalOrderDto[],
  locale: string | null | undefined,
): string {
  const t = getOrdersCopy(locale);
  if (selectedOrders.length === 0) return t.typeFallback;
  const type = getRouteDraftSingleType(selectedOrders);
  if (type !== null) return formatRoutePlanningType(type, locale);
  return hasMissingRouteType(selectedOrders)
    ? t.routeDraft.missingRequiredShort
    : t.mixed;
}

export function buildVisibleSelectedOrderIds(
  visibleOrders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>,
): string[] {
  return visibleOrders
    .filter((order) => selectedOrderIds.has(order.orderId))
    .map((order) => order.orderId);
}

export function buildRouteDraftSelection(
  orders: CanonicalOrderDto[],
  requestedSelectedOrderIds: ReadonlySet<string>,
  locale: string | null | undefined = "en-CA",
): {
  deliveryDate: string | null;
  orderIds: string[];
  routeType: OrderRouteTypeFilter | null;
  warning: string | null;
} {
  const ordersById = new Map(orders.map((order) => [order.orderId, order]));
  const requestedOrders = [...requestedSelectedOrderIds]
    .map((orderId) => ordersById.get(orderId))
    .filter((order): order is CanonicalOrderDto => order !== undefined);

  return {
    deliveryDate: getRouteDraftSingleDeliveryDate(requestedOrders),
    orderIds: requestedOrders.map((order) => order.orderId),
    routeType: getRouteDraftSingleType(requestedOrders),
    warning: null,
  };
}

export function getRouteDraftCreateReasons(
  selectedOrders: CanonicalOrderDto[],
  locale: string | null | undefined = "en-CA",
): string[] {
  if (selectedOrders.length === 0) return [];
  const t = getOrdersCopy(locale).routeDraft;
  const reasons: string[] = [];
  const hasMissingRequired = selectedOrders.some(
    (order) =>
      normalizeRouteFilterValue(order.deliveryDate) === null ||
      getOrderRouteType(order) === null,
  );
  if (hasMissingRequired) reasons.push(t.missingRequired);
  if (
    countUniquePresent(selectedOrders.map((order) => order.deliveryDate)) > 1
  ) {
    reasons.push(t.dateMustMatch);
  }
  if (countUniquePresent(selectedOrders.map(getOrderRouteType)) > 1) {
    reasons.push(t.selectedMustShareType);
  }
  return reasons;
}

export function getRouteDraftFirstCreateReason(
  selectedOrders: CanonicalOrderDto[],
  locale: string | null | undefined = "en-CA",
): string | null {
  return getRouteDraftCreateReasons(selectedOrders, locale)[0] ?? null;
}

function getRouteDraftSingleDeliveryDate(
  orders: CanonicalOrderDto[],
): string | null {
  const dates = uniquePresentValues(orders.map((order) => order.deliveryDate));
  return dates.length === 1 ? (dates[0] ?? null) : null;
}

function getRouteDraftSingleType(
  orders: CanonicalOrderDto[],
): OrderRouteTypeFilter | null {
  const types = [
    ...new Set(
      orders
        .map(getOrderRouteType)
        .filter((value): value is OrderRouteTypeFilter => value !== null),
    ),
  ];
  return types.length === 1 ? (types[0] ?? null) : null;
}

function countUniquePresent(values: Array<string | null | undefined>): number {
  return uniquePresentValues(values).length;
}

function uniquePresentValues(
  values: Array<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      values
        .map(normalizeRouteFilterValue)
        .filter((value): value is string => value !== null),
    ),
  ];
}

function hasMissingRouteDate(orders: CanonicalOrderDto[]): boolean {
  return orders.some(
    (order) => normalizeRouteFilterValue(order.deliveryDate) === null,
  );
}

function hasMissingRouteType(orders: CanonicalOrderDto[]): boolean {
  return orders.some((order) => getOrderRouteType(order) === null);
}

function formatRoutePlanningType(
  value: OrderRouteTypeFilter,
  locale: string | null | undefined,
): string {
  return humanizeToken(value, locale);
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
