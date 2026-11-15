-- PostGIS and btree_gist live in a dedicated schema on Supabase.
CREATE SCHEMA IF NOT EXISTS "extensions";
-- PostGIS is a non-relocatable extension installed by PostgreSQL in public.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA "extensions";
SET search_path = "public", "extensions";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('PLAYER', 'VENDOR');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "vendor_verification_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "indoor_outdoor" AS ENUM ('INDOOR', 'OUTDOOR');

-- CreateEnum
CREATE TYPE "equipment_price_mode" AS ENUM ('RENTAL', 'SALE');

-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('PHOTO', 'VIDEO');

-- CreateEnum
CREATE TYPE "booking_source" AS ENUM ('APP', 'WALK_IN', 'TOURNAMENT');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "booking_payment_status" AS ENUM ('DUE_AT_VENUE', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CASH_REFUND_DUE', 'CASH_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_mode" AS ENUM ('PAY_AT_VENUE', 'ONLINE');

-- CreateEnum
CREATE TYPE "contribution_status" AS ENUM ('UNPAID', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('SAFEPAY', 'DEVELOPMENT_MOCK');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment_purpose" AS ENUM ('BOOKING_CONTRIBUTION', 'TOURNAMENT_ENTRY');

-- CreateEnum
CREATE TYPE "room_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "game_room_status" AS ENUM ('OPEN', 'FULL', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "room_member_role" AS ENUM ('ORGANIZER', 'PLAYER');

-- CreateEnum
CREATE TYPE "room_share_status" AS ENUM ('OPEN', 'UNPAID', 'PENDING', 'PAID', 'DUE_AT_VENUE', 'REFUNDED');

-- CreateEnum
CREATE TYPE "conversation_kind" AS ENUM ('VENUE_VENDOR', 'GAME_ROOM', 'TOURNAMENT', 'SUPPORT');

-- CreateEnum
CREATE TYPE "tournament_status" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "tournament_participant_status" AS ENUM ('REGISTERED', 'WITHDRAWN', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('BOOKING', 'PAYMENT', 'CHAT', 'TOURNAMENT', 'REVIEW', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "user_role" NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "phone" VARCHAR(32),
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_profiles" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "business_name" VARCHAR(160) NOT NULL,
    "contact_phone" VARCHAR(32) NOT NULL,
    "verification_status" "vendor_verification_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sports" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sports" (
    "user_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,

    CONSTRAINT "user_sports_pkey" PRIMARY KEY ("user_id","sport_id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "vendor_profile_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "address" VARCHAR(500) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "location_note" VARCHAR(160),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "location" geography(Point,4326),
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "parking_available" BOOLEAN NOT NULL DEFAULT false,
    "parking_spaces" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_sports" (
    "venue_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,

    CONSTRAINT "venue_sports_pkey" PRIMARY KEY ("venue_id","sport_id")
);

-- CreateTable
CREATE TABLE "amenities" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "amenities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_amenities" (
    "venue_id" UUID NOT NULL,
    "amenity_id" UUID NOT NULL,

    CONSTRAINT "venue_amenities_pkey" PRIMARY KEY ("venue_id","amenity_id")
);

-- CreateTable
CREATE TABLE "venue_media" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "storage_path" VARCHAR(500) NOT NULL,
    "file_name" VARCHAR(255),
    "mime_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courts" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "width_meters" DECIMAL(8,2) NOT NULL,
    "length_meters" DECIMAL(8,2) NOT NULL,
    "indoor_outdoor" "indoor_outdoor" NOT NULL,
    "surface" VARCHAR(60) NOT NULL,
    "condition_rating" INTEGER NOT NULL,
    "hourly_price_paisa" INTEGER NOT NULL,
    "slot_duration_minutes" INTEGER NOT NULL,
    "opening_time" VARCHAR(5) NOT NULL DEFAULT '09:00',
    "closing_time" VARCHAR(5) NOT NULL DEFAULT '17:00',
    "available_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "court_blocks" (
    "id" UUID NOT NULL,
    "court_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(255),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "court_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_items" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "sport_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "price_mode" "equipment_price_mode" NOT NULL,
    "unit_price_paisa" INTEGER NOT NULL,
    "quantity_available" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "equipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "court_id" UUID NOT NULL,
    "customer_user_id" UUID,
    "created_by_user_id" UUID,
    "tournament_id" UUID,
    "source" "booking_source" NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "payment_mode" "payment_mode" NOT NULL,
    "payment_status" "booking_payment_status" NOT NULL DEFAULT 'PENDING',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "customer_name" VARCHAR(120),
    "customer_phone" VARCHAR(32),
    "ground_fee_paisa" INTEGER NOT NULL,
    "add_ons_total_paisa" INTEGER NOT NULL DEFAULT 0,
    "total_paisa" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "idempotency_key" VARCHAR(128),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_items" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "equipment_item_id" UUID,
    "name_snapshot" VARCHAR(120) NOT NULL,
    "price_mode_snapshot" "equipment_price_mode" NOT NULL,
    "unit_price_paisa" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_paisa" INTEGER NOT NULL,

    CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_participants" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_organizer" BOOLEAN NOT NULL DEFAULT false,
    "share_paisa" INTEGER NOT NULL,
    "payment_status" "contribution_status" NOT NULL DEFAULT 'UNPAID',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_contributions" (
    "id" UUID NOT NULL,
    "booking_participant_id" UUID NOT NULL,
    "amount_due_paisa" INTEGER NOT NULL,
    "amount_paid_paisa" INTEGER NOT NULL DEFAULT 0,
    "status" "contribution_status" NOT NULL DEFAULT 'UNPAID',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "purpose" "payment_purpose" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "amount_paisa" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "contribution_id" UUID,
    "tournament_participant_id" UUID,
    "provider_reference" VARCHAR(255),
    "checkout_url" VARCHAR(2048),
    "idempotency_key" VARCHAR(128),
    "metadata" JSONB,
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "provider_event_id" VARCHAR(255) NOT NULL,
    "payment_id" UUID,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "event_type" VARCHAR(120) NOT NULL,
    "redacted_payload" JSONB NOT NULL,
    "processing_error" VARCHAR(500),
    "processed_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_rooms" (
    "id" UUID NOT NULL,
    "organizer_user_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "venue_id" UUID,
    "court_id" UUID,
    "booking_id" UUID,
    "title" VARCHAR(160) NOT NULL,
    "location_label" VARCHAR(255) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "visibility" "room_visibility" NOT NULL,
    "invite_code_hash" VARCHAR(255),
    "capacity" INTEGER NOT NULL,
    "total_cost_paisa" INTEGER NOT NULL,
    "per_player_share_paisa" INTEGER NOT NULL,
    "payment_mode" "payment_mode" NOT NULL,
    "status" "game_room_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_room_members" (
    "id" UUID NOT NULL,
    "game_room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "room_member_role" NOT NULL DEFAULT 'PLAYER',
    "seat_index" INTEGER NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_room_shares" (
    "id" UUID NOT NULL,
    "game_room_id" UUID NOT NULL,
    "user_id" UUID,
    "seat_index" INTEGER NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "status" "room_share_status" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "game_room_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "kind" "conversation_kind" NOT NULL,
    "venue_id" UUID,
    "game_room_id" UUID,
    "tournament_id" UUID,
    "title" VARCHAR(180) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMPTZ(3),

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "organizer_user_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "max_teams" INTEGER NOT NULL,
    "team_size" INTEGER NOT NULL,
    "entry_fee_per_player_paisa" INTEGER NOT NULL,
    "prize_paisa" INTEGER NOT NULL,
    "status" "tournament_status" NOT NULL DEFAULT 'UPCOMING',
    "registration_open" BOOLEAN NOT NULL DEFAULT true,
    "winner_team_name" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_participants" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "team_name" VARCHAR(120),
    "team_member_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entry_fee_per_player_paisa" INTEGER NOT NULL,
    "total_entry_fee_paisa" INTEGER NOT NULL,
    "status" "tournament_participant_status" NOT NULL DEFAULT 'REGISTERED',
    "payment_status" "contribution_status" NOT NULL DEFAULT 'PENDING',
    "wins" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "player_user_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "payload" JSONB,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_expires_at_idx" ON "refresh_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_profiles_owner_user_id_key" ON "vendor_profiles"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sports_code_key" ON "sports"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sports_name_key" ON "sports"("name");

-- CreateIndex
CREATE INDEX "venues_vendor_profile_id_deleted_at_idx" ON "venues"("vendor_profile_id", "deleted_at");

-- CreateIndex
CREATE INDEX "venues_city_published_deleted_at_idx" ON "venues"("city", "published", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "amenities_name_key" ON "amenities"("name");

-- CreateIndex
CREATE INDEX "venue_media_venue_id_position_idx" ON "venue_media"("venue_id", "position");

-- CreateIndex
CREATE INDEX "courts_venue_id_is_active_idx" ON "courts"("venue_id", "is_active");

-- CreateIndex
CREATE INDEX "courts_sport_id_is_active_idx" ON "courts"("sport_id", "is_active");

-- CreateIndex
CREATE INDEX "court_blocks_court_id_starts_at_ends_at_idx" ON "court_blocks"("court_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "equipment_items_venue_id_active_idx" ON "equipment_items"("venue_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_idempotency_key_key" ON "bookings"("idempotency_key");

-- CreateIndex
CREATE INDEX "bookings_customer_user_id_starts_at_idx" ON "bookings"("customer_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_venue_id_starts_at_status_idx" ON "bookings"("venue_id", "starts_at", "status");

-- CreateIndex
CREATE INDEX "bookings_court_id_starts_at_status_idx" ON "bookings"("court_id", "starts_at", "status");

-- CreateIndex
CREATE INDEX "booking_items_booking_id_idx" ON "booking_items"("booking_id");

-- CreateIndex
CREATE INDEX "booking_participants_user_id_joined_at_idx" ON "booking_participants"("user_id", "joined_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_participants_booking_id_user_id_key" ON "booking_participants"("booking_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_contributions_booking_participant_id_key" ON "payment_contributions"("booking_participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider_reference");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_user_id_idempotency_key_key" ON "payments"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_provider_event_id_key" ON "webhook_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_rooms_booking_id_key" ON "game_rooms"("booking_id");

-- CreateIndex
CREATE INDEX "game_rooms_visibility_status_starts_at_idx" ON "game_rooms"("visibility", "status", "starts_at");

-- CreateIndex
CREATE INDEX "game_rooms_organizer_user_id_starts_at_idx" ON "game_rooms"("organizer_user_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "game_room_members_game_room_id_user_id_key" ON "game_room_members"("game_room_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_room_members_game_room_id_seat_index_key" ON "game_room_members"("game_room_id", "seat_index");

-- CreateIndex
CREATE UNIQUE INDEX "game_room_shares_game_room_id_seat_index_key" ON "game_room_shares"("game_room_id", "seat_index");

-- CreateIndex
CREATE UNIQUE INDEX "game_room_shares_game_room_id_user_id_key" ON "game_room_shares"("game_room_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_game_room_id_key" ON "conversations"("game_room_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tournament_id_key" ON "conversations"("tournament_id");

-- CreateIndex
CREATE INDEX "conversations_venue_id_kind_idx" ON "conversations"("venue_id", "kind");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_last_read_at_idx" ON "conversation_members"("user_id", "last_read_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "tournaments_status_starts_at_idx" ON "tournaments"("status", "starts_at");

-- CreateIndex
CREATE INDEX "tournaments_organizer_user_id_starts_at_idx" ON "tournaments"("organizer_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "tournament_participants_tournament_id_points_wins_idx" ON "tournament_participants"("tournament_id", "points", "wins");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_participants_tournament_id_user_id_key" ON "tournament_participants"("tournament_id", "user_id");

-- CreateIndex
CREATE INDEX "reviews_venue_id_created_at_idx" ON "reviews"("venue_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_player_user_id_key" ON "reviews"("booking_id", "player_user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sports" ADD CONSTRAINT "user_sports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sports" ADD CONSTRAINT "user_sports_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_vendor_profile_id_fkey" FOREIGN KEY ("vendor_profile_id") REFERENCES "vendor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_sports" ADD CONSTRAINT "venue_sports_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_sports" ADD CONSTRAINT "venue_sports_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_amenities" ADD CONSTRAINT "venue_amenities_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_amenities" ADD CONSTRAINT "venue_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_media" ADD CONSTRAINT "venue_media_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courts" ADD CONSTRAINT "courts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courts" ADD CONSTRAINT "courts_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "court_blocks" ADD CONSTRAINT "court_blocks_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "court_blocks" ADD CONSTRAINT "court_blocks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_items" ADD CONSTRAINT "equipment_items_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_equipment_item_id_fkey" FOREIGN KEY ("equipment_item_id") REFERENCES "equipment_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_participants" ADD CONSTRAINT "booking_participants_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_participants" ADD CONSTRAINT "booking_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_contributions" ADD CONSTRAINT "payment_contributions_booking_participant_id_fkey" FOREIGN KEY ("booking_participant_id") REFERENCES "booking_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_contribution_id_fkey" FOREIGN KEY ("contribution_id") REFERENCES "payment_contributions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tournament_participant_id_fkey" FOREIGN KEY ("tournament_participant_id") REFERENCES "tournament_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_organizer_user_id_fkey" FOREIGN KEY ("organizer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rooms" ADD CONSTRAINT "game_rooms_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_room_members" ADD CONSTRAINT "game_room_members_game_room_id_fkey" FOREIGN KEY ("game_room_id") REFERENCES "game_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_room_members" ADD CONSTRAINT "game_room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_room_shares" ADD CONSTRAINT "game_room_shares_game_room_id_fkey" FOREIGN KEY ("game_room_id") REFERENCES "game_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_room_shares" ADD CONSTRAINT "game_room_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_game_room_id_fkey" FOREIGN KEY ("game_room_id") REFERENCES "game_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_organizer_user_id_fkey" FOREIGN KEY ("organizer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_player_user_id_fkey" FOREIGN KEY ("player_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostGIS spatial lookup and database-enforced domain invariants.
CREATE INDEX "venues_location_gist_idx" ON "venues" USING GIST ("location");

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower("email"));

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_coordinate_pair_check" CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  ADD CONSTRAINT "venues_latitude_range_check" CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT "venues_longitude_range_check" CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180)),
  ADD CONSTRAINT "venues_parking_spaces_nonnegative_check" CHECK ("parking_spaces" >= 0);

ALTER TABLE "courts"
  ADD CONSTRAINT "courts_dimensions_positive_check" CHECK ("width_meters" > 0 AND "length_meters" > 0),
  ADD CONSTRAINT "courts_condition_range_check" CHECK ("condition_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "courts_price_nonnegative_check" CHECK ("hourly_price_paisa" >= 0),
  ADD CONSTRAINT "courts_slot_duration_range_check" CHECK ("slot_duration_minutes" BETWEEN 15 AND 240),
  ADD CONSTRAINT "courts_hours_valid_check" CHECK ("opening_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "closing_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "opening_time" < "closing_time"),
  ADD CONSTRAINT "courts_available_days_nonempty_check" CHECK (cardinality("available_days") > 0);

ALTER TABLE "court_blocks"
  ADD CONSTRAINT "court_blocks_positive_interval_check" CHECK ("ends_at" > "starts_at");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_positive_interval_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "bookings_nonnegative_amounts_check" CHECK ("ground_fee_paisa" >= 0 AND "add_ons_total_paisa" >= 0 AND "total_paisa" >= 0),
  ADD CONSTRAINT "bookings_currency_pkr_check" CHECK ("currency" = 'PKR');

-- [start,end) permits adjacent reservations but rejects concurrent overlap.
-- Cancelled/expired bookings release availability; completed bookings remain historical blockers.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_active_court_overlap"
  EXCLUDE USING GIST (
    "court_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED'));

ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_quantity_positive_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "booking_items_amounts_nonnegative_check" CHECK ("unit_price_paisa" >= 0 AND "line_total_paisa" >= 0);

ALTER TABLE "booking_participants"
  ADD CONSTRAINT "booking_participants_share_nonnegative_check" CHECK ("share_paisa" >= 0);

ALTER TABLE "payment_contributions"
  ADD CONSTRAINT "payment_contributions_amounts_valid_check" CHECK ("amount_due_paisa" >= 0 AND "amount_paid_paisa" >= 0 AND "amount_paid_paisa" <= "amount_due_paisa");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_nonnegative_check" CHECK ("amount_paisa" >= 0),
  ADD CONSTRAINT "payments_target_matches_purpose_check" CHECK (
    ("purpose" = 'BOOKING_CONTRIBUTION' AND "contribution_id" IS NOT NULL AND "tournament_participant_id" IS NULL)
    OR
    ("purpose" = 'TOURNAMENT_ENTRY' AND "tournament_participant_id" IS NOT NULL AND "contribution_id" IS NULL)
  );

ALTER TABLE "game_rooms"
  ADD CONSTRAINT "game_rooms_positive_interval_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "game_rooms_capacity_minimum_check" CHECK ("capacity" >= 2),
  ADD CONSTRAINT "game_rooms_amounts_nonnegative_check" CHECK ("total_cost_paisa" >= 0 AND "per_player_share_paisa" >= 0);

ALTER TABLE "game_room_shares"
  ADD CONSTRAINT "game_room_shares_seat_nonnegative_check" CHECK ("seat_index" >= 0),
  ADD CONSTRAINT "game_room_shares_amount_nonnegative_check" CHECK ("amount_paisa" >= 0),
  ADD CONSTRAINT "game_room_shares_open_seat_unassigned_check" CHECK ("status" <> 'OPEN' OR "user_id" IS NULL);

ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_positive_interval_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "tournaments_capacity_minimum_check" CHECK ("max_teams" >= 2),
  ADD CONSTRAINT "tournaments_team_size_range_check" CHECK ("team_size" BETWEEN 2 AND 30),
  ADD CONSTRAINT "tournaments_amounts_nonnegative_check" CHECK ("entry_fee_per_player_paisa" >= 0 AND "prize_paisa" >= 0);

ALTER TABLE "tournament_participants"
  ADD CONSTRAINT "tournament_participants_amounts_nonnegative_check" CHECK ("entry_fee_per_player_paisa" >= 0 AND "total_entry_fee_paisa" >= 0),
  ADD CONSTRAINT "tournament_participants_standings_nonnegative_check" CHECK ("wins" >= 0 AND "points" >= 0);

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_stars_range_check" CHECK ("stars" BETWEEN 1 AND 5);

RESET search_path;
