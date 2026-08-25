import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

export const CUSTOMER_EMAIL_RECONCILIATION_SCHEMA = 'customer_email_reconciliation_manifest_v1';
export const CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION = 'DO_NOT_SEND';

export type CustomerEmailReconciliationDisposition = typeof CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION;
export type CustomerEmailReconciliationItemKind = 'FACT';
export const CUSTOMER_EMAIL_RECONCILIATION_MAX_BATCH = 100;

export type CustomerEmailReconciliationScope = {
  appId: string;
  shopId: string;
};

export type CustomerEmailReconciliationSelection = {
  id: string;
  kind: CustomerEmailReconciliationItemKind;
};

export type CustomerEmailReconciliationInspection = CustomerEmailReconciliationSelection & {
  eligibilityCode: string | null;
  stateSha256: string;
  updatedAt: string;
};

export type CustomerEmailReconciliationManifest = {
  changeControlRef: string;
  disposition: CustomerEmailReconciliationDisposition;
  generatedAt: string;
  items: Array<CustomerEmailReconciliationSelection & {
    stateSha256: string;
    updatedAt: string;
  }>;
  reasonCode: string;
  schema: typeof CUSTOMER_EMAIL_RECONCILIATION_SCHEMA;
  scope: CustomerEmailReconciliationScope;
};

export type CustomerEmailReconciliationApplyResult = {
  alreadyAppliedItems: number;
  appliedItems: number;
  auditRows: number;
  disposition: CustomerEmailReconciliationDisposition;
  manifestSha256: string;
  mode: 'apply';
};

export type CustomerEmailOperatorEvidence = {
  actor: string;
  approvalRef: string;
  approvalSnapshotSha256: string;
  releaseImageDigest: string;
  ssmCommandId: string;
};

export interface CustomerEmailReconciliationStore {
  applyDoNotSend(input: {
    operatorEvidence: CustomerEmailOperatorEvidence;
    manifest: CustomerEmailReconciliationManifest;
    manifestSha256: string;
    now: Date;
  }): Promise<CustomerEmailReconciliationApplyResult>;
  inspect(input: {
    now: Date;
    scope: CustomerEmailReconciliationScope;
    selections: CustomerEmailReconciliationSelection[];
  }): Promise<CustomerEmailReconciliationInspection[]>;
}

export class CustomerEmailReconciliationRefusalError extends Error {
  constructor(
    readonly code: string,
    readonly item?: CustomerEmailReconciliationSelection
  ) {
    super(item === undefined ? code : `${code}:${item.kind}:${item.id}`);
    this.name = 'CustomerEmailReconciliationRefusalError';
  }
}

