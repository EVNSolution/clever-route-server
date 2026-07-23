import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import type { DsvAdminPrincipal, DsvCustomerUserPrincipal } from './dsv-principal.js';
import type {
  DsvV1ConditionListItemRow,
  DsvV1ControlSummaryInput,
  DsvV1CustomerDeliveryInquiryRow,
  DsvV1CustomerListItemRow,
  DsvV1DestinationListItemRow,
  DsvV1DriverListItemRow,
  DsvV1EtaStatus,
  DsvV1EventRowInput,
  DsvV1PageInfo,
  DsvV1ProofRowInput,
  DsvV1RecordRow,
  DsvV1RoutePlanStopEtaInput,
  DsvV1SellerOrderSummaryRow,
  DsvV1VehicleListItemRow,
} from './dsv-v1-read.dto.js';

export const dsvV1ReadDefaultLimit = 50;
export const dsvV1ReadMaxLimit = 100;
export const dsvV1ReadFallbackTimezone = 'Asia/Seoul';
export const dsvV1DateWindows = ['today', 'tomorrow', 'day-after-tomorrow'] as const;

export type DsvV1DateWindow = typeof dsvV1DateWindows[number];
export type DsvV1ReadEndpoint =
  | 'conditions'
  | 'control'
  | 'customer-deliveries'
  | 'customers'
  | 'destinations'
  | 'dispatches'
  | 'drivers'
  | 'records'
  | 'vehicles';
export type DsvV1ReadErrorCode = 'BAD_REQUEST' | 'DEPENDENCY_UNAVAILABLE';
export type DsvV1EmptyReason =
  | 'DATE_OUT_OF_WINDOW'
  | 'NO_ACTIVE_CUSTOMER_SCOPE'
  | 'NO_DELIVERIES'
  | 'NO_SERVICE_DATE';
type DsvV1PublicEventType =
  | 'ROUTE_COMPLETED'
  | 'ROUTE_STARTED'
  | 'STOP_ARRIVED'
  | 'STOP_DELIVERED'
  | 'STOP_FAILED';

export type DsvV1PaginatedRead<T> = {
  items: T[];
  page: DsvV1PageInfo;
};

export type DsvV1CustomerDeliveryReadResult = DsvV1PaginatedRead<DsvV1CustomerDeliveryInquiryRow> & {
  emptyReason?: DsvV1EmptyReason;
  serviceDate: string;
  timezone: string;
};

export type DsvV1ControlReadResult = DsvV1ControlSummaryInput & { timezone: string };

type DsvV1EtaReadRow = {
  estimatedArrivalAt: Date | null;
  etaInputRouteVersionId: string | null;
  etaSource: string | null;
  etaStatus: string;
  routePlanId: string;
  routePlanStopId: string;
};

export type DsvV1ReadListInput = {
  cursor?: string | null;
  limit?: number | string | null;
};

export type DsvV1ServiceDateInput = DsvV1ReadListInput & {
  serviceDate?: string | null;
};

export type DsvV1CustomerDeliveriesInput = DsvV1ReadListInput & {
  serviceDate?: string | null;
  window?: DsvV1DateWindow | null;
};

export type DsvV1TenantDateResolution = {
  dayAfterTomorrow: string;
  timezone: string;
  today: string;
  tomorrow: string;
};

