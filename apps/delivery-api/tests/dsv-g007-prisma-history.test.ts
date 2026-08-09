import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const migrationsDir = new URL('../prisma/migrations/', import.meta.url);
const baselineMigrationPath = new URL(
  '../prisma/migrations/20260520000000_initial_route_ops_baseline/migration.sql',
  import.meta.url
);
const bridgeCreateMigrationPath = new URL(
  '../prisma/migrations/20260618022400_create_mapped_table_compatibility_bridges/migration.sql',
  import.meta.url
);
const legacyRouteOpsUiSettingsMigrationPath = new URL(
  '../prisma/migrations/20260618022500_add_route_ops_ui_settings/migration.sql',
  import.meta.url
);
const legacyLifecycleCollapseMigrationPath = new URL(
  '../prisma/migrations/20260628170000_collapse_route_lifecycle_statuses/migration.sql',
  import.meta.url
);
const bridgeApplyMigrationPath = new URL(
  '../prisma/migrations/20260628170100_apply_mapped_table_compatibility/migration.sql',
  import.meta.url
);
const g002RepairMigrationName = '20260722193000_repair_g002_tenant_integrity';
const g004MigrationPath = new URL(
  '../prisma/migrations/20260722213000_dsv_assignment_eta_state/migration.sql',
  import.meta.url
);
const cleanupMigrationPath = new URL(
  '../prisma/migrations/20260722223000_drop_legacy_single_tenant_fks/migration.sql',
  import.meta.url
);
const finalRepairMigrationName = '20260722233000_align_migration_history_to_schema';
const finalRepairMigrationPath = new URL(`../prisma/migrations/${finalRepairMigrationName}/migration.sql`, import.meta.url);
const g009MigrationName = '20260723003000_g009_tenant_composite_dsv_fks';
const g010MigrationName = '20260723013000_g010_import_row_resource_tenant_fks';
const g011MigrationName = '20260723023000_g011_production_baseline_drift_repair';
const g011MigrationPath = new URL(`../prisma/migrations/${g011MigrationName}/migration.sql`, import.meta.url);
const adminStopActionsMigrationName = '20260723120000_add_admin_route_stop_actions';
const notificationOutboxMigrationName = '20260723170000_add_customer_notification_outbox_worker';
const operationalSettingsMigrationName = '20260727150000_add_dsv_operational_settings';
const vehicleDriverOneToOneMigrationName = '20260727161000_enforce_dsv_vehicle_driver_one_to_one';
const driverAccountDeletionMigrationName = '20260727180000_scope_deletion_request_to_driver_account';
const dsvAdminAccountsMigrationName = '20260727190000_add_dsv_admin_accounts';
const dsvVehicleTelematicsMigrationName = '20260728090000_add_dsv_vehicle_telematics_devices';
const pickupCompletedDriverEventMigrationName = '20260728120000_add_pickup_completed_driver_event';
const pickupCompletedUniqueIndexMigrationName = '20260728124500_add_pickup_completed_unique_index';
const dsvDriverAppAuthMigrationName = '20260802120000_add_dsv_driver_app_auth';
const manualCustomerEmailMigrationName = '20260803110000_add_manual_customer_email';
const timeConstraintAcknowledgedDriverEventMigrationName = '20260803120000_add_time_constraint_acknowledged_driver_event';
const dsvDriverSignupInviteMigrationName = '20260804120000_add_dsv_driver_account_signup_invites';
const shopScopedDriverSignupInviteMigrationName = '20260804150000_scope_driver_signup_invites_to_shop';
const uvisVehicleTelematicsMigrationName = '20260804170000_add_uvis_vehicle_telematics';
const uvisActivityStateMigrationName = '20260805090000_add_uvis_activity_state';
const dsvConditionTemperaturePolicyMigrationName = '20260805120000_add_dsv_condition_temperature_policy';
const dsvDriverAppReleaseMigrationName = '20260805150000_add_dsv_driver_app_releases';
const dsvDispatchChangeRequestMigrationName = '20260806120000_add_dsv_dispatch_change_requests';
const routesAppReleaseRegistryMigrationName = '20260806150000_add_routes_app_release_registry';
const dsvCustomerAccountInvitesMigrationName = '20260809120000_add_dsv_customer_account_invites';
const assignedDriverProfileBackfillMigrationName = '20260729170000_backfill_assigned_dsv_driver_profiles';
const dispatchGroupingBackfillMigrationName = '20260730170000_backfill_dsv_dispatch_groupings';
const accountScopedPushTokenMigrationName = '20260731140000_account_scope_driver_push_tokens';
const orderServiceDateIdentityMigrationName = '20260731120000_dsv_order_service_date_identity';
const geocodingCacheMigrationName = '20260802090000_add_geocoding_cache';
const shopScopedDriverSignupInviteMigrationPath = new URL(
  `../prisma/migrations/${shopScopedDriverSignupInviteMigrationName}/migration.sql`,
  import.meta.url
);
const pickupCompletedDriverEventMigrationPath = new URL(
  `../prisma/migrations/${pickupCompletedDriverEventMigrationName}/migration.sql`,
  import.meta.url
);
const pickupCompletedUniqueIndexMigrationPath = new URL(
  `../prisma/migrations/${pickupCompletedUniqueIndexMigrationName}/migration.sql`,
  import.meta.url
);
const timeConstraintAcknowledgedDriverEventMigrationPath = new URL(
  `../prisma/migrations/${timeConstraintAcknowledgedDriverEventMigrationName}/migration.sql`,
  import.meta.url
);
const assignedDriverProfileBackfillMigrationPath = new URL(
  `../prisma/migrations/${assignedDriverProfileBackfillMigrationName}/migration.sql`,
  import.meta.url
);
const dispatchGroupingBackfillMigrationPath = new URL(
  `../prisma/migrations/${dispatchGroupingBackfillMigrationName}/migration.sql`,
  import.meta.url
);
const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);

