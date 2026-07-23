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
  'sellerOrderId',
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

export const dsvV1SessionRequiredFields = ['csrfToken', 'principalType', 'shopId', 'scopes'] as const;

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
  actorId?: string | null;
  customerId?: string | null;
  displayName?: string | null;
  driverId?: string | null;
  principalType: DsvV1PrincipalType;
  scopes: readonly string[];
  shopId: string;
};

export type DsvV1SessionDto = {
  actorId?: string;
  csrfToken: string;
  customerId?: string;
  displayName?: string;
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
  actualCompletedAt?: Date | string | null;
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED';
  customerId: string;
  destinationAddress?: string | null;
  destinationDisplayName?: string | null;
  destinationId: string;
  driverId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  routePlanId?: string | null;
  routeStopSequence?: number | null;
  routeVersionId?: string | null;
  sellerOrderId: string;
  sellerOrderKey: string;
  vehicleId?: string | null;
};

export type DsvV1SellerOrderSummaryDto = {
  actualCompletedAt?: string;
  assignmentStatus: 'UNASSIGNED' | 'ASSIGNED';
  customerId: string;
  destinationAddress?: string;
  destinationDisplayName?: string;
  destinationId: string;
  driverId?: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  latitude?: number;
  longitude?: number;
  routePlanId?: string;
  routeStopSequence?: number;
  routeVersionId?: string;
  sellerOrderId: string;
  sellerOrderKey: string;
  vehicleId?: string;
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
  contentType?: string;
  deletedAt?: Date | string | null;
  driverDisplayName?: string | null;
  kind?: string;
  originalFilename?: string | null;
  proofId?: string;
  sizeBytes?: number;
  source?: string;
  uploadedAt?: Date | string;
};

export type DsvV1EventRowInput = {
  driverDisplayName?: string | null;
  eventId?: string;
  eventType: string;
  latitude?: number | null;
  longitude?: number | null;
  occurredAt: Date | string;
};

export type DsvV1EventSummaryDto = {
  occurredAt: string;
  type: string;
};

export type DsvV1RecordEventDto = DsvV1EventSummaryDto & {
  driverDisplayName?: string;
  eventId: string;
  latitude?: number;
  longitude?: number;
};

export type DsvV1RecordProofDto = {
  contentType: string;
  driverDisplayName?: string;
  kind: string;
  originalFilename?: string;
  proofId: string;
  sizeBytes: number;
  source: string;
  status: 'AVAILABLE' | 'EXPIRED';
  uploadedAt: string;
};

export type DsvV1RecordRow = DsvV1RoutePlanStopEtaInput & {
  deliveryStatus: string;
  destinationAddress?: string | null;
  destinationDisplayName: string;
  eventRows?: readonly DsvV1EventRowInput[];
  proofRows?: readonly DsvV1ProofRowInput[];
  sellerOrderId: string;
  sellerOrderKey: string;
};

export type DsvV1RecordDto = {
  deliveryStatus: string;
  destinationAddress?: string;
  destinationDisplayName: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  eventSummary: DsvV1RecordEventDto[];
  proofs: DsvV1RecordProofDto[];
  proofStatus: DsvV1EmittedProofStatus;
  sellerOrderId: string;
  sellerOrderKey: string;
};

export type DsvV1RecordPageDto = {
  items: DsvV1RecordDto[];
  page?: DsvV1PageInfo;
};

export type DsvV1DriverListItemRow = {
  age?: number | null;
  career?: string | null;
  displayName: string;
  driverId: string;
  gender?: string | null;
  phone?: string | null;
  score?: string | null;
  status?: string | null;
  traits?: string[] | null;
  zone?: string | null;
};

export type DsvV1DriverListItemDto = {
  age?: number;
  career?: string;
  displayName: string;
  driverId: string;
  gender?: string;
  phone?: string;
  score?: string;
  status?: string;
  traits?: string[];
  zone?: string;
};

export type DsvV1VehicleListItemRow = {
  displayName: string;
  driverAssignments: DsvV1VehicleDriverAssignmentRow[];
  note?: string | null;
  status?: string | null;
  telematicsCapabilities?: string[] | null;
  telematicsSerialNumber?: string | null;
  type?: string | null;
  vehicleId: string;
  vehiclePlate?: string | null;
  vehicleType?: string | null;
};

export type DsvV1VehicleDriverAssignmentRow = {
  assignmentId: string;
  driverId: string;
};

export type DsvV1VehicleListItemDto = {
  displayName: string;
  driverAssignments: DsvV1VehicleDriverAssignmentDto[];
  note?: string;
  status?: string;
  telematicsCapabilities?: string[];
  telematicsSerialNumber?: string;
  type?: string;
  vehicleId: string;
  vehiclePlate?: string;
  vehicleType?: string;
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
  code: string;
  conditionId: string;
  description: string;
  name: string;
  status?: string | null;
};

