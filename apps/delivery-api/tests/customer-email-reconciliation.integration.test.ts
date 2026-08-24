import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
  CustomerEmailReconciliationService,
  PrismaCustomerEmailReconciliationStore
} from '../src/modules/customer-email/customer-email-reconciliation.js';
import { PrismaEmailRuntimeHealthService } from '../src/modules/customer-email/email-runtime-health.service.js';
import { cleanupRouteOperationalEvidence } from '../src/modules/operations/route-operational-evidence-retention.js';

const databaseUrl = process.env.EMAIL_RECONCILIATION_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const now = new Date('2026-08-25T08:00:00.000Z');
const shopId = '91000000-0000-4000-8000-000000000070';
const otherShopId = '91000000-0000-4000-8000-000000000071';
const decision = { changeControlRef: 'EVNSolution/clever-change-control#265', reasonCode: 'HISTORICAL_DO_NOT_SEND' };

describe('customer email reconciliation PostgreSQL contract', () => {
  live('keeps dry-run mutation-free, refuses unsafe rows, and applies one PII-free cancellation idempotently', async () => {
    assertDisposableDatabase();
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const service = new CustomerEmailReconciliationService(new PrismaCustomerEmailReconciliationStore(prisma), () => now);
    try {
      const fixture = await seed(prisma);
      const sevenSelections = fixture.eligibleFactIds.map((id) => ({ id, kind: 'FACT' as const }));
      const beforeDryRun = await prisma.customerRouteNotificationFact.findMany({
        orderBy: { id: 'asc' },
        where: { id: { in: fixture.eligibleFactIds } }
      });
      const dryRun = await service.dryRun({
        ...decision,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: sevenSelections
      });
      const afterDryRun = await prisma.customerRouteNotificationFact.findMany({
        orderBy: { id: 'asc' },
        where: { id: { in: fixture.eligibleFactIds } }
      });

      expect(dryRun).toMatchObject({ mode: 'dry-run', mutationCount: 0 });
      expect(dryRun.manifest.items).toHaveLength(7);
      expect(afterDryRun).toEqual(beforeDryRun);
      expect(await prisma.customerDeliveryNotificationAttempt.count({ where: { factId: { in: fixture.eligibleFactIds } } })).toBe(0);
      expect(JSON.stringify(dryRun)).not.toMatch(/customer-70@invalid\.test|private delivery note|recipient|subject|body/iu);

      const oneItemManifest = await service.dryRun({
        ...decision,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: [sevenSelections[0]!]
      });
      const firstEligibleFactId = fixture.eligibleFactIds[0]!;
      const applyInput: Parameters<CustomerEmailReconciliationService['apply']>[0] = {
        actor: 'ops-cc265',
        ...decision,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        expectedScope: { appId: 'clever', shopId },
        manifest: oneItemManifest.manifest,
        reviewedManifestSha256: oneItemManifest.manifestSha256
      };
      await expect(service.apply(applyInput)).resolves.toMatchObject({ appliedItems: 1, alreadyAppliedItems: 0, auditRows: 1 });
      const auditAfterFirstApply = await prisma.customerEmailOperatorReconciliation.findFirstOrThrow({ where: { targetId: firstEligibleFactId } });
      await expect(service.apply(applyInput)).resolves.toMatchObject({ appliedItems: 0, alreadyAppliedItems: 1, auditRows: 0 });
      expect(await prisma.customerEmailOperatorReconciliation.findMany({ where: { targetId: firstEligibleFactId } })).toEqual([auditAfterFirstApply]);
      expect(await prisma.customerDeliveryNotificationAttempt.count({ where: { factId: firstEligibleFactId } })).toBe(0);
      expect(await prisma.customerRouteNotificationFact.findUniqueOrThrow({ where: { id: firstEligibleFactId } }))
        .toMatchObject({ errorCode: 'OPERATOR_DO_NOT_SEND', metadata: null, provider: null, recipientEmailSnapshot: null, status: 'DEAD' });
      expect(auditAfterFirstApply).toMatchObject({
        actor: 'ops-cc265',
        disposition: 'DO_NOT_SEND',
        targetKind: 'FACT'
      });
      expect(JSON.stringify(auditAfterFirstApply)).not.toMatch(/customer-70@invalid\.test|private delivery note|recipient|subject|body/iu);
      const runtimeHealth = await new PrismaEmailRuntimeHealthService(prisma, {
        automaticSenderConfigured: true, automaticWorkerEnabled: true, manualBrevoConfigured: true
      }, undefined, () => now).get({ shopDomain: 'email-reconciliation-70.invalid' });
      expect(runtimeHealth.email.outbox).toMatchObject({ deadLetter: 0, lastErrorCode: null });
      expect(runtimeHealth.email.state, JSON.stringify(runtimeHealth.email)).toBe('HEALTHY');

      const stale = await service.dryRun({
        ...decision,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: [sevenSelections[1]!]
      });
      await prisma.customerRouteNotificationFact.update({ data: { metadata: { changed: true } }, where: { id: fixture.eligibleFactIds[1]! } });
      await expect(service.apply({
        ...applyInput,
        manifest: stale.manifest,
        reviewedManifestSha256: stale.manifestSha256
      })).rejects.toMatchObject({ code: 'CHANGED_SINCE_MANIFEST' });

      const rollbackManifest = await service.dryRun({
        ...decision,
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: [sevenSelections[3]!]
      });
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_reconciliation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_reconciliation_audit
        BEFORE INSERT ON customer_email_operator_reconciliations
        FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_audit();
      `);
      await expect(service.apply({
        ...applyInput,
        manifest: rollbackManifest.manifest,
        reviewedManifestSha256: rollbackManifest.manifestSha256
      })).rejects.toBeDefined();
      await prisma.$executeRawUnsafe('DROP TRIGGER reject_reconciliation_audit ON customer_email_operator_reconciliations');
      await prisma.$executeRawUnsafe('DROP FUNCTION reject_reconciliation_audit()');
      expect(await prisma.customerRouteNotificationFact.findUniqueOrThrow({ where: { id: fixture.eligibleFactIds[3]! } }))
        .toMatchObject({ metadata: { internalNote: 'private delivery note' }, status: 'QUEUED' });
      expect(await prisma.customerEmailReconciliationTombstone.count({ where: { targetId: fixture.eligibleFactIds[3]! } })).toBe(0);

      await expect(service.dryRun(inputFor(fixture.succeededFactId))).rejects.toMatchObject({ code: 'ALREADY_SUCCEEDED' });
      await expect(service.dryRun(inputFor(fixture.leasedFactId))).rejects.toMatchObject({ code: 'ACTIVELY_LEASED' });
      await expect(service.dryRun(inputFor(fixture.attemptedFactId))).rejects.toMatchObject({ code: 'ALREADY_ATTEMPTED' });
      await expect(service.dryRun(inputFor(fixture.providerEvidenceFactId))).rejects.toMatchObject({ code: 'ALREADY_ATTEMPTED' });
      await expect(service.dryRun(inputFor(fixture.processingEvidenceFactId))).rejects.toMatchObject({ code: 'CLAIM_EVIDENCE_PRESENT' });
      await expect(service.dryRun({
        ...inputFor(fixture.eligibleFactIds[2]!),
        scope: { appId: 'clever', shopId: otherShopId }
      })).rejects.toMatchObject({ code: 'WRONG_SCOPE' });

      const attemptAfterRefusal = await prisma.customerDeliveryNotificationAttempt.findUniqueOrThrow({
        where: { id: fixture.preexistingAttemptId }
      });
      expect(attemptAfterRefusal).toEqual(fixture.preexistingAttempt);
      const attemptColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'customer_delivery_notification_attempts'
      `;
      expect(attemptColumns.map(({ column_name }) => column_name))
        .not.toEqual(expect.arrayContaining(['recipient', 'recipientEmail', 'subject', 'body', 'errorMessage']));

      await prisma.customerEmailOperatorReconciliation.update({
        data: { retainedUntil: new Date('2026-08-24T00:00:00.000Z') },
        where: { id: auditAfterFirstApply.id }
      });
      await expect(cleanupRouteOperationalEvidence(prisma, now)).resolves.toMatchObject({ emailReconciliationAudits: 1 });
      expect(await prisma.customerEmailOperatorReconciliation.count({ where: { targetId: firstEligibleFactId } })).toBe(0);
      expect(await prisma.customerEmailReconciliationTombstone.count({ where: { targetId: firstEligibleFactId } })).toBe(1);
      await expect(service.apply(applyInput)).resolves.toMatchObject({ appliedItems: 0, alreadyAppliedItems: 1, auditRows: 0 });
    } finally {
      await prisma.$disconnect();
    }
  });
});