export type DsvV1ReadQueryService = {
  listConditions(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1ConditionListItemRow>>;
  listControl(principal: DsvAdminPrincipal, input?: Pick<DsvV1ServiceDateInput, 'serviceDate'>): Promise<DsvV1ControlReadResult>;
  listCustomerDeliveries(
    principal: DsvCustomerUserPrincipal,
    input?: DsvV1CustomerDeliveriesInput,
  ): Promise<DsvV1CustomerDeliveryReadResult>;
  listCustomers(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1CustomerListItemRow>>;
  listDestinations(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1DestinationListItemRow>>;
  listDispatches(principal: DsvAdminPrincipal, input?: DsvV1ServiceDateInput): Promise<DsvV1PaginatedRead<DsvV1SellerOrderSummaryRow>>;
  listDrivers(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1DriverListItemRow>>;
  listRecords(principal: DsvAdminPrincipal, input?: DsvV1ServiceDateInput): Promise<DsvV1PaginatedRead<DsvV1RecordRow>>;
  listVehicles(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1VehicleListItemRow>>;
  resolveTenantDates(shopId: string, now?: Date): Promise<DsvV1TenantDateResolution>;
};

type DsvV1ReadPrismaClient = Pick<
  PrismaClient,
  | '$queryRaw'
  | 'commerceConnection'
  | 'customer'
  | 'deliveryCustomerProfile'
  | 'deliveryStop'
  | 'driverEvent'
  | 'driver'
  | 'dsvVehicleDriverAssignment'
  | 'dsvTransportCondition'
  | 'order'
  | 'routePlan'
  | 'vehicle'
>;

type CursorPayload = {
  customerId?: string;
  endpoint: DsvV1ReadEndpoint;
  last: Record<string, string | null>;
  limit: number;
  serviceDate?: string;
  shopId: string;
  sort: string;
  v: 1;
};

type CursorContext = Omit<CursorPayload, 'last' | 'v'>;

type PageSpec = {
  cursor: CursorPayload | null;
  limit: number;
};

type CustomerManagementRow = {
  displayName: string;
  externalCustomerCode: string;
  id: string;
  status: string | null;
};

type DestinationManagementRow = {
  displayName: string;
  id: string;
  normalizedAddress: Prisma.JsonValue;
};

const dispatchSort = 'serviceDate:asc,sellerOrderKey:asc,orderId:asc';
const recordsSort = 'occurredAt:desc,eventId:desc';
const managementSortByEndpoint = {
  conditions: 'name:asc,id:asc',
  customers: 'displayName:asc,id:asc',
  destinations: 'displayName:asc,id:asc',
  drivers: 'displayName:asc,id:asc',
  vehicles: 'displayName:asc,id:asc',
} as const satisfies Record<Exclude<DsvV1ReadEndpoint, 'control' | 'customer-deliveries' | 'dispatches' | 'records'>, string>;
const eventAllowlist = new Set<DsvV1PublicEventType>([
  'ROUTE_COMPLETED',
  'ROUTE_STARTED',
  'STOP_ARRIVED',
  'STOP_DELIVERED',
  'STOP_FAILED',
]);

export class DsvV1ReadQueryError extends Error {
  readonly httpStatus: 400 | 503;

  constructor(readonly code: DsvV1ReadErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'DsvV1ReadQueryError';
    this.httpStatus = code === 'BAD_REQUEST' ? 400 : 503;
  }
}

export class PrismaDsvV1ReadQueryService implements DsvV1ReadQueryService {
  constructor(
    private readonly prisma: DsvV1ReadPrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolveTenantDates(shopId: string, now: Date = this.clock()): Promise<DsvV1TenantDateResolution> {
    const timezone = await this.resolveTenantTimezone(shopId);
    const today = localDateInTimeZone(now, timezone);
    return {
      dayAfterTomorrow: addCalendarDays(today, 2),
      timezone,
      today,
      tomorrow: addCalendarDays(today, 1),
    };
  }

  async listCustomerDeliveries(
    principal: DsvCustomerUserPrincipal,
    input: DsvV1CustomerDeliveriesInput = {},
  ): Promise<DsvV1CustomerDeliveryReadResult> {
    if (principal.customerId === '') {
      const dates = await this.resolveTenantDates(principal.shopId);
      return {
        emptyReason: 'NO_ACTIVE_CUSTOMER_SCOPE',
        items: [],
        page: toPage(null),
        serviceDate: dates.today,
        timezone: dates.timezone,
      };
    }

    const datePolicy = await this.resolveCustomerServiceDate(principal.shopId, input);
    if (datePolicy.emptyReason !== undefined) {
      return {
        emptyReason: datePolicy.emptyReason,
        items: [],
        page: toPage(null),
        serviceDate: datePolicy.serviceDate,
        timezone: datePolicy.timezone,
      };
    }

    const limit = parseLimit(input.limit);
    const context: CursorContext = {
      customerId: principal.customerId,
      endpoint: 'customer-deliveries',
      limit,
      serviceDate: datePolicy.serviceDate,
      shopId: principal.shopId,
      sort: dispatchSort,
    };
    const page = readCursor(input.cursor, context);
    const rows = await this.prisma.order.findMany({
      orderBy: [{ sellerOrderKey: 'asc' }, { id: 'asc' }],
      select: customerDeliveryOrderSelect(datePolicy.serviceDate, principal.shopId),
      take: limit + 1,
      where: {
        customerId: principal.customerId,
        shopId: principal.shopId,
        ...orderCursorWhere(page.cursor),
        deliveryStops: {
          some: { deliveryDate: serviceDateAsDbDate(datePolicy.serviceDate), shopId: principal.shopId },
        },
      },
    });
    const items = rows.slice(0, limit).map(toCustomerDeliveryInquiryRow);
    return {
      ...(items.length === 0 ? { emptyReason: 'NO_DELIVERIES' as const } : {}),
      items,
      page: toPage(nextOrderCursor(rows, limit, context)),
      serviceDate: datePolicy.serviceDate,
      timezone: datePolicy.timezone,
    };
  }

  async listDispatches(
    principal: DsvAdminPrincipal,
    input: DsvV1ServiceDateInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1SellerOrderSummaryRow>> {
    const serviceDate = await this.resolveAdminServiceDate(principal.shopId, input.serviceDate);
    const limit = parseLimit(input.limit);
    const context: CursorContext = {
      endpoint: 'dispatches',
      limit,
      serviceDate,
      shopId: principal.shopId,
      sort: dispatchSort,
    };
    const page = readCursor(input.cursor, context);
    const rows = await this.prisma.order.findMany({
      orderBy: [{ sellerOrderKey: 'asc' }, { id: 'asc' }],
      select: customerDeliveryOrderSelect(serviceDate, principal.shopId),
      take: limit + 1,
      where: {
        shopId: principal.shopId,
        ...orderCursorWhere(page.cursor),
        deliveryStops: {
          some: { deliveryDate: serviceDateAsDbDate(serviceDate), shopId: principal.shopId },
        },
      },
    });
    return {
      items: rows.slice(0, limit).map(toSellerOrderSummaryRow),
      page: toPage(nextOrderCursor(rows, limit, context)),
    };
  }

  async listControl(
    principal: DsvAdminPrincipal,
    input: Pick<DsvV1ServiceDateInput, 'serviceDate'> = {},
  ): Promise<DsvV1ControlReadResult> {
    const dates = await this.resolveTenantDates(principal.shopId);
    const serviceDate = input.serviceDate ?? dates.today;
    assertIsoDate(serviceDate);
    const stops = await this.prisma.order.findMany({
      orderBy: [{ sellerOrderKey: 'asc' }, { id: 'asc' }],
      select: customerDeliveryOrderSelect(serviceDate, principal.shopId),
      where: {
        shopId: principal.shopId,
        deliveryStops: {
          some: { deliveryDate: serviceDateAsDbDate(serviceDate), shopId: principal.shopId },
        },
      },
    });
    const summaries = stops.map(toSellerOrderSummaryRow);
    return {
      assignedCount: summaries.filter((summary) => summary.assignmentStatus === 'ASSIGNED').length,
      failedEtaCount: summaries.filter((summary) => summary.etaStatus === 'FAILED').length,
      pendingEtaCount: summaries.filter((summary) => summary.etaStatus === 'PENDING').length,
      readyEtaCount: summaries.filter((summary) => summary.etaStatus === 'READY').length,
      serviceDate,
      totalDispatchCount: summaries.length,
      timezone: dates.timezone,
      unassignedCount: summaries.filter((summary) => summary.assignmentStatus === 'UNASSIGNED').length,
    };
  }

  async listRecords(
    principal: DsvAdminPrincipal,
    input: DsvV1ServiceDateInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1RecordRow>> {
    const serviceDate = await this.resolveAdminServiceDate(principal.shopId, input.serviceDate);
    const limit = parseLimit(input.limit);
    const context: CursorContext = {
      endpoint: 'records',
      limit,
      serviceDate,
      shopId: principal.shopId,
      sort: recordsSort,
    };
    const page = readCursor(input.cursor, context);
    const eventRows = await this.prisma.driverEvent.findMany({
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: recordEventSelect(principal.shopId),
      take: limit + 1,
      where: {
        eventType: { in: [...eventAllowlist] },
        shopId: principal.shopId,
        ...recordEventCursorWhere(page.cursor),
        deliveryStop: {
          deliveryDate: serviceDateAsDbDate(serviceDate),
          order: { shopId: principal.shopId },
          shopId: principal.shopId,
        },
      },
    });
    const flattened = eventRows.map(toEventRecordRow);
    if (flattened.length <= limit && shouldReadSyntheticRecords(page.cursor)) {
      const syntheticRows = await this.prisma.deliveryStop.findMany({
        orderBy: [{ id: 'desc' }],
        select: recordStopSelect(principal.shopId),
        take: limit + 1 - flattened.length,
        where: {
          deliveryDate: serviceDateAsDbDate(serviceDate),
          order: { shopId: principal.shopId },
          shopId: principal.shopId,
          ...syntheticRecordCursorWhere(page.cursor),
          driverEvents: { none: { eventType: { in: [...eventAllowlist] }, shopId: principal.shopId } },
        },
      });
      flattened.push(...syntheticRows.map(toSyntheticRecordRow));
    }
    return {
      items: flattened.slice(0, limit).map(stripRecordCursor),
      page: toPage(nextRecordCursor(flattened, limit, context)),
    };
  }

  async listDrivers(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1DriverListItemRow>> {
    return this.listManagement('drivers', principal.shopId, input, async (page) => {
      const rows = await this.prisma.driver.findMany({
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        select: { displayName: true, id: true, phone: true, status: true },
        take: page.limit + 1,
        where: { shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'displayName') },
      });
      return rows.map((row) => ({
        displayName: row.displayName,
        driverId: row.id,
        phone: row.phone,
        status: row.status,
      }));
    });
  }

  async listVehicles(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1VehicleListItemRow>> {
    return this.listManagement('vehicles', principal.shopId, input, async (page) => {
      const rows = await this.prisma.vehicle.findMany({
        orderBy: [{ label: 'asc' }, { id: 'asc' }],
        select: { id: true, label: true, licensePlate: true, status: true, vehicleType: true },
        take: page.limit + 1,
        where: { shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'label') },
      });
      const assignmentsByVehicleId = await this.listVehicleDriverAssignments(
        principal.shopId,
        rows.map((row) => row.id),
      );
      return rows.map((row) => ({
        displayName: row.label,
        driverAssignments: assignmentsByVehicleId.get(row.id) ?? [],
        status: row.status,
        vehicleId: row.id,
        vehiclePlate: row.licensePlate,
      }));
    });
  }

  async listCustomers(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1CustomerListItemRow>> {
    return this.listManagement('customers', principal.shopId, input, async (page) => {
      const rows = await this.prisma.$queryRaw<CustomerManagementRow[]>(Prisma.sql`
        SELECT
          id::text AS id,
          COALESCE("displayName", "externalCustomerCode") AS "displayName",
          "externalCustomerCode",
          status::text AS status
        FROM customers
        WHERE "shopId" = ${principal.shopId}::uuid
          ${effectiveLabelCursorSql(
            page.cursor,
            Prisma.sql`COALESCE("displayName", "externalCustomerCode")`,
            Prisma.sql`id::text`,
          )}
        ORDER BY LOWER(COALESCE("displayName", "externalCustomerCode")) ASC, id ASC
        LIMIT ${page.limit + 1}
      `);
      return rows.map((row) => ({
        customerId: row.id,
        displayName: row.displayName,
        externalCustomerCode: row.externalCustomerCode,
        status: row.status,
      }));
    });
  }

  async listDestinations(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1DestinationListItemRow>> {
    return this.listManagement('destinations', principal.shopId, input, async (page) => {
      const rows = await this.prisma.$queryRaw<DestinationManagementRow[]>(Prisma.sql`
        SELECT
          id::text AS id,
          COALESCE("canonicalName", id::text) AS "displayName",
          "normalizedAddress" AS "normalizedAddress"
        FROM delivery_customer_profiles
        WHERE "shopId" = ${principal.shopId}::uuid
          ${effectiveLabelCursorSql(
            page.cursor,
            Prisma.sql`COALESCE("canonicalName", id::text)`,
            Prisma.sql`id::text`,
          )}
        ORDER BY LOWER(COALESCE("canonicalName", id::text)) ASC, id ASC
        LIMIT ${page.limit + 1}
      `);
      return rows.map((row) => ({
        address: normalizedAddressLabel(row.normalizedAddress),
        destinationId: row.id,
        displayName: row.displayName,
      }));
    });
  }

  async listConditions(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1ConditionListItemRow>> {
    return this.listManagement('conditions', principal.shopId, input, async (page) => {
      const rows = await this.prisma.dsvTransportCondition.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { code: true, id: true, name: true, status: true },
        take: page.limit + 1,
        where: { shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'name') },
      });
      return rows.map((row) => ({ conditionId: row.id, name: row.name, status: row.status }));
    });
  }

  private async resolveTenantTimezone(shopId: string): Promise<string> {
    const connections = await this.prisma.commerceConnection.findMany({
      distinct: ['timezone'],
      select: { timezone: true },
      where: { shopId, status: 'ACTIVE', timezone: { not: null } },
    });
    const timezones = [...new Set(connections.map((connection) => connection.timezone?.trim()).filter(isNonEmpty))];
    if (timezones.length === 0) return dsvV1ReadFallbackTimezone;
    const invalid = timezones.filter((timezone) => !isValidIanaTimeZone(timezone));
    if (invalid.length > 0) {
      throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Active commerce connection has invalid timezone.', {
        invalidTimezones: invalid,
        shopId,
      });
    }
    if (timezones.length > 1) {
      throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Active commerce connections have conflicting timezones.', {
        shopId,
        timezones,
      });
    }
    return timezones[0] ?? dsvV1ReadFallbackTimezone;
  }

  private async resolveCustomerServiceDate(
    shopId: string,
    input: Pick<DsvV1CustomerDeliveriesInput, 'serviceDate' | 'window'>,
  ): Promise<{ emptyReason?: DsvV1EmptyReason; serviceDate: string; timezone: string }> {
    const dates = await this.resolveTenantDates(shopId);
    const windowDate = resolveWindowDate(input.window ?? 'today', dates);
    const serviceDate = input.serviceDate ?? windowDate;
    assertIsoDate(serviceDate);
    if (input.serviceDate !== undefined && input.serviceDate !== null && input.window !== undefined && input.window !== null
      && serviceDate !== windowDate) {
      throw new DsvV1ReadQueryError('BAD_REQUEST', 'window and serviceDate resolve to different service dates.', {
        serviceDate,
        window: input.window,
        windowDate,
      });
    }
    if (![dates.today, dates.tomorrow, dates.dayAfterTomorrow].includes(serviceDate)) {
      return { emptyReason: 'DATE_OUT_OF_WINDOW', serviceDate, timezone: dates.timezone };
    }
    return { serviceDate, timezone: dates.timezone };
  }

  private async resolveAdminServiceDate(shopId: string, serviceDate: string | null | undefined): Promise<string> {
    if (serviceDate !== undefined && serviceDate !== null) {
      assertIsoDate(serviceDate);
      return serviceDate;
    }
    return (await this.resolveTenantDates(shopId)).today;
  }

  private async listManagement<TItem>(
    endpoint: Exclude<DsvV1ReadEndpoint, 'control' | 'customer-deliveries' | 'dispatches' | 'records'>,
    shopId: string,
    input: DsvV1ReadListInput,
    read: (page: PageSpec) => Promise<TItem[]>,
  ): Promise<DsvV1PaginatedRead<TItem>> {
    const limit = parseLimit(input.limit);
    const context: CursorContext = { endpoint, limit, shopId, sort: managementSortByEndpoint[endpoint] };
    const page = readCursor(input.cursor, context);
    const rows = await read(page);
    const items = rows.slice(0, limit);
    return {
      items,
      page: toPage(nextManagementCursor(rows, limit, context)),
    };
  }

  private async listVehicleDriverAssignments(
    shopId: string,
    vehicleIds: readonly string[],
  ): Promise<Map<string, Array<{ assignmentId: string; driverId: string }>>> {
    if (vehicleIds.length === 0) return new Map();
    const rows = await this.prisma.dsvVehicleDriverAssignment.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { driverId: true, id: true, vehicleId: true },
      where: { shopId, vehicleId: { in: [...vehicleIds] } },
    });
    const byVehicleId = new Map<string, Array<{ assignmentId: string; driverId: string }>>();
    for (const row of rows) {
      const assignments = byVehicleId.get(row.vehicleId) ?? [];
      assignments.push({ assignmentId: row.id, driverId: row.driverId });
      byVehicleId.set(row.vehicleId, assignments);
    }
    return byVehicleId;
  }
}

const proofMediaSelect = {
  deletedAt: true,
  id: true,
} satisfies Prisma.DriverProofMediaSelect;

const publicEventSelect = {
  eventType: true,
  id: true,
  occurredAt: true,
} satisfies Prisma.DriverEventSelect;

const routePlanStopSelect = {
  estimatedArrivalAt: true,
  etaInputRouteVersionId: true,
  etaSource: true,
  etaStatus: true,
  id: true,
  routePlanId: true,
} satisfies Prisma.RoutePlanStopSelect;

function customerDeliveryOrderSelect(serviceDate: string, shopId: string) {
  return {
    currentRouteVersionId: true,
    customer: {
      select: { displayName: true, id: true },
    },
    deliveryStatus: true,
    deliveryStops: {
      orderBy: [{ id: 'asc' }],
      select: {
        driverEvents: {
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: publicEventSelect,
          where: { eventType: { in: [...eventAllowlist] }, shopId },
        },
        driverProofMedia: {
          select: proofMediaSelect,
          where: { shopId },
        },
        id: true,
        recipientName: true,
        routePlanStops: {
          orderBy: [{ createdAt: 'desc' }],
          select: routePlanStopSelect,
          where: { shopId },
        },
        status: true,
      },
      where: { deliveryDate: serviceDateAsDbDate(serviceDate), shopId },
    },
    destination: {
      select: {
        canonicalName: true,
        id: true,
        normalizedAddress: true,
      },
    },
    id: true,
    sellerOrderKey: true,
    sellerOrderSourceKind: true,
    sourceOrderNumber: true,
  } satisfies Prisma.OrderSelect;
}

function recordStopSelect(shopId: string) {
  return {
    driverProofMedia: { select: proofMediaSelect, where: { shopId } },
    id: true,
    order: {
      select: {
        currentRouteVersionId: true,
        deliveryStatus: true,
        destination: { select: { canonicalName: true } },
        id: true,
        sellerOrderKey: true,
        sellerOrderSourceKind: true,
        sourceOrderNumber: true,
      },
    },
    recipientName: true,
    routePlanStops: {
      orderBy: [{ createdAt: 'desc' }],
      select: routePlanStopSelect,
    },
    status: true,
  } satisfies Prisma.DeliveryStopSelect;
}

function recordEventSelect(shopId: string) {
  return {
    eventType: true,
    id: true,
    occurredAt: true,
    deliveryStop: {
      select: recordStopSelect(shopId),
    },
  } satisfies Prisma.DriverEventSelect;
}

type CustomerDeliveryOrderRow = Prisma.OrderGetPayload<{ select: ReturnType<typeof customerDeliveryOrderSelect> }>;
type RecordStopRow = Prisma.DeliveryStopGetPayload<{ select: ReturnType<typeof recordStopSelect> }>;
type RecordEventRow = Prisma.DriverEventGetPayload<{ select: ReturnType<typeof recordEventSelect> }>;
type RecordCursorRow = DsvV1RecordRow & { cursorEventId: string };

function toCustomerDeliveryInquiryRow(row: CustomerDeliveryOrderRow): DsvV1CustomerDeliveryInquiryRow {
  const stop = row.deliveryStops[0] ?? null;
  const eta = stop === null ? null : selectCanonicalEta(stop.routePlanStops, row.currentRouteVersionId);
  return {
    deliveryStatus: row.deliveryStatus,
    destinationDisplayName: row.destination?.canonicalName ?? '',
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(row.currentRouteVersionId, eta),
    eventRows: stop?.driverEvents.map(toDtoEventRow) ?? [],
    proofRows: stop?.driverProofMedia.map(toDtoProofRow) ?? [],
    sellerOrderKey: row.sellerOrderKey ?? row.id,
  };
}

function toSellerOrderSummaryRow(row: CustomerDeliveryOrderRow): DsvV1SellerOrderSummaryRow {
  const stop = row.deliveryStops[0] ?? null;
  const eta = stop === null ? null : selectCanonicalEta(stop.routePlanStops, row.currentRouteVersionId);
  return {
    assignmentStatus: row.currentRouteVersionId === null ? 'UNASSIGNED' : 'ASSIGNED',
    customerId: row.customer?.id ?? '',
    destinationId: row.destination?.id ?? '',
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(row.currentRouteVersionId, eta),
    ...(eta?.routePlanId === undefined ? {} : { routePlanId: eta.routePlanId }),
    ...(row.currentRouteVersionId === null ? {} : { routeVersionId: row.currentRouteVersionId }),
    sellerOrderId: row.id,
    sellerOrderKey: row.sellerOrderKey ?? row.id,
  };
}

function toSyntheticRecordRow(stop: RecordStopRow): RecordCursorRow {
  const eta = selectCanonicalEta(stop.routePlanStops, stop.order.currentRouteVersionId);
  return {
    cursorEventId: syntheticRecordId(stop.id),
    deliveryStatus: stop.order.deliveryStatus,
    destinationDisplayName: stop.order.destination?.canonicalName ?? stop.recipientName ?? '',
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(stop.order.currentRouteVersionId, eta),
    eventRows: [],
    proofRows: stop.driverProofMedia.map(toDtoProofRow),
    sellerOrderKey: stop.order.sellerOrderKey ?? stop.order.id,
  };
}

function toEventRecordRow(row: RecordEventRow): RecordCursorRow {
  if (row.deliveryStop === null) {
    throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Record event is missing its delivery stop.');
  }
  return {
    ...toSyntheticRecordRow(row.deliveryStop),
    cursorEventId: row.id,
    eventRows: [toDtoEventRow(row)],
  };
}

function etaFields(eta: (DsvV1EtaReadRow & { etaStatus: DsvV1EtaStatus }) | null): Partial<DsvV1RoutePlanStopEtaInput> {
  if (eta === null) return {};
  return {
    ...(eta.estimatedArrivalAt === null ? {} : { estimatedArrivalAt: eta.estimatedArrivalAt }),
    ...(eta.etaInputRouteVersionId === null ? {} : { etaInputRouteVersionId: eta.etaInputRouteVersionId }),
    ...(eta.etaSource === null ? {} : { etaSource: eta.etaSource }),
  };
}

function toDtoProofRow(row: { deletedAt: Date | null }): DsvV1ProofRowInput {
  return { deletedAt: row.deletedAt };
}

function toDtoEventRow(row: { eventType: string; id: string; occurredAt: Date }): DsvV1EventRowInput {
  if (!eventAllowlist.has(row.eventType as DsvV1PublicEventType)) {
    throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Unexpected non-public event type selected.', {
      eventId: row.id,
      eventType: row.eventType,
    });
  }
  return {
    eventType: row.eventType,
    occurredAt: row.occurredAt,
  };
}

