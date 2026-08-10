import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import type { DsvAdminPrincipal, DsvCustomerUserPrincipal } from './dsv-principal.js';
import type {
  DsvV1ConditionListItemRow,
  DsvV1ControlSummaryInput,
  DsvV1CustomerDeliveryInquiryRow,
  DsvV1CustomerListItemRow,
  DsvV1DestinationListItemRow,
  DsvV1DispatchChangeRequestDto,
  DsvV1DriverListItemRow,
  DsvV1EtaStatus,
  DsvV1EventRowInput,
  DsvV1OrderMessageSummaryRow,
  DsvV1PageInfo,
  DsvV1ProofRowInput,
  DsvV1RecordRow,
  DsvV1RoutePlanStopEtaInput,
  DsvV1SellerOrderSummaryRow,
  DsvV1VehicleListItemRow,
} from './dsv-v1-read.dto.js';
import {
  deriveDsvTimeConstraintState,
  dsvTimeConstraintAuditEvents,
} from './dsv-time-constraint.js';
import { normalizeRouteOpsUiSettings } from '../route-ops/route-ops-ui-settings.js';

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
export type DsvV1ReadErrorCode = 'BAD_REQUEST' | 'DEPENDENCY_UNAVAILABLE' | 'NOT_FOUND';
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
type DsvV1RecordEventType =
  | DsvV1PublicEventType
  | 'NOTE_ADDED'
  | 'PICKUP_COMPLETED'
  | 'ROUTE_PAUSED';

export type DsvV1PaginatedRead<T> = {
  items: T[];
  page: DsvV1PageInfo;
};

export type DsvV1CustomerDeliveryReadResult = DsvV1PaginatedRead<DsvV1CustomerDeliveryInquiryRow> & {
  emptyReason?: DsvV1EmptyReason;
  serviceDate: string;
  timezone: string;
};