export class CustomerEmailReconciliationService {
  constructor(
    private readonly store: CustomerEmailReconciliationStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async dryRun(input: {
    changeControlRef: string;
    disposition: CustomerEmailReconciliationDisposition;
    reasonCode: string;
    scope: CustomerEmailReconciliationScope;
    selections: CustomerEmailReconciliationSelection[];
  }): Promise<{
    manifest: CustomerEmailReconciliationManifest;
    manifestSha256: string;
    mode: 'dry-run';
    mutationCount: 0;
  }> {
    assertDisposition(input.disposition);
    assertDecisionBinding(input.changeControlRef, input.reasonCode);
    assertScope(input.scope);
    const selections = normalizeSelections(input.selections);
    const generatedAt = this.now();
    const inspected = await this.store.inspect({ now: generatedAt, scope: input.scope, selections });
    if (inspected.length !== selections.length) throw new CustomerEmailReconciliationRefusalError('SELECTION_INCOMPLETE');
    for (const item of inspected) {
      if (item.eligibilityCode !== null) {
        throw new CustomerEmailReconciliationRefusalError(item.eligibilityCode, item);
      }
    }
    const manifest: CustomerEmailReconciliationManifest = {
      changeControlRef: input.changeControlRef,
      disposition: input.disposition,
      generatedAt: generatedAt.toISOString(),
      items: inspected.map(({ id, kind, stateSha256, updatedAt }) => ({ id, kind, stateSha256, updatedAt })),
      reasonCode: input.reasonCode,
      schema: CUSTOMER_EMAIL_RECONCILIATION_SCHEMA,
      scope: input.scope
    };
    return {
      manifest,
      manifestSha256: sha256CanonicalJson(manifest),
      mode: 'dry-run',
      mutationCount: 0
    };
  }

  async apply(input: {
    operatorEvidence: CustomerEmailOperatorEvidence;
    changeControlRef: string;
    disposition: CustomerEmailReconciliationDisposition;
    expectedScope: CustomerEmailReconciliationScope;
    manifest: CustomerEmailReconciliationManifest;
    reasonCode: string;
    reviewedManifestSha256: string;
  }): Promise<CustomerEmailReconciliationApplyResult> {
    assertOperatorEvidence(input.operatorEvidence, input.changeControlRef);
    assertDecisionBinding(input.changeControlRef, input.reasonCode);
    assertDisposition(input.disposition);
    assertScope(input.expectedScope);
    assertManifest(input.manifest);
    if (input.manifest.disposition !== input.disposition) {
      throw new CustomerEmailReconciliationRefusalError('DISPOSITION_MISMATCH');
    }
    if (input.manifest.changeControlRef !== input.changeControlRef || input.manifest.reasonCode !== input.reasonCode) {
      throw new CustomerEmailReconciliationRefusalError('DECISION_BINDING_MISMATCH');
    }
    if (input.manifest.scope.appId !== input.expectedScope.appId || input.manifest.scope.shopId !== input.expectedScope.shopId) {
      throw new CustomerEmailReconciliationRefusalError('WRONG_SCOPE');
    }
    if (!/^[a-f0-9]{64}$/u.test(input.reviewedManifestSha256)) {
      throw new CustomerEmailReconciliationRefusalError('REVIEWED_MANIFEST_SHA256_INVALID');
    }
    const manifestSha256 = sha256CanonicalJson(input.manifest);
    if (manifestSha256 !== input.reviewedManifestSha256) {
      throw new CustomerEmailReconciliationRefusalError('REVIEWED_MANIFEST_SHA256_MISMATCH');
    }
    return this.store.applyDoNotSend({
      operatorEvidence: input.operatorEvidence,
      manifest: input.manifest,
      manifestSha256,
      now: this.now()
    });
  }
}

type ReconciliationPrisma = PrismaClient | Prisma.TransactionClient;

export class PrismaCustomerEmailReconciliationStore implements CustomerEmailReconciliationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(input: {
    now: Date;
    scope: CustomerEmailReconciliationScope;
    selections: CustomerEmailReconciliationSelection[];
  }): Promise<CustomerEmailReconciliationInspection[]> {
    return Promise.all(input.selections.map((selection) => this.inspectOne(this.prisma, selection, input.scope, input.now)));
  }

  async applyDoNotSend(input: {
    operatorEvidence: CustomerEmailOperatorEvidence;
    manifest: CustomerEmailReconciliationManifest;
    manifestSha256: string;
    now: Date;
  }): Promise<CustomerEmailReconciliationApplyResult> {
    return this.prisma.$transaction(async (tx) => {
      const planned: Array<{
        alreadyApplied: boolean;
        inspection: CustomerEmailReconciliationInspection;
        manifestItem: CustomerEmailReconciliationManifest['items'][number];
      }> = [];
      for (const manifestItem of input.manifest.items) {
        const selection = { id: manifestItem.id, kind: manifestItem.kind };
        if (await this.wasAlreadyApplied(tx, selection, input.manifestSha256)) {
          planned.push({
            alreadyApplied: true,
            inspection: { ...selection, eligibilityCode: null, stateSha256: manifestItem.stateSha256, updatedAt: manifestItem.updatedAt },
            manifestItem
          });
          continue;
        }
        const inspection = await this.inspectOne(tx, selection, input.manifest.scope, input.now);
        if (inspection.eligibilityCode !== null) {
          throw new CustomerEmailReconciliationRefusalError(inspection.eligibilityCode, selection);
        }
        if (inspection.stateSha256 !== manifestItem.stateSha256 || inspection.updatedAt !== manifestItem.updatedAt) {
          throw new CustomerEmailReconciliationRefusalError('CHANGED_SINCE_MANIFEST', selection);
        }
        planned.push({ alreadyApplied: false, inspection, manifestItem });
      }

      let appliedItems = 0;
      let alreadyAppliedItems = 0;
      let auditRows = 0;
      for (const item of planned) {
        if (item.alreadyApplied) {
          alreadyAppliedItems += 1;
          continue;
        }
        auditRows += await this.cancelFact(tx, item.manifestItem, {
          operatorEvidence: input.operatorEvidence,
          changeControlRef: input.manifest.changeControlRef,
          manifestSha256: input.manifestSha256,
          now: input.now,
          reasonCode: input.manifest.reasonCode,
          shopId: input.manifest.scope.shopId
        });
        appliedItems += 1;
      }
      return {
        alreadyAppliedItems,
        appliedItems,
        auditRows,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        manifestSha256: input.manifestSha256,
        mode: 'apply'
      };
    }, { isolationLevel: 'Serializable' });
  }