function selectCanonicalEta(
  rows: Array<{
    estimatedArrivalAt: Date | null;
    etaInputRouteVersionId: string | null;
    etaSource: string | null;
    etaStatus: string;
    id: string;
    routePlanId: string;
  }>,
  currentRouteVersionId: string | null,
): (DsvV1EtaReadRow & { etaStatus: DsvV1EtaStatus }) | null {
  if (currentRouteVersionId === null) return null;
  const selected = rows.find((row) => row.etaInputRouteVersionId === currentRouteVersionId) ?? null;
  if (selected === null) return null;
  return {
    estimatedArrivalAt: selected.estimatedArrivalAt,
    etaInputRouteVersionId: selected.etaInputRouteVersionId,
    etaSource: selected.etaSource,
    etaStatus: toDtoEtaStatus(selected.etaStatus),
    routePlanId: selected.routePlanId,
    routePlanStopId: selected.id,
  };
}

function fallbackEtaStatus(
  currentRouteVersionId: string | null,
  eta: (DsvV1EtaReadRow & { etaStatus: DsvV1EtaStatus }) | null,
): DsvV1EtaStatus {
  if (eta !== null) return eta.etaStatus;
  if (currentRouteVersionId === null) return 'NOT_REQUIRED';
  return 'PENDING';
}