export type DsvV1CustomerRouteScopeRow = {
  routePlanId: string;
  sellerOrderId: string;
  vehicleId: string;
  vehicleLatitude?: number | null;
  vehicleLongitude?: number | null;
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

type DsvV1RoutePlanStopReadRow = Omit<DsvV1EtaReadRow, 'routePlanStopId'> & {
  id: string;
  sequence: number;
};

export type DsvV1ReadListInput = {
  cursor?: string | null;
  limit?: number | string | null;
};

export type DsvV1VehicleTemperatureHistoryInput = {
  from?: Date;
  limit?: number;
  to?: Date;
  vehicleId: string;
};

export type DsvV1VehicleTemperatureHistorySample = {
  observedAt: string;
  temperatureA: number | null;
  temperatureB: number | null;
};

export type DsvV1VehicleTemperatureHistoryResult = {
  samples: DsvV1VehicleTemperatureHistorySample[];
  vehicleId: string;
};

export type DsvV1VehicleGpsTrailHistoryInput = {
  serviceDate?: string | null;
  vehicleId: string;
};

export type DsvV1VehicleGpsTrailSample = {
  distanceTodayKm: number | null;
  ignitionOn: boolean | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKph: number | null;
};

export type DsvV1VehicleGpsTrailSegment = {
  samples: DsvV1VehicleGpsTrailSample[];
};

export type DsvV1VehicleGpsTrailSession = {
  completedAt: string | null;
  completionEventId: string | null;
  endpoint: {
    endedAt: string | null;
    reason: 'DEPOT_RETURNED' | 'LAST_VALID_SAMPLE' | 'NO_SAMPLES' | 'RESTARTED' | 'ROUTE_COMPLETED' | 'ROUTE_PAUSED';
  };
  restart: {
    restartedAt: string;
    restartEventId: string | null;
  } | null;
  routePlanId: string;
  segments: DsvV1VehicleGpsTrailSegment[];
  sessionIndex: number;
  startedAt: string;
  startEventId: string | null;
  startSource: 'PLANNED_DEPARTURE' | 'ROUTE_STARTED';
};

export type DsvV1VehicleGpsTrailHistoryResult = {
  serviceDate: string;
  sessions: DsvV1VehicleGpsTrailSession[];
  timezone: string;
  vehicleId: string;
};

export type DsvV1ServiceDateInput = DsvV1ReadListInput & {
  serviceDate?: string | null;
};

export type DsvV1RecordsInput = {
  limit?: number | string | null;
  page?: number | string | null;
  serviceDate?: string | null;
};

export type DsvV1DispatchListInput = DsvV1ServiceDateInput & {
  destinationName?: string | null;
  orderNumber?: string | null;
};

export type DsvV1CustomerDeliveriesInput = DsvV1ReadListInput & {
  includeGpsTrails?: boolean | null;
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
  listCustomerDeliveriesForAdmin(
    principal: DsvAdminPrincipal,
    customerId: string,
    input?: DsvV1CustomerDeliveriesInput,
  ): Promise<DsvV1CustomerDeliveryReadResult>;
  listCustomerRouteScope(
    principal: DsvCustomerUserPrincipal,
    serviceDate: string,
  ): Promise<DsvV1CustomerRouteScopeRow[]>;
  listCustomerRouteScopeForAdmin(
    principal: DsvAdminPrincipal,
    customerId: string,
    serviceDate: string,
  ): Promise<DsvV1CustomerRouteScopeRow[]>;
  listCustomerGpsTrailHistories(
    principal: DsvCustomerUserPrincipal,
    serviceDate: string,
    scope: readonly DsvV1CustomerRouteScopeRow[],
  ): Promise<DsvV1VehicleGpsTrailHistoryResult[]>;
  listCustomerGpsTrailHistoriesForAdmin(
    principal: DsvAdminPrincipal,
    serviceDate: string,
    scope: readonly DsvV1CustomerRouteScopeRow[],
  ): Promise<DsvV1VehicleGpsTrailHistoryResult[]>;
  listCustomers(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1CustomerListItemRow>>;
  listDestinations(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1DestinationListItemRow>>;
  listDispatches(principal: DsvAdminPrincipal, input?: DsvV1DispatchListInput): Promise<DsvV1PaginatedRead<DsvV1SellerOrderSummaryRow>>;
  listDrivers(principal: DsvAdminPrincipal, input?: DsvV1ReadListInput): Promise<DsvV1PaginatedRead<DsvV1DriverListItemRow>>;
  listRecords(principal: DsvAdminPrincipal, input?: DsvV1RecordsInput): Promise<DsvV1PaginatedRead<DsvV1RecordRow>>;
  listVehicleTemperatureHistory(
    principal: DsvAdminPrincipal,
    input: DsvV1VehicleTemperatureHistoryInput,
  ): Promise<DsvV1VehicleTemperatureHistoryResult>;
  listVehicleGpsTrailHistory(
    principal: DsvAdminPrincipal,
    input: DsvV1VehicleGpsTrailHistoryInput,
  ): Promise<DsvV1VehicleGpsTrailHistoryResult>;
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
  | 'dsvAuditEvent'
  | 'dsvVehicleDriverAssignment'
  | 'dsvTransportCondition'
  | 'order'
  | 'routePlan'
  | 'shop'
  | 'uvisVehicleTelemetrySample'
  | 'vehicle'
> & Partial<Pick<PrismaClient, 'uvisTelemetryPollState' | 'uvisVehicleTelemetryCurrent'>>;

type DsvV1VehicleGpsTelemetry = {
  ignitionOn: boolean | null;
  latitude: Prisma.Decimal | number | string | null;
  longitude: Prisma.Decimal | number | string | null;
  observedAt: Date;
  speedKph: Prisma.Decimal | number | string | null;
  distanceTodayKm: Prisma.Decimal | number | string | null;
  staleAfter: Date;
  vehicleId: string;
};

type DsvV1VehicleTemperatureTelemetry = {
  observedAt: Date;
  staleAfter: Date;
  temperatureA: Prisma.Decimal | number | string | null;
  temperatureB: Prisma.Decimal | number | string | null;
  vehicleId: string;
};

type DsvV1VehicleTelemetryRead = Pick<DsvV1VehicleListItemRow,
  | 'distanceTodayKm'
  | 'ignitionOn'
  | 'speedKph'
  | 'temperatureA'
  | 'temperatureB'
  | 'temperatureObservedAt'
  | 'temperatureStale'
  | 'vehicleLatitude'
  | 'vehicleLongitude'
  | 'vehiclePositionObservedAt'
  | 'vehiclePositionStale'
  | 'vehicleStopped'
> & {
  gps?: DsvV1VehicleGpsTelemetry;
  temperature?: DsvV1VehicleTemperatureTelemetry;
};

type CursorPayload = {
  customerId?: string;
  destinationName?: string;
  endpoint: DsvV1ReadEndpoint;
  last: Record<string, string | null>;
  limit: number;
  orderNumber?: string;
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
  orderCount: number;
  status: string | null;
};

type DestinationManagementRow = {
  displayName: string;
  id: string;
  normalizedAddress: Prisma.JsonValue;
};

const dispatchSort = 'serviceDate:asc,sellerOrderKey:asc,orderId:asc';
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
const recordEventAllowlist = new Set<DsvV1RecordEventType>([
  ...eventAllowlist,
  'NOTE_ADDED',
  'PICKUP_COMPLETED',
  'ROUTE_PAUSED',
]);

export class DsvV1ReadQueryError extends Error {
  readonly httpStatus: 400 | 404 | 503;

  constructor(readonly code: DsvV1ReadErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'DsvV1ReadQueryError';
    this.httpStatus = code === 'BAD_REQUEST' ? 400 : code === 'NOT_FOUND' ? 404 : 503;
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
    const items = await this.enrichCustomerVehiclePositions(
      principal.shopId,
      rows.slice(0, limit).map(toCustomerDeliveryInquiryRow),
    );
    return {
      ...(items.length === 0 ? { emptyReason: 'NO_DELIVERIES' as const } : {}),
      items,
      page: toPage(nextOrderCursor(rows, limit, context)),
      serviceDate: datePolicy.serviceDate,
      timezone: datePolicy.timezone,
    };
  }

  async listCustomerDeliveriesForAdmin(
    principal: DsvAdminPrincipal,
    customerId: string,
    input: DsvV1CustomerDeliveriesInput = {},
  ): Promise<DsvV1CustomerDeliveryReadResult> {
    return this.listCustomerDeliveries({
      customerId,
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:customer-deliveries:read'],
      shopId: principal.shopId,
    }, input);
  }

  async listCustomerRouteScope(
    principal: DsvCustomerUserPrincipal,
    serviceDate: string,
  ): Promise<DsvV1CustomerRouteScopeRow[]> {
    assertIsoDate(serviceDate);
    const rows = await this.prisma.order.findMany({
      select: customerRouteScopeOrderSelect,
      where: {
        customerId: principal.customerId,
        shopId: principal.shopId,
        deliveryStops: {
          some: { deliveryDate: serviceDateAsDbDate(serviceDate), shopId: principal.shopId },
        },
      },
    });
    return this.enrichCustomerRouteScopePositions(principal.shopId, rows.flatMap(toCustomerRouteScopeRow));
  }

  async listCustomerRouteScopeForAdmin(
    principal: DsvAdminPrincipal,
    customerId: string,
    serviceDate: string,
  ): Promise<DsvV1CustomerRouteScopeRow[]> {
    return this.listCustomerRouteScope({
      customerId,
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:customer-deliveries:read'],
      shopId: principal.shopId,
    }, serviceDate);
  }

  async listCustomerGpsTrailHistories(
    principal: DsvCustomerUserPrincipal,
    serviceDate: string,
    scope: readonly DsvV1CustomerRouteScopeRow[],
  ): Promise<DsvV1VehicleGpsTrailHistoryResult[]> {
    assertIsoDate(serviceDate);
    const routePlanIdsByVehicle = new Map<string, Set<string>>();
    for (const item of scope) {
      const routePlanIds = routePlanIdsByVehicle.get(item.vehicleId) ?? new Set<string>();
      routePlanIds.add(item.routePlanId);
      routePlanIdsByVehicle.set(item.vehicleId, routePlanIds);
    }
    return Promise.all([...routePlanIdsByVehicle].map(async ([vehicleId, routePlanIds]) => {
      const history = await this.listVehicleGpsTrailHistoryForShop(principal.shopId, { serviceDate, vehicleId });
      return {
        ...history,
        sessions: history.sessions.filter((session) => routePlanIds.has(session.routePlanId)),
      };
    }));
  }

  async listCustomerGpsTrailHistoriesForAdmin(
    principal: DsvAdminPrincipal,
    serviceDate: string,
    scope: readonly DsvV1CustomerRouteScopeRow[],
  ): Promise<DsvV1VehicleGpsTrailHistoryResult[]> {
    return this.listCustomerGpsTrailHistories({
      customerId: '',
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:customer-deliveries:read'],
      shopId: principal.shopId,
    }, serviceDate, scope);
  }

  async listDispatches(
    principal: DsvAdminPrincipal,
    input: DsvV1DispatchListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1SellerOrderSummaryRow>> {
    const serviceDate = await this.resolveAdminServiceDate(principal.shopId, input.serviceDate);
    const limit = parseLimit(input.limit);
    const destinationName = normalizeSearchText(input.destinationName);
    const orderNumber = normalizeSearchText(input.orderNumber);
    const context: CursorContext = {
      ...(destinationName === undefined ? {} : { destinationName }),
      endpoint: 'dispatches',
      limit,
      ...(orderNumber === undefined ? {} : { orderNumber }),
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
        ...(orderNumber === undefined
          ? {}
          : { sellerOrderKey: { contains: orderNumber, mode: 'insensitive' } }),
        ...(destinationName === undefined
          ? {}
          : {
              OR: [
                { destination: { canonicalName: { contains: destinationName, mode: 'insensitive' } } },
                {
                  deliveryStops: {
                    some: {
                      deliveryDate: serviceDateAsDbDate(serviceDate),
                      recipientName: { contains: destinationName, mode: 'insensitive' },
                      shopId: principal.shopId,
                    },
                  },
                },
              ],
            }),
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
    input: DsvV1RecordsInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1RecordRow>> {
    const serviceDate = input.serviceDate ?? undefined;
    if (serviceDate !== undefined) assertIsoDate(serviceDate);
    const limit = parseLimit(input.limit);
    const currentPage = parsePageNumber(input.page);
    const where: Prisma.DeliveryStopWhereInput = {
      ...(serviceDate === undefined ? {} : { deliveryDate: serviceDateAsDbDate(serviceDate) }),
      order: { shopId: principal.shopId },
      shopId: principal.shopId,
    };
    const [totalItems, rows] = await Promise.all([
      this.prisma.deliveryStop.count({ where }),
      this.prisma.deliveryStop.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: recordStopSelect(principal.shopId),
        skip: (currentPage - 1) * limit,
        take: limit,
        where,
      }),
    ]);
    const records = rows.map(toRecordRow);
    const totalPages = Math.ceil(totalItems / limit);
    return {
      items: records.map(stripRecordCursor),
      page: {
        currentPage,
        hasMore: currentPage < totalPages,
        pageSize: limit,
        totalItems,
        totalPages,
      },
    };
  }

  async listDrivers(
    principal: DsvAdminPrincipal,
    input: DsvV1ReadListInput = {},
  ): Promise<DsvV1PaginatedRead<DsvV1DriverListItemRow>> {
    return this.listManagement('drivers', principal.shopId, input, async (page) => {
      const rows = await this.prisma.driver.findMany({
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        select: {
          displayName: true,
          dsvProfile: { select: { age: true, career: true, gender: true, score: true, traits: true, zone: true } },
          id: true,
          phone: true,
          status: true,
        },
        take: page.limit + 1,
        where: { dsvProfile: { isNot: null }, shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'displayName') },
      });
      return rows.map((row) => ({
        ...(row.dsvProfile ? {
          age: row.dsvProfile.age,
          career: row.dsvProfile.career,
          gender: row.dsvProfile.gender,
          score: row.dsvProfile.score,
          traits: row.dsvProfile.traits,
          zone: row.dsvProfile.zone,
        } : {}),
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
        select: {
          dsvProfile: { select: { note: true, typeLabel: true } },
          dsvTelematicsDevice: { select: { capabilities: true, serialNumber: true } },
          id: true,
          label: true,
          licensePlate: true,
          status: true,
          vehicleType: true,
        },
        take: page.limit + 1,
        where: { dsvProfile: { isNot: null }, shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'label') },
      });
      const assignmentsByVehicleId = await this.listVehicleDriverAssignments(
        principal.shopId,
        rows.map((row) => row.id),
      );
      const telemetryByVehicleId = await this.listVehicleTelemetry(principal.shopId, rows.map((row) => row.id));
      const telemetryActivity = await this.getTelemetryActivity(principal.shopId);
      return rows.map((row) => {
        const telemetry = { ...telemetryByVehicleId.get(row.id) };
        delete telemetry.gps;
        delete telemetry.temperature;
        return {
          displayName: row.label,
          driverAssignments: assignmentsByVehicleId.get(row.id) ?? [],
          ...telemetry,
          ...(row.dsvProfile ? {
            note: row.dsvProfile.note,
            type: row.dsvProfile.typeLabel,
          } : {}),
          status: row.status,
          ...(row.dsvTelematicsDevice === null || telemetryActivity === null ? {} : { telemetryActivity }),
          ...(row.dsvTelematicsDevice?.serialNumber === undefined
            ? {}
            : {
                telematicsCapabilities: row.dsvTelematicsDevice.capabilities,
                telematicsSerialNumber: row.dsvTelematicsDevice.serialNumber,
              }),
          vehicleId: row.id,
          vehiclePlate: row.licensePlate,
          vehicleType: row.dsvProfile?.typeLabel || row.vehicleType,
        };
      });
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
          (
            SELECT COUNT(*)::int
            FROM orders
            WHERE orders."shopId" = customers."shopId"
              AND orders."customerId" = customers.id
          ) AS "orderCount",
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
        orderCount: row.orderCount,
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
        select: {
          code: true,
          description: true,
          id: true,
          name: true,
          status: true,
          temperatureAlertEnabled: true,
          temperatureMaxC: true,
          temperatureMinC: true,
        },
        take: page.limit + 1,
        where: { shopId: principal.shopId, ...labelCursorWhere(page.cursor, 'name') },
      });
      return rows.map((row) => ({
        code: row.code,
        conditionId: row.id,
        description: row.description,
        name: row.name,
        status: row.status,
        temperatureAlertEnabled: row.temperatureAlertEnabled,
        temperatureMaxC: decimalToNumber(row.temperatureMaxC),
        temperatureMinC: decimalToNumber(row.temperatureMinC),
      }));
    });
  }

  async listVehicleTemperatureHistory(
    principal: DsvAdminPrincipal,
    input: DsvV1VehicleTemperatureHistoryInput,
  ): Promise<DsvV1VehicleTemperatureHistoryResult> {
    const vehicle = await this.prisma.vehicle.findFirst({
      select: { id: true },
      where: { id: input.vehicleId, shopId: principal.shopId },
    });
    if (vehicle === null) throw new DsvV1ReadQueryError('NOT_FOUND', 'Vehicle not found.');
    const to = input.to ?? this.clock();
    const from = input.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    if (from.getTime() > to.getTime()) {
      throw new DsvV1ReadQueryError('BAD_REQUEST', 'from must be before or equal to to.');
    }
    const limit = input.limit ?? 288;
    const rows = await this.prisma.uvisVehicleTelemetrySample.findMany({
      orderBy: [{ observedAt: 'desc' }],
      select: { observedAt: true, temperatureA: true, temperatureB: true },
      take: limit,
      where: {
        observedAt: { gte: from, lte: to },
        shopId: principal.shopId,
        sourceKind: 'TEMPERATURE_RECORDER',
        vehicleId: vehicle.id,
      },
    });
    return {
      samples: rows.reverse().map((row) => ({
        observedAt: row.observedAt.toISOString(),
        temperatureA: decimalToNumber(row.temperatureA),
        temperatureB: decimalToNumber(row.temperatureB),
      })),
      vehicleId: vehicle.id,
    };
  }

  async listVehicleGpsTrailHistory(
    principal: DsvAdminPrincipal,
    input: DsvV1VehicleGpsTrailHistoryInput,
  ): Promise<DsvV1VehicleGpsTrailHistoryResult> {
    return this.listVehicleGpsTrailHistoryForShop(principal.shopId, input);
  }

  private async listVehicleGpsTrailHistoryForShop(
    shopId: string,
    input: DsvV1VehicleGpsTrailHistoryInput,
  ): Promise<DsvV1VehicleGpsTrailHistoryResult> {
    const serviceDate = await this.resolveAdminServiceDate(shopId, input.serviceDate);
    const timezone = await this.resolveTenantTimezone(shopId);
    const vehicle = await this.prisma.vehicle.findFirst({
      select: { id: true },
      where: { id: input.vehicleId, shopId },
    });
    if (vehicle === null) throw new DsvV1ReadQueryError('NOT_FOUND', 'Vehicle not found.');

    const shop = await this.prisma.shop.findUnique({
      select: { routeOpsUiSettings: true },
      where: { id: shopId },
    });
    const plannedDepartureTime = normalizeRouteOpsUiSettings(shop?.routeOpsUiSettings).plannedDepartureTime;
    const window = serviceDateWindowUtc(serviceDate, timezone);
    const routePlans = await this.prisma.routePlan.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        constraints: true,
        depotLatitude: true,
        depotLongitude: true,
        driverEvents: {
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          select: { eventType: true, id: true, occurredAt: true },
          where: { eventType: { in: ['ROUTE_COMPLETED', 'ROUTE_PAUSED', 'ROUTE_STARTED'] }, shopId },
        },
        id: true,
        planDate: true,
      },
      where: {
        planDate: serviceDateAsDbDate(serviceDate),
        shopId,
        status: { not: 'CANCELLED' },
        vehicleId: vehicle.id,
      },
    });
    const samples = await this.prisma.uvisVehicleTelemetrySample.findMany({
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      select: {
        distanceTodayKm: true,
        ignitionOn: true,
        latitude: true,
        longitude: true,
        observedAt: true,
        speedKph: true,
        staleAfter: true,
      },
      where: {
        latitude: { not: null },
        longitude: { not: null },
        observedAt: { gte: window.start, lt: window.end },
        shopId,
        sourceKind: 'VEHICLE_GPS',
        vehicleId: vehicle.id,
      },
    });
    const validSamples = samples.flatMap((sample) => {
      const latitude = decimalToNumber(sample.latitude);
      const longitude = decimalToNumber(sample.longitude);
      if (latitude === null || longitude === null) return [];
      return [{ ...sample, latitude, longitude }];
    });

    const plannedStartRoutePlanId = selectPlannedStartRoutePlanId(routePlans);
    const routeSessions = routePlans.flatMap((routePlan) => gpsTrailSessionsForRoutePlan({
      includePlannedStart: routePlan.id === plannedStartRoutePlanId,
      plannedDepartureTime,
      routePlan,
      samples: validSamples,
      serviceDate,
      timezone,
      window,
    }));
    const sessions = routeSessions.length > 0
      ? routeSessions
      : gpsTrailSessionsWithoutRoutePlan({
          plannedDepartureTime,
          samples: validSamples,
          serviceDate,
          timezone,
          vehicleId: vehicle.id,
        });
    return {
      serviceDate,
      sessions: normalizeGpsTrailSessionTimeline(sessions),
      timezone,
      vehicleId: vehicle.id,
    };
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

  private async enrichCustomerVehiclePositions(
    shopId: string,
    items: DsvV1CustomerDeliveryInquiryRow[],
  ): Promise<DsvV1CustomerDeliveryInquiryRow[]> {
    const gpsByVehicleId = await this.listFreshVehicleGpsTelemetry(
      shopId,
      items.map((item) => item.vehicleId ?? null).filter(isNonEmpty),
    );
    if (gpsByVehicleId.size === 0) return items;
    return items.map((item) => {
      const gps = item.vehicleId === undefined || item.vehicleId === null ? undefined : gpsByVehicleId.get(item.vehicleId);
      const latitude = decimalToNumber(gps?.latitude ?? null);
      const longitude = decimalToNumber(gps?.longitude ?? null);
      if (latitude === null || longitude === null) return item;
      return { ...item, vehicleLatitude: latitude, vehicleLongitude: longitude };
    });
  }

  private async enrichCustomerRouteScopePositions(
    shopId: string,
    rows: DsvV1CustomerRouteScopeRow[],
  ): Promise<DsvV1CustomerRouteScopeRow[]> {
    const gpsByVehicleId = await this.listFreshVehicleGpsTelemetry(shopId, rows.map((row) => row.vehicleId));
    if (gpsByVehicleId.size === 0) return rows;
    return rows.map((row) => {
      const gps = gpsByVehicleId.get(row.vehicleId);
      const latitude = decimalToNumber(gps?.latitude ?? null);
      const longitude = decimalToNumber(gps?.longitude ?? null);
      if (latitude === null || longitude === null) return row;
      return { ...row, vehicleLatitude: latitude, vehicleLongitude: longitude };
    });
  }

  private async listFreshVehicleGpsTelemetry(
    shopId: string,
    vehicleIds: readonly string[],
  ): Promise<Map<string, DsvV1VehicleGpsTelemetry>> {
    const current = this.prisma.uvisVehicleTelemetryCurrent;
    const uniqueVehicleIds = [...new Set(vehicleIds)];
    if (current === undefined || uniqueVehicleIds.length === 0) return new Map();
    const now = this.clock();
    const rows = await current.findMany({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: {
        distanceTodayKm: true,
        ignitionOn: true,
        latitude: true,
        longitude: true,
        observedAt: true,
        speedKph: true,
        staleAfter: true,
        vehicleId: true,
      },
      where: {
        shopId,
        sourceKind: 'VEHICLE_GPS',
        staleAfter: { gt: now },
        vehicleId: { in: uniqueVehicleIds },
      },
    });
    const gpsByVehicleId = new Map<string, DsvV1VehicleGpsTelemetry>();
    for (const row of rows) {
      if (gpsByVehicleId.has(row.vehicleId) || row.staleAfter.getTime() <= now.getTime()) {
        continue;
      }
      gpsByVehicleId.set(row.vehicleId, row);
    }
    return gpsByVehicleId;
  }

  private async listVehicleTelemetry(
    shopId: string,
    vehicleIds: readonly string[],
  ): Promise<Map<string, DsvV1VehicleTelemetryRead>> {
    const current = this.prisma.uvisVehicleTelemetryCurrent;
    const uniqueVehicleIds = [...new Set(vehicleIds)];
    if (current === undefined || uniqueVehicleIds.length === 0) return new Map();
    const rows = await current.findMany({
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: {
        distanceTodayKm: true,
        ignitionOn: true,
        latitude: true,
        longitude: true,
        observedAt: true,
        sourceKind: true,
        speedKph: true,
        staleAfter: true,
        temperatureA: true,
        temperatureB: true,
        vehicleId: true,
      },
      where: {
        shopId,
        sourceKind: { in: ['VEHICLE_GPS', 'TEMPERATURE_RECORDER'] },
        vehicleId: { in: uniqueVehicleIds },
      },
    });
    const byVehicleId = new Map<string, DsvV1VehicleTelemetryRead>();
    const now = this.clock();
    for (const row of rows) {
      const telemetry = byVehicleId.get(row.vehicleId) ?? {};
      if (row.sourceKind === 'VEHICLE_GPS' && telemetry.gps === undefined) {
        const gps: DsvV1VehicleGpsTelemetry = row;
        telemetry.gps = gps;
        telemetry.vehicleLatitude = decimalToNumber(gps.latitude);
        telemetry.vehicleLongitude = decimalToNumber(gps.longitude);
        telemetry.vehiclePositionObservedAt = gps.observedAt;
        telemetry.vehiclePositionStale = gps.staleAfter.getTime() <= now.getTime();
        telemetry.ignitionOn = gps.ignitionOn;
        telemetry.speedKph = decimalToNumber(gps.speedKph);
        telemetry.distanceTodayKm = decimalToNumber(gps.distanceTodayKm);
        telemetry.vehicleStopped = stoppedFlag(gps.ignitionOn, telemetry.speedKph);
      }
      if (row.sourceKind === 'TEMPERATURE_RECORDER' && telemetry.temperature === undefined) {
        const temperature: DsvV1VehicleTemperatureTelemetry = row;
        telemetry.temperature = temperature;
        telemetry.temperatureA = decimalToNumber(temperature.temperatureA);
        telemetry.temperatureB = decimalToNumber(temperature.temperatureB);
        telemetry.temperatureObservedAt = temperature.observedAt;
        telemetry.temperatureStale = temperature.staleAfter.getTime() <= now.getTime();
      }
      byVehicleId.set(row.vehicleId, telemetry);
    }
    return byVehicleId;
  }

  private async getTelemetryActivity(shopId: string): Promise<'ACTIVE' | 'DORMANT' | null> {
    const pollState = this.prisma.uvisTelemetryPollState;
    if (pollState === undefined) return null;
    const state = await pollState.findUnique({
      select: { activity: true },
      where: { shopId },
    });
    return state?.activity ?? null;
  }
}

