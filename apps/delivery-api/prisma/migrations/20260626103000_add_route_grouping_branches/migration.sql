CREATE TABLE "route_grouping_branches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "groupingId" UUID NOT NULL,
  "driverId" UUID,
  "label" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "route_grouping_branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "route_grouping_branch_order_locks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "groupingId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "routeGroupingOrderId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "deliveryStopId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "route_grouping_branch_order_locks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "route_grouping_branches_groupingId_createdAt_idx"
  ON "route_grouping_branches"("groupingId", "createdAt");
CREATE INDEX "route_grouping_branches_shopId_driverId_idx"
  ON "route_grouping_branches"("shopId", "driverId");

CREATE UNIQUE INDEX "route_grouping_branch_order_locks_shopId_orderId_key"
  ON "route_grouping_branch_order_locks"("shopId", "orderId");
CREATE INDEX "route_grouping_branch_order_locks_groupingId_idx"
  ON "route_grouping_branch_order_locks"("groupingId");
CREATE INDEX "route_grouping_branch_order_locks_branchId_idx"
  ON "route_grouping_branch_order_locks"("branchId");

ALTER TABLE "route_grouping_branches"
  ADD CONSTRAINT "route_grouping_branches_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branches"
  ADD CONSTRAINT "route_grouping_branches_groupingId_fkey"
  FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branches"
  ADD CONSTRAINT "route_grouping_branches_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_groupingId_fkey"
  FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "route_grouping_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_routeGroupingOrderId_fkey"
  FOREIGN KEY ("routeGroupingOrderId") REFERENCES "route_grouping_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_branch_order_locks"
  ADD CONSTRAINT "route_grouping_branch_order_locks_deliveryStopId_fkey"
  FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
