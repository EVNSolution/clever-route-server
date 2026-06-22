import type {
  BootstrapPayload,
  CanonicalOrderDto,
  MapProviderStatus,
  RoutePlanDetailDto,
  RouteStopDto,
  StoreSettingsDto
} from './types';
import type { RouteOpsPoint } from './maps/geojson';
import { getStateCopy } from './i18n';

export type OrderFilters = {
  deliveryArea?: string;
  deliveryDate?: string;
  deliveryDates?: string;
  deliverySession?: string;
  deliveryStatus?: string;
  routeType?: OrderRouteTypeFilter | '';
  search?: string;
  scope?: OrderScopeFilter;
  serviceType?: string;
  status?: OrderPlanningStatusFilter;
  tab?: OrderTabFilter;
  weekday?: OrderWeekdayFilter | '';
};

export type OrderScopeFilter = 'planning' | 'history';
export type OrderTabFilter = 'all' | 'unplanned' | 'planned' | 'needs_review';
export type OrderPlanningStatusFilter = '' | 'planned' | 'unplanned';
export type OrderRouteTypeFilter = string;
export type OrderWeekdayFilter =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type OrderFilterState = Required<Omit<OrderFilters, 'status'>> & {
  status: OrderPlanningStatusFilter;
};

export type OrderWorksetContext = {
  routeScopeKey?: string | null;
  routeDate?: string | null;
  scope?: OrderScopeFilter;
  today?: string;
};

export type OrderWorksetUnavailableReason =
  | 'already_planned'
  | 'address_review'
  | 'completed_or_cancelled'
  | 'delivery_date_review'
  | 'different_delivery_date'
  | 'different_route_scope'
  | 'missing_address'
  | 'missing_coordinates'
  | 'missing_delivery_date'
  | 'missing_route_scope'
  | 'needs_review';

export type OrderWorksetReason = {
  code: OrderWorksetUnavailableReason;
  label: string;
};

export type OrderWorksetSummary = {
  reasonLabels: string[];
  reasonsByCode: Record<OrderWorksetUnavailableReason, number>;
  selectableCount: number;
  selectableOrderIds: string[];
  selectedCount: number;
  unavailableCount: number;
};

export const ORDER_WORKSET_REASON_LABELS: Record<
  OrderWorksetUnavailableReason,
  string
> = {
  already_planned: 'Already planned',
  address_review: 'Address Review',
  completed_or_cancelled: 'Completed/cancelled',
  delivery_date_review: 'Delivery date review',
  different_delivery_date: 'Different delivery date',
  different_route_scope: 'Different delivery session',
  missing_address: 'Missing address',
  missing_coordinates: 'Missing coordinates',
  missing_delivery_date: 'Missing delivery date',
  missing_route_scope: 'Missing route scope',
  needs_review: 'Other metadata review'
};

export function createDefaultOrderFilters(): OrderFilterState {
  return {
    deliveryArea: '',
    deliveryDate: '',
    deliveryDates: '',
    deliverySession: '',
    deliveryStatus: '',
    routeType: '',
    scope: 'planning',
    search: '',
    serviceType: '',
    status: '',
    tab: 'all',
    weekday: ''
  };
}

export function buildOrderQuery(filters: OrderFilters): string {
  const params = new URLSearchParams();
  setParam(params, 'deliveryDate', filters.deliveryDate);
  setParam(params, 'deliveryDates', filters.deliveryDates);
  setParam(params, 'deliveryArea', filters.deliveryArea);
  setParam(params, 'deliveryStatus', filters.deliveryStatus);
  setRequiredParam(params, 'scope', filters.scope);
  setRequiredParam(params, 'tab', filters.tab);
  if (filters.tab === undefined) setParam(params, 'status', filters.status);
  setParam(params, 'serviceType', filters.serviceType);
  setParam(params, 'deliverySession', filters.deliverySession);
  setParam(params, 'search', filters.search);
  return params.toString();
}

export function buildOrderFetchQuery(filters: OrderFilters): string {
  const {
    deliveryArea: _deliveryArea,
    deliveryDate: _deliveryDate,
    deliveryDates: _deliveryDates,
    deliverySession: _deliverySession,
    serviceType: _serviceType,
    routeType: _routeType,
    status: _status,
    tab: _tab,
    weekday: _weekday,
    ...serverFilters
  } = filters;
  return buildOrderQuery(serverFilters);
}

export function buildAreaOptionSourceFilters(filters: OrderFilters): OrderFilters {
  return { ...filters, deliveryArea: '' };
}