function gpsTrailSessionsWithoutRoutePlan(input: {
  plannedDepartureTime: string;
  samples: GpsTrailSampleRow[];
  serviceDate: string;
  timezone: string;
  vehicleId: string;
}): DsvV1VehicleGpsTrailSession[] {
  const startedAt = localDateTimeInTimeZoneToUtc(input.serviceDate, input.plannedDepartureTime, input.timezone);
  const samples = input.samples.filter((sample) => sample.observedAt.getTime() >= startedAt.getTime());
  if (samples.length === 0) return [];
  const endedAt = lastSampleAt(samples);
  return [{
    completedAt: null,
    completionEventId: null,
    endpoint: { endedAt: endedAt?.toISOString() ?? null, reason: 'LAST_VALID_SAMPLE' },
    restart: null,
    routePlanId: `unassigned:${input.vehicleId}:${input.serviceDate}`,
    segments: splitGpsTrailSegments(samples).map((segment) => ({ samples: segment.map(toGpsTrailSample) })),
    sessionIndex: 0,
    startedAt: startedAt.toISOString(),
    startEventId: null,
    startSource: 'PLANNED_DEPARTURE',
  }];
}

const proofStatusSelect = {
  deletedAt: true,
  id: true,
} satisfies Prisma.DriverProofMediaSelect;

