ALTER TABLE "dsv_transport_conditions"
  ADD COLUMN "temperatureAlertEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temperatureMinC" DECIMAL(6,2),
  ADD COLUMN "temperatureMaxC" DECIMAL(6,2);

ALTER TABLE "dsv_transport_conditions"
  ADD CONSTRAINT "dsv_transport_conditions_temperature_range_chk"
  CHECK (
    "temperatureMinC" IS NULL
    OR "temperatureMaxC" IS NULL
    OR "temperatureMinC" <= "temperatureMaxC"
  );