function toDtoEtaStatus(value: string): DsvV1EtaStatus {
  if (value === 'NOT_REQUIRED' || value === 'PENDING' || value === 'READY' || value === 'FAILED' || value === 'STALE') {
    return value;
  }
  throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Unexpected ETA status selected.', { etaStatus: value });
}

function parseLimit(raw: number | string | null | undefined): number {
  if (raw === undefined || raw === null || raw === '') return dsvV1ReadDefaultLimit;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'limit must be a positive integer.', { limit: raw });
  }
  if (value > dsvV1ReadMaxLimit) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'limit exceeds the maximum page size.', {
      limit: value,
      maxLimit: dsvV1ReadMaxLimit,
    });
  }
  return value;
}

function readCursor(raw: string | null | undefined, context: CursorContext): PageSpec {
  if (raw === undefined || raw === null || raw === '') return { cursor: null, limit: context.limit };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is invalid.');
  }
  if (!isCursorPayload(payload)) throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is invalid.');
  const expected: CursorPayload = { ...context, last: payload.last, v: 1 };
  if (JSON.stringify({ ...payload, last: undefined }) !== JSON.stringify({ ...expected, last: undefined })) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor does not match the requested filters.');
  }
  return { cursor: payload, limit: context.limit };
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1
    && typeof candidate.endpoint === 'string'
    && typeof candidate.shopId === 'string'
    && typeof candidate.limit === 'number'
    && typeof candidate.sort === 'string'
    && candidate.last !== null
    && typeof candidate.last === 'object'
    && (candidate.customerId === undefined || typeof candidate.customerId === 'string')
    && (candidate.serviceDate === undefined || typeof candidate.serviceDate === 'string');
}

