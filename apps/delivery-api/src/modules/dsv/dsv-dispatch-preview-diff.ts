import { createHash } from 'node:crypto';

import type { DsvAddressResolutionStatus } from './dsv-address-canonicalization.js';

export const dsvDispatchImportSourceKind = 'DSV_DISPATCH_IMPORT';

export const dsvDispatchDiffKinds = ['NEW', 'NO_OP', 'UPDATE_CANDIDATE', 'CONFLICT', 'ERROR'] as const;
export type DsvDispatchDiffKind = typeof dsvDispatchDiffKinds[number];

export type DsvDispatchSourceRow = {
  address: string;
  addressResolutionStatus?: DsvAddressResolutionStatus;
  conditionCode: string;
  customerCode: string;
  detailAddress?: string | null;
  destinationName: string;
  driverName: string;
  jibunAddress?: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  postalCode?: string | null;
  rawAddress?: string;
  rowNumber: number;
  sellerOrderKey: string;
  shippedBoxes: number;
  vehiclePlate: string;
};

export type DsvDispatchIssueSeverity = 'error' | 'review';

export type DsvDispatchPreviewIssue = {
  code: string;
  field: keyof DsvDispatchSourceRow | 'row';
  message: string;
  severity: DsvDispatchIssueSeverity;
};

export type DsvDispatchDriverSnapshot = {
  displayName: string;
  id: string;
  status: string;
  vehicleId?: string | null;
};

export type DsvDispatchVehicleSnapshot = {
  id: string;
  licensePlate: string | null;
  status: string;
};

export type DsvDispatchConditionSnapshot = {
  code: string;
  comparisonKey?: string | null;
  id: string;
  rawValue?: string | null;
  status: string | null;
};

export type DsvDispatchCustomerSnapshot = {
  externalCustomerCode: string;
  id: string;
  status: string;
};

export type DsvDispatchDestinationSnapshot = {
  address: string;
  customerCode?: string | null;
  id: string;
  name: string;
  status?: string | null;
};

export type DsvDispatchCanonicalOrderSnapshot = {
  activeDeliveryOwnershipCount?: number;
  cancelledAt?: string | null;
  customerId: string | null;
  deliveryStatus?: string | null;
  deliveryStop: DsvDispatchCanonicalStopSnapshot | null;
  destinationId: string | null;
  id: string;
  sellerOrderKey: string;
  serviceDate?: string | null;
  sourceKind: string;
};

export type DsvDispatchCanonicalStopSnapshot = {
  address: string | null;
  conditionComparisonKey?: string | null;
  deliveryDate: string | null;
  destinationName?: string | null;
  id: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  shippedBoxes?: number | null;
  status?: string | null;
};

export type DsvDispatchPriorImportRowSnapshot = {
  canonicalLink?: {
    customerId: string | null;
    deliveryStopId: string | null;
    destinationId: string | null;
    sellerOrderId: string | null;
  } | null;
  normalized: DsvDispatchNormalizedRow;
  sellerOrderKey: string;
  sourceKind: string;
};

export type DsvDispatchPreviewSnapshots = {
  canonicalOrders: DsvDispatchCanonicalOrderSnapshot[];
  conditions: DsvDispatchConditionSnapshot[];
  customers: DsvDispatchCustomerSnapshot[];
  destinations: DsvDispatchDestinationSnapshot[];
  drivers: DsvDispatchDriverSnapshot[];
  priorImportRows?: DsvDispatchPriorImportRowSnapshot[];
  vehicles: DsvDispatchVehicleSnapshot[];
};

export type DsvDispatchPreviewInput = {
  fileName: string;
  planDate: string;
  rows: DsvDispatchSourceRow[];
  shopId: string;
  snapshots: DsvDispatchPreviewSnapshots;
  sourceKind?: string;
};

