-- G007 compatibility bridge for historical migrations that still reference quoted Prisma model table names.
-- These tables are intentionally empty placeholders. Real data lives in mapped lowercase tables.

DO $$
BEGIN
  IF to_regclass('"Shop"') IS NULL THEN
    CREATE TABLE "Shop" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
    );
    COMMENT ON TABLE "Shop" IS 'G007 transient mapped-table compatibility bridge';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"RoutePlan"') IS NULL THEN
    CREATE TABLE "RoutePlan" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "status" "RoutePlanStatus" NOT NULL DEFAULT 'DRAFT',
      CONSTRAINT "RoutePlan_pkey" PRIMARY KEY ("id")
    );
    COMMENT ON TABLE "RoutePlan" IS 'G007 transient mapped-table compatibility bridge';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('"RouteGrouping"') IS NULL THEN
    CREATE TABLE "RouteGrouping" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "status" TEXT NOT NULL DEFAULT 'DRAFT',
      CONSTRAINT "RouteGrouping_pkey" PRIMARY KEY ("id")
    );
    COMMENT ON TABLE "RouteGrouping" IS 'G007 transient mapped-table compatibility bridge';
  END IF;
END $$;