const legacySingleColumnConstraints = [
  'route_plan_stops_routePlanId_fkey',
  'route_plan_stops_deliveryStopId_fkey',
  'driver_events_routePlanId_fkey'
] as const;

const tenantCompositeConstraints = [
  'route_plan_stops_routePlanId_shopId_fkey',
  'route_plan_stops_deliveryStopId_shopId_fkey',
  'driver_events_routePlanId_shopId_fkey'
] as const;

const indexRenames = [
  [
    'commerce_raw_order_ingests_connection_order_receivedAt_idx',
    'commerce_raw_order_ingests_commerceConnectionId_sourceOrder_idx'
  ],
  ['commerce_raw_order_ingests_connection_order_hash_key', 'commerce_raw_order_ingests_commerceConnectionId_sourceOrder_key'],
  ['commerce_raw_order_ingests_run_chunk_order_hash_key', 'commerce_raw_order_ingests_syncRunId_chunkId_sourceOrderId__key'],
  [
    'commerce_connection_audit_logs_commerceConnectionId_createdAt_idx',
    'commerce_connection_audit_logs_commerceConnectionId_created_idx'
  ],
  [
    'wordpress_plugin_pairing_codes_commerceConnectionId_expiresAt_idx',
    'wordpress_plugin_pairing_codes_commerceConnectionId_expires_idx'
  ],
  [
    'orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumber_idx',
    'orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumbe_idx'
  ],
  [
    'order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_idx',
    'order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_so_idx'
  ],
  [
    'driver_route_notification_attempts_groupingId_groupingVersion_idx',
    'driver_route_notification_attempts_groupingId_groupingVersi_idx'
  ]
] as const;

const constraintRenames = [
  [
    'route_plan_stops_etaInputRouteVersionId_fkey',
    'route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey'
  ],
  ['driver_events_routeVersionId_shopId_fkey', 'driver_events_routeVersionId_shopId_routePlanId_fkey']
] as const;