const recordProofMediaSelect = {
  contentType: true,
  deletedAt: true,
  driver: { select: { displayName: true } },
  id: true,
  kind: true,
  originalFilename: true,
  sizeBytes: true,
  source: true,
  uploadedAt: true,
} satisfies Prisma.DriverProofMediaSelect;

const publicEventSelect = {
  eventType: true,
  id: true,
  occurredAt: true,
} satisfies Prisma.DriverEventSelect;

const recordEventSelect = {
  driver: { select: { displayName: true } },
  eventType: true,
  id: true,
  latitude: true,
  longitude: true,
  occurredAt: true,
} satisfies Prisma.DriverEventSelect;

const routePlanStopSelect = {
  estimatedArrivalAt: true,
  etaInputRouteVersionId: true,
  etaSource: true,
  etaStatus: true,
  id: true,
  routePlanId: true,
  sequence: true,
} satisfies Prisma.RoutePlanStopSelect;

const customerRouteScopeOrderSelect = {
  currentRouteVersion: {
    select: {
      routePlanId: true,
      routePlan: {
        select: {
            trackingGeometry: {
              select: {
                lastLatitude: true,
                lastLongitude: true,
              },
            },
            vehicleId: true,
          },
        },
    },
  },
  id: true,
} satisfies Prisma.OrderSelect;

const timeConstraintAuditSelect = {
  actorId: true,
  eventType: true,
  id: true,
  occurredAt: true,
  redactedDiff: true,
} satisfies Prisma.DsvAuditEventSelect;