export function deriveAreaFilterOptions(orders: CanonicalOrderDto[]): string[] {
  return Array.from(
    new Set(
      orders
        .map((order) => order.deliveryArea?.trim() ?? '')
        .filter((area) => area !== '')
    )
  ).sort((first, second) => first.localeCompare(second));
}

export type OrderFacetedFilterKey =
  | 'deliveryArea'
  | 'deliveryDate'
  | 'deliveryDates'
  | 'weekday'
  | 'routeType';

export type OrderFilterOptionSets = {
  deliveryAreas: string[];
  deliveryDates: string[];
  routeTypes: string[];
  weekdays: OrderWeekdayFilter[];
};

export type OrderSourceValueOptions = {
  deliverySessions: string[];
  serviceTypes: string[];
};

export function applyClientOrderFiltersExcept(
  orders: CanonicalOrderDto[],
  filters: OrderFilters,
  excludedField: OrderFacetedFilterKey
): CanonicalOrderDto[] {
  return applyClientOrderFilters(orders, { ...filters, [excludedField]: '' });
}

export function deriveOrderFilterOptions(
  orders: CanonicalOrderDto[],
  filters: OrderFilters,
  filterOrder: OrderFacetedFilterKey[] = []
): OrderFilterOptionSets {
  const dateOptionFilters = isAutoFilledWeekday(filters, filterOrder)
    ? { ...filters, weekday: '' as const }
    : filters;
  const areaOrders = applyClientOrderFiltersExcept(
    orders,
    filters,
    'deliveryArea'
  );
  const dateOrders = applyClientOrderFilters(orders, {
    ...dateOptionFilters,
    deliveryDate: '',
    deliveryDates: ''
  });
  const weekdayOrders = applyClientOrderFilters(orders, {
    ...filters,
    deliveryDate: '',
    deliveryDates: '',
    weekday: ''
  });
  const typeOrders = applyClientOrderFiltersExcept(
    orders,
    filters,
    'routeType'
  );
  return {
    deliveryAreas: deriveAreaFilterOptions(areaOrders),
    deliveryDates: uniqueSortedValues(
      dateOrders.map((order) => order.deliveryDate)
    ),
    routeTypes: uniqueSortedValues(typeOrders.map(getOrderSourceType)),
    weekdays: uniqueSortedWeekdays(weekdayOrders.map(getOrderDeliveryWeekday))
  };
}

export function deriveOrderSourceValueOptions(
  orders: CanonicalOrderDto[],
  selectedOrder?: CanonicalOrderDto | null
): OrderSourceValueOptions {
  const withSelected =
    selectedOrder === null || selectedOrder === undefined
      ? orders
      : [...orders, selectedOrder];
  return {
    deliverySessions: uniqueSortedValues(
      withSelected.map((order) => order.deliverySession)
    ),
    serviceTypes: uniqueSortedValues(
      withSelected.map((order) => order.serviceType)
    )
  };
}

export function mergeOrderListsById(
  primary: CanonicalOrderDto[],
  secondary: CanonicalOrderDto[]
): CanonicalOrderDto[] {
  if (secondary.length === 0) return primary;
  const merged = new Map<string, CanonicalOrderDto>();
  for (const order of secondary) merged.set(order.orderId, order);
  for (const order of primary) merged.set(order.orderId, order);
  return [...merged.values()];
}

export function hasSelectedDeliveryDates(filters: OrderFilters): boolean {
  return (
    normalizeFilterValue(filters.deliveryDate) !== null ||
    parseDeliveryDateSet(filters.deliveryDates).length > 0
  );
}

export function selectOrdersForClientFilters(
  currentOrders: CanonicalOrderDto[],
  historyOrders: CanonicalOrderDto[],
  filters: OrderFilters
): CanonicalOrderDto[] {
  if (filters.scope !== 'planning' || !hasSelectedDeliveryDates(filters)) {
    return currentOrders;
  }
  return mergeOrderListsById(currentOrders, historyOrders);
}

export function toggleWeekdayDeliveryDates(input: {
  availableDates: string[];
  currentDeliveryDates: string;
  weekday: OrderWeekdayFilter;
}): string {
  const selected = new Set(parseDeliveryDateSet(input.currentDeliveryDates));
  const matchingDates = uniqueSortedValues(
    input.availableDates.filter(
      (deliveryDate) => weekdayForDeliveryDate(deliveryDate) === input.weekday
    )
  );
  if (matchingDates.length === 0) return serializeDeliveryDateSet([...selected]);
  const remove = matchingDates.every((deliveryDate) => selected.has(deliveryDate));
  for (const deliveryDate of matchingDates) {
    if (remove) selected.delete(deliveryDate);
    else selected.add(deliveryDate);
  }
  return serializeDeliveryDateSet([...selected]);
}

