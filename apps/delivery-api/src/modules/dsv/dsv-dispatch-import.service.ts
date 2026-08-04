import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type {
  DsvAddressSuggestion,
  DsvAddressCanonicalizer,
  DsvAddressResolutionStatus,
} from './dsv-address-canonicalization.js';
import {
  buildDsvDispatchPreviewDiff,
  canonicalJson,
  conditionComparisonKey,
  dsvDispatchImportSourceKind,
  sha256CanonicalJson,
  type DsvDispatchCanonicalOrderSnapshot,
  type DsvDispatchPreviewDiff,
  type DsvDispatchPreviewRow as DsvDispatchDiffRow,
} from './dsv-dispatch-preview-diff.js';

export type DsvDispatchImportSourceRow = {
  address: string;
  addressResolutionStatus?: DsvAddressResolutionStatus;
  addressSuggestions?: DsvAddressSuggestion[];
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

export type DsvDispatchImportInput = {
  fileName: string;
  planDate: string;
  previewHash?: string;
  rows: DsvDispatchImportSourceRow[];
};

export type DsvDispatchIssue = {
  code: string;
  field: keyof DsvDispatchImportSourceRow | 'row';
  message: string;
  severity: 'error' | 'review';
};

export type DsvDispatchPreviewRow = DsvDispatchImportSourceRow & {
  candidateDiff?: DsvDispatchDiffRow['candidateDiff'] | undefined;
  conditionId?: string | null | undefined;
  customerId?: string | null | undefined;
  deliveryStopId?: string | null | undefined;
  destinationId?: string | null | undefined;
  diffKind?: DsvDispatchDiffRow['diffKind'] | undefined;
  driverId: string | null;
  issues: DsvDispatchIssue[];
  normalized?: DsvDispatchDiffRow['normalized'] | null | undefined;
  sellerOrderId?: string | null | undefined;
  status: 'READY' | 'NEEDS_REVIEW' | 'APPLYING' | 'APPLIED' | 'BLOCKED';
  vehicleId: string | null;
};

export type DsvDispatchImportPreview = {
  canApply?: boolean;
  canCommit: boolean;
  conditionCandidates: Array<{ comparisonKey: string; rawValue: string; rowNumbers: number[] }> | string[];
  fileName: string;
  planDate: string;
  previewHash?: string;
  rows: DsvDispatchPreviewRow[];
  sourceHash?: string;
  summary: {
    conflictRows?: number;
    errorRows: number;
    newRows?: number;
    noOpRows?: number;
    readyRows: number;
    reviewRows: number;
    totalRows: number;
    updateCandidateRows?: number;
  };
};

export type DsvTransportConditionView = {
  code: string;
  createdAt: string;
  description: string;
  id: string;
  name: string;
  status?: string | null | undefined;
  updatedAt: string;
};

export type DsvDispatchImportView = {
  createdAt: string;
  fileName: string;
  id: string;
  planDate: string;
  previewHash?: string | undefined;
  rowCount: number;
  rows: DsvDispatchPreviewRow[];
  sourceHash?: string | undefined;
  status: 'STAGED' | 'READY' | 'NEEDS_REVIEW' | 'APPLYING' | 'APPLIED' | 'FAILED';
};

export type DsvDispatchImportApplyInput = {
  actor: string;
  commandId: string;
  expectedSourceHash: string;
  importId: string;
  principal?: {
    actorId?: string | null;
    actorType?: string;
    principalType?: 'DSV_ADMIN' | 'IMPORT_WORKER' | 'SYSTEM_WORKER';
    requestId?: string;
  };
  shopDomain: string;
};

export type DsvDispatchImportApplyResult = {
  commandId: string;
  importId: string;
  previewHash: string;
  receiptId: string;
  rows: Array<{
    customerId: string;
    deliveryStopId: string;
    destinationId: string;
    outcome: 'NEW' | 'NO_OP' | 'UPDATE_CANDIDATE';
    rowId: string;
    rowNumber: number;
    sellerOrderId: string;
    sellerOrderKey: string;
  }>;
  sourceHash: string;
  status: 'APPLIED';
  summary: {
    appliedRows: number;
    newRows: number;
    noOpRows: number;
    updatedRows: number;
  };
};

export type DsvDispatchImportService = {
  commit(input: DsvDispatchImportInput & { actor: string; shopDomain: string }): Promise<DsvDispatchImportView>;
  createCondition(input: {
    actor: string;
    code: string;
    description: string;
    name: string;
    principal?: DsvDispatchImportApplyInput['principal'];
    shopDomain: string;
  }): Promise<DsvTransportConditionView>;
  deleteCondition(input: { conditionId: string; shopDomain: string }): Promise<void>;
  getImport(input: { importId: string; shopDomain: string }): Promise<DsvDispatchImportView | null>;
  listConditions(input: { shopDomain: string }): Promise<DsvTransportConditionView[] | null>;
  preview(input: DsvDispatchImportInput & { shopDomain: string }): Promise<DsvDispatchImportPreview>;
  updateCondition(input: {
    code: string;
    conditionId: string;
    description: string;
    name: string;
    shopDomain: string;
  }): Promise<DsvTransportConditionView>;
};

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

type ApplyFailureCode =
  | 'COMMAND_IN_PROGRESS'
  | 'DISPATCH_IMPORT_ALREADY_APPLIED'
  | 'DISPATCH_IMPORT_CANONICAL_CONFLICT'
  | 'DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES'
  | 'DISPATCH_IMPORT_HAS_REVIEW_ROWS'
  | 'DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES'
  | 'DISPATCH_IMPORT_INACTIVE_CONDITION'
  | 'DISPATCH_IMPORT_NOT_READY'
  | 'DISPATCH_IMPORT_PREVIEW_STALE'
  | 'DISPATCH_IMPORT_RESOURCE_AMBIGUOUS'
  | 'DISPATCH_IMPORT_RESOURCE_MISSING'
  | 'DUPLICATE_ACTIVE_DELIVERY'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH';

type DsvDispatchImportServiceOptions = {
  addressCanonicalizer?: DsvAddressCanonicalizer;
  applyTransactionMaxWaitMs?: number;
  applyTransactionTimeoutMs?: number;
  delayAfterCanonicalRowsMs?: number;
  failAfterCanonicalRows?: number;
};

const defaultApplyTransactionMaxWaitMs = 20_000;
const defaultApplyTransactionTimeoutMs = 120_000;
const failureEvidenceTransactionOptions = { maxWait: 20_000, timeout: 30_000 } as const;

export class DsvDispatchImportValidationError extends Error {
  constructor(readonly preview: DsvDispatchImportPreview) {
    super('배차 파일에 수정이 필요한 행이 있습니다.');
    this.name = 'DsvDispatchImportValidationError';
  }
}

export class DsvDispatchImportConflictError extends Error {
  constructor(readonly code: 'CONDITION_EXISTS' | 'CONDITION_IN_USE' | 'SELLER_ORDER_ALREADY_IMPORTED' | 'DISPATCH_IMPORT_PREVIEW_STALE') {
    super(
      code === 'CONDITION_EXISTS'
        ? '이미 등록된 운송조건입니다.'
        : code === 'CONDITION_IN_USE'
          ? '배차 기록에서 사용 중인 운송조건은 삭제할 수 없습니다.'
        : code === 'DISPATCH_IMPORT_PREVIEW_STALE'
          ? '배차 파일 미리보기 결과가 현재 기준과 다릅니다.'
          : '이미 업로드된 SellerOrderKey가 있습니다.',
    );
    this.name = 'DsvDispatchImportConflictError';
  }
}

export class DsvDispatchImportApplyError extends Error {
  constructor(readonly code: ApplyFailureCode, message: string = code) {
    super(message);
    this.name = 'DsvDispatchImportApplyError';
  }
}

export class DsvDispatchImportShopNotFoundError extends Error {
  constructor() {
    super('Customer workspace not found');
    this.name = 'DsvDispatchImportShopNotFoundError';
  }
}

export class DsvTransportConditionNotFoundError extends Error {
  constructor() {
    super('Transport condition not found');
    this.name = 'DsvTransportConditionNotFoundError';
  }
}

export class PrismaDsvDispatchImportService implements DsvDispatchImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: DsvDispatchImportServiceOptions = {},
  ) {}

  async preview(input: DsvDispatchImportInput & { shopDomain: string }): Promise<DsvDispatchImportPreview> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    const rows = await this.canonicalizeRows(input.rows, input.shopDomain);
    const diff = await this.buildPreviewForRows(this.prisma, shop.id, { ...input, rows });
    return previewView(diff, rows);
  }

  async commit(input: DsvDispatchImportInput & { actor: string; shopDomain: string }): Promise<DsvDispatchImportView> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    const rows = await this.canonicalizeRows(input.rows, input.shopDomain);
    const diff = await this.buildPreviewForRows(this.prisma, shop.id, { ...input, rows });
    const preview = previewView(diff, rows);
    if (input.previewHash !== undefined && input.previewHash !== diff.previewHash) {
      throw new DsvDispatchImportConflictError('DISPATCH_IMPORT_PREVIEW_STALE');
    }
    if (preview.rows.some((row) => row.issues.some((issue) => isAddressResolutionIssue(issue.code)))) {
      throw new DsvDispatchImportValidationError(preview);
    }
    const candidateConditionIds = await this.persistConditionCandidates(shop.id, input.actor, diff);

    const record = await this.prisma.dsvDispatchImport.create({
      data: {
        createdBy: input.actor,
        fileName: diff.fileName,
        planDate: new Date(`${diff.planDate}T00:00:00.000Z`),
        previewHash: diff.previewHash,
        rowCount: diff.rows.length,
        shop: { connect: { id: shop.id } },
        sourceHash: diff.sourceHash,
        sourceKind: dsvDispatchImportSourceKind,
        status: stageStatus(diff),
        rows: {
          create: diff.rows.map((row) => {
            const source = rows.find((item) => item.rowNumber === row.rowNumber && item.sellerOrderKey.trim() === row.sellerOrderKey);
            if (source === undefined) throw new Error(`Missing source row ${row.rowNumber}`);
            return {
              address: source.address,
              candidateDiff: toJson(row.candidateDiff),
              canonicalLink: Prisma.JsonNull,
              conditionCode: source.conditionCode,
              conditionId: row.conditionId ?? candidateConditionIds.get(row.normalized.conditionComparisonKey) ?? null,
              customerCode: source.customerCode,
              customerId: row.customerId,
              deliveryStopId: row.deliveryStopId,
              destinationId: row.destinationId,
              destinationName: source.destinationName,
              diffKind: row.diffKind,
              driverId: row.driverId,
              driverName: source.driverName,
              issues: toJson(row.issues),
              latitude: source.latitude,
              longitude: source.longitude,
              normalized: toJson(row.normalized),
              notes: source.notes,
              previewHash: diff.previewHash,
              rowNumber: row.rowNumber,
              sellerOrderId: row.sellerOrderId,
              sellerOrderKey: row.sellerOrderKey,
              shippedBoxes: source.shippedBoxes,
              sourceHash: diff.sourceHash,
              sourceKind: dsvDispatchImportSourceKind,
              status: rowStatus(row),
              vehicleId: row.vehicleId,
              vehiclePlate: source.vehiclePlate,
            };
          }),
        },
      },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    return importView(record);
  }

  async apply(input: DsvDispatchImportApplyInput): Promise<DsvDispatchImportApplyResult> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    const importRecord = await this.prisma.dsvDispatchImport.findFirst({
      select: { applyResult: true, id: true, previewHash: true, sourceHash: true, status: true },
      where: { id: input.importId, shopId: shop.id },
    });
    if (importRecord === null) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');
    const payloadHash = applyPayloadHash({
      commandId: input.commandId,
      importId: input.importId,
      previewHash: importRecord.previewHash,
      sourceHash: input.expectedSourceHash,
    });
    const claim = await this.claimApplyCommand(shop.id, input, payloadHash);
    if ('result' in claim) return claim.result;

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockApplyImport(tx, shop.id, input.importId);
        const receipt = await tx.dsvCommandReceipt.findFirst({
          where: {
            id: claim.receiptId,
            payloadHash,
            shopId: shop.id,
            status: 'STARTED',
          },
        });
        if (receipt === null) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');

        const lockedImport = await tx.dsvDispatchImport.findFirst({
          include: { rows: { orderBy: [{ rowNumber: 'asc' }, { sellerOrderKey: 'asc' }] } },
          where: { id: input.importId, shopId: shop.id },
        });
        if (lockedImport === null || (lockedImport.status !== 'READY' && lockedImport.status !== 'STAGED')) {
          if (lockedImport?.status === 'FAILED') throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');
          const stagedFailure = lockedImport === null ? null : applyFailureFromPersistedRows(lockedImport.rows);
          if (stagedFailure !== null) throw new DsvDispatchImportApplyError(stagedFailure);
          throw new DsvDispatchImportApplyError(
            lockedImport?.status === 'APPLIED' ? 'DISPATCH_IMPORT_ALREADY_APPLIED' : 'DISPATCH_IMPORT_NOT_READY',
          );
        }
        if (lockedImport.sourceHash !== input.expectedSourceHash) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_PREVIEW_STALE');

        const sourceRows = lockedImport.rows.map(sourceRowFromRecord);
        for (const key of [...new Set(sourceRows.map((row) => row.sellerOrderKey))].sort()) {
          await lockSellerOrder(tx, shop.id, key);
        }
        await lockCanonicalOrderRows(tx, shop.id, sourceRows.map((row) => row.sellerOrderKey));

        const recomputed = await this.buildPreviewForRows(tx, shop.id, {
          fileName: lockedImport.fileName,
          planDate: lockedImport.planDate.toISOString().slice(0, 10),
          rows: sourceRows,
        });
        if (
          recomputed.sourceHash !== lockedImport.sourceHash
          || (recomputed.previewHash !== lockedImport.previewHash
            && !matchesStagedPreviewExceptResolvedDestination(lockedImport.rows, recomputed))
        ) {
          throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_PREVIEW_STALE');
        }
        assertApplicable(recomputed);
        const destinationFingerprints = unique(sourceRows.map((row) => addressFingerprint(row))).sort((left, right) =>
          left.localeCompare(right));
        for (const fingerprint of destinationFingerprints) {
          await lockDestinationFingerprint(tx, shop.id, fingerprint);
        }

        const resultRows: DsvDispatchImportApplyResult['rows'] = [];
        const importRowsByRowNumber = new Map(lockedImport.rows.map((row) => [row.rowNumber, row]));
        const sourceRowsByIdentity = new Map(sourceRows.map((row) => [`${row.rowNumber}:${row.sellerOrderKey}`, row]));
        let canonicalWrites = 0;
        for (const row of recomputed.rows) {
          const source = sourceRowsByIdentity.get(`${row.rowNumber}:${row.sellerOrderKey}`);
          const importRow = importRowsByRowNumber.get(row.rowNumber);
          if (source === undefined || importRow === undefined) throw new Error(`Missing locked row ${row.rowNumber}`);
          const link = row.diffKind === 'NO_OP'
            ? await this.linkNoOpRow(tx, shop.id, row)
            : row.diffKind === 'UPDATE_CANDIDATE'
              ? await this.updateCanonicalRows(tx, shop.id, source, row)
              : await this.createNewCanonicalRows(tx, shop.id, source, row);
          if (row.diffKind === 'NEW') {
            canonicalWrites += 1;
            if (this.options.delayAfterCanonicalRowsMs !== undefined) {
              await delay(this.options.delayAfterCanonicalRowsMs);
            }
            if (this.options.failAfterCanonicalRows !== undefined && canonicalWrites >= this.options.failAfterCanonicalRows) {
              throw new Error('G003 forced mid-transaction failure');
            }
          }
          const outcome = row.diffKind as 'NEW' | 'NO_OP' | 'UPDATE_CANDIDATE';
          await tx.dsvDispatchImportRow.update({
            data: {
              applyReceiptId: receipt.id,
              appliedAt: new Date(),
              canonicalLink: toJson({ ...link, outcome }),
              customerId: link.customerId,
              deliveryStopId: link.deliveryStopId,
              destinationId: link.destinationId,
              sellerOrderId: link.sellerOrderId,
              status: 'APPLIED',
            },
            where: { id: importRow.id },
          });
          resultRows.push({
            ...link,
            outcome,
            rowId: importRow.id,
            rowNumber: row.rowNumber,
            sellerOrderKey: row.sellerOrderKey,
          });
        }
        await invalidateReadyRoutePlansForUpdates(tx, shop.id, resultRows.filter((row) => row.outcome === 'UPDATE_CANDIDATE'));
        await this.ensureDispatchGrouping(
          tx,
          shop.id,
          input.importId,
          lockedImport.fileName,
          lockedImport.planDate,
          input.actor,
          resultRows,
        );

        const result: DsvDispatchImportApplyResult = {
          commandId: input.commandId,
          importId: input.importId,
          previewHash: lockedImport.previewHash,
          receiptId: receipt.id,
          rows: resultRows,
          sourceHash: lockedImport.sourceHash,
          status: 'APPLIED',
          summary: {
            appliedRows: resultRows.length,
            newRows: resultRows.filter((row) => row.outcome === 'NEW').length,
            noOpRows: resultRows.filter((row) => row.outcome === 'NO_OP').length,
            updatedRows: resultRows.filter((row) => row.outcome === 'UPDATE_CANDIDATE').length,
          },
        };

        await tx.dsvAuditEvent.create({
          data: {
            actorId: input.principal?.actorId ?? input.actor,
            actorType: input.principal?.actorType ?? 'DSV_ADMIN',
            commandReceiptId: receipt.id,
            entityId: input.importId,
            entityType: 'DsvDispatchImport',
            eventType: 'applyDispatchImport',
            importId: input.importId,
            principalType: input.principal?.principalType ?? 'DSV_ADMIN',
            reason: 'G003 dispatch import apply',
            redactedDiff: toJson({
              commandId: input.commandId,
              rows: resultRows.map((row) => ({
                deliveryStopId: row.deliveryStopId,
                outcome: row.outcome,
                rowNumber: row.rowNumber,
                sellerOrderId: row.sellerOrderId,
                sellerOrderKey: row.sellerOrderKey,
              })),
            }),
            requestId: input.principal?.requestId ?? input.commandId,
            shopId: shop.id,
          },
        });
        await tx.dsvDispatchImport.update({
          data: {
            appliedAt: new Date(),
            appliedBy: input.actor,
            applyReceiptId: receipt.id,
            applyResult: toJson(result),
            failureCode: null,
            failureMessage: null,
            status: 'APPLIED',
          },
          where: { id: input.importId },
        });
        const completedReceipt = await tx.dsvCommandReceipt.updateMany({
          data: {
            completedAt: new Date(),
            responseBodyRef: canonicalJson(result),
            responseStatus: 200,
            resultEntityId: input.importId,
            resultEntityType: 'DsvDispatchImport',
            status: 'SUCCEEDED',
          },
          where: { id: receipt.id, payloadHash, shopId: shop.id, status: 'STARTED' },
        });
        if (completedReceipt.count !== 1) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');
        return result;
      }, {
        maxWait: this.options.applyTransactionMaxWaitMs ?? defaultApplyTransactionMaxWaitMs,
        timeout: this.options.applyTransactionTimeoutMs ?? defaultApplyTransactionTimeoutMs,
      });
    } catch (error) {
      const terminalError = normalizeApplyTransactionError(error);
      await this.recordFailedApplyAttempt(shop.id, input, payloadHash, claim.receiptId, terminalError);
      throw terminalError;
    }
  }

  private async claimApplyCommand(
    shopId: string,
    input: DsvDispatchImportApplyInput,
    payloadHash: string,
  ): Promise<{ receiptId: string } | { result: DsvDispatchImportApplyResult }> {
    return this.prisma.$transaction(async (tx) => {
      await lockApplyCommand(tx, shopId, input.commandId);
      const existingReceipt = await tx.dsvCommandReceipt.findUnique({
        where: { shopId_commandName_commandId: { commandId: input.commandId, commandName: 'applyDispatchImport', shopId } },
      });
      if (existingReceipt !== null) {
        if (existingReceipt.payloadHash !== payloadHash) throw new DsvDispatchImportApplyError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        if (existingReceipt.status === 'STARTED') throw new DsvDispatchImportApplyError('COMMAND_IN_PROGRESS');
        if (existingReceipt.status === 'SUCCEEDED') {
          const applied = await tx.dsvDispatchImport.findFirst({
            select: { applyResult: true },
            where: { id: input.importId, shopId },
          });
          if (isApplyResult(applied?.applyResult)) return { result: applied.applyResult };
        }
        if (existingReceipt.status === 'FAILED') throw failedApplyReceiptError(existingReceipt);
        throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');
      }
      const receipt = await tx.dsvCommandReceipt.create({
        data: {
          actorId: input.principal?.actorId ?? input.actor,
          actorType: input.principal?.actorType ?? 'DSV_ADMIN',
          commandId: input.commandId,
          commandName: 'applyDispatchImport',
          importId: input.importId,
          payloadHash,
          principalType: input.principal?.principalType ?? 'DSV_ADMIN',
          requestId: input.principal?.requestId ?? input.commandId,
          shopId,
          status: 'STARTED',
        },
      });
      return { receiptId: receipt.id };
    }, failureEvidenceTransactionOptions);
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
    principal?: DsvDispatchImportApplyInput['principal'];
    shopDomain: string;
  }): Promise<DsvTransportConditionView> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    const comparisonKey = conditionComparisonKey(input.code);
    try {
      const condition = await this.prisma.$transaction(async (tx) => {
        await lockCondition(tx, shop.id, comparisonKey);
        const existing = await tx.dsvTransportCondition.findFirst({
          where: {
            OR: [
              { comparisonKey },
              { code: comparisonKey },
            ],
            shopId: shop.id,
          },
        });
        const previousStatus = existing?.status ?? null;
        const promoted = existing === null
          ? await tx.dsvTransportCondition.create({
            data: {
              activatedAt: new Date(),
              code: comparisonKey,
              comparisonKey,
              createdBy: input.actor,
              description: input.description,
              name: input.name,
              rawValue: input.code,
              shopId: shop.id,
              status: 'ACTIVE',
            },
          })
          : await tx.dsvTransportCondition.update({
            data: {
              activatedAt: new Date(),
              code: comparisonKey,
              comparisonKey,
              deactivatedAt: null,
              description: input.description,
              name: input.name,
              rawValue: existing.rawValue ?? input.code,
              status: 'ACTIVE',
            },
            where: { id_shopId: { id: existing.id, shopId: shop.id } },
          });
        const sourceRows = await tx.dsvDispatchImportRow.findMany({
          orderBy: [{ importId: 'asc' }, { rowNumber: 'asc' }],
          select: { importId: true, rowNumber: true },
          where: { conditionId: promoted.id, shopId: shop.id },
        });
        await tx.dsvAuditEvent.create({
          data: {
            actorId: input.principal?.actorId ?? input.actor,
            actorType: input.principal?.actorType ?? 'DSV_ADMIN',
            entityId: promoted.id,
            entityType: 'DsvTransportCondition',
            eventType: 'activateDsvTransportCondition',
            ...(sourceRows[0] === undefined ? {} : { importId: sourceRows[0].importId }),
            principalType: input.principal?.principalType ?? 'DSV_ADMIN',
            reason: 'G003 condition candidate activation',
            redactedDiff: toJson({
              comparisonKey,
              conditionId: promoted.id,
              nextStatus: 'ACTIVE',
              previousStatus,
              sourceRows,
            }),
            requestId: input.principal?.requestId ?? `condition:${promoted.id}`,
            shopId: shop.id,
          },
        });
        return promoted;
      });
      return conditionView(condition);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvDispatchImportConflictError('CONDITION_EXISTS');
      throw error;
    }
  }

  async deleteCondition(input: { conditionId: string; shopDomain: string }): Promise<void> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    await this.prisma.$transaction(async (tx) => {
      const condition = await tx.dsvTransportCondition.findUnique({
        where: { id_shopId: { id: input.conditionId, shopId: shop.id } },
      });
      if (condition === null) throw new DsvTransportConditionNotFoundError();
      const references = await tx.dsvDispatchImportRow.count({
        where: { conditionId: condition.id, shopId: shop.id },
      });
      if (references > 0) throw new DsvDispatchImportConflictError('CONDITION_IN_USE');
      await tx.dsvTransportCondition.delete({
        where: { id_shopId: { id: condition.id, shopId: shop.id } },
      });
    });
  }

  async updateCondition(input: {
    code: string;
    conditionId: string;
    description: string;
    name: string;
    shopDomain: string;
  }): Promise<DsvTransportConditionView> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) throw new DsvDispatchImportShopNotFoundError();
    const comparisonKey = conditionComparisonKey(input.code);
    try {
      const condition = await this.prisma.$transaction(async (tx) => {
        await lockCondition(tx, shop.id, comparisonKey);
        const current = await tx.dsvTransportCondition.findUnique({
          where: { id_shopId: { id: input.conditionId, shopId: shop.id } },
        });
        if (current === null) throw new DsvTransportConditionNotFoundError();
        const duplicate = await tx.dsvTransportCondition.findFirst({
          where: { comparisonKey, id: { not: current.id }, shopId: shop.id },
        });
        if (duplicate !== null) throw new DsvDispatchImportConflictError('CONDITION_EXISTS');
        return tx.dsvTransportCondition.update({
          data: {
            code: comparisonKey,
            comparisonKey,
            description: input.description,
            name: input.name,
            rawValue: input.code,
          },
          where: { id_shopId: { id: current.id, shopId: shop.id } },
        });
      });
      return conditionView(condition);
    } catch (error) {
      if (isUniqueConflict(error)) throw new DsvDispatchImportConflictError('CONDITION_EXISTS');
      throw error;
    }
  }

  private async buildPreviewForRows(
    prisma: Pick<Tx, 'customer' | 'deliveryCustomerProfile' | 'deliveryStop' | 'dsvDriverProfile' | 'dsvTransportCondition' | 'order' | 'routeGroupingBranchOrderLock' | 'routeGroupingChildVersion' | 'routeGroupingOrder' | 'routePlanStop' | 'vehicle'>,
    shopId: string,
    input: Pick<DsvDispatchImportInput, 'fileName' | 'planDate' | 'rows'>,
  ): Promise<DsvDispatchPreviewDiff> {
    const normalizedRows = input.rows.map((row) => ({ ...row, sellerOrderKey: row.sellerOrderKey.trim() }));
    const driverNames = unique(normalizedRows.map((row) => row.driverName.trim()));
    const vehiclePlates = unique(normalizedRows.map((row) => row.vehiclePlate.trim()));
    const customerCodes = unique(normalizedRows.map((row) => row.customerCode.trim()));
    const sellerOrderKeys = unique(normalizedRows.map((row) => row.sellerOrderKey));
    const addressFingerprints = unique(normalizedRows.map((row) => addressFingerprint(row)));
    const serviceDate = new Date(`${input.planDate}T00:00:00.000Z`);

    const [drivers, vehicles, conditions, customers, destinations, orders] = await Promise.all([
      prisma.dsvDriverProfile.findMany({
        select: { driver: { select: { id: true, status: true } }, lookupName: true },
        where: { lookupName: { in: driverNames }, shopId },
      }),
      prisma.vehicle.findMany({
        select: { id: true, licensePlate: true, status: true },
        where: { licensePlate: { in: vehiclePlates }, shopId },
      }),
      prisma.dsvTransportCondition.findMany({
        select: { code: true, comparisonKey: true, id: true, rawValue: true, status: true },
        where: { shopId },
      }),
      prisma.customer.findMany({
        select: { externalCustomerCode: true, id: true, status: true },
        where: { externalCustomerCode: { in: customerCodes }, shopId, sourceKind: dsvDispatchImportSourceKind },
      }),
      prisma.deliveryCustomerProfile.findMany({
        select: { addressFingerprint: true, canonicalName: true, id: true, mergedIntoProfileId: true, normalizedAddress: true },
        where: { addressFingerprint: { in: addressFingerprints }, shopId },
      }),
      prisma.order.findMany({
        include: { deliveryStops: { orderBy: { createdAt: 'asc' }, take: 1 } },
        where: { sellerOrderKey: { in: sellerOrderKeys }, sellerOrderSourceKind: dsvDispatchImportSourceKind, serviceDate, shopId },
      }),
    ]);

    const activeCounts = new Map<string, number>();
    await Promise.all(orders.map(async (order) => {
      const stop = order.deliveryStops[0] ?? null;
      activeCounts.set(order.id, await activeDeliveryOwnershipCount(
        prisma,
        shopId,
        order.id,
        stop?.id ?? null,
        stop?.status ?? null,
        order.currentRouteVersionId,
      ));
    }));

    return buildDsvDispatchPreviewDiff({
      fileName: input.fileName,
      planDate: input.planDate,
      rows: normalizedRows,
      shopId,
      snapshots: {
        canonicalOrders: orders.map((order): DsvDispatchCanonicalOrderSnapshot => {
          const normalized = normalizedFromOrder(order.rawPayload);
          const stop = order.deliveryStops[0] ?? null;
          return {
            activeDeliveryOwnershipCount: activeCounts.get(order.id) ?? 0,
            cancelledAt: order.cancelledAt?.toISOString() ?? null,
            customerId: order.customerId,
            deliveryStatus: order.deliveryStatus,
            deliveryStop: stop === null ? null : {
              address: normalized?.address ?? stop.address1,
              conditionComparisonKey: normalized?.conditionComparisonKey ?? null,
              deliveryDate: stop.deliveryDate?.toISOString().slice(0, 10) ?? null,
              destinationName: normalized?.destinationName ?? null,
              id: stop.id,
              latitude: stop.latitude?.toNumber() ?? null,
              longitude: stop.longitude?.toNumber() ?? null,
              notes: stop.instructions,
              shippedBoxes: normalized?.shippedBoxes ?? null,
              status: stop.status,
            },
            destinationId: order.destinationId,
            id: order.id,
            sellerOrderKey: order.sellerOrderKey ?? '',
            serviceDate: order.serviceDate?.toISOString().slice(0, 10) ?? null,
            sourceKind: order.sellerOrderSourceKind ?? '',
          };
        }),
        conditions,
        customers,
        destinations: destinations.map((destination) => {
          const normalized = normalizedAddress(destination.normalizedAddress);
          return {
            address: normalized.address,
            id: destination.id,
            name: destination.canonicalName ?? normalized.name,
            status: destination.mergedIntoProfileId === null ? 'ACTIVE' : 'INACTIVE',
          };
        }),
        drivers: drivers.map((profile) => ({
          displayName: profile.lookupName,
          id: profile.driver.id,
          status: profile.driver.status,
        })),
        vehicles: vehicles.map((vehicle) => ({ id: vehicle.id, licensePlate: vehicle.licensePlate, status: vehicle.status })),
      },
    });
  }

  private async canonicalizeRows(
    rows: DsvDispatchImportSourceRow[],
    shopDomain: string,
  ): Promise<DsvDispatchImportSourceRow[]> {
    const persistenceSafeRows = rows.map(withPersistenceSafeCoordinates);
    const canonicalizer = this.options.addressCanonicalizer;
    if (canonicalizer === undefined) return persistenceSafeRows;

    const resolutions = new Map<string, Awaited<ReturnType<DsvAddressCanonicalizer['resolve']>>>();
    const pendingAddresses = new Map<string, { destinationName: string; rawAddress: string }>();
    for (const row of persistenceSafeRows) {
      if (row.addressResolutionStatus === 'RESOLVED' && row.postalCode !== undefined) continue;
      const rawAddress = row.rawAddress ?? row.address;
      const key = addressResolutionKey(rawAddress, row.destinationName);
      if (!pendingAddresses.has(key)) {
        pendingAddresses.set(key, { destinationName: row.destinationName, rawAddress });
      }
    }
    const entries = [...pendingAddresses.entries()];
    let nextEntryIndex = 0;
    const workerCount = Math.min(10, entries.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextEntryIndex < entries.length) {
        const entry = entries[nextEntryIndex];
        nextEntryIndex += 1;
        if (entry === undefined) return;
        const [key, pending] = entry;
        resolutions.set(key, await canonicalizer.resolve({
          address: pending.rawAddress,
          destinationName: pending.destinationName,
          shopDomain,
        }));
      }
    }));

    return persistenceSafeRows.map((row) => {
      if (row.addressResolutionStatus === 'RESOLVED' && row.postalCode !== undefined) return row;
      const rawAddress = row.rawAddress ?? row.address;
      const key = addressResolutionKey(rawAddress, row.destinationName);
      const resolution = resolutions.get(key);
      if (resolution === undefined) return row;
      const hasSourceCoordinates = row.latitude !== null && row.longitude !== null;
      const hasResolvedCoordinates = resolution.latitude !== null && resolution.longitude !== null;
      return {
        ...row,
        address: resolution.address,
        ...(resolution.suggestions === undefined
          ? {}
          : { addressSuggestions: resolution.suggestions }),
        addressResolutionStatus: resolution.status === 'RESOLVED' && (hasResolvedCoordinates || hasSourceCoordinates)
          ? 'RESOLVED'
          : resolution.status,
        detailAddress: resolution.detailAddress,
        jibunAddress: resolution.jibunAddress,
        latitude: persistenceSafeCoordinate(hasResolvedCoordinates ? resolution.latitude : row.latitude),
        longitude: persistenceSafeCoordinate(hasResolvedCoordinates ? resolution.longitude : row.longitude),
        postalCode: resolution.postalCode,
        rawAddress: resolution.rawAddress,
      };
    });
  }

  private async persistConditionCandidates(
    shopId: string,
    actor: string,
    diff: DsvDispatchPreviewDiff,
  ): Promise<Map<string, string>> {
    const conditions = await Promise.all(diff.conditionCandidates.map(async (candidate) => {
      const condition = await this.prisma.dsvTransportCondition.upsert({
        create: {
          code: candidate.comparisonKey,
          comparisonKey: candidate.comparisonKey,
          createdBy: actor,
          description: '',
          name: candidate.rawValue,
          rawValue: candidate.rawValue,
          shopId,
          status: 'CANDIDATE',
        },
        update: { rawValue: candidate.rawValue },
        where: { shopId_comparisonKey: { comparisonKey: candidate.comparisonKey, shopId } },
      });
      return { comparisonKey: candidate.comparisonKey, id: condition.id };
    }));
    return new Map(conditions.map((condition) => [condition.comparisonKey, condition.id]));
  }

  private async createNewCanonicalRows(
    tx: Tx,
    shopId: string,
    source: DsvDispatchImportSourceRow,
    row: DsvDispatchDiffRow,
  ): Promise<ApplyCanonicalLink> {
    const customer = await tx.customer.upsert({
      create: {
        displayName: row.normalized.customerCode,
        externalCustomerCode: row.normalized.customerCode,
        metadata: toJson({ sourceKind: dsvDispatchImportSourceKind }),
        shopId,
        sourceKind: dsvDispatchImportSourceKind,
        status: 'ACTIVE',
      },
      update: {},
      where: {
        shopId_sourceKind_externalCustomerCode: {
          externalCustomerCode: row.normalized.customerCode,
          shopId,
          sourceKind: dsvDispatchImportSourceKind,
        },
      },
    });
    if (customer.status !== 'ACTIVE') {
      throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_REVIEW_ROWS');
    }
    const destination = await findOrCreateDestination(tx, shopId, source, row.normalized);
    const serviceDate = new Date(`${row.normalized.planDate}T00:00:00.000Z`);
    const datedSourceOrderId = `${row.normalized.planDate}:${row.sellerOrderKey}`;
    const order = await tx.order.upsert({
      create: {
        customerId: customer.id,
        destinationId: destination.id,
        name: row.sellerOrderKey,
        rawPayload: toJson({ dsv: { normalized: row.normalized, source } }),
        sellerOrderKey: row.sellerOrderKey,
        sellerOrderSourceKind: dsvDispatchImportSourceKind,
        serviceDate,
        shopId,
        shopifyOrderGid: `dsv:${dsvDispatchImportSourceKind}:${datedSourceOrderId}`,
        sourceOrderId: datedSourceOrderId,
        sourceOrderNumber: row.sellerOrderKey,
        sourcePlatform: 'SHOPIFY',
      },
      update: {},
      where: {
        shopId_sellerOrderSourceKind_sellerOrderKey_serviceDate: {
          sellerOrderKey: row.sellerOrderKey,
          sellerOrderSourceKind: dsvDispatchImportSourceKind,
          serviceDate,
          shopId,
        },
      },
    });
    const stop = await tx.deliveryStop.upsert({
      create: {
        address1: row.normalized.address,
        address2: row.normalized.detailAddress ?? null,
        countryCode: 'KR',
        deliveryDate: new Date(`${row.normalized.planDate}T00:00:00.000Z`),
        geocodeStatus: row.normalized.latitude !== null && row.normalized.longitude !== null ? 'RESOLVED' : 'FAILED',
        instructions: row.normalized.notes,
        latitude: row.normalized.latitude,
        longitude: row.normalized.longitude,
        orderId: order.id,
        postalCode: row.normalized.postalCode ?? null,
        recipientName: row.normalized.destinationName,
        shopId,
      },
      update: {},
      where: { shopId_orderId: { orderId: order.id, shopId } },
    });
    return {
      customerId: customer.id,
      deliveryStopId: stop.id,
      destinationId: destination.id,
      sellerOrderId: order.id,
    };
  }

  private async updateCanonicalRows(
    tx: Tx,
    shopId: string,
    source: DsvDispatchImportSourceRow,
    row: DsvDispatchDiffRow,
  ): Promise<ApplyCanonicalLink> {
    if (row.sellerOrderId === null || row.deliveryStopId === null) {
      throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    }
    const customer = await tx.customer.upsert({
      create: {
        displayName: row.normalized.customerCode,
        externalCustomerCode: row.normalized.customerCode,
        metadata: toJson({ sourceKind: dsvDispatchImportSourceKind }),
        shopId,
        sourceKind: dsvDispatchImportSourceKind,
        status: 'ACTIVE',
      },
      update: {},
      where: {
        shopId_sourceKind_externalCustomerCode: {
          externalCustomerCode: row.normalized.customerCode,
          shopId,
          sourceKind: dsvDispatchImportSourceKind,
        },
      },
    });
    if (customer.status !== 'ACTIVE') {
      throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_REVIEW_ROWS');
    }
    const destination = await this.resolveUpdateDestination(tx, shopId, source, row);
    const deliveryDate = new Date(`${row.normalized.planDate}T00:00:00.000Z`);
    const updatedOrder = await tx.order.updateMany({
      data: {
        customerId: customer.id,
        destinationId: destination.id,
        rawPayload: toJson({ dsv: { normalized: row.normalized, source } }),
      },
      where: {
        cancelledAt: null,
        deliveryStatus: 'PENDING',
        id: row.sellerOrderId,
        serviceDate: deliveryDate,
        shopId,
      },
    });
    if (updatedOrder.count !== 1) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    const updatedStop = await tx.deliveryStop.updateMany({
      data: {
        address1: row.normalized.address,
        address2: row.normalized.detailAddress ?? null,
        countryCode: 'KR',
        deliveryDate,
        geocodeStatus: row.normalized.latitude !== null && row.normalized.longitude !== null ? 'RESOLVED' : 'FAILED',
        instructions: row.normalized.notes,
        latitude: row.normalized.latitude,
        longitude: row.normalized.longitude,
        postalCode: row.normalized.postalCode ?? null,
        recipientName: row.normalized.destinationName,
      },
      where: {
        id: row.deliveryStopId,
        shopId,
        status: 'PENDING',
      },
    });
    if (updatedStop.count !== 1) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    const [order, stop] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id_shopId: { id: row.sellerOrderId, shopId } } }),
      tx.deliveryStop.findUniqueOrThrow({ where: { id_shopId: { id: row.deliveryStopId, shopId } } }),
    ]);
    return {
      customerId: order.customerId ?? customer.id,
      deliveryStopId: stop.id,
      destinationId: order.destinationId ?? destination.id,
      sellerOrderId: order.id,
    };
  }

  private async resolveUpdateDestination(
    tx: Tx,
    shopId: string,
    source: DsvDispatchImportSourceRow,
    row: DsvDispatchDiffRow,
  ) {
    if (row.destinationId !== null && !row.candidateDiff.some((diff) => diff.field === 'destinationId')) {
      const existing = await tx.deliveryCustomerProfile.findFirst({
        where: { id: row.destinationId, mergedIntoProfileId: null, shopId },
      });
      if (existing !== null) return existing;
    }
    if (row.destinationId !== null) {
      const matched = await tx.deliveryCustomerProfile.findFirst({
        where: { id: row.destinationId, mergedIntoProfileId: null, shopId },
      });
      if (matched !== null) return matched;
    }
    return findOrCreateDestination(tx, shopId, source, row.normalized);
  }

  private async linkNoOpRow(tx: Tx, shopId: string, row: DsvDispatchDiffRow): Promise<ApplyCanonicalLink> {
    if (row.sellerOrderId === null || row.deliveryStopId === null) {
      throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    }
    const order = await tx.order.findFirst({
      include: { deliveryStops: { orderBy: { createdAt: 'asc' }, take: 1 } },
      where: { id: row.sellerOrderId, shopId },
    });
    if (order === null || order.deliveryStops[0] === undefined) {
      throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
    }
    return {
      customerId: order.customerId ?? row.customerId ?? '',
      deliveryStopId: order.deliveryStops[0].id,
      destinationId: order.destinationId ?? row.destinationId ?? '',
      sellerOrderId: order.id,
    };
  }

  private async ensureDispatchGrouping(
    tx: Tx,
    shopId: string,
    importId: string,
    fileName: string,
    planDate: Date,
    actor: string,
    rows: DsvDispatchImportApplyResult['rows'],
  ): Promise<void> {
    const orderIds = rows.map((row) => row.sellerOrderId);
    const ownedOrderIds = new Set((await tx.routeGroupingOrder.findMany({
      select: { orderId: true },
      where: { orderId: { in: orderIds }, shopId },
    })).map((row) => row.orderId));
    const unownedRows = rows.filter((row) => !ownedOrderIds.has(row.sellerOrderId));
    if (unownedRows.length === 0) return;

    const grouping = await findOrCreateUnassignedDispatchGrouping(tx, shopId, importId, fileName, planDate, actor);
    await tx.routeGroupingOrder.createMany({
      data: unownedRows.map((row, index) => ({
        assignmentStatus: 'UNASSIGNED',
        deliveryStopId: row.deliveryStopId,
        groupingId: grouping.id,
        orderId: row.sellerOrderId,
        shopId,
        sourceSequence: index + 1,
      })),
    });
  }

  private async recordFailedApplyAttempt(
    shopId: string,
    input: DsvDispatchImportApplyInput,
    payloadHash: string,
    receiptId: string,
    error: DsvDispatchImportApplyError,
  ): Promise<void> {
    const code = error.code;
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockApplyCommand(tx, shopId, input.commandId);
        await lockApplyImport(tx, shopId, input.importId);
        const failedReceipt = await tx.dsvCommandReceipt.updateMany({
          data: {
            completedAt: new Date(),
            responseBodyRef: canonicalJson({ code, status: failureStatus(code) }),
            responseStatus: failureStatus(code),
            status: 'FAILED',
          },
          where: { id: receiptId, payloadHash, shopId, status: 'STARTED' },
        });
        if (failedReceipt.count !== 1) return;
        const importState = await tx.dsvDispatchImport.findFirst({
          select: { status: true },
          where: { id: input.importId, shopId },
        });
        if (importState === null) throw new Error('Failed receipt cannot be linked to an import');
        const preserveAppliedBatch = importState.status === 'APPLIED';
        if (!preserveAppliedBatch) {
          const failedImport = await tx.dsvDispatchImport.updateMany({
            data: { failureCode: code, failureMessage: code, status: 'FAILED' },
            where: { id: input.importId, shopId, status: { not: 'APPLIED' } },
          });
          if (failedImport.count !== 1) throw new Error('Failed receipt cannot be linked to an applicable import');
        }
        await tx.dsvAuditEvent.create({
          data: {
            actorId: input.principal?.actorId ?? input.actor,
            actorType: input.principal?.actorType ?? 'DSV_ADMIN',
            commandReceiptId: receiptId,
            entityId: input.importId,
            entityType: 'DsvDispatchImport',
            eventType: 'applyDispatchImportFailed',
            importId: input.importId,
            principalType: input.principal?.principalType ?? 'DSV_ADMIN',
            reason: code,
            redactedDiff: toJson({
              code,
              compensation: 'canonical mutation transaction rolled back',
              preservedAppliedBatch: preserveAppliedBatch,
            }),
            requestId: input.principal?.requestId ?? input.commandId,
            shopId,
          },
        });
      }, failureEvidenceTransactionOptions);
    } catch {
      // The original apply error is more useful to callers than best-effort compensation failure.
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
    if (matchingDrivers.length === 0) issues.push(legacyIssue('DRIVER_NOT_FOUND', 'driverName', '등록된 배송원을 찾을 수 없습니다.'));
    if (matchingDrivers.length > 1) issues.push(legacyIssue('DRIVER_AMBIGUOUS', 'driverName', '같은 이름의 배송원이 둘 이상입니다. 고유 식별자가 필요합니다.'));
    if (matchingVehicles.length === 0) issues.push(legacyIssue('VEHICLE_NOT_FOUND', 'vehiclePlate', '등록된 차량 번호를 찾을 수 없습니다.'));
    if (duplicateKeys.has(source.sellerOrderKey)) issues.push(legacyIssue('SELLER_ORDER_DUPLICATED', 'sellerOrderKey', '파일 안에서 SellerOrderKey가 중복됩니다.'));
    if (priorKeys.has(source.sellerOrderKey)) issues.push(legacyIssue('SELLER_ORDER_ALREADY_IMPORTED', 'sellerOrderKey', '이미 업로드된 SellerOrderKey입니다.'));
    if (conflictingDrivers.has(source.driverName)) issues.push(legacyIssue('DRIVER_VEHICLE_CONFLICT', 'vehiclePlate', '한 배송원에게 파일 내 여러 차량이 지정되었습니다.'));
    if (conflictingVehicles.has(source.vehiclePlate)) issues.push(legacyIssue('VEHICLE_DRIVER_CONFLICT', 'driverName', '한 차량에 파일 내 여러 배송원이 지정되었습니다.'));
    if (!knownConditions.has(source.conditionCode)) issues.push(legacyIssue('CONDITION_UNREGISTERED', 'conditionCode', '운송조건을 먼저 등록해야 합니다.'));
    if (source.latitude === null && source.longitude === null) {
      issues.push(legacyIssue('LOCATION_NOT_RESOLVED', 'row', '좌표가 없어 주문 생성 전 주소 확인 또는 지오코딩이 필요합니다.', 'review'));
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
    canApply: rows.length > 0 && errorRows === 0 && reviewRows === 0,
    canCommit: rows.length > 0 && errorRows === 0,
    conditionCandidates,
    fileName: input.fileName,
    planDate: input.planDate,
    previewHash: sha256CanonicalJson({ fileName: input.fileName, planDate: input.planDate, rows }),
    rows,
    sourceHash: sha256CanonicalJson({ fileName: input.fileName, planDate: input.planDate, rows: input.rows }),
    summary: {
      errorRows,
      readyRows: rows.length - errorRows - reviewRows,
      reviewRows,
      totalRows: rows.length,
    },
  };
}

