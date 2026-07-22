import { Prisma, type PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export type DsvDispatchImportSourceRow = {
  address: string;
  conditionCode: string;
  customerCode: string;
  destinationName: string;
  driverName: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  rowNumber: number;
  sellerOrderKey: string;
  shippedBoxes: number;
  vehiclePlate: string;
};

export type DsvDispatchImportInput = {
  fileName: string;
  planDate: string;
  rows: DsvDispatchImportSourceRow[];
};

export type DsvDispatchIssue = {
  code: string;
  field: keyof DsvDispatchImportSourceRow | 'row';
  message: string;
  severity: 'error' | 'review';
};

export type DsvDispatchPreviewRow = DsvDispatchImportSourceRow & {
  driverId: string | null;
  issues: DsvDispatchIssue[];
  status: 'READY' | 'NEEDS_REVIEW';
  vehicleId: string | null;
};

export type DsvDispatchImportPreview = {
  canCommit: boolean;
  conditionCandidates: string[];
  fileName: string;
  planDate: string;
  rows: DsvDispatchPreviewRow[];
  summary: {
    errorRows: number;
    readyRows: number;
    reviewRows: number;
    totalRows: number;
  };
};

export type DsvTransportConditionView = {
  code: string;
  createdAt: string;
  description: string;
  id: string;
  name: string;
  updatedAt: string;
};

export type DsvDispatchImportView = {
  createdAt: string;
  fileName: string;
  id: string;
  planDate: string;
  rowCount: number;
  rows: DsvDispatchPreviewRow[];
  status: 'READY' | 'NEEDS_REVIEW';
};

export type DsvDispatchImportService = {
  commit(input: DsvDispatchImportInput & { actor: string; shopDomain: string }): Promise<DsvDispatchImportView>;
  createCondition(input: {
    actor: string;
    code: string;
    description: string;
    name: string;
    shopDomain: string;
  }): Promise<DsvTransportConditionView>;
  getImport(input: { importId: string; shopDomain: string }): Promise<DsvDispatchImportView | null>;
  listConditions(input: { shopDomain: string }): Promise<DsvTransportConditionView[] | null>;
  preview(input: DsvDispatchImportInput & { shopDomain: string }): Promise<DsvDispatchImportPreview>;
};

export class DsvDispatchImportValidationError extends Error {
  constructor(readonly preview: DsvDispatchImportPreview) {
    super('배차 파일에 수정이 필요한 행이 있습니다.');
    this.name = 'DsvDispatchImportValidationError';
  }
}

export class DsvDispatchImportConflictError extends Error {
  constructor(readonly code: 'CONDITION_EXISTS' | 'SELLER_ORDER_ALREADY_IMPORTED') {
    super(code === 'CONDITION_EXISTS' ? '이미 등록된 운송조건입니다.' : '이미 업로드된 SellerOrderKey가 있습니다.');
    this.name = 'DsvDispatchImportConflictError';
  }
}

export class DsvDispatchImportShopNotFoundError extends Error {
  constructor() {
    super('Customer workspace not found');
    this.name = 'DsvDispatchImportShopNotFoundError';
  }
}

export class PrismaDsvDispatchImportService implements DsvDispatchImportService {
  constructor(private readonly prisma: PrismaClient) {}

  async preview(input: DsvDispatchImportInput & { shopDomain: string }): Promise<DsvDispatchImportPreview> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();

    const driverNames = unique(input.rows.map((row) => row.driverName));
    const vehiclePlates = unique(input.rows.map((row) => row.vehiclePlate));
    const sellerOrderKeys = unique(input.rows.map((row) => row.sellerOrderKey));
    const [drivers, vehicles, conditions, priorRows] = await Promise.all([
      this.prisma.dsvDriverProfile.findMany({
        select: { driver: { select: { id: true, status: true } }, lookupName: true },
        where: { lookupName: { in: driverNames }, shopId: shop.id },
      }),
      this.prisma.vehicle.findMany({
        select: { id: true, licensePlate: true },
        where: { licensePlate: { in: vehiclePlates }, shopId: shop.id, status: 'ACTIVE' },
      }),
      this.prisma.dsvTransportCondition.findMany({ select: { code: true }, where: { shopId: shop.id } }),
      this.prisma.dsvDispatchImportRow.findMany({
        select: { sellerOrderKey: true },
        where: { sellerOrderKey: { in: sellerOrderKeys }, shopId: shop.id },
      }),
    ]);

    return buildDispatchImportPreview({
      conditions: conditions.map((condition) => condition.code),
      drivers: drivers
        .filter((profile) => profile.driver.status === 'ACTIVE')
        .map((profile) => ({ displayName: profile.lookupName, id: profile.driver.id })),
      fileName: input.fileName,
      planDate: input.planDate,
      priorSellerOrderKeys: priorRows.map((row) => row.sellerOrderKey),
      rows: input.rows,
      vehicles,
    });
  }

  async commit(input: DsvDispatchImportInput & { actor: string; shopDomain: string }): Promise<DsvDispatchImportView> {
    const preview = await this.preview(input);
    if (!preview.canCommit) throw new DsvDispatchImportValidationError(preview);
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();

    try {
      const record = await this.prisma.dsvDispatchImport.create({
        data: {
          createdBy: input.actor,
          fileName: preview.fileName,
          planDate: new Date(`${preview.planDate}T00:00:00.000Z`),
          rowCount: preview.rows.length,
          shopId: shop.id,
          status: preview.rows.some((row) => row.status === 'NEEDS_REVIEW') ? 'NEEDS_REVIEW' : 'READY',
          rows: {
            create: preview.rows.map((row) => ({
              address: row.address,
              conditionCode: row.conditionCode,
              customerCode: row.customerCode,
              destinationName: row.destinationName,
              driverId: row.driverId,
              driverName: row.driverName,
              issues: toJson(row.issues),
              latitude: row.latitude,
              longitude: row.longitude,
              notes: row.notes,
              rowNumber: row.rowNumber,
              sellerOrderKey: row.sellerOrderKey,
              shippedBoxes: row.shippedBoxes,
              shopId: shop.id,
              status: row.status,
              vehicleId: row.vehicleId,
              vehiclePlate: row.vehiclePlate,
            })),
          },
        },
        include: { rows: { orderBy: { rowNumber: 'asc' } } },
      });
      return importView(record);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvDispatchImportConflictError('SELLER_ORDER_ALREADY_IMPORTED');
      throw error;
    }
  }

  async getImport(input: { importId: string; shopDomain: string }): Promise<DsvDispatchImportView | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const record = await this.prisma.dsvDispatchImport.findFirst({
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
      where: { id: input.importId, shopId: shop.id },
    });
    return record === null ? null : importView(record);
  }

  async listConditions(input: { shopDomain: string }): Promise<DsvTransportConditionView[] | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const conditions = await this.prisma.dsvTransportCondition.findMany({
      orderBy: [{ code: 'asc' }],
      where: { shopId: shop.id },
    });
    return conditions.map(conditionView);
  }

  async createCondition(input: {
    actor: string;
    code: string;
    description: string;
    name: string;
    shopDomain: string;
  }): Promise<DsvTransportConditionView> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    try {
      const condition = await this.prisma.dsvTransportCondition.create({
        data: {
          code: input.code,
          createdBy: input.actor,
          description: input.description,
          name: input.name,
          shopId: shop.id,
        },
      });
      return conditionView(condition);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvDispatchImportConflictError('CONDITION_EXISTS');
      throw error;
    }
  }

  private findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain }),
    });
  }
}