export function weekdayForDeliveryDate(
  value: string | null | undefined
): OrderWeekdayFilter | null {
  const normalized = normalizeFilterValue(value);
  if (normalized === null) return null;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return WEEKDAY_FILTERS[date.getUTCDay()] ?? null;
}

export function reconcileOrderFilters(input: {
  changedField: OrderFacetedFilterKey;
  filters: OrderFilterState;
  orders: CanonicalOrderDto[];
  previousOrder: OrderFacetedFilterKey[];
}): { filters: OrderFilterState; order: OrderFacetedFilterKey[] } {
  let next = { ...input.filters };
  let order = [
    ...input.previousOrder.filter((field) => field !== input.changedField),
    input.changedField
  ];

  if (input.changedField === 'deliveryDate') {
    next.deliveryDates = '';
    const weekday = weekdayForDeliveryDate(next.deliveryDate);
    next.weekday = weekday ?? '';
    if (weekday !== null) {
      order = order.filter((field) => field !== 'weekday');
    }
  }

  if (input.changedField === 'deliveryDates') {
    next.deliveryDate = '';
    const weekday = weekdayForDeliveryDates(next.deliveryDates);
    next.weekday = weekday ?? '';
    if (weekday !== null) {
      order = order.filter((field) => field !== 'weekday');
    }
  }

  if (input.changedField === 'weekday' && next.weekday !== '') {
    const availableDates = uniqueSortedValues(
      applyClientOrderFilters(input.orders, {
        ...next,
        deliveryDate: '',
        deliveryDates: '',
        weekday: ''
      }).map((order) => order.deliveryDate)
    );
    next.deliveryDate = '';
    next.deliveryDates = toggleWeekdayDeliveryDates({
      availableDates,
      currentDeliveryDates: next.deliveryDates,
      weekday: next.weekday
    });
    order = order.filter(
      (field) => field !== 'deliveryDate' && field !== 'deliveryDates'
    );
    if (parseDeliveryDateSet(next.deliveryDates).length > 0) {
      order.push('deliveryDates');
    }
  }

  return pruneOrderFilters({ filters: next, orders: input.orders, order });
}

export function pruneOrderFilters(input: {
  filters: OrderFilterState;
  orders: CanonicalOrderDto[];
  order: OrderFacetedFilterKey[];
}): { filters: OrderFilterState; order: OrderFacetedFilterKey[] } {
  let next = { ...input.filters };
  const authoredWeekday = input.order.includes('weekday');
  if (
    !authoredWeekday &&
    normalizeFilterValue(next.deliveryDate) === null &&
    parseDeliveryDateSet(next.deliveryDates).length === 0
  ) {
    next.weekday = '';
  }
  const remainingOrder: OrderFacetedFilterKey[] = [];
  for (const field of input.order) {
    const value = normalizeFilterValue(next[field]);
    if (value === null) continue;
    if (isFilterValueAvailable(input.orders, next, field, value)) {
      remainingOrder.push(field);
      continue;
    }
    next = { ...next, [field]: '' };
  }
  const syncedWeekday =
    parseDeliveryDateSet(next.deliveryDates).length > 0
      ? weekdayForDeliveryDates(next.deliveryDates)
      : weekdayForDeliveryDate(next.deliveryDate);
  if (syncedWeekday !== null && next.weekday !== syncedWeekday) {
    next.weekday = syncedWeekday;
  }
  if (syncedWeekday === null && !authoredWeekday) {
    next.weekday = '';
  }
  return { filters: next, order: remainingOrder };
}

function isAutoFilledWeekday(
  filters: OrderFilters,
  filterOrder: OrderFacetedFilterKey[]
): boolean {
  return (
    (normalizeFilterValue(filters.deliveryDate) !== null ||
      parseDeliveryDateSet(filters.deliveryDates).length > 0) &&
    normalizeFilterValue(filters.weekday) !== null &&
    !filterOrder.includes('weekday')
  );
}

function isFilterValueAvailable(
  orders: CanonicalOrderDto[],
  filters: OrderFilters,
  field: OrderFacetedFilterKey,
  value: string
): boolean {
  const options = deriveOrderFilterOptions(orders, filters);
  if (field === 'deliveryArea')
    return options.deliveryAreas.some(
      (area) => area.toLowerCase() === value.toLowerCase()
    );
  if (field === 'deliveryDate') return options.deliveryDates.includes(value);
  if (field === 'deliveryDates') {
    const selectedDates = parseDeliveryDateSet(value);
    return (
      selectedDates.length > 0 &&
      selectedDates.every((date) => options.deliveryDates.includes(date))
    );
  }
  if (field === 'routeType') return options.routeTypes.includes(value);
  return options.weekdays.includes(value as OrderWeekdayFilter);
}

