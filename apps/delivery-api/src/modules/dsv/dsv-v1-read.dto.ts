export const dsvV1ApiVersion = 'dsv.v1' as const;

export const dsvV1EtaStatuses = ['NOT_REQUIRED', 'PENDING', 'READY', 'FAILED', 'STALE'] as const;
export type DsvV1EtaStatus = typeof dsvV1EtaStatuses[number];

export const dsvV1ProofStatuses = ['NONE', 'AVAILABLE', 'REDACTED', 'EXPIRED'] as const;
export type DsvV1ProofStatus = typeof dsvV1ProofStatuses[number];

export const dsvV1EmittedProofStatuses = ['NONE', 'AVAILABLE', 'EXPIRED'] as const;
export type DsvV1EmittedProofStatus = typeof dsvV1EmittedProofStatuses[number];

export const dsvV1ErrorCodes = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'SELLER_ORDER_ALREADY_ACQUIRED',
  'COMMAND_IN_PROGRESS',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'VALIDATION_FAILED',
  'DEPENDENCY_UNAVAILABLE',
] as const;
export type DsvV1ErrorCode = typeof dsvV1ErrorCodes[number];

export const dsvV1CustomerDeliveryRequiredFields = [
  'sellerOrderKey',
  'destinationDisplayName',
  'deliveryStatus',
  'etaStatus',
  'eventSummary',
  'proofStatus',
] as const;

export const dsvV1SellerOrderSummaryRequiredFields = [
  'sellerOrderId',
  'sellerOrderKey',
  'customerId',
  'destinationId',
  'assignmentStatus',
  'etaStatus',
] as const;

export const dsvV1SessionRequiredFields = ['principalType', 'shopId', 'scopes'] as const;

export type DsvV1PrincipalType = 'DSV_ADMIN' | 'CUSTOMER_USER' | 'DRIVER' | 'IMPORT_WORKER' | 'DEVICE';

export type DsvV1SuccessEnvelope<TData> = {
  data: TData;
  meta: {
    apiVersion: typeof dsvV1ApiVersion;
  };
  requestId: string;
};

export type DsvV1ErrorEnvelope = {
  error: {
    code: DsvV1ErrorCode;
    details?: Record<string, unknown>;
    message: string;
    requestId: string;
  };
};

export type DsvV1PageInfo = {
  hasMore?: boolean;
  nextCursor?: string;
};

export type DsvV1SessionPrincipalInput = {
  customerId?: string | null;
  driverId?: string | null;
  principalType: DsvV1PrincipalType;
  scopes: readonly string[];
  shopId: string;
};

export type DsvV1SessionDto = {
  customerId?: string;
  driverId?: string;
  principalType: DsvV1PrincipalType;
  scopes: string[];
  shopId: string;
};

export type DsvV1RoutePlanStopEtaInput = {
  estimatedArrivalAt?: Date | string | null;
  etaInputRouteVersionId?: string | null;
  etaSource?: string | null;
  etaStatus: DsvV1EtaStatus;
};

export type DsvV1SellerOrderSummaryRow = DsvV1RoutePlanStopEtaInput & {
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED';
  customerId: string;
  destinationId: string;
  routePlanId?: string | null;
  routeVersionId?: string | null;
  sellerOrderId: string;
  sellerOrderKey: string;
};

export type DsvV1SellerOrderSummaryDto = {
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED';
  customerId: string;
  destinationId: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  routePlanId?: string;
  routeVersionId?: string;
  sellerOrderId: string;
  sellerOrderKey: string;
};

export type DsvV1SellerOrderSummaryPageDto = {
  items: DsvV1SellerOrderSummaryDto[];
  page?: DsvV1PageInfo;
};

export type DsvV1ControlSummaryInput = {
  assignedCount: number;
  failedEtaCount: number;
  pendingEtaCount: number;
  readyEtaCount: number;
  serviceDate: string;
  totalDispatchCount: number;
  unassignedCount: number;
};

export type DsvV1ControlSummaryDto = DsvV1ControlSummaryInput;

export type DsvV1ProofRowInput = {
  deletedAt?: Date | string | null;
};

export type DsvV1EventRowInput = {
  eventType: string;
  occurredAt: Date | string;
};

export type DsvV1EventSummaryDto = {
  occurredAt: string;
  type: string;
};

export type DsvV1RecordRow = DsvV1RoutePlanStopEtaInput & {
  deliveryStatus: string;
  destinationDisplayName: string;
  eventRows?: readonly DsvV1EventRowInput[];
  proofRows?: readonly DsvV1ProofRowInput[];
  sellerOrderKey: string;
};

export type DsvV1RecordDto = {
  deliveryStatus: string;
  destinationDisplayName: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  eventSummary: DsvV1EventSummaryDto[];
  proofStatus: DsvV1EmittedProofStatus;
  sellerOrderKey: string;
};

export type DsvV1RecordPageDto = {
  items: DsvV1RecordDto[];
  page?: DsvV1PageInfo;
};

export type DsvV1DriverListItemRow = {
  displayName: string;
  driverId: string;
  phone?: string | null;
  status?: string | null;
};

