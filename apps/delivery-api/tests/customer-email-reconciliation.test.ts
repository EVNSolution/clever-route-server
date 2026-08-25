import { describe, expect, test } from 'vitest';

import {
  CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
  CustomerEmailReconciliationRefusalError,
  CustomerEmailReconciliationService,
  sha256CanonicalJson,
  type CustomerEmailReconciliationApplyResult,
  type CustomerEmailReconciliationInspection,
  type CustomerEmailReconciliationManifest,
  type CustomerEmailReconciliationScope,
  type CustomerEmailReconciliationSelection,
  type CustomerEmailReconciliationStore
} from '../src/modules/customer-email/customer-email-reconciliation.js';

const now = new Date('2026-08-25T08:00:00.000Z');
const scope = { appId: 'clever', shopId: '81000000-0000-4000-8000-000000000001' };
const decision = { changeControlRef: 'EVNSolution/clever-change-control#265', reasonCode: 'HISTORICAL_DO_NOT_SEND' };
const operatorEvidence = { actor: 'aws-1234567890abcdef', approvalRef: 'EVNSolution/clever-change-control#265:comment-123', approvalSnapshotSha256: 'b'.repeat(64), releaseImageDigest: `ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:${'a'.repeat(64)}`, ssmCommandId: '11111111-1111-4111-8111-111111111111' };

describe('customer email reconciliation', () => {
  test('refuses any change-control reference other than the approved CC#265 contract', async () => {
    const store = new InMemoryReconciliationStore(scope, sevenFacts().slice(0, 1));
    await expect(service(store).dryRun({
      changeControlRef: 'EVNSolution/clever-change-control#999',
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      reasonCode: decision.reasonCode,
      scope,
      selections: [{ id: factId(1), kind: 'FACT' }]
    })).rejects.toMatchObject({ code: 'CHANGE_CONTROL_REF_INVALID' });
    expect(store.mutations).toHaveLength(0);
  });

  test('creates a seven-row PII-free dry-run manifest without mutation', async () => {
    const store = new InMemoryReconciliationStore(scope, sevenFacts());
    const result = await service(store).dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: sevenFacts().map(({ id, kind }) => ({ id, kind }))
    });

    expect(result).toMatchObject({ mode: 'dry-run', mutationCount: 0 });
    expect(result.manifest.items).toHaveLength(7);
    expect(store.mutations).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/recipient|subject|body|customer@example\.com|Secret delivery text/iu);
  });

  test('refuses a manifest when a selected row changed after review', async () => {
    const store = new InMemoryReconciliationStore(scope, sevenFacts().slice(0, 1));
    const dryRun = await service(store).dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: [{ id: factId(1), kind: 'FACT' }]
    });
    store.change(factId(1));

    await expect(service(store).apply({
      operatorEvidence,
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      expectedScope: scope,
      manifest: dryRun.manifest,
      reviewedManifestSha256: dryRun.manifestSha256
    })).rejects.toMatchObject({ code: 'CHANGED_SINCE_MANIFEST' });
    expect(store.mutations).toHaveLength(0);
  });

  test.each([
    ['ALREADY_SUCCEEDED', 'ALREADY_SUCCEEDED'],
    ['ACTIVELY_LEASED', 'ACTIVELY_LEASED']
  ] as const)('refuses %s rows before producing an applyable manifest', async (eligibilityCode, expectedCode) => {
    const store = new InMemoryReconciliationStore(scope, [{
      eligibilityCode,
      id: factId(1),
      kind: 'FACT',
      pii: 'customer@example.com',
      stateVersion: 1,
      updatedAt: now.toISOString()
    }]);

    await expect(service(store).dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: [{ id: factId(1), kind: 'FACT' }]
    })).rejects.toMatchObject({ code: expectedCode });
  });

  test('applies do-not-send once, repeats idempotently, and records the explicit actor without PII', async () => {
    const store = new InMemoryReconciliationStore(scope, sevenFacts().slice(0, 1));
    const reconciliation = service(store);
    const dryRun = await reconciliation.dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: [{ id: factId(1), kind: 'FACT' }]
    });
    const input: Parameters<CustomerEmailReconciliationService['apply']>[0] = {
      operatorEvidence,
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      expectedScope: scope,
      manifest: dryRun.manifest,
      reviewedManifestSha256: dryRun.manifestSha256
    };

    await expect(reconciliation.apply(input)).resolves.toMatchObject({ appliedItems: 1, alreadyAppliedItems: 0, auditRows: 1 });
    await expect(reconciliation.apply(input)).resolves.toMatchObject({ appliedItems: 0, alreadyAppliedItems: 1, auditRows: 0 });
    expect(store.mutations).toHaveLength(1);
    expect(store.audits).toEqual([{ actor: operatorEvidence.actor, disposition: 'DO_NOT_SEND', manifestSha256: dryRun.manifestSha256 }]);
    expect(JSON.stringify({ audits: store.audits, result: await reconciliation.apply(input) }))
      .not.toMatch(/customer@example\.com|Secret delivery text|recipient|subject|body/iu);
  });

  test('requires a reviewed manifest hash, PII-free actor token, exact scope, and the only supported disposition', async () => {
    const store = new InMemoryReconciliationStore(scope, sevenFacts().slice(0, 1));
    const reconciliation = service(store);
    const dryRun = await reconciliation.dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: [{ id: factId(1), kind: 'FACT' }]
    });
    await expect(reconciliation.apply({
      operatorEvidence: { ...operatorEvidence, actor: 'operator@example.com' },
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      expectedScope: scope,
      manifest: dryRun.manifest,
      reviewedManifestSha256: dryRun.manifestSha256
    })).rejects.toMatchObject({ code: 'ACTOR_INVALID' });
    await expect(reconciliation.apply({
      operatorEvidence,
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      expectedScope: { ...scope, shopId: '81000000-0000-4000-8000-000000000002' },
      manifest: dryRun.manifest,
      reviewedManifestSha256: dryRun.manifestSha256
    })).rejects.toMatchObject({ code: 'WRONG_SCOPE' });
    await expect(reconciliation.apply({
      operatorEvidence,
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      expectedScope: scope,
      manifest: dryRun.manifest,
      reviewedManifestSha256: '0'.repeat(64)
    })).rejects.toMatchObject({ code: 'REVIEWED_MANIFEST_SHA256_MISMATCH' });
  });

  test('refuses batches above the guarded fact-only limit before querying storage', async () => {
    const store = new InMemoryReconciliationStore(scope, []);
    await expect(service(store).dryRun({
      ...decision,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      scope,
      selections: Array.from({ length: 101 }, (_, index) => ({ id: factId(index + 1), kind: 'FACT' }))
    })).rejects.toMatchObject({ code: 'BATCH_LIMIT_EXCEEDED' });
  });
});