function uniqueSortedValues(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeFilterValue(value))
        .filter((value): value is string => value !== null)
    )
  ).sort((first, second) => first.localeCompare(second));
}

function uniqueSortedWeekdays(
  values: Array<OrderWeekdayFilter | null | undefined>
): OrderWeekdayFilter[] {
  const present = new Set(
    values.filter(
      (value): value is OrderWeekdayFilter =>
        value !== null && value !== undefined
    )
  );
  return WEEKDAY_FILTERS.filter((weekday) => present.has(weekday));
}

export function applyClientOrderFilters(
  orders: CanonicalOrderDto[],
  filters: OrderFilters
): CanonicalOrderDto[] {
  if (!hasActiveClientOrderFilter(filters)) return orders;
  return orders.filter((order) => {
    const deliveryDates = parseDeliveryDateSet(filters.deliveryDates);
    if (deliveryDates.length > 0) {
      if (order.deliveryDate === null || !deliveryDates.includes(order.deliveryDate)) return false;
    } else {
      const deliveryDate = normalizeFilterValue(filters.deliveryDate);
      if (deliveryDate !== null && order.deliveryDate !== deliveryDate) return false;
    }

    const weekday = normalizeFilterValue(filters.weekday);
    if (weekday !== null && getOrderDeliveryWeekday(order) !== weekday) return false;

    const routeType = normalizeFilterValue(filters.routeType);
    if (routeType !== null && getOrderSourceType(order) !== routeType) return false;

    const serviceType = normalizeFilterValue(filters.serviceType);
    if (serviceType !== null && order.serviceType !== serviceType) return false;

    const deliverySession = normalizeFilterValue(filters.deliverySession);
    if (deliverySession !== null && order.deliverySession !== deliverySession) return false;

    const tab = filters.tab;
    if (tab !== undefined && tab !== 'all' && !matchesClientOrderTab(order, tab)) {
      return false;
    }

    const planningStatus = normalizeFilterValue(filters.status);
    if (planningStatus === 'planned' && !isPlannedOrder(order)) return false;
    if (planningStatus === 'unplanned' && isPlannedOrder(order)) return false;

    const deliveryStatus = normalizeFilterValue(filters.deliveryStatus);
    if (deliveryStatus !== null && order.deliveryStatus !== deliveryStatus) {
      return false;
    }

    const deliveryArea = normalizeFilterValue(filters.deliveryArea);
    if (
      deliveryArea !== null &&
      order.deliveryArea?.toLowerCase() !== deliveryArea.toLowerCase()
    ) {
      return false;
    }

    const search = normalizeFilterValue(filters.search);
    if (search !== null && !matchesOrderSearch(order, search)) return false;

    return true;
  });
}

function hasActiveClientOrderFilter(filters: OrderFilters): boolean {
  return (
    normalizeFilterValue(filters.deliveryArea) !== null ||
    normalizeFilterValue(filters.deliveryDate) !== null ||
    parseDeliveryDateSet(filters.deliveryDates).length > 0 ||
    normalizeFilterValue(filters.deliverySession) !== null ||
    normalizeFilterValue(filters.deliveryStatus) !== null ||
    normalizeFilterValue(filters.routeType) !== null ||
    normalizeFilterValue(filters.search) !== null ||
    normalizeFilterValue(filters.serviceType) !== null ||
    normalizeFilterValue(filters.status) !== null ||
    normalizeFilterValue(filters.weekday) !== null ||
    (filters.tab !== undefined && filters.tab !== 'all')
  );
}

export const WEEKDAY_FILTERS: OrderWeekdayFilter[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat'
];

export function parseDeliveryDateSet(value: string | null | undefined): string[] {
  const normalized = normalizeFilterValue(value);
  if (normalized === null) return [];
  return uniqueSortedValues(normalized.split(','));
}

export function serializeDeliveryDateSet(values: Array<string | null | undefined>): string {
  return uniqueSortedValues(values).join(',');
}

export function weekdayForDeliveryDates(value: string | null | undefined): OrderWeekdayFilter | null {
  const weekdays = new Set(parseDeliveryDateSet(value).map(weekdayForDeliveryDate));
  weekdays.delete(null);
  return weekdays.size === 1 ? [...weekdays][0] ?? null : null;
}