export type DsvV1DriverListItemDto = {
  displayName: string;
  driverId: string;
  phone?: string;
  status?: string;
};

export type DsvV1VehicleListItemRow = {
  displayName: string;
  driverAssignments: DsvV1VehicleDriverAssignmentRow[];
  status?: string | null;
  vehicleId: string;
  vehiclePlate?: string | null;
};

export type DsvV1VehicleDriverAssignmentRow = {
  assignmentId: string;
  driverId: string;
};

export type DsvV1VehicleListItemDto = {
  displayName: string;
  driverAssignments: DsvV1VehicleDriverAssignmentDto[];
  status?: string;
  vehicleId: string;
  vehiclePlate?: string;
};

export type DsvV1VehicleDriverAssignmentDto = {
  assignmentId: string;
  driverId: string;
};

export type DsvV1CustomerListItemRow = {
  customerId: string;
  displayName: string;
  externalCustomerCode?: string | null;
  status?: string | null;
};

export type DsvV1CustomerListItemDto = {
  customerId: string;
  displayName: string;
  externalCustomerCode?: string;
  status?: string;
};

export type DsvV1DestinationListItemRow = {
  address?: string | null;
  destinationId: string;
  displayName: string;
};

export type DsvV1DestinationListItemDto = {
  address?: string;
  destinationId: string;
  displayName: string;
};

export type DsvV1ConditionListItemRow = {
  conditionId: string;
  name: string;
  status?: string | null;
};

export type DsvV1ConditionListItemDto = {
  conditionId: string;
  name: string;
  status?: string;
};

export type DsvV1ManagementListPageDto<TItem> = {
  items: TItem[];
  page: DsvV1PageInfo;
};

export type DsvV1CustomerDeliveryInquiryRow = DsvV1RoutePlanStopEtaInput & {
  deliveryStatus: string;
  destinationDisplayName: string;
  eventRows?: readonly DsvV1EventRowInput[];
  proofRows?: readonly DsvV1ProofRowInput[];
  sellerOrderKey: string;
};

export type DsvV1CustomerDeliveryInquiryItemDto = {
  deliveryStatus: string;
  destinationDisplayName: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  eventSummary: DsvV1EventSummaryDto[];
  proofStatus: DsvV1EmittedProofStatus;
  sellerOrderKey: string;
};

export type DsvV1CustomerDeliveryInquiryPageDto = {
  emptyReason?: string;
  items: DsvV1CustomerDeliveryInquiryItemDto[];
  page?: DsvV1PageInfo;
};

const allowedPublicEventTypes = new Set([
  'ROUTE_STARTED',
  'ROUTE_PAUSED',
  'ROUTE_COMPLETED',
  'STOP_ARRIVED',
  'STOP_DELIVERED',
  'STOP_FAILED',
]);

export function toDsvV1SuccessEnvelope<TData>(data: TData, requestId: string): DsvV1SuccessEnvelope<TData> {
  return {
    data,
    meta: { apiVersion: dsvV1ApiVersion },
    requestId,
  };
}

export function toDsvV1ErrorEnvelope(input: {
  code: DsvV1ErrorCode;
  details?: Record<string, unknown>;
  message: string;
  requestId: string;
}): DsvV1ErrorEnvelope {
  return {
    error: {
      code: input.code,
      ...(input.details === undefined ? {} : { details: input.details }),
      message: input.message,
      requestId: input.requestId,
    },
  };
}

export function mapDsvV1PageInfo(input?: DsvV1PageInfo): DsvV1PageInfo | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.hasMore === undefined ? {} : { hasMore: input.hasMore }),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}

export function mapDsvV1SessionPrincipal(input: DsvV1SessionPrincipalInput): DsvV1SessionDto {
  return {
    ...(input.customerId === undefined || input.customerId === null ? {} : { customerId: input.customerId }),
    ...(input.driverId === undefined || input.driverId === null ? {} : { driverId: input.driverId }),
    principalType: input.principalType,
    scopes: [...input.scopes],
    shopId: input.shopId,
  };
}

export function mapDsvV1SellerOrderSummary(row: DsvV1SellerOrderSummaryRow): DsvV1SellerOrderSummaryDto {
  return {
    assignmentStatus: row.assignmentStatus,
    customerId: row.customerId,
    destinationId: row.destinationId,
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    ...(row.routePlanId === undefined || row.routePlanId === null ? {} : { routePlanId: row.routePlanId }),
    ...(row.routeVersionId === undefined || row.routeVersionId === null ? {} : { routeVersionId: row.routeVersionId }),
    sellerOrderId: row.sellerOrderId,
    sellerOrderKey: row.sellerOrderKey,
  };
}

export function mapDsvV1SellerOrderSummaryPage(input: {
  items: readonly DsvV1SellerOrderSummaryRow[];
  page?: DsvV1PageInfo;
}): DsvV1SellerOrderSummaryPageDto {
  return {
    items: input.items.map(mapDsvV1SellerOrderSummary),
    ...optionalPage(input.page),
  };
}

