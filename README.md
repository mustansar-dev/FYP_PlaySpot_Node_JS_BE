# PlaySpot PK Backend

PlaySpot PK is a React Native sports-venue booking and matchmaking app. This repository contains the API foundation, Prompt 1 authentication/profile endpoints, and Prompt 2 vendor venue/catalog/media/review endpoints. Booking, payments and community endpoints remain unimplemented.

## Project and working state

- Frontend: [FYP_PlaySpot_React_Native_FE](https://github.com/mustansar-dev/FYP_PlaySpot_React_Native_FE).
- Frontend checkout inspected for this foundation: `/home/ibrahim/rn_lab_workspace/FYP_PlaySpot_React_Native_FE`. This path is machine-specific; use the repository URL on another computer.
- Backend runtime: Node.js 22 with npm. This machine has Node `v22.17.0` and npm `10.9.2`; Prisma 7.10.1 supports Node 22.12+.
- Current backend checkout for Prompt 2: `feature/auth-booking`. Prompt 2 names `feature/vendor-venue-maps`, but neither that branch nor `develop` exists in the available branch refs. This session preserved the active branch; repository metadata is read-only in the current workspace, so the changes are not committed here.
- Two supplied planning prompts are present as untracked files in this checkout. They are task inputs and are intentionally not copied into this README or altered.
- Exactly one README is maintained in this repository: this root file. Setup, contract, schema, decisions and limitations stay here.

## Completed scope

1. Inspect the current frontend's routes, forms, Redux/local-storage services and demo data, then record screen-to-API requirements below.
2. Implement only the backend foundation: validated configuration, Express app, liveness/readiness health routes, Prisma schema, PostGIS/exclusion-constraint migration and idempotent reference-data seed.
3. Validate the schema/client and run typecheck, lint, tests and build.
4. Prompt 1 adds player/vendor registration, login, refresh rotation, logout/revocation, current-user/profile routes, vendor profile onboarding/status and role guards.
5. Do not apply a migration to a shared database until the team-approved development target and credentials are configured. No Supabase connection URL or credentials were present during this work; local PostgreSQL has no PostGIS extension installed.
6. Prompt 2 adds vendor-owned venue, court, equipment and media management; public venue discovery/detail/reviews; parameterized PostGIS nearby search; and completed-booking review eligibility. It uses the existing schema and adds no migration.

## Frontend audit

The inspected frontend is a bare React Native CLI application (`react-native` 0.86.2, React 19.2.3) using React Navigation native stack, Redux Toolkit and AsyncStorage. It has no API client, `fetch`/Axios calls, OpenAPI client or backend DTO package yet. Current screen operations use in-memory Redux state initialized from fixtures and local AsyncStorage.

### Screen-to-API contract

| Frontend screen/flow | Current input/data contract | Proposed API calls | Role and important behavior |
|---|---|---|---|
| Welcome / Role selection | Select `player` or `vendor`; navigation only | None | Public navigation only. |
| Player registration | `name`, `email`, `phone`, `password`, `confirmPassword`, `preferredSports[]` | `POST /api/v1/auth/register/player` | Public; server validates and returns a user plus access/refresh session. Never store or return passwords/hashes. |
| Vendor registration and venue management | Account fields plus venue, `grounds[]`, facilities, parking, equipment and media | `POST /auth/register/vendor`, then authenticated `POST /venues`, `POST /venues/:venueId/courts`, `POST /venues/:venueId/equipment`, signed upload/confirm; read/update/delete routes for managed records | Registration still creates a pending vendor profile only. Venue writes create drafts; publishing requires vendor approval. Device photo/video URIs must be uploaded through signed Storage URLs. |
| Login / session restore / logout | `email`, `password`; current auth repository stores local account/session IDs | `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` | Public login/refresh; other calls authenticated. Frontend token storage/refresh integration is still required. |
| Edit profile / Settings | `name`, `phone`, player `preferredSports[]`, vendor `businessName`; local appearance/session controls | `GET/PATCH /api/v1/users/me`, `GET/PATCH /api/v1/vendors/me` | Authenticated owner. Theme is frontend session state; logout revokes the refresh token. Forgot Password currently explicitly says no email or OTP was sent. |
| Player home / Venue Search | Search text, sport, hourly budget, minimum rating, distance and sort; default origin is Lahore coordinates | `GET /api/v1/venues`, `GET /api/v1/venues/nearby?lat=&lng=&radiusKm=&sport=&...` | Public read. PostGIS filters radius and returns nearest-first results. Catalog filters include text, city, sport, all requested amenities, price and rating. |
| Venue Map | Select a venue marker, search nearby area and open details | `GET /api/v1/venues/nearby` and `GET /api/v1/venues/:venueId` | Public read. Current map is a local schematic with fixture coordinates; there is no map SDK or geocoder in the frontend. Do not claim GPS/geocoding is connected. |
| Venue details / reviews | Venue, grounds/courts, facilities, equipment, ratings and reviews | `GET /api/v1/venues/:venueId`, `GET /api/v1/venues/:venueId/courts`, `GET /api/v1/venues/:venueId/equipment`, `GET /api/v1/venues/:venueId/reviews`, `POST/PATCH /api/v1/venues/:venueId/reviews` | Public reads. Create review needs a completed booking ID belonging to the authenticated player; the current review form does not send one yet. Chat remains local and is not part of Prompt 2. |
| Slot selection / equipment / checkout | `venueId`, `groundId` (API name `courtId`), local `slotId`/date/time, equipment IDs/quantities and payment mode | `GET /api/v1/courts/:courtId/availability?date=...`, `POST /api/v1/bookings`, then payment-init/status routes | Player. Server resolves the selected time, recalculates court/add-on prices and atomically reserves the shared calendar. Frontend payment mode `simulated` is not trusted as proof of payment. |
| Player bookings / booking detail | Booking ID, venue/court names, date/time, status, payment status, total, add-on snapshots; joined/created rooms and tournaments are shown alongside bookings | `GET /api/v1/bookings/me`, `GET /api/v1/bookings/:bookingId`, `POST /api/v1/bookings/:bookingId/cancel` | Player may read/cancel own eligible records; server policy controls state transitions. |
| Vendor venue editor / inventory | Vendor-owned venue fields, courts and operating hours, facilities/parking, equipment/add-ons, photos/video, publish status | `GET /api/v1/vendors/me/venues`, `POST/PATCH/DELETE /api/v1/venues/:venueId`, court, equipment, amenities and media endpoints | Every write verifies vendor ownership. Frontend still uses local Redux and needs Prompt 6 integration. Availability preview remains frontend-only until Prompt 3. |
| Vendor availability / bookings / walk-in | Court, date and generated time slots; walk-in name/contact, payment choice/status; booking detail | `GET /api/v1/vendors/me/bookings`, `GET /api/v1/courts/:courtId/availability`, `POST /api/v1/vendors/me/bookings/walk-in`, booking detail/status routes | Vendor may manage only owned venues/courts. Walk-ins and app bookings use the same overlap constraint. |
| Game rooms / split calculator | Room title/sport/location/date/start/end/capacity/visibility/private code, optional venue reservation, seat shares and member status | `POST/GET /api/v1/game-rooms`, `GET /api/v1/game-rooms/:id`, `POST /:id/join`, `POST /:id/leave`, share/payment contribution routes | Player. Private rooms require invitation/access verification; booking shares use server-calculated amounts and verified payments. |
| Chat inbox / conversation | Conversation kind (`venue-vendor`, `game-room`, `tournament`, `support`), participant IDs, message body/timestamp and unread state | `GET /api/v1/conversations`, `GET /api/v1/conversations/:id/messages`, `POST /api/v1/conversations/:id/messages`; authenticated Socket.IO later | Server derives sender from auth and checks membership before history/send/socket join. No client-supplied sender ID is authoritative. |
| Tournaments / tournament detail | Vendor host, venue/courts, sport, date/start/end, max teams, team size, entry fee/player, prize, team names/member names, payment state, standings/winner | Vendor `POST/PATCH /api/v1/tournaments`; player list/detail, `POST /:id/teams`, `DELETE /:id/teams/me`; standings/result routes | Vendor organizes; players register teams. UI currently labels entry/prize as demo-only with no money moved. Real checkout must use Safepay sandbox and verified provider status. |
| Global/tournament leaderboards | Player account names and preferred sports; wins/points from tournament standings | `GET /api/v1/leaderboards?sport=...`, `GET /api/v1/tournaments/:id/leaderboard` | Read-only. Rankings must derive from persisted results, ordered deterministically by points, wins and name. |
| Notifications | In-app booking/chat/tournament/review records, `readAt` | `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all` | Authenticated user; no push service is currently installed. |
| Vendor analytics / reviews | Booking counts, booked value, occupancy and review aggregates | `GET /api/v1/vendors/me/analytics?from=&to=`, vendor review endpoints | Server derives only from the authenticated vendor's persisted bookings/courts. Current six-month dashboard history is local fixture data. |

### Current local/mock sources to replace

- Auth/session and account fixture storage: `src/services/authStorage.js`, `src/services/authRepository.js`, `src/store/authSlice.js`.
- Venue, court, equipment, slot and review fixtures: `src/data/demoVenueData.js`; normalization/persistence: `src/services/venueStorage.js`; state transitions: `src/store/venueSlice.js`.
- Rooms, conversations, messages, tournaments, standings and notifications: `src/data/demoCommunityData.js`, `src/store/communitySlice.js`, and `src/utils/community.js`.
- Screen-level flows: `src/screens/BookingScreens.js`, `src/screens/CommunityScreens.js`, `src/screens/VenueSearchScreen.js`, `src/screens/VenueDetailsScreen.js`, `src/screens/VendorVenueManagementScreen.js`, `src/screens/VendorRegistrationScreen.js`, `src/screens/VendorAnalyticsScreen.js`, `src/screens/AccountScreens.js`.
- No screen or service currently calls `fetch`, Axios or a backend URL. Every listed API route is proposed, not implemented.

## API contract

Base prefix: `/api/v1`. JSON success response:

```json
{"success":true,"data":{},"meta":{"page":1,"limit":20,"total":0}}
```

Error response:

```json
{"success":false,"error":{"code":"VALIDATION_ERROR","message":"The request is invalid.","details":[]}}
```

The API implements `GET /health` (liveness), `GET /api/v1/health` (database readiness), auth/profile routes, and Prompt 2 venue/catalog/media/review routes. Booking, payment, community, analytics and notification routes remain proposed.

| Group | Proposed routes | Auth |
|---|---|---|
| Auth/user | `POST /api/v1/auth/register/player`, `POST /api/v1/auth/register/vendor`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `GET/PATCH /api/v1/users/me`, `GET/PATCH /api/v1/vendors/me` | Implemented; public/authenticated as appropriate |
| Venues/catalog | `GET /amenities`, `GET /venues`, `GET /venues/nearby`, `GET /venues/:venueId`, `GET /vendors/me/venues`, `POST /venues`, `PATCH/DELETE /venues/:venueId` | Public reads; owning vendor writes |
| Courts/equipment | `GET/POST /venues/:venueId/courts`, `PATCH/DELETE /venues/:venueId/courts/:courtId`, `GET/POST /venues/:venueId/equipment`, `PATCH/DELETE /venues/:venueId/equipment/:equipmentId` | Public reads for published venues; owning vendor writes |
| Media/reviews | `POST /venues/:venueId/media/signed-upload`, `POST /venues/:venueId/media/confirm`, `DELETE /venues/:venueId/media/:mediaId`, `GET /venues/:venueId/reviews`, `POST/PATCH /venues/:venueId/reviews` | Vendor owner for media; public review read; completed-booking player create/edit |
| Availability/booking | `GET /courts/:courtId/availability?date=...` and booking routes | Proposed; Prompt 3 |
| Booking | `POST /bookings`, `GET /bookings/me`, `GET /bookings/:bookingId`, `POST /bookings/:bookingId/cancel`, `GET /vendors/me/bookings`, `POST /vendors/me/bookings/walk-in` | Player or owning vendor |
| Payment | `POST /bookings/:bookingId/contributions`, `POST /payments/:paymentId/checkout`, `GET /payments/:paymentId`, `POST /webhooks/safepay` | Authenticated payer; webhook signature verified |
| Rooms/chat | `POST/GET /game-rooms`, `GET /game-rooms/:id`, `POST/DELETE /game-rooms/:id/members/me`, `GET /conversations`, `GET/POST /conversations/:id/messages` | Authenticated; membership checked per room/conversation |
| Tournaments/leaderboard | `GET/POST /tournaments`, `GET/PATCH /tournaments/:id`, `POST/DELETE /tournaments/:id/teams/me`, `PUT /tournaments/:id/standings`, `GET /tournaments/:id/leaderboard`, `GET /leaderboards` | Public list/read as decided; host/player writes |
| Analytics/notifications/media | `GET /vendors/me/analytics`, `GET /notifications`, `PATCH /notifications/:id/read`, `POST /media/signed-upload`, `POST /media/confirm` | Authenticated; vendor ownership on records |

### DTO conventions

- Public roles map to the frontend's `player` and `vendor` values. Server internals use `PLAYER`/`VENDOR` roles and never trust a client role field.
- Player registration uses `name`, `email`, `phone`, `password`, `confirmPassword`, `preferredSports[]`; the current vendor registration endpoint accepts account fields plus `businessName` and optional `contactPhone`. The frontend's full vendor draft (`venueName`, `grounds[]`, equipment, facilities and media) still requires the later onboarding/catalog endpoints.
- Frontend's ground record is named `ground`; API model is `Court`. Request/response DTOs should expose `groundId`/`groundName` where preserving current mobile property names avoids a large screen rewrite, while route names and DB use `courtId`/`Court` consistently.
- UI money values are integer PKR rupees (`hourlyPricePKR`, `totalPKR`, `entryFeePKR`). Database/payment values are integer paisa (`...Paisa`). Explicit DTO functions divide/multiply by 100; never use floating point for stored money.
- UI schedule fields are local `date: YYYY-MM-DD`, `startTime/endTime: HH:MM`. API persists UTC `timestamptz` plus `Asia/Karachi` venue timezone and formats local fields for current screens.
- Venue discovery response should retain names expected by `VenueCard`: `id`, `name`, `address`, `city`, `locationNote`, `sports[]`, `facilities[]`, `latitude`, `longitude`, `parkingAvailable`, `parkingSpaces`, `published`, plus computed `distanceKm`, `ratingAverage`, `ratingCount`, `minimumHourlyPricePKR`.
- Catalog DTOs expose the frontend's `grounds[]` naming while the API and database use `courts`/`Court`. Prices convert between integer PKR and paisa. Media responses contain a Storage object path and public URL when Storage is configured.
- Booking DTO should keep `venueName`, `groundName`, `date`, `startTime`, `endTime`, `durationMinutes`, `groundFeePKR`, `addOns[]`, `addOnsTotalPKR`, `totalPKR`, `source`, `status`, and `paymentStatus` for the existing booking cards.

### Authentication behavior

- Player registration accepts `name`, `email`, optional `phone`, `password`, `confirmPassword` and optional `preferredSports[]`. Vendor registration accepts the account fields plus `businessName` and optional `contactPhone`; it creates the `VendorProfile` with `PENDING` verification status. Venue/court/equipment setup and media upload remain separate later work.
- Login accepts the frontend form `{ "email": "...", "password": "..." }` or `{ "identifier": "email-or-phone", "password": "..." }`, and returns `{ user, accessToken, refreshToken, tokenType }`. Email matching is case-insensitive; phone matching is also supported.
- Access JWTs last 15 minutes. Refresh tokens are random opaque values; only an HMAC-SHA256 digest is stored. Refresh rotates the token, and reuse of a revoked token revokes the user's active refresh sessions. Logout revokes all of the authenticated user's refresh sessions.
- Authenticated requests use `Authorization: Bearer <accessToken>`. The API checks the current user status and role in PostgreSQL for protected requests. `/auth/me` and `/users/me` return the safe user DTO; vendor routes require the persisted `VENDOR` role and scope by the authenticated owner.
- Registration/login/refresh share an in-memory IP rate limit (20 requests per 15 minutes). Multi-instance deployments need a shared limiter store.
- No email/SMS verification or OTP is sent. Vendor verification remains `PENDING`; approval workflow is not implemented.

## Initial database model and relationships

This schema is adapted to the frontend audit, not a full implementation of every later prompt. UUIDs are primary keys, dates are UTC `timestamptz`, multi-record operations use database transactions, and monetary values are integer PKR paisa.

| Area | Models | Purpose / constraints |
|---|---|---|
| Identity | `User`, `RefreshToken`, `VendorProfile`, `Sport`, `UserSport` | Player/vendor roles; normalized email and optional phone unique; password hashes only; vendor profile one-to-one with owner; normalized sports catalog and player interests. |
| Venue | `Venue`, `VenueSport`, `Amenity`, `VenueAmenity`, `VenueMedia`, `Court`, `CourtBlock`, `EquipmentItem` | Vendor-owned venue/courts/add-ons; PostGIS geography point plus DTO latitude/longitude; address fallback; operating schedule per court; optional blocked intervals; media metadata only, not binary content. |
| Booking | `Booking`, `BookingItem`, `BookingParticipant`, `PaymentContribution` | One booking calendar for player, tournament and walk-in records; price/quantity snapshots; participant shares. Court/date/time collisions are blocked by a PostgreSQL GiST exclusion constraint. |
| Payments | `Payment`, `WebhookEvent` | Safepay provider reference/idempotency, sandbox/live provider status, contribution/payment relationship and deduplicated webhook event. Webhook payload is stored only in a redacted JSON field. |
| Community | `GameRoom`, `GameRoomMember`, `GameRoomShare`, `Conversation`, `ConversationMember`, `Message` | Public/private room and seat-share state, vendor/room/tournament conversations, participant access and persisted chat. A room conversation can include the selected venue vendor separately from player membership. |
| Tournaments | `Tournament`, `TournamentParticipant` | Vendor-hosted venue/court schedule, team size/capacity, entry fee and prize, team leader/member names, entry status and deterministic wins/points standings. No fake bracket model. |
| Notifications/reviews | `Notification`, `Review` | Per-user read state; reviews linked to eligible booking/player and unique by `(bookingId, playerUserId)`. |

### Integrity decisions

- `Venue.vendorProfileId` enforces vendor ownership through the parent relation. Every write service must verify the authenticated owner; never accept `vendorId` as authority.
- Venue point writes and nearby queries use the dedicated parameterized raw-SQL repository. Point order is longitude then latitude. Normal CRUD must not attempt to write the Prisma `Unsupported` field.
- PostgreSQL `extensions.postgis` is installed by the initial SQL migration; a GiST index is added for venue geography. `extensions.btree_gist` supports the booking exclusion constraint.
- Active booking overlap constraint uses half-open `tstzrange(starts_at, ends_at, '[)')` for the same court and excludes `PENDING_PAYMENT`, `CONFIRMED`, and `COMPLETED` rows. Adjacent bookings such as 18:00–19:00 and 19:00–20:00 do not overlap. Cancelled/expired rows release availability.
- Review unique key is `(booking_id, player_user_id)`. The current UI does not send a booking ID; the backend will require eligible completed booking authorization and the frontend contract will need an update before review create is integrated.
- `Payment` must reference exactly one booking contribution or tournament entry; a custom SQL check enforces this. Provider success is only persisted from verified webhook/status checks, not from client return URLs.
- `ConversationMember` is the server authority for reading/sending messages. `GameRoomMember` is separate, allowing a room's vendor chat participant without making that vendor a player.
- No shared DB URL, Supabase service key or Geoapify/Safepay credentials were available. Do not run migrations against an unknown/shared target.

## Backend foundation layout

```text
prisma/schema.prisma                 # Prisma 7 PostgreSQL models and enums
prisma/migrations/                   # Initial SQL migration plus PostGIS/constraint SQL
prisma.config.ts                     # Prisma CLI database and seed configuration
prisma/seed.ts                       # Idempotent sports/amenities only; no sample accounts
src/app.ts / src/server.ts           # Express composition and HTTP lifecycle
src/config/env.ts                    # Zod environment parsing
src/database/prisma.ts               # Prisma PostgreSQL adapter singleton
src/routes/health.ts                  # Liveness/readiness routes
src/common/                           # Response and HTTP error shapes
src/middleware/                       # Central 404 and error handling
src/modules/auth/                     # Authentication, roles and profiles
src/modules/venues/                   # Vendor/catalog/review routes and Zod DTOs
src/modules/venues/spatialRepository.ts # Parameterized PostGIS point/search queries
src/modules/venues/storage.ts         # Supabase signed-upload adapter and no-config behavior
src/**/*.test.ts                      # Health and environment tests
```

Keep the project a modular monolith; add a route/service/repository when its feature is implemented.

## Decisions and known frontend gaps

1. **Prisma version:** pinned Prisma ORM 7.10.1 and `@prisma/client` 7.10.1 (the current stable v7 line; Prisma 8 is still a release candidate). npm's published Prisma 7.10.1 engine range includes this Node 22.17 runtime. Prisma 7 uses ESM, an explicit PostgreSQL driver adapter and `prisma.config.ts`; PostGIS remains an `Unsupported("geography(Point,4326)")` field accessed through parameterized raw SQL. The initial Prisma 6 trial surfaced high-severity advisories in its CLI dependency tree, so the scaffold moved to patched Prisma 7 rather than force-upgrading via `npm audit fix`.
2. **Map:** frontend uses a custom offline schematic and Lahore fixture coordinates; it has no map SDK or GPS. Prompt 2 adds PostGIS nearby search and accepts manual coordinates. No geocoding/routing route was added because current vendor forms accept a manual map pin and the frontend has no geocoder dependency.
3. **Media:** frontend currently returns local image-picker URIs. Prompt 2 adds authenticated signed upload/confirm/delete endpoints using Supabase Storage when configured. The mobile app still needs to upload file bytes and replace local URIs during Prompt 6. Storage settings are optional at API startup; upload routes return `STORAGE_NOT_CONFIGURED` until set. Venue read URLs assume the configured bucket is public.
4. **Payments:** room and tournament UI currently records simulated statuses and states that money does not move. Backend `DEVELOPMENT_MOCK` is reserved for isolated tests only and must be rejected in production. Prompt 4 owns Safepay sandbox. Tournament prize allocation/payout semantics need team/provider confirmation; this schema does not claim escrow or automatic vendor payouts.
5. **Reviews:** current review UI submits venue ID, stars and comment without a booking ID. The API requires a booking ID belonging to the authenticated player with `COMPLETED` status. The current schema has no separate venue-confirmed-attendance field, so that part of the UI rule cannot yet be enforced; coordinate a schema addition with the schema owner if attendance confirmation is required.
6. **Authentication:** forgot-password UI expressly says no email/OTP is sent. This foundation does not implement OTP or claim email delivery. Player/vendor registration UI currently creates local accounts; future API integration must carry the vendor nested venue draft and return a real backend user/session.
7. **Legacy local data:** current frontend seeds fictional local venues, sample bookings, conversations, tournaments and leaderboards. API responses must replace these deliberately in Prompt 6; do not copy fixture rows into the shared database as real providers/customers.
8. **Prompt 2 schema limits:** the shared schema has no equipment description or venue/court capacity column. Prompt 2 leaves those fields out rather than editing schema/migrations, as required. The editor currently does not send capacity.
9. **Branch safety:** Prompt 2 expects `feature/vendor-venue-maps` based on `develop`; this checkout only has `feature/auth-booking` and no `develop` ref. Changes remain on the active branch and uncommitted in this workspace.

## Environment and commands

Node.js 22 and npm are used to match the installed environment. Copy the environment template before install because Prisma's config reads `DATABASE_URL` during generation:

```bash
cp .env.example .env
# Edit DATABASE_URL to point to your own local database or the team-approved Supabase dev project.
# Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET to different random values of at least 32 characters.
npm ci
npm run prisma:validate
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
npm run dev
```

The API listens on `PORT` (default 4000). `GET /health` is liveness and does not require the database; `GET /api/v1/health` verifies DB connectivity and returns 503 when unavailable. The server requires a PostgreSQL `DATABASE_URL`; `.env.example` contains only a placeholder. Never commit `.env` or copy Supabase credentials into the mobile app.

For Android Emulator access to a development host, Android's standard emulator host alias is `10.0.2.2`; physical devices require a reachable LAN/tunnel address. Do not commit a developer-specific IP. The current frontend has no configurable API base URL yet; Prompt 6 must add one.

### Database setup / migration status

1. Use the agreed Supabase project or an isolated local PostgreSQL database. Never use `prisma migrate reset`, truncate or destructive push commands on the shared instance.
2. On Supabase, enable PostGIS in the `extensions` schema. The migration also enables `btree_gist` there. On local PostgreSQL, PostGIS must be installed by the administrator first; `btree_gist` availability was confirmed locally.
3. The checked-in migration is the canonical initial schema. Run `npm run prisma:migrate:deploy` only after checking that `DATABASE_URL` targets the approved empty development database.
4. This foundation did **not** apply migrations: no shared URL/credentials were configured, local PostgreSQL does not list PostGIS as an available extension, and Docker is not installed. The API schema/client and migration can be validated offline; live DB health/migration must be completed after a team-approved database is available.
5. The migration adds PostGIS, a geography GiST index, booking exclusion and domain check constraints as hand-reviewed SQL because Prisma's typed schema cannot express all of them. Preserve these statements in later migrations and review schema drift; do not replace them with `db push` or a migration reset.

## Environment variables

| Variable | Required now | Purpose |
|---|---:|---|
| `NODE_ENV` | No | `development`, `test` or `production`; default `development`. |
| `PORT` | No | HTTP port; default `4000`. |
| `API_PREFIX` | No | Versioned route prefix; default `/api/v1`. |
| `APP_ORIGINS` | No | Comma-separated browser origins; default local Metro web origin. Native requests without an Origin header are accepted. |
| `DATABASE_URL` | Yes | PostgreSQL connection for Prisma. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Yes outside tests | Independent random secrets, at least 32 characters each. Server startup fails when either is missing or short. Refresh token digests use the refresh secret; JWT access tokens use the access secret. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Optional for API startup; required for venue media | Server-side signed upload, object verification and deletion. Keep the service role key on the backend. Configure the bucket for public reads because venue DTOs return public media URLs. |
| `GEOAPIFY_API_KEY` | Optional/not used by current routes | No geocoding endpoint is exposed; vendors can submit manually selected coordinates. |
| `SAFEPAY_ENV`, `SAFEPAY_SECRET_KEY`, `SAFEPAY_API_KEY`, `SAFEPAY_WEBHOOK_SECRET`, `SAFEPAY_RETURN_URL`, `SAFEPAY_CANCEL_URL` | Later | Safepay sandbox; no live payment is enabled in this foundation. |

## Verification results

- `npm ci` — passed from the lockfile (413 packages). A local placeholder `DATABASE_URL` was used for Prisma configuration; install/generation did not connect to a database.
- `npm test` — Prompt 2 verification passed: 6 files / 31 tests, including venue ownership, coordinate validation, amenity filters/pagination, PostGIS parameter order/distance mapping, media authorization/object verification, review eligibility/duplicates and the existing auth/foundation tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `DATABASE_URL=postgresql://local:local@127.0.0.1:5432/playspot_dev npm run prisma:validate` — passed after Prompt 2; schema remains unchanged.
- `DATABASE_URL=postgresql://local:local@127.0.0.1:5432/playspot_dev npm run prisma:generate` — passed after installing from the existing lockfile.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npm run prisma:validate` — passed.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npm run prisma:generate` — passed; Prisma Client 7.10.1 generated into the ignored `src/generated/prisma` directory.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output prisma/migrations/20261110000000_initial/migration.sql` — passed; the checked-in migration then adds the PostGIS/btree_gist setup, GiST index and custom check/exclusion constraints.
- `npm audit --omit=dev --audit-level=moderate` — passed with 0 production dependency vulnerabilities. Full `npm audit` reports 7 moderate advisories in the development-only TypeScript ESLint/minimatch chain; no forced major downgrade was applied.
- Built-server smoke test with a deliberately non-working local URL: `GET /health` returned 200, `GET /api/v1/health` returned 503 with `DATABASE_UNAVAILABLE`, and an unimplemented route returned the standard 404 envelope. This confirms liveness is separate from readiness and no fake DB success is returned.
- `git diff --check` — passed. `find . -name README.md -print` — exactly one result, `./README.md`.
- **Not run for Prompt 2:** migration/deploy, seed, live PostGIS query or real Supabase Storage request. No approved database or Supabase credentials are configured. PostGIS SQL parameterization was tested with mocked Prisma raw-query calls; live DB verification remains for the approved development database.
- **Runtime note:** this machine's Node is 22.17.0. Node 22.23.4 was the latest published 22.x LTS patch checked during Prompt 0; use a current supported Node 22 patch for shared development/deployment.
- **Tooling note:** npm reports ESLint 9.39.5 as deprecated and the full dev-dependency audit contains 7 moderate TypeScript ESLint/minimatch findings. The ESLint 10 upgrade attempt hit peer-dependency resolution conflicts, so it was reverted rather than forcing a mismatched toolchain. Production dependency audit is clean; update the lint toolchain with a compatible parser/plugin set before release.

## Official implementation references

- [Supabase PostGIS guide](https://supabase.com/docs/guides/database/extensions/postgis) — enable PostGIS in `extensions`, geographic points, GiST index and longitude/latitude order.
- [Prisma ORM 7 raw SQL guidance](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries) — unsupported spatial fields require casting/parameterized raw SQL; ordinary CRUD stays typed.
- [Prisma ORM 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) — ESM, CLI config, PostgreSQL driver adapter and connection setup.
- [Supabase Storage signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl) — clients upload to a time-limited signed URL without receiving the service role key.
- [PostgreSQL range/exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html) — use GiST range overlap exclusions and `btree_gist` for court equality.
- [Express 5 migration/requirements](https://expressjs.com/en/guide/migrating-5/) — Express 5 supports Node 18+.
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases) — check the current supported LTS patch before shared deployment.