export function getOrderDeliveryWeekday(order: CanonicalOrderDto): OrderWeekdayFilter | null {
  if (order.deliveryDate === null) return null;
  const date = new Date(`${order.deliveryDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return WEEKDAY_FILTERS[date.getUTCDay()] ?? null;
}

export function getOrderSourceType(order: CanonicalOrderDto): string | null {
  return (
    normalizeFilterValue(order.serviceType) ??
    normalizeFilterValue(order.deliverySession)
  );
}

export function getOrderRouteType(order: CanonicalOrderDto): OrderRouteTypeFilter | null {
  const serviceType = normalizeFilterValue(order.serviceType)?.toUpperCase();
  if (serviceType === 'PICKUP') return 'pickup';
  if (serviceType === 'EVENING_DELIVERY') return 'evening_delivery';
  if (serviceType === 'DELIVERY') return 'delivery';

  const deliverySession = normalizeFilterValue(order.deliverySession)?.toUpperCase();
  if (deliverySession === 'PICKUP') return 'pickup';
  if (deliverySession === 'EVENING') return 'evening_delivery';
  if (deliverySession === 'DAY') return 'delivery';
  return null;
}

function normalizeFilterValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'all') return null;
  return trimmed;
}

function matchesClientOrderTab(order: CanonicalOrderDto, tab: Exclude<OrderTabFilter, 'all'>): boolean {
  if (tab === 'planned') return isPlannedOrder(order);
  if (tab === 'needs_review') return isNeedsReviewOrder(order);
  return !isPlannedOrder(order) && isRoutePlanEligibleForWorkset(order);
}

function matchesOrderSearch(order: CanonicalOrderDto, search: string): boolean {
  const needle = search.toLowerCase();
  return [
    order.orderName,
    order.sourceOrderNumber,
    order.sourceOrderId,
    order.recipientName,
    order.phone,
    order.deliveryArea,
    order.shippingAddress.address1,
    order.shippingAddress.address2,
    order.shippingAddress.city,
    order.shippingAddress.province,
    order.shippingAddress.postalCode
  ].some((value) => value?.toLowerCase().includes(needle) === true);
}

export function matchesPlanningScope(
  order: CanonicalOrderDto,
  today: string
): boolean {
  if (isCompletedOrCancelledOrder(order)) return false;
  if (order.deliveryDate !== null) return order.deliveryDate >= today;
  return isNeedsReviewOrder(order);
}

export function matchesOrderTab(
  order: CanonicalOrderDto,
  tab: OrderTabFilter,
  today: string
): boolean {
  if (!matchesPlanningScope(order, today)) return false;
  if (tab === 'all')
    return (
      matchesOrderTab(order, 'unplanned', today) ||
      matchesOrderTab(order, 'planned', today) ||
      matchesOrderTab(order, 'needs_review', today)
    );
  if (tab === 'planned') return isPlannedOrder(order);
  if (tab === 'needs_review') return isNeedsReviewOrder(order);
  return !isPlannedOrder(order) && isRoutePlanEligibleForWorkset(order);
}

export function getOrderWorksetUnavailableReasons(
  order: CanonicalOrderDto,
  context: OrderWorksetContext = {}
): OrderWorksetReason[] {
  const reasons = new Set<OrderWorksetUnavailableReason>();
  if (isCompletedOrCancelledOrder(order)) reasons.add('completed_or_cancelled');
  if (isPlannedOrder(order)) reasons.add('already_planned');
  if (isDeliveryDateReviewRequired(order)) {
    reasons.add('delivery_date_review');
  } else if (order.deliveryDate === null) {
    reasons.add('missing_delivery_date');
  }
  if (!hasRouteScope(order)) reasons.add('missing_route_scope');
  if (!hasResolvedCoordinates(order)) {
    reasons.add(readCoordinateUnavailableReason(order));
  }
  if (hasUnrepresentedNeedsReviewReason(order, reasons)) {
    reasons.add('needs_review');
  }
  if (
    context.routeDate !== undefined &&
    context.routeDate !== null &&
    order.deliveryDate !== null &&
    order.deliveryDate !== context.routeDate
  ) {
    reasons.add('different_delivery_date');
  }
  const routeScopeKey = getRouteScopeKey(order);
  if (
    context.routeScopeKey !== undefined &&
    context.routeScopeKey !== null &&
    routeScopeKey !== null &&
    routeScopeKey !== context.routeScopeKey
  ) {
    reasons.add('different_route_scope');
  }
  return [...reasons].map((code) => ({
    code,
    label: ORDER_WORKSET_REASON_LABELS[code]
  }));
}

export function formatOrderWorksetUnavailableReasons(
  reasons: OrderWorksetReason[],
  locale: string | null | undefined = 'en-CA'
): OrderWorksetReason[] {
  const labels = getStateCopy(locale).worksetReasons;
  return reasons.map((reason) => ({ ...reason, label: labels[reason.code] }));
}

export function isOrderWorksetEligible(
  order: CanonicalOrderDto,
  context: OrderWorksetContext = {}
): boolean {
  return (
    getOrderWorksetUnavailableReasons(order, context).length === 0 &&
    isRoutePlanEligibleForWorkset(order)
  );
}

export function summarizeOrderWorkset(
  orders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>,
  context: OrderWorksetContext = {},
  locale: string | null | undefined = 'en-CA'
): OrderWorksetSummary {
  const labels = getStateCopy(locale).worksetReasons;
  const reasonsByCode = Object.fromEntries(
    Object.keys(ORDER_WORKSET_REASON_LABELS).map((code) => [code, 0])
  ) as Record<OrderWorksetUnavailableReason, number>;
  const selectableOrderIds: string[] = [];
  for (const order of orders) {
    const reasons = getOrderWorksetUnavailableReasons(order, context);
    if (reasons.length === 0 && isRoutePlanEligibleForWorkset(order)) {
      selectableOrderIds.push(order.orderId);
      continue;
    }
    for (const reason of reasons) reasonsByCode[reason.code] += 1;
  }
  const reasonLabels = (
    Object.entries(reasonsByCode) as Array<
      [OrderWorksetUnavailableReason, number]
    >
  )
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${labels[code]} ${count}`);
  return {
    reasonLabels,
    reasonsByCode,
    selectableCount: selectableOrderIds.length,
    selectableOrderIds,
    selectedCount: selectableOrderIds.filter((orderId) =>
      selectedOrderIds.has(orderId)
    ).length,
    unavailableCount: orders.length - selectableOrderIds.length
  };
}