function encodeCursor(context: CursorContext, last: Record<string, string | null>): string {
  return Buffer.from(JSON.stringify({ ...context, last, v: 1 } satisfies CursorPayload), 'utf8').toString('base64url');
}

function nextOrderCursor(rows: CustomerDeliveryOrderRow[], limit: number, context: CursorContext): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (last === undefined) return null;
  return encodeCursor(context, {
    orderId: last.id,
    sellerOrderKey: last.sellerOrderKey,
    serviceDate: context.serviceDate ?? null,
  });
}

function nextRecordCursor(rows: RecordCursorRow[], limit: number, context: CursorContext): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (last === undefined) return null;
  const lastEvent = last.eventRows?.[0];
  return encodeCursor(context, {
    eventId: last.cursorEventId,
    occurredAt: toCursorDate(lastEvent?.occurredAt),
    serviceDate: context.serviceDate ?? null,
  });
}

function nextManagementCursor<TItem>(rows: TItem[], limit: number, context: CursorContext): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (last === undefined) return null;
  return encodeCursor(context, managementCursorPosition(last));
}

function toPage(nextCursor: string | null): DsvV1PageInfo {
  return {
    hasMore: nextCursor !== null,
    ...(nextCursor === null ? {} : { nextCursor }),
  };
}

function managementCursorPosition(value: unknown): Record<string, string | null> {
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const id = stringField(row, 'driverId')
      ?? stringField(row, 'vehicleId')
      ?? stringField(row, 'customerId')
      ?? stringField(row, 'destinationId')
      ?? stringField(row, 'conditionId');
    const label = stringField(row, 'displayName') ?? stringField(row, 'name');
    if (id !== null && label !== null) return { id, label };
  }
  throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Unable to create management cursor.');
}

