-- Collapse persisted route/group lifecycle values without dropping enum variants.
-- ponytail: old enum variants stay in the DB schema because production deploy uses prisma db push,
-- which correctly blocks enum removal as data-loss. App code must only create DRAFT/PUBLISHED/CANCELLED.

UPDATE "RoutePlan"
SET "status" = CASE "status"::text
  WHEN 'OPTIMIZED' THEN 'DRAFT'
  WHEN 'ASSIGNED' THEN 'PUBLISHED'
  WHEN 'IN_PROGRESS' THEN 'PUBLISHED'
  WHEN 'COMPLETED' THEN 'PUBLISHED'
  ELSE "status"::text
END::"RoutePlanStatus"
WHERE "status"::text IN ('OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED');

UPDATE "RouteGrouping"
SET "status" = CASE "status"::text
  WHEN 'READY' THEN 'DRAFT'
  WHEN 'CHANGED' THEN 'DRAFT'
  ELSE "status"::text
END::"RouteGroupingStatus"
WHERE "status"::text IN ('READY', 'CHANGED');