export type DsvDispatchNormalizedRow = {
  address: string;
  addressResolutionStatus?: DsvAddressResolutionStatus;
  conditionComparisonKey: string;
  customerCode: string;
  detailAddress?: string | null;
  destinationName: string;
  driverName: string;
  jibunAddress?: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  planDate: string;
  postalCode?: string | null;
  rawAddress?: string;
  sellerOrderKey: string;
  shippedBoxes: number;
  sourceKind: string;
  vehiclePlate: string;
};

export type DsvDispatchCandidateDiff = {
  field: string;
  existing: unknown;
  incoming: unknown;
};

export type DsvDispatchPreviewRow = {
  canonicalIdentity: {
    sellerOrderKey: string;
    shopId: string;
    sourceKind: string;
  };
  candidateDiff: DsvDispatchCandidateDiff[];
  conditionId: string | null;
  customerId: string | null;
  deliveryStopId: string | null;
  destinationId: string | null;
  diffKind: DsvDispatchDiffKind;
  driverId: string | null;
  issues: DsvDispatchPreviewIssue[];
  normalized: DsvDispatchNormalizedRow;
  rowNumber: number;
  sellerOrderId: string | null;
  sellerOrderKey: string;
  vehicleId: string | null;
};

export type DsvDispatchPreviewDiff = {
  canApply: boolean;
  conditionCandidates: Array<{
    comparisonKey: string;
    rawValue: string;
    rowNumbers: number[];
  }>;
  fileName: string;
  planDate: string;
  previewHash: string;
  rows: DsvDispatchPreviewRow[];
  sourceHash: string;
  summary: {
    conflictRows: number;
    errorRows: number;
    newRows: number;
    noOpRows: number;
    readyRows: number;
    reviewRows: number;
    totalRows: number;
    updateCandidateRows: number;
  };
};

const diffOrder = new Map<DsvDispatchDiffKind, number>(dsvDispatchDiffKinds.map((kind, index) => [kind, index]));
const lockedDeliveryStatuses = new Set(['CANCELLED', 'COMPLETED', 'DELIVERED', 'FAILED', 'OUT_FOR_DELIVERY']);

