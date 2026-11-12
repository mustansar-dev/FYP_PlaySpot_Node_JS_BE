ALTER TABLE "bookings"
  ADD COLUMN "hold_expires_at" TIMESTAMPTZ(3);

CREATE INDEX "bookings_status_hold_expires_at_idx"
  ON "bookings"("status", "hold_expires_at");

ALTER TABLE "payments"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ADD COLUMN "method" "payment_method",
  ADD COLUMN "environment" "payment_environment",
  ADD COLUMN "booking_id" UUID;

UPDATE "payments"
SET "method" = 'ONLINE',
    "environment" = CASE
      WHEN "provider" = 'DEVELOPMENT_MOCK' THEN 'DEVELOPMENT'::"payment_environment"
      ELSE 'SANDBOX'::"payment_environment"
    END;

ALTER TABLE "payments"
  ALTER COLUMN "method" SET NOT NULL,
  ALTER COLUMN "environment" SET NOT NULL;

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_user_id_fkey",
  ADD CONSTRAINT "payments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "payments_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "vendor_payment_instructions" (
  "id" UUID NOT NULL,
  "vendor_profile_id" UUID NOT NULL,
  "account_title" VARCHAR(160) NOT NULL,
  "bank_name" VARCHAR(120) NOT NULL,
  "iban" VARCHAR(34),
  "account_number" VARCHAR(64),
  "instructions" VARCHAR(1000),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "vendor_payment_instructions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_payment_instructions_account_check"
    CHECK ("iban" IS NOT NULL OR "account_number" IS NOT NULL),
  CONSTRAINT "vendor_payment_instructions_iban_trimmed_check"
    CHECK ("iban" IS NULL OR length(btrim("iban")) > 0),
  CONSTRAINT "vendor_payment_instructions_account_number_trimmed_check"
    CHECK ("account_number" IS NULL OR length(btrim("account_number")) > 0)
);

CREATE UNIQUE INDEX "vendor_payment_instructions_vendor_profile_id_key"
  ON "vendor_payment_instructions"("vendor_profile_id");

CREATE TABLE "payment_receipts" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "storage_path" VARCHAR(500) NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(120) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "status" "payment_receipt_status" NOT NULL DEFAULT 'SUBMITTED',
  "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_by_user_id" UUID,
  "reviewed_at" TIMESTAMPTZ(3),
  "rejection_reason" VARCHAR(500),
  CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_receipts_size_check"
    CHECK ("size_bytes" BETWEEN 1 AND 5242880),
  CONSTRAINT "payment_receipts_mime_type_check"
    CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  CONSTRAINT "payment_receipts_review_fields_check"
    CHECK (("status" = 'SUBMITTED' AND "reviewed_at" IS NULL AND "reviewed_by_user_id" IS NULL)
      OR ("status" <> 'SUBMITTED' AND "reviewed_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "payment_receipts_storage_path_key"
  ON "payment_receipts"("storage_path");
CREATE INDEX "payment_receipts_payment_id_submitted_at_idx"
  ON "payment_receipts"("payment_id", "submitted_at");

CREATE TABLE "payment_status_audits" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "previous_status" "payment_status",
  "new_status" "payment_status" NOT NULL,
  "amount_paisa" INTEGER,
  "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_status_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_status_audits_amount_check"
    CHECK ("amount_paisa" IS NULL OR "amount_paisa" >= 0)
);

CREATE INDEX "payment_status_audits_payment_id_created_at_idx"
  ON "payment_status_audits"("payment_id", "created_at");

CREATE INDEX "payments_booking_id_created_at_idx"
  ON "payments"("booking_id", "created_at");
CREATE INDEX "payments_contribution_id_status_idx"
  ON "payments"("contribution_id", "status");

-- A contribution can have only one open attempt at a time; rejected/failed attempts may be retried.
CREATE UNIQUE INDEX "payments_one_open_contribution_payment_idx"
  ON "payments"("contribution_id")
  WHERE "contribution_id" IS NOT NULL
    AND "status" IN ('PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED');

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_target_matches_purpose_check",
  ADD CONSTRAINT "payments_target_matches_purpose_check" CHECK (
    ("purpose" = 'BOOKING_CONTRIBUTION' AND "contribution_id" IS NOT NULL AND "booking_id" IS NULL AND "tournament_participant_id" IS NULL)
    OR ("purpose" = 'TOURNAMENT_ENTRY' AND "contribution_id" IS NULL AND "booking_id" IS NULL AND "tournament_participant_id" IS NOT NULL)
    OR ("purpose" = 'WALK_IN_BOOKING' AND "contribution_id" IS NULL AND "booking_id" IS NOT NULL AND "tournament_participant_id" IS NULL)
  ),
  ADD CONSTRAINT "payments_method_provider_check" CHECK (
    ("method" = 'ONLINE' AND "provider" IN ('SAFEPAY', 'DEVELOPMENT_MOCK') AND "environment" IN ('SANDBOX', 'DEVELOPMENT'))
    OR ("method" IN ('PAY_AT_VENUE', 'BANK_TRANSFER') AND "provider" = 'MANUAL' AND "environment" = 'MANUAL')
  ),
  ADD CONSTRAINT "payments_currency_pkr_check" CHECK ("currency" = 'PKR');

ALTER TABLE "payment_receipts"
  ADD CONSTRAINT "payment_receipts_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_receipts_reviewed_by_user_id_fkey"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_status_audits"
  ADD CONSTRAINT "payment_status_audits_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_status_audits_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vendor_payment_instructions"
  ADD CONSTRAINT "vendor_payment_instructions_vendor_profile_id_fkey"
    FOREIGN KEY ("vendor_profile_id") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