export function buildDispatchImportPreview(input: {
  conditions: string[];
  drivers: Array<{ displayName: string; id: string }>;
  fileName: string;
  planDate: string;
  priorSellerOrderKeys: string[];
  rows: DsvDispatchImportSourceRow[];
  vehicles: Array<{ id: string; licensePlate: string | null }>;
}): DsvDispatchImportPreview {
  const duplicateKeys = duplicateValues(input.rows.map((row) => row.sellerOrderKey));
  const conflictingDrivers = conflictingMappings(input.rows, (row) => row.driverName, (row) => row.vehiclePlate);
  const conflictingVehicles = conflictingMappings(input.rows, (row) => row.vehiclePlate, (row) => row.driverName);
  const knownConditions = new Set(input.conditions);
  const priorKeys = new Set(input.priorSellerOrderKeys);
  const conditionCandidates = unique(input.rows.map((row) => row.conditionCode)).filter((code) => !knownConditions.has(code));
  const rows = input.rows.map((source): DsvDispatchPreviewRow => {
    const issues = validateSourceRow(source);
    const matchingDrivers = input.drivers.filter((driver) => driver.displayName === source.driverName);
    const matchingVehicles = input.vehicles.filter((vehicle) => vehicle.licensePlate === source.vehiclePlate);
    if (matchingDrivers.length === 0) issues.push(issue('DRIVER_NOT_FOUND', 'driverName', '등록된 배송원을 찾을 수 없습니다.'));
    if (matchingDrivers.length > 1) issues.push(issue('DRIVER_AMBIGUOUS', 'driverName', '같은 이름의 배송원이 둘 이상입니다. 고유 식별자가 필요합니다.'));
    if (matchingVehicles.length === 0) issues.push(issue('VEHICLE_NOT_FOUND', 'vehiclePlate', '등록된 차량 번호를 찾을 수 없습니다.'));
    if (duplicateKeys.has(source.sellerOrderKey)) issues.push(issue('SELLER_ORDER_DUPLICATED', 'sellerOrderKey', '파일 안에서 SellerOrderKey가 중복됩니다.'));
    if (priorKeys.has(source.sellerOrderKey)) issues.push(issue('SELLER_ORDER_ALREADY_IMPORTED', 'sellerOrderKey', '이미 업로드된 SellerOrderKey입니다.'));
    if (conflictingDrivers.has(source.driverName)) issues.push(issue('DRIVER_VEHICLE_CONFLICT', 'vehiclePlate', '한 배송원에게 파일 내 여러 차량이 지정되었습니다.'));
    if (conflictingVehicles.has(source.vehiclePlate)) issues.push(issue('VEHICLE_DRIVER_CONFLICT', 'driverName', '한 차량에 파일 내 여러 배송원이 지정되었습니다.'));
    if (!knownConditions.has(source.conditionCode)) issues.push(issue('CONDITION_UNREGISTERED', 'conditionCode', '운송조건을 먼저 등록해야 합니다.'));
    if (source.latitude === null && source.longitude === null) {
      issues.push(issue('LOCATION_NOT_RESOLVED', 'row', '좌표가 없어 주문 생성 전 주소 확인 또는 지오코딩이 필요합니다.', 'review'));
    }
    return {
      ...source,
      driverId: matchingDrivers.length === 1 ? matchingDrivers[0]?.id ?? null : null,
      issues,
      status: issues.length === 0 ? 'READY' : 'NEEDS_REVIEW',
      vehicleId: matchingVehicles.length === 1 ? matchingVehicles[0]?.id ?? null : null,
    };
  });
  const errorRows = rows.filter((row) => row.issues.some((item) => item.severity === 'error')).length;
  const reviewRows = rows.filter((row) => row.status === 'NEEDS_REVIEW' && !row.issues.some((item) => item.severity === 'error')).length;
  return {
    canCommit: rows.length > 0 && errorRows === 0,
    conditionCandidates,
    fileName: input.fileName,
    planDate: input.planDate,
    rows,
    summary: {
      errorRows,
      readyRows: rows.length - errorRows - reviewRows,
      reviewRows,
      totalRows: rows.length,
    },
  };
}