  private async inspectOne(
    prisma: ReconciliationPrisma,
    selection: CustomerEmailReconciliationSelection,
    scope: CustomerEmailReconciliationScope,
    now: Date
  ): Promise<CustomerEmailReconciliationInspection> {
    return this.inspectFact(prisma, selection, scope, now);
  }

  private async inspectFact(
    prisma: ReconciliationPrisma,
    selection: CustomerEmailReconciliationSelection,
    scope: CustomerEmailReconciliationScope,
    now: Date
  ): Promise<CustomerEmailReconciliationInspection> {
    const fact = await prisma.customerRouteNotificationFact.findUnique({
      select: {
        attemptCount: true,
        attempts: { select: { outcome: true } },
        deadAt: true,
        errorCode: true,
        errorMessage: true,
        id: true,
        leaseExpiresAt: true,
        leaseToken: true,
        processingStartedAt: true,
        provider: true,
        providerMessageId: true,
        sentAt: true,
        shop: { select: { appId: true } },
        shopId: true,
        status: true,
        updatedAt: true
      },
      where: { id: selection.id }
    });
    if (fact === null) throw new CustomerEmailReconciliationRefusalError('NOT_FOUND', selection);
    const wrongScope = fact.shopId !== scope.shopId || fact.shop.appId !== scope.appId;
    const succeeded = fact.status === 'SENT' || fact.sentAt !== null || fact.attempts.some(({ outcome }) => outcome === 'SENT');
    const activeLease = fact.leaseToken !== null && fact.leaseExpiresAt !== null && fact.leaseExpiresAt > now;
    const claimEvidence = fact.leaseToken !== null || fact.leaseExpiresAt !== null || fact.processingStartedAt !== null;
    const attempted = fact.attemptCount > 0 || fact.attempts.length > 0 || fact.provider !== null
      || fact.providerMessageId !== null || fact.errorCode !== null || fact.errorMessage !== null || fact.deadAt !== null;
    const state = {
      attemptCount: fact.attemptCount,
      attemptOutcomes: fact.attempts.map(({ outcome }) => outcome).sort(),
      dead: fact.deadAt !== null,
      errorCodePresent: fact.errorCode !== null,
      errorMessagePresent: fact.errorMessage !== null,
      leaseExpiresAt: fact.leaseExpiresAt?.toISOString() ?? null,
      leasePresent: fact.leaseToken !== null,
      processingStarted: fact.processingStartedAt !== null,
      providerPresent: fact.provider !== null,
      providerResultPresent: fact.providerMessageId !== null,
      sent: fact.sentAt !== null,
      status: fact.status,
      updatedAt: fact.updatedAt.toISOString()
    };
    return {
      ...selection,
      eligibilityCode: wrongScope
        ? 'WRONG_SCOPE'
        : succeeded
          ? 'ALREADY_SUCCEEDED'
          : activeLease
            ? 'ACTIVELY_LEASED'
            : claimEvidence
              ? 'CLAIM_EVIDENCE_PRESENT'
              : attempted
                ? 'ALREADY_ATTEMPTED'
                : fact.status !== 'QUEUED'
                  ? 'NOT_PENDING'
                  : null,
      stateSha256: sha256CanonicalJson(state),
      updatedAt: fact.updatedAt.toISOString()
    };
  }

  private async cancelFact(
    tx: Prisma.TransactionClient,
    item: CustomerEmailReconciliationManifest['items'][number],
    input: { operatorEvidence: CustomerEmailOperatorEvidence; changeControlRef: string; manifestSha256: string; now: Date; reasonCode: string; shopId: string }
  ): Promise<number> {
    const updated = await tx.customerRouteNotificationFact.updateMany({
      data: {
        deadAt: input.now,
        errorCode: 'OPERATOR_DO_NOT_SEND',
        errorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        metadata: Prisma.DbNull,
        nextAttemptAt: null,
        processingStartedAt: null,
        provider: null,
        providerMessageId: null,
        recipientEmailSnapshot: null,
        status: 'DEAD'
      },
      where: {
        attemptCount: 0,
        deadAt: null,
        errorCode: null,
        errorMessage: null,
        id: item.id,
        leaseExpiresAt: null,
        leaseToken: null,
        processingStartedAt: null,
        provider: null,
        providerMessageId: null,
        sentAt: null,
        shopId: input.shopId,
        status: 'QUEUED',
        updatedAt: new Date(item.updatedAt)
      }
    });
    if (updated.count !== 1) throw new CustomerEmailReconciliationRefusalError('CHANGED_SINCE_MANIFEST', item);
    await tx.customerEmailOperatorReconciliation.create({
      data: reconciliationAuditData({
        operatorEvidence: input.operatorEvidence,
        changeControlRef: input.changeControlRef,
        item,
        manifestSha256: input.manifestSha256,
        now: input.now,
        reasonCode: input.reasonCode,
        shopId: input.shopId
      })
    });
    await tx.customerEmailReconciliationTombstone.create({
      data: reconciliationTombstoneData({
        item,
        changeControlRef: input.changeControlRef,
        manifestSha256: input.manifestSha256,
        reasonCode: input.reasonCode,
        shopId: input.shopId
      })
    });
    return 1;
  }

