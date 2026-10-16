-- Customer invitation history: who a link is for (free text) and which administrator issued it.
-- Both are NULL for invites issued before this migration. The administrator link is cleared when that account is deleted.
ALTER TABLE "dsv_customer_account_invites" ADD COLUMN "inviteeLabel" TEXT;
ALTER TABLE "dsv_customer_account_invites" ADD COLUMN "invitedByAccountId" UUID;
ALTER TABLE "dsv_customer_account_invites"
  ADD CONSTRAINT "dsv_customer_account_invites_invitedByAccountId_fkey"
  FOREIGN KEY ("invitedByAccountId") REFERENCES "dsv_admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
