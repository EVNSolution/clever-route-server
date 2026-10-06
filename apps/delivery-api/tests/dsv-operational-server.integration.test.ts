import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import { PrismaAdminDriverRepository } from '../src/modules/driver/admin-driver.repository.js';
import { PrismaDriverAuthRepository } from '../src/modules/driver/driver-auth.repository.js';
import { PrismaDsvDriverAccountLinkService } from '../src/modules/dsv/dsv-driver-account-link.service.js';
import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';
import { PrismaDsvExecutionContextService } from '../src/modules/dsv/dsv-execution-context.service.js';
import { PrismaDsvGeofenceService } from '../src/modules/dsv/dsv-geofence.service.js';
import type { DsvGeofencePolicy } from '../src/modules/dsv/dsv-geofence-policy.js';
import {
  PrismaDsvOperationalDriverNotificationService,
  type DsvOperationalNotificationSendPolicy,
} from '../src/modules/dsv/dsv-operational-driver-notification.service.js';
import {
  DSV_OPERATIONAL_DRIVER_APP_ID,
  type DsvOperationalPushProvider,
  type DsvOperationalPushResult,
} from '../src/modules/dsv/dsv-operational-driver-notification.provider.js';
import type { DsvDriverPrincipal } from '../src/modules/dsv/dsv-principal.js';
import { createDsvAdminPrincipal } from '../src/modules/dsv/dsv-principal.js';
import { PrismaDsvResourceService } from '../src/modules/dsv/dsv-resource.service.js';
import {
  PrismaDsvExecutionCommandsService,
  type DsvExecutionDriverEventPort,
} from '../src/modules/dsv/dsv-execution-commands.service.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import { PrismaUvisTelemetryRepository } from '../src/modules/uvis/uvis-telemetry.repository.js';
import { PrismaDsvDriverExecutionPrincipalResolver } from '../src/routes/dsv-execution.routes.js';
import { FakeDriverPushProvider } from './support/fake-driver-push-provider.js';

const safeTargetClass = 'safe-local-dsv-operational-disposable';
const exactDatabaseUrl = 'postgresql://dsv_operational:dsv_operational@127.0.0.1:55496/dsv_operational?schema=public';
const databaseUrl = process.env.DSV_OPERATIONAL_DATABASE_URL ?? '';
const targetClass = process.env.DSV_OPERATIONAL_DATABASE_TARGET_CLASS ?? '';
const enabled = targetClass === safeTargetClass;
const live = enabled ? describe.sequential : describe.skip;