export type DsvV1ConditionListItemDto = {
  code: string;
  conditionId: string;
  description: string;
  name: string;
  status?: string;
};

export type DsvV1ManagementListPageDto<TItem> = {
  items: TItem[];
  page: DsvV1PageInfo;
};

export type DsvV1CustomerDeliveryInquiryRow = DsvV1RoutePlanStopEtaInput & {
  deliveryStatus: string;
  destinationAddress?: string | null;
  destinationDisplayName: string;
  eventRows?: readonly DsvV1EventRowInput[];
  latitude?: number | null;
  longitude?: number | null;
  proofRows?: readonly DsvV1ProofRowInput[];
  sellerOrderId: string;
  sellerOrderKey: string;
  vehicleDisplayName?: string | null;
  vehicleId?: string | null;
  vehicleLatitude?: number | null;
  vehicleLongitude?: number | null;
};

export type DsvV1CustomerDeliveryInquiryItemDto = {
  deliveryStatus: string;
  destinationAddress?: string;
  destinationDisplayName: string;
  estimatedArrivalAt?: string;
  etaStatus: DsvV1EtaStatus;
  eventSummary: DsvV1EventSummaryDto[];
  latitude?: number;
  longitude?: number;
  proofStatus: DsvV1EmittedProofStatus;
  sellerOrderId: string;
  sellerOrderKey: string;
  vehicleDisplayName?: string;
  vehicleId?: string;
  vehicleLatitude?: number;
  vehicleLongitude?: number;
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
const allowedRecordEventTypes = new Set([
  ...allowedPublicEventTypes,
  'NOTE_ADDED',
  'PICKUP_COMPLETED',
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

export function mapDsvV1SessionPrincipal(
  input: DsvV1SessionPrincipalInput,
  csrfToken: string,
): DsvV1SessionDto {
  return {
    ...(input.actorId === undefined || input.actorId === null ? {} : { actorId: input.actorId }),
    csrfToken,
    ...(input.customerId === undefined || input.customerId === null ? {} : { customerId: input.customerId }),
    ...(input.displayName === undefined || input.displayName === null ? {} : { displayName: input.displayName }),
    ...(input.driverId === undefined || input.driverId === null ? {} : { driverId: input.driverId }),
    principalType: input.principalType,
    scopes: [...input.scopes],
    shopId: input.shopId,
  };
}

export function mapDsvV1SellerOrderSummary(row: DsvV1SellerOrderSummaryRow): DsvV1SellerOrderSummaryDto {
  return {
    ...optionalIso('actualCompletedAt', row.actualCompletedAt),
    assignmentStatus: row.assignmentStatus,
    customerId: row.customerId,
    ...(row.destinationAddress === undefined || row.destinationAddress === null ? {} : { destinationAddress: row.destinationAddress }),
    ...(row.destinationDisplayName === undefined || row.destinationDisplayName === null ? {} : { destinationDisplayName: row.destinationDisplayName }),
    destinationId: row.destinationId,
    ...(row.driverId === undefined || row.driverId === null ? {} : { driverId: row.driverId }),
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    ...(row.latitude === undefined || row.latitude === null ? {} : { latitude: row.latitude }),
    ...(row.longitude === undefined || row.longitude === null ? {} : { longitude: row.longitude }),
    ...(row.routePlanId === undefined || row.routePlanId === null ? {} : { routePlanId: row.routePlanId }),
    ...(row.routeStopSequence === undefined || row.routeStopSequence === null ? {} : { routeStopSequence: row.routeStopSequence }),
    ...(row.routeVersionId === undefined || row.routeVersionId === null ? {} : { routeVersionId: row.routeVersionId }),
    sellerOrderId: row.sellerOrderId,
    sellerOrderKey: row.sellerOrderKey,
    ...(row.vehicleId === undefined || row.vehicleId === null ? {} : { vehicleId: row.vehicleId }),
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
    ...(row.destinationAddress === undefined || row.destinationAddress === null
      ? {}
      : { destinationAddress: row.destinationAddress }),
    destinationDisplayName: row.destinationDisplayName,
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    eventSummary: mapDsvV1RecordEvents(row.eventRows ?? []),
    proofs: mapDsvV1RecordProofs(row.proofRows ?? []),
    proofStatus: deriveDsvV1ProofStatus(row.proofRows ?? []),
    sellerOrderId: row.sellerOrderId,
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
    ...(row.age === undefined || row.age === null ? {} : { age: row.age }),
    ...(row.career === undefined || row.career === null ? {} : { career: row.career }),
    displayName: row.displayName,
    driverId: row.driverId,
    ...(row.gender === undefined || row.gender === null ? {} : { gender: row.gender }),
    ...(row.phone === undefined || row.phone === null ? {} : { phone: row.phone }),
    ...(row.score === undefined || row.score === null ? {} : { score: row.score }),
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
    ...(row.traits === undefined || row.traits === null ? {} : { traits: row.traits }),
    ...(row.zone === undefined || row.zone === null ? {} : { zone: row.zone }),
  };
}

export function mapDsvV1VehicleListItem(row: DsvV1VehicleListItemRow): DsvV1VehicleListItemDto {
  return {
    displayName: row.displayName,
    driverAssignments: row.driverAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      driverId: assignment.driverId,
    })),
    ...(row.note === undefined || row.note === null ? {} : { note: row.note }),
    ...(row.status === undefined || row.status === null ? {} : { status: row.status }),
    ...(row.telematicsCapabilities === undefined || row.telematicsCapabilities === null
      ? {}
      : { telematicsCapabilities: row.telematicsCapabilities }),
    ...(row.telematicsSerialNumber === undefined || row.telematicsSerialNumber === null
      ? {}
      : { telematicsSerialNumber: row.telematicsSerialNumber }),
    ...(row.type === undefined || row.type === null ? {} : { type: row.type }),
    vehicleId: row.vehicleId,
    ...(row.vehiclePlate === undefined || row.vehiclePlate === null ? {} : { vehiclePlate: row.vehiclePlate }),
    ...(row.vehicleType === undefined || row.vehicleType === null ? {} : { vehicleType: row.vehicleType }),
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
    code: row.code,
    conditionId: row.conditionId,
    description: row.description,
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
    ...(row.destinationAddress === undefined || row.destinationAddress === null ? {} : { destinationAddress: row.destinationAddress }),
    destinationDisplayName: row.destinationDisplayName,
    ...optionalIso('estimatedArrivalAt', row.estimatedArrivalAt),
    etaStatus: row.etaStatus,
    eventSummary: mapDsvV1EventSummary(row.eventRows ?? []),
    ...(row.latitude === undefined || row.latitude === null ? {} : { latitude: row.latitude }),
    ...(row.longitude === undefined || row.longitude === null ? {} : { longitude: row.longitude }),
    proofStatus: deriveDsvV1ProofStatus(row.proofRows ?? []),
    sellerOrderId: row.sellerOrderId,
    sellerOrderKey: row.sellerOrderKey,
    ...(row.vehicleDisplayName === undefined || row.vehicleDisplayName === null ? {} : { vehicleDisplayName: row.vehicleDisplayName }),
    ...(row.vehicleId === undefined || row.vehicleId === null ? {} : { vehicleId: row.vehicleId }),
    ...(row.vehicleLatitude === undefined || row.vehicleLatitude === null ? {} : { vehicleLatitude: row.vehicleLatitude }),
    ...(row.vehicleLongitude === undefined || row.vehicleLongitude === null ? {} : { vehicleLongitude: row.vehicleLongitude }),
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

export function mapDsvV1RecordEvents(rows: readonly DsvV1EventRowInput[]): DsvV1RecordEventDto[] {
  return rows.flatMap((row) => {
    if (!allowedRecordEventTypes.has(row.eventType) || row.eventId === undefined) return [];
    return [{
      ...(row.driverDisplayName === undefined || row.driverDisplayName === null ? {} : { driverDisplayName: row.driverDisplayName }),
      eventId: row.eventId,
      ...(row.latitude === undefined || row.latitude === null ? {} : { latitude: row.latitude }),
      ...(row.longitude === undefined || row.longitude === null ? {} : { longitude: row.longitude }),
      occurredAt: toIsoDateTime(row.occurredAt),
      type: row.eventType,
    }];
  });
}

export function mapDsvV1RecordProofs(rows: readonly DsvV1ProofRowInput[]): DsvV1RecordProofDto[] {
  return rows.flatMap((row) => {
    if (
      row.contentType === undefined
      || row.kind === undefined
      || row.proofId === undefined
      || row.sizeBytes === undefined
      || row.source === undefined
      || row.uploadedAt === undefined
    ) return [];
    return [{
      contentType: row.contentType,
      ...(row.driverDisplayName === undefined || row.driverDisplayName === null ? {} : { driverDisplayName: row.driverDisplayName }),
      kind: row.kind,
      ...(row.originalFilename === undefined || row.originalFilename === null ? {} : { originalFilename: row.originalFilename }),
      proofId: row.proofId,
      sizeBytes: row.sizeBytes,
      source: row.source,
      status: row.deletedAt === null || row.deletedAt === undefined ? 'AVAILABLE' : 'EXPIRED',
      uploadedAt: toIsoDateTime(row.uploadedAt),
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
