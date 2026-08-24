import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

export const CUSTOMER_EMAIL_RECONCILIATION_SCHEMA = 'customer_email_reconciliation_manifest_v1';
export const CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION = 'DO_NOT_SEND';

export type CustomerEmailReconciliationDisposition = typeof CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION;
export type CustomerEmailReconciliationItemKind = 'DISPATCH' | 'FACT';

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
  disposition: CustomerEmailReconciliationDisposition;
  generatedAt: string;
  items: Array<CustomerEmailReconciliationSelection & {
    stateSha256: string;
    updatedAt: string;
  }>;
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

export interface CustomerEmailReconciliationStore {
  applyDoNotSend(input: {
    actor: string;
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
    disposition: CustomerEmailReconciliationDisposition;
    scope: CustomerEmailReconciliationScope;
    selections: CustomerEmailReconciliationSelection[];
  }): Promise<{
    manifest: CustomerEmailReconciliationManifest;
    manifestSha256: string;
    mode: 'dry-run';
    mutationCount: 0;
  }> {
    assertDisposition(input.disposition);
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
      disposition: input.disposition,
      generatedAt: generatedAt.toISOString(),
      items: inspected.map(({ id, kind, stateSha256, updatedAt }) => ({ id, kind, stateSha256, updatedAt })),
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
    actor: string;
    disposition: CustomerEmailReconciliationDisposition;
    expectedScope: CustomerEmailReconciliationScope;
    manifest: CustomerEmailReconciliationManifest;
    reviewedManifestSha256: string;
  }): Promise<CustomerEmailReconciliationApplyResult> {
    assertActor(input.actor);
    assertDisposition(input.disposition);
    assertScope(input.expectedScope);
    assertManifest(input.manifest);
    if (input.manifest.disposition !== input.disposition) {
      throw new CustomerEmailReconciliationRefusalError('DISPOSITION_MISMATCH');
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
      actor: input.actor,
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
    actor: string;
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
        if (item.manifestItem.kind === 'FACT') {
          auditRows += await this.cancelFact(tx, item.manifestItem, {
            actor: input.actor,
            manifestSha256: input.manifestSha256,
            now: input.now,
            shopId: input.manifest.scope.shopId
          });
        } else {
          auditRows += await this.cancelDispatch(tx, item.manifestItem, {
            actor: input.actor,
            manifestSha256: input.manifestSha256,
            now: input.now
          });
        }
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
    return selection.kind === 'FACT'
      ? this.inspectFact(prisma, selection, scope, now)
      : this.inspectDispatch(prisma, selection, scope);
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
        id: true,
        leaseExpiresAt: true,
        leaseToken: true,
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
    const attempted = fact.attemptCount > 0 || fact.attempts.length > 0;
    const state = {
      attemptCount: fact.attemptCount,
      attemptOutcomes: fact.attempts.map(({ outcome }) => outcome).sort(),
      leaseExpiresAt: fact.leaseExpiresAt?.toISOString() ?? null,
      leasePresent: fact.leaseToken !== null,
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
            : attempted
              ? 'ALREADY_ATTEMPTED'
              : fact.status !== 'QUEUED'
                ? 'NOT_PENDING'
                : null,
      stateSha256: sha256CanonicalJson(state),
      updatedAt: fact.updatedAt.toISOString()
    };
  }

  private async inspectDispatch(
    prisma: ReconciliationPrisma,
    selection: CustomerEmailReconciliationSelection,
    scope: CustomerEmailReconciliationScope
  ): Promise<CustomerEmailReconciliationInspection> {
    const dispatch = await prisma.customerEmailManualDispatch.findUnique({
      select: {
        id: true,
        recipients: {
          orderBy: { id: 'asc' },
          select: {
            attempts: { select: { outcome: true } },
            errorCode: true,
            id: true,
            provider: true,
            providerMessageId: true,
            sentAt: true,
            status: true,
            updatedAt: true
          }
        },
        shop: { select: { appId: true } },
        shopId: true,
        updatedAt: true
      },
      where: { id: selection.id }
    });
    if (dispatch === null) throw new CustomerEmailReconciliationRefusalError('NOT_FOUND', selection);
    const wrongScope = dispatch.shopId !== scope.shopId || dispatch.shop.appId !== scope.appId;
    const succeeded = dispatch.recipients.some((recipient) =>
      recipient.status === 'SENT' || recipient.sentAt !== null || recipient.providerMessageId !== null
      || recipient.attempts.some(({ outcome }) => outcome === 'SENT'));
    const attempted = dispatch.recipients.some((recipient) =>
      recipient.status === 'FAILED' || recipient.provider !== null || recipient.attempts.length > 0);
    const pending = dispatch.recipients.length > 0 && dispatch.recipients.every(({ status }) => status === 'PENDING');
    const state = {
      recipients: dispatch.recipients.map((recipient) => ({
        attemptOutcomes: recipient.attempts.map(({ outcome }) => outcome).sort(),
        id: recipient.id,
        providerPresent: recipient.provider !== null,
        providerResultPresent: recipient.providerMessageId !== null,
        sent: recipient.sentAt !== null,
        status: recipient.status,
        updatedAt: recipient.updatedAt.toISOString()
      })),
      updatedAt: dispatch.updatedAt.toISOString()
    };
    return {
      ...selection,
      eligibilityCode: wrongScope
        ? 'WRONG_SCOPE'
        : succeeded
          ? 'ALREADY_SUCCEEDED'
          : attempted
            ? 'ALREADY_ATTEMPTED'
            : !pending
              ? 'NOT_PENDING'
              : null,
      stateSha256: sha256CanonicalJson(state),
      updatedAt: dispatch.updatedAt.toISOString()
    };
  }

  private async cancelFact(
    tx: Prisma.TransactionClient,
    item: CustomerEmailReconciliationManifest['items'][number],
    input: { actor: string; manifestSha256: string; now: Date; shopId: string }
  ): Promise<number> {
    const updated = await tx.customerRouteNotificationFact.updateMany({
      data: {
        deadAt: input.now,
        errorCode: 'OPERATOR_DO_NOT_SEND',
        errorMessage: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        processingStartedAt: null,
        provider: 'operator-reconciliation',
        providerMessageId: null,
        recipientEmailSnapshot: null,
        status: 'DEAD'
      },
      where: {
        attemptCount: 0,
        id: item.id,
        leaseToken: null,
        sentAt: null,
        shopId: input.shopId,
        status: 'QUEUED',
        updatedAt: new Date(item.updatedAt)
      }
    });
    if (updated.count !== 1) throw new CustomerEmailReconciliationRefusalError('CHANGED_SINCE_MANIFEST', item);
    await tx.customerDeliveryNotificationAttempt.create({
      data: reconciliationAuditData({
        actor: input.actor,
        factId: item.id,
        item,
        manifestSha256: input.manifestSha256,
        now: input.now,
        shopId: input.shopId
      })
    });
    return 1;
  }

  private async cancelDispatch(
    tx: Prisma.TransactionClient,
    item: CustomerEmailReconciliationManifest['items'][number],
    input: { actor: string; manifestSha256: string; now: Date }
  ): Promise<number> {
    const dispatch = await tx.customerEmailManualDispatch.findUnique({
      select: {
        recipients: { orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } },
        shopId: true
      },
      where: { id: item.id }
    });
    if (dispatch === null) throw new CustomerEmailReconciliationRefusalError('NOT_FOUND', item);
    let auditRows = 0;
    for (const recipient of dispatch.recipients) {
      const updated = await tx.customerEmailManualDispatchRecipient.updateMany({
        data: {
          errorCode: 'OPERATOR_DO_NOT_SEND',
          errorMessage: null,
          provider: null,
          providerMessageId: null,
          recipientEmail: null,
          renderedBody: null,
          renderedSubject: null,
          status: 'SKIPPED'
        },
        where: {
          dispatchId: item.id,
          id: recipient.id,
          providerMessageId: null,
          sentAt: null,
          shopId: dispatch.shopId,
          status: 'PENDING',
          updatedAt: recipient.updatedAt
        }
      });
      if (updated.count !== 1) throw new CustomerEmailReconciliationRefusalError('CHANGED_SINCE_MANIFEST', item);
      await tx.customerDeliveryNotificationAttempt.create({
        data: reconciliationAuditData({
          actor: input.actor,
          item,
          manifestSha256: input.manifestSha256,
          manualDispatchRecipientId: recipient.id,
          now: input.now,
          shopId: dispatch.shopId
        })
      });
      auditRows += 1;
    }
    return auditRows;
  }

  private async wasAlreadyApplied(
    tx: Prisma.TransactionClient,
    selection: CustomerEmailReconciliationSelection,
    manifestSha256: string
  ): Promise<boolean> {
    const correlationId = reconciliationCorrelationId(manifestSha256, selection);
    if (selection.kind === 'FACT') {
      const [fact, audit] = await Promise.all([
        tx.customerRouteNotificationFact.findUnique({
          select: { errorCode: true, status: true },
          where: { id: selection.id }
        }),
        tx.customerDeliveryNotificationAttempt.findFirst({
          select: { id: true },
          where: { correlationId, errorCode: 'OPERATOR_DO_NOT_SEND', factId: selection.id, outcome: 'TERMINAL_FAILURE' }
        })
      ]);
      return fact?.status === 'DEAD' && fact.errorCode === 'OPERATOR_DO_NOT_SEND' && audit !== null;
    }
    const dispatch = await tx.customerEmailManualDispatch.findUnique({
      select: {
        recipients: {
          select: {
            attempts: { select: { id: true }, where: { correlationId, errorCode: 'OPERATOR_DO_NOT_SEND', outcome: 'TERMINAL_FAILURE' } },
            errorCode: true,
            status: true
          }
        }
      },
      where: { id: selection.id }
    });
    return dispatch !== null && dispatch.recipients.length > 0 && dispatch.recipients.every((recipient) =>
      recipient.status === 'SKIPPED' && recipient.errorCode === 'OPERATOR_DO_NOT_SEND' && recipient.attempts.length === 1);
  }
}