export function summarizeSelection(
  orders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>
): {
  blockers: string[];
  readySelected: CanonicalOrderDto[];
} {
  const selected = orders.filter((order) => selectedOrderIds.has(order.orderId));
  const blockers = selected.flatMap((order) =>
    order.blockerReasons.map((reason) => `${order.orderName}: ${reason}`)
  );
  return {
    blockers,
    readySelected: selected.filter(
      (order) =>
        order.blockerReasons.length === 0 &&
        order.planningStatus === 'UNPLANNED'
    )
  };
}

function isRoutePlanEligibleForWorkset(order: CanonicalOrderDto): boolean {
  if (isPlannedOrder(order)) return false;
  return (
    order.routeEligible === true ||
    (order.routeEligible !== false &&
      order.blockerReasons.length === 0 &&
      order.planningStatus === 'UNPLANNED' &&
      hasRouteScope(order) &&
      order.deliveryDate !== null &&
      hasResolvedCoordinates(order))
  );
}

function isPlannedOrder(order: CanonicalOrderDto): boolean {
  return order.routePlanId !== null || order.planningStatus !== 'UNPLANNED';
}

function isNeedsReviewOrder(order: CanonicalOrderDto): boolean {
  return (
    order.health === 'needs_review' ||
    order.metadataResolved === false ||
    order.routeEligible === false ||
    order.blockerReasons.length > 0 ||
    order.deliveryDate === null ||
    !hasRouteScope(order) ||
    !hasResolvedCoordinates(order)
  );
}

const BLOCKER_WORKSET_REASON_MAP: Partial<
  Record<string, OrderWorksetUnavailableReason>
> = {
  ambiguous_delivery_day: 'delivery_date_review',
  delivery_date_weekday_mismatch: 'delivery_date_review',
  delivery_date_weekday_unverified: 'delivery_date_review',
  delivery_day_unparsed: 'delivery_date_review',
  missing_address: 'missing_address',
  missing_coordinates: 'missing_coordinates',
  missing_delivery_date: 'missing_delivery_date',
  missing_route_scope: 'missing_route_scope'
};