function customerDeliveryOrderSelect(serviceDate: string, shopId: string) {
  return {
    currentRouteVersionId: true,
    currentRouteVersion: {
      select: {
        createdAt: true,
        driverId: true,
        routePlanId: true,
        routePlan: {
          select: {
            vehicle: {
              select: {
                id: true,
                label: true,
                licensePlate: true,
              },
            },
            vehicleId: true,
            trackingGeometry: {
              select: {
                lastLatitude: true,
                lastLongitude: true,
              },
            },
            driverEvents: {
              orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
              select: publicEventSelect,
              where: { eventType: { in: ['ROUTE_COMPLETED', 'ROUTE_PAUSED', 'ROUTE_STARTED'] }, shopId },
            },
            status: true,
          },
        },
      },
    },
    customer: {
      select: { displayName: true, id: true, notificationEmailEnabled: true, notificationEmailRecipient: true },
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
          select: proofStatusSelect,
          where: { shopId },
        },
        dsvDispatchImportRows: {
          orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
          select: { conditionCode: true, shippedBoxes: true },
          take: 1,
          where: { shopId, status: 'APPLIED' },
        },
        dsvDispatchChangeRequests: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            commandReceipt: { select: { commandId: true } },
            createdAt: true,
            id: true,
            routePlanId: true,
            routeVersionId: true,
            status: true,
            timeWindowEnd: true,
            timeWindowStart: true,
            type: true,
          },
          take: 1,
          where: { shopId, status: 'PENDING_ACK' },
        },
        id: true,
        address1: true,
        address2: true,
        city: true,
        countryCode: true,
        instructions: true,
        latitude: true,
        longitude: true,
        postalCode: true,
        province: true,
        recipientName: true,
        routePlanStops: {
          orderBy: [{ createdAt: 'desc' }],
          select: routePlanStopSelect,
          where: { shopId },
        },
        status: true,
        timeWindowEnd: true,
        timeWindowStart: true,
      },
      where: { deliveryDate: serviceDateAsDbDate(serviceDate), shopId },
    },
    dsvAuditEvents: {
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: timeConstraintAuditSelect,
      where: { eventType: { in: [...dsvTimeConstraintAuditEvents] }, shopId },
    },
    destination: {
      select: {
        canonicalName: true,
        id: true,
        normalizedAddress: true,
      },
    },
    destinationId: true,
    id: true,
    orderMessages: {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        audience: true,
        authorId: true,
        authorType: true,
        body: true,
        createdAt: true,
        id: true,
        readByDriverAt: true,
      },
      take: 20,
      where: { shopId },
    },
    sellerOrderKey: true,
    sellerOrderSourceKind: true,
    sourceOrderNumber: true,
  } satisfies Prisma.OrderSelect;
}

function recordStopSelect(shopId: string) {
  return {
    address1: true,
    address2: true,
    city: true,
    countryCode: true,
    dsvDispatchImportRows: {
      orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
      select: { address: true, notes: true },
      take: 1,
      where: { shopId, status: 'APPLIED' },
    },
    driverEvents: {
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: recordEventSelect,
      where: { eventType: { in: [...recordEventAllowlist] }, shopId },
    },
    driverProofMedia: {
      orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
      select: recordProofMediaSelect,
      where: { shopId },
    },
    id: true,
    order: {
      select: {
        currentRouteVersionId: true,
        currentRouteVersion: { select: { createdAt: true } },
        deliveryStatus: true,
        dsvAuditEvents: {
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: timeConstraintAuditSelect,
          where: { eventType: { in: [...dsvTimeConstraintAuditEvents] }, shopId },
        },
        destination: { select: { canonicalName: true } },
        id: true,
        sellerOrderKey: true,
        sellerOrderSourceKind: true,
        sourceOrderNumber: true,
      },
    },
    postalCode: true,
    province: true,
    recipientName: true,
    instructions: true,
    routePlanStops: {
      orderBy: [{ createdAt: 'desc' }],
      select: routePlanStopSelect,
    },
    status: true,
    timeWindowEnd: true,
    timeWindowStart: true,
    updatedAt: true,
  } satisfies Prisma.DeliveryStopSelect;
}

type CustomerDeliveryOrderRow = Prisma.OrderGetPayload<{ select: ReturnType<typeof customerDeliveryOrderSelect> }>;
type CustomerRouteScopeOrderRow = Prisma.OrderGetPayload<{ select: typeof customerRouteScopeOrderSelect }>;
type RecordStopRow = Prisma.DeliveryStopGetPayload<{ select: ReturnType<typeof recordStopSelect> }>;
type RecordCursorRow = DsvV1RecordRow & { cursorStopId: string; cursorUpdatedAt: Date };
type GpsTrailRoutePlanRow = Prisma.RoutePlanGetPayload<{
  select: {
    constraints: true;
    depotLatitude: true;
    depotLongitude: true;
    driverEvents: {
      select: { eventType: true; id: true; occurredAt: true };
    };
    id: true;
    planDate: true;
  };
}>;
type GpsTrailSampleRow = {
  distanceTodayKm: Prisma.Decimal | number | string | null;
  ignitionOn: boolean | null;
  latitude: number;
  longitude: number;
  observedAt: Date;
  speedKph: Prisma.Decimal | number | string | null;
  staleAfter: Date;
};

function toCustomerDeliveryInquiryRow(row: CustomerDeliveryOrderRow): DsvV1CustomerDeliveryInquiryRow {
  const stop = requireSelectedCustomerDeliveryStop(row.deliveryStops[0] ?? null, row.id);
  const eta = selectCanonicalEta(stop.routePlanStops, row.currentRouteVersionId);
  const vehicle = row.currentRouteVersion?.routePlan?.vehicle ?? null;
  const vehiclePosition = row.currentRouteVersion?.routePlan?.trackingGeometry ?? null;
  const currentRouteStop = selectCurrentRouteStop(stop.routePlanStops, row.currentRouteVersion?.routePlanId ?? null);
  const routePlanId = currentRouteStop?.routePlanId ?? eta?.routePlanId ?? row.currentRouteVersion?.routePlanId ?? null;
  return {
    customerDisplayName: row.customer?.displayName ?? null,
    deliveryStatus: row.deliveryStatus,
    destinationAddress: deliveryStopAddressLabel(stop),
    destinationDisplayName: row.destination?.canonicalName ?? '',
    destinationId: requireOrderDestinationId(row.destinationId, row.id),
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(row.currentRouteVersionId, eta),
    eventRows: stop.driverEvents.map(toDtoEventRow),
    latitude: decimalToNumber(stop.latitude),
    latestCustomerMessage: latestOrderMessage(row.orderMessages ?? [], 'CUSTOMER'),
    longitude: decimalToNumber(stop.longitude),
    proofRows: stop.driverProofMedia.map(toDtoProofRow),
    ...(routePlanId === null ? {} : { routePlanId }),
    sellerOrderId: row.id,
    sellerOrderKey: row.sellerOrderKey ?? row.id,
    shippedBoxes: requireSelectedStopShippedBoxes(stop, row.id),
    vehicleDisplayName: vehicle === null ? null : vehicle.licensePlate ?? vehicle.label,
    vehicleId: vehicle?.id ?? null,
    vehicleLatitude: decimalToNumber(vehiclePosition?.lastLatitude ?? null),
    vehicleLongitude: decimalToNumber(vehiclePosition?.lastLongitude ?? null),
  };
}

function toCustomerRouteScopeRow(row: CustomerRouteScopeOrderRow): DsvV1CustomerRouteScopeRow[] {
  const routeVersion = row.currentRouteVersion;
  const routePlan = routeVersion?.routePlan ?? null;
  const vehiclePosition = routePlan?.trackingGeometry ?? null;
  const vehicleLatitude = decimalToNumber(vehiclePosition?.lastLatitude ?? null);
  const vehicleLongitude = decimalToNumber(vehiclePosition?.lastLongitude ?? null);
  if (
    routeVersion === null
    || routeVersion.routePlanId === null
    || routePlan?.vehicleId === null
    || routePlan?.vehicleId === undefined
  ) return [];
  return [{
    routePlanId: routeVersion.routePlanId,
    sellerOrderId: row.id,
    vehicleId: routePlan.vehicleId,
    vehicleLatitude,
    vehicleLongitude,
  }];
}

function requireSelectedCustomerDeliveryStop(
  stop: CustomerDeliveryOrderRow['deliveryStops'][number] | null,
  orderId: string,
): CustomerDeliveryOrderRow['deliveryStops'][number] {
  if (stop !== null) return stop;
  throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Customer delivery order is missing its selected service-date stop.', {
    orderId,
  });
}

