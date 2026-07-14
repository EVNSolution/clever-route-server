CREATE TABLE "driver_accounts" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "pinSalt" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_accounts_phone_key" ON "driver_accounts"("phone");
CREATE INDEX "driver_accounts_status_idx" ON "driver_accounts"("status");

ALTER TABLE "drivers" ADD COLUMN "accountId" UUID;
CREATE INDEX "drivers_accountId_status_idx" ON "drivers"("accountId", "status");
ALTER TABLE "drivers"
    ADD CONSTRAINT "drivers_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "driver_account_sessions" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "driver_account_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_account_sessions_refreshTokenHash_key"
    ON "driver_account_sessions"("refreshTokenHash");
CREATE INDEX "driver_account_sessions_accountId_expiresAt_idx"
    ON "driver_account_sessions"("accountId", "expiresAt");
ALTER TABLE "driver_account_sessions"
    ADD CONSTRAINT "driver_account_sessions_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
