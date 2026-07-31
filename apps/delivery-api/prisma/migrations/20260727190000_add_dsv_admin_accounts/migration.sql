CREATE TYPE "DsvAdminAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "dsv_admin_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "loginId" TEXT NOT NULL,
    "displayName" TEXT,
    "passwordHash" TEXT NOT NULL,
    "passwordSalt" TEXT NOT NULL,
    "status" "DsvAdminAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastAuthenticatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_admin_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dsv_admin_accounts_loginId_key" ON "dsv_admin_accounts"("loginId");
CREATE INDEX "dsv_admin_accounts_status_idx" ON "dsv_admin_accounts"("status");