live('DSV operational server PostgreSQL integration', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    if (
      process.env.CLEVER_RUN_DISPOSABLE_DB_TESTS !== '1'
      || databaseUrl !== exactDatabaseUrl
      || process.env.DATABASE_URL !== exactDatabaseUrl
    ) {
      throw new Error(
        `Refusing unsafe DSV operational integration target: target=${targetClass || '<missing>'} url=${databaseUrl || '<missing>'}`,
      );
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const shopId of createdShopIds.reverse()) {
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.$disconnect();
  }, 30_000);

  test('commits start receipt, two distinct events, and warning resolution as one result', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'start');
    const service = commandService(prisma);
    const input = startInput(fixture);

    const first = await service.start(input);
    const replay = await service.start(input);

    expect(first).toMatchObject({ duplicate: false, executionContextId: fixture.contextId });
    expect(replay).toEqual({ ...first, duplicate: true });
    expect(first.routeStartedEventId).not.toBe(first.pickupCompletedEventId);
    await expect(prisma.driverEvent.findMany({
      select: { clientEventId: true, eventType: true },
      where: { routePlanId: fixture.routePlanId, shopId: fixture.shopId },
    })).resolves.toEqual(expect.arrayContaining([
      { clientEventId: `dsv:${input.commandId}:pickup-completed`, eventType: 'PICKUP_COMPLETED' },
      { clientEventId: `dsv:${input.commandId}:route-started`, eventType: 'ROUTE_STARTED' },
    ]));
    await expect(prisma.dsvExecutionCommand.count({
      where: { commandId: input.commandId, commandName: 'START_EXECUTION', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderStatus: 'RESOLVED_START', startedAt: input.occurredAt });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: fixture.warningId } }))
      .resolves.toMatchObject({ businessStatus: 'RESOLVED', resolutionReason: 'ROUTE_STARTED' });
  });

  test('blocks DSV driver deletion while an active execution still references it', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-active-dsv-driver');
    await addDsvResourceProfiles(prisma, fixture);
    await expectNoImportResourceReferences(prisma, fixture);
    const before = await readResourceReferenceState(prisma, fixture);

    await expect(new PrismaDsvResourceService(prisma).deleteDriver({
      driverId: fixture.driverId,
      principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
      shopDomain: fixture.shopDomain,
    })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });

    await expect(readResourceReferenceState(prisma, fixture)).resolves.toEqual(before);
  });

  test('blocks common admin driver deletion while an active execution still references it', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-active-admin-driver');
    await addDsvResourceProfiles(prisma, fixture);
    await expectNoImportResourceReferences(prisma, fixture);
    const before = await readResourceReferenceState(prisma, fixture);

    await expect(new PrismaAdminDriverRepository(prisma).deleteDriver({
      appId: 'clever',
      driverId: fixture.driverId,
      shopDomain: fixture.shopDomain,
    })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });

    await expect(readResourceReferenceState(prisma, fixture)).resolves.toEqual(before);
  });

  test('blocks DSV vehicle deletion while an active execution still references it', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-active-dsv-vehicle');
    await addDsvResourceProfiles(prisma, fixture);
    await expectNoImportResourceReferences(prisma, fixture);
    const before = await readResourceReferenceState(prisma, fixture);

    await expect(new PrismaDsvResourceService(prisma).deleteVehicle({
      shopDomain: fixture.shopDomain,
      vehicleId: fixture.vehicleId,
    })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });

    await expect(readResourceReferenceState(prisma, fixture)).resolves.toEqual(before);
  });

  test('deletes unreferenced DSV resources and a common admin driver normally', async () => {
    const unique = randomUUID();
    const shopDomain = `dsv-unreferenced-delete-${unique}.example.test`;
    const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain } });
    createdShopIds.push(shop.id);
    const resourceService = new PrismaDsvResourceService(prisma);
    const driver = await resourceService.createDriver({
      age: 40,
      career: 'synthetic',
      gender: 'synthetic',
      name: `Unreferenced ${unique}`,
      score: 'A',
      shopDomain,
      traits: [],
      zone: 'synthetic',
    });
    const vehicle = await resourceService.createVehicle({
      note: 'synthetic',
      plate: `UNREF-${unique.slice(0, 8)}`,
      shopDomain,
      type: 'Synthetic',
    });
    const adminRepository = new PrismaAdminDriverRepository(prisma);
    const adminDriver = await adminRepository.createPendingDriver({
      appId: 'clever',
      displayName: 'Unreferenced admin driver',
      phone: `+82${unique.replaceAll('-', '').slice(0, 15)}`,
      shopDomain,
    });
    const principal = createDsvAdminPrincipal({ shopId: shop.id });

    await expect(resourceService.deleteDriver({ driverId: driver.id, principal, shopDomain })).resolves.toBeUndefined();
    await expect(resourceService.deleteVehicle({ shopDomain, vehicleId: vehicle.id })).resolves.toBeUndefined();
    await expect(adminRepository.deleteDriver({ appId: 'clever', driverId: adminDriver.id, shopDomain }))
      .resolves.toBe(adminDriver.id);
    await expect(prisma.driver.count({ where: { id: { in: [driver.id, adminDriver.id] } } })).resolves.toBe(0);
    await expect(prisma.vehicle.count({ where: { id: vehicle.id } })).resolves.toBe(0);
  });

  test('retains closed execution history when terminal route resources are deleted', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-closed-history');
    await addDsvResourceProfiles(prisma, fixture);
    const closedAt = new Date('2026-10-06T03:00:00.000Z');
    await prisma.$transaction([
      prisma.routePlan.update({ data: { status: 'COMPLETED' }, where: { id: fixture.routePlanId } }),
      prisma.dsvExecutionContext.update({
        data: {
          closedAt,
          reminderDueAt: null,
          reminderStatus: 'RESOLVED_COMPLETE',
          status: 'CLOSED',
        },
        where: { id: fixture.contextId },
      }),
    ]);
    const service = new PrismaDsvResourceService(prisma);
    await expect(service.deleteDriver({
      driverId: fixture.driverId,
      principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
      shopDomain: fixture.shopDomain,
    })).resolves.toBeUndefined();
    await expect(service.deleteVehicle({
      shopDomain: fixture.shopDomain,
      vehicleId: fixture.vehicleId,
    })).resolves.toBeUndefined();

    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        closedAt,
        driverId: fixture.driverId,
        recipientAccountId: fixture.accountId,
        status: 'CLOSED',
        vehicleId: fixture.vehicleId,
      });
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ driverId: null, status: 'COMPLETED', vehicleId: null });
  });

  test('keeps the resource when a published-route assignment wins the deletion race', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-race-assignment-wins');
    const replacement = await createDsvReplacementDriver(prisma, fixture, 'assignment-wins');
    const assignmentClient = namedClient('dsv_delete_race_assignment_wins_writer');
    const blockerClient = namedClient('dsv_delete_race_assignment_wins_blocker');
    const deletionClient = namedClient('dsv_delete_race_assignment_wins_delete');
    let releaseContext!: () => void;
    let contextLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseContext = resolve; });
    const locked = new Promise<void>((resolve) => { contextLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM dsv_execution_contexts
        WHERE id = ${fixture.contextId}::uuid
        FOR UPDATE
      `;
      contextLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let assigned;
    try {
      const assignment = new PrismaRoutePlanRepository(assignmentClient, { allowAnyShopDomain: true })
        .assignRoutePlanDriver({
          payload: { driverId: replacement.driverId },
          routePlanId: fixture.routePlanId,
          shopDomain: fixture.shopDomain,
        });
      await waitForLockedApplication(prisma, 'dsv_delete_race_assignment_wins_writer');
      const deletion = new PrismaDsvResourceService(deletionClient).deleteDriver({
        driverId: replacement.driverId,
        principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
        shopDomain: fixture.shopDomain,
      });
      const deletionOutcome = expect(deletion).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });
      await waitForLockedApplication(prisma, 'dsv_delete_race_assignment_wins_delete');
      releaseContext();
      [assigned] = await Promise.all([
        assignment,
        deletionOutcome,
      ]);
      await blocker;
    } finally {
      releaseContext();
      await Promise.allSettled([
        blocker,
        assignmentClient.$disconnect(),
        blockerClient.$disconnect(),
        deletionClient.$disconnect(),
      ]);
    }

    expect(assigned).toMatchObject({ routePlan: { driverId: replacement.driverId } });
    await expect(prisma.driver.findUnique({ where: { id: replacement.driverId } })).resolves.not.toBeNull();
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        assignmentEpoch: 2n,
        driverId: replacement.driverId,
        recipientAccountId: replacement.accountId,
        status: 'ACTIVE',
      });
  }, 20_000);

  test('rejects a published-route assignment when deletion wins the resource race', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delete-race-deletion-wins');
    const replacement = await createDsvReplacementDriver(prisma, fixture, 'deletion-wins');
    const assignmentClient = namedClient('dsv_delete_race_deletion_wins_writer');
    const blockerClient = namedClient('dsv_delete_race_deletion_wins_blocker');
    const deletionClient = namedClient('dsv_delete_race_deletion_wins_delete');
    let releaseRoute!: () => void;
    let routeLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseRoute = resolve; });
    const locked = new Promise<void>((resolve) => { routeLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM route_plans
        WHERE id = ${fixture.routePlanId}::uuid
        FOR UPDATE
      `;
      routeLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    const assignment = new PrismaRoutePlanRepository(assignmentClient, { allowAnyShopDomain: true })
      .assignRoutePlanDriver({
        payload: { driverId: replacement.driverId },
        routePlanId: fixture.routePlanId,
        shopDomain: fixture.shopDomain,
      });
    const assignmentOutcome = assignment.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );
    try {
      await waitForLockedApplication(prisma, 'dsv_delete_race_deletion_wins_writer');
      await expect(new PrismaDsvResourceService(deletionClient).deleteDriver({
        driverId: replacement.driverId,
        principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
        shopDomain: fixture.shopDomain,
      })).resolves.toBeUndefined();
      releaseRoute();
      const outcome = await assignmentOutcome;
      expect(outcome.status).toBe('rejected');
      await blocker;
    } finally {
      releaseRoute();
      await Promise.allSettled([
        blocker,
        assignmentOutcome,
        assignmentClient.$disconnect(),
        blockerClient.$disconnect(),
        deletionClient.$disconnect(),
      ]);
    }

    await expect(prisma.driver.findUnique({ where: { id: replacement.driverId } })).resolves.toBeNull();
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ driverId: fixture.driverId });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 1n, driverId: fixture.driverId, status: 'ACTIVE' });
  }, 20_000);

  test('keeps the resource when first publication wins the deletion race', async () => {
    const fixture = await createUnpublishedOperationalFixture(prisma, createdShopIds, 'publish-delete-publication-wins');
    const publicationClient = namedClient('dsv_publish_delete_publication_wins_publish');
    const blockerClient = namedClient('dsv_publish_delete_publication_wins_blocker');
    const deletionClient = namedClient('dsv_publish_delete_publication_wins_delete');
    const advisoryKey = 8_701_061;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION dsv_test_block_context_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryKey});
        RETURN NEW;
      END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER dsv_test_block_context_insert_trigger
      BEFORE INSERT ON dsv_execution_contexts
      FOR EACH ROW EXECUTE FUNCTION dsv_test_block_context_insert()
    `);
    let releaseGate!: () => void;
    let gateLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseGate = resolve; });
    const locked = new Promise<void>((resolve) => { gateLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(${advisoryKey})`;
      gateLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let published;
    try {
      const publication = routeGroupingService(publicationClient).recordChildRoutePublished({
        routePlanId: fixture.routePlanId,
        shopDomain: fixture.shopDomain,
      });
      await waitForLockedApplication(prisma, 'dsv_publish_delete_publication_wins_publish');
      const deletion = new PrismaDsvResourceService(deletionClient).deleteDriver({
        driverId: fixture.driverId,
        principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
        shopDomain: fixture.shopDomain,
      });
      const deletionOutcome = expect(deletion).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });
      await waitForLockedApplication(prisma, 'dsv_publish_delete_publication_wins_delete');
      releaseGate();
      [published] = await Promise.all([publication, deletionOutcome]);
      await blocker;
    } finally {
      releaseGate();
      await Promise.allSettled([blocker, publicationClient.$disconnect(), blockerClient.$disconnect(), deletionClient.$disconnect()]);
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dsv_test_block_context_insert_trigger ON dsv_execution_contexts');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_test_block_context_insert()');
    }

    expect(published?.publishedAt).not.toBeNull();
    await expect(prisma.driver.findUnique({ where: { id: fixture.driverId } })).resolves.not.toBeNull();
    const context = await prisma.dsvExecutionContext.findFirstOrThrow({
      where: { routePlanId: fixture.routePlanId, shopId: fixture.shopId },
    });
    expect(context).toMatchObject({ driverId: fixture.driverId, status: 'ACTIVE' });
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: context.id, kind: 'N01' },
    })).resolves.toBe(1);
    await expect(prisma.dsvExecutionCommand.count({
      where: { commandId: `publication:${fixture.childVersionId}`, shopId: fixture.shopId },
    })).resolves.toBe(1);
  }, 20_000);

  test('returns a failed publication without stale execution artifacts when deletion wins', async () => {
    const fixture = await createUnpublishedOperationalFixture(prisma, createdShopIds, 'publish-delete-deletion-wins');
    const publicationClient = namedClient('dsv_publish_delete_deletion_wins_publish');
    const blockerClient = namedClient('dsv_publish_delete_deletion_wins_blocker');
    const deletionClient = namedClient('dsv_publish_delete_deletion_wins_delete');
    const advisoryKey = 8_701_062;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION dsv_test_block_driver_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${fixture.driverId}'::uuid THEN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
        END IF;
        RETURN OLD;
      END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER dsv_test_block_driver_delete_trigger
      BEFORE DELETE ON drivers
      FOR EACH ROW EXECUTE FUNCTION dsv_test_block_driver_delete()
    `);
    let releaseGate!: () => void;
    let gateLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseGate = resolve; });
    const locked = new Promise<void>((resolve) => { gateLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(${advisoryKey})`;
      gateLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let publicationResult: { errorCode?: string; publishedAt: string | null; status: string } | undefined;
    try {
      const deletion = new PrismaDsvResourceService(deletionClient).deleteDriver({
        driverId: fixture.driverId,
        principal: createDsvAdminPrincipal({ shopId: fixture.shopId }),
        shopDomain: fixture.shopDomain,
      });
      await waitForLockedApplication(prisma, 'dsv_publish_delete_deletion_wins_delete');
      const publication = routeGroupingService(publicationClient).recordChildRoutePublished({
        routePlanId: fixture.routePlanId,
        shopDomain: fixture.shopDomain,
      });
      await waitForLockedApplication(prisma, 'dsv_publish_delete_deletion_wins_publish');
      releaseGate();
      [, publicationResult] = await Promise.all([deletion, publication]);
      await blocker;
    } finally {
      releaseGate();
      await Promise.allSettled([blocker, publicationClient.$disconnect(), blockerClient.$disconnect(), deletionClient.$disconnect()]);
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dsv_test_block_driver_delete_trigger ON drivers');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_test_block_driver_delete()');
    }

    await expect(prisma.driver.findUnique({ where: { id: fixture.driverId } })).resolves.toBeNull();
    expect(publicationResult).toMatchObject({ errorCode: 'NOTIFICATION_PROCESSING_FAILED', status: 'FAILED' });
    expect(publicationResult?.publishedAt).not.toBeNull();
    const publishedChild = await prisma.routeGroupingChildVersion.findUniqueOrThrow({
      where: { id: fixture.childVersionId },
    });
    expect(publishedChild.publishedAt).not.toBeNull();
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ driverId: null });
    await expect(prisma.dsvExecutionContext.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(0);
    await expect(prisma.dsvExecutionRouteMapping.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({ where: { shopId: fixture.shopId } })).resolves.toBe(0);
    await expect(prisma.dsvExecutionCommand.findFirstOrThrow({
      where: { commandId: `publication:${fixture.childVersionId}`, shopId: fixture.shopId },
    })).resolves.toMatchObject({ result: { outcome: 'SKIPPED_NON_DSV' } });
  }, 20_000);

  test('serializes admin account approval before deletion without a driver-route lock cycle', async () => {
    const identity = accountLinkIdentity('admin-approval');
    const fixture = await createUnlinkedOperationalFixture(prisma, createdShopIds, 'admin-account-link-delete', identity);
    const account = await prisma.driverAccount.create({
      data: { name: identity.name, phone: identity.phone, status: 'ACTIVE' },
    });
    await expectAccountLinkDeletionRace(prisma, [fixture], 'admin-account-link', (client) => (
      new PrismaDsvDriverAccountLinkService(client).approve({
        accountId: account.id,
        actorId: 'synthetic-admin',
        driverId: fixture.driverId,
        requestId: randomUUID(),
        shopDomain: fixture.shopDomain,
      })
    ), account.id);
  }, 30_000);

  test('serializes existing admin pending-driver account attribution before deletion', async () => {
    const identity = accountLinkIdentity('admin-existing-driver');
    const fixture = await createUnlinkedOperationalFixture(
      prisma,
      createdShopIds,
      'admin-existing-driver-account-link-delete',
      identity,
    );
    const account = await prisma.driverAccount.create({
      data: { name: identity.name, phone: identity.phone, status: 'ACTIVE' },
    });

    await expectAccountLinkDeletionRace(prisma, [fixture], 'admin-existing-driver-account-link', (client) => (
      new PrismaAdminDriverRepository(client).createPendingDriver({
        appId: 'clever',
        displayName: identity.name,
        phone: identity.phone,
        shopDomain: fixture.shopDomain,
      })
    ), account.id);

    const beforeRepeat = await Promise.all([
      prisma.dsvOperationalNotification.count({ where: { executionContextId: fixture.contextId } }),
      prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } }),
    ]);
    await new PrismaAdminDriverRepository(prisma).createPendingDriver({
      appId: 'clever',
      displayName: identity.name,
      phone: identity.phone,
      shopDomain: fixture.shopDomain,
    });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 2n, recipientAccountId: account.id });
    await expect(Promise.all([
      prisma.dsvOperationalNotification.count({ where: { executionContextId: fixture.contextId } }),
      prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } }),
    ])).resolves.toEqual(beforeRepeat);
  }, 30_000);

  test('moves an existing admin pending driver from the old recipient to the matched account', async () => {
    const identity = accountLinkIdentity('admin-reassign');
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'admin-existing-driver-reassign');
    await addDsvResourceProfiles(prisma, fixture);
    const replacementAccount = await prisma.driverAccount.create({
      data: { name: identity.name, phone: identity.phone, status: 'ACTIVE' },
    });
    await prisma.driver.update({
      data: { displayName: identity.name, phone: identity.phone },
      where: { id: fixture.driverId },
    });

    await new PrismaAdminDriverRepository(prisma).createPendingDriver({
      appId: 'clever',
      displayName: identity.name,
      phone: identity.phone,
      shopDomain: fixture.shopDomain,
    });

    await expect(prisma.driver.findUniqueOrThrow({ where: { id: fixture.driverId } }))
      .resolves.toMatchObject({ accountId: replacementAccount.id });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 2n, recipientAccountId: replacementAccount.id, status: 'ACTIVE' });
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: { kind: 'asc' },
      select: { assignmentEpoch: true, businessStatus: true, kind: true, recipientAccountId: true },
      where: { executionContextId: fixture.contextId, kind: { in: ['N01', 'N03'] } },
    })).resolves.toEqual([
      {
        assignmentEpoch: 2n,
        businessStatus: 'OPEN',
        kind: 'N01',
        recipientAccountId: replacementAccount.id,
      },
      {
        assignmentEpoch: 1n,
        businessStatus: 'OPEN',
        kind: 'N03',
        recipientAccountId: fixture.accountId,
      },
    ]);
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: fixture.warningId } }))
      .resolves.toMatchObject({ businessStatus: 'RESOLVED', recipientAccountId: fixture.accountId });

    await prisma.$transaction([
      prisma.driverAccount.update({
        data: { phone: `+8210${randomUUID().replace(/\D/gu, '').padEnd(8, '0').slice(0, 8)}` },
        where: { id: replacementAccount.id },
      }),
      prisma.driverAccount.update({ data: { phone: identity.phone }, where: { id: fixture.accountId } }),
    ]);
    await new PrismaAdminDriverRepository(prisma).createPendingDriver({
      appId: 'clever',
      displayName: identity.name,
      phone: identity.phone,
      shopDomain: fixture.shopDomain,
    });

    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 3n, recipientAccountId: fixture.accountId, status: 'ACTIVE' });
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: { kind: 'asc' },
      select: { assignmentEpoch: true, businessStatus: true, kind: true, recipientAccountId: true },
      where: {
        executionContextId: fixture.contextId,
        OR: [
          { assignmentEpoch: 3n, kind: 'N01' },
          { assignmentEpoch: 2n, kind: 'N03' },
        ],
      },
    })).resolves.toEqual([
      {
        assignmentEpoch: 3n,
        businessStatus: 'OPEN',
        kind: 'N01',
        recipientAccountId: fixture.accountId,
      },
      {
        assignmentEpoch: 2n,
        businessStatus: 'OPEN',
        kind: 'N03',
        recipientAccountId: replacementAccount.id,
      },
    ]);
    await expect(prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } })).resolves.toBe(2);
  });

  test('rolls back and retries account approval when a new driver route commits after topology discovery', async () => {
    const identity = accountLinkIdentity('admin-topology-retry');
    const fixture = await createUnlinkedOperationalFixture(prisma, createdShopIds, 'admin-account-link-topology', identity);
    const account = await prisma.driverAccount.create({
      data: { name: identity.name, phone: identity.phone, status: 'ACTIVE' },
    });
    let releaseTopology!: () => void;
    let topologyRead!: () => void;
    const release = new Promise<void>((resolve) => { releaseTopology = resolve; });
    const read = new Promise<void>((resolve) => { topologyRead = resolve; });
    let transactionAttempts = 0;
    let gated = false;
    const gatedPrisma = new Proxy(prisma, {
      get(target, property, receiver): unknown {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => target.$transaction(async (tx) => {
          transactionAttempts += 1;
          const gatedTx = new Proxy(tx, {
            get(target, property, receiver): unknown {
              if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
              return async <R>(query: Prisma.Sql): Promise<R> => {
                const result = await target.$queryRaw<R>(query);
                if (!gated && query.sql.includes('SELECT DISTINCT attribution_route')) {
                  gated = true;
                  topologyRead();
                  await release;
                }
                return result;
              };
            },
          });
          return operation(gatedTx);
        });
      },
    });
    const linking = new PrismaDsvDriverAccountLinkService(gatedPrisma).approve({
      accountId: account.id,
      actorId: 'synthetic-admin',
      driverId: fixture.driverId,
      requestId: randomUUID(),
      shopDomain: fixture.shopDomain,
    });
    await read;
    const newRoute = await prisma.routePlan.create({
      data: {
        constraints: {},
        driverId: fixture.driverId,
        metrics: {},
        name: 'Synthetic late attribution route',
        optimizerVersion: 'dsv-operational-integration',
        planDate: new Date('2026-10-06T00:00:00.000Z'),
        shopId: fixture.shopId,
        status: 'READY',
      },
    });
    releaseTopology();
    await expect(linking).resolves.toEqual({ accountId: account.id, driverId: fixture.driverId });
    expect(transactionAttempts).toBe(2);
    await expect(prisma.routePlan.findUnique({ where: { id: newRoute.id } })).resolves.not.toBeNull();
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 2n, recipientAccountId: account.id });
    await expect(prisma.dsvOperationalNotification.count({
      where: { assignmentEpoch: 2n, executionContextId: fixture.contextId, kind: 'N01' },
    })).resolves.toBe(1);
    await expect(prisma.dsvAuditEvent.count({
      where: {
        entityId: fixture.driverId,
        entityType: 'DRIVER_ACCOUNT_LINK',
        eventType: 'DRIVER_ACCOUNT_LINK_APPROVED',
        shopId: fixture.shopId,
      },
    })).resolves.toBe(1);
  }, 30_000);

  test('serializes DSV registration for multiple reverse-ordered routes before deletion', async () => {
    const identity = accountLinkIdentity('dsv-register');
    const fixtures = await Promise.all([
      createUnlinkedOperationalFixture(prisma, createdShopIds, 'register-account-link-delete-a', identity, {
        driverId: '87010600-0000-4000-8000-000000000101',
        routePlanId: '87010600-0000-4000-8000-000000000902',
      }),
      createUnlinkedOperationalFixture(prisma, createdShopIds, 'register-account-link-delete-b', identity, {
        driverId: '87010600-0000-4000-8000-000000000202',
        routePlanId: '87010600-0000-4000-8000-000000000801',
      }),
    ]);
    expect(fixtures.map(({ driverId }) => driverId).sort()).toEqual([fixtures[0].driverId, fixtures[1].driverId]);
    expect(fixtures.map(({ routePlanId }) => routePlanId).sort()).toEqual([fixtures[1].routePlanId, fixtures[0].routePlanId]);
    await expectAccountLinkDeletionRace(prisma, fixtures, 'dsv-register-account-link', (client) => (
      new PrismaDsvDriverAuthRepository(client).register({
        loginId: `register-${randomUUID()}@example.test`,
        name: identity.name,
        password: 'test-synthetic-password-123!',
        phone: identity.phone,
      })
    ));
  }, 30_000);

  test('serializes DSV login auto-link before deletion', async () => {
    const identity = accountLinkIdentity('dsv-login');
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'login-account-link-delete');
    const loginId = `login-${randomUUID()}@example.test`;
    const password = 'test-synthetic-password-123!';
    const registered = await new PrismaDsvDriverAuthRepository(prisma).register({
      loginId,
      name: identity.name,
      password,
      phone: identity.phone,
    });
    await addDsvResourceProfiles(prisma, fixture);
    await unlinkOperationalFixture(prisma, fixture, identity);
    await expectAccountLinkDeletionRace(prisma, [fixture], 'dsv-login-account-link', (client) => (
      new PrismaDsvDriverAuthRepository(client).login({ loginId, password })
    ), registered.accountId);
  }, 30_000);

  test('serializes DSV refresh auto-link before deletion', async () => {
    const identity = accountLinkIdentity('dsv-refresh');
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'refresh-account-link-delete');
    const registered = await new PrismaDsvDriverAuthRepository(prisma).register({
      loginId: `refresh-${randomUUID()}@example.test`,
      name: identity.name,
      password: 'test-synthetic-password-123!',
      phone: identity.phone,
    });
    await addDsvResourceProfiles(prisma, fixture);
    await unlinkOperationalFixture(prisma, fixture, identity);
    await expectAccountLinkDeletionRace(prisma, [fixture], 'dsv-refresh-account-link', (client) => (
      new PrismaDsvDriverAuthRepository(client).refresh({ refreshToken: registered.refreshToken })
    ), registered.accountId);
  }, 30_000);

  test('serializes common invite registration for multiple reverse-ordered routes before deletion', async () => {
    const identity = accountLinkIdentity('common-invite');
    const inviteCode = randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
    const fixtures = await Promise.all([
      createUnlinkedOperationalFixture(prisma, createdShopIds, 'invite-account-link-delete-a', identity, {
        driverId: '87010600-0000-4000-8000-000000000303',
        routePlanId: '87010600-0000-4000-8000-000000000704',
      }),
      createUnlinkedOperationalFixture(prisma, createdShopIds, 'invite-account-link-delete-b', identity, {
        driverId: '87010600-0000-4000-8000-000000000404',
        routePlanId: '87010600-0000-4000-8000-000000000603',
      }),
    ]);
    await prisma.driver.updateMany({
      data: { inviteCode, inviteCodeExpiresAt: new Date(Date.now() + 60_000) },
      where: { id: { in: fixtures.map(({ driverId }) => driverId) } },
    });
    expect(fixtures.map(({ driverId }) => driverId).sort()).toEqual([fixtures[0].driverId, fixtures[1].driverId]);
    expect(fixtures.map(({ routePlanId }) => routePlanId).sort()).toEqual([fixtures[1].routePlanId, fixtures[0].routePlanId]);
    await expectAccountLinkDeletionRace(prisma, fixtures, 'common-invite-account-link', (client) => (
      new PrismaDriverAuthRepository(client).verifyInvite({
        displayName: identity.name,
        inviteCode,
        phone: identity.phone,
        pin: '123456',
      })
    ));
  }, 30_000);

  test('rolls back DSV registration account, session, contexts, and intents when a later driver link fails', async () => {
    const identity = accountLinkIdentity('dsv-register-rollback');
    const fixtures = await createReverseOrderedUnlinkedFixtures(
      prisma,
      createdShopIds,
      'register-link-rollback',
      identity,
      505,
    );
    await expectMultiDriverAccountLinkRollback(prisma, fixtures, identity, () => (
      new PrismaDsvDriverAuthRepository(prisma).register({
        loginId: `rr-${randomUUID()}@x.test`,
        name: identity.name,
        password: 'test-synthetic-password-123!',
        phone: identity.phone,
      })
    ));
  }, 30_000);

  test('rolls back common invite account, session, contexts, and intents when a later driver link fails', async () => {
    const identity = accountLinkIdentity('common-invite-rollback');
    const inviteCode = randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
    const fixtures = await createReverseOrderedUnlinkedFixtures(
      prisma,
      createdShopIds,
      'invite-link-rollback',
      identity,
      707,
    );
    await prisma.driver.updateMany({
      data: { inviteCode, inviteCodeExpiresAt: new Date(Date.now() + 60_000) },
      where: { id: { in: fixtures.map(({ driverId }) => driverId) } },
    });
    await expectMultiDriverAccountLinkRollback(prisma, fixtures, identity, () => (
      new PrismaDriverAuthRepository(prisma).verifyInvite({
        displayName: identity.name,
        inviteCode,
        phone: identity.phone,
        pin: '123456',
      })
    ));
  }, 30_000);

  test('creates one execution and N01 for simultaneous first-publication receipts', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'first-publication');
    await prisma.dsvExecutionContext.delete({ where: { id: fixture.contextId } });
    const input = {
      commandId: randomUUID(),
      firstPublication: true,
      now: new Date('2026-10-06T00:00:00.000Z'),
      previousPublishedAt: null,
      routePlanId: fixture.routePlanId,
      shopId: fixture.shopId,
      tripIntent: 'INITIAL_EXECUTION' as const,
    };
    const invoke = () => prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute(input)
    ));

    const [first, second] = await Promise.all([invoke(), invoke()]);

    expect([first.outcome, second.outcome].sort()).toEqual(['ACCEPT', 'REPLAY']);
    expect(second.executionContextId).toBe(first.executionContextId);
    await expect(prisma.dsvExecutionContext.count({ where: { routePlanId: fixture.routePlanId, shopId: fixture.shopId } }))
      .resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: first.executionContextId!, kind: 'N01' },
    })).resolves.toBe(1);
    await expect(prisma.dsvExecutionCommand.count({
      where: { commandId: input.commandId, commandName: `SYNC_ROUTE_EXECUTION:${fixture.routePlanId}`, shopId: fixture.shopId },
    })).resolves.toBe(1);
  });

  test('serializes implicit first publications for one vehicle and requires an explicit new execution', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'vehicle-first-publication');
    const sibling = await createSiblingPublishedRoute(prisma, fixture, 'vehicle-first-publication-sibling');
    await prisma.dsvExecutionContext.delete({ where: { id: fixture.contextId } });
    const firstClient = namedClient('dsv_vehicle_first_a');
    const secondClient = namedClient('dsv_vehicle_first_b');
    const blockerClient = namedClient('dsv_vehicle_first_blocker');
    let releaseVehicleLock!: () => void;
    let vehicleLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseVehicleLock = resolve; });
    const locked = new Promise<void>((resolve) => { vehicleLocked = resolve; });
    const lockKey = `dsv-execution:${fixture.shopId}:vehicle-service-date:${fixture.vehicleId}:2026-10-06`;
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        WITH lock AS (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)))
        SELECT 1 AS locked FROM lock
      `);
      vehicleLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    const sync = (client: PrismaClient, routePlanId: string) => client.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId: randomUUID(),
        firstPublication: true,
        now: new Date('2026-10-06T00:00:00.000Z'),
        previousPublishedAt: null,
        routePlanId,
        shopId: fixture.shopId,
      })
    ));
    let results: Awaited<ReturnType<typeof sync>>[] | undefined;
    try {
      const firstRun = sync(firstClient, fixture.routePlanId);
      const secondRun = sync(secondClient, sibling.routePlanId);
      await waitForLockedApplications(prisma, ['dsv_vehicle_first_a', 'dsv_vehicle_first_b']);
      releaseVehicleLock();
      results = await Promise.all([firstRun, secondRun]);
      await blocker;
    } finally {
      releaseVehicleLock();
      await Promise.allSettled([
        blocker,
        blockerClient.$disconnect(),
        firstClient.$disconnect(),
        secondClient.$disconnect(),
      ]);
    }

    if (results === undefined) throw new Error('Concurrent publication results were not recorded.');
    expect(results.map((result) => result.outcome).sort()).toEqual(['ACCEPT', 'MAPPING_REQUIRED']);
    const mappingRequiredRoute = results.find((result) => result.outcome === 'MAPPING_REQUIRED')!.routePlanId;
    const explicitlyCreated = await prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId: randomUUID(),
        now: new Date('2026-10-06T00:01:00.000Z'),
        routePlanId: mappingRequiredRoute,
        shopId: fixture.shopId,
        tripIntent: 'NEW_EXECUTION',
      })
    ));
    expect(explicitlyCreated.outcome).toBe('ACCEPT');
    await expect(prisma.dsvExecutionContext.count({
      where: { serviceDate: new Date('2026-10-06T00:00:00.000Z'), shopId: fixture.shopId, vehicleId: fixture.vehicleId },
    })).resolves.toBe(2);
  }, 20_000);

  test('rolls execution identity, mapping, intent, and command back with the parent transaction', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'publication-rollback');
    await prisma.dsvExecutionContext.delete({ where: { id: fixture.contextId } });
    const commandId = randomUUID();

    await expect(prisma.$transaction(async (transaction) => {
      await new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId,
        firstPublication: true,
        previousPublishedAt: null,
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
        tripIntent: 'INITIAL_EXECUTION',
      });
      throw new Error('synthetic publication failure');
    })).rejects.toThrow('synthetic publication failure');

    await expect(prisma.dsvExecutionContext.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(0);
    await expect(prisma.dsvExecutionRouteMapping.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({ where: { shopId: fixture.shopId } })).resolves.toBe(0);
    await expect(prisma.dsvExecutionCommand.count({ where: { commandId, shopId: fixture.shopId } })).resolves.toBe(0);
  });

  test('rejects a cross-day SAME_EXECUTION rebind and rolls every execution artifact back', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'cross-day-same-execution');
    const replacement = await createSiblingPublishedRoute(prisma, fixture, 'cross-day-same-execution-replacement');
    const replacementServiceDate = new Date('2026-10-07T00:00:00.000Z');
    await Promise.all([
      prisma.routePlan.update({
        data: { planDate: replacementServiceDate },
        where: { id: replacement.routePlanId },
      }),
      prisma.order.update({
        data: { serviceDate: replacementServiceDate },
        where: { id: replacement.orderId },
      }),
    ]);
    const before = await readExecutionArtifactState(prisma, fixture.shopId);
    const commandId = randomUUID();

    await expect(prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId,
        executionContextId: fixture.contextId,
        now: new Date('2026-10-07T00:05:00.000Z'),
        routePlanId: replacement.routePlanId,
        shopId: fixture.shopId,
        tripIntent: 'SAME_EXECUTION',
      })
    ))).rejects.toMatchObject({ code: 'EXECUTION_SERVICE_DATE_MISMATCH' });

    await expect(readExecutionArtifactState(prisma, fixture.shopId)).resolves.toEqual(before);
    await expect(prisma.dsvExecutionCommand.count({ where: { commandId, shopId: fixture.shopId } })).resolves.toBe(0);
  });

  test('bumps route content version without resetting assignment epoch or reminder state', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'content-version');
    await prisma.dsvExecutionContext.delete({ where: { id: fixture.contextId } });
    const sync = (commandId: string) => prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId,
        firstPublication: true,
        previousPublishedAt: null,
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
      })
    ));
    const created = await sync(randomUUID());
    await prisma.order.update({
      data: { rawPayload: { dsv: { normalized: { shippedBoxes: 2 } } } },
      where: { id: fixture.orderId },
    });

    const changed = await sync(randomUUID());

    expect(changed).toMatchObject({
      assignmentEpoch: '1',
      executionContextId: created.executionContextId,
      notificationKinds: ['N02'],
      routeVersion: 2,
    });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: created.executionContextId! } }))
      .resolves.toMatchObject({
        assignmentEpoch: 1n,
        reminderOrdinal: 0,
        reminderStatus: 'AWAITING_DEPARTURE',
        routeVersion: 2,
      });
  });

  test('commits a generic stop override with its route version and rolls both back on sync failure', async () => {
    const committed = await createOperationalFixture(prisma, createdShopIds, 'stop-override-commit');
    const routePlans = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
    await expect(routePlans.updateAdminRouteStopOverride({
      actor: 'synthetic-operator',
      appId: 'clever',
      deliveryStopId: committed.stopId,
      payload: { address1: 'Committed override destination' },
      routePlanId: committed.routePlanId,
      shopDomain: committed.shopDomain,
    })).resolves.toMatchObject({ geometry: { status: 'stale' } });
    await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: committed.stopId } }))
      .resolves.toMatchObject({ address1: 'Committed override destination' });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: committed.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 1n, routeVersion: 2 });

    const rolledBack = await createOperationalFixture(prisma, createdShopIds, 'stop-override-rollback');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION dsv_operational_test_fail_context_sync() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic context sync failure'; END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER dsv_operational_test_fail_context_sync_trigger
      BEFORE UPDATE ON dsv_execution_contexts
      FOR EACH ROW EXECUTE FUNCTION dsv_operational_test_fail_context_sync()
    `);
    try {
      await expect(routePlans.updateAdminRouteStopOverride({
        actor: 'synthetic-operator',
        appId: 'clever',
        deliveryStopId: rolledBack.stopId,
        payload: { address1: 'Must roll back' },
        routePlanId: rolledBack.routePlanId,
        shopDomain: rolledBack.shopDomain,
      })).rejects.toThrow('synthetic context sync failure');
      await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: rolledBack.stopId } }))
        .resolves.toMatchObject({ address1: 'Synthetic destination' });
      await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: rolledBack.contextId } }))
        .resolves.toMatchObject({ assignmentEpoch: 1n, routeVersion: 1 });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dsv_operational_test_fail_context_sync_trigger ON dsv_execution_contexts');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_operational_test_fail_context_sync()');
    }
  });

  test('syncs both published children only after production draft projections are complete', async () => {
    const fixture = await createPublishedMultiChildFixture(prisma, createdShopIds, 'multi-child-save');
    const beforeContexts = await readExecutionVersions(prisma, fixture.contextIds);
    await prisma.order.updateMany({
      data: { rawPayload: { dsv: { normalized: { shippedBoxes: 2 } } } },
      where: { id: { in: fixture.orderIds } },
    });

    const saved = await routeGroupingService(prisma).saveDraft(multiChildDraftInput(fixture, 'updated'));

    expect(saved).not.toBeNull();
    await expect(prisma.routeGrouping.findUniqueOrThrow({ where: { id: fixture.groupingId } }))
      .resolves.toMatchObject({ status: 'READY' });
    const currentChildren = await prisma.routeGroupingChildVersion.findMany({
      orderBy: { routePlanId: 'asc' },
      select: { id: true, publishedAt: true, routePlanId: true, status: true, supersededAt: true },
      where: { groupingId: fixture.groupingId, status: 'CURRENT', supersededAt: null },
    });
    expect(currentChildren).toHaveLength(2);
    expect(currentChildren.some(({ id }) => fixture.childVersionIds.includes(id))).toBe(false);
    expect(currentChildren.every(({ publishedAt }) => publishedAt !== null)).toBe(true);
    for (const child of currentChildren) {
      const route = fixture.routes.find(({ routePlanId }) => routePlanId === child.routePlanId)!;
      await expect(prisma.order.findUniqueOrThrow({ where: { id: route.orderId } }))
        .resolves.toMatchObject({ currentRouteVersionId: child.id });
      await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: route.routePlanId } }))
        .resolves.toMatchObject({ name: `updated-${route.routePlanId}`, status: 'READY' });
    }
    const afterContexts = await readExecutionVersions(prisma, fixture.contextIds);
    expect(afterContexts).toHaveLength(2);
    for (const context of afterContexts) {
      const before = beforeContexts.find(({ id }) => id === context.id)!;
      expect(context).toMatchObject({ assignmentEpoch: before.assignmentEpoch, routeVersion: before.routeVersion + 1 });
      expect(context.contentSnapshot).toMatchObject({ stops: [{ quantity: 2 }] });
    }
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: { executionContextId: 'asc' },
      select: { assignmentEpoch: true, businessStatus: true, executionContextId: true, kind: true, routeVersion: true },
      where: { executionContextId: { in: fixture.contextIds }, kind: 'N02' },
    })).resolves.toEqual(afterContexts.map((context) => ({
      assignmentEpoch: 1n,
      businessStatus: 'OPEN',
      executionContextId: context.id,
      kind: 'N02',
      routeVersion: context.routeVersion,
    })));
    await expect(prisma.dsvExecutionCommand.count({
      where: {
        commandId: { startsWith: 'child-successor:' },
        commandName: { in: fixture.routePlanIds.map((id) => `SYNC_ROUTE_EXECUTION:${id}`) },
        shopId: fixture.shopId,
      },
    })).resolves.toBe(2);
  });

  test('rolls every published child projection, context, intent, and receipt back when the later sync fails', async () => {
    const fixture = await createPublishedMultiChildFixture(prisma, createdShopIds, 'multi-child-rollback');
    const before = await readPublishedMultiChildState(prisma, fixture);
    await prisma.order.updateMany({
      data: { rawPayload: { dsv: { normalized: { shippedBoxes: 2 } } } },
      where: { id: { in: fixture.orderIds } },
    });
    const secondRoutePlanId = [...fixture.routePlanIds].sort()[1]!;
    const secondContextId = fixture.routes.find(({ routePlanId }) => routePlanId === secondRoutePlanId)!.contextId;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION dsv_operational_test_fail_later_child_sync() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${secondContextId}'::uuid THEN
          RAISE EXCEPTION 'synthetic later child sync failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER dsv_operational_test_fail_later_child_sync_trigger
      BEFORE UPDATE ON dsv_execution_contexts
      FOR EACH ROW EXECUTE FUNCTION dsv_operational_test_fail_later_child_sync()
    `);
    try {
      await expect(prisma.$transaction((transaction) => (
        routeGroupingService(prisma).saveDraftInTransaction(
          transaction,
          multiChildDraftInput(fixture, 'must-roll-back'),
        )
      ))).rejects.toThrow('synthetic later child sync failure');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS dsv_operational_test_fail_later_child_sync_trigger ON dsv_execution_contexts',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_operational_test_fail_later_child_sync()');
    }

    await expect(readPublishedMultiChildState(prisma, fixture)).resolves.toEqual(before);
  });

  test('returns one durable result when the same start command arrives simultaneously', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'concurrent-start');
    const input = startInput(fixture);
    const firstClient = namedClient('dsv_start_first');
    const secondClient = namedClient('dsv_start_second');
    let releaseContextLock!: () => void;
    let contextLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseContextLock = resolve; });
    const locked = new Promise<void>((resolve) => { contextLocked = resolve; });
    const blocker = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM dsv_execution_contexts WHERE id = ${fixture.contextId}::uuid FOR UPDATE`;
      contextLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let first;
    let second;
    try {
      const firstRun = commandService(firstClient).start(input);
      const secondRun = commandService(secondClient).start(input);
      await waitForLockedApplications(prisma, ['dsv_start_first', 'dsv_start_second']);
      releaseContextLock();
      [first, second] = await Promise.all([firstRun, secondRun]);
      await blocker;
    } finally {
      releaseContextLock();
      await Promise.allSettled([blocker, firstClient.$disconnect(), secondClient.$disconnect()]);
    }

    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(second.commandId).toBe(first.commandId);
    await expect(prisma.dsvExecutionCommand.count({
      where: { commandId: input.commandId, commandName: 'START_EXECUTION', shopId: fixture.shopId },
    })).resolves.toBe(1);
    await expect(prisma.driverEvent.count({
      where: { eventType: { in: ['PICKUP_COMPLETED', 'ROUTE_STARTED'] }, routePlanId: fixture.routePlanId },
    })).resolves.toBe(2);
  });

  test('preserves an arbitrary legacy ROUTE_STARTED event and repairs only missing pickup', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'legacy-partial-start');
    const repository = new PrismaDriverEventRepository(prisma);
    const input = startInput(fixture);
    const legacy = await prisma.$transaction((transaction) => repository.recordDriverEventInTransaction(transaction, {
      assignmentGeneration: '1',
      clientEventId: `legacy-${randomUUID()}`,
      deliveryStopId: null,
      driverContractVersion: 2,
      driverId: fixture.driverId,
      eventType: 'ROUTE_STARTED',
      expectedRouteVersionId: fixture.childVersionId,
      latitude: null,
      longitude: null,
      occurredAt: new Date(input.occurredAt.getTime() - 60_000),
      payload: { schema: 'legacy_partial_start_v1' },
      routePlanId: fixture.routePlanId,
      shopDomain: fixture.shopDomain,
      shopId: fixture.shopId,
    }, { skipDsvExecutionSync: true }));

    const repaired = await commandService(prisma).start(input);

    expect(repaired.routeStartedEventId).toBe(legacy.eventId);
    expect(repaired.pickupCompletedEventId).not.toBe(legacy.eventId);
    await expect(prisma.driverEvent.groupBy({
      by: ['eventType'],
      _count: { _all: true },
      where: { routePlanId: fixture.routePlanId, eventType: { in: ['PICKUP_COMPLETED', 'ROUTE_STARTED'] } },
    })).resolves.toEqual(expect.arrayContaining([
      { _count: { _all: 1 }, eventType: 'PICKUP_COMPLETED' },
      { _count: { _all: 1 }, eventType: 'ROUTE_STARTED' },
    ]));
  });

  test('keeps selector history and rejects overlapping windows for one vehicle', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'selector-history');
    const select = (commandId: string, validFrom: Date, validUntil: Date) => prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).selectActiveExecution({
        commandId,
        executionContextId: fixture.contextId,
        shopId: fixture.shopId,
        validFrom,
        validUntil,
        vehicleId: fixture.vehicleId,
      })
    ));
    await select(randomUUID(), new Date('2026-10-06T00:00:00.000Z'), new Date('2026-10-06T01:00:00.000Z'));
    await select(randomUUID(), new Date('2026-10-06T01:00:00.000Z'), new Date('2026-10-06T02:00:00.000Z'));

    await expect(select(
      randomUUID(),
      new Date('2026-10-06T00:30:00.000Z'),
      new Date('2026-10-06T01:30:00.000Z'),
    )).rejects.toMatchObject({ code: 'SELECTION_INTERVAL_OVERLAP' });
    await expect(prisma.dsvExecutionSelection.count({
      where: { shopId: fixture.shopId, vehicleId: fixture.vehicleId },
    })).resolves.toBe(2);
    await expect(prisma.dsvExecutionRouteMapping.create({
      data: {
        executionContextId: fixture.contextId,
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
        validFrom: new Date('2026-10-06T03:00:00.000Z'),
        validUntil: new Date('2026-10-06T02:59:59.999Z'),
      },
    })).rejects.toThrow('dsv_execution_route_mappings_valid_interval');
  });

  test('clips active selection history and removes future selections when the vehicle changes', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'selection-vehicle-change');
    const select = (validFrom: Date, validUntil: Date) => prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).selectActiveExecution({
        commandId: randomUUID(),
        executionContextId: fixture.contextId,
        shopId: fixture.shopId,
        validFrom,
        validUntil,
        vehicleId: fixture.vehicleId,
      })
    ));
    await select(new Date('2026-10-06T00:00:00.000Z'), new Date('2026-10-06T02:00:00.000Z'));
    await select(new Date('2026-10-06T02:00:00.000Z'), new Date('2026-10-06T04:00:00.000Z'));
    const replacementVehicle = await prisma.vehicle.create({
      data: {
        label: 'Synthetic replacement vehicle',
        licensePlate: `REPLACE-${randomUUID().slice(0, 8)}`,
        shopId: fixture.shopId,
        status: 'ACTIVE',
      },
    });
    await prisma.routePlan.update({ data: { vehicleId: replacementVehicle.id }, where: { id: fixture.routePlanId } });
    const changedAt = new Date('2026-10-06T01:00:00.000Z');
    await prisma.$transaction((transaction) => new PrismaDsvExecutionContextService(transaction).syncForRoute({
      commandId: randomUUID(),
      now: changedAt,
      routePlanId: fixture.routePlanId,
      shopId: fixture.shopId,
    }));

    await expect(prisma.dsvExecutionSelection.findMany({
      orderBy: { validFrom: 'asc' },
      where: { executionContextId: fixture.contextId, shopId: fixture.shopId },
    })).resolves.toMatchObject([{
      validFrom: new Date('2026-10-06T00:00:00.000Z'),
      validUntil: changedAt,
      vehicleId: fixture.vehicleId,
    }]);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 2n, vehicleId: replacementVehicle.id });
  });

  test('commits grouped driver assignment, execution epoch, child snapshot, and intents after the route lock', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'grouped-driver-assignment');
    await prisma.$transaction((transaction) => (
      new PrismaDsvExecutionContextService(transaction).syncForRoute({
        commandId: randomUUID(),
        now: new Date('2026-10-06T00:05:00.000Z'),
        routePlanId: fixture.routePlanId,
        shopId: fixture.shopId,
      })
    ));
    const baseline = await prisma.dsvExecutionContext.findUniqueOrThrow({
      select: { assignmentEpoch: true, routeVersion: true },
      where: { id: fixture.contextId },
    });
    expect(baseline).toEqual({ assignmentEpoch: 1n, routeVersion: 2 });
    const replacementAccount = await prisma.driverAccount.create({
      data: {
        name: 'Synthetic replacement account',
        phone: `+82${randomUUID().replaceAll('-', '').slice(0, 15)}`,
        status: 'ACTIVE',
      },
    });
    const replacementDriver = await prisma.driver.create({
      data: {
        accountId: replacementAccount.id,
        displayName: 'Synthetic replacement driver',
        shopId: fixture.shopId,
        status: 'ACTIVE',
      },
    });
    const assignmentClient = namedClient('dsv_grouped_driver_assignment');
    const blockerClient = namedClient('dsv_grouped_driver_blocker');
    const synchronizationClient = namedClient('dsv_grouped_driver_synchronization');
    let releaseRouteLock!: () => void;
    let routeLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseRouteLock = resolve; });
    const locked = new Promise<void>((resolve) => { routeLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM route_plans
        WHERE id = ${fixture.routePlanId}::uuid
        FOR UPDATE
      `;
      routeLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let assigned;
    try {
      const assignment = new PrismaRoutePlanRepository(assignmentClient, { allowAnyShopDomain: true })
        .assignRoutePlanDriver({
          payload: { driverId: replacementDriver.id },
          routePlanId: fixture.routePlanId,
          shopDomain: fixture.shopDomain,
        });
      await waitForLockedApplication(prisma, 'dsv_grouped_driver_assignment');
      const synchronization = synchronizationClient.$transaction((transaction) => (
        new PrismaDsvExecutionContextService(transaction).syncForRoute({
          commandId: randomUUID(),
          now: new Date('2026-10-06T00:10:00.000Z'),
          routePlanId: fixture.routePlanId,
          shopId: fixture.shopId,
        })
      ));
      await waitForLockedApplication(prisma, 'dsv_grouped_driver_synchronization');
      releaseRouteLock();
      [assigned] = await Promise.all([assignment, synchronization]);
      await blocker;
    } finally {
      releaseRouteLock();
      await Promise.allSettled([
        blocker,
        assignmentClient.$disconnect(),
        blockerClient.$disconnect(),
        synchronizationClient.$disconnect(),
      ]);
    }

    expect(assigned).toMatchObject({ routePlan: { driverId: replacementDriver.id } });
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ assignmentGeneration: 2n, driverId: replacementDriver.id });
    const currentChildren = await prisma.routeGroupingChildVersion.findMany({
      select: { driverId: true, snapshot: true },
      where: { routePlanId: fixture.routePlanId, status: 'CURRENT', supersededAt: null },
    });
    expect(currentChildren).toHaveLength(1);
    expect(currentChildren[0]).toMatchObject({ driverId: replacementDriver.id });
    expect(currentChildren[0]?.snapshot).toMatchObject({ assignmentGeneration: '2' });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        assignmentEpoch: 2n,
        driverId: replacementDriver.id,
        recipientAccountId: replacementAccount.id,
        routeVersion: baseline.routeVersion,
      });
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: { kind: 'asc' },
      select: { assignmentEpoch: true, businessStatus: true, kind: true, recipientAccountId: true },
      where: { executionContextId: fixture.contextId, kind: { in: ['N01', 'N03'] } },
    })).resolves.toEqual([
      {
        assignmentEpoch: 2n,
        businessStatus: 'OPEN',
        kind: 'N01',
        recipientAccountId: replacementAccount.id,
      },
      {
        assignmentEpoch: 1n,
        businessStatus: 'OPEN',
        kind: 'N03',
        recipientAccountId: fixture.accountId,
      },
    ]);
  }, 20_000);

  test('serializes grouped driver assignment before execution close without a lock-order cycle', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'grouped-driver-close-race');
    const replacementAccount = await prisma.driverAccount.create({
      data: {
        name: 'Synthetic close-race account',
        phone: `+82${randomUUID().replaceAll('-', '').slice(0, 15)}`,
        status: 'ACTIVE',
      },
    });
    const replacementDriver = await prisma.driver.create({
      data: {
        accountId: replacementAccount.id,
        displayName: 'Synthetic close-race driver',
        shopId: fixture.shopId,
        status: 'ACTIVE',
      },
    });
    const assignmentClient = namedClient('dsv_grouped_close_assignment');
    const blockerClient = namedClient('dsv_grouped_close_blocker');
    const closeClient = namedClient('dsv_grouped_close_execution');
    let releaseRouteLock!: () => void;
    let routeLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseRouteLock = resolve; });
    const locked = new Promise<void>((resolve) => { routeLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM route_plans
        WHERE id = ${fixture.routePlanId}::uuid
        FOR UPDATE
      `;
      routeLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    let assigned;
    let closed;
    try {
      const assignment = new PrismaRoutePlanRepository(assignmentClient, { allowAnyShopDomain: true })
        .assignRoutePlanDriver({
          payload: { driverId: replacementDriver.id },
          routePlanId: fixture.routePlanId,
          shopDomain: fixture.shopDomain,
        });
      await waitForLockedApplication(prisma, 'dsv_grouped_close_assignment');
      const close = closeClient.$transaction((transaction) => (
        new PrismaDsvExecutionContextService(transaction).closeForRoute({
          now: new Date('2026-10-06T00:10:00.000Z'),
          reason: 'COMPLETED',
          routePlanId: fixture.routePlanId,
          shopId: fixture.shopId,
        })
      ));
      await waitForLockedApplication(prisma, 'dsv_grouped_close_execution');
      releaseRouteLock();
      [assigned, closed] = await Promise.all([assignment, close]);
      await blocker;
    } finally {
      releaseRouteLock();
      await Promise.allSettled([
        blocker,
        assignmentClient.$disconnect(),
        blockerClient.$disconnect(),
        closeClient.$disconnect(),
      ]);
    }

    expect(assigned).toMatchObject({ routePlan: { driverId: replacementDriver.id } });
    expect(closed).toMatchObject({ executionContextId: fixture.contextId, outcome: 'ACCEPT', status: 'COMPLETED' });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        assignmentEpoch: 2n,
        driverId: replacementDriver.id,
        recipientAccountId: replacementAccount.id,
        status: 'COMPLETED',
      });
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId },
    })).resolves.toBe(0);
  }, 20_000);

  test('rejects a reused command id with a different fence and keeps the winning state', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'command-mismatch');
    const service = commandService(prisma);
    const input = startInput(fixture);
    const first = await service.start(input);

    await expect(service.start({ ...input, routeVersion: input.routeVersion + 1 }))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(prisma.dsvExecutionCommand.findFirstOrThrow({
      where: { commandId: input.commandId, commandName: 'START_EXECUTION', shopId: fixture.shopId },
    })).resolves.toMatchObject({ result: first });
    await expect(prisma.driverEvent.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(2);
  });

  test('rolls back the first event when the second start event fails', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'start-rollback');
    const repository = new PrismaDriverEventRepository(prisma);
    let calls = 0;
    const failingPort: DsvExecutionDriverEventPort = {
      recordDriverEventInTransaction: async (transaction, input, options) => {
        calls += 1;
        if (calls === 2) throw new Error('synthetic second event failure');
        return repository.recordDriverEventInTransaction(transaction, input, options);
      },
    };
    const service = new PrismaDsvExecutionCommandsService(prisma, failingPort);

    await expect(service.start(startInput(fixture))).rejects.toThrow('synthetic second event failure');
    await expect(prisma.driverEvent.count({ where: { routePlanId: fixture.routePlanId } })).resolves.toBe(0);
    await expect(prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } })).resolves.toBe(0);
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ status: 'READY' });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderStatus: 'REMINDER_ACTIVE', startedAt: null });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: fixture.warningId } }))
      .resolves.toMatchObject({ businessStatus: 'OPEN', resolvedAt: null });
  });

  test('rejects foreign tenant and account identities before command writes', async () => {
    const owner = await createOperationalFixture(prisma, createdShopIds, 'owner');
    const foreign = await createOperationalFixture(prisma, createdShopIds, 'foreign');
    const service = commandService(prisma);

    await expect(service.start({
      ...startInput(owner),
      accountId: foreign.accountId,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.start({
      ...startInput(owner),
      commandId: randomUUID(),
      driverId: foreign.driverId,
    })).rejects.toMatchObject({ code: 'ASSIGNMENT_CHANGED' });
    await expect(service.start({
      ...startInput(owner),
      commandId: randomUUID(),
      shopDomain: foreign.shopDomain,
      shopId: foreign.shopId,
    })).rejects.toMatchObject({ code: 'CONTEXT_NOT_FOUND' });
    await expect(prisma.dsvExecutionCommand.count({ where: { shopId: { in: [owner.shopId, foreign.shopId] } } }))
      .resolves.toBe(0);
  });

  test('stores N07 separately from delivery failure and rolls both writes back if intent storage fails', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delivery-exception');
    const service = commandService(prisma);
    const input = reportInput(fixture);

    const first = await service.reportDeliveryException(input);
    const replay = await service.reportDeliveryException(input);

    expect(replay).toEqual({ ...first, duplicate: true });
    await expect(prisma.dsvDeliveryException.count({ where: { executionContextId: fixture.contextId } }))
      .resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: first.notificationId } }))
      .resolves.toMatchObject({ audience: 'OPS', businessStatus: 'OPEN', kind: 'N07' });
    await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }))
      .resolves.toMatchObject({ status: 'PENDING' });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }))
      .resolves.toMatchObject({ deliveryStatus: 'PENDING' });
    await expect(prisma.driverEvent.count({
      where: { deliveryStopId: fixture.stopId, eventType: 'STOP_FAILED' },
    })).resolves.toBe(0);

    const rollbackFixture = await createOperationalFixture(prisma, createdShopIds, 'delivery-exception-rollback');
    const rollbackInput = reportInput(rollbackFixture);
    await prisma.dsvOperationalNotification.create({
      data: notificationData(rollbackFixture, `N07:${rollbackFixture.contextId}:1:${rollbackInput.commandId}`),
    });
    const before = await prisma.dsvDeliveryException.count({ where: { executionContextId: rollbackFixture.contextId } });
    await expect(service.reportDeliveryException(rollbackInput)).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.dsvDeliveryException.count({ where: { executionContextId: rollbackFixture.contextId } }))
      .resolves.toBe(before);
    await expect(prisma.dsvExecutionCommand.count({
      where: { commandId: rollbackInput.commandId, shopId: rollbackFixture.shopId },
    })).resolves.toBe(0);
  });

  test('serializes operations acknowledgement and resolution without reopening a resolved exception', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delivery-exception-race');
    const report = await commandService(prisma).reportDeliveryException(reportInput(fixture));
    const ackClient = namedClient('dsv_exception_ack');
    const resolveClient = namedClient('dsv_exception_resolve');
    const blockerClient = namedClient('dsv_exception_blocker');
    let releaseReportLock!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseReportLock = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM dsv_delivery_exceptions WHERE id = ${report.exceptionId}::uuid FOR UPDATE
      `;
      reportLocked();
      await release;
    }, { timeout: 20_000 });
    await locked;
    try {
      const acknowledged = commandService(ackClient).acknowledgeDeliveryException({
        id: report.exceptionId,
        now: new Date('2026-10-06T00:31:00.000Z'),
        shopId: fixture.shopId,
      });
      const resolved = commandService(resolveClient).resolveDeliveryException({
        id: report.exceptionId,
        now: new Date('2026-10-06T00:31:01.000Z'),
        shopId: fixture.shopId,
      });
      await waitForLockedApplications(prisma, ['dsv_exception_ack', 'dsv_exception_resolve']);
      releaseReportLock();
      await expect(Promise.all([acknowledged, resolved])).resolves.toHaveLength(2);
      await blocker;
    } finally {
      releaseReportLock();
      await Promise.allSettled([
        blocker,
        ackClient.$disconnect(),
        blockerClient.$disconnect(),
        resolveClient.$disconnect(),
      ]);
    }

    const persistedReport = await prisma.dsvDeliveryException.findUniqueOrThrow({ where: { id: report.exceptionId } });
    expect(persistedReport.status).toBe('RESOLVED');
    expect(persistedReport.resolvedAt).toBeInstanceOf(Date);
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: report.notificationId } }))
      .resolves.toMatchObject({ businessStatus: 'RESOLVED', resolutionReason: 'OPERATIONS_RESOLVED' });
    await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }))
      .resolves.toMatchObject({ status: 'PENDING' });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }))
      .resolves.toMatchObject({ deliveryStatus: 'PENDING' });
  }, 20_000);

  test('keeps N07 open through start, reassignment, and completion until operations resolves it', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'delivery-exception-lifecycle');
    const service = commandService(prisma);
    const report = await service.reportDeliveryException(reportInput(fixture));
    const n04 = await prisma.dsvOperationalNotification.create({
      data: {
        ...notificationData(fixture, `N04:${fixture.contextId}:1:warehouse`),
        kind: 'N04',
      },
    });

    await service.start(startInput(fixture));
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: { kind: 'asc' },
      select: { businessStatus: true, id: true, kind: true },
      where: { id: { in: [fixture.warningId, n04.id, report.notificationId] } },
    })).resolves.toEqual([
      { businessStatus: 'RESOLVED', id: n04.id, kind: 'N04' },
      { businessStatus: 'RESOLVED', id: fixture.warningId, kind: 'N05' },
      { businessStatus: 'OPEN', id: report.notificationId, kind: 'N07' },
    ]);

    const replacementAccount = await prisma.driverAccount.create({
      data: { name: 'Synthetic replacement', phone: `+82${randomUUID().replaceAll('-', '').slice(0, 15)}`, status: 'ACTIVE' },
    });
    const replacementDriver = await prisma.driver.create({
      data: { accountId: replacementAccount.id, displayName: 'Synthetic replacement', shopId: fixture.shopId, status: 'ACTIVE' },
    });
    await prisma.$transaction([
      prisma.routePlan.update({ data: { driverId: replacementDriver.id }, where: { id: fixture.routePlanId } }),
      prisma.routeGroupingChildVersion.update({ data: { driverId: replacementDriver.id }, where: { id: fixture.childVersionId } }),
    ]);
    await prisma.$transaction((transaction) => new PrismaDsvExecutionContextService(transaction).syncForRoute({
      commandId: randomUUID(),
      now: new Date('2026-10-06T00:32:00.000Z'),
      routePlanId: fixture.routePlanId,
      shopId: fixture.shopId,
    }));
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: report.notificationId } }))
      .resolves.toMatchObject({ businessStatus: 'OPEN' });

    await prisma.$transaction((transaction) => new PrismaDsvExecutionContextService(transaction).closeForRoute({
      commandId: randomUUID(),
      now: new Date('2026-10-06T00:33:00.000Z'),
      reason: 'COMPLETED',
      routePlanId: fixture.routePlanId,
      shopId: fixture.shopId,
    }));
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: report.notificationId } }))
      .resolves.toMatchObject({ businessStatus: 'OPEN' });
    await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stopId } }))
      .resolves.toMatchObject({ status: 'PENDING' });

    await service.resolveDeliveryException({
      id: report.exceptionId,
      now: new Date('2026-10-06T00:34:00.000Z'),
      shopId: fixture.shopId,
    });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: report.notificationId } }))
      .resolves.toMatchObject({ businessStatus: 'RESOLVED', resolutionReason: 'OPERATIONS_RESOLVED' });
  });

  test('closes an existing N06 at a terminal stop and rejects later reports or N06 creation', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'terminal-stop-fence');
    const commands = commandService(prisma);
    const report = await commands.reportDeliveryException(reportInput(fixture));
    const candidate = await prisma.dsvOperationalNotification.create({
      data: {
        ...notificationData(fixture, `N06:${fixture.contextId}:1:${fixture.stopId}:1`),
        kind: 'N06',
        targetStopId: fixture.stopId,
      },
    });
    const routePlans = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
    await expect(routePlans.transitionAdminRouteStop({
      actor: 'synthetic-operator',
      appId: 'clever',
      deliveryStopId: fixture.stopId,
      payload: { idempotencyKey: randomUUID(), status: 'COMPLETED' },
      routePlanId: fixture.routePlanId,
      shopDomain: fixture.shopDomain,
    })).resolves.toMatchObject({ status: { deliveryStopStatus: 'DELIVERED' } });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({ businessStatus: 'RESOLVED', resolutionReason: 'STOP_TERMINAL' });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: report.notificationId } }))
      .resolves.toMatchObject({ businessStatus: 'OPEN', kind: 'N07' });
    await expect(commands.reportDeliveryException({
      ...reportInput(fixture),
      commandId: randomUUID(),
    })).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });

    await enableSyntheticGeofence(prisma, fixture, 'LIVE');
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const service = new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('LIVE') });
    for (const observedAt of [
      new Date('2026-10-06T00:40:00.000Z'),
      new Date('2026-10-06T00:40:10.000Z'),
    ]) {
      const stored = await telemetry.recordSample(telemetryInput(
        fixture,
        observedAt,
        ['37.5000000', '127.0000000'],
      ));
      const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
      await makeGeofenceJobDue(prisma, job.id, observedAt);
      await service.process(job.id, new Date(observedAt.getTime() + 1_000));
    }
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N06' },
    })).resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N06' },
    })).resolves.toBe(0);
  });

  test('persists UVIS jobs atomically and resumes geofence state across service restarts', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'geofence-restart');
    await enableSyntheticGeofence(prisma, fixture, 'SHADOW');
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const times = [0, 10, 20, 30].map((seconds) => new Date(Date.parse('2026-10-06T00:10:00.000Z') + seconds * 1_000));
    const coordinates = [
      ['37.4900000', '127.0100000'],
      ['37.4900000', '127.0100000'],
      ['37.5200000', '127.0300000'],
      ['37.5200000', '127.0300000'],
    ] as const;
    const sampleIds: string[] = [];

    for (const [index, observedAt] of times.entries()) {
      const stored = await telemetry.recordSample(telemetryInput(fixture, observedAt, coordinates[index]!));
      sampleIds.push(stored.sampleId);
      const duplicate = await telemetry.recordSample(telemetryInput(fixture, observedAt, coordinates[index]!));
      expect(duplicate).toMatchObject({ sampleId: stored.sampleId, sampleStatus: 'DUPLICATE' });
      const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
      await makeGeofenceJobDue(prisma, job.id, observedAt);
      const serviceAfterRestart = new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('SHADOW') });
      await expect(serviceAfterRestart.process(job.id, new Date(observedAt.getTime() + 1_000)))
        .resolves.toMatchObject({ executionContextId: fixture.contextId, status: 'PROCESSED' });
    }

    await expect(prisma.dsvGeofenceJob.count({ where: { shopId: fixture.shopId } })).resolves.toBe(4);
    await expect(prisma.dsvGeofenceEvent.findMany({
      orderBy: { confirmedObservedAt: 'asc' },
      select: {
        confirmedAt: true,
        confirmedObservedAt: true,
        transition: true,
        firstObservedAt: true,
        sourceSampleId: true,
      },
      where: { executionContextId: fixture.contextId, targetKey: 'DEPOT' },
    })).resolves.toEqual([
      {
        confirmedAt: new Date(times[1]!.getTime() + 1_000),
        confirmedObservedAt: times[1],
        transition: 'ARRIVED',
        firstObservedAt: times[0],
        sourceSampleId: sampleIds[1],
      },
      {
        confirmedAt: new Date(times[3]!.getTime() + 1_000),
        confirmedObservedAt: times[3],
        transition: 'DEPARTED',
        firstObservedAt: times[2],
        sourceSampleId: sampleIds[3],
      },
    ]);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        departureObservedAt: times[3],
        reminderDueAt: new Date(times[3]!.getTime() + 300_000),
        reminderStatus: 'REMINDER_ACTIVE',
      });
    const stateBeforeLate = await prisma.dsvGeofenceState.findUniqueOrThrow({
      where: {
        executionContextId_assignmentEpoch_targetKey: {
          assignmentEpoch: 1n,
          executionContextId: fixture.contextId,
          targetKey: 'DEPOT',
        },
      },
    });
    const lateAt = new Date('2026-10-06T00:10:15.000Z');
    const late = await telemetry.recordSample(telemetryInput(fixture, lateAt, ['37.4900000', '127.0100000']));
    const lateJob = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: late.sampleId } });
    await makeGeofenceJobDue(prisma, lateJob.id, lateAt);
    await new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('SHADOW') })
      .process(lateJob.id, new Date('2026-10-06T00:11:00.000Z'));
    await expect(prisma.dsvGeofenceState.findUniqueOrThrow({ where: { id: stateBeforeLate.id } }))
      .resolves.toMatchObject({ state: stateBeforeLate.state });
  });

  test('confirms a persisted warehouse exit from one sample and emits one reminder at T plus 300 seconds', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'single-sample-departure');
    const policy: DsvGeofencePolicy = {
      ...syntheticGeofencePolicy('LIVE'),
      arrivalDwellSeconds: 0,
      arrivalMinSamples: 1,
      exitDwellSeconds: 0,
      exitMinSamples: 1,
      policyVersion: 'synthetic-single-sample-v1',
    };
    const insideAt = new Date('2026-10-06T00:09:50.000Z');
    const departedAt = new Date('2026-10-06T00:10:00.000Z');
    await enableSyntheticGeofence(prisma, fixture, 'LIVE');
    await prisma.dsvExecutionContext.update({
      data: {
        departureObservedAt: null,
        liveEligibleAt: insideAt,
        policy,
        reminderDueAt: null,
        reminderIncidentId: null,
        reminderOrdinal: 0,
        reminderStatus: 'AWAITING_DEPARTURE',
      },
      where: { id: fixture.contextId },
    });
    await prisma.dsvOperationalNotification.updateMany({
      data: { businessStatus: 'RESOLVED', resolutionReason: 'SYNTHETIC_SINGLE_SAMPLE_BASELINE', resolvedAt: insideAt },
      where: { executionContextId: fixture.contextId, kind: 'N05' },
    });
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const inside = await telemetry.recordSample(telemetryInput(
      fixture,
      insideAt,
      ['37.4900000', '127.0100000'],
    ));
    const insideJob = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: inside.sampleId } });
    await makeGeofenceJobDue(prisma, insideJob.id, insideAt);
    await expect(new PrismaDsvGeofenceService(prisma, { policy }).process(
      insideJob.id,
      new Date(insideAt.getTime() + 1_000),
    )).resolves.toMatchObject({ status: 'PROCESSED' });
    await expect(prisma.dsvGeofenceState.findUniqueOrThrow({
      where: {
        executionContextId_assignmentEpoch_targetKey: {
          assignmentEpoch: 1n,
          executionContextId: fixture.contextId,
          targetKey: 'DEPOT',
        },
      },
    })).resolves.toMatchObject({ state: { geofence: { phase: 'INSIDE', visitOrdinal: 1 } } });

    const departed = await telemetry.recordSample(telemetryInput(
      fixture,
      departedAt,
      ['37.5200000', '127.0300000'],
    ));
    const departedJob = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: departed.sampleId } });
    await makeGeofenceJobDue(prisma, departedJob.id, departedAt);
    await expect(new PrismaDsvGeofenceService(prisma, { policy }).process(
      departedJob.id,
      new Date(departedAt.getTime() + 1_000),
    )).resolves.toMatchObject({ status: 'PROCESSED' });
    await expect(new PrismaDsvGeofenceService(prisma, { policy }).process(
      departedJob.id,
      new Date(departedAt.getTime() + 2_000),
    )).resolves.toMatchObject({ reason: 'NOT_CLAIMED', status: 'DEFERRED' });
    await expect(prisma.dsvGeofenceEvent.findMany({
      select: { confirmedObservedAt: true, firstObservedAt: true, sourceSampleId: true, transition: true },
      where: { executionContextId: fixture.contextId, targetKey: 'DEPOT', transition: 'DEPARTED' },
    })).resolves.toEqual([{
      confirmedObservedAt: departedAt,
      firstObservedAt: departedAt,
      sourceSampleId: departed.sampleId,
      transition: 'DEPARTED',
    }]);
    const dueAt = new Date(departedAt.getTime() + 300_000);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ departureObservedAt: departedAt, reminderDueAt: dueAt, reminderOrdinal: 0 });
    const restarted = new PrismaDsvGeofenceService(prisma, { policy });
    await expect(restarted.tickReminders(new Date(dueAt.getTime() - 1))).resolves.toBe(0);
    await expect(restarted.tickReminders(dueAt)).resolves.toBe(1);
    await expect(restarted.tickReminders(dueAt)).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(1);
    await prisma.dsvExecutionContext.update({
      data: { reminderDueAt: null, reminderStatus: 'ENDED' },
      where: { id: fixture.contextId },
    });
  });

  test('does not catch up missed business reminders in a burst', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'reminder-no-catchup');
    await enableSyntheticGeofence(prisma, fixture, 'LIVE');
    const dueAt = new Date('2026-10-06T00:15:00.000Z');
    await prisma.dsvExecutionContext.update({
      data: {
        departureObservedAt: new Date(dueAt.getTime() - 300_000),
        reminderDueAt: dueAt,
        reminderStatus: 'REMINDER_ACTIVE',
      },
      where: { id: fixture.contextId },
    });
    const recoveredAt = new Date('2026-10-06T00:45:00.000Z');
    const service = new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('LIVE') });
    const initialCount = await prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N05' },
    });

    await expect(service.tickReminders(recoveredAt)).resolves.toBe(1);
    await expect(service.tickReminders(recoveredAt)).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(initialCount + 1);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        reminderDueAt: new Date(recoveredAt.getTime() + 300_000),
        reminderOrdinal: 1,
      });
    await expect(service.tickReminders(new Date(recoveredAt.getTime() + 300_000))).resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(initialCount + 2);
  });

  test('does not create an old reminder at LIVE activation and accepts a fresh departure afterward', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'live-activation-departure');
    await enableSyntheticGeofence(prisma, fixture, 'LIVE');
    await prisma.dsvOperationalNotification.updateMany({
      data: { businessStatus: 'RESOLVED', resolutionReason: 'SYNTHETIC_ACTIVATION_BASELINE', resolvedAt: new Date('2026-10-06T00:25:00.000Z') },
      where: { executionContextId: fixture.contextId, kind: 'N05' },
    });
    await prisma.dsvExecutionContext.update({
      data: {
        departureObservedAt: new Date('2026-10-06T00:20:00.000Z'),
        liveEligibleAt: new Date('2026-10-06T00:25:30.000Z'),
        reminderDueAt: new Date('2026-10-06T00:25:00.000Z'),
        reminderStatus: 'REMINDER_ACTIVE',
      },
      where: { id: fixture.contextId },
    });
    const service = new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('LIVE') });
    await expect(service.tickReminders(new Date('2026-10-06T00:25:00.000Z'))).resolves.toBe(0);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderDueAt: null, reminderStatus: 'STALE_ACTIVATION' });
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(0);

    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const observations = [
      { at: new Date('2026-10-06T00:26:00.000Z'), coordinates: ['37.4900000', '127.0100000'] as const },
      { at: new Date('2026-10-06T00:26:10.000Z'), coordinates: ['37.4900000', '127.0100000'] as const },
      { at: new Date('2026-10-06T00:27:00.000Z'), coordinates: ['37.5200000', '127.0300000'] as const },
      { at: new Date('2026-10-06T00:27:10.000Z'), coordinates: ['37.5200000', '127.0300000'] as const },
    ];
    for (const observation of observations) {
      const stored = await telemetry.recordSample(telemetryInput(fixture, observation.at, observation.coordinates));
      const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
      await makeGeofenceJobDue(prisma, job.id, observation.at);
      await service.process(job.id, new Date(observation.at.getTime() + 1_000));
    }
    const dueAt = new Date('2026-10-06T00:32:10.000Z');
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        departureObservedAt: new Date('2026-10-06T00:27:10.000Z'),
        reminderDueAt: dueAt,
        reminderStatus: 'REMINDER_ACTIVE',
      });
    await expect(service.tickReminders(dueAt)).resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(1);
  });

  test('pauses reminders on warehouse reentry and resumes from a fresh cross-midnight departure', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'warehouse-reentry-resume');
    await enableSyntheticGeofence(prisma, fixture, 'LIVE');
    await prisma.dsvExecutionContext.update({
      data: { monitorEndAt: new Date('2026-10-07T01:00:00.000Z') },
      where: { id: fixture.contextId },
    });
    await prisma.dsvExecutionContext.updateMany({
      data: { reminderDueAt: null },
      where: { id: { not: fixture.contextId } },
    });
    await prisma.dsvOperationalNotification.update({
      data: {
        businessStatus: 'RESOLVED',
        resolutionReason: 'SYNTHETIC_REENTRY_BASELINE',
        resolvedAt: new Date('2026-10-06T23:47:00.000Z'),
      },
      where: { id: fixture.warningId },
    });
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const service = new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('LIVE') });
    const processObservation = async (
      observedAt: Date,
      coordinates: readonly [string, string],
    ): Promise<void> => {
      const stored = await telemetry.recordSample(telemetryInput(fixture, observedAt, coordinates));
      const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
      await makeGeofenceJobDue(prisma, job.id, observedAt);
      await expect(service.process(job.id, new Date(observedAt.getTime() + 1_000)))
        .resolves.toMatchObject({ status: 'PROCESSED' });
    };
    const depot = ['37.4900000', '127.0100000'] as const;
    const outside = ['37.5200000', '127.0300000'] as const;

    await processObservation(new Date('2026-10-06T23:48:00.000Z'), depot);
    await processObservation(new Date('2026-10-06T23:48:10.000Z'), depot);
    await processObservation(new Date('2026-10-06T23:49:00.000Z'), outside);
    await processObservation(new Date('2026-10-06T23:49:10.000Z'), outside);
    const firstDueAt = new Date('2026-10-06T23:54:10.000Z');
    await expect(service.tickReminders(new Date(firstDueAt.getTime() - 1))).resolves.toBe(0);
    await expect(service.tickReminders(firstDueAt)).resolves.toBe(1);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderOrdinal: 1, reminderStatus: 'REMINDER_ACTIVE' });

    await processObservation(new Date('2026-10-06T23:55:00.000Z'), depot);
    await processObservation(new Date('2026-10-06T23:55:10.000Z'), depot);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        departureObservedAt: new Date('2026-10-06T23:49:10.000Z'),
        reminderDueAt: null,
        reminderOrdinal: 1,
        reminderStatus: 'PAUSED_WAREHOUSE_RETURN',
      });
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N04' },
    })).resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(0);

    await processObservation(new Date('2026-10-07T00:00:00.000Z'), outside);
    await processObservation(new Date('2026-10-07T00:00:10.000Z'), outside);
    const secondDueAt = new Date('2026-10-07T00:05:10.000Z');
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({
        departureObservedAt: new Date('2026-10-07T00:00:10.000Z'),
        reminderDueAt: secondDueAt,
        reminderOrdinal: 1,
        reminderStatus: 'REMINDER_ACTIVE',
      });
    await expect(service.tickReminders(new Date(secondDueAt.getTime() - 1))).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(0);
    await expect(service.tickReminders(secondDueAt)).resolves.toBe(1);
    await expect(prisma.dsvOperationalNotification.count({
      where: { businessStatus: 'OPEN', executionContextId: fixture.contextId, kind: 'N05' },
    })).resolves.toBe(1);
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderOrdinal: 2 });
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: 'N04' },
    })).resolves.toBe(1);
  });

  test('rolls back geofence state when processing fails and leaves the job retryable', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'geofence-rollback');
    await enableSyntheticGeofence(prisma, fixture, 'SHADOW');
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const observedAt = new Date('2026-10-06T00:20:00.000Z');
    const stored = await telemetry.recordSample(telemetryInput(fixture, observedAt, ['37.4900000', '127.0100000']));
    const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
    await makeGeofenceJobDue(prisma, job.id, observedAt);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION dsv_operational_test_fail_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic geofence state failure'; END $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER dsv_operational_test_fail_state_trigger
      BEFORE INSERT OR UPDATE ON dsv_geofence_states
      FOR EACH ROW EXECUTE FUNCTION dsv_operational_test_fail_state();
    `);
    try {
      await expect(new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('SHADOW') })
        .process(job.id, new Date('2026-10-06T00:20:01.000Z'))).rejects.toThrow('synthetic geofence state failure');
      await expect(prisma.dsvGeofenceState.count({ where: { executionContextId: fixture.contextId } })).resolves.toBe(0);
      await expect(prisma.dsvGeofenceEvent.count({ where: { executionContextId: fixture.contextId } })).resolves.toBe(0);
      await expect(prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
        attemptCount: 1,
        leaseToken: null,
        resultReason: 'PROCESSING_ERROR',
        status: 'PENDING',
      });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dsv_operational_test_fail_state_trigger ON dsv_geofence_states');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_operational_test_fail_state()');
    }
  });

  test('revalidates a geofence observation after a concurrent context rebind', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'geofence-context-rebind');
    const sibling = await createSiblingPublishedRoute(prisma, fixture, 'geofence-context-rebind-sibling');
    await enableSyntheticGeofence(prisma, fixture, 'SHADOW');
    const observedAt = new Date('2026-10-06T00:10:00.000Z');
    const stored = await new PrismaUvisTelemetryRepository(prisma).recordSample(telemetryInput(
      fixture,
      observedAt,
      ['37.4900000', '127.0100000'],
    ));
    const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
    await makeGeofenceJobDue(prisma, job.id, observedAt);
    const processorClient = namedClient('dsv_geofence_stale_reader');
    const blockerClient = namedClient('dsv_geofence_rebind_writer');
    let releaseContextLock!: () => void;
    let contextLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseContextLock = resolve; });
    const locked = new Promise<void>((resolve) => { contextLocked = resolve; });
    const rebindAt = new Date(observedAt.getTime() + 1);
    const blocker = blockerClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM dsv_execution_contexts WHERE id = ${fixture.contextId}::uuid FOR UPDATE
      `;
      contextLocked();
      await release;
      await transaction.dsvExecutionRouteMapping.updateMany({
        data: { validUntil: rebindAt },
        where: { executionContextId: fixture.contextId, shopId: fixture.shopId, validUntil: null },
      });
      await transaction.dsvExecutionRouteMapping.create({
        data: {
          executionContextId: fixture.contextId,
          routePlanId: sibling.routePlanId,
          shopId: fixture.shopId,
          validFrom: rebindAt,
        },
      });
      await transaction.dsvExecutionContext.update({
        data: {
          contentFingerprint: `concurrent-rebind-${randomUUID()}`,
          effectiveAt: rebindAt,
          routePlanId: sibling.routePlanId,
          routeVersion: { increment: 1 },
        },
        where: { id: fixture.contextId },
      });
    }, { timeout: 20_000 });
    await locked;
    try {
      const processing = new PrismaDsvGeofenceService(processorClient, { policy: syntheticGeofencePolicy('SHADOW') })
        .process(job.id, new Date(observedAt.getTime() + 1_000));
      await waitForLockedApplication(prisma, 'dsv_geofence_stale_reader');
      releaseContextLock();
      await expect(processing).resolves.toMatchObject({ reason: 'CONTEXT_CHANGED', status: 'DEFERRED' });
      await blocker;
    } finally {
      releaseContextLock();
      await Promise.allSettled([blocker, blockerClient.$disconnect(), processorClient.$disconnect()]);
    }
    await expect(prisma.dsvGeofenceState.count({ where: { executionContextId: fixture.contextId } })).resolves.toBe(0);
    await expect(prisma.dsvGeofenceEvent.count({ where: { executionContextId: fixture.contextId } })).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({
      where: { executionContextId: fixture.contextId, kind: { in: ['N04', 'N05', 'N06'] } },
    })).resolves.toBe(1);
  }, 20_000);

  test('defers one vehicle observation when multiple executions are eligible without selection', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'ambiguous-context');
    await enableSyntheticGeofence(prisma, fixture, 'SHADOW');
    const secondRoute = await prisma.routePlan.create({
      data: {
        constraints: {}, driverId: fixture.driverId, metrics: {}, name: 'Synthetic afternoon route',
        optimizerVersion: 'dsv-operational-integration', planDate: new Date('2026-10-06T00:00:00.000Z'),
        shopId: fixture.shopId, status: 'READY', vehicleId: fixture.vehicleId,
      },
    });
    const secondContext = await prisma.dsvExecutionContext.create({
      data: {
        assignmentEpoch: 1n, contentFingerprint: 'afternoon', contentSnapshot: { depot: null, stops: [] },
        driverId: fixture.driverId, effectiveAt: new Date('2026-10-06T00:00:00.000Z'), notificationMode: 'SHADOW',
        policy: syntheticGeofencePolicy('SHADOW'), recipientAccountId: fixture.accountId, reminderStatus: 'AWAITING_DEPARTURE',
        routePlanId: secondRoute.id, routeVersion: 1, serviceDate: new Date('2026-10-06T00:00:00.000Z'),
        shopId: fixture.shopId, status: 'ACTIVE', vehicleId: fixture.vehicleId,
      },
    });
    await prisma.dsvExecutionRouteMapping.create({
      data: { executionContextId: secondContext.id, routePlanId: secondRoute.id, shopId: fixture.shopId, validFrom: new Date('2026-10-06T00:00:00.000Z') },
    });
    const telemetry = new PrismaUvisTelemetryRepository(prisma);
    const stored = await telemetry.recordSample(telemetryInput(
      fixture,
      new Date('2026-10-06T00:10:00.000Z'),
      ['37.4900000', '127.0100000'],
    ));
    const job = await prisma.dsvGeofenceJob.findUniqueOrThrow({ where: { sampleId: stored.sampleId } });
    await makeGeofenceJobDue(prisma, job.id, new Date('2026-10-06T00:10:00.000Z'));

    await expect(new PrismaDsvGeofenceService(prisma, { policy: syntheticGeofencePolicy('SHADOW') })
      .process(job.id, new Date('2026-10-06T00:10:01.000Z'))).resolves.toMatchObject({
        reason: 'AMBIGUOUS_EXECUTION_CONTEXT',
        status: 'DEFERRED',
      });
    await expect(prisma.dsvGeofenceState.count({ where: { shopId: fixture.shopId } })).resolves.toBe(0);
    await expect(prisma.dsvOperationalNotification.count({ where: { shopId: fixture.shopId, kind: { in: ['N04', 'N06'] } } }))
      .resolves.toBe(0);
  });

  test('reclaims an expired send lease and rejects the late worker completion', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'notification-lease');
    const now = new Date('2026-10-06T01:00:00.000Z');
    const notification = await prepareLiveNotification(prisma, fixture, now);
    let firstClock = now;
    let releaseFirst!: (result: DsvOperationalPushResult) => void;
    let firstCalled!: () => void;
    const firstReached = new Promise<void>((resolve) => { firstCalled = resolve; });
    const delayedProvider: DsvOperationalPushProvider = {
      providerName: 'synthetic-delayed',
      send: () => {
        firstCalled();
        return new Promise((resolve) => { releaseFirst = resolve; });
      },
    };
    const secondMessages: string[] = [];
    const secondProvider: DsvOperationalPushProvider = {
      providerName: 'synthetic-second-worker',
      send: (message) => {
        secondMessages.push(message.payload.notificationId);
        return Promise.resolve({ providerMessageId: 'synthetic-second', status: 'SENT' });
      },
    };
    const firstService = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      delayedProvider,
      liveSendPolicy(fixture),
      { clock: () => firstClock, leaseMs: 1_000 },
    );
    const secondService = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      secondProvider,
      liveSendPolicy(fixture),
      { clock: () => new Date(now.getTime() + 2_100), leaseMs: 1_000 },
    );

    const firstRun = firstService.runOnce(now);
    await firstReached;
    const secondRun = await secondService.runOnce(new Date(now.getTime() + 2_000));
    firstClock = new Date(now.getTime() + 2_500);
    releaseFirst({ errorCode: 'TOKEN_INVALID', invalidToken: true, status: 'FAILED' });
    const lateResult = await firstRun;

    expect(secondRun).toMatchObject({ attempted: 1, sent: 1 });
    expect(lateResult).toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    expect(secondMessages).toEqual([notification.id]);
    await expect(prisma.dsvOperationalNotificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    })).resolves.toMatchObject({
      attemptCount: 2,
      providerMessageId: 'synthetic-second',
      status: 'SENT',
    });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderOrdinal: 0 });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: notification.id } }))
      .resolves.toMatchObject({ ordinal: 1 });
    await expect(prisma.driverPushToken.findFirstOrThrow({ where: { accountId: fixture.accountId } }))
      .resolves.toMatchObject({ revokedAt: null, status: 'ACTIVE' });
  });

  test('retries a transient provider failure without incrementing the business reminder ordinal', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'notification-retry');
    const now = new Date('2026-10-06T01:30:00.000Z');
    const notification = await prepareLiveNotification(prisma, fixture, now);
    let clock = now;
    let providerCalls = 0;
    const provider: DsvOperationalPushProvider = {
      providerName: 'synthetic-transient-then-success',
      send: () => {
        providerCalls += 1;
        return Promise.resolve(providerCalls === 1
          ? { errorCode: 'SYNTHETIC_TRANSIENT', status: 'FAILED' }
          : { providerMessageId: 'synthetic-retry-success', status: 'SENT' });
      },
    };
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      provider,
      liveSendPolicy(fixture),
      { clock: () => clock },
    );

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    const retryAt = new Date(now.getTime() + liveSendPolicy(fixture).retryDelayMs);
    await expect(prisma.dsvOperationalNotificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    })).resolves.toMatchObject({
      attemptCount: 1,
      errorCode: 'SYNTHETIC_TRANSIENT',
      nextAttemptAt: retryAt,
      status: 'RETRY',
    });

    clock = new Date(retryAt.getTime() - 1);
    await expect(service.runOnce(clock)).resolves.toMatchObject({ attempted: 0, sent: 0 });
    clock = retryAt;
    await expect(service.runOnce(clock)).resolves.toMatchObject({ attempted: 1, sent: 1 });
    expect(providerCalls).toBe(2);
    await expect(prisma.dsvOperationalNotificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    })).resolves.toMatchObject({
      attemptCount: 2,
      providerMessageId: 'synthetic-retry-success',
      status: 'SENT',
    });
    await expect(prisma.dsvOperationalNotification.findUniqueOrThrow({ where: { id: notification.id } }))
      .resolves.toMatchObject({ ordinal: 1 });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ reminderOrdinal: 0 });
  });

  test('keeps future N01 service dates identical in inbox and provider retries across midnight', async () => {
    const fixtures = await Promise.all([
      createOperationalFixture(prisma, createdShopIds, 'n01-date-first'),
      createOperationalFixture(prisma, createdShopIds, 'n01-date-second'),
    ]);
    const sendAt = new Date('2026-12-31T23:59:50.000Z');
    const retryAt = new Date('2027-01-01T00:00:20.000Z');
    const serviceDates = [
      new Date('2027-01-02T00:00:00.000Z'),
      new Date('2027-01-03T00:00:00.000Z'),
    ];
    const expectedTitles = ['1월 2일 배차가 등록되었습니다.', '1월 3일 배차가 등록되었습니다.'];
    const notifications: Array<{ id: string }> = [];
    const registrationService = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      { providerName: 'synthetic-registration', send: () => Promise.resolve({ status: 'SKIPPED' }) },
    );
    for (const [index, fixture] of fixtures.entries()) {
      await prisma.dsvExecutionContext.update({
        data: {
          liveEligibleAt: new Date(sendAt.getTime() - 1_000),
          monitorEndAt: new Date(sendAt.getTime() + 3_600_000),
          monitorStartAt: new Date(sendAt.getTime() - 3_600_000),
          notificationMode: 'LIVE',
          policy: { authorizationId: 'synthetic-authorization', policyVersion: 'synthetic-v1' },
          serviceDate: serviceDates[index]!,
        },
        where: { id: fixture.contextId },
      });
      const token = await prisma.driverPushToken.create({
        data: {
          accountId: fixture.accountId,
          appId: DSV_OPERATIONAL_DRIVER_APP_ID,
          deviceId: `n01-install-${fixture.deviceId}`,
          devicePushToken: `n01-token-${fixture.deviceId}`,
          platform: 'android',
          status: 'ACTIVE',
          tokenHash: `n01-hash-${fixture.deviceId}`,
        },
      });
      await registrationService.registerCapability({
        installationId: `n01-install-${fixture.deviceId}`,
        kinds: ['N01'],
        now: sendAt,
        principal: driverPrincipal(fixture),
        schemaVersion: 1,
        tokenId: token.id,
      });
      notifications.push(await prisma.dsvOperationalNotification.create({
        data: {
          ...notificationData(fixture, `N01:${fixture.contextId}:1`),
          createdAt: sendAt,
          dueAt: sendAt,
          expiresAt: new Date(sendAt.getTime() + 3_600_000),
          kind: 'N01',
        },
      }));
    }
    let clock = sendAt;
    const firstNotificationId = notifications[0]!.id;
    const providerCalls = new Map<string, number>();
    const copies: Array<{ body: string; notificationId: string; title: string }> = [];
    const provider: DsvOperationalPushProvider = {
      providerName: 'synthetic-n01-midnight-retry',
      send: (message) => {
        const notificationId = message.payload.notificationId;
        copies.push({ body: message.body, notificationId, title: message.title });
        const attempt = (providerCalls.get(notificationId) ?? 0) + 1;
        providerCalls.set(notificationId, attempt);
        return Promise.resolve(notificationId === firstNotificationId && attempt === 1
          ? { errorCode: 'SYNTHETIC_TRANSIENT', status: 'FAILED' }
          : { providerMessageId: `synthetic-${notificationId}-${attempt}`, status: 'SENT' });
      },
    };
    const policy: DsvOperationalNotificationSendPolicy = {
      allowedAccountIds: fixtures.map(({ accountId }) => accountId),
      allowedKinds: ['N01'],
      allowedShopIds: fixtures.map(({ shopId }) => shopId),
      approvedAuthorizationId: 'synthetic-authorization',
      approvedGeofencePolicyVersion: 'synthetic-v1',
      businessReminderCap: 3,
      liveSendingEnabled: true,
      maxProviderAttempts: 3,
      monitorWindowMs: 7_200_000,
      notificationRetentionMs: 86_400_000,
      retryDelayMs: 30_000,
    };
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      provider,
      policy,
      { clock: () => clock },
    );

    for (const [index, fixture] of fixtures.entries()) {
      const inbox = await service.list({ now: sendAt, principal: driverPrincipal(fixture) });
      const item = inbox.items.find(({ id }) => id === notifications[index]!.id);
      expect(item?.summary).toEqual({
        body: '앱에서 새 배차를 확인해 주세요.',
        title: expectedTitles[index],
      });
    }
    await expect(service.runOnce(sendAt)).resolves.toMatchObject({ attempted: 2, sent: 1, skipped: 1 });
    clock = new Date(retryAt.getTime() - 1);
    await expect(service.runOnce(clock)).resolves.toMatchObject({ attempted: 0, sent: 0 });
    clock = retryAt;
    await expect(service.runOnce(clock)).resolves.toMatchObject({ attempted: 1, sent: 1 });

    for (const [index, notification] of notifications.entries()) {
      const notificationCopies = copies.filter(({ notificationId }) => notificationId === notification.id);
      expect(notificationCopies).toHaveLength(index === 0 ? 2 : 1);
      expect(notificationCopies.every(({ body, title }) => (
        body === '앱에서 새 배차를 확인해 주세요.' && title === expectedTitles[index]
      ))).toBe(true);
    }
  });

  test('revalidates assignment immediately before send and isolates inbox access by account and tenant', async () => {
    const owner = await createOperationalFixture(prisma, createdShopIds, 'notification-owner');
    const foreign = await createOperationalFixture(prisma, createdShopIds, 'notification-foreign');
    const now = new Date('2026-10-06T02:00:00.000Z');
    const notification = await prepareLiveNotification(prisma, owner, now);
    let providerCalls = 0;
    const provider: DsvOperationalPushProvider = {
      providerName: 'synthetic-guard',
      send: () => {
        providerCalls += 1;
        return Promise.resolve({ providerMessageId: 'must-not-send', status: 'SENT' });
      },
    };
    await prisma.dsvExecutionContext.update({
      data: { assignmentEpoch: { increment: 1 } },
      where: { id: owner.contextId },
    });
    const service = new PrismaDsvOperationalDriverNotificationService(
      prisma,
      provider,
      liveSendPolicy(owner),
      { clock: () => now },
    );

    await expect(service.runOnce(now)).resolves.toMatchObject({ attempted: 1, sent: 0, skipped: 1 });
    expect(providerCalls).toBe(0);
    await expect(prisma.dsvOperationalNotificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    })).resolves.toMatchObject({ errorCode: 'EXECUTION_CONTEXT_STALE', status: 'SKIPPED' });

    const ownerInbox = await service.list({ principal: driverPrincipal(owner), now });
    const foreignInbox = await service.list({ principal: driverPrincipal(foreign), now });
    expect(ownerInbox.items.map((item) => item.id)).toContain(notification.id);
    expect(foreignInbox.items.map((item) => item.id)).not.toContain(notification.id);
    await expect(service.ack({ notificationId: notification.id, principal: driverPrincipal(foreign), now }))
      .rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_NOT_FOUND' });
  });

  test('uses the persisted DSV driver principal for inbox, capability, and resolver authorization', async () => {
    const fixture = await createOperationalFixture(prisma, createdShopIds, 'principal-authority');
    const foreignAccount = await prisma.driverAccount.create({
      data: { name: 'Synthetic foreign account', phone: `+82${randomUUID().replaceAll('-', '').slice(0, 15)}`, status: 'ACTIVE' },
    });
    const foreignDriver = await prisma.driver.create({
      data: { accountId: foreignAccount.id, displayName: 'Synthetic foreign driver', shopId: fixture.shopId, status: 'ACTIVE' },
    });
    await prisma.dsvDriverProfile.createMany({
      data: [
        { driverId: fixture.driverId, lookupName: `OWNER-${randomUUID()}`, shopId: fixture.shopId },
        { driverId: foreignDriver.id, lookupName: `FOREIGN-${randomUUID()}`, shopId: fixture.shopId },
      ],
    });
    const principalResolver = new PrismaDsvDriverExecutionPrincipalResolver(prisma);
    const ownerAuth = await principalResolver.resolve({ accountId: fixture.accountId, tokenVersion: 0 });
    const foreignAuth = await principalResolver.resolve({ accountId: foreignAccount.id, tokenVersion: 0 });
    expect(ownerAuth.principal.scopes).toEqual(expect.arrayContaining([
      'driver:assignments:read',
      'driver:events:write',
    ]));
    const token = await prisma.driverPushToken.create({
      data: {
        accountId: fixture.accountId,
        appId: DSV_OPERATIONAL_DRIVER_APP_ID,
        deviceId: `install-${fixture.deviceId}`,
        devicePushToken: `synthetic-principal-token-${fixture.deviceId}`,
        platform: 'android',
        status: 'ACTIVE',
        tokenHash: `synthetic-principal-hash-${fixture.deviceId}`,
      },
    });
    const service = new PrismaDsvOperationalDriverNotificationService(prisma, {
      providerName: 'synthetic-principal-provider',
      send: () => Promise.resolve({ status: 'SKIPPED' }),
    });
    await expect(service.registerCapability({
      installationId: `install-${fixture.deviceId}`,
      kinds: ['N05'],
      now: new Date('2026-10-06T00:10:00.000Z'),
      principal: ownerAuth.principal,
      schemaVersion: 1,
      tokenId: token.id,
    })).resolves.toMatchObject({ kinds: ['N05'], schemaVersion: 1 });
    const inbox = await service.list({
      now: new Date('2026-10-06T00:10:00.000Z'),
      principal: ownerAuth.principal,
    });
    expect(inbox.items.map((item) => item.id)).toContain(fixture.warningId);
    await expect(service.resolve({
      notificationId: fixture.warningId,
      now: new Date('2026-10-06T00:10:00.000Z'),
      principal: ownerAuth.principal,
    })).resolves.toMatchObject({
      destination: { executionContextId: fixture.contextId, routePlanId: fixture.routePlanId, type: 'EXECUTION' },
      notificationId: fixture.warningId,
    });
    await expect(service.registerCapability({
      installationId: `install-${fixture.deviceId}`,
      kinds: ['N05'],
      principal: foreignAuth.principal,
      schemaVersion: 1,
      tokenId: token.id,
    })).rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_NOT_FOUND' });
    await expect(service.resolve({
      notificationId: fixture.warningId,
      now: new Date('2026-10-06T00:10:00.000Z'),
      principal: foreignAuth.principal,
    })).rejects.toMatchObject({ code: 'DSV_OPERATIONAL_NOTIFICATION_NOT_FOUND' });
  });
});

type OperationalFixture = {
  accountId: string;
  childVersionId: string;
  contextId: string;
  deviceId: string;
  driverId: string;
  orderId: string;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
  stopId: string;
  vehicleId: string;
  vehiclePlate: string;
  warningId: string;
};

type AccountLinkIdentity = { name: string; phone: string };

function accountLinkIdentity(name: string): AccountLinkIdentity {
  const localPhone = randomUUID().replace(/\D/gu, '').padEnd(8, '0').slice(0, 8);
  return {
    name: `Synthetic ${name.slice(0, 12)} ${randomUUID().slice(0, 8)}`,
    phone: name.startsWith('dsv-') ? `010${localPhone}` : `+8210${localPhone}`,
  };
}

async function createUnlinkedOperationalFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
  identity: AccountLinkIdentity,
  ids: { driverId?: string; routePlanId?: string } = {},
): Promise<OperationalFixture> {
  const fixture = await createOperationalFixture(prisma, createdShopIds, name, ids);
  await addDsvResourceProfiles(prisma, fixture);
  await unlinkOperationalFixture(prisma, fixture, identity);
  return fixture;
}

async function unlinkOperationalFixture(
  prisma: PrismaClient,
  fixture: OperationalFixture,
  identity: AccountLinkIdentity,
): Promise<void> {
  await prisma.$transaction([
    prisma.driver.update({
      data: { accountId: null, authSubject: null, displayName: identity.name, phone: identity.phone },
      where: { id: fixture.driverId },
    }),
    prisma.dsvExecutionContext.update({
      data: { recipientAccountId: null },
      where: { id: fixture.contextId },
    }),
    prisma.dsvOperationalNotification.updateMany({
      data: { recipientAccountId: null },
      where: { executionContextId: fixture.contextId },
    }),
  ]);
}

async function createReverseOrderedUnlinkedFixtures(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
  identity: AccountLinkIdentity,
  seed: number,
): Promise<[OperationalFixture, OperationalFixture]> {
  const driverLow = seed.toString().padStart(12, '0');
  const driverHigh = (seed + 1).toString().padStart(12, '0');
  const routeLow = (seed + 100).toString().padStart(12, '0');
  const routeHigh = (seed + 101).toString().padStart(12, '0');
  return Promise.all([
    createUnlinkedOperationalFixture(prisma, createdShopIds, `${name}-a`, identity, {
      driverId: `87010600-0000-4000-8000-${driverLow}`,
      routePlanId: `87010600-0000-4000-8000-${routeHigh}`,
    }),
    createUnlinkedOperationalFixture(prisma, createdShopIds, `${name}-b`, identity, {
      driverId: `87010600-0000-4000-8000-${driverHigh}`,
      routePlanId: `87010600-0000-4000-8000-${routeLow}`,
    }),
  ]);
}

async function expectMultiDriverAccountLinkRollback(
  prisma: PrismaClient,
  fixtures: [OperationalFixture, OperationalFixture],
  identity: AccountLinkIdentity,
  link: () => Promise<unknown>,
): Promise<void> {
  const [first, second] = fixtures;
  const before = await Promise.all([
    prisma.driverAccount.count(),
    prisma.driverAccountSession.count(),
  ]);
  const beforeFixtureState = await Promise.all(fixtures.map(async (fixture) => ({
    driver: await prisma.driver.findUniqueOrThrow({ where: { id: fixture.driverId } }),
    executionArtifacts: await readExecutionArtifactState(prisma, fixture.shopId),
    profiles: await prisma.dsvDriverProfile.findMany({
      orderBy: { driverId: 'asc' },
      where: { driverId: fixture.driverId, shopId: fixture.shopId },
    }),
    route: await prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }),
  })));
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION dsv_test_fail_second_account_link_intent() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."executionContextId" = '${second.contextId}'::uuid AND NEW.kind = 'N01' THEN
        IF NOT EXISTS (
          SELECT 1 FROM dsv_execution_contexts
          WHERE id = '${first.contextId}'::uuid
            AND "assignmentEpoch" = 2
            AND "recipientAccountId" IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'synthetic first attribution was incomplete';
        END IF;
        RAISE EXCEPTION 'synthetic second attribution intent failure';
      END IF;
      RETURN NEW;
    END $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER dsv_test_fail_second_account_link_intent_trigger
    BEFORE INSERT ON dsv_operational_notifications
    FOR EACH ROW EXECUTE FUNCTION dsv_test_fail_second_account_link_intent()
  `);
  try {
    await expect(link()).rejects.toThrow('synthetic second attribution intent failure');
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS dsv_test_fail_second_account_link_intent_trigger ON dsv_operational_notifications',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_test_fail_second_account_link_intent()');
  }
  await expect(prisma.driverAccount.count({ where: { phone: identity.phone } })).resolves.toBe(0);
  await expect(Promise.all([
    prisma.driverAccount.count(),
    prisma.driverAccountSession.count(),
  ])).resolves.toEqual(before);
  for (const [index, fixture] of fixtures.entries()) {
    await expect(Promise.all([
      prisma.driver.findUniqueOrThrow({ where: { id: fixture.driverId } }),
      readExecutionArtifactState(prisma, fixture.shopId),
      prisma.dsvDriverProfile.findMany({
        orderBy: { driverId: 'asc' },
        where: { driverId: fixture.driverId, shopId: fixture.shopId },
      }),
      prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }),
    ])).resolves.toEqual([
      beforeFixtureState[index]?.driver,
      beforeFixtureState[index]?.executionArtifacts,
      beforeFixtureState[index]?.profiles,
      beforeFixtureState[index]?.route,
    ]);
    await expect(prisma.driver.findUniqueOrThrow({ where: { id: fixture.driverId } }))
      .resolves.toMatchObject({ accountId: null });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 1n, recipientAccountId: null, status: 'ACTIVE' });
    await expect(prisma.dsvOperationalNotification.findMany({
      select: { assignmentEpoch: true, businessStatus: true, kind: true, recipientAccountId: true },
      where: { executionContextId: fixture.contextId },
    })).resolves.toEqual([
      { assignmentEpoch: 1n, businessStatus: 'OPEN', kind: 'N05', recipientAccountId: null },
    ]);
    await expect(prisma.dsvExecutionCommand.count({ where: { shopId: fixture.shopId } })).resolves.toBe(0);
  }
}