function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === 'string' ? value : null;
}

function normalizedAddressLabel(value: Prisma.JsonValue): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const parts = ['address1', 'city', 'province', 'postalCode', 'countryCode']
      .map((key) => value[key])
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

function toCursorDate(value: Date | string | undefined): string {
  if (value === undefined) return '';
  return value instanceof Date ? value.toISOString() : value;
}

function orderCursorWhere(cursor: CursorPayload | null): Prisma.OrderWhereInput {
  if (cursor === null) return {};
  const sellerOrderKey = cursor.last.sellerOrderKey;
  const orderId = cursor.last.orderId;
  if (sellerOrderKey === undefined || orderId === undefined || orderId === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing order position.');
  }
  if (sellerOrderKey === null) {
    return {
      OR: [
        { sellerOrderKey: null, id: { gt: orderId } },
        { sellerOrderKey: { not: null } },
      ],
    };
  }
  return {
    OR: [
      { sellerOrderKey: { gt: sellerOrderKey } },
      { sellerOrderKey, id: { gt: orderId } },
    ],
  };
}

function recordEventCursorWhere(cursor: CursorPayload | null): Prisma.DriverEventWhereInput {
  if (cursor === null) return {};
  const occurredAt = cursor.last.occurredAt;
  const eventId = cursor.last.eventId;
  if (occurredAt === undefined || eventId === undefined || occurredAt === null || eventId === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing record position.');
  }
  if (occurredAt === '') return { id: { equals: neverMatchUuid } };
  const occurredAtDate = new Date(occurredAt);
  if (Number.isNaN(occurredAtDate.getTime())) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor has invalid record position.');
  }
  return {
    OR: [
      { occurredAt: { lt: occurredAtDate } },
      { occurredAt: occurredAtDate, id: { lt: eventId } },
    ],
  };
}