export function buildDsvDispatchPreviewDiff(input: DsvDispatchPreviewInput): DsvDispatchPreviewDiff {
  const sourceKind = input.sourceKind ?? dsvDispatchImportSourceKind;
  const orderedSourceRows = sortSourceRows(input.rows);
  const sourceRows = orderedSourceRows.map(canonicalSourceRow);
  const sourceHash = sha256CanonicalJson({
    fileName: input.fileName,
    planDate: input.planDate,
    rows: sourceRows,
    sourceKind,
  });
  const duplicateKeys = duplicateValues(input.rows.map((row) => normalizeText(row.sellerOrderKey)));
  const conditionCandidates = new Map<string, { rawValue: string; rowNumbers: number[] }>();
  const rows = orderedSourceRows.map((source): DsvDispatchPreviewRow => {
    const normalized = normalizeRow(source, input.planDate, sourceKind);
    const issues = validateSourceRow(source);
    const hasDriverName = normalized.driverName !== '';
    const driverMatches = !hasDriverName
      ? []
      : input.snapshots.drivers.filter(
        (driver) => driver.status === 'ACTIVE' && normalizeText(driver.displayName) === normalized.driverName,
      );
    const vehicleMatches = !hasDriverName || normalized.vehiclePlate === ''
      ? []
      : input.snapshots.vehicles.filter(
        (vehicle) => vehicle.status === 'ACTIVE' && normalizeNullableText(vehicle.licensePlate) === normalized.vehiclePlate,
      );
    const vehicleId = normalized.vehiclePlate === ''
      ? driverMatches.length === 1 ? driverMatches[0]?.vehicleId ?? null : null
      : vehicleMatches.length === 1 ? vehicleMatches[0]?.id ?? null : null;
    const conditionMatches = input.snapshots.conditions.filter(
      (condition) => conditionKey(condition) === normalized.conditionComparisonKey,
    );
    const exactCustomerMatches = input.snapshots.customers.filter(
      (customer) => customer.externalCustomerCode === normalized.customerCode,
    );
    const customerMatches = exactCustomerMatches.filter((customer) => customer.status === 'ACTIVE');
    const destinationMatches = input.snapshots.destinations.filter(
      (destination) =>
        destination.status !== 'INACTIVE'
        && normalizeText(destination.name) === normalized.destinationName
        && normalizeText(destination.address) === normalized.address,
    );

    if (hasDriverName) {
      addCardinalityIssues(issues, 'DRIVER', 'driverName', driverMatches.length);
    }
    if (hasDriverName && normalized.vehiclePlate !== '') {
      addCardinalityIssues(issues, 'VEHICLE', 'vehiclePlate', vehicleMatches.length);
    }
    const customerIssue = resolveCustomerIssue(exactCustomerMatches, customerMatches);
    if (customerIssue !== null) issues.push(customerIssue);
    addAmbiguityIssue(issues, 'DESTINATION', 'destinationName', destinationMatches.length);

    if (duplicateKeys.has(normalized.sellerOrderKey)) {
      issues.push(issue('SELLER_ORDER_DUPLICATED', 'sellerOrderKey', '파일 안에서 SellerOrderKey가 중복됩니다.'));
    }

    const conditionIssue = resolveConditionIssue(conditionMatches);
    if (conditionIssue !== null) {
      issues.push(conditionIssue);
      if (conditionIssue.code === 'CONDITION_CANDIDATE') {
        recordConditionCandidate(conditionCandidates, normalized.conditionComparisonKey, source);
      }
    }

    const canonicalOrder = findCanonicalOrder(input.snapshots.canonicalOrders, {
      planDate: normalized.planDate,
      sellerOrderKey: normalized.sellerOrderKey,
      sourceKind,
    });
    const resolvedDestinationId = resolveDestinationIdForDiff(canonicalOrder, normalized, destinationMatches);
    const candidateDiff = canonicalOrder === null
      ? []
      : diffCanonicalOrder(canonicalOrder, normalized, {
        conditionId: conditionMatches[0]?.id ?? null,
        customerId: customerMatches[0]?.id ?? null,
        destinationId: resolvedDestinationId,
      });

    const conflictIssue = canonicalOrder === null ? null : resolveCanonicalConflict(canonicalOrder, candidateDiff);
    if (conflictIssue !== null) issues.push(conflictIssue);

    const diffKind = classifyDiff({
      canonicalOrder,
      candidateDiff,
      hasErrors: issues.some((item) => item.severity === 'error'),
    });

    return {
      canonicalIdentity: {
        sellerOrderKey: normalized.sellerOrderKey,
        shopId: input.shopId,
        sourceKind,
      },
      candidateDiff: sortCandidateDiff(candidateDiff),
      conditionId: conditionMatches.length === 1 && conditionMatches[0]?.status === 'ACTIVE' ? conditionMatches[0].id : null,
      customerId: customerMatches.length === 1 ? customerMatches[0]?.id ?? null : null,
      deliveryStopId: canonicalOrder?.deliveryStop?.id ?? null,
      destinationId: destinationMatches.length === 1 ? destinationMatches[0]?.id ?? null : resolvedDestinationId,
      diffKind,
      driverId: driverMatches.length === 1 ? driverMatches[0]?.id ?? null : null,
      issues: sortIssues(issues),
      normalized,
      rowNumber: source.rowNumber,
      sellerOrderId: canonicalOrder?.id ?? null,
      sellerOrderKey: normalized.sellerOrderKey,
      vehicleId,
    };
  }).sort(comparePreviewRows);

  const previewHash = sha256CanonicalJson({
    canonicalDiffRows: rows.map((row) => ({
      candidateDiff: row.candidateDiff,
      canonicalIdentity: row.canonicalIdentity,
      conditionId: row.conditionId,
      customerId: row.customerId,
      deliveryStopId: row.deliveryStopId,
      destinationId: row.destinationId,
      diffKind: row.diffKind,
      driverId: row.driverId,
      issues: row.issues.map((item) => ({
        code: item.code,
        field: item.field,
        severity: item.severity,
      })),
      normalized: row.normalized,
      rowNumber: row.rowNumber,
      sellerOrderId: row.sellerOrderId,
      sellerOrderKey: row.sellerOrderKey,
      vehicleId: row.vehicleId,
    })),
    conditionCandidates: sortedConditionCandidates(conditionCandidates),
    sourceHash,
  });

  const summary = summarize(rows);
  const blockingReviewRows = rows.filter((row) => row.issues.some((item) => (
    item.severity === 'review' && item.code !== 'SHIPPED_BOXES_ZERO'
  ))).length;
  return {
    canApply: rows.length > 0
      && summary.errorRows === 0
      && blockingReviewRows === 0
      && summary.conflictRows === 0,
    conditionCandidates: sortedConditionCandidates(conditionCandidates),
    fileName: input.fileName,
    planDate: input.planDate,
    previewHash,
    rows,
    sourceHash,
    summary,
  };
}