async function expectAccountLinkDeletionRace(
  prisma: PrismaClient,
  fixtures: OperationalFixture[],
  applicationPrefix: string,
  link: (client: PrismaClient) => Promise<unknown>,
  expectedAccountId?: string,
): Promise<void> {
  const linkApplication = `${applicationPrefix}-writer`;
  const deleteApplication = `${applicationPrefix}-delete`;
  const blockerApplication = `${applicationPrefix}-blocker`;
  const linkClient = namedClient(linkApplication);
  const deleteClient = namedClient(deleteApplication);
  const blockerClient = namedClient(blockerApplication);
  const lockFixtures = fixtures.map((fixture, index) => ({ fixture, key: 8_702_100 + index }));
  const triggerCases = lockFixtures.map(({ fixture, key }) => (
    `IF NEW.id = '${fixture.driverId}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}); END IF;`
  )).join('\n');
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION dsv_test_block_account_link() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD."accountId" IS NULL AND NEW."accountId" IS NOT NULL THEN
        ${triggerCases}
      END IF;
      RETURN NEW;
    END $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER dsv_test_block_account_link_trigger
    AFTER UPDATE OF "accountId" ON drivers
    FOR EACH ROW EXECUTE FUNCTION dsv_test_block_account_link()
  `);
  let releaseGate!: () => void;
  let gateLocked!: () => void;
  const release = new Promise<void>((resolve) => { releaseGate = resolve; });
  const locked = new Promise<void>((resolve) => { gateLocked = resolve; });
  const blocker = blockerClient.$transaction(async (transaction) => {
    for (const { key } of lockFixtures) {
      await transaction.$queryRaw`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(${key})`;
    }
    gateLocked();
    await release;
  }, { timeout: 25_000 });
  await locked;
  let linkResult: PromiseSettledResult<unknown> | undefined;
  let deletionResult: PromiseSettledResult<void> | undefined;
  try {
    const linking = link(linkClient);
    await waitForLockedApplication(prisma, linkApplication);
    const waitingKey = await waitForWaitingAdvisoryKey(prisma, linkApplication);
    const deletionFixture = lockFixtures.find(({ key }) => key === waitingKey)?.fixture;
    if (deletionFixture === undefined) throw new Error(`Unexpected account-link advisory key: ${waitingKey}`);
    const deletion = new PrismaDsvResourceService(deleteClient).deleteDriver({
      driverId: deletionFixture.driverId,
      principal: createDsvAdminPrincipal({ shopId: deletionFixture.shopId }),
      shopDomain: deletionFixture.shopDomain,
    });
    await waitForLockedApplication(prisma, deleteApplication);
    releaseGate();
    [linkResult, deletionResult] = await Promise.allSettled([linking, deletion]);
    await blocker;
  } finally {
    releaseGate();
    await Promise.allSettled([blocker, linkClient.$disconnect(), deleteClient.$disconnect(), blockerClient.$disconnect()]);
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dsv_test_block_account_link_trigger ON drivers');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dsv_test_block_account_link()');
  }

  expect(linkResult?.status).toBe('fulfilled');
  if (deletionResult?.status === 'rejected'
    && deletionResult.reason instanceof Prisma.PrismaClientKnownRequestError
    && deletionResult.reason.code === 'P2010') {
    expect({
      code: deletionResult.reason.code,
      message: deletionResult.reason.message,
      meta: deletionResult.reason.meta,
    }).toEqual({ code: 'RESOURCE_IN_USE' });
  }
  expect(deletionResult).toMatchObject({ status: 'rejected', reason: { code: 'RESOURCE_IN_USE' } });
  if (deletionResult?.status === 'rejected') {
    expect(deletionResult.reason).not.toMatchObject({ code: 'P2010' });
    expect(String(deletionResult.reason)).not.toContain('40P01');
  }
  const accountId = expectedAccountId ?? (linkResult?.status === 'fulfilled'
    && typeof linkResult.value === 'object' && linkResult.value !== null && 'accountId' in linkResult.value
    && typeof linkResult.value.accountId === 'string' ? linkResult.value.accountId : null);
  expect(accountId).not.toBeNull();
  for (const fixture of fixtures) {
    await expect(prisma.driver.findUniqueOrThrow({ where: { id: fixture.driverId } }))
      .resolves.toMatchObject({ accountId });
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: fixture.routePlanId } }))
      .resolves.toMatchObject({ driverId: fixture.driverId });
    await expect(prisma.dsvExecutionContext.findUniqueOrThrow({ where: { id: fixture.contextId } }))
      .resolves.toMatchObject({ assignmentEpoch: 2n, recipientAccountId: accountId, status: 'ACTIVE' });
    await expect(prisma.dsvOperationalNotification.findMany({
      orderBy: [{ assignmentEpoch: 'asc' }, { kind: 'asc' }],
      select: { assignmentEpoch: true, businessStatus: true, kind: true, recipientAccountId: true },
      where: { executionContextId: fixture.contextId },
    })).resolves.toEqual([
      { assignmentEpoch: 1n, businessStatus: 'RESOLVED', kind: 'N05', recipientAccountId: null },
      { assignmentEpoch: 2n, businessStatus: 'OPEN', kind: 'N01', recipientAccountId: accountId },
    ]);
  }
}

async function waitForWaitingAdvisoryKey(prisma: PrismaClient, applicationName: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ lockKey: bigint }>>`
      SELECT lock_row.objid::bigint AS "lockKey"
      FROM pg_locks lock_row
      JOIN pg_stat_activity activity ON activity.pid = lock_row.pid
      WHERE activity.application_name = ${applicationName}
        AND lock_row.locktype = 'advisory'
        AND lock_row.granted = false
    `;
    if (rows[0] !== undefined) return Number(rows[0].lockKey);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} did not reach its advisory lock boundary.`);
}