function shouldReadSyntheticRecords(cursor: CursorPayload | null): boolean {
  if (cursor === null) return true;
  const occurredAt = cursor.last.occurredAt;
  const eventId = cursor.last.eventId;
  if (occurredAt === undefined || eventId === undefined || occurredAt === null || eventId === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing record position.');
  }
  return true;
}

function syntheticRecordCursorWhere(cursor: CursorPayload | null): Prisma.DeliveryStopWhereInput {
  if (cursor === null) return {};
  const occurredAt = cursor.last.occurredAt;
  const eventId = cursor.last.eventId;
  if (occurredAt === undefined || eventId === undefined || occurredAt === null || eventId === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing record position.');
  }
  if (occurredAt !== '') return {};
  const stopId = eventId.startsWith(syntheticRecordPrefix) ? eventId.slice(syntheticRecordPrefix.length) : eventId;
  return { id: { lt: stopId } };
}

function labelCursorWhere(
  cursor: CursorPayload | null,
  field: 'canonicalName' | 'displayName' | 'externalCustomerCode' | 'label' | 'name',
) {
  if (cursor === null) return {};
  const label = cursor.last.label;
  const id = cursor.last.id;
  if (label === undefined || id === undefined || label === null || id === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing list position.');
  }
  return {
    OR: [
      { [field]: { gt: label } },
      { [field]: label, id: { gt: id } },
    ],
  };
}

