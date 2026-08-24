import { PrismaClient } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import {
  CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
  CustomerEmailReconciliationService,
  PrismaCustomerEmailReconciliationStore
} from '../src/modules/customer-email/customer-email-reconciliation.js';

const databaseUrl = process.env.EMAIL_RECONCILIATION_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const now = new Date('2026-08-25T08:00:00.000Z');
const shopId = '91000000-0000-4000-8000-000000000070';
const otherShopId = '91000000-0000-4000-8000-000000000071';

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
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: [sevenSelections[0]!]
      });
      const firstEligibleFactId = fixture.eligibleFactIds[0]!;
      const applyInput: Parameters<CustomerEmailReconciliationService['apply']>[0] = {
        actor: 'ops-cc265',
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        expectedScope: { appId: 'clever', shopId },
        manifest: oneItemManifest.manifest,
        reviewedManifestSha256: oneItemManifest.manifestSha256
      };
      await expect(service.apply(applyInput)).resolves.toMatchObject({ appliedItems: 1, alreadyAppliedItems: 0, auditRows: 1 });
      const auditAfterFirstApply = await prisma.customerDeliveryNotificationAttempt.findFirstOrThrow({
        where: { factId: firstEligibleFactId }
      });
      await expect(service.apply(applyInput)).resolves.toMatchObject({ appliedItems: 0, alreadyAppliedItems: 1, auditRows: 0 });
      expect(await prisma.customerDeliveryNotificationAttempt.findMany({ where: { factId: firstEligibleFactId } }))
        .toEqual([auditAfterFirstApply]);
      expect(await prisma.customerRouteNotificationFact.findUniqueOrThrow({ where: { id: firstEligibleFactId } }))
        .toMatchObject({ errorCode: 'OPERATOR_DO_NOT_SEND', recipientEmailSnapshot: null, status: 'DEAD' });
      expect(auditAfterFirstApply).toMatchObject({
        attemptNumber: 1,
        errorCode: 'OPERATOR_DO_NOT_SEND',
        outcome: 'TERMINAL_FAILURE',
        provider: 'operator-reconciliation/ops-cc265'
      });
      expect(JSON.stringify({
        correlationId: auditAfterFirstApply.correlationId,
        errorCode: auditAfterFirstApply.errorCode,
        outcome: auditAfterFirstApply.outcome,
        provider: auditAfterFirstApply.provider
      })).not.toMatch(/customer-70@invalid\.test|private delivery note|recipient|subject|body/iu);

      const dispatchManifest = await service.dryRun({
        disposition: CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
        scope: { appId: 'clever', shopId },
        selections: [{ id: fixture.dispatchId, kind: 'DISPATCH' }]
      });
      const dispatchApplyInput: Parameters<CustomerEmailReconciliationService['apply']>[0] = {
        ...applyInput,
        manifest: dispatchManifest.manifest,
        reviewedManifestSha256: dispatchManifest.manifestSha256
      };
      await expect(service.apply(dispatchApplyInput)).resolves.toMatchObject({ appliedItems: 1, alreadyAppliedItems: 0, auditRows: 2 });
      await expect(service.apply(dispatchApplyInput)).resolves.toMatchObject({ appliedItems: 0, alreadyAppliedItems: 1, auditRows: 0 });
      const reconciledRecipients = await prisma.customerEmailManualDispatchRecipient.findMany({
        orderBy: { id: 'asc' },
        where: { dispatchId: fixture.dispatchId }
      });
      expect(reconciledRecipients).toMatchObject(fixture.dispatchRecipientIds.sort().map((id) => ({
        errorCode: 'OPERATOR_DO_NOT_SEND',
        id,
        recipientEmail: null,
        renderedBody: null,
        renderedSubject: null,
        status: 'SKIPPED'
      })));
      expect(await prisma.customerDeliveryNotificationAttempt.count({
        where: { manualDispatchRecipientId: { in: fixture.dispatchRecipientIds } }
      })).toBe(2);

      const stale = await service.dryRun({
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

      await expect(service.dryRun(inputFor(fixture.succeededFactId))).rejects.toMatchObject({ code: 'ALREADY_SUCCEEDED' });
      await expect(service.dryRun(inputFor(fixture.leasedFactId))).rejects.toMatchObject({ code: 'ACTIVELY_LEASED' });
      await expect(service.dryRun(inputFor(fixture.attemptedFactId))).rejects.toMatchObject({ code: 'ALREADY_ATTEMPTED' });
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
    } finally {
      await prisma.$disconnect();
    }
  });
});

function inputFor(id: string): Parameters<CustomerEmailReconciliationService['dryRun']>[0] {
  return {
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
  await prisma.customerRouteNotificationFact.createMany({ data: [
    { id: succeededFactId, orderId: order.id, sentAt: now, shopId, source: 'TEST_RECONCILIATION', status: 'SENT' },
    { id: leasedFactId, leaseExpiresAt: new Date(now.getTime() + 60_000), leaseToken: 'active-lease', orderId: order.id, shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' },
    { attemptCount: 1, id: attemptedFactId, orderId: order.id, shopId, source: 'TEST_RECONCILIATION', status: 'QUEUED' }
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
  const dispatch = await prisma.customerEmailManualDispatch.create({
    data: {
      actor: 'fixture',
      commandId: 'email-reconciliation-dispatch',
      counts: {},
      request: {},
      routePlanId: '93000000-0000-4000-8000-000000000070',
      shopId,
      signal: 'READY',
      template: {}
    }
  });
  const dispatchRecipients = await Promise.all([1, 2].map((sequence) =>
    prisma.customerEmailManualDispatchRecipient.create({
      data: {
        dispatchId: dispatch.id,
        recipientEmail: `dispatch-${sequence}@invalid.test`,
        renderedBody: 'private dispatch body',
        renderedSubject: 'private dispatch subject',
        routePlanId: '93000000-0000-4000-8000-000000000070',
        shopId,
        status: 'PENDING'
      }
    })));
  return {
    attemptedFactId,
    dispatchId: dispatch.id,
    dispatchRecipientIds: dispatchRecipients.map(({ id }) => id),
    eligibleFactIds,
    leasedFactId,
    preexistingAttempt,
    preexistingAttemptId: preexistingAttempt.id,
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