async function addDsvResourceProfiles(prisma: PrismaClient, fixture: OperationalFixture): Promise<void> {
  await Promise.all([
    prisma.dsvDriverProfile.create({
      data: {
        driverId: fixture.driverId,
        lookupName: `delete-guard-${fixture.driverId}`,
        shopId: fixture.shopId,
      },
    }),
    prisma.dsvVehicleProfile.create({
      data: {
        shopId: fixture.shopId,
        typeLabel: 'Synthetic guarded vehicle',
        vehicleId: fixture.vehicleId,
      },
    }),
  ]);
}

async function createUnpublishedOperationalFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
): Promise<OperationalFixture> {
  const fixture = await createOperationalFixture(prisma, createdShopIds, name);
  await prisma.$transaction(async (transaction) => {
    await transaction.dsvOperationalNotification.deleteMany({ where: { executionContextId: fixture.contextId } });
    await transaction.dsvExecutionRouteMapping.deleteMany({ where: { executionContextId: fixture.contextId } });
    await transaction.dsvExecutionContext.delete({ where: { id: fixture.contextId } });
    await transaction.routeGroupingChildVersion.update({
      data: { publishedAt: null },
      where: { id: fixture.childVersionId },
    });
  });
  await addDsvResourceProfiles(prisma, fixture);
  await expectNoImportResourceReferences(prisma, fixture);
  return fixture;
}