function validateSourceRow(row: DsvDispatchImportSourceRow): DsvDispatchIssue[] {
  const issues: DsvDispatchIssue[] = [];
  for (const [field, maxLength] of [
    ['driverName', 80],
    ['vehiclePlate', 40],
    ['destinationName', 160],
    ['conditionCode', 80],
    ['address', 500],
    ['customerCode', 160],
    ['sellerOrderKey', 160],
  ] as const) {
    const value = row[field];
    if (value === '') issues.push(issue('REQUIRED', field, '필수 값입니다.'));
    else if (value.length > maxLength) issues.push(issue('TOO_LONG', field, `${maxLength}자 이하여야 합니다.`));
  }
  if (!Number.isInteger(row.rowNumber) || row.rowNumber < 2) issues.push(issue('ROW_NUMBER_INVALID', 'rowNumber', '행 번호가 올바르지 않습니다.'));
  if (!Number.isInteger(row.shippedBoxes) || row.shippedBoxes <= 0) issues.push(issue('SHIPPED_BOXES_INVALID', 'shippedBoxes', '박스 수량은 1 이상의 정수여야 합니다.'));
  if (row.notes !== null && row.notes.length > 1_000) issues.push(issue('TOO_LONG', 'notes', '특이사항은 1,000자 이하여야 합니다.'));
  if ((row.latitude === null) !== (row.longitude === null)) issues.push(issue('LOCATION_INCOMPLETE', 'row', '위도와 경도는 함께 입력해야 합니다.'));
  if (row.latitude !== null && (row.latitude < -90 || row.latitude > 90)) issues.push(issue('LATITUDE_INVALID', 'latitude', '위도 범위가 올바르지 않습니다.'));
  if (row.longitude !== null && (row.longitude < -180 || row.longitude > 180)) issues.push(issue('LONGITUDE_INVALID', 'longitude', '경도 범위가 올바르지 않습니다.'));
  return issues;
}