type InMemoryRow = CustomerEmailReconciliationSelection & {
  appliedManifestSha256?: string;
  eligibilityCode: string | null;
  pii: string;
  stateVersion: number;
  updatedAt: string;
};

class InMemoryReconciliationStore implements CustomerEmailReconciliationStore {
  readonly audits: Array<{ actor: string; disposition: string; manifestSha256: string }> = [];
  readonly mutations: string[] = [];
  private readonly rows: Map<string, InMemoryRow>;

  constructor(
    private readonly scope: CustomerEmailReconciliationScope,
    rows: InMemoryRow[]
  ) {
    this.rows = new Map(rows.map((row) => [key(row), row]));
  }

  change(id: string): void {
    const row = this.rows.get(`FACT:${id}`);
    if (row === undefined) throw new Error('Missing test row');
    row.stateVersion += 1;
    row.updatedAt = new Date(now.getTime() + 1_000).toISOString();
  }

  inspect(input: {
    now: Date;
    scope: CustomerEmailReconciliationScope;
    selections: CustomerEmailReconciliationSelection[];
  }): Promise<CustomerEmailReconciliationInspection[]> {
    void input.now;
    if (input.scope.appId !== this.scope.appId || input.scope.shopId !== this.scope.shopId) {
      throw new CustomerEmailReconciliationRefusalError('WRONG_SCOPE');
    }
    return Promise.resolve(input.selections.map((selection) => {
      const row = this.rows.get(key(selection));
      if (row === undefined) throw new CustomerEmailReconciliationRefusalError('NOT_FOUND', selection);
      return inspection(row);
    }));
  }

  applyDoNotSend(input: {
    operatorEvidence: typeof operatorEvidence;
    manifest: CustomerEmailReconciliationManifest;
    manifestSha256: string;
    now: Date;
  }): Promise<CustomerEmailReconciliationApplyResult> {
    void input.now;
    let appliedItems = 0;
    let alreadyAppliedItems = 0;
    for (const manifestItem of input.manifest.items) {
      const row = this.rows.get(key(manifestItem));
      if (row === undefined) throw new CustomerEmailReconciliationRefusalError('NOT_FOUND', manifestItem);
      if (row.appliedManifestSha256 === input.manifestSha256) {
        alreadyAppliedItems += 1;
        continue;
      }
      const current = inspection(row);
      if (current.eligibilityCode !== null) throw new CustomerEmailReconciliationRefusalError(current.eligibilityCode, row);
      if (current.stateSha256 !== manifestItem.stateSha256 || current.updatedAt !== manifestItem.updatedAt) {
        throw new CustomerEmailReconciliationRefusalError('CHANGED_SINCE_MANIFEST', row);
      }
      row.appliedManifestSha256 = input.manifestSha256;
      this.mutations.push(key(row));
      this.audits.push({ actor: input.operatorEvidence.actor, disposition: input.manifest.disposition, manifestSha256: input.manifestSha256 });
      appliedItems += 1;
    }
    return Promise.resolve({
      alreadyAppliedItems,
      appliedItems,
      auditRows: appliedItems,
      disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
      manifestSha256: input.manifestSha256,
      mode: 'apply'
    });
  }
}

function service(store: CustomerEmailReconciliationStore): CustomerEmailReconciliationService {
  return new CustomerEmailReconciliationService(store, () => now);
}

function inspection(row: InMemoryRow): CustomerEmailReconciliationInspection {
  return {
    eligibilityCode: row.eligibilityCode,
    id: row.id,
    kind: row.kind,
    stateSha256: sha256CanonicalJson({ stateVersion: row.stateVersion, updatedAt: row.updatedAt }),
    updatedAt: row.updatedAt
  };
}

function sevenFacts(): InMemoryRow[] {
  return Array.from({ length: 7 }, (_, index) => ({
    eligibilityCode: null,
    id: factId(index + 1),
    kind: 'FACT',
    pii: index === 0 ? 'customer@example.com Secret delivery text' : `hidden-${index}`,
    stateVersion: 1,
    updatedAt: now.toISOString()
  }));
}

function factId(sequence: number): string {
  return `91000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
}

function key(selection: CustomerEmailReconciliationSelection): string {
  return `${selection.kind}:${selection.id}`;
}
