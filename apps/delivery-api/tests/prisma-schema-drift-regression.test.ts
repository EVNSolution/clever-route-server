import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);

function model(schema: string, name: string): string {
  return new RegExp(`model ${name} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}

describe('Prisma migration-history schema alignment', () => {
  test('keeps database-generated UUID defaults and migrated update defaults', async () => {
    const schema = await readFile(schemaPath, 'utf8');

    for (const name of [
      'ShopifyOrderRedactionTombstone',
      'ShopifyShopRedactionTombstone',
      'ShopifyRedactedWebhookReceipt',
      'OrderSelectionSnapshot',
      'DsvVehicleTelematicsDevice',
      'UvisVehicleTelemetryCurrent',
      'UvisVehicleTelemetrySample',
      'UvisVehicleTrailMaterialization',
      'DriverEventAttempt',
      'DriverRouteCompletionReview',
      'DriverRouteCompletionReviewHistory',
      'DriverRouteCompletionGateHistory'
    ]) {
      expect(model(schema, name)).toMatch(/\bid\s+String\s+@id @default\(dbgenerated\("gen_random_uuid\(\)"\)\) @db\.Uuid/u);
    }

    for (const name of [
      'DriverBundleHandoffRequest',
      'DriverSyncSession',
      'DriverRouteSessionLease',
      'AlertCondition',
      'AlertCycle',
      'DsvDispatchChangeRequest',
      'OrderMessage',
      'ShopifyOrderReconciliationJob',
      'DriverEventAttempt'
    ]) {
      expect(model(schema, name)).toMatch(/\bupdatedAt\s+DateTime\s+@default\(now\(\)\) @updatedAt @db\.Timestamptz\(6\)/u);
    }

    expect(model(schema, 'RouteGroupingPolygon')).toMatch(/\bupdatedAt\s+DateTime\s+@updatedAt @db\.Timestamptz\(6\)/u);
    expect(model(schema, 'RouteGroupingPolygon')).not.toMatch(/\bupdatedAt\s+DateTime\s+@default\(now\(\)\)/u);
  });

  test('preserves migrated foreign-key actions and physical constraint names', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const expected = [
      ['DriverSyncSession', 'map: "driver_sync_sessions_shop_fkey"'],
      ['DriverSyncSession', 'map: "driver_sync_sessions_route_fkey"'],
      ['DriverSyncSession', 'map: "driver_sync_sessions_driver_fkey"'],
      ['DriverRouteSessionLease', 'map: "driver_route_session_leases_shop_fkey"'],
      ['DriverRouteSessionLease', 'map: "driver_route_session_leases_route_fkey"'],
      ['DriverRouteSessionLease', 'map: "driver_route_session_leases_driver_fkey"'],
      ['DriverRouteSessionLease', 'map: "driver_route_session_leases_session_fkey"'],
      ['DriverSyncHeartbeat', 'map: "driver_sync_heartbeats_session_fkey"'],
      ['AlertCondition', 'map: "alert_conditions_shop_fkey"'],
      ['AlertCycle', 'map: "alert_cycles_condition_fkey"'],
      ['AlertCycle', 'map: "alert_cycles_legacy_fkey"'],
      ['CustomerDeliveryNotificationAttempt', 'map: "customer_delivery_notification_attempts_shop_fkey"'],
      ['CustomerDeliveryNotificationAttempt', 'map: "customer_delivery_notification_attempts_fact_fkey"'],
      ['CustomerDeliveryNotificationAttempt', 'map: "customer_delivery_notification_attempts_manual_fkey"'],
      ['CustomerEmailOperatorReconciliation', 'map: "customer_email_operator_reconciliations_shop_fkey"'],
      ['CustomerEmailReconciliationTombstone', 'map: "customer_email_reconciliation_tombstones_shop_fkey"'],
      ['CustomerEmailReconciliationTombstone', 'map: "customer_email_reconciliation_tombstones_target_fkey"'],
      ['DriverRouteCompletionReview', 'map: "driver_route_completion_reviews_shop_fkey"'],
      ['DriverRouteCompletionReview', 'map: "driver_route_completion_reviews_attempt_fkey"'],
      ['DriverRouteCompletionReview', 'map: "driver_route_completion_reviews_event_fkey"'],
      ['DriverRouteCompletionReviewHistory', 'map: "driver_route_completion_review_history_review_fkey"']
    ] as const;

    for (const [name, constraint] of expected) {
      expect(model(schema, name)).toContain('onUpdate: NoAction');
      expect(model(schema, name)).toContain(constraint);
    }

    expect(model(schema, 'UvisVehicleTelemetryCurrent')).toContain(
      'map: "uvis_vehicle_telemetry_current_lastSampleId_shopId_deviceId_sou"'
    );
  });

  test('models the raw-SQL trigram indexes and does not invent the lease index', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const trigramIndexes = schema.match(/@@index\(\[[^\n]+gin_trgm_ops[^\n]+type: Gin\)/gu) ?? [];

    expect(trigramIndexes).toHaveLength(26);
    expect(model(schema, 'Order')).toContain('map: "orders_sourceOrderNumber_trgm_idx", type: Gin');
    expect(model(schema, 'DeliveryStop')).toContain('map: "delivery_stops_recipientName_trgm_idx", type: Gin');
    expect(model(schema, 'OrderDeliveryFact')).toContain('map: "order_delivery_facts_weekday_trgm_idx", type: Gin');
    expect(model(schema, 'DriverRouteSessionLease')).not.toContain('@@index([routePlanId, driverId, expiresAt])');
  });

  test('pins every shortened migration-created index name', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const shortenedNames = [
      'driver_bundle_handoff_requests_shopId_groupingId_destinationId_',
      'driver_bundle_handoff_requests_shopId_sourceDriverId_status_cre',
      'driver_bundle_handoff_requests_shopId_targetDriverId_status_cre',
      'shopify_redacted_webhook_receipts_appId_shopDomain_redactedAt_i',
      'orders_shopId_sellerOrderSourceKind_sellerOrderKey_serviceDate_',
      'order_selection_snapshots_shopId_appId_actorSubjectHash_expires',
      'dsv_customer_account_invites_shopId_customerId_purpose_expiresA',
      'routes_app_release_artifacts_platform_distributionChannel_versi',
      'order_messages_shop_order_audience_createdAt_idx',
      'customer_email_manual_dispatches_shopId_routePlanId_createdAt_i',
      'customer_email_manual_dispatch_recipients_shopId_routePlanId_de',
      'driver_sync_sessions_last_observed_idx',
      'driver_sync_sessions_route_driver_expires_idx',
      'driver_sync_heartbeats_retention_idx',
      'driver_sync_heartbeats_session_received_idx',
      'driver_route_session_leases_session_idx',
      'alert_conditions_shop_type_idx',
      'alert_cycles_condition_opened_idx',
      'alert_cycles_legacy_idx',
      'alert_cycles_retention_idx',
      'customer_delivery_notification_attempts_retention_idx',
      'customer_delivery_notification_attempts_shop_created_idx',
      'customer_email_operator_reconciliations_correlation_idx',
      'customer_email_operator_reconciliations_retention_idx',
      'customer_email_operator_reconciliations_shop_created_idx',
      'customer_email_reconciliation_tombstones_correlation_idx',
      'customer_email_reconciliation_tombstones_shop_created_idx',
      'customer_email_reconciliation_tombstones_shop_target_idx',
      'admin_route_stop_action_audits_shopId_routePlanId_deliveryStopI',
      'uvis_vehicle_telemetry_samples_deviceId_sourceKind_observedAt_k',
      'uvis_vehicle_telemetry_samples_id_shopId_deviceId_sourceKind_ke',
      'uvis_vehicle_trail_materializations_shop_vehicle_day_schema_key',
      'uvis_vehicle_trail_materializations_shopId_vehicleId_serviceDat',
      'dsv_change_requests_shop_order_status_idx',
      'dsv_change_requests_shop_status_route_stop_createdAt_idx'
    ];

    expect(shortenedNames).toHaveLength(35);
    for (const name of shortenedNames) expect(schema).toContain(`map: "${name}"`);
  });
});
