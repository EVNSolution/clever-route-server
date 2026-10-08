-- Preserve existing receipts and add an explicit private-draft recovery command.
ALTER TABLE "route_live_change_command_receipts"
  DROP CONSTRAINT "route_live_change_command_receipts_kind_check",
  ADD CONSTRAINT "route_live_change_command_receipts_kind_check"
    CHECK ("kind" IN ('SAVE', 'DISPATCH', 'DISCARD') AND "assignmentGeneration" > 0);
