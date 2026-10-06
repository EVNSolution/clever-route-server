-- Additive lifecycle state for historical routes whose tracking window ended
-- before all stops reached a terminal delivery outcome.
ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