async function createDsvReplacementDriver(
  prisma: PrismaClient,
  fixture: OperationalFixture,
  name: string,
): Promise<{ accountId: string; driverId: string }> {
  const unique = randomUUID();
  const account = await prisma.driverAccount.create({
    data: {
      name: `Synthetic replacement ${name}`,
      phone: `+82${unique.replaceAll('-', '').slice(0, 15)}`,
      status: 'ACTIVE',
    },
  });
  const driver = await prisma.driver.create({
    data: {
      accountId: account.id,
      displayName: `Synthetic replacement ${name}`,
      dsvProfile: {
        create: {
          lookupName: `replacement-${name}-${unique}`,
        },
      },
      shopId: fixture.shopId,
      status: 'ACTIVE',
    },
  });
  await expect(prisma.dsvDispatchImportRow.count({ where: { driverId: driver.id } })).resolves.toBe(0);
  return { accountId: account.id, driverId: driver.id };
}

async function expectNoImportResourceReferences(
  prisma: PrismaClient,
  fixture: OperationalFixture,
): Promise<void> {
  await expect(prisma.dsvDispatchImportRow.count({
    where: {
      OR: [
        { driverId: fixture.driverId },
        { vehicleId: fixture.vehicleId },
      ],
    },
  })).resolves.toBe(0);
}