function previewView(diff: DsvDispatchPreviewDiff, sourceRows: DsvDispatchImportSourceRow[]): DsvDispatchImportPreview {
  const errorRows = diff.summary.errorRows + diff.summary.conflictRows;
  const reviewRows = diff.rows.filter((row) =>
    row.issues.some((issue) => issue.severity === 'review')
    && !row.issues.some((issue) => issue.severity === 'error')).length;
  const hasAddressResolutionIssue = diff.rows.some((row) =>
    row.issues.some((issue) => isAddressResolutionIssue(issue.code)));
  return {
    canApply: diff.canApply,
    canCommit: diff.rows.length > 0 && errorRows === 0 && !hasAddressResolutionIssue,
    conditionCandidates: diff.conditionCandidates,
    fileName: diff.fileName,
    planDate: diff.planDate,
    previewHash: diff.previewHash,
    rows: diff.rows.map((row) => {
      const source = sourceRows.find((item) => item.rowNumber === row.rowNumber && item.sellerOrderKey.trim() === row.sellerOrderKey);
      return {
        ...(source ?? {
          address: row.normalized.address,
          conditionCode: row.normalized.conditionComparisonKey,
          customerCode: row.normalized.customerCode,
          destinationName: row.normalized.destinationName,
          driverName: row.normalized.driverName,
          latitude: row.normalized.latitude,
          longitude: row.normalized.longitude,
          notes: row.normalized.notes,
          rowNumber: row.rowNumber,
          sellerOrderKey: row.sellerOrderKey,
          shippedBoxes: row.normalized.shippedBoxes,
          vehiclePlate: row.normalized.vehiclePlate,
        }),
        candidateDiff: row.candidateDiff,
        conditionId: row.conditionId,
        customerId: row.customerId,
        deliveryStopId: row.deliveryStopId,
        destinationId: row.destinationId,
        diffKind: row.diffKind,
        driverId: row.driverId,
        issues: row.issues,
        normalized: row.normalized,
        sellerOrderId: row.sellerOrderId,
        status: row.issues.length === 0 && isReadyDiffKind(row.diffKind) ? 'READY' : 'NEEDS_REVIEW',
        vehicleId: row.vehicleId,
      };
    }),
    sourceHash: diff.sourceHash,
    summary: {
      conflictRows: diff.summary.conflictRows,
      errorRows,
      newRows: diff.summary.newRows,
      noOpRows: diff.summary.noOpRows,
      readyRows: diff.rows.length - errorRows - reviewRows,
      reviewRows,
      totalRows: diff.summary.totalRows,
      updateCandidateRows: diff.summary.updateCandidateRows,
    },
  };
}