function reconciliationAuditData(input: {
  actor: string;
  factId?: string;
  item: CustomerEmailReconciliationSelection;
  manifestSha256: string;
  manualDispatchRecipientId?: string;
  now: Date;
  shopId: string;
}): Prisma.CustomerDeliveryNotificationAttemptUncheckedCreateInput {
  return {
    attemptNumber: 1,
    completedAt: input.now,
    correlationId: reconciliationCorrelationId(input.manifestSha256, input.item),
    errorCode: 'OPERATOR_DO_NOT_SEND',
    ...(input.factId === undefined ? {} : { factId: input.factId }),
    ...(input.manualDispatchRecipientId === undefined ? {} : { manualDispatchRecipientId: input.manualDispatchRecipientId }),
    outcome: 'TERMINAL_FAILURE',
    provider: `operator-reconciliation/${input.actor}`,
    retainedUntil: new Date(input.now.getTime() + 180 * 24 * 60 * 60 * 1000),
    shopId: input.shopId,
    startedAt: input.now
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
    || value.disposition !== CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION
    || typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))
    || !isRecord(value.scope) || typeof value.scope.appId !== 'string' || typeof value.scope.shopId !== 'string'
    || !Array.isArray(value.items) || value.items.length === 0) {
    throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || (item.kind !== 'FACT' && item.kind !== 'DISPATCH')
      || typeof item.id !== 'string' || !isUuid(item.id)
      || typeof item.stateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.stateSha256)
      || typeof item.updatedAt !== 'string' || Number.isNaN(Date.parse(item.updatedAt))) {
      throw new CustomerEmailReconciliationRefusalError('MANIFEST_INVALID');
    }
    const kind: CustomerEmailReconciliationItemKind = item.kind;
    return { id: item.id, kind, stateSha256: item.stateSha256, updatedAt: item.updatedAt };
  });
  const manifest: CustomerEmailReconciliationManifest = {
    disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
    generatedAt: value.generatedAt,
    items,
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
  const canonical = selections.map((selection) => {
    if ((selection.kind !== 'FACT' && selection.kind !== 'DISPATCH') || !isUuid(selection.id)) {
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