function issue(
  code: string,
  field: DsvDispatchIssue['field'],
  message: string,
  severity: DsvDispatchIssue['severity'] = 'error',
): DsvDispatchIssue {
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

function conflictingMappings<T>(rows: T[], key: (row: T) => string, value: (row: T) => string): Set<string> {
  const mappings = new Map<string, Set<string>>();
  for (const row of rows) {
    const current = mappings.get(key(row)) ?? new Set<string>();
    current.add(value(row));
    mappings.set(key(row), current);
  }
  return new Set([...mappings].filter(([, values]) => values.size > 1).map(([entry]) => entry));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function conditionView(condition: {
  code: string;
  createdAt: Date;
  description: string;
  id: string;
  name: string;
  updatedAt: Date;
}): DsvTransportConditionView {
  return {
    code: condition.code,
    createdAt: condition.createdAt.toISOString(),
    description: condition.description,
    id: condition.id,
    name: condition.name,
    updatedAt: condition.updatedAt.toISOString(),
  };
}

function importView(record: {
  createdAt: Date;
  fileName: string;
  id: string;
  planDate: Date;
  rowCount: number;
  rows: Array<{
    address: string;
    conditionCode: string;
    customerCode: string;
    destinationName: string;
    driverId: string | null;
    driverName: string;
    issues: Prisma.JsonValue;
    latitude: Prisma.Decimal | null;
    longitude: Prisma.Decimal | null;
    notes: string | null;
    rowNumber: number;
    sellerOrderKey: string;
    shippedBoxes: number;
    status: 'READY' | 'NEEDS_REVIEW';
    vehicleId: string | null;
    vehiclePlate: string;
  }>;
  status: 'READY' | 'NEEDS_REVIEW';
}): DsvDispatchImportView {
  return {
    createdAt: record.createdAt.toISOString(),
    fileName: record.fileName,
    id: record.id,
    planDate: record.planDate.toISOString().slice(0, 10),
    rowCount: record.rowCount,
    rows: record.rows.map((row) => ({
      address: row.address,
      conditionCode: row.conditionCode,
      customerCode: row.customerCode,
      destinationName: row.destinationName,
      driverId: row.driverId,
      driverName: row.driverName,
      issues: Array.isArray(row.issues) ? row.issues as DsvDispatchIssue[] : [],
      latitude: row.latitude?.toNumber() ?? null,
      longitude: row.longitude?.toNumber() ?? null,
      notes: row.notes,
      rowNumber: row.rowNumber,
      sellerOrderKey: row.sellerOrderKey,
      shippedBoxes: row.shippedBoxes,
      status: row.status,
      vehicleId: row.vehicleId,
      vehiclePlate: row.vehiclePlate,
    })),
    status: record.status,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