function isAddressResolutionIssue(code: string): boolean {
  return code === 'ADDRESS_AMBIGUOUS'
    || code === 'ADDRESS_COORDINATES_NOT_RESOLVED'
    || code === 'ADDRESS_NOT_FOUND'
    || code === 'ADDRESS_SERVICE_UNAVAILABLE';
}

function matchesStagedPreviewExceptResolvedDestination(
  stagedRows: Array<{
    candidateDiff: Prisma.JsonValue | null;
    conditionId: string | null;
    customerId: string | null;
    deliveryStopId: string | null;
    destinationId: string | null;
    diffKind: string;
    driverId: string | null;
    issues: Prisma.JsonValue;
    normalized: Prisma.JsonValue;
    rowNumber: number;
    sellerOrderId: string | null;
    sellerOrderKey: string;
    vehicleId: string | null;
  }>,
  recomputed: DsvDispatchPreviewDiff,
): boolean {
  if (stagedRows.length !== recomputed.rows.length) return false;
  return recomputed.rows.every((row) => {
    const staged = stagedRows.find((candidate) =>
      candidate.rowNumber === row.rowNumber && candidate.sellerOrderKey === row.sellerOrderKey);
    if (staged === undefined || staged.diffKind !== row.diffKind) return false;
    const destinationMatches = staged.destinationId === row.destinationId
      || (row.diffKind === 'NEW' && staged.destinationId === null && row.destinationId !== null);
    return destinationMatches
      && staged.conditionId === row.conditionId
      && staged.customerId === row.customerId
      && staged.deliveryStopId === row.deliveryStopId
      && staged.driverId === row.driverId
      && staged.sellerOrderId === row.sellerOrderId
      && staged.vehicleId === row.vehicleId
      && canonicalJson(staged.candidateDiff) === canonicalJson(row.candidateDiff)
      && canonicalJson(staged.issues) === canonicalJson(row.issues)
      && canonicalJson(staged.normalized) === canonicalJson(row.normalized);
  });
}