describe('G007 DSV Prisma migration history', () => {
  test('orders compatibility bridges around the broken mapped-table migrations', async () => {
    const migrations = await readMigrationNames();

    expect(migrations).toHaveLength(73);
    expect(migrations).toContain('20260618022400_create_mapped_table_compatibility_bridges');
    expect(migrations).toContain('20260618022500_add_route_ops_ui_settings');
    expect(migrations).toContain('20260628170000_collapse_route_lifecycle_statuses');
    expect(migrations).toContain('20260628170100_apply_mapped_table_compatibility');
    expect(migrations.indexOf('20260618022400_create_mapped_table_compatibility_bridges')).toBeLessThan(
      migrations.indexOf('20260618022500_add_route_ops_ui_settings')
    );
    expect(migrations.indexOf('20260628170000_collapse_route_lifecycle_statuses')).toBeLessThan(
      migrations.indexOf('20260628170100_apply_mapped_table_compatibility')
    );
    expect(migrations.indexOf('20260628170100_apply_mapped_table_compatibility')).toBeLessThan(
      migrations.indexOf(g002RepairMigrationName)
    );
  });

  test('keeps migration SQL files directly under first-level migration directories', async () => {
    const migrations = await readMigrationNames();
    const migrationSqlPaths = await findMigrationSqlRelativePaths();
    const nestedMigrationSqlPaths = migrationSqlPaths.filter((path) => path.split('/').length !== 2);

    expect(nestedMigrationSqlPaths).toEqual([]);
    expect(migrationSqlPaths.sort()).toEqual(migrations.map((migration) => `${migration}/migration.sql`));
  });

  test('keeps old mapped-table migration checksums untouched', async () => {
    await expect(sqlSha256(legacyRouteOpsUiSettingsMigrationPath)).resolves.toBe(
      'a379b48bd023a08f659325ae3b96020b79c2a5fc44598f90172aaff28bbf5343'
    );
    await expect(sqlSha256(legacyLifecycleCollapseMigrationPath)).resolves.toBe(
      '17d3fa1f569b3166980629314232100992038354860b17e171d0ded9884db7cc'
    );
  });

  test('creates and drops only marked transient quoted compatibility tables', async () => {
    const [bridgeCreate, bridgeApply] = await Promise.all([
      readFile(bridgeCreateMigrationPath, 'utf8'),
      readFile(bridgeApplyMigrationPath, 'utf8')
    ]);

    for (const tableName of ['Shop', 'RoutePlan', 'RouteGrouping']) {
      expect(bridgeCreate).toContain(`to_regclass('"${tableName}"') IS NULL`);
      expect(bridgeCreate).toContain(`CREATE TABLE "${tableName}"`);
      expect(bridgeCreate).toContain(`COMMENT ON TABLE "${tableName}" IS 'G007 transient mapped-table compatibility bridge'`);
      expect(bridgeApply).toContain(`SELECT to_regclass('"${tableName}"') INTO legacy_oid`);
      expect(bridgeApply).toContain(`DROP TABLE "${tableName}"`);
    }

    expect(bridgeCreate).toContain('"status" "RoutePlanStatus" NOT NULL DEFAULT \'DRAFT\'');
    expect(bridgeCreate).toContain('"status" TEXT NOT NULL DEFAULT \'DRAFT\'');
    expect(dropTableNames(bridgeApply)).toEqual(['RouteGrouping', 'RoutePlan', 'Shop']);
    expect(bridgeApply.match(/obj_description\(legacy_oid, 'pg_class'\) = 'G007 transient mapped-table compatibility bridge'/gu)).toHaveLength(3);
  });

  test('applies legacy mapped-table effects to lowercase tables without deleting mapped data', async () => {
    const bridgeApply = await readFile(bridgeApplyMigrationPath, 'utf8');

    expect(bridgeApply).toContain('ALTER TABLE "shops"');
    expect(bridgeApply).toContain('ADD COLUMN IF NOT EXISTS "routeOpsUiSettings" JSONB');
    expect(bridgeApply).toContain('UPDATE "route_plans"');
    expect(bridgeApply).toContain('END::"RoutePlanStatus"');
    expect(bridgeApply).toContain('UPDATE "route_groupings"');
    expect(bridgeApply).toContain('END::"RouteGroupingStatus"');
    expect(bridgeApply).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/iu);
    expect(bridgeApply).not.toMatch(/\bDROP\s+TABLE\s+"(?:shops|route_plans|route_groupings)"/iu);
  });

  test('orders the additive cleanup and G009 through G011 tenant-composite repairs', async () => {
    const migrations = await readMigrationNames();

    expect(migrations).toContain('20260722213000_dsv_assignment_eta_state');
    expect(migrations).toContain('20260722223000_drop_legacy_single_tenant_fks');
    expect(migrations).toContain(finalRepairMigrationName);
    expect(migrations).toContain(g009MigrationName);
    expect(migrations).toContain(g010MigrationName);
    expect(migrations).toContain(g011MigrationName);
    expect(migrations).toContain(adminStopActionsMigrationName);
    expect(migrations).toContain(notificationOutboxMigrationName);
    expect(migrations).toContain(operationalSettingsMigrationName);
    expect(migrations).toContain(vehicleDriverOneToOneMigrationName);
    expect(migrations).toContain(driverAccountDeletionMigrationName);
    expect(migrations).toContain(dsvAdminAccountsMigrationName);
    expect(migrations).toContain(dsvVehicleTelematicsMigrationName);
    expect(migrations).toContain(pickupCompletedDriverEventMigrationName);
    expect(migrations).toContain(pickupCompletedUniqueIndexMigrationName);
    expect(migrations).toContain(manualCustomerEmailMigrationName);
    expect(migrations).toContain(timeConstraintAcknowledgedDriverEventMigrationName);
    expect(migrations).toContain(dsvDriverSignupInviteMigrationName);
    expect(migrations).toContain(shopScopedDriverSignupInviteMigrationName);
    expect(migrations).toContain(uvisVehicleTelematicsMigrationName);
    expect(migrations).toContain(uvisActivityStateMigrationName);
    expect(migrations).toContain(assignedDriverProfileBackfillMigrationName);
    expect(migrations).toContain(dispatchGroupingBackfillMigrationName);
    expect(migrations).toContain(accountScopedPushTokenMigrationName);
    expect(migrations.indexOf('20260722213000_dsv_assignment_eta_state')).toBeLessThan(
      migrations.indexOf('20260722223000_drop_legacy_single_tenant_fks')
    );
    expect(migrations.indexOf('20260722223000_drop_legacy_single_tenant_fks')).toBeLessThan(
      migrations.indexOf(finalRepairMigrationName)
    );
    expect(migrations.indexOf(finalRepairMigrationName)).toBeLessThan(migrations.indexOf(g009MigrationName));
    expect(migrations.indexOf(g009MigrationName)).toBeLessThan(migrations.indexOf(g010MigrationName));
    expect(migrations.indexOf(g010MigrationName)).toBeLessThan(migrations.indexOf(g011MigrationName));
    expect(migrations.indexOf(g011MigrationName)).toBeLessThan(migrations.indexOf(adminStopActionsMigrationName));
    expect(migrations.indexOf(adminStopActionsMigrationName)).toBeLessThan(migrations.indexOf(notificationOutboxMigrationName));
    expect(migrations.indexOf(notificationOutboxMigrationName)).toBeLessThan(
      migrations.indexOf(operationalSettingsMigrationName)
    );
    expect(migrations.indexOf(operationalSettingsMigrationName)).toBeLessThan(
      migrations.indexOf(vehicleDriverOneToOneMigrationName)
    );
    expect(migrations.indexOf(vehicleDriverOneToOneMigrationName)).toBeLessThan(
      migrations.indexOf(driverAccountDeletionMigrationName)
    );
    expect(migrations.indexOf(driverAccountDeletionMigrationName)).toBeLessThan(
      migrations.indexOf(dsvAdminAccountsMigrationName)
    );
    expect(migrations.indexOf(dsvAdminAccountsMigrationName)).toBeLessThan(
      migrations.indexOf(dsvVehicleTelematicsMigrationName)
    );
    expect(migrations.indexOf(dsvVehicleTelematicsMigrationName)).toBeLessThan(
      migrations.indexOf(pickupCompletedDriverEventMigrationName)
    );
    expect(migrations.indexOf(pickupCompletedDriverEventMigrationName)).toBeLessThan(
      migrations.indexOf(pickupCompletedUniqueIndexMigrationName)
    );
    expect(migrations.indexOf(pickupCompletedUniqueIndexMigrationName)).toBeLessThan(
      migrations.indexOf(assignedDriverProfileBackfillMigrationName)
    );
    expect(migrations.indexOf(assignedDriverProfileBackfillMigrationName)).toBeLessThan(
      migrations.indexOf(dispatchGroupingBackfillMigrationName)
    );
    expect(migrations.indexOf(dispatchGroupingBackfillMigrationName)).toBeLessThan(
      migrations.indexOf(orderServiceDateIdentityMigrationName)
    );
    expect(migrations.indexOf(orderServiceDateIdentityMigrationName)).toBeLessThan(
      migrations.indexOf(accountScopedPushTokenMigrationName)
    );
    expect(migrations.indexOf(accountScopedPushTokenMigrationName)).toBeLessThan(
      migrations.indexOf(geocodingCacheMigrationName)
    );
    expect(migrations.indexOf(geocodingCacheMigrationName)).toBeLessThan(
      migrations.indexOf(dsvDriverAppAuthMigrationName)
    );
    expect(migrations.indexOf(dsvDriverAppAuthMigrationName)).toBeLessThan(
      migrations.indexOf(manualCustomerEmailMigrationName)
    );
    expect(migrations.indexOf(manualCustomerEmailMigrationName)).toBeLessThan(
      migrations.indexOf(timeConstraintAcknowledgedDriverEventMigrationName)
    );
    expect(migrations.indexOf(timeConstraintAcknowledgedDriverEventMigrationName)).toBeLessThan(
      migrations.indexOf(dsvDriverSignupInviteMigrationName)
    );
    expect(migrations.indexOf(dsvDriverSignupInviteMigrationName)).toBeLessThan(
      migrations.indexOf(shopScopedDriverSignupInviteMigrationName)
    );
    expect(migrations.indexOf(shopScopedDriverSignupInviteMigrationName)).toBeLessThan(
      migrations.indexOf(uvisVehicleTelematicsMigrationName)
    );
    expect(migrations.indexOf(uvisVehicleTelematicsMigrationName)).toBeLessThan(
      migrations.indexOf(uvisActivityStateMigrationName)
    );
    expect(migrations.indexOf(uvisActivityStateMigrationName)).toBeLessThan(
      migrations.indexOf(dsvConditionTemperaturePolicyMigrationName)
    );
    expect(migrations.indexOf(dsvConditionTemperaturePolicyMigrationName)).toBeLessThan(
      migrations.indexOf(dsvDriverAppReleaseMigrationName)
    );
    expect(migrations.indexOf(dsvDriverAppReleaseMigrationName)).toBeLessThan(
      migrations.indexOf(dsvDispatchChangeRequestMigrationName)
    );
    expect(migrations.indexOf(dsvDispatchChangeRequestMigrationName)).toBeLessThan(
      migrations.indexOf(routesAppReleaseRegistryMigrationName)
    );
    expect(migrations.indexOf(routesAppReleaseRegistryMigrationName)).toBeLessThan(
      migrations.indexOf(dsvCustomerAccountInvitesMigrationName)
    );
    expect(migrations.at(-1)).toBe(dsvCustomerAccountInvitesMigrationName);
  });

  test('backfills shop ownership before allowing driverless signup invites', async () => {
    const migration = await readFile(shopScopedDriverSignupInviteMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN "shopId" UUID');
    expect(migration).toContain('SET "shopId" = driver."shopId"');
    expect(migration.indexOf('SET "shopId" = driver."shopId"')).toBeLessThan(
      migration.indexOf('ALTER COLUMN "shopId" SET NOT NULL')
    );
    expect(migration).toContain('ALTER COLUMN "driverId" DROP NOT NULL');
    expect(migration).toContain('FOREIGN KEY ("shopId") REFERENCES "shops"("id")');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(?:TABLE|INDEX|SCHEMA|TYPE)\b/iu);
  });

  test('backfills only assigned drivers without replacing canonical contact or assignment data', async () => {
    const migration = await readFile(assignedDriverProfileBackfillMigrationPath, 'utf8');

    expect(migration).toContain('INSERT INTO "dsv_driver_profiles"');
    expect(migration).toContain('FROM "drivers" driver');
    expect(migration).toContain('FROM "dsv_vehicle_driver_assignments" assignment');
    expect(migration).toContain('assignment."driverId" = driver.id');
    expect(migration).toContain('assignment."shopId" = driver."shopId"');
    expect(migration).not.toContain('UPDATE "drivers"');
    expect(migration).not.toContain('UPDATE "dsv_vehicle_driver_assignments"');
    expect(stripSqlLineComments(migration)).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/iu);
  });

  test('backfills assignment ownership for applied dispatch imports without existing grouping rows', async () => {
    const migration = await readFile(dispatchGroupingBackfillMigrationPath, 'utf8');

    expect(migration).toContain('CREATE TEMP TABLE "_dsv_orphan_dispatch_rows"');
    expect(migration).toContain('INSERT INTO "route_groupings"');
    expect(migration).toContain('INSERT INTO "route_grouping_versions"');
    expect(migration).toContain('INSERT INTO "route_grouping_orders"');
    expect(migration).toContain("row.\"status\" = 'APPLIED'");
    expect(migration).toContain('NOT EXISTS');
  });

  test('separates pickup completed enum addition from enum-using partial index', async () => {
    const [enumMigration, indexMigration] = await Promise.all([
      readFile(pickupCompletedDriverEventMigrationPath, 'utf8'),
      readFile(pickupCompletedUniqueIndexMigrationPath, 'utf8')
    ]);

    expect(enumMigration.trim()).toBe(`ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'PICKUP_COMPLETED';`);
    expect(enumMigration).not.toContain('CREATE UNIQUE INDEX');
    expect(enumMigration).not.toContain('driver_events_pickup_completed_driver_route_key');
    expect(indexMigration).not.toContain('ALTER TYPE "DriverEventType" ADD VALUE');
    expect(indexMigration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "driver_events_pickup_completed_driver_route_key"');
    expect(indexMigration).toContain('ON "driver_events"("driverId", "routePlanId")');
    expect(indexMigration).toContain(
      'WHERE "eventType" = \'PICKUP_COMPLETED\' AND "driverId" IS NOT NULL AND "routePlanId" IS NOT NULL'
    );
  });

  test('adds time constraint acknowledgement as a single-purpose additive enum migration', async () => {
    const migration = await readFile(timeConstraintAcknowledgedDriverEventMigrationPath, 'utf8');

    expect(migration.trim()).toBe(`ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'TIME_CONSTRAINT_ACKNOWLEDGED';`);
    expect(stripSqlLineComments(migration)).not.toMatch(/\bCREATE\s+(?:TABLE|INDEX)\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b/iu);
  });

  test('keeps the production baseline drift repair additive and fail closed', async () => {
    const migration = await readFile(g011MigrationPath, 'utf8');

    expect(migration).toContain('missing or cross-shop customer references exist');
    expect(migration).toContain('missing or cross-shop destination references exist');
    expect(migration.match(/SET DEFAULT gen_random_uuid\(\)/gu) ?? []).toHaveLength(4);
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "orders_customerId_shopId_fkey"');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "dsv_audit_events_customerId_shopId_fkey"');
    expect(migration.match(/ON DELETE NO ACTION ON UPDATE CASCADE/gu) ?? []).toHaveLength(4);
    expect(stripSqlLineComments(migration)).not.toMatch(/\bDROP\s+(?:TABLE|INDEX|SCHEMA|TYPE)\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/iu);
  });

  test('documents the baseline, G004 tenant-composite replacement, and G007 cleanup transition', async () => {
    const [baseline, g004, cleanup] = await Promise.all([
      readFile(baselineMigrationPath, 'utf8'),
      readFile(g004MigrationPath, 'utf8'),
      readFile(cleanupMigrationPath, 'utf8')
    ]);

    for (const constraintName of legacySingleColumnConstraints) {
      expect(baseline).toContain(`ADD CONSTRAINT "${constraintName}"`);
      expect(g004).not.toContain(`DROP CONSTRAINT "${constraintName}"`);
      expect(cleanup).toContain(`DROP CONSTRAINT IF EXISTS "${constraintName}"`);
    }

    for (const constraintName of tenantCompositeConstraints) {
      expect(g004).toContain(`ADD CONSTRAINT "${constraintName}"`);
      expect(cleanup).not.toContain(`DROP CONSTRAINT IF EXISTS "${constraintName}"`);
      expect(cleanup).not.toContain(`DROP CONSTRAINT "${constraintName}"`);
    }

    expect(dropConstraintNames(cleanup)).toEqual([...legacySingleColumnConstraints]);
    expect(cleanup).not.toMatch(/\bDROP\s+(?:TABLE|INDEX|SCHEMA|TYPE)\b/iu);
    expect(cleanup).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/iu);
  });

  test('final repair migration conditionally aligns drifted names and route plan stop shop FK', async () => {
    const finalRepair = await readFile(finalRepairMigrationPath, 'utf8');

    expect(finalRepair).toContain('ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS \'PUBLISHED\'');

    for (const [from, to] of indexRenames) {
      expect(finalRepair).toContain(from);
      expect(finalRepair).toContain(to);
    }
    expect(finalRepair.match(/ALTER INDEX %I RENAME TO %I/gu)).toHaveLength(1);

    for (const [from, to] of constraintRenames) {
      expect(finalRepair).toContain(`c.conname = '${from}'`);
      expect(finalRepair).toContain(`c.conname = '${to}'`);
      expect(finalRepair).toContain(`RENAME CONSTRAINT "${from}"`);
      expect(finalRepair).toContain(`TO "${to}"`);
    }

    expect(finalRepair).toContain('Cannot add route_plan_stops_shopId_fkey: orphan route_plan_stops.shopId values exist');
    expect(finalRepair).toContain('ADD CONSTRAINT "route_plan_stops_shopId_fkey"');
    expect(finalRepair).toContain('FOREIGN KEY ("shopId") REFERENCES "shops"("id")');
    expect(finalRepair).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(finalRepair).toContain("to_regclass('public.route_plan_stops') IS NOT NULL");
    expect(finalRepair).toContain('ALTER COLUMN "warnings" SET DEFAULT \'[]\'::jsonb');
    expect(finalRepair.match(/SET DEFAULT gen_random_uuid\(\)/gu) ?? []).toHaveLength(22);
    expect(finalRepair.match(/SET DEFAULT CURRENT_TIMESTAMP/gu) ?? []).toHaveLength(10);
    expect(stripSqlLineComments(finalRepair)).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/iu);
  });

  test('schema preserves historical DB defaults instead of planning default drops', async () => {
    const schema = await readFile(schemaPath, 'utf8');

    expect(schema.match(/@default\(dbgenerated\("gen_random_uuid\(\)"\)\)/gu) ?? []).toHaveLength(36);
    expect(schema.match(/updatedAt\s+DateTime\s+@default\(now\(\)\)\s+@updatedAt/gu)).toHaveLength(14);
    expect(schema).toContain('warnings             Json                          @default("[]")');
  });
});

async function readMigrationNames(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((entry) => /^\d+_/u.test(entry)).sort();
}

async function findMigrationSqlRelativePaths(dir = migrationsDir, prefix: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = [...prefix, entry.name];

      if (entry.isDirectory()) {
        return findMigrationSqlRelativePaths(new URL(`${entry.name}/`, dir), entryPath);
      }

      return entry.isFile() && entry.name === 'migration.sql' ? [entryPath.join('/')] : [];
    })
  );

  return paths.flat();
}

async function sqlSha256(path: URL): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function dropTableNames(sql: string): string[] {
  return [...sql.matchAll(/\bDROP\s+TABLE\s+"(?<tableName>[^"]+)"/giu)].map((match) => {
    const tableName = match.groups?.tableName;
    if (tableName === undefined) {
      throw new Error(`Could not parse table name from ${match[0]}`);
    }
    return tableName;
  });
}

function dropConstraintNames(sql: string): string[] {
  return [...sql.matchAll(/\bDROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"(?<constraintName>[^"]+)"/giu)].map((match) => {
    const constraintName = match.groups?.constraintName;
    if (constraintName === undefined) {
      throw new Error(`Could not parse constraint name from ${match[0]}`);
    }
    return constraintName;
  });
}

function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}
