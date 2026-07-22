-- CreateEnum
CREATE TYPE "DsvDispatchImportStatus" AS ENUM ('READY', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DsvDispatchImportRowStatus" AS ENUM ('READY', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "dsv_driver_profiles" (
    "driverId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "lookupName" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "career" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "score" TEXT NOT NULL,
    "traits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_driver_profiles_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "dsv_vehicle_profiles" (
    "vehicleId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "typeLabel" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_vehicle_profiles_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "dsv_vehicle_driver_assignments" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_vehicle_driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_transport_conditions" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_transport_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_dispatch_imports" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "status" "DsvDispatchImportStatus" NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_dispatch_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_dispatch_import_rows" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "driverId" UUID,
    "vehicleId" UUID,
    "driverName" TEXT NOT NULL,
    "vehiclePlate" TEXT NOT NULL,
    "destinationName" TEXT NOT NULL,
    "conditionCode" TEXT NOT NULL,
    "shippedBoxes" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "sellerOrderKey" TEXT NOT NULL,
    "notes" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "status" "DsvDispatchImportRowStatus" NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_dispatch_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dsv_driver_profiles_shopId_idx" ON "dsv_driver_profiles"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_driver_profiles_shopId_lookupName_key" ON "dsv_driver_profiles"("shopId", "lookupName");

-- CreateIndex
CREATE INDEX "dsv_vehicle_profiles_shopId_idx" ON "dsv_vehicle_profiles"("shopId");

-- CreateIndex
CREATE INDEX "dsv_vehicle_driver_assignments_shopId_driverId_idx" ON "dsv_vehicle_driver_assignments"("shopId", "driverId");

-- CreateIndex
CREATE INDEX "dsv_vehicle_driver_assignments_shopId_vehicleId_idx" ON "dsv_vehicle_driver_assignments"("shopId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_vehicle_driver_assignments_shopId_vehicleId_driverId_key" ON "dsv_vehicle_driver_assignments"("shopId", "vehicleId", "driverId");

-- CreateIndex
CREATE INDEX "dsv_transport_conditions_shopId_createdAt_idx" ON "dsv_transport_conditions"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_transport_conditions_shopId_code_key" ON "dsv_transport_conditions"("shopId", "code");

-- CreateIndex
CREATE INDEX "dsv_dispatch_imports_shopId_planDate_createdAt_idx" ON "dsv_dispatch_imports"("shopId", "planDate", "createdAt");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_importId_status_rowNumber_idx" ON "dsv_dispatch_import_rows"("importId", "status", "rowNumber");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_driverId_idx" ON "dsv_dispatch_import_rows"("driverId");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_vehicleId_idx" ON "dsv_dispatch_import_rows"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_dispatch_import_rows_importId_rowNumber_key" ON "dsv_dispatch_import_rows"("importId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_key" ON "dsv_dispatch_import_rows"("shopId", "sellerOrderKey");

-- AddForeignKey
ALTER TABLE "dsv_driver_profiles" ADD CONSTRAINT "dsv_driver_profiles_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_driver_profiles" ADD CONSTRAINT "dsv_driver_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_profiles" ADD CONSTRAINT "dsv_vehicle_profiles_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_profiles" ADD CONSTRAINT "dsv_vehicle_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_transport_conditions" ADD CONSTRAINT "dsv_transport_conditions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_imports" ADD CONSTRAINT "dsv_dispatch_imports_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