async function readResourceReferenceState(prisma: PrismaClient, fixture: OperationalFixture) {
  const [context, driver, route, vehicle] = await Promise.all([
    prisma.dsvExecutionContext.findUniqueOrThrow({
      select: {
        assignmentEpoch: true,
        driverId: true,
        recipientAccountId: true,
        status: true,
        vehicleId: true,
      },
      where: { id: fixture.contextId },
    }),
    prisma.driver.findUnique({ select: { id: true, shopId: true }, where: { id: fixture.driverId } }),
    prisma.routePlan.findUniqueOrThrow({
      select: { driverId: true, id: true, status: true, vehicleId: true },
      where: { id: fixture.routePlanId },
    }),
    prisma.vehicle.findUnique({ select: { id: true, shopId: true }, where: { id: fixture.vehicleId } }),
  ]);
  return { context, driver, route, vehicle };
}

async function readExecutionArtifactState(prisma: PrismaClient, shopId: string) {
  const [commands, contexts, mappings, notifications] = await Promise.all([
    prisma.dsvExecutionCommand.findMany({ orderBy: { id: 'asc' }, where: { shopId } }),
    prisma.dsvExecutionContext.findMany({ orderBy: { id: 'asc' }, where: { shopId } }),
    prisma.dsvExecutionRouteMapping.findMany({ orderBy: { id: 'asc' }, where: { shopId } }),
    prisma.dsvOperationalNotification.findMany({ orderBy: { id: 'asc' }, where: { shopId } }),
  ]);
  return { commands, contexts, mappings, notifications };
}

