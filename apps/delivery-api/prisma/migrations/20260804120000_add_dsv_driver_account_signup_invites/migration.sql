CREATE TABLE "dsv_driver_account_signup_invites" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_driver_account_signup_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dsv_driver_account_signup_invites_tokenHash_key"
ON "dsv_driver_account_signup_invites"("tokenHash");

CREATE INDEX "dsv_driver_account_signup_invites_driverId_expiresAt_idx"
ON "dsv_driver_account_signup_invites"("driverId", "expiresAt");

ALTER TABLE "dsv_driver_account_signup_invites"
ADD CONSTRAINT "dsv_driver_account_signup_invites_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
