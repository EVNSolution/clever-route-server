import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const servicePath = new URL('../src/modules/dsv/dsv-dispatch-import.service.ts', import.meta.url);

describe('G003 DSV dispatch import service apply contract', () => {
  test('recomputes preview from persisted rows and rejects stale client expectations', async () => {
    const source = await serviceSource();

    expect(source).toContain('const sourceRows = lockedImport.rows.map(sourceRowFromRecord)');
    expect(source).toContain('const recomputed = await this.buildPreviewForRows(tx, shop.id');
    expect(source).toContain('recomputed.sourceHash !== lockedImport.sourceHash');
    expect(source).toContain('recomputed.previewHash !== lockedImport.previewHash');
    expect(source).toContain("throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_PREVIEW_STALE')");
  });

  test('durably claims commands before canonical work and preserves replay semantics', async () => {
    const source = await serviceSource();
    const claimCallIndex = source.indexOf('const claim = await this.claimApplyCommand(shop.id, input, payloadHash)');
    const canonicalTransactionIndex = source.indexOf('return await this.prisma.$transaction', claimCallIndex);
    const claimMethodStart = source.indexOf('private async claimApplyCommand');
    const claimMethodEnd = source.indexOf('async getImport', claimMethodStart);
    const claimMethod = source.slice(claimMethodStart, claimMethodEnd);
    const canonicalTransaction = source.slice(canonicalTransactionIndex, claimMethodStart);
    const lockIndex = claimMethod.indexOf('await lockApplyCommand(tx, shopId, input.commandId)');
    const receiptLookupIndex = claimMethod.indexOf('const existingReceipt = await tx.dsvCommandReceipt.findUnique');
    const receiptCreateIndex = claimMethod.indexOf('const receipt = await tx.dsvCommandReceipt.create');

    expect(claimCallIndex).toBeGreaterThan(0);
    expect(canonicalTransactionIndex).toBeGreaterThan(claimCallIndex);
    expect(lockIndex).toBeGreaterThan(0);
    expect(receiptLookupIndex).toBeGreaterThan(lockIndex);
    expect(receiptCreateIndex).toBeGreaterThan(receiptLookupIndex);
    expect(claimMethod).toContain('shopId_commandName_commandId');
    expect(claimMethod).toContain("existingReceipt.status === 'STARTED'");
    expect(claimMethod).toContain("existingReceipt.status === 'SUCCEEDED'");
    expect(claimMethod).toContain("throw new DsvDispatchImportApplyError('COMMAND_IN_PROGRESS')");
    expect(claimMethod).toContain("throw new DsvDispatchImportApplyError('IDEMPOTENCY_PAYLOAD_MISMATCH')");
    expect(claimMethod).toContain('return { result: applied.applyResult }');
    expect(claimMethod).toContain("existingReceipt.status === 'FAILED'");
    expect(claimMethod).toContain('throw failedApplyReceiptError(existingReceipt)');
    expect(canonicalTransaction).toContain("status: 'STARTED'");
    expect(canonicalTransaction).toContain("lockedImport?.status === 'FAILED'");
    expect(canonicalTransaction).toContain("throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_NOT_READY')");
    expect(canonicalTransaction).toContain('dsvCommandReceipt.updateMany');
    expect(canonicalTransaction).toContain("status: 'SUCCEEDED'");
    expect(canonicalTransaction).not.toContain('dsvCommandReceipt.create');
  });

  test('compensates only the matching started receipt and deliberately preserves applied batches', async () => {
    const source = await serviceSource();
    const compensationStart = source.indexOf('private async recordFailedApplyAttempt');
    const compensationEnd = source.indexOf('private findShop', compensationStart);
    const compensation = source.slice(compensationStart, compensationEnd);

    expect(compensation).toContain('await lockApplyCommand(tx, shopId, input.commandId)');
    expect(compensation).toContain('await lockApplyImport(tx, shopId, input.importId)');
    expect(compensation).toContain('const failedReceipt = await tx.dsvCommandReceipt.updateMany');
    expect(compensation).toContain("where: { id: receiptId, payloadHash, shopId, status: 'STARTED' }");
    expect(compensation).toContain('if (failedReceipt.count !== 1) return');
    expect(compensation).toContain('const preserveAppliedBatch = importState.status === \'APPLIED\'');
    expect(compensation).toContain('if (!preserveAppliedBatch)');
    expect(compensation).toContain("failureCode: code, failureMessage: code, status: 'FAILED'");
    expect(compensation).toContain('preservedAppliedBatch: preserveAppliedBatch');
    expect(compensation).not.toContain('dsvCommandReceipt.create');
    expect(compensation).not.toContain('dsvCommandReceipt.upsert');
  });

  test('forces rollback-safe failure evidence for mid-transaction apply failures', async () => {
    const source = await serviceSource();

    expect(source).toContain('failAfterCanonicalRows');
    expect(source).toContain("throw new Error('G003 forced mid-transaction failure')");
    expect(source).toContain('const terminalError = normalizeApplyTransactionError(error)');
    expect(source).toContain('await this.recordFailedApplyAttempt(shop.id, input, payloadHash, claim.receiptId, terminalError)');
    expect(source).toContain('throw terminalError');
    expect(source).toContain("eventType: 'applyDispatchImportFailed'");
    expect(source).toContain("compensation: 'canonical mutation transaction rolled back'");
    expect(source).toContain('responseBodyRef: canonicalJson({ code, status: failureStatus(code) })');
    expect(source).toContain('function failedApplyReceiptError');
  });

  test('budgets max-batch transactions and maps Prisma timeouts to replayable failure evidence', async () => {
    const source = await serviceSource();

    expect(source).toContain('const defaultApplyTransactionMaxWaitMs = 20_000');
    expect(source).toContain('const defaultApplyTransactionTimeoutMs = 120_000');
    expect(source).toContain('maxWait: this.options.applyTransactionMaxWaitMs ?? defaultApplyTransactionMaxWaitMs');
    expect(source).toContain('timeout: this.options.applyTransactionTimeoutMs ?? defaultApplyTransactionTimeoutMs');
    expect(source).toContain("error.code === 'P2028'");
    expect(source).toContain("'DISPATCH_IMPORT_CANONICAL_CONFLICT'");
    expect(source).toContain('function normalizeApplyTransactionError');
    expect(source).toContain('if (error instanceof DsvDispatchImportApplyError) return error');
    expect(source).toContain("error.code === 'P2028'");
    expect(source).toContain('failureCode: code, failureMessage: code');
    expect(source).toContain("status: 'FAILED'");
  });

  test('locks import, seller orders, destination fingerprints, and condition promotion', async () => {
    const source = await serviceSource();

    expect(source).toContain('function lockApplyImport');
    expect(source).toContain('function lockApplyCommand');
    expect(source).toContain('function lockSellerOrder');
    expect(source).toContain('function lockDestinationFingerprint');
    expect(source).toContain('function lockCondition');
    expect(source.match(/pg_advisory_xact_lock/g)).toHaveLength(5);
    expect(source).toContain('dsv-apply:');
    expect(source).toContain('dsv-command:');
    expect(source).toContain('dsv-seller-order:');
    expect(source).toContain('dsv-destination:');
    expect(source).toContain('dsv-condition:');
    expect(source).toContain('const destinationFingerprints = unique(sourceRows.map((row) => addressFingerprint(row))).sort');
    expect(source).toContain('await lockDestinationFingerprint(tx, shop.id, fingerprint)');
  });

  test('creates canonical rows and assignment ownership while leaving route-plan writes for G004', async () => {
    const source = await serviceSource();

    expect(source).toContain('tx.order.upsert');
    expect(source).toContain('tx.deliveryStop.upsert');
    expect(source).toContain('tx.customer.upsert');
    expect(source).toContain('findOrCreateDestination');
    expect(source).toContain('await this.ensureDispatchGrouping(');
    expect(source).toContain('tx.routeGrouping.create');
    expect(source).toContain('tx.routeGroupingVersion.create');
    expect(source).toContain('tx.routeGroupingOrder.createMany');
    expect(source).not.toMatch(/tx\.route(?:Plan|PlanStop)\.(?:create|update|upsert|delete|deleteMany|createMany|updateMany)/u);
  });

  test('uses a physical destination fingerprint that is independent of customer identity', async () => {
    const source = await serviceSource();
    const fingerprintStart = source.indexOf('function addressFingerprint');
    const fingerprintEnd = source.indexOf('function sourceRowFromRecord', fingerprintStart);
    const fingerprint = source.slice(fingerprintStart, fingerprintEnd);

    expect(fingerprint).toContain("'address' | 'destinationName'");
    expect(fingerprint).toContain('row.destinationName');
    expect(fingerprint).toContain('row.address');
    expect(fingerprint).not.toContain('customerCode');
  });

  test('does not reactivate inactive customers during canonical apply', async () => {
    const source = await serviceSource();
    const createStart = source.indexOf('private async createNewCanonicalRows');
    const createEnd = source.indexOf('private async linkNoOpRow', createStart);
    const createCanonical = source.slice(createStart, createEnd);

    expect(createCanonical).toContain('update: {}');
    expect(createCanonical).toContain("customer.status !== 'ACTIVE'");
    expect(createCanonical).toContain("throw new DsvDispatchImportApplyError('DISPATCH_IMPORT_HAS_REVIEW_ROWS')");
    expect(createCanonical).not.toContain("update: { status: 'ACTIVE' }");
    expect(source).toContain("issue.code === 'CUSTOMER_INACTIVE'");
    expect(source).toContain("codes.includes('CUSTOMER_INACTIVE')");
  });

  test('counts distinct active ownership identities and filters terminal storage', async () => {
    const source = await serviceSource();
    const ownershipStart = source.indexOf('async function activeDeliveryOwnershipCount');
    const ownershipEnd = source.indexOf('type ApplyCanonicalLink', ownershipStart);
    const ownership = source.slice(ownershipStart, ownershipEnd);

    expect(ownership).toContain('const ownershipIdentities = new Set<string>()');
    expect(ownership).toContain('return ownershipIdentities.size');
    expect(ownership).toContain("assignmentStatus: 'ASSIGNED'");
    expect(ownership).toContain("groupingVersion: { status: 'CURRENT' }");
    expect(ownership).toContain("status: { in: ['PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'READY'] }");
    expect(ownership).not.toContain('.count(');
  });

  test('links staged candidate rows to the upserted condition provenance', async () => {
    const source = await serviceSource();

    expect(source).toContain('const candidateConditionIds = await this.persistConditionCandidates');
    expect(source).toContain('conditionId: row.conditionId ?? candidateConditionIds.get(row.normalized.conditionComparisonKey) ?? null');
    expect(source).toContain('Promise<Map<string, string>>');
    expect(source).toContain('return new Map(conditions.map((condition) => [condition.comparisonKey, condition.id]))');
  });

  test('promotes condition candidates transactionally without replacing creator provenance', async () => {
    const source = await serviceSource();
    const methodStart = source.indexOf('async createCondition');
    const methodEnd = source.indexOf('private async buildPreviewForRows', methodStart);
    const method = source.slice(methodStart, methodEnd);
    const updateStart = method.indexOf('await tx.dsvTransportCondition.update');
    const updateEnd = method.indexOf('const sourceRows', updateStart);
    const update = method.slice(updateStart, updateEnd);

    expect(method).toContain('await this.prisma.$transaction');
    expect(method).toContain('await lockCondition(tx, shop.id, comparisonKey)');
    expect(method).toContain("eventType: 'activateDsvTransportCondition'");
    expect(method).toContain('principalType: input.principal?.principalType');
    expect(method).toContain('requestId: input.principal?.requestId');
    expect(method).toContain('sourceRows');
    expect(update).not.toContain('createdBy');
    expect(update).toContain('rawValue: existing.rawValue ?? input.code');
  });

  test('blocks candidates, inactive/missing/ambiguous resources, conflicts, and update candidates before canonical writes', async () => {
    const source = await serviceSource();
    const assertApplicableIndex = source.indexOf('assertApplicable(recomputed)');
    const createCanonicalIndex = source.indexOf('this.createNewCanonicalRows');

    expect(assertApplicableIndex).toBeGreaterThan(0);
    expect(assertApplicableIndex).toBeLessThan(createCanonicalIndex);
    expect(source).toContain("DISPATCH_IMPORT_HAS_UPDATE_CANDIDATES");
    expect(source).toContain("DISPATCH_IMPORT_HAS_CONDITION_CANDIDATES");
    expect(source).toContain("DISPATCH_IMPORT_INACTIVE_CONDITION");
    expect(source).toContain("DISPATCH_IMPORT_RESOURCE_AMBIGUOUS");
    expect(source).toContain("DISPATCH_IMPORT_RESOURCE_MISSING");
    expect(source).toContain("DUPLICATE_ACTIVE_DELIVERY");
  });
});

async function serviceSource(): Promise<string> {
  return readFile(servicePath, 'utf8');
}