type PublishedMultiChildFixture = {
  childVersionIds: string[];
  contextIds: string[];
  groupingId: string;
  orderIds: string[];
  routePlanIds: string[];
  routes: Array<{ childVersionId: string; contextId: string; orderId: string; routePlanId: string }>;
  shopDomain: string;
  shopId: string;
};

function routeGroupingService(prisma: PrismaClient): PrismaRouteGroupingService {
  return new PrismaRouteGroupingService(
    prisma,
    new FakeDriverPushProvider(),
    undefined,
    undefined,
    {
      buildRoute: () => Promise.resolve({
        routeGeometry: { coordinates: [[127.01, 37.49], [127.00, 37.50]], type: 'LineString' },
        routeMetrics: { distanceMeters: 1, durationSeconds: 1 },
        routeStopPoints: [],
      }),
    },
  );
}

function multiChildDraftInput(fixture: PublishedMultiChildFixture, labelPrefix: string) {
  return {
    appId: 'clever',
    groupingId: fixture.groupingId,
    mode: 'MANUAL_ORDER' as const,
    routes: fixture.routes.map((route) => ({
      branchId: null,
      label: `${labelPrefix}-${route.routePlanId}`,
      orderIds: [route.orderId],
      routeKey: `routePlan:${route.routePlanId}`,
      routePlanId: route.routePlanId,
    })),
    shopDomain: fixture.shopDomain,
  };
}

async function readExecutionVersions(prisma: PrismaClient, contextIds: string[]) {
  return prisma.dsvExecutionContext.findMany({
    orderBy: { id: 'asc' },
    select: {
      assignmentEpoch: true,
      contentSnapshot: true,
      id: true,
      routePlanId: true,
      routeVersion: true,
      status: true,
    },
    where: { id: { in: contextIds } },
  });
}

async function readPublishedMultiChildState(prisma: PrismaClient, fixture: PublishedMultiChildFixture) {
  const commandNames = fixture.routePlanIds.map((id) => `SYNC_ROUTE_EXECUTION:${id}`);
  const [children, contexts, grouping, notifications, orders, receipts, routes, stops] = await Promise.all([
    prisma.routeGroupingChildVersion.findMany({
      orderBy: { id: 'asc' },
      select: { driverId: true, id: true, publishedAt: true, routePlanId: true, snapshot: true, status: true, supersededAt: true },
      where: { groupingId: fixture.groupingId },
    }),
    readExecutionVersions(prisma, fixture.contextIds),
    prisma.routeGrouping.findUniqueOrThrow({ select: { status: true }, where: { id: fixture.groupingId } }),
    prisma.dsvOperationalNotification.findMany({
      orderBy: { id: 'asc' },
      select: {
        assignmentEpoch: true,
        businessStatus: true,
        executionContextId: true,
        id: true,
        kind: true,
        logicalKey: true,
        routeVersion: true,
      },
      where: { executionContextId: { in: fixture.contextIds } },
    }),
    prisma.order.findMany({
      orderBy: { id: 'asc' },
      select: { currentRouteVersionId: true, id: true },
      where: { id: { in: fixture.orderIds } },
    }),
    prisma.dsvExecutionCommand.findMany({
      orderBy: { id: 'asc' },
      select: { commandId: true, commandName: true, id: true, result: true },
      where: { commandName: { in: commandNames }, shopId: fixture.shopId },
    }),
    prisma.routePlan.findMany({
      orderBy: { id: 'asc' },
      select: { assignmentGeneration: true, driverId: true, id: true, name: true, status: true, vehicleId: true },
      where: { id: { in: fixture.routePlanIds } },
    }),
    prisma.routePlanStop.findMany({
      orderBy: [{ routePlanId: 'asc' }, { sequence: 'asc' }],
      select: { deliveryStopId: true, etaInputRouteVersionId: true, routePlanId: true, sequence: true },
      where: { routePlanId: { in: fixture.routePlanIds } },
    }),
  ]);
  return { children, contexts, grouping, notifications, orders, receipts, routes, stops };
}

function commandService(prisma: PrismaClient): PrismaDsvExecutionCommandsService {
  return new PrismaDsvExecutionCommandsService(prisma, new PrismaDriverEventRepository(prisma));
}

function namedClient(applicationName: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: `${exactDatabaseUrl}&application_name=${applicationName}` });
}

async function waitForLockedApplications(prisma: PrismaClient, names: string[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ application_name: string }>>`
      SELECT application_name
      FROM pg_stat_activity
      WHERE application_name IN (${names[0]}, ${names[1]})
        AND wait_event_type = 'Lock'
    `;
    if (new Set(rows.map((row) => row.application_name)).size === names.length) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Concurrent start commands did not reach their database lock boundary.');
}