function requireSelectedStopShippedBoxes(stop: CustomerDeliveryOrderRow['deliveryStops'][number], orderId: string): number {
  const shippedBoxes = stop.dsvDispatchImportRows[0]?.shippedBoxes ?? null;
  if (shippedBoxes !== null) return shippedBoxes;
  throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Customer delivery stop is missing shippedBoxes.', {
    deliveryStopId: stop.id,
    orderId,
  });
}

function requireOrderDestinationId(destinationId: string | null, orderId: string): string {
  if (destinationId !== null) return destinationId;
  throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Customer delivery order is missing destinationId.', {
    orderId,
  });
}

function toSellerOrderSummaryRow(row: CustomerDeliveryOrderRow): DsvV1SellerOrderSummaryRow {
  const stop = row.deliveryStops[0] ?? null;
  const importRow = stop?.dsvDispatchImportRows[0] ?? null;
  const eta = stop === null ? null : selectCanonicalEta(stop.routePlanStops, row.currentRouteVersionId);
  const currentRoute = row.currentRouteVersion;
  const currentRouteDriverId = currentRoute?.driverId ?? null;
  const currentRouteStop = stop === null
    ? null
    : selectCurrentRouteStop(stop.routePlanStops, currentRoute?.routePlanId ?? null);
  const routePlanId = currentRouteStop?.routePlanId ?? eta?.routePlanId ?? currentRoute?.routePlanId ?? null;
  const constraintState = deriveDsvTimeConstraintState({
    audits: row.dsvAuditEvents,
    currentRouteVersionCreatedAt: currentRoute?.createdAt ?? null,
    currentRouteVersionId: row.currentRouteVersionId,
    rawNote: stop?.instructions ?? null,
    timeWindowEnd: stop?.timeWindowEnd ?? null,
    timeWindowStart: stop?.timeWindowStart ?? null,
  });
  return {
    actualCompletedAt: latestDeliveredAt(stop?.driverEvents ?? []),
    assignmentStatus: currentRouteDriverId === null ? 'UNASSIGNED' : 'ASSIGNED',
    ...(importRow === null ? {} : { conditionCode: importRow.conditionCode, shippedBoxes: importRow.shippedBoxes }),
    customerId: row.customer?.id ?? '',
    customerNotificationEmailEnabled: row.customer?.notificationEmailEnabled ?? null,
    customerNotificationEmailRecipient: row.customer?.notificationEmailRecipient ?? null,
    deliveryStopId: stop?.id ?? '',
    destinationAddress: stop === null ? normalizedAddressLabel(row.destination?.normalizedAddress ?? null) : deliveryStopAddressLabel(stop),
    destinationDisplayName: row.destination?.canonicalName ?? stop?.recipientName ?? '',
    destinationId: row.destination?.id ?? '',
    driverId: currentRouteDriverId,
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(currentRouteDriverId === null ? null : row.currentRouteVersionId, eta),
    eventRows: stop?.driverEvents.map(toDtoEventRow) ?? [],
    latitude: decimalToNumber(stop?.latitude ?? null),
    latestCustomerMessage: latestOrderMessage(row.orderMessages ?? [], 'CUSTOMER'),
    latestDriverMessage: latestOrderMessage(row.orderMessages ?? [], 'DRIVER'),
    longitude: decimalToNumber(stop?.longitude ?? null),
    operationStatus: deriveOperationStatus({
      currentRouteDriverId,
      deliveryStatus: row.deliveryStatus,
      routeEvents: currentRoute?.routePlan?.driverEvents ?? [],
      routeStatus: currentRoute?.routePlan?.status ?? null,
    }),
    ...(routePlanId === null ? {} : { routePlanId }),
    rawNote: constraintState.rawNote,
    reviewStatus: constraintState.reviewStatus,
    routeConstraintStatus: constraintState.routeConstraintStatus,
    ...(currentRouteStop === null ? {} : { routeStopSequence: currentRouteStop.sequence }),
    ...(row.currentRouteVersionId === null ? {} : { routeVersionId: row.currentRouteVersionId }),
    sellerOrderId: row.id,
    sellerOrderKey: row.sellerOrderKey ?? row.id,
    changeRequest: toDsvV1ChangeRequest(stop?.dsvDispatchChangeRequests?.[0] ?? null),
    timeConstraint: constraintState.timeConstraint,
    vehicleId: currentRoute?.routePlan?.vehicleId ?? null,
  };
}

function latestOrderMessage(
  messages: readonly {
    audience: string;
    authorId: string | null;
    authorType: string;
    body: string;
    createdAt: Date;
    id: string;
    readByDriverAt: Date | null;
  }[],
  audience: 'CUSTOMER' | 'DRIVER',
): DsvV1OrderMessageSummaryRow | null {
  const message = messages.find((item) => item.audience === audience) ?? null;
  if (message === null) return null;
  return {
    audience,
    authorId: message.authorId,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt,
    messageId: message.id,
    readByDriverAt: message.readByDriverAt,
  };
}

function latestDeliveredAt(events: readonly { eventType: string; occurredAt: Date }[]): Date | null {
  return events.find((event) => event.eventType === 'STOP_DELIVERED')?.occurredAt ?? null;
}