function effectiveLabelCursorSql(cursor: CursorPayload | null, effectiveLabelExpression: Prisma.Sql, idExpression: Prisma.Sql): Prisma.Sql {
  if (cursor === null) return Prisma.empty;
  const label = cursor.last.label;
  const id = cursor.last.id;
  if (label === undefined || id === undefined || label === null || id === null) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'cursor is missing list position.');
  }
  return Prisma.sql`
    AND (
      LOWER(${effectiveLabelExpression}) > LOWER(${label})
      OR (LOWER(${effectiveLabelExpression}) = LOWER(${label}) AND ${idExpression} > ${id})
    )
  `;
}

function stripRecordCursor(row: RecordCursorRow): DsvV1RecordRow {
  const { cursorEventId, ...record } = row;
  void cursorEventId;
  return record;
}

const syntheticRecordPrefix = 'synthetic:';
const neverMatchUuid = '00000000-0000-0000-0000-000000000000';

function syntheticRecordId(stopId: string): string {
  return `${syntheticRecordPrefix}${stopId}`;
}

function resolveWindowDate(window: DsvV1DateWindow, dates: DsvV1TenantDateResolution): string {
  switch (window) {
    case 'today':
      return dates.today;
    case 'tomorrow':
      return dates.tomorrow;
    case 'day-after-tomorrow':
      return dates.dayAfterTomorrow;
  }
}

function localDateInTimeZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Unable to resolve tenant-local date.', { timezone });
  }
  return `${year}-${month}-${day}`;
}

function addCalendarDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'serviceDate must be YYYY-MM-DD.', { serviceDate: isoDate });
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function serviceDateAsDbDate(serviceDate: string): Date {
  assertIsoDate(serviceDate);
  return new Date(`${serviceDate}T00:00:00.000Z`);
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'serviceDate must be YYYY-MM-DD.', { serviceDate: value });
  }
}

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date('2026-01-01T00:00:00.000Z'));
    return true;
  } catch {
    return false;
  }
}

function isNonEmpty(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}