async function waitForLockedApplication(prisma: PrismaClient, name: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ application_name: string }>>`
      SELECT application_name
      FROM pg_stat_activity
      WHERE application_name = ${name}
        AND wait_event_type = 'Lock'
    `;
    if (rows.length > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${name} did not reach its database lock boundary.`);
}

function startInput(fixture: OperationalFixture) {
  return {
    accountId: fixture.accountId,
    assignmentEpoch: '1',
    assignmentGeneration: '1',
    commandId: randomUUID(),
    driverId: fixture.driverId,
    executionContextId: fixture.contextId,
    expectedRouteVersionId: fixture.childVersionId,
    occurredAt: new Date('2026-10-06T00:30:00.000Z'),
    routeVersion: 1,
    shopDomain: fixture.shopDomain,
    shopId: fixture.shopId,
  };
}

function reportInput(fixture: OperationalFixture) {
  return {
    ...startInput(fixture),
    explanation: 'Synthetic access obstruction',
    reasonCode: 'ACCESS_BLOCKED',
    targetStopId: fixture.stopId,
  };
}

const baseGeofencePolicy = {
  arrivalDwellSeconds: 10,
  arrivalMinSamples: 2,
  destinationExitRadiusMeters: 80,
  destinationRadiusMeters: 60,
  exitDwellSeconds: 10,
  exitMinSamples: 2,
  futureToleranceSeconds: 5,
  maxGapSeconds: 120,
  maxObservationDelaySeconds: 120,
  maxReminderCount: 3,
  maxSpeedKph: 160,
  notificationTtlSeconds: 3600,
  policyVersion: 'synthetic-v1',
  reminderIntervalSeconds: 300,
  warehouseExitRadiusMeters: 100,
  warehouseRadiusMeters: 80,
} as const;

function liveSendPolicy(fixture: OperationalFixture): DsvOperationalNotificationSendPolicy {
  return {
    allowedAccountIds: [fixture.accountId],
    allowedKinds: ['N05'],
    allowedShopIds: [fixture.shopId],
    approvedAuthorizationId: 'synthetic-authorization',
    approvedGeofencePolicyVersion: 'synthetic-v1',
    businessReminderCap: 3,
    liveSendingEnabled: true,
    maxProviderAttempts: 3,
    monitorWindowMs: 3_600_000,
    notificationRetentionMs: 86_400_000,
    retryDelayMs: 30_000,
  };
}

function syntheticGeofencePolicy(mode: 'LIVE' | 'SHADOW'): DsvGeofencePolicy {
  return { ...baseGeofencePolicy, mode };
}

async function enableSyntheticGeofence(
  prisma: PrismaClient,
  fixture: OperationalFixture,
  mode: 'LIVE' | 'SHADOW',
): Promise<void> {
  await prisma.dsvExecutionContext.update({
    data: {
      monitorEndAt: new Date('2026-10-07T00:00:00.000Z'),
      monitorStartAt: new Date('2026-10-06T00:00:00.000Z'),
      notificationMode: mode,
      policy: syntheticGeofencePolicy(mode),
      ...(mode === 'LIVE' ? { liveEligibleAt: new Date('2026-10-06T00:00:00.000Z') } : {}),
    },
    where: { id: fixture.contextId },
  });
}

function telemetryInput(
  fixture: OperationalFixture,
  observedAt: Date,
  coordinates: readonly [string, string],
) {
  return {
    deviceId: fixture.deviceId,
    ignitionOn: true,
    latitude: coordinates[0],
    longitude: coordinates[1],
    observedAt,
    receivedAt: observedAt,
    sourceDeviceIdentifier: 'synthetic-uvis-device',
    sourceKind: 'VEHICLE_GPS' as const,
    sourcePlate: fixture.vehiclePlate,
    speedKph: '10',
    staleAfter: new Date(observedAt.getTime() + 300_000),
  };
}

function driverPrincipal(fixture: OperationalFixture): DsvDriverPrincipal {
  return {
    driverId: fixture.driverId,
    principalType: 'DRIVER',
    scopes: ['driver:assignments:read'],
    shopId: fixture.shopId,
  };
}

async function prepareLiveNotification(
  prisma: PrismaClient,
  fixture: OperationalFixture,
  now: Date,
) {
  await prisma.dsvOperationalNotification.updateMany({
    data: { businessStatus: 'RESOLVED', resolvedAt: now, resolutionReason: 'SYNTHETIC_WORKER_SETUP' },
    where: { executionContextId: fixture.contextId, businessStatus: 'OPEN' },
  });
  await prisma.dsvExecutionContext.update({
    data: {
      liveEligibleAt: now,
      monitorEndAt: new Date(now.getTime() + 3_600_000),
      monitorStartAt: now,
      notificationMode: 'LIVE',
      policy: { authorizationId: 'synthetic-authorization', policyVersion: 'synthetic-v1' },
    },
    where: { id: fixture.contextId },
  });
  const token = await prisma.driverPushToken.create({
    data: {
      accountId: fixture.accountId,
      appId: DSV_OPERATIONAL_DRIVER_APP_ID,
      deviceId: `install-${fixture.deviceId}`,
      devicePushToken: `synthetic-token-${fixture.deviceId}`,
      platform: 'android',
      status: 'ACTIVE',
      tokenHash: `synthetic-hash-${fixture.deviceId}`,
    },
  });
  const registrationService = new PrismaDsvOperationalDriverNotificationService(
    prisma,
    { providerName: 'synthetic-registration', send: () => Promise.resolve({ status: 'SKIPPED' }) },
  );
  await registrationService.registerCapability({
    installationId: `install-${fixture.deviceId}`,
    kinds: ['N05'],
    now,
    principal: driverPrincipal(fixture),
    schemaVersion: 1,
    tokenId: token.id,
  });
  return prisma.dsvOperationalNotification.create({
    data: {
      assignmentEpoch: 1n,
      audience: 'DRIVER',
      businessStatus: 'OPEN',
      createdAt: now,
      dueAt: now,
      executionContextId: fixture.contextId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      kind: 'N05',
      logicalKey: `N05:${fixture.contextId}:1:1:worker`,
      ordinal: 1,
      payload: { schemaVersion: 1 },
      recipientAccountId: fixture.accountId,
      routeVersion: 1,
      shopId: fixture.shopId,
    },
  });
}

async function makeGeofenceJobDue(prisma: PrismaClient, jobId: string, at: Date): Promise<void> {
  await prisma.dsvGeofenceJob.update({ data: { nextAttemptAt: at }, where: { id: jobId } });
}

async function createPublishedMultiChildFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
): Promise<PublishedMultiChildFixture> {
  const first = await createOperationalFixture(prisma, createdShopIds, `${name}-first`);
  const second = await createSiblingPublishedRoute(prisma, first, `${name}-second`);
  const [firstChild, secondChild] = await Promise.all([
    prisma.routeGroupingChildVersion.findUniqueOrThrow({
      select: { groupingId: true, groupingVersionId: true, id: true },
      where: { id: first.childVersionId },
    }),
    prisma.routeGroupingChildVersion.findUniqueOrThrow({
      select: { groupingId: true, id: true },
      where: { id: second.childVersionId },
    }),
  ]);
  await prisma.routeGroupingChildVersion.update({
    data: { groupingId: firstChild.groupingId, groupingVersionId: firstChild.groupingVersionId },
    where: { id: secondChild.id },
  });
  await prisma.routeGrouping.delete({ where: { id: secondChild.groupingId } });
  await prisma.routeGroupingOrder.createMany({
    data: [
      {
        deliveryStopId: first.stopId,
        groupingId: firstChild.groupingId,
        orderId: first.orderId,
        shopId: first.shopId,
        sourceSequence: 1,
      },
      {
        deliveryStopId: second.stopId,
        groupingId: firstChild.groupingId,
        orderId: second.orderId,
        shopId: first.shopId,
        sourceSequence: 2,
      },
    ],
  });
  await prisma.shop.update({
    data: {
      defaultDepotAddress: 'Synthetic multi-child depot',
      defaultDepotLatitude: '37.4900000',
      defaultDepotLongitude: '127.0100000',
    },
    where: { id: first.shopId },
  });
  await prisma.dsvExecutionContext.delete({ where: { id: first.contextId } });
  const firstPublication = await prisma.$transaction((transaction) => (
    new PrismaDsvExecutionContextService(transaction).syncForRoute({
      commandId: randomUUID(),
      firstPublication: true,
      now: new Date('2026-10-06T00:00:00.000Z'),
      previousPublishedAt: null,
      routePlanId: first.routePlanId,
      shopId: first.shopId,
      tripIntent: 'INITIAL_EXECUTION',
    })
  ));
  const secondPublication = await prisma.$transaction((transaction) => (
    new PrismaDsvExecutionContextService(transaction).syncForRoute({
      commandId: randomUUID(),
      firstPublication: true,
      now: new Date('2026-10-06T00:01:00.000Z'),
      previousPublishedAt: null,
      routePlanId: second.routePlanId,
      shopId: first.shopId,
      tripIntent: 'NEW_EXECUTION',
    })
  ));
  if (firstPublication.executionContextId === null || secondPublication.executionContextId === null) {
    throw new Error('Published multi-child fixture did not create both execution contexts.');
  }
  const routes = [
    {
      childVersionId: first.childVersionId,
      contextId: firstPublication.executionContextId,
      orderId: first.orderId,
      routePlanId: first.routePlanId,
    },
    {
      childVersionId: second.childVersionId,
      contextId: secondPublication.executionContextId,
      orderId: second.orderId,
      routePlanId: second.routePlanId,
    },
  ];
  return {
    childVersionIds: routes.map(({ childVersionId }) => childVersionId),
    contextIds: routes.map(({ contextId }) => contextId),
    groupingId: firstChild.groupingId,
    orderIds: routes.map(({ orderId }) => orderId),
    routePlanIds: routes.map(({ routePlanId }) => routePlanId),
    routes,
    shopDomain: first.shopDomain,
    shopId: first.shopId,
  };
}

async function createSiblingPublishedRoute(
  prisma: PrismaClient,
  fixture: OperationalFixture,
  name: string,
): Promise<{ childVersionId: string; orderId: string; routePlanId: string; stopId: string }> {
  const unique = `${name}-${randomUUID()}`;
  const order = await prisma.order.create({
    data: {
      name: `#${name}`,
      rawPayload: { dsv: { normalized: { shippedBoxes: 1 } } },
      sellerOrderKey: `SO-${unique}`,
      sellerOrderSourceKind: 'DSV_DISPATCH',
      serviceDate: new Date('2026-10-06T00:00:00.000Z'),
      shopId: fixture.shopId,
      shopifyOrderGid: `gid://synthetic/Order/${unique}`,
      sourceOrderId: unique,
      sourcePlatform: 'SHOPIFY',
    },
  });
  const stop = await prisma.deliveryStop.create({
    data: {
      address1: 'Synthetic sibling destination',
      countryCode: 'KR',
      latitude: '37.5100000',
      longitude: '127.0200000',
      orderId: order.id,
      recipientName: 'Synthetic Sibling Recipient',
      shopId: fixture.shopId,
      status: 'PENDING',
    },
  });
  const route = await prisma.routePlan.create({
    data: {
      constraints: {},
      depotLatitude: '37.4900000',
      depotLongitude: '127.0100000',
      driverId: fixture.driverId,
      metrics: {},
      name: `Synthetic Route ${name}`,
      optimizerVersion: 'dsv-operational-integration',
      planDate: new Date('2026-10-06T00:00:00.000Z'),
      shopId: fixture.shopId,
      status: 'READY',
      vehicleId: fixture.vehicleId,
    },
  });
  const grouping = await prisma.routeGrouping.create({
    data: { name: `Synthetic Grouping ${name}`, planDate: route.planDate, shopId: fixture.shopId, status: 'READY' },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: fixture.shopId, status: 'CURRENT', version: 1 },
  });
  const child = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: fixture.driverId,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      publishedAt: new Date('2026-10-06T00:00:00.000Z'),
      routePlanId: route.id,
      shopId: fixture.shopId,
      snapshot: {
        assignmentGeneration: '1',
        stops: [{ deliveryStopId: stop.id, orderId: order.id, sequence: 1 }],
      },
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.routePlanStop.create({
      data: { deliveryStopId: stop.id, etaInputRouteVersionId: child.id, routePlanId: route.id, sequence: 1, shopId: fixture.shopId },
    }),
    prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: order.id } }),
  ]);
  return { childVersionId: child.id, orderId: order.id, routePlanId: route.id, stopId: stop.id };
}

function notificationData(
  fixture: Pick<OperationalFixture, 'accountId' | 'contextId' | 'shopId'>,
  logicalKey: string,
) {
  return {
    assignmentEpoch: 1n,
    businessStatus: 'OPEN',
    dueAt: new Date('2026-10-06T00:30:00.000Z'),
    executionContextId: fixture.contextId,
    expiresAt: new Date('2026-10-07T00:30:00.000Z'),
    kind: 'N05',
    logicalKey,
    payload: { schema: 'synthetic_test_v1' },
    recipientAccountId: fixture.accountId,
    routeVersion: 1,
    shopId: fixture.shopId,
  };
}

async function createOperationalFixture(
  prisma: PrismaClient,
  createdShopIds: string[],
  name: string,
  ids: { driverId?: string; routePlanId?: string } = {},
): Promise<OperationalFixture> {
  const unique = `${name}-${randomUUID()}`;
  const shopDomain = `dsv-operational-${unique}.example.test`;
  const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain } });
  createdShopIds.push(shop.id);
  const account = await prisma.driverAccount.create({
    data: { name: `Synthetic ${name}`, phone: `+82${randomUUID().replaceAll('-', '').slice(0, 15)}`, status: 'ACTIVE' },
  });
  const [driver, vehicle] = await Promise.all([
    prisma.driver.create({
      data: {
        accountId: account.id,
        displayName: `Synthetic Driver ${name}`,
        ...(ids.driverId === undefined ? {} : { id: ids.driverId }),
        shopId: shop.id,
        status: 'ACTIVE',
      },
    }),
    prisma.vehicle.create({
      data: { label: `Synthetic Vehicle ${name}`, licensePlate: unique.slice(0, 30), shopId: shop.id, status: 'ACTIVE' },
    }),
  ]);
  const device = await prisma.dsvVehicleTelematicsDevice.create({
    data: {
      capabilities: ['VEHICLE_GPS'],
      installedAt: new Date('2026-10-06T00:00:00.000Z'),
      serialNumber: `UVIS-${unique}`,
      shopId: shop.id,
      vehicleId: vehicle.id,
    },
  });
  const order = await prisma.order.create({
    data: {
      name: `#${name}`,
      rawPayload: { dsv: { normalized: { shippedBoxes: 1 } } },
      sellerOrderKey: `SO-${unique}`,
      sellerOrderSourceKind: 'DSV_DISPATCH',
      serviceDate: new Date('2026-10-06T00:00:00.000Z'),
      shopId: shop.id,
      shopifyOrderGid: `gid://synthetic/Order/${unique}`,
      sourceOrderId: unique,
      sourcePlatform: 'SHOPIFY',
    },
  });
  const stop = await prisma.deliveryStop.create({
    data: {
      address1: 'Synthetic destination',
      countryCode: 'KR',
      latitude: '37.5000000',
      longitude: '127.0000000',
      orderId: order.id,
      recipientName: 'Synthetic Recipient',
      shopId: shop.id,
      status: 'PENDING',
    },
  });
  const route = await prisma.routePlan.create({
    data: {
      constraints: {},
      depotLatitude: '37.4900000',
      depotLongitude: '127.0100000',
      driverId: driver.id,
      ...(ids.routePlanId === undefined ? {} : { id: ids.routePlanId }),
      metrics: {},
      name: `Synthetic Route ${name}`,
      optimizerVersion: 'dsv-operational-integration',
      planDate: new Date('2026-10-06T00:00:00.000Z'),
      shopId: shop.id,
      status: 'READY',
      vehicleId: vehicle.id,
    },
  });
  const grouping = await prisma.routeGrouping.create({
    data: { name: `Synthetic Grouping ${name}`, planDate: route.planDate, shopId: shop.id, status: 'READY' },
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 },
  });
  const child = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id,
      groupingId: grouping.id,
      groupingVersionId: groupingVersion.id,
      publishedAt: new Date('2026-10-06T00:00:00.000Z'),
      routePlanId: route.id,
      shopId: shop.id,
      snapshot: {
        assignmentGeneration: '1',
        stops: [{ deliveryStopId: stop.id, orderId: order.id, sequence: 1 }],
      },
      status: 'CURRENT',
      version: 1,
    },
  });
  await Promise.all([
    prisma.routePlanStop.create({
      data: { deliveryStopId: stop.id, etaInputRouteVersionId: child.id, routePlanId: route.id, sequence: 1, shopId: shop.id },
    }),
    prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: order.id } }),
  ]);
  const context = await prisma.dsvExecutionContext.create({
    data: {
      assignmentEpoch: 1n,
      contentFingerprint: `fingerprint-${unique}`,
      contentSnapshot: {
        depot: { latitude: 37.49, longitude: 127.01 },
        stops: [{ id: stop.id, orderId: order.id, quantity: 1, sequence: 1, status: 'PENDING' }],
      },
      driverId: driver.id,
      effectiveAt: new Date('2026-10-06T00:00:00.000Z'),
      notificationMode: 'OFF',
      recipientAccountId: account.id,
      reminderDueAt: new Date('2026-10-06T00:30:00.000Z'),
      reminderIncidentId: randomUUID(),
      reminderStatus: 'REMINDER_ACTIVE',
      routePlanId: route.id,
      routeVersion: 1,
      serviceDate: new Date('2026-10-06T00:00:00.000Z'),
      shopId: shop.id,
      status: 'ACTIVE',
      vehicleId: vehicle.id,
    },
  });
  const warning = await prisma.dsvOperationalNotification.create({
    data: notificationData({ accountId: account.id, contextId: context.id, shopId: shop.id }, `N05:${context.id}:1:1`),
  });
  await prisma.dsvExecutionRouteMapping.create({
    data: {
      executionContextId: context.id,
      routePlanId: route.id,
      shopId: shop.id,
      validFrom: new Date('2026-10-06T00:00:00.000Z'),
    },
  });
  return {
    accountId: account.id,
    childVersionId: child.id,
    contextId: context.id,
    deviceId: device.id,
    driverId: driver.id,
    orderId: order.id,
    routePlanId: route.id,
    shopDomain,
    shopId: shop.id,
    stopId: stop.id,
    vehicleId: vehicle.id,
    vehiclePlate: vehicle.licensePlate!,
    warningId: warning.id,
  };
}
