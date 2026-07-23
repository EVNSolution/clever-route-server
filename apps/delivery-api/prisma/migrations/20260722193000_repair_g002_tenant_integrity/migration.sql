-- G002 repair: enforce tenant-scoped references for DSV receipt/audit history.
-- The original G002 migration is already merged; this follow-up is deterministic and
-- intentionally avoids idempotent DDL wrappers or swallowed duplicate errors.

CREATE UNIQUE INDEX "orders_id_shopId_key" ON "orders"("id", "shopId");
CREATE UNIQUE INDEX "route_plans_id_shopId_key" ON "route_plans"("id", "shopId");
CREATE UNIQUE INDEX "route_grouping_child_versions_id_shopId_key" ON "route_grouping_child_versions"("id", "shopId");
CREATE UNIQUE INDEX "dsv_dispatch_imports_id_shopId_key" ON "dsv_dispatch_imports"("id", "shopId");
CREATE UNIQUE INDEX "dsv_command_receipts_id_shopId_key" ON "dsv_command_receipts"("id", "shopId");

ALTER TABLE "orders" DROP CONSTRAINT "orders_currentRouteVersionId_fkey";
ALTER TABLE "route_grouping_child_versions" DROP CONSTRAINT "route_grouping_child_versions_routePlanId_fkey";
ALTER TABLE "dsv_dispatch_import_rows" DROP CONSTRAINT "dsv_dispatch_import_rows_importId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_importId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_sellerOrderId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_previousRoutePlanId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_nextRoutePlanId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_previousRouteVersionId_fkey";
ALTER TABLE "dsv_command_receipts" DROP CONSTRAINT "dsv_command_receipts_nextRouteVersionId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_sellerOrderId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_commandReceiptId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_importId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_previousRoutePlanId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_nextRoutePlanId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_previousRouteVersionId_fkey";
ALTER TABLE "dsv_audit_events" DROP CONSTRAINT "dsv_audit_events_nextRouteVersionId_fkey";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_currentRouteVersionId_shopId_fkey"
  FOREIGN KEY ("currentRouteVersionId", "shopId") REFERENCES "route_grouping_child_versions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "route_grouping_child_versions"
  ADD CONSTRAINT "route_grouping_child_versions_routePlanId_shopId_fkey"
  FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_importId_shopId_fkey"
  FOREIGN KEY ("importId", "shopId") REFERENCES "dsv_dispatch_imports"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_importId_shopId_fkey"
  FOREIGN KEY ("importId", "shopId") REFERENCES "dsv_dispatch_imports"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_sellerOrderId_shopId_fkey"
  FOREIGN KEY ("sellerOrderId", "shopId") REFERENCES "orders"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_previousRoutePlanId_shopId_fkey"
  FOREIGN KEY ("previousRoutePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_nextRoutePlanId_shopId_fkey"
  FOREIGN KEY ("nextRoutePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_previousRouteVersionId_shopId_fkey"
  FOREIGN KEY ("previousRouteVersionId", "shopId") REFERENCES "route_grouping_child_versions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_command_receipts"
  ADD CONSTRAINT "dsv_command_receipts_nextRouteVersionId_shopId_fkey"
  FOREIGN KEY ("nextRouteVersionId", "shopId") REFERENCES "route_grouping_child_versions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_sellerOrderId_shopId_fkey"
  FOREIGN KEY ("sellerOrderId", "shopId") REFERENCES "orders"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_commandReceiptId_shopId_fkey"
  FOREIGN KEY ("commandReceiptId", "shopId") REFERENCES "dsv_command_receipts"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_importId_shopId_fkey"
  FOREIGN KEY ("importId", "shopId") REFERENCES "dsv_dispatch_imports"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_previousRoutePlanId_shopId_fkey"
  FOREIGN KEY ("previousRoutePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_nextRoutePlanId_shopId_fkey"
  FOREIGN KEY ("nextRoutePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_previousRouteVersionId_shopId_fkey"
  FOREIGN KEY ("previousRouteVersionId", "shopId") REFERENCES "route_grouping_child_versions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_nextRouteVersionId_shopId_fkey"
  FOREIGN KEY ("nextRouteVersionId", "shopId") REFERENCES "route_grouping_child_versions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