function applyFailureFromPersistedRows(rows: Array<{ issues: Prisma.JsonValue }>): ApplyFailureCode | null {
  const codes = rows.flatMap((row) => issueCodes(row.issues));
  if (codes.includes('CUSTOMER_INACTIVE')) return 'DISPATCH_IMPORT_HAS_REVIEW_ROWS';
  if (codes.includes('DUPLICATE_ACTIVE_DELIVERY')) return 'DUPLICATE_ACTIVE_DELIVERY';
  if (codes.includes('CONDITION_CANDIDATE')) return 'DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES';
  if (codes.includes('CONDITION_INACTIVE')) return 'DISPATCH_IMPORT_INACTIVE_CONDITION';
  return null;
}

function issueCodes(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) => {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) return [];
    const code = (issue as Record<string, unknown>).code;
    return typeof code === 'string' ? [code] : [];
  });
}

function assertApplicable(diff: DsvDispatchPreviewDiff): void {
  if (diff.rows.some((row) => row.diffKind === 'CONFLICT')) {
    throw new DsvDispatchImportApplyError(
      diff.rows.some((row) => row.issues.some((issue) => issue.code === 'DUPLICATE_ACTIVE_DELIVERY'))
        ? 'DUPLICATE_ACTIVE_DELIVERY'
        : 'DISPATCH_IMPORT_CANONICAL_CONFLICT',
    );
  }
  const issues = diff.rows.flatMap((row) => row.issues);
  if (issues.some((issue) => issue.code === 'CONDITION_CANDIDATE')) {
    throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES');
  }
  if (issues.some((issue) => issue.code === 'CONDITION_INACTIVE')) {
    throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_INACTIVE_CONDITION');
  }
  if (issues.some((issue) => issue.code === 'CUSTOMER_INACTIVE')) {
    throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_REVIEW_ROWS');
  }
  if (issues.some((issue) => issue.code.endsWith('_AMBIGUOUS'))) {
    throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_RESOURCE_AMBIGUOUS');
  }
  if (issues.some((issue) => issue.code.endsWith('_MISSING'))) {
    throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_RESOURCE_MISSING');
  }
  if (issues.length > 0 || !diff.canApply) throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_REVIEW_ROWS');
}