function hasUnrepresentedNeedsReviewReason(
  order: CanonicalOrderDto,
  reasons: ReadonlySet<OrderWorksetUnavailableReason>
): boolean {
  const hasSpecificMetadataReason =
    reasons.has('address_review') ||
    reasons.has('delivery_date_review') ||
    reasons.has('missing_address') ||
    reasons.has('missing_coordinates') ||
    reasons.has('missing_delivery_date') ||
    reasons.has('missing_route_scope');
  const hasUnrepresentedBlocker = order.blockerReasons.some((blocker) => {
    if (blocker === 'missing_coordinates' && reasons.has('address_review')) {
      return false;
    }
    if (blocker === 'missing_delivery_date' && reasons.has('delivery_date_review')) {
      return false;
    }
    const mappedReason = BLOCKER_WORKSET_REASON_MAP[blocker];
    return mappedReason === undefined || !reasons.has(mappedReason);
  });
  if (hasUnrepresentedBlocker) return true;
  if (
    order.health === 'needs_review' ||
    order.metadataResolved === false ||
    order.routeEligible === false
  ) {
    return !hasSpecificMetadataReason;
  }
  return false;
}

function isCompletedOrCancelledOrder(order: CanonicalOrderDto): boolean {
  return (
    order.deliveryStatus === 'completed' ||
    order.status === 'cancelled' ||
    order.status === 'CANCELLED'
  );
}

function hasRouteScope(order: CanonicalOrderDto): boolean {
  return isPresent(order.serviceType) && isPresent(order.deliverySession);
}

function getRouteScopeKey(order: CanonicalOrderDto): string | null {
  if (!hasRouteScope(order) || order.deliveryDate === null) return null;
  return [
    order.deliveryDate,
    order.serviceType,
    order.deliverySession,
    order.timeWindowStart ?? '',
    order.timeWindowEnd ?? ''
  ].join('|');
}

function hasResolvedCoordinates(order: CanonicalOrderDto): boolean {
  return (
    typeof order.coordinates.latitude === 'number' &&
    Number.isFinite(order.coordinates.latitude) &&
    typeof order.coordinates.longitude === 'number' &&
    Number.isFinite(order.coordinates.longitude)
  );
}

function readCoordinateUnavailableReason(
  order: CanonicalOrderDto
): OrderWorksetUnavailableReason {
  if (!hasGeocodableAddress(order)) return 'missing_address';
  return isAddressReviewRequired(order) ? 'address_review' : 'missing_coordinates';
}

export function isAddressReviewRequired(order: CanonicalOrderDto): boolean {
  if (hasResolvedCoordinates(order)) return false;
  if (!hasGeocodableAddress(order)) return false;
  if (order.geocodeStatus !== 'FAILED') return false;
  const diagnostics = order.geocodeDiagnostics;
  if (diagnostics === undefined || diagnostics === null) return false;
  const code = diagnostics.code ?? diagnostics.messageKey;
  if (code !== 'GEOCODER_NO_RESULT') return false;
  if (diagnostics.source !== 'bulk_geocode') return false;
  return diagnostics.queryShapes.some((shape) =>
    shape.includes('no_city_no_postal')
  );
}

export function isDeliveryDateReviewRequired(order: CanonicalOrderDto): boolean {
  return order.blockerReasons.some((reason) =>
    DELIVERY_DATE_REVIEW_REASONS.has(reason)
  );
}

const DELIVERY_DATE_REVIEW_REASONS = new Set([
  'ambiguous_delivery_day',
  'delivery_date_weekday_mismatch',
  'delivery_date_weekday_unverified',
  'delivery_day_unparsed'
]);

function hasGeocodableAddress(order: CanonicalOrderDto): boolean {
  return [
    order.shippingAddress.address1,
    order.shippingAddress.city,
    order.shippingAddress.province,
    order.shippingAddress.postalCode
  ].some(isPresent);
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

export function routeStopOrderKey(stop: RouteStopDto): string {
  return stop.deliveryStopId || stop.sourceOrderId || stop.orderId;
}

export function hasStopSequenceChanged(savedStops: RouteStopDto[] | null | undefined, draftStops: RouteStopDto[]): boolean {
  if (savedStops === null || savedStops === undefined) return false;
  if (savedStops.length !== draftStops.length) return true;
  return savedStops.some((stop, index) => {
    const draftStop = draftStops[index];
    return draftStop === undefined || routeStopOrderKey(stop) !== routeStopOrderKey(draftStop);
  });
}

export function moveStop(stops: RouteStopDto[], deliveryStopId: string, direction: -1 | 1): RouteStopDto[] {
  const index = stops.findIndex((stop) => stop.deliveryStopId === deliveryStopId);
  if (index < 0) return stops;
  const target = index + direction;
  if (target < 0 || target >= stops.length) return stops;
  const next = [...stops];
  const [removed] = next.splice(index, 1);
  if (removed === undefined) return stops;
  next.splice(target, 0, removed);
  return resequenceStops(next);
}


export function moveStopBefore(stops: RouteStopDto[], draggedStopId: string, targetStopId: string): RouteStopDto[] {
  return moveStopToDropPosition(stops, draggedStopId, targetStopId, 'before');
}

export type StopDropPosition = 'before' | 'after';

export function moveStopToDropPosition(
  stops: RouteStopDto[],
  draggedStopId: string,
  targetStopId: string,
  position: StopDropPosition,
): RouteStopDto[] {
  if (draggedStopId === targetStopId) return stops;
  const draggedIndex = stops.findIndex((stop) => stop.deliveryStopId === draggedStopId);
  if (draggedIndex < 0) return stops;
  const next = [...stops];
  const [dragged] = next.splice(draggedIndex, 1);
  if (dragged === undefined) return stops;
  const targetIndex = next.findIndex((stop) => stop.deliveryStopId === targetStopId);
  if (targetIndex < 0) return stops;
  next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, dragged);
  return resequenceStops(next);
}

