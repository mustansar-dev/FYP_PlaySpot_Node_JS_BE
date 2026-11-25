# PlaySpot PK Backend

PlaySpot PK is a React Native sports venue booking and matchmaking app. This backend provides authenticated player/vendor APIs for accounts, venues, courts, discovery, availability, bookings and walk-ins, payment workflows, game rooms, persisted chat, tournaments, leaderboards and vendor analytics. The React Native app uses the API for live account and domain data; only JWT session credentials remain in local storage. Database-backed operation still requires a configured PostgreSQL/PostGIS database.

## Project and working state

- Frontend: [FYP_PlaySpot_React_Native_FE](https://github.com/mustansar-dev/FYP_PlaySpot_React_Native_FE).
- Frontend checkout inspected for this foundation: `/home/ibrahim/rn_lab_workspace/FYP_PlaySpot_React_Native_FE`. This path is machine-specific; use the repository URL on another computer.
- Team: Ibrahim Sattar (BSSE23004), Mustansar (BSSE23027), Hasham (BSSE23053).
- Backend runtime: Node.js 22 with npm. This machine has Node `v22.17.0` and npm `10.9.2`; Prisma 7.10.1 supports Node 22.12+.
- Current integration checkouts: backend `frontend-integration`, frontend `backend-integration`. Existing local changes were reviewed and preserved; no branch switch, reset, rebase or push was performed.
- The updated backend week plan and prompt pack were read for this release pass; their contents are not duplicated here.
- Exactly one README is maintained in this repository: this root file. Setup, contract, schema, decisions and limitations stay here.

## Completed scope

1. The backend has validated Express/Prisma configuration, liveness/readiness routes, a PostgreSQL/PostGIS schema, booking overlap constraints and an idempotent reference-data seed.
2. Authentication provides player/vendor registration, login, refresh rotation, logout/revocation, profile routes and role/ownership checks.
3. Venue APIs provide vendor-owned venue/court/equipment/media operations, public discovery/detail/reviews and parameterized PostGIS nearby search.
4. Booking APIs provide availability, server-priced reservations, walk-ins on the shared court calendar, history, cancellation and payment contributions. Payment routes provide safeguarded Safepay Sandbox or a development-only simulation, pay-at-venue, bank-transfer instructions/receipt review and vendor collection controls.
5. Community APIs provide public/private rooms, persisted member-checked chat, tournaments, leaderboards and vendor analytics. Socket.IO authenticates with the same JWT and REST remains the history/send fallback.
6. Prompt 6 connects high-priority React Native account, discovery, booking, community and analytics flows to these APIs. The current local development database is `playspot_db`, with restricted runtime role `playspot_user` and DDL role `playspot_migrator`.
7. The local `playspot_db` had an empty active sports catalog, which caused player registration to reject the frontend's selected interests. The reference seed is now part of the one-command setup and registration returns an actionable `SPORT_CATALOG_NOT_SEEDED` error if setup was skipped.
8. The database had an applied generated migration that dropped the custom PostGIS and payment indexes. A follow-up migration restores those indexes, and the Prisma schema now declares all three so future schema diffs preserve them.
9. Live vendor venue edits now persist to the API. New courts are created by the server and the frontend replaces temporary form IDs with real court UUIDs before requesting availability. Vendors may preview their own draft courts; players only discover venues after publication.

## Frontend audit

The inspected frontend is a bare React Native CLI application (`react-native` 0.86.2, React 19.2.3) using React Navigation native stack, Redux Toolkit and AsyncStorage. `src/services/apiClient.js` owns the configurable fetch client, bearer token, refresh rotation, response parsing and session expiry. Live builds default to the backend; AsyncStorage stores the JWT session only, while demo account/domain persistence is explicitly enabled only in tests or when `__PLAYSPOT_DEMO_MODE__` is set. Redux holds the in-memory view cache in backend mode, with no silent fixture fallback after network failures.

### Screen-to-API contract

| Frontend screen/flow | Current input/data contract | Proposed API calls | Role and important behavior |
|---|---|---|---|
| Welcome / Role selection | Select `player` or `vendor`; navigation only | None | Public navigation only. |
| Player registration | `name`, `email`, `phone`, `password`, `confirmPassword`, `preferredSports[]` | `POST /api/v1/auth/register/player` | Public; server validates and returns a user plus access/refresh session. Never store or return passwords/hashes. |
| Vendor registration and venue management | Account fields plus venue, `grounds[]`, facilities, parking, equipment and media | `POST /auth/register/vendor`, then authenticated venue/court/equipment CRUD and signed media routes | Vendor registration creates a pending profile and draft venue. In development the owner can publish the venue for player discovery; production still requires approval. Court and venue edits now persist to PostgreSQL. Device photo/video URIs are not uploaded by the mobile app yet. |
| Login / session restore / logout | `email`, `password`; backend tokens and safe user profile | `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` | Public login/refresh; other calls authenticated. The mobile client stores rotating tokens and refreshes once after a 401. |
| Edit profile / Settings | `name`, `phone`, player `preferredSports[]`, vendor `businessName`; local appearance/session controls | `GET/PATCH /api/v1/users/me`, `GET/PATCH /api/v1/vendors/me` | Authenticated owner. Theme is frontend session state; logout revokes the refresh token. Forgot Password currently explicitly says no email or OTP was sent. |
| Player home / Venue Search | Search text, sport, hourly budget, minimum rating, distance and sort; Search can use the player's permission-granted device location, with Lahore as the fallback origin | `GET /api/v1/venues`, `GET /api/v1/venues/nearby?lat=&lng=&radiusKm=&sport=&...` | Public read. PostGIS returns published venues nearest-first. If a legacy row has latitude/longitude but no geography point, the nearby query derives the point from those coordinates; venues with no coordinates remain at the end without an estimate. Area text matches venue `locationNote` too. |
| Venue Map | Interactive Geoapify map tiles, nearby PlaySpot venue markers, place search, map taps/panning and device location | `GET /api/v1/map/status`, `/map/tiles/:z/:x/:y`, `/map/geocode?q=...`, `/map/reverse?lat=&lon=`, plus `/venues/nearby` | Public map reads. Geoapify credentials stay on the backend; the tile and geocoding routes are rate-limited and validate coordinates. Android requests location permission when the player selects **My location**. |
| Venue details / reviews | Venue, grounds/courts, facilities, equipment, ratings and reviews | `GET /api/v1/venues/:venueId`, `GET /api/v1/venues/:venueId/courts`, `GET /api/v1/venues/:venueId/equipment`, `GET /api/v1/venues/:venueId/reviews`, `POST/PATCH /api/v1/venues/:venueId/reviews` | Public reads. A review requires a completed booking ID owned by the authenticated player. Venue pins require saved latitude/longitude. |
| Slot selection / equipment / checkout | `venueId`, `groundId` (API name `courtId`), local `slotId`/date/time, equipment IDs/quantities and payment mode | `GET /api/v1/courts/:courtId/availability?date=...`, `POST /api/v1/bookings`, then payment-init/status routes | Player. Server resolves the selected time, recalculates court/add-on prices and atomically reserves the shared calendar. Frontend payment mode `simulated` is not trusted as proof of payment. |
| Player bookings / booking detail | Booking ID, venue/court names, date/time, status, payment status, total, add-on snapshots; joined/created rooms and tournaments are shown alongside bookings | `GET /api/v1/bookings/me`, `GET /api/v1/bookings/:bookingId`, `POST /api/v1/bookings/:bookingId/cancel` | Player may read/cancel own eligible records; server policy controls state transitions. |
| Vendor venue editor / inventory | Vendor-owned venue fields, UUID courts and operating hours, facilities/parking, equipment/add-ons, photos/video, publish status | `GET /api/v1/vendors/me/venues`, venue/court/equipment CRUD, amenities and media endpoints | Venue, facility and court changes now save to the API. New local draft courts are created on the server and replaced in app state with server UUIDs. Local picker URIs are not uploaded to Storage yet. |
| Vendor availability / bookings / walk-in | Court UUID, date and generated time slots; walk-in name/contact, payment choice/status; booking detail | Authenticated `GET /api/v1/courts/:courtId/availability`, vendor booking/walk-in endpoints | A vendor can read availability for their own draft or published courts; players can read published courts. Walk-ins and app bookings use the same overlap constraint. |
| Game rooms / split calculator | Room title/sport/location/date/start/end/capacity/visibility/private invite, optional court reservation, seat shares and member status | `POST/GET /api/v1/game-rooms`, `GET /api/v1/game-rooms/me`, `GET /api/v1/game-rooms/:id`, join/leave/close/invite routes, booking contribution/payment routes | Player. A court-hosted room atomically reserves the selected court as a booking; shares are server-calculated and due at the venue. Private rooms are omitted from public results and require an invite. Hosted room payments are pay-at-venue only. |
| Chat inbox / conversation | Conversation kind (`venue-vendor`, `game-room`, `tournament`, `support`), participant IDs, message body/timestamp and unread state | `GET /api/v1/conversations`, message history/send routes and authenticated Socket.IO events | Server derives sender from auth and checks membership before history/send/socket join. Messages and in-app notifications are persisted; push notifications are not configured. |
| Tournaments / tournament detail | Vendor host, selected venue courts, sport, date/start/end, max teams, team size, entry fee/player, prize, team names/member names, payment state, standings/winner | Vendor `POST /api/v1/tournaments`; player list/detail, register/withdraw, team payment, vendor cash/transfer review, cancellation and standings routes | Tournament creation validates and reserves each selected court on the shared booking calendar. Team entry supports Safepay checkout or pay-at-venue; paid/failed status is server-owned. Prize payouts and refunds are not automated. |
| Global/tournament leaderboards | Player account names and preferred sports; wins/points from tournament standings | `GET /api/v1/leaderboards?sportId=...`, `GET /api/v1/tournaments/:id/leaderboard` | Read-only. Rankings derive from persisted results, ordered deterministically by points, wins and name. |
| Notifications | In-app booking/chat/tournament/review records, `readAt` | `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all` | Authenticated user; no push service is currently installed. |
| Vendor analytics / reviews | Daily booking and verified revenue charts, booked value, occupancy and review aggregates | `GET /api/v1/vendors/me/analytics?from=&to=`, vendor review endpoints | Server derives the selected period only from the authenticated vendor's persisted bookings, courts and settled payments. |

### Current local/mock sources to replace

- Auth/session and account fixture storage: `src/services/authStorage.js`, `src/services/authRepository.js`, `src/store/authSlice.js`.
- Venue, court, equipment, slot and review fixtures: `src/data/demoVenueData.js`; normalization/persistence: `src/services/venueStorage.js`; state transitions: `src/store/venueSlice.js`.
- Rooms, conversations, messages, tournaments, standings and notifications: `src/data/demoCommunityData.js`, `src/store/communitySlice.js`, and `src/utils/community.js`.
- Screen-level flows: `src/screens/BookingScreens.js`, `src/screens/CommunityScreens.js`, `src/screens/VenueSearchScreen.js`, `src/screens/VenueDetailsScreen.js`, `src/screens/VendorVenueManagementScreen.js`, `src/screens/VendorRegistrationScreen.js`, `src/screens/VendorAnalyticsScreen.js`, `src/screens/AccountScreens.js`.
- Prompt 6 adds a centralized `fetch` client in the frontend (`src/services/apiClient.js`, `src/services/backendApi.js`) and explicit demo mode for Jest/local demo use. App builds default to the backend; API failures do not hydrate fixture data.

## API contract

Base prefix: `/api/v1`. JSON success response:

```json
{"success":true,"data":{},"meta":{"page":1,"limit":20,"total":0}}
```

Error response:

```json
{"success":false,"error":{"code":"VALIDATION_ERROR","message":"The request is invalid.","details":[]}}
```

The API implements liveness/readiness, authentication/profile, venue/catalog/media/reviews, availability/bookings/walk-ins, payments, rooms/chat, tournaments/leaderboards, vendor analytics and persisted in-app chat notifications. `GET /api/v1/sports` exposes active reference sports (`id`, `name`, `code`) for room/tournament requests. Push notifications are not configured.

| Group | Implemented routes | Auth |
|---|---|---|
| Auth/user | `POST /api/v1/auth/register/player`, `POST /api/v1/auth/register/vendor`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `GET/PATCH /api/v1/users/me`, `GET/PATCH /api/v1/vendors/me` | Implemented; public/authenticated as appropriate |
| Venues/catalog | `GET /amenities`, `GET /venues`, `GET /venues/nearby`, `GET /venues/:venueId`, `GET /vendors/me/venues`, `POST /venues`, `PATCH/DELETE /venues/:venueId` | Public reads; owning vendor writes |
| Courts/equipment | `GET/POST /venues/:venueId/courts`, `PATCH/DELETE /venues/:venueId/courts/:courtId`, `GET/POST /venues/:venueId/equipment`, `PATCH/DELETE /venues/:venueId/equipment/:equipmentId` | Public reads for published venues; owning vendor writes |
| Media/reviews | `POST /venues/:venueId/media/signed-upload`, `POST /venues/:venueId/media/confirm`, `DELETE /venues/:venueId/media/:mediaId`, `GET /venues/:venueId/reviews`, `POST/PATCH /venues/:venueId/reviews` | Vendor owner for media; public review read; completed-booking player create/edit |
| Availability/booking | `GET /courts/:courtId/availability?date=...`, booking read/create/cancel, vendor list and walk-in routes | Authenticated player or owning vendor |
| Booking | `POST /bookings`, `GET /bookings/me`, `GET /bookings/:bookingId`, `POST /bookings/:bookingId/cancel`, `GET /vendors/me/bookings`, `POST /vendors/me/bookings/walk-in` | Player or owning vendor |
| Payment | `GET/PUT /vendors/me/payment-instructions`, `POST /bookings/:bookingId/contributions`, `POST /tournaments/:id/teams/me/payments`, `POST /payments/:id/checkout`, `GET /payments/:id`, Safepay webhook, bank instructions, authenticated receipt upload and private receipt review, vendor cash confirmation and transfer approve/reject | Authenticated payer or owning vendor; webhook signature verified; simulation is development-only |
| Rooms/chat | `GET /sports`, `POST/GET /game-rooms`, `GET /game-rooms/me`, `GET /game-rooms/:id`, join/leave/close/invite routes, venue conversation, conversation history/send and Socket.IO events | Authenticated; membership checked per room/conversation; selected venue vendor joins room chat |
| Tournaments/leaderboard | `GET/POST /tournaments`, `GET /tournaments/:id`, `POST /tournaments/:id/teams`, `GET /tournaments/:id/teams/me`, `DELETE /tournaments/:id/teams/me`, entry-payment/instructions, cancel, standings and leaderboard routes | Public listing/detail; authenticated player/vendor actions and organizer ownership checks |
| Analytics/notifications/media | `GET /vendors/me/analytics`, `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all`, `POST /media/signed-upload`, `POST /media/confirm` | Authenticated; notification reads are owner-scoped; media checks ownership |

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
- No email/SMS verification or OTP is sent. Vendor verification remains `PENDING` until an operator approves it. Development allows an owner to publish a venue for the local FYP demo; production still blocks publishing until approval. There is no admin approval screen/role in this build.

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
- Hosted database, Supabase and payment-provider credentials are not recorded in this repository. The local backend `.env` may contain a Geoapify key; it is read server-side and must never be copied into the mobile `.env` or bundle. Do not run migrations against an unknown/shared target.

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
src/modules/maps/router.ts            # Geoapify tile proxy, place geocoding and reverse lookup
src/**/*.test.ts                      # Health and environment tests
```

Keep the project a modular monolith; add a route/service/repository when its feature is implemented.

## Decisions and known frontend gaps

1. **Prisma version:** pinned Prisma ORM 7.10.1 and `@prisma/client` 7.10.1 (the current stable v7 line; Prisma 8 is still a release candidate). npm's published Prisma 7.10.1 engine range includes this Node 22.17 runtime. Prisma 7 uses ESM, an explicit PostgreSQL driver adapter and `prisma.config.ts`; PostGIS remains an `Unsupported("geography(Point,4326)")` field accessed through parameterized raw SQL. The initial Prisma 6 trial surfaced high-severity advisories in its CLI dependency tree, so the scaffold moved to patched Prisma 7 rather than force-upgrading via `npm audit fix`.
2. **Map:** the Android client uses MapLibre Native with Geoapify raster tiles, server-proxied through `/map/tiles`. The backend also exposes bounded Pakistan place search and reverse geocoding; it never sends the Geoapify key to the app. Nearby venue markers/search still come from PlaySpot's PostGIS APIs, while device location uses Android's permission-gated location provider.
3. **Media and receipts:** frontend currently returns local venue image-picker URIs; those are not uploaded to Supabase yet. In development, payment receipts upload through the authenticated Multer multipart route and are stored privately in `PAYMENT_RECEIPTS_LOCAL_DIR` (default `.data/payment-receipts/`, ignored by Git). Production receipt storage requires the private Supabase bucket configuration. Receipt files are only served to the payer and venue owner.
4. **Payments:** booking checkout supports online (Safepay sandbox or labelled development simulation), pay-at-venue and bank transfer with receipt review. Tournament entry supports online or pay-at-venue; the backend also supports tournament bank-transfer instructions and receipt review, though the mobile tournament form currently exposes only online/pay-at-venue. Game-room court shares are pay-at-venue only. No workflow transfers prize money, performs automatic refunds or splits/pays out marketplace funds. `DEVELOPMENT_MOCK` is forbidden in production.
5. **Reviews:** the review UI now submits a completed booking ID with venue ID, stars and comment. The API requires that booking to belong to the authenticated player and have `COMPLETED` status. The current schema has no separate venue-confirmed-attendance field, so that part of the UI rule cannot yet be enforced; coordinate a schema addition with the schema owner if attendance confirmation is required.
6. **Authentication:** forgot-password UI expressly says no email/OTP is sent. This foundation does not implement OTP or claim email delivery. Player/vendor registration is connected to the API; vendor onboarding sends its nested venue, court and equipment draft sequentially. OTP/password recovery is not implemented.
7. **Legacy local data:** current frontend seeds fictional local venues, sample bookings, conversations, tournaments and leaderboards. the Prompt 6 mobile integration now switches these flows to API responses outside explicit demo mode; do not copy fixture rows into the shared database as real providers/customers.
8. **Vendor approval:** this FYP has no admin approval screen or admin role. Development mode allows a vendor to publish their own listing so a local player account can discover it. Production keeps publication approval-gated and requires an operator to approve the vendor profile.
9. **Prompt 2 schema limits:** the shared schema has no equipment description or venue/court capacity column. Prompt 2 leaves those fields out rather than editing schema/migrations, as required. The editor currently does not send capacity.
10. **Branch safety:** this QA pass preserved the active `backend-integration` and `frontend-integration` branches and all pre-existing worktree changes. No remote branches were merged or pushed.

## Prompt 6 mobile integration status

The mobile client lives in the sibling repository `FYP_PlaySpot_React_Native_FE`. It keeps its public API URL in `src/config/backendApi.js`; no database, storage service-role, or payment secrets belong in the bundle. Android emulator uses `10.0.2.2`; a physical device must use a developer-configured LAN/tunnel address. The frontend selects a local demo only when Jest runs or `globalThis.__PLAYSPOT_DEMO_MODE__ === true`; network errors are surfaced instead of switching to fixtures.

| Flow | Backend contract | Mobile integration state / limitation |
|---|---|---|
| Player/vendor auth and refresh | `/auth/register/*`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/users/me`, `/vendors/me` | Central API client stores rotating tokens in AsyncStorage, retries one 401 after a single shared refresh, clears the session on invalid refresh, and the app hydrates remote user data. |
| Venue onboarding and catalog | `/venues`, `/venues/:id`, `/venues/:id/courts`, `/venues/:id/equipment`, `/amenities`, signed media routes | Vendor registration creates draft venue/courts/equipment sequentially. Selected local media URIs remain local and are not uploaded yet. |
| Discovery and availability | `/venues`, `/venues/nearby`, `/map/status`, `/map/tiles/:z/:x/:y`, `/map/geocode`, `/map/reverse`, `/courts/:courtId/availability?date=` | Search and room venue suggestions query the backend. Player Search can use GPS coordinates; the map uses MapLibre plus server-proxied Geoapify tiles and place search. Nearby ordering uses venue coordinates and the chosen player origin. Availability is fetched per selected court/date. |
| Bookings and walk-ins | `POST /bookings`, `/bookings/me`, `/bookings/:id`, `/bookings/:id/cancel`, `/vendors/me/bookings`, `/vendors/me/bookings/walk-in` | Booking and walk-in create/cancel call the server; availability and conflicts are authoritative server-side. Never treat app state as proof a slot is reserved. |
| Payment | `/payments/:id/checkout`, `/payments/:id`, booking and tournament payment instructions, signed receipt routes and vendor confirmation routes | Booking checkout offers online, pay-at-venue and bank transfer with receipt upload and vendor approval/rejection. Booking detail refreshes server payment state and lets the venue record cash. Tournament entry offers online and pay-at-venue; vendor cash confirmation is available on tournament detail. Safepay needs issued Sandbox credentials; local simulation is clearly labelled. |
| Rooms and chat | `/sports`, `/game-rooms`, `/game-rooms/me`, `/venues/:venueId/conversations`, `/conversations`, `/conversations/:id/messages` and Socket.IO events | Public/private membership, court booking reservation, due-at-venue member shares, vendor participation in room chat, REST history and Socket.IO send/receive are connected. Chat notifications persist. Share settlement beyond the backend vendor payment routes is not fully exposed in the room UI. Private invite codes can be rotated; the player must keep the returned code. |
| Tournaments and leaderboards | `/sports`, `/tournaments`, court reservations, team registration/withdrawal, team-entry payments, standings, tournament/global leaderboards | Tournament creation reserves selected courts. Team registration/payment state, online checkout, pay-at-venue, cancellation/refund-pending audit, standings and leaderboards are connected. Safepay needs credentials; prize payouts and actual refunds are manual/external. Tournament bank transfer works in the backend but is not exposed in the current mobile tournament UI. |
| Vendor analytics | `/vendors/me/analytics?from=&to=` | The dashboard displays the backend's selected-period booking and verified-revenue totals plus daily charts; it refreshes from persisted server data in backend mode. |

The integration adds the read-only `/sports` reference route, persisted chat notifications, venue-vendor conversations, booking receipts, tournament court reservations and tournament-entry payment state. Chat realtime uses Socket.IO authentication with `auth: { token: accessToken }`, `chat:join` payload `{ conversationId }`, `chat:message` payload `{ conversationId, body }`, and receives `chat:message:new` plus `notification:new`. REST history and notification reads remain the recovery path. Push notifications, venue binary media upload, prize payouts and automatic refunds are not configured. Safepay checkout requires issued Sandbox credentials; without them the development-only simulation is labelled and cannot run in production.

## Environment and commands

Requirements: Node.js 22.12 or newer, npm, and PostgreSQL with PostGIS plus `btree_gist`. Keep the app and migration roles separate:

- `DATABASE_URL` connects as `playspot_user` and is used by the running API.
- `MIGRATOR_DATABASE_URL` connects as `playspot_migrator` to the same database and is used for migrations and reference-data seeding.
- `SHADOW_DATABASE_URL` is an optional, separate database used only by `prisma migrate dev`. It is not needed by the first-time `setup` script, which uses the checked-in migrations with `migrate deploy`.

From a clean checkout:

```bash
npm run setup
npm run dev
```

`npm run setup` installs the lockfile dependencies, creates an ignored `.env` from `.env.example` if needed, generates local JWT secrets, validates/generates Prisma Client, applies pending checked-in migrations using the migrator role, seeds sports and amenities, and verifies database access. For an existing database, set `DATABASE_URL` as `playspot_user` and `MIGRATOR_DATABASE_URL` as `playspot_migrator` in `.env`. If the migrator URL is missing, setup can derive it from a same-server `SHADOW_DATABASE_URL` with a separate role.

For a new local PostgreSQL instance, optionally set `PLAYSPOT_POSTGRES_ADMIN_URL` to a local administrator connection in the ignored `.env`; setup generates strong local passwords, creates `playspot_user` and `playspot_migrator`, creates `playspot_db` and `playspot_shadow`, grants runtime/migration permissions, and enables PostGIS plus `btree_gist`. Then setup applies the migrations and seed. This provisioner is for a disposable/local development database only; it does not provision hosted or production databases. `npm run db:setup` repeats the database steps without reinstalling dependencies. Neither command resets or truncates existing data.

The sports catalog seed is idempotent. It creates Futsal, Football, Cricket, Padel, Badminton and Basketball. Player registration/profile edits and tournament/room forms use these active rows; an empty catalog now returns `SPORT_CATALOG_NOT_SEEDED` with the setup command.

Useful commands:

```bash
npm run db:check
npm run db:provision             # only when PLAYSPOT_POSTGRES_ADMIN_URL is set for a local DB
npm run prisma:migrate:status
npm run prisma:migrate:dev       # isolated development DB only; needs SHADOW_DATABASE_URL or CREATEDB
npm run prisma:migrate:deploy    # apply reviewed migrations with MIGRATOR_DATABASE_URL
npm run prisma:seed              # idempotent reference data seed, using the migrator role
npm run dev
```

The API listens on `PORT` (default `4000`). `GET /health` is liveness; `GET /api/v1/health` checks database readiness. `npm run db:check` confirms the two roles target the same database, runtime read/account-write privileges, migrator schema-create privilege, PostGIS extensions and seeded sports without printing connection strings.

For the React Native app, open the sibling [FYP_PlaySpot_React_Native_FE](/home/ibrahim/rn_lab_workspace/FYP_PlaySpot_React_Native_FE) folder and run `npm run setup`, then run `npm start` and `npm run android`. Start this backend first with `npm run dev`. Android Emulator uses `http://10.0.2.2:4000/api/v1`; a physical phone must use the development computer's reachable LAN/tunnel address in the frontend `.env`. The API URL is public configuration and belongs only in the frontend `.env`. Never copy `DATABASE_URL`, `MIGRATOR_DATABASE_URL`, Supabase service-role keys or payment secrets into the app.

### Database setup / migration status

1. Use the approved development database or an isolated local PostgreSQL/PostGIS database. Never use `prisma migrate reset`, truncate, or destructive push commands on shared data.
2. Migrations run as `playspot_migrator`; API requests run as `playspot_user`. Both connection URLs must point to the same database. For local migration authoring with `migrate dev`, provision a separate shadow database and set `SHADOW_DATABASE_URL`.
3. The checked-in migrations install PostGIS and `btree_gist`, create the venue geography GiST index, and enforce court overlap/domain constraints. The three custom indexes are now declared in `schema.prisma`; migration `20261120150000_restore_preserved_indexes` restores them after the generated `20261120141941_1st` migration dropped them.
4. In this workspace, `npm run db:setup` applied the pending index-restoration migration and seeded six sports plus six amenities into the local `playspot_db`. `npm run db:check` then verified PostGIS, `btree_gist`, runtime role access and migrator DDL access. Do not run this against a production database.

## Environment variables

| Variable | Required now | Purpose |
|---|---:|---|
| `NODE_ENV` | No | `development`, `test` or `production`; default `development`. |
| `PORT` | No | HTTP port; default `4000`. |
| `API_PREFIX` | No | Versioned route prefix; default `/api/v1`. |
| `APP_ORIGINS` | No | Comma-separated browser origins; default local Metro web origin. Native requests without an Origin header are accepted. |
| `PLAYSPOT_POSTGRES_ADMIN_URL` | Optional for new local DB provisioning | Local administrator connection used by `npm run setup` to create local roles/databases and enable extensions. Never commit or use for hosted/production setup. |
| `PLAYSPOT_DB_NAME`, `PLAYSPOT_SHADOW_DB_NAME` | No | Local provisioner database names; defaults `playspot_db` and `playspot_shadow`. |
| `PLAYSPOT_USER_PASSWORD`, `PLAYSPOT_MIGRATOR_PASSWORD` | No | Local provisioner role passwords. If blank, setup generates private values into ignored `.env`. |
| `DATABASE_URL` | Yes | Restricted PostgreSQL runtime connection (`playspot_user`). |
| `MIGRATOR_DATABASE_URL` | Yes for `npm run setup` | DDL-capable PostgreSQL connection (`playspot_migrator`) to the same database. Prisma migrations and reference seeding use this role. |
| `SHADOW_DATABASE_URL` | Only for `prisma migrate dev` | Separate shadow database; never point it at the actual development database. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Yes outside tests | Independent secrets, at least 32 characters. `npm run setup` generates local values if blank; the API never prints them. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Optional for API startup; required for venue media | Server-side signed upload, object verification and deletion. Keep the service role key on the backend. Configure the bucket for public reads because venue DTOs return public media URLs. |
| `PAYMENT_RECEIPTS_BUCKET`, `PAYMENT_RECEIPTS_LOCAL_DIR` | Receipt bucket for Supabase; local directory for development fallback | Supabase receipt objects stay private. Development files default to `.data/payment-receipts/`; production does not use local-disk fallback. |
| `GEOAPIFY_API_KEY` | Optional for API startup; needed for real map tiles and geocoding | Backend-only Geoapify key used by the map tile proxy and forward/reverse geocoding routes. Add it to the backend `.env`; never place it in the React Native `.env` or source bundle. |
| `PAYMENT_PROVIDER` | No | `.env.example` selects `development_mock` for a local-only, clearly labelled payment simulation. Production startup rejects this adapter. |
| `SAFEPAY_ENV`, `SAFEPAY_SECRET_KEY`, `SAFEPAY_API_KEY`, `SAFEPAY_WEBHOOK_SECRET`, `SAFEPAY_RETURN_URL`, `SAFEPAY_CANCEL_URL` | Required when `PAYMENT_PROVIDER=safepay` | Safepay Sandbox only; sandbox credentials must be supplied before hosted checkout can run. No live payment configuration is supported. |

## Integration setup and verification — November 21, 2026

### Demo marketplace records

Run `npm run seed:demo-marketplace` against a development database to create or refresh three fictional Pakistani vendors, six fictional players, public venues, courts, sport rentals, clearly marked fictional bank instructions, two completed tournaments with scores, one upcoming tournament, registered teams and player bookings. The script is idempotent, only writes accounts under `@demo.playspot.invalid`, and refuses to run when `NODE_ENV=production`.

All seeded accounts use password `PlaySpotDemo2026!`. The script prints their login emails after a successful run. These are clearly labeled demo accounts and must not be used in production.

- Backend `npm run setup` — passed. It installed 453 packages from the lockfile, validated and generated Prisma Client 7.10.1, found all five migrations applied, seeded six sports plus six amenities, and verified `playspot_user`, `playspot_migrator`, PostGIS and `btree_gist`.
- Backend `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` — passed; 14 test files / 72 tests passed.
- Backend HTTP smoke — `/health`, `/api/v1/health` and `/api/v1/sports` returned success. The live sports route returned Badminton, Basketball, Cricket, Football, Futsal and Padel. This confirms the registration error was caused by the previously empty active sports catalog; setup now seeds it and the API returns an actionable setup error if it is empty again.
- Database status — `npm run db:check` passed and `prisma migrate status` reports all five migrations up to date. The local database has both required extensions and the restored custom indexes.
- Vendor availability now requires a sign-in, accepts an unpublished court only for its owning vendor, and still hides that draft from players. The local database initially had one unpublished venue and one saved court; after publishing the venue through the development API, the public venues endpoint returned it. A second court that exists only in old frontend state must be re-added/saved once so it receives a database UUID.
- Frontend `npm run setup -- --skip-install` — passed and validated the ignored Android Emulator API URL. Frontend `npm test -- --runInBand` — passed: 11 suites / 63 tests. Android Metro bundle passed and copied 24 assets.
- `git diff --check` — passed in both repositories. `.env` and `node_modules/` are ignored by the existing `.gitignore` files. The optional PostgreSQL administrator provisioner was not run because the workspace already had the two roles and databases.
- npm reports 10 dependency advisories. The audit run still reports three high issues through `effect` under Prisma's CLI configuration dependency; `npm audit --force` proposes a breaking downgrade to Prisma 6.12, so no forced dependency change was applied.
- Provider limits: no Safepay Sandbox credentials or Supabase Storage credentials are configured. Online checkout can be demonstrated only through the labelled local simulation until sandbox credentials are issued. A vendor must configure bank instructions before bank transfer can be used. No live payment, refund, prize payout or venue-media upload was attempted. No emulator/device walkthrough or Android Gradle build was run in this verification pass.

## Official implementation references

- [Supabase PostGIS guide](https://supabase.com/docs/guides/database/extensions/postgis) — enable PostGIS in `extensions`, geographic points, GiST index and longitude/latitude order.
- [Prisma ORM 7 raw SQL guidance](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries) — unsupported spatial fields require casting/parameterized raw SQL; ordinary CRUD stays typed.
- [Prisma ORM 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) — ESM, CLI config, PostgreSQL driver adapter and connection setup.
- [Supabase Storage signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl) — clients upload to a time-limited signed URL without receiving the service role key.
- [PostgreSQL range/exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html) — use GiST range overlap exclusions and `btree_gist` for court equality.
- [Express 5 migration/requirements](https://expressjs.com/en/guide/migrating-5/) — Express 5 supports Node 18+.
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases) — check the current supported LTS patch before shared deployment.