async function lockApplyImport(tx: Pick<Tx, '$queryRaw'>, shopId: string, importId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-apply:${shopId}:${importId}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockApplyCommand(tx: Pick<Tx, '$queryRaw'>, shopId: string, commandId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-command:${shopId}:${commandId}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockSellerOrder(tx: Pick<Tx, '$queryRaw'>, shopId: string, sellerOrderKey: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-seller-order:${shopId}:${sellerOrderKey}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockCanonicalOrderRows(
  tx: Pick<Tx, '$queryRaw'>,
  shopId: string,
  sellerOrderKeys: string[],
): Promise<void> {
  const keys = unique(sellerOrderKeys).sort((left, right) => left.localeCompare(right));
  if (keys.length === 0) return;
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM orders
    WHERE "shopId" = ${shopId}::uuid
      AND "sellerOrderSourceKind" = ${dsvDispatchImportSourceKind}
      AND "sellerOrderKey" IN (${Prisma.join(keys)})
    ORDER BY "sellerOrderKey"
    FOR UPDATE
  `;
}

async function lockDestinationFingerprint(tx: Pick<Tx, '$queryRaw'>, shopId: string, fingerprint: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-destination:${shopId}:${fingerprint}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function lockCondition(tx: Pick<Tx, '$queryRaw'>, shopId: string, comparisonKey: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${`dsv-condition:${shopId}:${comparisonKey}`}, 0))) SELECT 1 AS locked FROM lock`;
}

async function activeDeliveryOwnershipCount(
  prisma: Pick<Tx, 'routeGroupingBranchOrderLock' | 'routeGroupingChildVersion' | 'routeGroupingOrder' | 'routePlanStop'>,
  shopId: string,
  orderId: string,
  deliveryStopId: string | null,
  deliveryStopStatus: string | null,
  currentRouteVersionId: string | null,
): Promise<number> {
  if (deliveryStopId === null || deliveryStopStatus === null || !activeDeliveryStopStatuses.has(deliveryStopStatus)) return 0;
  const [groupingOrders, branchLocks, routePlanStops] = await Promise.all([
    prisma.routeGroupingOrder.findMany({
      select: { groupingId: true },
      where: {
        assignmentStatus: 'ASSIGNED',
        deliveryStopId,
        grouping: { status: { in: ['PUBLISHED', 'READY', 'CHANGED'] } },
        orderId,
        shopId,
      },
    }),
    prisma.routeGroupingBranchOrderLock.findMany({
      select: { groupingId: true },
      where: {
        deliveryStopId,
        grouping: { status: { in: ['PUBLISHED', 'READY', 'CHANGED'] } },
        orderId,
        routeGroupingOrder: { assignmentStatus: 'ASSIGNED' },
        shopId,
      },
    }),
    prisma.routePlanStop.findMany({
      select: { routePlanId: true },
      where: {
        deliveryStopId,
        routePlan: { shopId, status: { in: ['PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'READY'] } },
      },
    }),
  ]);
  const routePlanIds = unique(routePlanStops.map((stop) => stop.routePlanId));
  const versionSelectors: Prisma.RouteGroupingChildVersionWhereInput[] = [];
  if (currentRouteVersionId !== null) versionSelectors.push({ id: currentRouteVersionId });
  if (routePlanIds.length > 0) versionSelectors.push({ routePlanId: { in: routePlanIds } });
  const childVersions = versionSelectors.length === 0
    ? []
    : await prisma.routeGroupingChildVersion.findMany({
      select: {
        grouping: { select: { routeScopeKey: true, serviceType: true } },
        groupingId: true,
        id: true,
        routePlan: { select: { status: true } },
        routePlanId: true,
      },
      where: {
        OR: versionSelectors,
        grouping: { status: { in: ['PUBLISHED', 'READY', 'CHANGED'] } },
        groupingVersion: { status: 'CURRENT' },
        shopId,
        status: 'CURRENT',
        supersededAt: null,
      },
    });
  const mutableReadyRoutePlanIds = new Set(childVersions
    .filter((child) => child.routePlanId !== null && isMutableDsvReadyRouteVersion(child, groupingOrders))
    .map((child) => child.routePlanId));
  const activeChildVersions = childVersions.filter((child) =>
    child.routePlan !== null
    && (
      activeRoutePlanStatuses.has(child.routePlan.status)
      || (child.routePlan.status === 'READY' && !isMutableDsvReadyRouteVersion(child, groupingOrders))
    ));
  const routePlanVersions = new Map(
    activeChildVersions
      .filter((child): child is typeof child & { routePlanId: string } => child.routePlanId !== null)
      .map((child) => [child.routePlanId, { groupingId: child.groupingId, id: child.id }]),
  );
  const ownershipIdentities = new Set<string>();
  const corroboratingGroupingIds = new Set([...groupingOrders, ...branchLocks].map((owner) => owner.groupingId));
  const routeOwnerGroupingIds = new Set<string>();
  const currentVersion = activeChildVersions.find((version) => version.id === currentRouteVersionId);
  if (currentVersion !== undefined) {
    ownershipIdentities.add(`route-version:${currentVersion.id}`);
    routeOwnerGroupingIds.add(currentVersion.groupingId);
  }
  for (const stop of routePlanStops) {
    if (mutableReadyRoutePlanIds.has(stop.routePlanId)) continue;
    const version = routePlanVersions.get(stop.routePlanId);
    if (version === undefined) {
      ownershipIdentities.add(`route-plan:${stop.routePlanId}`);
      continue;
    }
    ownershipIdentities.add(`route-version:${version.id}`);
    routeOwnerGroupingIds.add(version.groupingId);
  }
  for (const groupingId of corroboratingGroupingIds) {
    if (!routeOwnerGroupingIds.has(groupingId)) ownershipIdentities.add(`grouping:${groupingId}`);
  }
  return ownershipIdentities.size;
}

const activeDeliveryStopStatuses: ReadonlySet<string> = new Set(['PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED']);
const activeRoutePlanStatuses: ReadonlySet<string> = new Set(['PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS']);

function isMutableDsvReadyRouteVersion(
  version: {
    grouping: { routeScopeKey: string | null; serviceType: string | null };
    groupingId: string;
    routePlan: { status: string } | null;
  },
  groupingOrders: Array<{ groupingId: string }>,
): boolean {
  return version.routePlan?.status === 'READY'
    && version.grouping.serviceType === 'DSV_DISPATCH'
    && (version.grouping.routeScopeKey?.startsWith('dsv-import:') ?? false)
    && groupingOrders.every((order) => order.groupingId !== version.groupingId);
}

type ApplyCanonicalLink = {
  customerId: string;
  deliveryStopId: string;
  destinationId: string;
  sellerOrderId: string;
};

async function invalidateReadyRoutePlansForUpdates(
  tx: Tx,
  shopId: string,
  rows: DsvDispatchImportApplyResult['rows'],
): Promise<void> {
  if (rows.length === 0) return;
  const routePlanStops = await tx.routePlanStop.findMany({
    select: { routePlanId: true },
    where: {
      deliveryStopId: { in: rows.map((row) => row.deliveryStopId) },
      routePlan: {
        routeGroupingChildVersions: {
          some: {
            grouping: {
              routeScopeKey: { startsWith: 'dsv-import:' },
              serviceType: 'DSV_DISPATCH',
            },
            groupingVersion: { status: 'CURRENT' },
            shopId,
            status: 'CURRENT',
            supersededAt: null,
          },
        },
        shopId,
        status: 'READY',
      },
      shopId,
    },
  });
  const routePlanIds = unique(routePlanStops.map((stop) => stop.routePlanId));
  if (routePlanIds.length === 0) return;

  await Promise.all([
    tx.routePlanStop.updateMany({
      data: {
        distanceFromPreviousMeters: null,
        durationFromPreviousSeconds: null,
        estimatedArrivalAt: null,
        etaCalculatedAt: null,
        etaFailureCode: null,
        etaFailureMessage: null,
        etaInputRouteVersionId: null,
        etaSource: null,
        etaStatus: 'NOT_REQUIRED',
      },
      where: { routePlanId: { in: routePlanIds }, shopId },
    }),
    tx.routePlanGeometryCache.deleteMany({
      where: { routePlanId: { in: routePlanIds } },
    }),
  ]);
}

async function findOrCreateUnassignedDispatchGrouping(
  tx: Tx,
  shopId: string,
  importId: string,
  fileName: string,
  planDate: Date,
  actor: string,
): Promise<{ id: string }> {
  const routeScopeKey = `dsv-import:${importId}`;
  const existing = await tx.routeGrouping.findFirst({
    select: { id: true },
    where: { planDate, routeScopeKey, shopId, status: { in: ['READY', 'CHANGED'] } },
  });
  if (existing !== null) return existing;
  const grouping = await tx.routeGrouping.create({
    data: {
      createdBy: actor,
      name: fileName,
      planDate,
      routeScopeKey,
      serviceType: 'DSV_DISPATCH',
      shopId,
      status: 'READY',
    },
    select: { id: true },
  });
  await tx.routeGroupingVersion.create({
    data: {
      actor,
      changeReason: 'DSV dispatch import date sync',
      groupingId: grouping.id,
      shopId,
      status: 'CURRENT',
      version: 1,
    },
  });
  return grouping;
}

async function findOrCreateDestination(
  tx: Tx,
  shopId: string,
  source: DsvDispatchImportSourceRow,
  normalized: DsvDispatchDiffRow['normalized'],
) {
  const fingerprint = addressFingerprint(source);
  const existing = await tx.deliveryCustomerProfile.findFirst({
    where: { addressFingerprint: fingerprint, mergedIntoProfileId: null, shopId },
  });
  if (existing !== null) return existing;
  return tx.deliveryCustomerProfile.create({
    data: {
      addressFingerprint: fingerprint,
      canonicalName: source.destinationName.trim(),
      normalizedAddress: toJson({
        address: normalized.address,
        detailAddress: normalized.detailAddress ?? null,
        jibunAddress: normalized.jibunAddress ?? null,
        latitude: normalized.latitude,
        longitude: normalized.longitude,
        name: source.destinationName.trim(),
        postalCode: normalized.postalCode ?? null,
        rawAddress: normalized.rawAddress ?? source.address.trim(),
      }),
      normalizedNameKey: source.destinationName.trim().toUpperCase(),
      shopId,
    },
  });
}

function addressFingerprint(
  row: Pick<DsvDispatchImportSourceRow, 'address' | 'destinationName' | 'detailAddress' | 'postalCode'>,
): string {
  const structuredSuffix = row.detailAddress === undefined && row.postalCode === undefined
    ? ''
    : `|${row.postalCode?.trim() ?? ''}|${row.detailAddress?.trim().toUpperCase() ?? ''}`;
  return createHash('sha256')
    .update(`${row.destinationName.trim().toUpperCase()}|${row.address.trim().toUpperCase()}${structuredSuffix}`, 'utf8')
    .digest('hex');
}

function withPersistenceSafeCoordinates(row: DsvDispatchImportSourceRow): DsvDispatchImportSourceRow {
  return {
    ...row,
    latitude: persistenceSafeCoordinate(row.latitude),
    longitude: persistenceSafeCoordinate(row.longitude),
  };
}

function addressResolutionKey(rawAddress: string, destinationName: string): string {
  const normalize = (value: string): string =>
    value.trim().replace(/\s+/gu, ' ').toLowerCase();
  return `${normalize(rawAddress)}|${normalize(destinationName)}`;
}

function persistenceSafeCoordinate(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(7));
}

function sourceRowFromRecord(row: {
  address: string;
  conditionCode: string;
  customerCode: string;
  destinationName: string;
  driverName: string;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
  notes: string | null;
  normalized: Prisma.JsonValue;
  rowNumber: number;
  sellerOrderKey: string;
  shippedBoxes: number;
  vehiclePlate: string;
}): DsvDispatchImportSourceRow {
  const normalized = normalizedFromJson(row.normalized);
  return {
    address: row.address,
    ...(normalized?.addressResolutionStatus === undefined
      ? {}
      : { addressResolutionStatus: normalized.addressResolutionStatus }),
    conditionCode: row.conditionCode,
    customerCode: row.customerCode,
    ...(normalized?.detailAddress === undefined ? {} : { detailAddress: normalized.detailAddress }),
    destinationName: row.destinationName,
    driverName: row.driverName,
    ...(normalized?.jibunAddress === undefined ? {} : { jibunAddress: normalized.jibunAddress }),
    latitude: row.latitude?.toNumber() ?? null,
    longitude: row.longitude?.toNumber() ?? null,
    notes: row.notes,
    ...(normalized?.postalCode === undefined ? {} : { postalCode: normalized.postalCode }),
    ...(normalized?.rawAddress === undefined ? {} : { rawAddress: normalized.rawAddress }),
    rowNumber: row.rowNumber,
    sellerOrderKey: row.sellerOrderKey,
    shippedBoxes: row.shippedBoxes,
    vehiclePlate: row.vehiclePlate,
  };
}

function stageStatus(diff: DsvDispatchPreviewDiff): 'READY' | 'NEEDS_REVIEW' {
  return diff.rows.every((row) => row.issues.length === 0 && isReadyDiffKind(row.diffKind))
    ? 'READY'
    : 'NEEDS_REVIEW';
}

function rowStatus(row: DsvDispatchDiffRow): 'READY' | 'NEEDS_REVIEW' {
  return row.issues.length === 0 && isReadyDiffKind(row.diffKind) ? 'READY' : 'NEEDS_REVIEW';
}

function isReadyDiffKind(kind: DsvDispatchDiffRow['diffKind']): boolean {
  return kind === 'NEW' || kind === 'NO_OP' || kind === 'UPDATE_CANDIDATE';
}

function applyPayloadHash(input: {
  commandId: string;
  importId: string;
  previewHash: string;
  sourceHash: string;
}): string {
  return sha256CanonicalJson({
    commandId: input.commandId,
    commandName: 'applyDispatchImport',
    importId: input.importId,
    previewHash: input.previewHash,
    sourceHash: input.sourceHash,
  });
}

function failureStatus(code: ApplyFailureCode): number {
  return code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
    || code === 'COMMAND_IN_PROGRESS'
    || code === 'DISPATCH_IMPORT_ALREADY_APPLIED'
    || code === 'DISPATCH_IMPORT_PREVIEW_STALE'
    || code === 'DUPLICATE_ACTIVE_DELIVERY'
    ? 409
    : 422;
}

function normalizeApplyTransactionError(error: unknown): DsvDispatchImportApplyError {
  if (error instanceof DsvDispatchImportApplyError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
    return new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
  }
  return new DsvDispatchImportApplyError('DISPATCH_IMPORT_CANONICAL_CONFLICT');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function failedApplyReceiptError(receipt: { responseBodyRef: string | null; responseStatus: number | null }): DsvDispatchImportApplyError {
  if (receipt.responseBodyRef !== null) {
    try {
      const metadata = JSON.parse(receipt.responseBodyRef) as { code?: unknown; status?: unknown };
      if (
        isApplyFailureCode(metadata.code)
        && typeof metadata.status === 'number'
        && metadata.status === receipt.responseStatus
      ) {
        return new DsvDispatchImportApplyError(metadata.code);
      }
    } catch {
      // Legacy failed receipts without valid metadata require a new command ID.
    }
  }
  return new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY');
}

function isApplyFailureCode(value: unknown): value is ApplyFailureCode {
  return typeof value === 'string' && applyFailureCodes.has(value as ApplyFailureCode);
}

const applyFailureCodes: ReadonlySet<ApplyFailureCode> = new Set([
  'COMMAND_IN_PROGRESS',
  'DISPATCH_IMPORT_ALREADY_APPLIED',
  'DISPATCH_IMPORT_CANONICAL_CONFLICT',
  'DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES',
  'DISPATCH_IMPORT_HAS_REVIEW_ROWS',
  'DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES',
  'DISPATCH_IMPORT_INACTIVE_CONDITION',
  'DISPATCH_IMPORT_NOT_READY',
  'DISPATCH_IMPORT_PREVIEW_STALE',
  'DISPATCH_IMPORT_RESOURCE_AMBIGUOUS',
  'DISPATCH_IMPORT_RESOURCE_MISSING',
  'DUPLICATE_ACTIVE_DELIVERY',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
]);

function conditionView(condition: {
  code: string;
  createdAt: Date;
  description: string;
  id: string;
  name: string;
  status?: string | null;
  updatedAt: Date;
}): DsvTransportConditionView {
  return {
    code: condition.code,
    createdAt: condition.createdAt.toISOString(),
    description: condition.description,
    id: condition.id,
    name: condition.name,
    status: condition.status ?? null,
    updatedAt: condition.updatedAt.toISOString(),
  };
}

function importView(record: {
  createdAt: Date;
  fileName: string;
  id: string;
  planDate: Date;
  previewHash?: string;
  rowCount: number;
  rows: Array<{
    address: string;
    candidateDiff?: Prisma.JsonValue | null;
    conditionCode: string;
    conditionId?: string | null;
    customerCode: string;
    customerId?: string | null;
    deliveryStopId?: string | null;
    destinationId?: string | null;
    destinationName: string;
    diffKind?: string;
    driverId: string | null;
    driverName: string;
    issues: Prisma.JsonValue;
    latitude: Prisma.Decimal | null;
    longitude: Prisma.Decimal | null;
    normalized?: Prisma.JsonValue;
    notes: string | null;
    rowNumber: number;
    sellerOrderId?: string | null;
    sellerOrderKey: string;
    shippedBoxes: number;
    status: 'READY' | 'NEEDS_REVIEW' | 'APPLYING' | 'APPLIED' | 'BLOCKED';
    vehicleId: string | null;
    vehiclePlate: string;
  }>;
  sourceHash?: string;
  status: 'STAGED' | 'READY' | 'NEEDS_REVIEW' | 'APPLYING' | 'APPLIED' | 'FAILED';
}): DsvDispatchImportView {
  return {
    createdAt: record.createdAt.toISOString(),
    fileName: record.fileName,
    id: record.id,
    planDate: record.planDate.toISOString().slice(0, 10),
    previewHash: record.previewHash,
    rowCount: record.rowCount,
    rows: record.rows.map((row) => ({
      address: row.address,
      candidateDiff: Array.isArray(row.candidateDiff) ? row.candidateDiff as DsvDispatchDiffRow['candidateDiff'] : undefined,
      conditionCode: row.conditionCode,
      conditionId: row.conditionId,
      customerCode: row.customerCode,
      customerId: row.customerId,
      deliveryStopId: row.deliveryStopId,
      destinationId: row.destinationId,
      destinationName: row.destinationName,
      diffKind: isDiffKind(row.diffKind) ? row.diffKind : undefined,
      driverId: row.driverId,
      driverName: row.driverName,
      issues: Array.isArray(row.issues) ? row.issues as DsvDispatchIssue[] : [],
      latitude: row.latitude?.toNumber() ?? null,
      longitude: row.longitude?.toNumber() ?? null,
      normalized: normalizedFromJson(row.normalized),
      notes: row.notes,
      rowNumber: row.rowNumber,
      sellerOrderId: row.sellerOrderId,
      sellerOrderKey: row.sellerOrderKey,
      shippedBoxes: row.shippedBoxes,
      status: row.status,
      vehicleId: row.vehicleId,
      vehiclePlate: row.vehiclePlate,
    })),
    sourceHash: record.sourceHash,
    status: record.status,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizedAddress(value: Prisma.JsonValue): { address: string; name: string } {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      address: typeof record.address === 'string' ? record.address : '',
      name: typeof record.name === 'string' ? record.name : '',
    };
  }
  return { address: '', name: '' };
}

function normalizedFromOrder(value: Prisma.JsonValue): DsvDispatchDiffRow['normalized'] | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const dsv = (value as Record<string, unknown>).dsv;
    if (dsv !== null && typeof dsv === 'object' && !Array.isArray(dsv)) {
      return normalizedFromJson((dsv as Record<string, unknown>).normalized as Prisma.JsonValue);
    }
  }
  return null;
}

function normalizedFromJson(value: Prisma.JsonValue | undefined): DsvDispatchDiffRow['normalized'] | null {
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (
      typeof row.address === 'string'
      && typeof row.conditionComparisonKey === 'string'
      && typeof row.customerCode === 'string'
      && typeof row.destinationName === 'string'
      && typeof row.driverName === 'string'
      && typeof row.planDate === 'string'
      && typeof row.sellerOrderKey === 'string'
      && typeof row.shippedBoxes === 'number'
      && typeof row.sourceKind === 'string'
      && typeof row.vehiclePlate === 'string'
    ) {
      return row as DsvDispatchDiffRow['normalized'];
    }
  }
  return null;
}

function isApplyResult(value: Prisma.JsonValue | undefined): value is DsvDispatchImportApplyResult {
  return value !== null
    && value !== undefined
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { status?: unknown }).status === 'APPLIED';
}

function isDiffKind(value: string | undefined): value is DsvDispatchDiffRow['diffKind'] {
  return value === 'NEW' || value === 'NO_OP' || value === 'UPDATE_CANDIDATE' || value === 'CONFLICT' || value === 'ERROR';
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
    if (value === '') issues.push(legacyIssue('REQUIRED', field, '필수 값입니다.'));
    else if (value.length > maxLength) issues.push(legacyIssue('TOO_LONG', field, `${maxLength}자 이하여야 합니다.`));
  }
  if (!Number.isInteger(row.rowNumber) || row.rowNumber < 2) issues.push(legacyIssue('ROW_NUMBER_INVALID', 'rowNumber', '행 번호가 올바르지 않습니다.'));
  if (!Number.isInteger(row.shippedBoxes) || row.shippedBoxes <= 0) issues.push(legacyIssue('SHIPPED_BOXES_INVALID', 'shippedBoxes', '박스 수량은 1 이상의 정수여야 합니다.'));
  if (row.notes !== null && row.notes.length > 1_000) issues.push(legacyIssue('TOO_LONG', 'notes', '특이사항은 1,000자 이하여야 합니다.'));
  if ((row.latitude === null) !== (row.longitude === null)) issues.push(legacyIssue('LOCATION_INCOMPLETE', 'row', '위도와 경도는 함께 입력해야 합니다.'));
  if (row.latitude !== null && (row.latitude < -90 || row.latitude > 90)) issues.push(legacyIssue('LATITUDE_INVALID', 'latitude', '위도 범위가 올바르지 않습니다.'));
  if (row.longitude !== null && (row.longitude < -180 || row.longitude > 180)) issues.push(legacyIssue('LONGITUDE_INVALID', 'longitude', '경도 범위가 올바르지 않습니다.'));
  return issues;
}

function legacyIssue(
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
