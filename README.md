# PlaySpot PK Backend

PlaySpot PK is a React Native sports-venue booking and matchmaking app. This repository is the initial API and database foundation. It currently provides a small Express health API and a Prisma schema/migration foundation; feature endpoints have **not** been implemented yet.

## Project and working state

- Frontend: [FYP_PlaySpot_React_Native_FE](https://github.com/mustansar-dev/FYP_PlaySpot_React_Native_FE).
- Frontend checkout inspected for this foundation: `/home/ibrahim/rn_lab_workspace/FYP_PlaySpot_React_Native_FE`. This path is machine-specific; use the repository URL on another computer.
- Backend runtime: Node.js 22 with npm. This machine has Node `v22.17.0` and npm `10.9.2`; Prisma 7.10.1 supports Node 22.12+.
- Backend branch observed: `main`; only `main` is available locally/remotely at the time of this foundation. The plan's `develop` and `feature/backend-foundation` branches do not exist here. This work has not changed branches or been committed.
- Two supplied planning prompts are present as untracked files in this checkout. They are task inputs and are intentionally not copied into this README or altered.
- Exactly one README is maintained in this repository: this root file. Setup, contract, schema, decisions and limitations stay here.

## Prompt 0 scope and implementation plan

1. Inspect the current frontend's routes, forms, Redux/local-storage services and demo data, then record screen-to-API requirements below.
2. Implement only the backend foundation: validated configuration, Express app, liveness/readiness health routes, Prisma schema, PostGIS/exclusion-constraint migration and idempotent reference-data seed.
3. Validate the schema/client and run typecheck, lint, tests and build.
4. Do not implement later-prompt feature routes, payment provider calls, maps, media upload, authentication or sockets in this foundation.
5. Do not apply a migration to a shared database until the team-approved development target and credentials are configured. No Supabase connection URL or credentials were present during this work; local PostgreSQL has no PostGIS extension installed.

## Frontend audit

The inspected frontend is a bare React Native CLI application (`react-native` 0.86.2, React 19.2.3) using React Navigation native stack, Redux Toolkit and AsyncStorage. It has no API client, `fetch`/Axios calls, OpenAPI client or backend DTO package yet. Current screen operations use in-memory Redux state initialized from fixtures and local AsyncStorage.

### Screen-to-API contract

| Frontend screen/flow | Current input/data contract | Proposed API calls | Role and important behavior |
|---|---|---|---|
| Welcome / Role selection | Select `player` or `vendor`; navigation only | None | Public navigation only. |
| Player registration | `name`, `email`, `phone`, `password`, `confirmPassword`, `preferredSports[]` | `POST /api/v1/auth/register/player` | Public; server validates and returns a user plus access/refresh session. Never store or return passwords/hashes. |
| Vendor registration | Account fields plus `businessName`, `venueName`, `address`, `city`, `locationNote`, optional `latitude`/`longitude`, `sports[]`, one or more `grounds[]`, `facilities[]`, parking fields, `equipment[]`, photo URIs and optional video URI | `POST /api/v1/auth/register/vendor` creates the account/profile/venue/courts/equipment in one transaction; media upload is a later signed-upload flow | Public registration, then vendor-owned records. Court fields: `name`, `sport`, `widthMeters`, `lengthMeters`, `indoorOutdoor`, `surface`, `conditionRating`, `hourlyPricePKR`, `slotDurationMinutes`, `openingTime`, `closingTime`, `availableDays[]`. Current local photo/video URIs are device paths, not uploadable server URLs. |
| Login / session restore / logout | `email`, `password`; current auth repository stores local account/session IDs | `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` | Public login/refresh; other calls authenticated. Frontend token storage/refresh integration is still required. |
| Edit profile / Settings | `name`, `phone`, player `preferredSports[]`, vendor `businessName`; local appearance/session controls | `GET/PATCH /api/v1/users/me`, `GET/PATCH /api/v1/vendors/me` | Authenticated owner. Theme is frontend session state; logout revokes the refresh token. Forgot Password currently explicitly says no email or OTP was sent. |
| Player home / Venue Search | Search text, `sport`, hourly budget, minimum rating, distance, indoor/outdoor, sort; default origin is Lahore coordinates | `GET /api/v1/venues`, `GET /api/v1/venues/nearby?lat=&lng=&radiusKm=&sport=&...` | Public read. PostGIS performs the radius filter and nearest-first order. Search can return `{id,name,address,city,locationNote,sports,facilities,parkingAvailable,parkingSpaces,latitude,longitude,distanceKm,ratingAverage,ratingCount,minimumHourlyPricePKR,media[]}`. |
| Venue Map | Select a venue marker, search nearby area and open details | `GET /api/v1/venues/nearby` and `GET /api/v1/venues/:venueId` | Public read. Current map is a local schematic with fixture coordinates; there is no map SDK or geocoder in the frontend. Do not claim GPS/geocoding is connected. |
| Venue details / reviews | Venue and courts, facilities, equipment, ratings, reviews; review form uses `stars` and `comment`; direct vendor chat is local conversation state | `GET /api/v1/venues/:venueId`, `GET /api/v1/venues/:venueId/reviews`, `POST /api/v1/venues/:venueId/reviews`, conversation APIs | Public venue/review read. Review API needs an eligible booking reference, which the current review screen does not collect; see open decisions. Vendor chat must authorize both conversation participants. |
| Slot selection / equipment / checkout | `venueId`, `groundId` (API name `courtId`), local `slotId`/date/time, equipment IDs/quantities and payment mode | `GET /api/v1/courts/:courtId/availability?date=...`, `POST /api/v1/bookings`, then payment-init/status routes | Player. Server resolves the selected time, recalculates court/add-on prices and atomically reserves the shared calendar. Frontend payment mode `simulated` is not trusted as proof of payment. |
| Player bookings / booking detail | Booking ID, venue/court names, date/time, status, payment status, total, add-on snapshots; joined/created rooms and tournaments are shown alongside bookings | `GET /api/v1/bookings/me`, `GET /api/v1/bookings/:bookingId`, `POST /api/v1/bookings/:bookingId/cancel` | Player may read/cancel own eligible records; server policy controls state transitions. |
| Vendor venue editor / inventory | Vendor-owned venue fields, courts and operating hours, facilities/parking, equipment/add-ons, photos/video, publish status | `GET/PATCH /api/v1/vendors/me`, `POST/PATCH /api/v1/venues/:venueId`, court/amenity/equipment endpoints, signed media endpoints | Vendor ownership enforced on server. Current editor changes local Redux records and regenerates an 8-day availability preview. |
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

The health-only foundation implements `GET /health` (liveness) and `GET /api/v1/health` (database readiness). Other routes below are the initial contract proposal and remain unimplemented.

| Group | Proposed routes | Auth |
|---|---|---|
| Auth/user | `POST /auth/register/player`, `POST /auth/register/vendor`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `GET/PATCH /users/me`, `GET/PATCH /vendors/me` | Public or authenticated as appropriate |
| Venues/catalog | `GET /venues`, `GET /venues/nearby`, `GET /venues/:venueId`, `POST/PATCH /venues/:venueId`, `GET /venues/:venueId/courts`, `POST/PATCH /venues/:venueId/courts/:courtId`, venue media/amenity/equipment routes | Public reads; owning vendor writes |
| Discovery/reviews | `GET /venues/:venueId/reviews`, `POST /venues/:venueId/reviews`, `GET /courts/:courtId/availability?date=...` | Public reads; eligible booking player review |
| Booking | `POST /bookings`, `GET /bookings/me`, `GET /bookings/:bookingId`, `POST /bookings/:bookingId/cancel`, `GET /vendors/me/bookings`, `POST /vendors/me/bookings/walk-in` | Player or owning vendor |
| Payment | `POST /bookings/:bookingId/contributions`, `POST /payments/:paymentId/checkout`, `GET /payments/:paymentId`, `POST /webhooks/safepay` | Authenticated payer; webhook signature verified |
| Rooms/chat | `POST/GET /game-rooms`, `GET /game-rooms/:id`, `POST/DELETE /game-rooms/:id/members/me`, `GET /conversations`, `GET/POST /conversations/:id/messages` | Authenticated; membership checked per room/conversation |
| Tournaments/leaderboard | `GET/POST /tournaments`, `GET/PATCH /tournaments/:id`, `POST/DELETE /tournaments/:id/teams/me`, `PUT /tournaments/:id/standings`, `GET /tournaments/:id/leaderboard`, `GET /leaderboards` | Public list/read as decided; host/player writes |
| Analytics/notifications/media | `GET /vendors/me/analytics`, `GET /notifications`, `PATCH /notifications/:id/read`, `POST /media/signed-upload`, `POST /media/confirm` | Authenticated; vendor ownership on records |

### DTO conventions

- Public roles map to the frontend's `player` and `vendor` values. Server internals use `PLAYER`/`VENDOR` roles and never trust a client role field.
- Frontend registration JSON uses `name`, `email`, `phone`, `password`, `preferredSports[]`; vendor registration adds nested `vendorProfile` and `grounds[]`/`equipment[]` as documented in the matrix.
- Frontend's ground record is named `ground`; API model is `Court`. Request/response DTOs should expose `groundId`/`groundName` where preserving current mobile property names avoids a large screen rewrite, while route names and DB use `courtId`/`Court` consistently.
- UI money values are integer PKR rupees (`hourlyPricePKR`, `totalPKR`, `entryFeePKR`). Database/payment values are integer paisa (`...Paisa`). Explicit DTO functions divide/multiply by 100; never use floating point for stored money.
- UI schedule fields are local `date: YYYY-MM-DD`, `startTime/endTime: HH:MM`. API persists UTC `timestamptz` plus `Asia/Karachi` venue timezone and formats local fields for current screens.
- Venue discovery response should retain names expected by `VenueCard`: `id`, `name`, `address`, `city`, `locationNote`, `sports[]`, `facilities[]`, `latitude`, `longitude`, `parkingAvailable`, `parkingSpaces`, `published`, plus computed `distanceKm`, `ratingAverage`, `ratingCount`, `minimumHourlyPricePKR`.
- Booking DTO should keep `venueName`, `groundName`, `date`, `startTime`, `endTime`, `durationMinutes`, `groundFeePKR`, `addOns[]`, `addOnsTotalPKR`, `totalPKR`, `source`, `status`, and `paymentStatus` for the existing booking cards.

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
src/**/*.test.ts                      # Health and environment tests
```

Feature module directories are intentionally not stubbed before their owners begin Prompts 1–5. Keep the project a modular monolith; add a route/service/repository when its feature is implemented.

## Decisions and known frontend gaps

1. **Prisma version:** pinned Prisma ORM 7.10.1 and `@prisma/client` 7.10.1 (the current stable v7 line; Prisma 8 is still a release candidate). npm's published Prisma 7.10.1 engine range includes this Node 22.17 runtime. Prisma 7 uses ESM, an explicit PostgreSQL driver adapter and `prisma.config.ts`; PostGIS remains an `Unsupported("geography(Point,4326)")` field accessed through parameterized raw SQL. The initial Prisma 6 trial surfaced high-severity advisories in its CLI dependency tree, so the scaffold moved to patched Prisma 7 rather than force-upgrading via `npm audit fix`.
2. **Map:** frontend currently uses a custom offline schematic and Lahore fixture coordinates; it has no map SDK, GPS or geocoder. This prompt adds no map package. Nearby API uses PostGIS; provider integration is deferred to Prompt 2.
3. **Media:** frontend currently returns local image-picker URIs; no signed upload flow or public remote media URL exists. Do not persist those device URIs as if they were uploaded. Prompt 2 must add signed storage URLs and the frontend upload/confirm flow.
4. **Payments:** room and tournament UI currently records simulated statuses and states that money does not move. Backend `DEVELOPMENT_MOCK` is reserved for isolated tests only and must be rejected in production. Prompt 4 owns Safepay sandbox. Tournament prize allocation/payout semantics need team/provider confirmation; this schema does not claim escrow or automatic vendor payouts.
5. **Reviews:** current review UI submits venue ID, stars and comment without a booking ID. Prompt 0 keeps the plan's eligible-booking rule; connect the UI to include a booking or get explicit approval to broaden eligibility.
6. **Authentication:** forgot-password UI expressly says no email/OTP is sent. This foundation does not implement OTP or claim email delivery. Player/vendor registration UI currently creates local accounts; future API integration must carry the vendor nested venue draft and return a real backend user/session.
7. **Legacy local data:** current frontend seeds fictional local venues, sample bookings, conversations, tournaments and leaderboards. API responses must replace these deliberately in Prompt 6; do not copy fixture rows into the shared database as real providers/customers.
8. **Branch safety:** the backend repo was on `main` with only two untracked prompt input files and no `develop`/feature branch. Per the global instruction not to switch with uncommitted files, branch was left unchanged and no commit was made. Review the working tree and create the team's feature branch before committing/PR.

## Environment and commands

Node.js 22 and npm are used to match the installed environment. Copy the environment template before install because Prisma's config reads `DATABASE_URL` during generation:

```bash
cp .env.example .env
# Edit DATABASE_URL to point to your own local database or the team-approved Supabase dev project.
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
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Later | Add only for Prompt 1 auth; use independent high-entropy values. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Later | Server-side signed media upload only; never expose service key to frontend. |
| `GEOAPIFY_API_KEY` | Later/optional | Server-side geocoding if needed; manual coordinates remain the fallback. |
| `SAFEPAY_ENV`, `SAFEPAY_SECRET_KEY`, `SAFEPAY_API_KEY`, `SAFEPAY_WEBHOOK_SECRET`, `SAFEPAY_RETURN_URL`, `SAFEPAY_CANCEL_URL` | Later | Safepay sandbox; no live payment is enabled in this foundation. |

## Prompt 0 verification results

- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npm ci` — passed from the lockfile (412 packages). The URL was a placeholder; install/generation did not connect to a database.
- `npm test` — passed: 2 files / 8 tests (environment validation, blank optional `.env.example` URLs, CORS, health/readiness and 404 behavior).
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npm run prisma:validate` — passed.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npm run prisma:generate` — passed; Prisma Client 7.10.1 generated into the ignored `src/generated/prisma` directory.
- `DATABASE_URL=postgresql://playspot:local-only@localhost:5432/playspot_dev npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output prisma/migrations/20261110000000_initial/migration.sql` — passed; the checked-in migration then adds the PostGIS/btree_gist setup, GiST index and custom check/exclusion constraints.
- `npm audit --omit=dev --audit-level=moderate` — passed with 0 production dependency vulnerabilities. Full `npm audit` reports 7 moderate advisories in the development-only TypeScript ESLint/minimatch chain; no forced major downgrade was applied.
- Built-server smoke test with a deliberately non-working local URL: `GET /health` returned 200, `GET /api/v1/health` returned 503 with `DATABASE_UNAVAILABLE`, and an unimplemented route returned the standard 404 envelope. This confirms liveness is separate from readiness and no fake DB success is returned.
- `git diff --check` — passed. `find . -name README.md -print` — exactly one result, `./README.md`.
- **Not run:** migration deploy, seed, live DB connectivity, PostGIS query, and any real provider integration. No database URL/credentials were present and local PostgreSQL 16 has no PostGIS extension available; Docker is absent. The migration is generated and reviewed but must only be applied to the team-approved development database after PostGIS is enabled.
- **Runtime note:** this machine's Node is 22.17.0. Node 22.23.4 was the latest published 22.x LTS patch checked during Prompt 0; use a current supported Node 22 patch for shared development/deployment.
- **Tooling note:** npm reports ESLint 9.39.5 as deprecated and the full dev-dependency audit contains 7 moderate TypeScript ESLint/minimatch findings. The ESLint 10 upgrade attempt hit peer-dependency resolution conflicts, so it was reverted rather than forcing a mismatched toolchain. Production dependency audit is clean; update the lint toolchain with a compatible parser/plugin set before release.

## Official implementation references

- [Supabase PostGIS guide](https://supabase.com/docs/guides/database/extensions/postgis) — enable PostGIS in `extensions`, geographic points, GiST index and longitude/latitude order.
- [Prisma ORM 7 raw SQL guidance](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries) — unsupported spatial fields require casting/parameterized raw SQL; ordinary CRUD stays typed.
- [Prisma ORM 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) — ESM, CLI config, PostgreSQL driver adapter and connection setup.
- [PostgreSQL range/exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html) — use GiST range overlap exclusions and `btree_gist` for court equality.
- [Express 5 migration/requirements](https://expressjs.com/en/guide/migrating-5/) — Express 5 supports Node 18+.
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases) — check the current supported LTS patch before shared deployment.