export function conditionComparisonKey(value: string): string {
  return normalizeText(value).toUpperCase();
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

function normalizeRow(row: DsvDispatchSourceRow, planDate: string, sourceKind: string): DsvDispatchNormalizedRow {
  return {
    address: normalizeText(row.address),
    ...(row.addressResolutionStatus === undefined ? {} : { addressResolutionStatus: row.addressResolutionStatus }),
    conditionComparisonKey: conditionComparisonKey(row.conditionCode),
    customerCode: normalizeText(row.customerCode),
    ...(row.detailAddress === undefined ? {} : { detailAddress: normalizeNullableText(row.detailAddress) }),
    destinationName: normalizeText(row.destinationName),
    driverName: normalizeText(row.driverName),
    ...(row.jibunAddress === undefined ? {} : { jibunAddress: normalizeNullableText(row.jibunAddress) }),
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes === null ? null : normalizeText(row.notes),
    planDate,
    ...(row.postalCode === undefined ? {} : { postalCode: normalizeNullableText(row.postalCode) }),
    ...(row.rawAddress === undefined ? {} : { rawAddress: normalizeText(row.rawAddress) }),
    sellerOrderKey: normalizeText(row.sellerOrderKey),
    shippedBoxes: row.shippedBoxes,
    sourceKind,
    vehiclePlate: normalizeText(row.vehiclePlate),
  };
}

function canonicalSourceRow(row: DsvDispatchSourceRow): DsvDispatchSourceRow {
  return {
    address: row.address,
    ...(row.addressResolutionStatus === undefined ? {} : { addressResolutionStatus: row.addressResolutionStatus }),
    conditionCode: row.conditionCode,
    customerCode: row.customerCode,
    ...(row.detailAddress === undefined ? {} : { detailAddress: row.detailAddress }),
    destinationName: row.destinationName,
    driverName: row.driverName,
    ...(row.jibunAddress === undefined ? {} : { jibunAddress: row.jibunAddress }),
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
    ...(row.postalCode === undefined ? {} : { postalCode: row.postalCode }),
    ...(row.rawAddress === undefined ? {} : { rawAddress: row.rawAddress }),
    rowNumber: row.rowNumber,
    sellerOrderKey: row.sellerOrderKey,
    shippedBoxes: row.shippedBoxes,
    vehiclePlate: row.vehiclePlate,
  };
}

function validateSourceRow(row: DsvDispatchSourceRow): DsvDispatchPreviewIssue[] {
  const issues: DsvDispatchPreviewIssue[] = [];
  for (const [field, maxLength] of [
    ['destinationName', 160],
    ['conditionCode', 80],
    ['address', 500],
    ['customerCode', 160],
    ['sellerOrderKey', 160],
  ] as const) {
    const value = normalizeText(row[field]);
    if (value === '') issues.push(issue('REQUIRED', field, '필수 값입니다.'));
    else if (value.length > maxLength) issues.push(issue('TOO_LONG', field, `${maxLength}자 이하여야 합니다.`));
  }
  for (const [field, maxLength] of [
    ['driverName', 80],
    ['vehiclePlate', 40],
  ] as const) {
    const value = normalizeText(row[field]);
    if (value !== '' && value.length > maxLength) issues.push(issue('TOO_LONG', field, `${maxLength}자 이하여야 합니다.`));
  }
  if (!Number.isInteger(row.rowNumber) || row.rowNumber < 2) issues.push(issue('ROW_NUMBER_INVALID', 'rowNumber', '행 번호가 올바르지 않습니다.'));
  if (!Number.isInteger(row.shippedBoxes) || row.shippedBoxes < 0) {
    issues.push(issue('SHIPPED_BOXES_INVALID', 'shippedBoxes', '박스 수량은 0 이상의 정수여야 합니다.'));
  } else if (row.shippedBoxes === 0) {
    issues.push(issue(
      'SHIPPED_BOXES_ZERO',
      'shippedBoxes',
      '같은 배송지의 다른 주문에 박스를 합산한 경우인지 확인하세요. 0박스로 업로드할 수 있습니다.',
      'review',
    ));
  }
  if (row.notes !== null && row.notes.length > 1_000) issues.push(issue('TOO_LONG', 'notes', '특이사항은 1,000자 이하여야 합니다.'));
  if ((row.latitude === null) !== (row.longitude === null)) issues.push(issue('LOCATION_INCOMPLETE', 'row', '위도와 경도는 함께 입력해야 합니다.'));
  if (row.latitude !== null && (row.latitude < -90 || row.latitude > 90)) issues.push(issue('LATITUDE_INVALID', 'latitude', '위도 범위가 올바르지 않습니다.'));
  if (row.longitude !== null && (row.longitude < -180 || row.longitude > 180)) issues.push(issue('LONGITUDE_INVALID', 'longitude', '경도 범위가 올바르지 않습니다.'));
  const addressIssue = addressResolutionIssue(row.addressResolutionStatus);
  if (addressIssue !== null) issues.push(addressIssue);
  return issues;
}

function addressResolutionIssue(
  status: DsvAddressResolutionStatus | undefined,
): DsvDispatchPreviewIssue | null {
  if (status === undefined || status === 'RESOLVED') return null;
  if (status === 'ADDRESS_ONLY') {
    return issue('ADDRESS_COORDINATES_NOT_RESOLVED', 'address', '주소와 우편번호는 확인했지만 지도 좌표를 확정하지 못했습니다.', 'review');
  }
  if (status === 'AMBIGUOUS') {
    return issue('ADDRESS_AMBIGUOUS', 'address', '동일 후보가 여러 개라 주소 정본을 확정하지 못했습니다.', 'review');
  }
  if (status === 'NOT_FOUND') {
    return issue('ADDRESS_NOT_FOUND', 'address', '도로명주소와 우편번호를 확인하지 못했습니다.', 'review');
  }
  return issue('ADDRESS_SERVICE_UNAVAILABLE', 'address', '주소 정본화 서비스를 사용할 수 없습니다.', 'review');
}

function addCardinalityIssues(
  issues: DsvDispatchPreviewIssue[],
  resource: 'DRIVER' | 'VEHICLE' | 'CUSTOMER' | 'DESTINATION',
  field: DsvDispatchPreviewIssue['field'],
  matchCount: number,
): void {
  if (matchCount === 0) issues.push(issue(`${resource}_MISSING`, field, '대상을 찾을 수 없습니다.'));
  if (matchCount > 1) issues.push(issue(`${resource}_AMBIGUOUS`, field, '대상이 둘 이상입니다.'));
}

function addAmbiguityIssue(
  issues: DsvDispatchPreviewIssue[],
  resource: 'CUSTOMER' | 'DESTINATION',
  field: DsvDispatchPreviewIssue['field'],
  matchCount: number,
): void {
  if (matchCount > 1) issues.push(issue(`${resource}_AMBIGUOUS`, field, '대상이 둘 이상입니다.'));
}

function resolveConditionIssue(matches: DsvDispatchConditionSnapshot[]): DsvDispatchPreviewIssue | null {
  if (matches.length === 0) return issue('CONDITION_CANDIDATE', 'conditionCode', '운송조건 후보를 먼저 활성화해야 합니다.');
  if (matches.length > 1) return issue('CONDITION_AMBIGUOUS', 'conditionCode', '운송조건이 둘 이상입니다.');
  const [match] = matches;
  if (match?.status === 'ACTIVE') return null;
  if (match?.status === 'INACTIVE') return issue('CONDITION_INACTIVE', 'conditionCode', '비활성 운송조건입니다.');
  return issue('CONDITION_CANDIDATE', 'conditionCode', '운송조건 후보를 먼저 활성화해야 합니다.');
}

function resolveCustomerIssue(
  exactMatches: DsvDispatchCustomerSnapshot[],
  activeMatches: DsvDispatchCustomerSnapshot[],
): DsvDispatchPreviewIssue | null {
  if (activeMatches.length > 1) return issue('CUSTOMER_AMBIGUOUS', 'customerCode', '대상이 둘 이상입니다.');
  if (activeMatches.length === 1) return null;
  if (exactMatches.some((customer) => customer.status === 'INACTIVE')) {
    return issue('CUSTOMER_INACTIVE', 'customerCode', '비활성 고객사입니다.');
  }
  return null;
}

function resolveCanonicalConflict(
  order: DsvDispatchCanonicalOrderSnapshot,
  candidateDiff: DsvDispatchCandidateDiff[],
): DsvDispatchPreviewIssue | null {
  if ((order.activeDeliveryOwnershipCount ?? 0) > 1) {
    return issue('DUPLICATE_ACTIVE_DELIVERY', 'sellerOrderKey', '중복 활성 배송 상태입니다.');
  }
  if ((order.activeDeliveryOwnershipCount ?? 0) > 0 && candidateDiff.length > 0) {
    return issue('CANONICAL_ORDER_ACTIVE_OWNERSHIP', 'sellerOrderKey', '이미 배차된 주문은 가져오기로 수정할 수 없습니다.');
  }
  if (order.cancelledAt !== null && order.cancelledAt !== undefined) {
    return issue('CANONICAL_ORDER_CANCELLED', 'sellerOrderKey', '취소된 주문입니다.');
  }
  if (order.deliveryStatus !== null && order.deliveryStatus !== undefined && lockedDeliveryStatuses.has(order.deliveryStatus)) {
    return issue('CANONICAL_ORDER_LOCKED', 'sellerOrderKey', '수정할 수 없는 배송 상태입니다.');
  }
  if (
    candidateDiff.length > 0
    && order.deliveryStop?.status !== null
    && order.deliveryStop?.status !== undefined
    && order.deliveryStop.status !== 'PENDING'
  ) {
    return issue('CANONICAL_STOP_NOT_PENDING', 'sellerOrderKey', '대기 상태가 아닌 배송지는 가져오기로 수정할 수 없습니다.');
  }
  if (
    candidateDiff.length > 0
    && order.deliveryStatus !== null
    && order.deliveryStatus !== undefined
    && order.deliveryStatus !== 'PENDING'
  ) {
    return issue('CANONICAL_ORDER_NOT_PENDING', 'sellerOrderKey', '대기 상태가 아닌 주문은 가져오기로 수정할 수 없습니다.');
  }
  return null;
}

function diffCanonicalOrder(
  order: DsvDispatchCanonicalOrderSnapshot,
  normalized: DsvDispatchNormalizedRow,
  resolved: {
    conditionId: string | null;
    customerId: string | null;
    destinationId: string | null;
  },
): DsvDispatchCandidateDiff[] {
  const stop = order.deliveryStop;
  const diffs: DsvDispatchCandidateDiff[] = [];
  compareField(diffs, 'customerId', order.customerId, resolved.customerId);
  compareField(diffs, 'destinationId', order.destinationId, resolved.destinationId);
  compareField(diffs, 'address', normalizeNullableText(stop?.address ?? null), normalized.address);
  compareField(diffs, 'conditionComparisonKey', conditionComparisonKey(stop?.conditionComparisonKey ?? ''), normalized.conditionComparisonKey);
  compareField(diffs, 'deliveryDate', stop?.deliveryDate ?? null, normalized.planDate);
  compareField(diffs, 'destinationName', normalizeNullableText(stop?.destinationName ?? null), normalized.destinationName);
  compareField(diffs, 'latitude', stop?.latitude ?? null, normalized.latitude);
  compareField(diffs, 'longitude', stop?.longitude ?? null, normalized.longitude);
  compareField(diffs, 'notes', normalizeNullableText(stop?.notes ?? null), normalized.notes);
  compareField(diffs, 'shippedBoxes', stop?.shippedBoxes ?? null, normalized.shippedBoxes);
  return diffs;
}

function compareField(diffs: DsvDispatchCandidateDiff[], field: string, existing: unknown, incoming: unknown): void {
  if (existing !== incoming) diffs.push({ existing, field, incoming });
}

function classifyDiff(input: {
  canonicalOrder: DsvDispatchCanonicalOrderSnapshot | null;
  candidateDiff: DsvDispatchCandidateDiff[];
  hasErrors: boolean;
}): DsvDispatchDiffKind {
  if (input.canonicalOrder !== null) {
    if ((input.canonicalOrder.activeDeliveryOwnershipCount ?? 0) > 1) return 'CONFLICT';
    if (input.canonicalOrder.cancelledAt !== null && input.canonicalOrder.cancelledAt !== undefined) return 'CONFLICT';
    if (input.canonicalOrder.deliveryStatus !== null
      && input.canonicalOrder.deliveryStatus !== undefined
      && lockedDeliveryStatuses.has(input.canonicalOrder.deliveryStatus)) return 'CONFLICT';
    if (input.candidateDiff.length > 0
      && input.canonicalOrder.deliveryStop?.status !== null
      && input.canonicalOrder.deliveryStop?.status !== undefined
      && input.canonicalOrder.deliveryStop.status !== 'PENDING') return 'CONFLICT';
    if (input.candidateDiff.length > 0
      && input.canonicalOrder.deliveryStatus !== null
      && input.canonicalOrder.deliveryStatus !== undefined
      && input.canonicalOrder.deliveryStatus !== 'PENDING') return 'CONFLICT';
    if ((input.canonicalOrder.activeDeliveryOwnershipCount ?? 0) > 0 && input.candidateDiff.length > 0) return 'CONFLICT';
  }
  if (input.hasErrors) return 'ERROR';
  if (input.canonicalOrder === null) return 'NEW';
  return input.candidateDiff.length === 0 ? 'NO_OP' : 'UPDATE_CANDIDATE';
}

function summarize(rows: DsvDispatchPreviewRow[]): DsvDispatchPreviewDiff['summary'] {
  const count = (kind: DsvDispatchDiffKind): number => rows.filter((row) => row.diffKind === kind).length;
  const errorRows = count('ERROR');
  const conflictRows = count('CONFLICT');
  const updateCandidateRows = count('UPDATE_CANDIDATE');
  return {
    conflictRows,
    errorRows,
    newRows: count('NEW'),
    noOpRows: count('NO_OP'),
    readyRows: rows.length - errorRows - conflictRows,
    reviewRows: rows.filter((row) => row.issues.some((item) => item.severity === 'review')).length,
    totalRows: rows.length,
    updateCandidateRows,
  };
}

function resolveDestinationIdForDiff(
  canonicalOrder: DsvDispatchCanonicalOrderSnapshot | null,
  normalized: DsvDispatchNormalizedRow,
  destinationMatches: DsvDispatchDestinationSnapshot[],
): string | null {
  if (destinationMatches.length === 1) return destinationMatches[0]?.id ?? null;
  if (destinationMatches.length > 1 || canonicalOrder === null) return null;
  const stop = canonicalOrder.deliveryStop;
  const existingName = normalizeNullableText(stop?.destinationName ?? null);
  const existingAddress = normalizeNullableText(stop?.address ?? null);
  if (existingName === normalized.destinationName && existingAddress === normalized.address) {
    return canonicalOrder.destinationId;
  }
  return null;
}

function sortedConditionCandidates(
  candidates: Map<string, { rawValue: string; rowNumbers: number[] }>,
): DsvDispatchPreviewDiff['conditionCandidates'] {
  return [...candidates]
    .map(([comparisonKey, candidate]) => ({
      comparisonKey,
      rawValue: candidate.rawValue,
      rowNumbers: [...candidate.rowNumbers].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.comparisonKey.localeCompare(right.comparisonKey));
}

function recordConditionCandidate(
  candidates: Map<string, { rawValue: string; rowNumbers: number[] }>,
  comparisonKey: string,
  source: DsvDispatchSourceRow,
): void {
  const candidate = candidates.get(comparisonKey);
  if (candidate !== undefined) {
    candidate.rowNumbers.push(source.rowNumber);
    return;
  }

  // Canonical source order makes the earliest row's exact text the stable preserved raw value.
  candidates.set(comparisonKey, {
    rawValue: source.conditionCode,
    rowNumbers: [source.rowNumber],
  });
}

function findCanonicalOrder(
  orders: DsvDispatchCanonicalOrderSnapshot[],
  identity: { planDate: string; sellerOrderKey: string; sourceKind: string },
): DsvDispatchCanonicalOrderSnapshot | null {
  const matches = orders.filter(
    (order) =>
      order.sourceKind === identity.sourceKind
      && order.sellerOrderKey === identity.sellerOrderKey
      && (order.serviceDate ?? order.deliveryStop?.deliveryDate ?? null) === identity.planDate,
  );
  return matches[0] ?? null;
}

function conditionKey(condition: DsvDispatchConditionSnapshot): string {
  return condition.comparisonKey === null || condition.comparisonKey === undefined
    ? conditionComparisonKey(condition.code)
    : conditionComparisonKey(condition.comparisonKey);
}

function sortSourceRows(rows: DsvDispatchSourceRow[]): DsvDispatchSourceRow[] {
  return [...rows].sort((left, right) =>
    left.rowNumber - right.rowNumber
    || left.sellerOrderKey.localeCompare(right.sellerOrderKey)
    || compareText(canonicalJson(canonicalSourceRow(left)), canonicalJson(canonicalSourceRow(right))));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePreviewRows(left: DsvDispatchPreviewRow, right: DsvDispatchPreviewRow): number {
  return left.rowNumber - right.rowNumber
    || left.sellerOrderKey.localeCompare(right.sellerOrderKey)
    || (diffOrder.get(left.diffKind) ?? 99) - (diffOrder.get(right.diffKind) ?? 99)
    || (left.issues[0]?.code ?? '').localeCompare(right.issues[0]?.code ?? '');
}

function sortIssues(issues: DsvDispatchPreviewIssue[]): DsvDispatchPreviewIssue[] {
  return [...issues].sort((left, right) => left.code.localeCompare(right.code));
}

function sortCandidateDiff(diffs: DsvDispatchCandidateDiff[]): DsvDispatchCandidateDiff[] {
  return [...diffs].sort((left, right) => left.field.localeCompare(right.field));
}

function issue(
  code: string,
  field: DsvDispatchPreviewIssue['field'],
  message: string,
  severity: DsvDispatchIssueSeverity = 'error',
): DsvDispatchPreviewIssue {
  return { code, field, message, severity };
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeNullableText(value: string | null): string | null {
  return value === null ? null : normalizeText(value);
}