function deriveOperationStatus(input: {
  currentRouteDriverId: string | null;
  deliveryStatus: string;
  routeEvents: readonly { eventType: string; occurredAt: Date }[];
  routeStatus: string | null;
}): NonNullable<DsvV1SellerOrderSummaryRow['operationStatus']> {
  if (input.deliveryStatus === 'DELIVERED') return 'COMPLETED';
  if (input.deliveryStatus === 'CANCELLED') return 'CANCELLED';
  if (input.routeEvents.some((event) => event.eventType === 'ROUTE_COMPLETED')) return 'COMPLETED';
  if (input.routeStatus === 'COMPLETED') return 'COMPLETED';
  if (input.routeStatus === 'CANCELLED') return 'CANCELLED';
  if (input.routeStatus === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (input.routeEvents.some((event) => event.eventType === 'ROUTE_STARTED' || event.eventType === 'ROUTE_PAUSED')) return 'IN_PROGRESS';
  if (input.currentRouteDriverId !== null || input.routeStatus === 'READY') return 'READY';
  return 'UNASSIGNED';
}

function toDsvV1ChangeRequest(changeRequest: {
  commandReceipt: { commandId: string };
  createdAt: Date;
  id: string;
  routePlanId: string;
  routeVersionId: string;
  status: string;
  timeWindowEnd: Date | null;
  timeWindowStart: Date | null;
  type: string;
} | null): DsvV1DispatchChangeRequestDto | null {
  if (changeRequest === null || changeRequest.status !== 'PENDING_ACK') return null;
  if (changeRequest.type !== 'TIME_CONSTRAINT_CHANGE' && changeRequest.type !== 'ACTIVE_ROUTE_ORDER_REMOVAL') return null;
  return {
    changeRequestId: changeRequest.id,
    commandId: changeRequest.commandReceipt.commandId,
    requestedAt: changeRequest.createdAt.toISOString(),
    routePlanId: changeRequest.routePlanId,
    routeVersionId: changeRequest.routeVersionId,
    status: 'PENDING_ACK',
    type: changeRequest.type,
    ...(changeRequest.timeWindowEnd === null ? {} : { timeWindowEnd: formatTimeOnly(changeRequest.timeWindowEnd) }),
    ...(changeRequest.timeWindowStart === null ? {} : { timeWindowStart: formatTimeOnly(changeRequest.timeWindowStart) }),
  };
}

function formatTimeOnly(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function toRecordRow(stop: RecordStopRow): RecordCursorRow {
  const eta = selectCanonicalEta(stop.routePlanStops, stop.order.currentRouteVersionId);
  const sourceAddress = stop.dsvDispatchImportRows[0]?.address.trim();
  const constraintState = deriveDsvTimeConstraintState({
    audits: stop.order.dsvAuditEvents,
    currentRouteVersionCreatedAt: stop.order.currentRouteVersion?.createdAt ?? null,
    currentRouteVersionId: stop.order.currentRouteVersionId,
    rawNote: stop.instructions ?? stop.dsvDispatchImportRows[0]?.notes ?? null,
    timeWindowEnd: stop.timeWindowEnd,
    timeWindowStart: stop.timeWindowStart,
  });
  return {
    cursorStopId: stop.id,
    cursorUpdatedAt: stop.updatedAt,
    deliveryStatus: recordDeliveryStatus(stop),
    destinationAddress: sourceAddress === undefined || sourceAddress === ''
      ? deliveryStopAddressLabel(stop)
      : sourceAddress,
    destinationDisplayName: stop.order.destination?.canonicalName ?? stop.recipientName ?? '',
    ...etaFields(eta),
    etaStatus: fallbackEtaStatus(stop.order.currentRouteVersionId, eta),
    eventRows: stop.driverEvents.map(toRecordDtoEventRow),
    proofRows: stop.driverProofMedia.map(toRecordDtoProofRow),
    rawNote: constraintState.rawNote,
    reviewStatus: constraintState.reviewStatus,
    routeConstraintStatus: constraintState.routeConstraintStatus,
    sellerOrderId: stop.order.id,
    sellerOrderKey: stop.order.sellerOrderKey ?? stop.order.id,
    timeConstraint: constraintState.timeConstraint,
  };
}

function recordDeliveryStatus(stop: RecordStopRow): string {
  const latestTerminalEvent = stop.driverEvents.find(({ eventType }) =>
    eventType === 'STOP_DELIVERED' || eventType === 'STOP_FAILED');
  if (latestTerminalEvent?.eventType === 'STOP_DELIVERED') return 'DELIVERED';
  if (latestTerminalEvent?.eventType === 'STOP_FAILED') return 'FAILED';
  if (stop.status === 'DELIVERED') return 'DELIVERED';
  if (stop.status === 'FAILED') return 'FAILED';
  return stop.order.deliveryStatus;
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

function toRecordDtoProofRow(row: RecordStopRow['driverProofMedia'][number]): DsvV1ProofRowInput {
  return {
    contentType: row.contentType,
    deletedAt: row.deletedAt,
    driverDisplayName: row.driver?.displayName ?? null,
    kind: row.kind,
    originalFilename: row.originalFilename,
    proofId: row.id,
    sizeBytes: row.sizeBytes,
    source: row.source,
    uploadedAt: row.uploadedAt,
  };
}

function toRecordDtoEventRow(row: RecordStopRow['driverEvents'][number]): DsvV1EventRowInput {
  if (!recordEventAllowlist.has(row.eventType as DsvV1RecordEventType)) {
    throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Unexpected record event type selected.', {
      eventId: row.id,
      eventType: row.eventType,
    });
  }
  return {
    driverDisplayName: row.driver?.displayName ?? null,
    eventId: row.id,
    eventType: row.eventType,
    latitude: decimalToNumber(row.latitude),
    longitude: decimalToNumber(row.longitude),
    occurredAt: row.occurredAt,
  };
}

function selectCanonicalEta(
  rows: DsvV1RoutePlanStopReadRow[],
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

function selectCurrentRouteStop(
  rows: DsvV1RoutePlanStopReadRow[],
  currentRoutePlanId: string | null,
): Pick<DsvV1RoutePlanStopReadRow, 'routePlanId' | 'sequence'> | null {
  if (currentRoutePlanId === null) return null;
  const selected = rows.find((row) => row.routePlanId === currentRoutePlanId) ?? null;
  return selected === null ? null : { routePlanId: selected.routePlanId, sequence: selected.sequence };
}

function gpsTrailSessionsForRoutePlan(input: {
  includePlannedStart: boolean;
  plannedDepartureTime: string;
  routePlan: GpsTrailRoutePlanRow;
  samples: GpsTrailSampleRow[];
  serviceDate: string;
  timezone: string;
  window: { end: Date; start: Date };
}): DsvV1VehicleGpsTrailSession[] {
  const starts: Array<{
    eventId: string | null;
    source: DsvV1VehicleGpsTrailSession['startSource'];
    startedAt: Date;
  }> = input.routePlan.driverEvents
    .filter((event) => event.eventType === 'ROUTE_STARTED')
    .map((event) => ({
      eventId: event.id,
      source: 'ROUTE_STARTED' as const,
      startedAt: event.occurredAt,
    }));
  const plannedStart = plannedRouteStart(input.routePlan, input.serviceDate, input.timezone, input.plannedDepartureTime);
  let sessionStarts = starts;
  if (starts.length === 0) {
    sessionStarts = input.includePlannedStart ? [{
        eventId: null,
        source: 'PLANNED_DEPARTURE' as const,
        startedAt: plannedStart,
      }] : [];
  } else if (input.includePlannedStart) {
    sessionStarts = [
      plannedStart.getTime() < starts[0]!.startedAt.getTime()
        ? { eventId: null, source: 'PLANNED_DEPARTURE' as const, startedAt: plannedStart }
        : starts[0]!,
      ...starts.slice(1),
    ];
  }
  const completions = input.routePlan.driverEvents.filter((event) => event.eventType === 'ROUTE_COMPLETED');
  const pauses = input.routePlan.driverEvents.filter((event) => event.eventType === 'ROUTE_PAUSED');
  const depot = depotCoordinate(input.routePlan);

  return sessionStarts.map((start, index) => {
    const nextStart = sessionStarts[index + 1] ?? null;
    const nextPause = pauses.find((event) =>
      event.occurredAt.getTime() >= start.startedAt.getTime()
      && (nextStart === null || event.occurredAt.getTime() < nextStart.startedAt.getTime())
    ) ?? null;
    const boundaryEnd = nextPause?.occurredAt ?? nextStart?.startedAt ?? input.window.end;
    const completion = completions.find((event) =>
      event.occurredAt.getTime() >= start.startedAt.getTime() && event.occurredAt.getTime() < boundaryEnd.getTime()
    ) ?? null;
    const sessionSamples = input.samples.filter((sample) =>
      sample.observedAt.getTime() >= start.startedAt.getTime() && sample.observedAt.getTime() < boundaryEnd.getTime()
    );
    const endpoint = gpsTrailEndpoint({
      completion,
      depot,
      nextStart,
      pause: nextPause,
      samples: sessionSamples,
    });
    const clippedSamples = endpoint.endedAt === null
      ? sessionSamples
      : sessionSamples.filter((sample) => sample.observedAt.getTime() <= endpoint.endedAt!.getTime());

    return {
      completedAt: completion?.occurredAt.toISOString() ?? null,
      completionEventId: completion?.id ?? null,
      endpoint: {
        endedAt: endpoint.endedAt?.toISOString() ?? null,
        reason: endpoint.reason,
      },
      restart: nextStart === null ? null : {
        restartedAt: nextStart.startedAt.toISOString(),
        restartEventId: nextStart.eventId,
      },
      routePlanId: input.routePlan.id,
      segments: splitGpsTrailSegments(clippedSamples).map((segment) => ({
        samples: segment.map(toGpsTrailSample),
      })),
      sessionIndex: index,
      startedAt: start.startedAt.toISOString(),
      startEventId: start.eventId,
      startSource: start.source,
    };
  });
}

function selectPlannedStartRoutePlanId(routePlans: GpsTrailRoutePlanRow[]): string | null {
  const firstActualStart = routePlans
    .flatMap((routePlan) => routePlan.driverEvents
      .filter((event) => event.eventType === 'ROUTE_STARTED')
      .map((event) => ({ occurredAt: event.occurredAt, routePlanId: routePlan.id })))
    .sort((left, right) => {
      const timeOrder = left.occurredAt.getTime() - right.occurredAt.getTime();
      return timeOrder === 0 ? left.routePlanId.localeCompare(right.routePlanId) : timeOrder;
    })[0] ?? null;
  return firstActualStart?.routePlanId ?? routePlans[0]?.id ?? null;
}

function normalizeGpsTrailSessionTimeline(
  sessions: DsvV1VehicleGpsTrailSession[],
): DsvV1VehicleGpsTrailSession[] {
  const ordered = [...sessions].sort((left, right) => {
    const timeOrder = Date.parse(left.startedAt) - Date.parse(right.startedAt);
    if (timeOrder !== 0) return timeOrder;
    const routeOrder = left.routePlanId.localeCompare(right.routePlanId);
    return routeOrder === 0 ? left.sessionIndex - right.sessionIndex : routeOrder;
  });
  return ordered.map((session, index) => {
    const next = ordered[index + 1] ?? null;
    if (next === null) return { ...session, restart: null };
    const nextStartedAt = Date.parse(next.startedAt);
    const endpointAt = session.endpoint.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(session.endpoint.endedAt);
    const restart = { restartedAt: next.startedAt, restartEventId: next.startEventId };
    if (endpointAt <= nextStartedAt) return { ...session, restart };
    const segments = session.segments
      .map((segment) => ({
        samples: segment.samples.filter((sample) => Date.parse(sample.observedAt) < nextStartedAt),
      }))
      .filter((segment) => segment.samples.length > 0);
    const endedAt = segments.at(-1)?.samples.at(-1)?.observedAt ?? null;
    const completionIsBeforeRestart = session.completedAt !== null && Date.parse(session.completedAt) < nextStartedAt;
    return {
      ...session,
      completedAt: completionIsBeforeRestart ? session.completedAt : null,
      completionEventId: completionIsBeforeRestart ? session.completionEventId : null,
      endpoint: { endedAt, reason: 'RESTARTED' },
      restart,
      segments,
    };
  });
}

function gpsTrailEndpoint(input: {
  completion: { id: string; occurredAt: Date } | null;
  depot: { latitude: number; longitude: number } | null;
  nextStart: { eventId: string | null; startedAt: Date } | null;
  pause: { id: string; occurredAt: Date } | null;
  samples: GpsTrailSampleRow[];
}): {
  endedAt: Date | null;
  reason: DsvV1VehicleGpsTrailSession['endpoint']['reason'];
} {
  if (input.pause !== null) {
    return { endedAt: lastSampleAt(input.samples) ?? input.pause.occurredAt, reason: 'ROUTE_PAUSED' };
  }
  if (input.completion !== null && input.depot !== null) {
    const depotReturn = input.samples.find((sample) =>
      sample.observedAt.getTime() >= input.completion!.occurredAt.getTime()
      && distanceMeters(sample, input.depot!) <= 150
    );
    if (depotReturn !== undefined) return { endedAt: depotReturn.observedAt, reason: 'DEPOT_RETURNED' };
  }
  if (input.nextStart !== null) {
    return { endedAt: lastSampleAt(input.samples), reason: 'RESTARTED' };
  }
  const last = lastSampleAt(input.samples);
  if (last !== null) return { endedAt: last, reason: 'LAST_VALID_SAMPLE' };
  if (input.completion !== null) return { endedAt: input.completion.occurredAt, reason: 'ROUTE_COMPLETED' };
  return { endedAt: null, reason: 'NO_SAMPLES' };
}

function splitGpsTrailSegments(samples: GpsTrailSampleRow[]): GpsTrailSampleRow[][] {
  const segments: GpsTrailSampleRow[][] = [];
  for (const sample of samples) {
    const current = segments[segments.length - 1] ?? null;
    const previous = current?.[current.length - 1] ?? null;
    if (current === null || previous === null || previous.staleAfter.getTime() < sample.observedAt.getTime()) {
      segments.push([sample]);
    } else {
      current.push(sample);
    }
  }
  return segments;
}

function toGpsTrailSample(sample: GpsTrailSampleRow): DsvV1VehicleGpsTrailSample {
  return {
    distanceTodayKm: decimalToNumber(sample.distanceTodayKm),
    ignitionOn: sample.ignitionOn,
    latitude: sample.latitude,
    longitude: sample.longitude,
    observedAt: sample.observedAt.toISOString(),
    speedKph: decimalToNumber(sample.speedKph),
  };
}

function plannedRouteStart(
  routePlan: GpsTrailRoutePlanRow,
  serviceDate: string,
  timezone: string,
  plannedDepartureTime: string,
): Date {
  const scheduledStartAt = readScheduledStartAt(routePlan.constraints);
  if (scheduledStartAt !== null) return scheduledStartAt;
  const departureTime = readDepartureTime(routePlan.constraints) ?? plannedDepartureTime;
  return localDateTimeInTimeZoneToUtc(serviceDate, departureTime, timezone);
}

function readDepartureTime(value: unknown): string | null {
  const departureTime = jsonString(objectOrNull(value)?.departureTime);
  return departureTime !== null && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(departureTime) ? departureTime : null;
}

function readScheduledStartAt(value: unknown): Date | null {
  const scheduledStartAt = jsonString(objectOrNull(value)?.scheduledStartAt);
  if (scheduledStartAt === null || !scheduledStartAt.includes('T')) return null;
  const instant = new Date(scheduledStartAt);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function jsonString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function depotCoordinate(routePlan: GpsTrailRoutePlanRow): { latitude: number; longitude: number } | null {
  const latitude = decimalToNumber(routePlan.depotLatitude);
  const longitude = decimalToNumber(routePlan.depotLongitude);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function lastSampleAt(samples: GpsTrailSampleRow[]): Date | null {
  return samples[samples.length - 1]?.observedAt ?? null;
}

function distanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const earthRadiusMeters = 6_371_000;
  const leftLat = degreesToRadians(left.latitude);
  const rightLat = degreesToRadians(right.latitude);
  const deltaLat = degreesToRadians(right.latitude - left.latitude);
  const deltaLng = degreesToRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
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

function parsePageNumber(raw: number | string | null | undefined): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'page must be a positive integer.', { page: raw });
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
    && (candidate.destinationName === undefined || typeof candidate.destinationName === 'string')
    && (candidate.orderNumber === undefined || typeof candidate.orderNumber === 'string')
    && (candidate.serviceDate === undefined || typeof candidate.serviceDate === 'string');
}

function normalizeSearchText(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized === '') return undefined;
  if (normalized.length > 120) {
    throw new DsvV1ReadQueryError('BAD_REQUEST', 'search text exceeds the maximum length.', {
      maxLength: 120,
    });
  }
  return normalized;
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

function deliveryStopAddressLabel(value: {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
}): string | null {
  const parts = [value.address1, value.address2, value.city, value.province]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .filter((part, index, all) => all.findIndex((candidate) => candidate === part) === index);
  return parts.length === 0 ? null : parts.join(', ');
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    const record = value as { toNumber?: unknown; toString?: unknown };
    if (typeof record.toNumber === 'function') {
      const parsed = (record.toNumber as () => unknown)();
      return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof record.toString === 'function' && record.toString !== Object.prototype.toString) {
      const parsed = Number((record.toString as () => string)());
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function stoppedFlag(ignitionOn: boolean | null, speedKph: number | null): boolean | null {
  if (ignitionOn === true || (speedKph !== null && speedKph > 1)) return false;
  if (ignitionOn === false && speedKph !== null && speedKph <= 1) return true;
  return null;
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
  const { cursorStopId, cursorUpdatedAt, ...record } = row;
  void cursorStopId;
  void cursorUpdatedAt;
  return record;
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

function serviceDateWindowUtc(serviceDate: string, timezone: string): { end: Date; start: Date } {
  assertIsoDate(serviceDate);
  return {
    end: localDateTimeInTimeZoneToUtc(addCalendarDays(serviceDate, 1), '00:00', timezone),
    start: localDateTimeInTimeZoneToUtc(serviceDate, '00:00', timezone),
  };
}

function localDateTimeInTimeZoneToUtc(isoDate: string, timeOfDay: string, timezone: string): Date {
  assertIsoDate(isoDate);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
    throw new DsvV1ReadQueryError('DEPENDENCY_UNAVAILABLE', 'Planned departure time is invalid.', { timeOfDay });
  }
  const [year, month, day] = isoDate.split('-').map(Number);
  const [hour, minute] = timeOfDay.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0));
  const offset = timeZoneOffsetMs(utcGuess, timezone);
  const first = new Date(utcGuess.getTime() - offset);
  const correctedOffset = timeZoneOffsetMs(first, timezone);
  return new Date(utcGuess.getTime() - correctedOffset);
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? '0');
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - date.getTime();
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

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
