BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "driver_proof_media" AS media
    LEFT JOIN "route_plans" AS route_plan
      ON route_plan."id" = media."routePlanId" AND route_plan."shopId" = media."shopId"
    LEFT JOIN "delivery_stops" AS delivery_stop
      ON delivery_stop."id" = media."deliveryStopId" AND delivery_stop."shopId" = media."shopId"
    LEFT JOIN "drivers" AS driver
      ON driver."id" = media."driverId" AND driver."shopId" = media."shopId"
    WHERE route_plan."id" IS NULL
       OR delivery_stop."id" IS NULL
       OR (media."driverId" IS NOT NULL AND driver."id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'driver_proof_media contains cross-tenant parent references'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TABLE "driver_proof_media_delivery_stops" (
    "proofMediaId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_proof_media_delivery_stops_pkey" PRIMARY KEY ("proofMediaId", "deliveryStopId")
);

ALTER TABLE "driver_proof_media"
ADD CONSTRAINT "driver_proof_media_id_shopId_key" UNIQUE ("id", "shopId");

INSERT INTO "driver_proof_media_delivery_stops" ("proofMediaId", "shopId", "deliveryStopId", "createdAt")
SELECT media."id", media."shopId", media."deliveryStopId", media."createdAt"
FROM "driver_proof_media" AS media
ON CONFLICT ("proofMediaId", "deliveryStopId") DO NOTHING;

INSERT INTO "driver_proof_media_delivery_stops" ("proofMediaId", "shopId", "deliveryStopId", "createdAt")
SELECT media."id", media."shopId", sibling_stop."id", media."createdAt"
FROM "driver_proof_media" AS media
JOIN "delivery_stops" AS anchor_stop
  ON anchor_stop."id" = media."deliveryStopId"
 AND anchor_stop."shopId" = media."shopId"
JOIN "orders" AS anchor_order
  ON anchor_order."id" = anchor_stop."orderId"
 AND anchor_order."shopId" = media."shopId"
JOIN "orders" AS sibling_order
  ON sibling_order."shopId" = media."shopId"
 AND sibling_order."destinationId" = anchor_order."destinationId"
JOIN "delivery_stops" AS sibling_stop
  ON sibling_stop."orderId" = sibling_order."id"
 AND sibling_stop."shopId" = media."shopId"
JOIN "route_plan_stops" AS sibling_route_stop
  ON sibling_route_stop."routePlanId" = media."routePlanId"
 AND sibling_route_stop."deliveryStopId" = sibling_stop."id"
 AND sibling_route_stop."shopId" = media."shopId"
WHERE anchor_order."destinationId" IS NOT NULL
ON CONFLICT ("proofMediaId", "deliveryStopId") DO NOTHING;

CREATE INDEX "driver_proof_media_delivery_stops_deliveryStopId_proofMediaId_idx"
ON "driver_proof_media_delivery_stops"("deliveryStopId", "proofMediaId");

ALTER TABLE "driver_proof_media_delivery_stops"
ADD CONSTRAINT "driver_proof_media_delivery_stops_proofMediaId_fkey"
FOREIGN KEY ("proofMediaId", "shopId") REFERENCES "driver_proof_media"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Check retained-parent references at commit so the multi-level shop cascade can
-- remove media and links first. Standalone route/stop deletes still fail.
ALTER TABLE "driver_proof_media_delivery_stops"
ADD CONSTRAINT "driver_proof_media_delivery_stops_deliveryStopId_fkey"
FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "driver_proof_media"
DROP CONSTRAINT "driver_proof_media_routePlanId_fkey",
ADD CONSTRAINT "driver_proof_media_routePlanId_fkey"
FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "driver_proof_media"
DROP CONSTRAINT "driver_proof_media_deliveryStopId_fkey",
ADD CONSTRAINT "driver_proof_media_deliveryStopId_fkey"
FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

COMMIT;