  private async wasAlreadyApplied(
    tx: Prisma.TransactionClient,
    selection: CustomerEmailReconciliationSelection,
    manifestSha256: string
  ): Promise<boolean> {
    const correlationId = reconciliationCorrelationId(manifestSha256, selection);
    const tombstone = await tx.customerEmailReconciliationTombstone.findUnique({
      select: { id: true },
      where: { correlationId }
    });
    const fact = await tx.customerRouteNotificationFact.findUnique({
      select: { errorCode: true, status: true },
      where: { id: selection.id }
    });
    return fact?.status === 'DEAD' && fact.errorCode === 'OPERATOR_DO_NOT_SEND' && tombstone !== null;
  }
}

function reconciliationAuditData(input: {
  operatorEvidence: CustomerEmailOperatorEvidence;
  changeControlRef: string;
  item: CustomerEmailReconciliationSelection;
  manifestSha256: string;
  now: Date;
  reasonCode: string;
  shopId: string;
}): Prisma.CustomerEmailOperatorReconciliationUncheckedCreateInput {
  return {
    actor: input.operatorEvidence.actor,
    approvalRef: input.operatorEvidence.approvalRef,
    approvalSnapshotSha256: input.operatorEvidence.approvalSnapshotSha256,
    changeControlRef: input.changeControlRef,
    correlationId: reconciliationCorrelationId(input.manifestSha256, input.item),
    disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
    manifestSha256: input.manifestSha256,
    reasonCode: input.reasonCode,
    releaseImageDigest: input.operatorEvidence.releaseImageDigest,
    retainedUntil: new Date(input.now.getTime() + 180 * 24 * 60 * 60 * 1000),
    shopId: input.shopId,
    targetId: input.item.id,
    targetKind: input.item.kind,
    ssmCommandId: input.operatorEvidence.ssmCommandId
  };
}

function reconciliationTombstoneData(input: {
  changeControlRef: string;
  item: CustomerEmailReconciliationSelection;
  manifestSha256: string;
  reasonCode: string;
  shopId: string;
}): Prisma.CustomerEmailReconciliationTombstoneUncheckedCreateInput {
  return {
    changeControlRef: input.changeControlRef,
    correlationId: reconciliationCorrelationId(input.manifestSha256, input.item),
    disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
    manifestSha256: input.manifestSha256,
    reasonCode: input.reasonCode,
    shopId: input.shopId,
    targetId: input.item.id
  };
}

function reconciliationCorrelationId(
  manifestSha256: string,
  item: CustomerEmailReconciliationSelection
): string {
  return `email-reconciliation:${manifestSha256}:${item.kind}:${item.id}`;
}