export function mapDsvV1ControlSummary(input: DsvV1ControlSummaryInput): DsvV1ControlSummaryDto {
  return {
    assignedCount: input.assignedCount,
    failedEtaCount: input.failedEtaCount,
    pendingEtaCount: input.pendingEtaCount,
    readyEtaCount: input.readyEtaCount,
    serviceDate: input.serviceDate,
    totalDispatchCount: input.totalDispatchCount,
    unassignedCount: input.unassignedCount,
  };
}

export function mapDsvV1Record(row: DsvV1RecordRow): DsvV1RecordDto {
  return {
    deliveryStatus: row.deliveryStatus,
    destinationDisplayName: row.destinationDisplayName,
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    eventSummary: mapDsvV1EventSummary(row.eventRows ?? []),
    proofStatus: deriveDsvV1ProofStatus(row.proofRows ?? []),
    sellerOrderKey: row.sellerOrderKey,
  };
}

export function mapDsvV1RecordPage(input: {
  items: readonly DsvV1RecordRow[];
  page?: DsvV1PageInfo;
}): DsvV1RecordPageDto {
  return {
    items: input.items.map(mapDsvV1Record),
    ...optionalPage(input.page),
  };
}

export function mapDsvV1DriverListItem(row: DsvV1DriverListItemRow): DsvV1DriverListItemDto {
  return {
    displayName: row.displayName,
    driverId: row.driverId,
    ...(row.phone === undefined || row.phone === null ? {} : { phone: row.phone }),
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
  };
}

export function mapDsvV1VehicleListItem(row: DsvV1VehicleListItemRow): DsvV1VehicleListItemDto {
  return {
    displayName: row.displayName,
    driverAssignments: row.driverAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      driverId: assignment.driverId,
    })),
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
    vehicleId: row.vehicleId,
    ...(row.vehiclePlate === undefined || row.vehiclePlate === null ? {} : { vehiclePlate: row.vehiclePlate }),
  };
}

export function mapDsvV1CustomerListItem(row: DsvV1CustomerListItemRow): DsvV1CustomerListItemDto {
  return {
    customerId: row.customerId,
    displayName: row.displayName,
    ...(row.externalCustomerCode === undefined || row.externalCustomerCode === null
      ? {}
      : { externalCustomerCode: row.externalCustomerCode }),
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
  };
}

export function mapDsvV1DestinationListItem(row: DsvV1DestinationListItemRow): DsvV1DestinationListItemDto {
  return {
    ...(row.address === undefined || row.address === null ? {} : { address: row.address }),
    destinationId: row.destinationId,
    displayName: row.displayName,
  };
}

export function mapDsvV1ConditionListItem(row: DsvV1ConditionListItemRow): DsvV1ConditionListItemDto {
  return {
    conditionId: row.conditionId,
    name: row.name,
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
  };
}

export function mapDsvV1ManagementListPage<TItem>(input: {
  items: readonly TItem[];
  page: DsvV1PageInfo;
}): DsvV1ManagementListPageDto<TItem> {
  return {
    items: [...input.items],
    page: mapDsvV1PageInfo(input.page) ?? {},
  };
}

export function mapDsvV1CustomerDeliveryInquiryItem(
  row: DsvV1CustomerDeliveryInquiryRow
): DsvV1CustomerDeliveryInquiryItemDto {
  return {
    deliveryStatus: row.deliveryStatus,
    destinationDisplayName: row.destinationDisplayName,
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    eventSummary: mapDsvV1EventSummary(row.eventRows ?? []),
    proofStatus: deriveDsvV1ProofStatus(row.proofRows ?? []),
    sellerOrderKey: row.sellerOrderKey,
  };
}

export function mapDsvV1CustomerDeliveryInquiryPage(input: {
  emptyReason?: string;
  items: readonly DsvV1CustomerDeliveryInquiryRow[];
  page?: DsvV1PageInfo;
}): DsvV1CustomerDeliveryInquiryPageDto {
  return {
    ...(input.emptyReason === undefined ? {} : { emptyReason: input.emptyReason }),
    items: input.items.map(mapDsvV1CustomerDeliveryInquiryItem),
    ...optionalPage(input.page),
  };
}

export function deriveDsvV1ProofStatus(rows: readonly DsvV1ProofRowInput[]): DsvV1EmittedProofStatus {
  if (rows.length === 0) return 'NONE';
  if (rows.some((row) => row.deletedAt === null || row.deletedAt === undefined)) return 'AVAILABLE';
  return 'EXPIRED';
}

export function mapDsvV1EventSummary(rows: readonly DsvV1EventRowInput[]): DsvV1EventSummaryDto[] {
  return rows.flatMap((row) => {
    if (!allowedPublicEventTypes.has(row.eventType)) return [];
    return [{
      occurredAt: toIsoDateTime(row.occurredAt),
      type: row.eventType,
    }];
  });
}

function optionalPage(page?: DsvV1PageInfo): { page?: DsvV1PageInfo } {
  const mapped = mapDsvV1PageInfo(page);
  return mapped === undefined ? {} : { page: mapped };
}

function optionalIso<Key extends string>(key: Key, value?: Date | string | null): Record<Key, string> | object {
  if (value === undefined || value === null) return {};
  return { [key]: toIsoDateTime(value) };
}

function toIsoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