export function moveStopToSequence(
  stops: RouteStopDto[],
  deliveryStopId: string,
  sequence: number,
): RouteStopDto[] {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > stops.length) return stops;
  const currentIndex = stops.findIndex((stop) => stop.deliveryStopId === deliveryStopId);
  const targetIndex = sequence - 1;
  if (currentIndex < 0 || currentIndex === targetIndex) return stops;
  const next = [...stops];
  const [moved] = next.splice(currentIndex, 1);
  if (moved === undefined) return stops;
  next.splice(targetIndex, 0, moved);
  return resequenceStops(next);
}

export function resequenceStops(stops: RouteStopDto[]): RouteStopDto[] {
  return stops.map((stop, index) => ({ ...stop, sequence: index + 1 }));
}

export function deriveRouteStats(detail: RoutePlanDetailDto | null): {
  attempted: number;
  completed: number;
  missingCoordinates: number;
  stops: number;
} {
  if (detail === null) return { attempted: 0, completed: 0, missingCoordinates: 0, stops: 0 };
  return detail.stops.reduce(
    (stats, stop) => ({
      attempted: stats.attempted + (stop.status.toUpperCase() === 'ATTEMPTED' ? 1 : 0),
      completed: stats.completed + (stop.status.toUpperCase() === 'COMPLETED' ? 1 : 0),
      missingCoordinates: stats.missingCoordinates + (stop.coordinates.latitude === null || stop.coordinates.longitude === null ? 1 : 0),
      stops: stats.stops + 1
    }),
    { attempted: 0, completed: 0, missingCoordinates: 0, stops: 0 }
  );
}

export function geometryLabel(detail: RoutePlanDetailDto | null, routerStatus: MapProviderStatus, locale: string | null | undefined = 'en-CA'): string {
  const t = getStateCopy(locale).geometry;
  if (detail === null) return t.noRouteSelected;
  if (detail.routeGeometry !== null) return t.roadGeometry;
  if (countRoutableRoutePoints(detail) < 2) return t.noCoordinates;
  if (routerStatus === 'not_configured') return t.routerNotConfigured;
  return t.roadGeometryUnavailable;
}

function countRoutableRoutePoints(detail: RoutePlanDetailDto): number {
  const depot = detail.routePlan.depot;
  const points = [
    depot === null ? null : { latitude: depot.latitude, longitude: depot.longitude },
    ...detail.stops.map((stop) => stop.coordinates)
  ];
  return points.filter((point): point is { latitude: number; longitude: number } =>
    point !== null &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude)
  ).length;
}

export function hideSetupActions(bootstrap: BootstrapPayload): boolean {
  return bootstrap.mode === 'plugin';
}

export function storeSettingsToDepotPoint(settings: StoreSettingsDto | null, locale: string | null | undefined = settings?.locale): RouteOpsPoint | null {
  if (settings === null) return null;
  if (!isValidLatitude(settings.defaultDepotLatitude) || !isValidLongitude(settings.defaultDepotLongitude)) return null;
  const address = settings.defaultDepotAddress?.trim();
  return {
    addressLabel: address === undefined || address === '' ? getStateCopy(locale).storeAddress : address,
    id: 'settings-store-depot',
    kind: 'depot',
    label: getStateCopy(locale).store,
    latitude: settings.defaultDepotLatitude,
    longitude: settings.defaultDepotLongitude
  };
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value === undefined || value.trim() === '' || value === 'all') return;
  params.set(key, value.trim());
}

function setRequiredParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined
): void {
  if (value === undefined || value.trim() === '') return;
  params.set(key, value.trim());
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}
