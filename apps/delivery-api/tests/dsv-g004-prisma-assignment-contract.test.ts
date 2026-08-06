import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260722213000_dsv_assignment_eta_state/migration.sql',
  import.meta.url
);

describe('G004 DSV Prisma assignment contract', () => {
  test('adds canonical ETA state to route plan stops with route-version input ownership', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const migration = await readFile(migrationPath, 'utf8');
    const routePlanStop = modelBody(schema, 'RoutePlanStop');
    const routeVersion = modelBody(schema, 'RouteGroupingChildVersion');
    const driverEvent = modelBody(schema, 'DriverEvent');

    expect(schema).toMatch(/enum DsvEtaStatus \{[\s\S]*NOT_REQUIRED[\s\S]*PENDING[\s\S]*READY[\s\S]*FAILED[\s\S]*STALE[\s\S]*\}/u);
    expect(routePlanStop).toContain('shopId                      String                     @db.Uuid');
    expect(routePlanStop).toContain('shop                        Shop                       @relation(fields: [shopId], references: [id], onDelete: Cascade)');
    expect(routePlanStop).toContain('routePlan                   RoutePlan                  @relation(fields: [routePlanId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(routePlanStop).toContain('deliveryStop                DeliveryStop               @relation(fields: [deliveryStopId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(routePlanStop).toContain('etaStatus                   DsvEtaStatus               @default(NOT_REQUIRED)');
    expect(routePlanStop).toContain('etaInputRouteVersionId      String?                    @db.Uuid');
    expect(routePlanStop).toContain(
      'etaInputRouteVersion        RouteGroupingChildVersion? @relation("RoutePlanStopEtaInputRouteVersion", fields: [etaInputRouteVersionId, shopId, routePlanId], references: [id, shopId, routePlanId], onDelete: NoAction)'
    );
    expect(routePlanStop).toContain('etaSource                   String?                    @db.Text');
    expect(routePlanStop).toContain('etaCalculatedAt             DateTime?                  @db.Timestamptz(6)');
    expect(routePlanStop).toContain('etaFailureCode              String?                    @db.Text');
    expect(routePlanStop).toContain('etaFailureMessage           String?                    @db.Text');
    expect(routePlanStop).toContain('@@index([shopId, routePlanId])');
    expect(routePlanStop).toContain('@@index([etaInputRouteVersionId])');
    expect(routePlanStop).toContain('@@index([routePlanId, etaStatus])');
    expect(routeVersion).toContain('etaInputRouteStops   RoutePlanStop[]                  @relation("RoutePlanStopEtaInputRouteVersion")');
    expect(routeVersion).toContain('driverEvents         DriverEvent[]                    @relation("DriverEventRouteVersion")');
    expect(routeVersion).toContain('@@unique([id, shopId, routePlanId])');
    expect(driverEvent).toContain('routePlan                     RoutePlan?                 @relation(fields: [routePlanId, shopId], references: [id, shopId], onDelete: NoAction)');
    expect(driverEvent).toContain('routeVersionId                String?                    @db.Uuid');
    expect(driverEvent).toContain('routeVersion                  RouteGroupingChildVersion? @relation("DriverEventRouteVersion", fields: [routeVersionId, shopId, routePlanId], references: [id, shopId, routePlanId], onDelete: NoAction)');
    expect(driverEvent).toContain('@@index([shopId, routeVersionId, occurredAt])');

    expect(migration).toContain('CREATE TYPE "DsvEtaStatus" AS ENUM');
    expect(migration).toContain('ADD COLUMN "shopId" UUID');
    expect(migration).toContain('ADD COLUMN "etaStatus" "DsvEtaStatus" NOT NULL DEFAULT \'NOT_REQUIRED\'');
    expect(migration).toContain('ADD COLUMN "etaInputRouteVersionId" UUID');
    expect(migration).toContain('ADD COLUMN "etaSource" TEXT');
    expect(migration).toContain('ALTER TABLE "driver_events"');
    expect(migration).toContain('ADD COLUMN "routeVersionId" UUID');
    expect(migration).toContain('UPDATE "route_plan_stops" route_stop');
    expect(migration).toContain('ALTER COLUMN "shopId" SET NOT NULL');
    expect(migration).toContain('CREATE INDEX "route_plan_stops_etaInputRouteVersionId_idx"');
    expect(migration).toContain('CREATE INDEX "route_plan_stops_routePlanId_etaStatus_idx"');
    expect(migration).toContain('CREATE INDEX "route_plan_stops_shopId_routePlanId_idx"');
    expect(migration).toContain('CREATE INDEX "driver_events_shopId_routeVersionId_occurredAt_idx"');
    expect(migration).toContain('CREATE UNIQUE INDEX "route_grouping_child_versions_id_shopId_routePlanId_key"');
    expect(migration).toContain('ADD CONSTRAINT "route_plan_stops_routePlanId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "route_plan_stops_deliveryStopId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "route_plan_stops_etaInputRouteVersionId_fkey"');
    expect(migration).toContain(
      'FOREIGN KEY ("etaInputRouteVersionId", "shopId", "routePlanId") REFERENCES "route_grouping_child_versions"("id", "shopId", "routePlanId")'
    );
    expect(migration).toContain('ADD CONSTRAINT "driver_events_routeVersionId_shopId_fkey"');
    expect(migration).toContain(
      'FOREIGN KEY ("routeVersionId", "shopId", "routePlanId") REFERENCES "route_grouping_child_versions"("id", "shopId", "routePlanId")'
    );
    expect(migration).toContain('RAISE EXCEPTION \'Cannot enforce route_plan_stops.shopId');
  });

  test('keeps assignment ownership on canonical order route versions without DSV shadow assignment storage', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const migration = await readFile(migrationPath, 'utf8');
    const order = modelBody(schema, 'Order');
    const receipt = modelBody(schema, 'DsvCommandReceipt');
    const audit = modelBody(schema, 'DsvAuditEvent');

    expect(order).toContain('currentRouteVersionId');
    expect(order).toContain('currentRouteVersion');
    expect(order).toContain('@@index([shopId, currentRouteVersionId])');
    expect(receipt).toContain('previousRouteVersionId');
    expect(receipt).toContain('nextRouteVersionId');
    expect(audit).toContain('previousRouteVersionId');
    expect(audit).toContain('nextRouteVersionId');

    expect(schema).not.toMatch(/model\s+Dsv(?:SellerOrder)?Assignment\b/u);
    expect(schema).not.toMatch(/@@map\("dsv_(?:seller_order_)?assignments"\)/u);
    expect(migration).not.toMatch(/\bCREATE\s+TABLE\b/iu);
    expect(migration).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER)\b/iu);
    expect(migration).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE)\b/imu);
  });
});

function modelBody(schema: string, modelName: string): string {
  return new RegExp(`model ${modelName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}