export function parseCustomerEmailReconciliationManifest(value: unknown): CustomerEmailReconciliationManifest {
  if (!isRecord(value) || value.schema !== CUSTOMER_EMAIL_RECONCILIATION_SCHEMA
    || typeof value.changeControlRef !== 'string' || typeof value.reasonCode !== 'string'
    || value.disposition !== CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION
    || typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))
    || !isRecord(value.scope) || typeof value.scope.appId !== 'string' || typeof value.scope.shopId !== 'string'
    || !Array.isArray(value.items) || value.items.length === 0) {
    throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || item.kind !== 'FACT'
      || typeof item.id !== 'string' || !isUuid(item.id)
      || typeof item.stateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.stateSha256)
      || typeof item.updatedAt !== 'string' || Number.isNaN(Date.parse(item.updatedAt))) {
      throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
    }
    const kind: CustomerEmailReconciliationItemKind = item.kind;
    return { id: item.id, kind, stateSha256: item.stateSha256, updatedAt: item.updatedAt };
  });
  const manifest: CustomerEmailReconciliationManifest = {
    changeControlRef: value.changeControlRef,
    disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
    generatedAt: value.generatedAt,
    items,
    reasonCode: value.reasonCode,
    schema: CUSTOMER_EMAIL_RECONCILIATION_SCHEMA,
    scope: { appId: value.scope.appId, shopId: value.scope.shopId }
  };
  assertManifest(manifest);
  return manifest;
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function assertManifest(manifest: CustomerEmailReconciliationManifest): void {
  assertDecisionBinding(manifest.changeControlRef, manifest.reasonCode);
  assertScope(manifest.scope);
  assertDisposition(manifest.disposition);
  normalizeSelections(manifest.items);
  if (manifest.schema !== CUSTOMER_EMAIL_RECONCILIATION_SCHEMA || Number.isNaN(Date.parse(manifest.generatedAt))) {
    throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
  }
  for (const item of manifest.items) {
    if (!/^[a-f0-9]{64}$/u.test(item.stateSha256) || Number.isNaN(Date.parse(item.updatedAt))) {
      throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
    }
  }
}

function assertActor(actor: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]{2,79}$/u.test(actor)) {
    throw new CustomerEmailReconciliationRefusalError('ACTOR_INVALID');
  }
}

function assertOperatorEvidence(evidence: CustomerEmailOperatorEvidence, changeControlRef: string): void {
  assertActor(evidence.actor);
  if (!/^[a-f0-9-]{36}$/u.test(evidence.ssmCommandId)) throw new CustomerEmailReconciliationRefusalError('SSM_COMMAND_ID_INVALID');
  if (!/^ghcr\.io\/evnsolution\/clever-route-server-delivery-api@sha256:[a-f0-9]{64}$/u.test(evidence.releaseImageDigest)) {
    throw new CustomerEmailReconciliationRefusalError('RELEASE_IMAGE_DIGEST_INVALID');
  }
  if (evidence.approvalRef !== `${changeControlRef}:comment-${evidence.approvalRef.split(':comment-')[1] ?? ''}`
    || !/:comment-[1-9][0-9]*$/u.test(evidence.approvalRef)) {
    throw new CustomerEmailReconciliationRefusalError('APPROVAL_REF_INVALID');
  }
  if (!/^[a-f0-9]{64}$/u.test(evidence.approvalSnapshotSha256)) throw new CustomerEmailReconciliationRefusalError('APPROVAL_SNAPSHOT_INVALID');
}

function assertDecisionBinding(changeControlRef: string, reasonCode: string): void {
  if (!/^EVNSolution\/clever-change-control#[1-9][0-9]*$/u.test(changeControlRef)) {
    throw new CustomerEmailReconciliationRefusalError('CHANGE_CONTROL_REF_INVALID');
  }
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(reasonCode)) {
    throw new CustomerEmailReconciliationRefusalError('REASON_CODE_INVALID');
  }
}

function assertDisposition(disposition: string): asserts disposition is CustomerEmailReconciliationDisposition {
  if (disposition !== CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION) {
    throw new CustomerEmailReconciliationRefusalError('DISPOSITION_UNSUPPORTED');
  }
}

function assertScope(scope: CustomerEmailReconciliationScope): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(scope.appId) || !isUuid(scope.shopId)) {
    throw new CustomerEmailReconciliationRefusalError('SCOPE_INVALID');
  }
}

function normalizeSelections(selections: CustomerEmailReconciliationSelection[]): CustomerEmailReconciliationSelection[] {
  if (selections.length === 0) throw new CustomerEmailReconciliationRefusalError('EXPLICIT_SELECTION_REQUIRED');
  if (selections.length > CUSTOMER_EMAIL_RECONCILIATION_MAX_BATCH) {
    throw new CustomerEmailReconciliationRefusalError('BATCH_LIMIT_EXCEEDED');
  }
  const canonical = selections.map((selection) => {
    if (selection.kind !== 'FACT' || !isUuid(selection.id)) {
      throw new CustomerEmailReconciliationRefusalError('SELECTION_INVALID');
    }
    return { id: selection.id.toLowerCase(), kind: selection.kind };
  }).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  if (new Set(canonical.map(({ id, kind }) => `${kind}:${id}`)).size !== canonical.length) {
    throw new CustomerEmailReconciliationRefusalError('SELECTION_DUPLICATE');
  }
  return canonical;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}