function inputFor(id: string): Parameters<CustomerEmailReconciliationService['dryRun']>[0] {
  return {
    ...decision,
    disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
    scope: { appId: 'clever', shopId },
    selections: [{ id, kind: 'FACT' as const }]
  };
}

async function seed(prisma: PrismaClient) {
  await prisma.shop.createMany({ data: [
    { appId: 'clever', id: shopId, shopDomain: 'email-reconciliation-70.invalid' },
    { appId: 'clever', id: otherShopId, shopDomain: 'email-reconciliation-71.invalid' }
  ] });
  const order = await prisma.order.create({
    data: {
      name: '#EMAIL-RECONCILIATION',
      rawPayload: {},
      shopId,
      shopifyOrderGid: `gid://shopify/Order/${shopId}`,
      sourceOrderId: 'email-reconciliation-order',
      sourcePlatform: 'SHOPIFY'
    }
  });
  const eligibleFactIds = Array.from({ length: 7 }, (_, index) =>
    `92000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`);
  await prisma.customerRouteNotificationFact.createMany({
    data: eligibleFactIds.map((id) => ({
      id,
      metadata: { internalNote: 'private delivery note' },
      occurredAt: now,
      orderId: order.id,
      recipientEmailSnapshot: 'customer-70@invalid.test',
      shopId,
      source: 'TEST_RECONCILIATION',
      status: 'QUEUED'
    }))
  });
  const succeededFactId = '92000000-0000-4000-8000-000000000020';
  const leasedFactId = '92000000-0000-4000-8000-000000000021';
  const attemptedFactId = '92000000-0000-4000-8000-000000000022';
  const providerEvidenceFactId = '92000000-0000-4000-8000-000000000023';
  const processingEvidenceFactId = '92000000-0000-4000-8000-000000000024';
  await prisma.customerRouteNotificationFact.createMany({ data: [
    { id: succeededFactId, occurredAt: now, orderId: order.id, sentAt: now, shopId, source: 'TEST_RECONCILIATION', status: 'SENT' },
    { id: leasedFactId, leaseExpiresAt: new Date(now.getTime() + 60_000), leaseToken: 'active-lease', occurredAt: now, orderId: order.id, shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' },
    { attemptCount: 1, id: attemptedFactId, occurredAt: now, orderId: order.id, shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' },
    { id: providerEvidenceFactId, occurredAt: now, orderId: order.id, provider: 'historical-provider', providerMessageId: 'provider-result', shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' },
    { id: processingEvidenceFactId, occurredAt: now, orderId: order.id, processingStartedAt: new Date('2026-08-24T08:00:00.000Z'), shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' }
  ] });
  const preexistingAttempt = await prisma.customerDeliveryNotificationAttempt.create({
    data: {
      attemptNumber: 1,
      correlationId: 'preexisting-immutable-attempt',
      errorCode: 'TEMPORARY_PROVIDER_FAILURE',
      factId: attemptedFactId,
      outcome: 'RETRYABLE_FAILURE',
      provider: 'fixture-provider',
      retainedUntil: new Date('2027-02-21T08:00:00.000Z'),
      shopId,
      startedAt: new Date('2026-08-24T08:00:00.000Z')
    }
  });
  return {
    attemptedFactId,
    eligibleFactIds,
    leasedFactId,
    preexistingAttempt,
    preexistingAttemptId: preexistingAttempt.id,
    processingEvidenceFactId,
    providerEvidenceFactId,
    succeededFactId
  };
}

function assertDisposableDatabase(): void {
  const standardHarness = process.env.G002_DATABASE_TARGET_CLASS === 'safe-local-g002-disposable'
    && databaseUrl.includes('127.0.0.1:55488/clever_g002');
  const isolatedHarness = process.env.EMAIL_RECONCILIATION_DATABASE_TARGET_CLASS === 'safe-local-email-reconciliation-disposable'
    && databaseUrl.includes('127.0.0.1:55498/clever_email_reconciliation');
  if (!standardHarness && !isolatedHarness) {
    throw new Error('Refusing non-disposable database');
  }
}
