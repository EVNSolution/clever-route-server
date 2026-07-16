-- Add the route lifecycle state used by newly-created route plans.
-- Existing DRAFT/PUBLISHED rows remain readable and are normalized by application code.
ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'READY';
