DROP INDEX IF EXISTS "route_plan_stops_deliveryStopId_key";
CREATE INDEX IF NOT EXISTS "route_plan_stops_deliveryStopId_idx" ON "route_plan_stops"("deliveryStopId");

DROP INDEX IF EXISTS "route_grouping_branch_order_locks_shopId_orderId_key";
CREATE UNIQUE INDEX "route_grouping_branch_order_locks_groupingId_orderId_key" ON "route_grouping_branch_order_locks"("groupingId", "orderId");
