-- Restore indexes dropped by 20261120141941_1st. Prisma now declares these
-- indexes in schema.prisma so future migration diffs keep them in place.
CREATE INDEX "payments_booking_id_created_at_idx"
  ON "payments"("booking_id", "created_at");

CREATE INDEX "payments_contribution_id_status_idx"
  ON "payments"("contribution_id", "status");

CREATE INDEX "venues_location_gist_idx"
  ON "venues" USING GIST ("location");
