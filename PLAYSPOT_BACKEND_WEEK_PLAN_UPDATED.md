# PlaySpot PK — Backend/API Week Plan

**Project:** PlaySpot PK — Smart Sports Venue Booking and Player Matchmaking Platform  
**Backend:** Node.js + Express.js + TypeScript + PostgreSQL/PostGIS  
**Frontend:** Existing React Native app in `mustansar-dev/FYP_PlaySpot_React_Native_FE`  
**Deadline:** **11:59 pm, Saturday, November 14, 2026 (Pakistan time, Asia/Karachi)**  
**Planning window:** Tuesday, November 10 through Saturday, November 14, 2026  
**Status update:** Revised Thursday, November 12, 2026. The team reports that Codex Prompts 0, 1 and 2 are complete; the remaining work starts at booking/availability and payment implementation.  
**Team:** Ibrahim Sattar (BSSE23004), Mustansar (BSSE23027), Hasham (BSSE23053)

---

## 1. Project objective

Build a real, integrated backend/API for the completed PlaySpot React Native frontend. The backend must replace the frontend's mock/dummy data with persistent database records and real API responses. The completed application supports two main roles:

- **Player/User:** discover venues, filter by sport and location, view facilities and reviews, book courts, rent equipment, join or create games, contribute to split payments, chat, join tournaments, and view leaderboards.
- **Venue Provider/Vendor:** register and manage a provider profile, create venues and courts/playing grounds, define facilities and venue conditions, upload photographs/videos, publish equipment/add-ons, manage availability and bookings, add walk-in bookings, communicate with customers, and view booking/revenue/occupancy analytics.

This is a time-boxed academic project. Deliver a reliable, demonstrable end-to-end MVP rather than a broad collection of untested endpoints. Every frontend flow included in the final presentation must have a functioning API and persistent behavior, or be clearly labelled as a deliberately limited demo flow.

## 2. Deadline and delivery definition

The final deadline is **Saturday, November 14, 2026 at 11:59 pm PKT**. The team should aim to freeze feature work by 7:00 pm on November 14, leaving the remaining time for integration, smoke tests, bug fixes, deployment checks and submission.

“Complete” means:

1. The backend starts from a clean clone using the documented commands.
2. Database migrations and seed scripts work against the shared development database.
3. The React Native app can authenticate and use the backend base URL without relying on mock data for the main flows.
4. Authorization is enforced on the server, not only by hiding frontend buttons.
5. Booking availability prevents overlapping confirmed/held bookings, including vendor-entered walk-ins.
6. Payment states are set from verified server-side provider/webhook results, never solely from a client redirect.
7. At least one complete happy-path test exists for every major feature group.
8. Secrets, real customer credentials and payment credentials are not committed.
9. The backend repository has **one and only one README file: the root `README.md`**. All setup, architecture, API contract, schema overview, commands, integration notes and team workflow belong in that root file. Do not create nested README files or separate documentation Markdown files inside the backend repository.

## 3. Decisions and recommended technology stack

### 3.1 Backend framework

| Area | Decision | Reason |
|---|---|---|
| Runtime | Node.js 22 LTS or the compatible LTS already used by the project | Stable ecosystem and compatibility. Do not upgrade an existing toolchain without a concrete reason. |
| Language | TypeScript | Shared contracts, safer refactoring across three developers, clearer request/response types. |
| HTTP framework | Express 5 (or the compatible Express version already present) | Familiar REST API framework; keep the codebase simple and modular. |
| Database | PostgreSQL | Relational integrity, transactions, constraints and robust querying suit booking/payment data. |
| Spatial database | PostGIS extension | Efficient radius and nearest-venue searches using geographic coordinates and spatial indexes. |
| ORM | Prisma | Productive typed CRUD, schema and migrations. Use parameterized `$queryRaw`/`$executeRaw` for PostGIS operations because Prisma does not natively model PostGIS geometry/geography fields. |
| Validation | Zod | Validate request bodies, query parameters and environment variables at the boundary. |
| Authentication | JWT access token + rotating refresh token; bcrypt/bcryptjs password hashing | Works with a React Native client. Keep refresh tokens hashed in the database and revoke/rotate them. |
| Realtime | Socket.IO for authenticated chat events, backed by persisted messages | Chat needs server-mediated realtime delivery; REST remains the source of truth and fallback. |
| File storage | Supabase Storage using server-issued signed upload URLs | Keep large photos/videos outside PostgreSQL; store paths/metadata in database. |
| API contract | REST JSON under `/api/v1`; document the contract in root README and expose Swagger/OpenAPI only if time permits | Easy to consume from React Native. |
| Tests | Jest or Vitest + Supertest, depending on the starter setup | Exercise routes and business rules without a mobile UI. |

**Important Prisma/PostGIS caveat:** Prisma's official documentation says it does not directly support PostGIS geographic types. The schema can declare the column as `Unsupported("geography(Point,4326)")`, but reads/writes involving that field must use carefully parameterized raw SQL. Keep ordinary venue CRUD in Prisma and isolate all spatial SQL in one location repository/service. Do not interpolate user-provided SQL strings. See the Prisma note in the references section.

### 3.2 Database hosting: Supabase Free PostgreSQL + PostGIS

**Recommendation:** Use a Supabase Free project as the shared development database, with PostGIS enabled. Use a local PostgreSQL/PostGIS Docker container as the optional local fallback if anyone cannot access the shared instance.

Why:

- Supabase provides a normal PostgreSQL connection, so Express + Prisma can connect to it.
- PostGIS can be enabled from the Supabase Dashboard under Database → Extensions. Install it in the `extensions` schema, not `public`, as the current Supabase guide recommends.
- The current published Free plan includes a 500 MB database, 1 GB file storage and 5 GB egress. This is adequate for a small academic MVP if test media are compressed and usage is controlled.
- Important limitation: Free projects can pause after seven days of low activity. The owner must monitor the project and reactivate it before the presentation if needed. Free plan does not provide production-grade backups/SLA.

**Database rules:**

- Use one shared development database/project for integration. Each developer uses their own local `.env` and never commits secrets.
- Store monetary amounts as integer minor units (PKR paisa), not floating-point values. Use a consistent currency field (`PKR`).
- Store timestamps as UTC `timestamptz`; format local time at the frontend boundary.
- Use UUID primary keys, foreign keys, unique constraints, check constraints and indexes.
- Put a GIST index on venue location. Use `ST_DWithin` to filter a radius and sort by `ST_Distance` for nearby venues.
- Use transactions for booking creation, payment allocation, room membership and other multi-record workflows.
- The schema/migration owner is the only person who edits Prisma schema and creates/edits migrations during the short delivery window. Other developers submit schema-change requests through their PRs to avoid migration collisions.

### 3.3 Location/maps: MapLibre + OpenFreeMap + Geoapify

A map renderer, map tile source and geocoding/routing API are different things; do not treat them as one service.

| Layer | Recommended choice | Use in PlaySpot | Cost/limits and caveats |
|---|---|---|---|
| React Native map renderer | `@maplibre/maplibre-react-native` **only if compatible with the existing frontend's React Native version/new architecture** | Native interactive map, camera, markers and user-location view | Open-source. Current v11 docs require React Native 0.80+ and New Architecture; it is not supported in Expo Go. Inspect the existing frontend before adding it. Do not force a risky RN upgrade during this deadline. |
| Basemap/style/tile service | OpenFreeMap public style (OpenStreetMap-derived) | Display Lahore/Pakistan roads and map background | Public service is advertised as free with no API key or request/view cap. It is community-operated; do not promise an SLA. Use attribution, cache responsibly, and make style URL configurable so the provider can be changed. |
| Geocoding + routing | Geoapify | Convert vendor-entered addresses to coordinates, search addresses, optionally fetch directions/route data | Current Free plan: 3,000 credits/day, no card required, up to 5 requests/second. Pricing page says free plan has limited commercial use; acceptable for an academic demo subject to terms, quota and attribution. Proxy key-bearing calls through Express if practical; do not place a secret API key in a committed source file. |
| Nearby venue search | Our own PostGIS query | Return venues within a selected distance of the player's coordinates | No third-party nearby search is needed. PostGIS is the authoritative distance/filter source for our own venues. |

**Implementation approach:**

1. A vendor submits an address and a map pin (latitude/longitude). Geocode only when necessary; do not geocode every venue on every request.
2. Persist the canonical venue point in PostGIS `geography(Point,4326)` and expose numeric `latitude`/`longitude` to the frontend DTO.
3. The app sends `lat`, `lng`, `radiusKm`, sport and other filters to `GET /api/v1/venues/nearby`.
4. Express validates coordinates and invokes a parameterized PostGIS `ST_DWithin` query; results include distance in metres/kilometres and are sorted nearest-first.
5. The map displays returned venues as markers. Search by text/address and routing can use Geoapify behind backend endpoints.
6. Always display the correct map/data attribution required by OpenFreeMap/its style and Geoapify.

**Do not use the public `tile.openstreetmap.org` raster endpoint as an unrestricted production tile CDN.** Its published policy warns that the tile servers are capacity-limited, have no SLA and can block harmful usage; use an OSM-derived provider instead. Do not bulk-download tiles.

### 3.4 Checkout and payment design: three methods, Safepay Sandbox for online demo

The checkout should offer the same three broad payment choices shown in the Poncho reference screenshots, without copying its brand assets, bank details, transaction data or proprietary screen content:

1. **Pay 100% Online** — redirect/open the provider-hosted checkout. For the academic build, use **Safepay Sandbox** as the default online provider because its free, no-real-money test environment and test payment instruments are publicly documented. A sandbox transaction is only a test; it cannot collect real funds.
2. **Pay at Court / Pay at Venue** — reserve the selected slot under the venue's booking policy, but store payment as due/uncollected. The venue owner or authorized manager must explicitly mark cash as received at the venue. Choosing this method must never auto-mark payment as paid.
3. **Bank Transfer** — show bank-transfer instructions configured by the relevant venue/vendor, allow the customer to submit a transfer receipt, and place the payment in `PENDING_VERIFICATION`. Only the owning vendor/authorized manager (or an administrator if that role exists in the inspected app) may approve or reject it. An uploaded receipt is not proof that money has arrived.

#### Provider comparison and decision

| Criterion | Safepay Sandbox | Swich (likely `swichnow.io`, based on the screenshot's “Swich” brand) |
|---|---|---|
| What it is | Payment provider with separate sandbox and production accounts | Pakistan-focused merchant payment and payout platform branded Swich by Numbers Private Limited |
| Free development test | Officially documented as free; sandbox transactions have no financial impact and test cards/payment instruments can simulate transactions | Swich's public content references sandbox testing, but the accessible public API-documentation landing page does not expose enough detail to confirm self-service sandbox signup, test credentials or a no-cost student sandbox. Obtain written confirmation before relying on it |
| Real-money requirements | Production account, onboarding/KYC and approval are required. Safepay's onboarding guide asks for business information, contact details, ownership/management CNICs, receiving bank details and relevant business documents; its guide says document preparation can take 1–2 weeks | Merchant KYC/KYB is required. Its terms specify valid CNIC/NICOP for individuals, NTN/STRN and business registration documents for entities, and a Pakistani bank account. Merchant fees are set in the Merchant Service Agreement/merchant portal; standard settlement terms are typically T+2 business days and may include reserves/holds |
| Payment breadth | Use only the methods exposed to the sandbox account and documented test instruments; do not promise local wallets unless the chosen account explicitly enables them | Its public product page advertises JazzCash, Easypaisa, debit/credit cards, 1LINK bank transfer and Raast QR through one gateway |
| Integration evidence | Public sandbox signup, API docs and test payment instructions are available | Public API documentation and integration guide are linked, but detailed API schema and sandbox access must be obtained directly from Swich |
| Fit for this deadline/no-budget project | **Selected for the online demo**: no live funds and no merchant settlement needed for the class demo | **Not selected for implementation now**: written sandbox access, eligibility, platform approval and fees are not established for this team |

**Decision:** implement Safepay Sandbox for the online checkout path, plus the two manual methods. Do not wait for or assume Swich access. Keep an adapter boundary so a Swich provider can be added later if the team obtains official sandbox credentials, integration docs, written student eligibility and a fee/onboarding answer. Do not integrate a different company/product called **SwichPay** by mistake: SwichPay (`swichpay.com`) is a separate brand/company from Swich (`swichnow.io`). The screenshot alone identifies only the display name “Swich”; it does not conclusively prove which legal provider contract Poncho has.

#### What the Swich phone-number step means (and does not mean)

The supplied Poncho screenshot shows Swich checkout asking the **customer** to add a WhatsApp/mobile number with country code `+92`. This is a customer-facing information/verification step in that checkout flow. It is separate from merchant onboarding. The screenshot does not reveal whether Swich uses the number for OTP, WhatsApp account matching, payment authorization, fraud checks or notifications; do not invent the precise mechanism. It does **not** prove that the merchant can accept payments without KYC, that the gateway is free, or that PlaySpot can obtain a sandbox account without approval. For PlaySpot, store a normalized customer phone as contact data only unless a real OTP provider confirms verification; never display an unverified number as verified and never fabricate an OTP success.

#### Safepay Sandbox setup facts

- Sandbox and production are separate accounts/environments. The public Safepay signup page describes a sandbox account as nearly identical to production but with no real money and lists testing checkout, refunds and Quick Links.
- The Safepay getting-started guide states that sandbox test cards can simulate transactions and that sandbox transactions do not move customer funds or pay the merchant.
- The signup page asks users to contact Safepay support after account creation to begin onboarding. Confirm access and obtain the API public/secret keys and webhook secret from the actual sandbox dashboard before implementation; never invent credentials.
- Live/production use is different: Safepay says it must collect merchant information for SBP/financial-partner requirements. Its onboarding page documents business details, customer support contact, address, business type, ownership/management information, bank account and document uploads; it notes 1–2 weeks may be needed to prepare documents. No one should assume live approval before it is issued.

#### Payment domain model and state rules

Use separate booking state and payment state. A booking can hold a court slot while its selected payment method is still unpaid or under review, subject to an explicit reservation expiry/policy.

Recommended `PaymentMethod` values (align exact names with the frontend's real enums discovered in Prompts 0–2):

- `ONLINE` — gateway checkout; provider is `SAFEPAY` in this academic build.
- `PAY_AT_VENUE` — cash/physical payment to be collected by the venue.
- `BANK_TRANSFER` — manual transfer to the venue/vendor account, followed by receipt submission and review.

Recommended payment statuses (adapt names to the existing schema, never create duplicate competing enums):

- Online: `PENDING` → `PROCESSING` → `PAID` or `FAILED`/`CANCELLED`/`EXPIRED`.
- Pay at venue: `DUE_AT_VENUE` → `PAID` when the authorized vendor records collection; optionally `OVERDUE`/`CANCELLED` according to policy.
- Bank transfer: `AWAITING_TRANSFER` → `PROOF_SUBMITTED` → `PAID` after vendor verification, or `REJECTED` with a reason and resubmission path.

Suggested persistent data:

- `Payment`: booking/contribution, payer, method, provider, amount in integer paisa, currency `PKR`, status, timestamps, idempotency key and safe provider references.
- `PaymentReceipt` or `PaymentProof`: payment ID, private storage object path, MIME type, size, submitted time, reviewer, decision, decision time and rejection reason. Do not store raw image/PDF bytes in Postgres.
- `VendorPaymentInstructions`: vendor ID, account title, bank name, IBAN/account number, instructions and active flag. Expose only fields needed to pay; do not hard-code the competitor's account. Confirm the venue's actual intended receiving account before a real transfer feature is used.
- `PaymentStatusAudit` (or equivalent audit fields/events): actor, previous/new status, reason and timestamp for cash collection/manual bank proof review.
- `WebhookEvent`: provider event ID unique where available, verified signature outcome, safe payload metadata, processed state and timestamp; never persist card data or secrets.

**Bank-transfer proof controls:** accept only a small allowlist such as PDF/JPEG/PNG; enforce strict size limits (for example 5 MB), inspect actual file type rather than trusting extension, store in a private bucket and serve with short-lived signed URLs. Only the payer and authorized vendor/administrator may access the receipt. A receipt screenshot is evidence submitted by the user, not authoritative settlement confirmation.

**Pay-at-venue controls:** only the vendor/manager owning the venue may mark the payment collected. Record who marked it, when and how much. Vendor walk-in booking payments should use the same payment states/audit path. Prevent the player from changing their own status to paid.

**Online provider interface:** isolate gateway code under `src/integrations/payments/` behind functions such as `createCheckout`, `verifyWebhook` and `getPaymentStatus`. Implement Safepay Sandbox first. The mobile client receives only the hosted checkout URL and safe references; provider secrets stay on the server. Verify the correct Safepay product's webhook signature from the raw request body using its current official instructions; do not reuse the separate Raastwire signature algorithm for standard checkout. A return/deep link is only a navigation signal, never proof of payment. Webhook/status reconciliation must be idempotent.

**Swich future adapter:** do not guess its endpoint paths, authentication scheme, webhook signature, callback payload or sandbox base URL. Add a provider implementation only after the team receives the exact official developer docs, sandbox account/keys, test-mode instructions, fees, supported channels and written confirmation of student/project onboarding. If these are not available before the deadline, leave Swich as a documented future provider choice and demonstrate Safepay Sandbox instead.

#### Split payments

- Treat split payment as a PlaySpot application ledger, not escrow or automatic marketplace settlement. Each booking may have multiple participant contributions. Each contribution can use one of the three supported methods if the frontend supports per-person selection.
- `PAID` totals include only verified online webhook/status confirmations, vendor-confirmed cash collection or vendor-approved bank-transfer proofs.
- Pending bank receipts and `DUE_AT_VENUE` cash must not count as collected revenue.
- Use a transaction/locking strategy so concurrent contributions cannot exceed the amount due. Do not mark the whole booking fully paid until all required contributions reach the total in verified states.
- Do not send payouts or hold third-party funds on behalf of multiple independent vendors under an unapproved student merchant account. A real marketplace collection/split/payout model needs provider approval, vendor KYC and an agreed settlement structure.

**No-budget recommendation:** Safepay Sandbox is the only online method selected for the class demo because the free test environment is documented and does not move real money. The two manual methods are application workflows, not gateways; they need no payment processor API but do require correct vendor payment instructions and manual reconciliation. There is no claim that real live online processing is free.

### 3.5 Media storage

Use Supabase Storage for venue/court photos, optional videos and profile images if a shared bucket is available. The Express backend authenticates the vendor, checks ownership, creates an allowlisted storage path and returns a signed upload URL. Save the resulting object path, media type, size and URL/reference in PostgreSQL. Never expose the Supabase `service_role` key to the mobile app. Apply file-size/type limits and use public read only for public venue media; private chat media should use signed read URLs.

---

## 4. Architecture and code organization

Use a modular monolith. Do not create microservices for this academic deadline.

```text
playspot-backend/
├── README.md                    # The only README in the backend repository
├── package.json
├── tsconfig.json
├── .env.example                 # Names/placeholders only; no real secrets
├── .gitignore
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── src/
│   ├── app.ts                   # Express app composition
│   ├── server.ts                # HTTP + Socket.IO startup/shutdown
│   ├── config/                  # env validation, constants
│   ├── common/                  # errors, response helpers, pagination, types
│   ├── middleware/              # auth, role guard, validation, rate limit, errors
│   ├── database/                # Prisma client, transactions, spatial query wrapper
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── vendors/
│   │   ├── venues/
│   │   ├── courts/
│   │   ├── equipment/
│   │   ├── availability/
│   │   ├── bookings/
│   │   ├── reviews/
│   │   ├── payments/
│   │   ├── rooms/
│   │   ├── chat/
│   │   ├── tournaments/
│   │   ├── leaderboards/
│   │   ├── analytics/
│   │   ├── media/
│   │   └── notifications/
│   ├── integrations/
│   │   ├── maps/                 # Geoapify client/provider adapter
│   │   ├── payments/             # PaymentGateway + Safepay adapter
│   │   └── storage/              # Supabase Storage adapter
│   ├── realtime/                 # Socket.IO auth, rooms, events
│   └── routes/                   # `/api/v1` router composition
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

Each feature module should separate `routes`, `controller`, `service`, `repository` (where needed), `schemas` and `types`. Avoid one giant controller, duplicated business logic, circular imports and routes that directly issue database queries.

### Request lifecycle

`React Native → Express route → validation middleware (Zod) → authentication/role middleware → controller → service/business rules → Prisma/repository → PostgreSQL/PostGIS → consistent JSON response`

Use `src/integrations` for external providers; never call Safepay, Geoapify or Storage directly from controllers.

## 5. Database design — entity inventory

The final schema must be designed **after inspecting the real frontend routes/screens/forms/types/API calls**. The following is the expected baseline, not permission to blindly create every possible field. Map each selected table/relationship to a real frontend feature and note any frontend gaps in the root README.

| Domain | Core tables/models | Key rules |
|---|---|---|
| Identity | `User`, `RefreshToken`, `VendorProfile` | Email/phone uniqueness as appropriate; hashed password; `PLAYER`/`VENDOR` roles; vendor account status. One user may have one primary role for MVP unless frontend explicitly supports multiple roles. |
| Sports/catalog | `Sport`, `Amenity` | Controlled reference data; seed football, cricket, badminton, padel, basketball, table tennis, etc. |
| Venue | `Venue`, `VenueMedia`, `VenueAmenity`, `Court`, `CourtMedia`, `OperatingHour` | Vendor ownership; address; city/area; point; dimensions; surface type (real grass/turf/wood/etc.); condition; photos/videos; capacity; opening hours; facilities/parking. |
| Equipment/add-ons | `EquipmentItem` (or `VenueAddon`) | Belongs to venue; price, rental/sale type, stock/quantity, active status. Booking item snapshots price and quantity at purchase time. |
| Availability | `AvailabilityRule` or `OperatingHour`, optional `BlockedSlot` | Slots are calculated from court hours and booking/blocked records. Time zone policy must be explicit. |
| Booking | `Booking`, `BookingItem`, optional `BookingParticipant` | APP and WALK_IN sources; court; start/end; status; amount snapshot; creator; optional walk-in customer name/phone; equipment lines. |
| Reviews | `Review`, optional `ReviewMedia` | Only a completed/eligible booking can be reviewed; unique review per booking/player; compute aggregate rating from reviews. |
| Game rooms | `GameRoom`, `GameRoomMember` | Public/private, invite code, sport/venue/time, capacity, creator, membership status. Do not expose private rooms in public queries. |
| Chat | `Conversation`, `ConversationMember`, `Message` | Persist messages; verify sender is a member before read/write/socket join. |
| Tournaments | `Tournament`, `TournamentParticipant`, optional `TournamentMatch` | Host/vendor, sport, venue, dates, capacity/status; basic participant list and simple leaderboard/ranking. |
| Payments | `Payment`, `PaymentContribution`/`PaymentAllocation`, `PaymentReceipt`/`PaymentProof`, `VendorPaymentInstructions`, `PaymentStatusAudit`, `WebhookEvent`, optional `Refund` | Three methods (`ONLINE`, `PAY_AT_VENUE`, `BANK_TRANSFER`); online provider/webhook reference; private receipt metadata; vendor-owned bank instructions; audit trail; PKR integer paisa; idempotency; split totals count only verified/approved/collected amounts. |
| Media | `MediaAsset` (optional; otherwise media columns in owning tables) | Database stores metadata/path, not binary file content. |
| Notifications | `Notification` | In-app notification records for booking/payment/room/chat events if frontend requires them. |

### Essential relational constraints

- Every venue belongs to a vendor profile/user; vendors can only edit their own venue, courts, equipment, bookings and analytics.
- Every court belongs to one venue and has a sport or supported sport relation.
- `VenueAmenity` must be unique on `(venueId, amenityId)`.
- A booking belongs to one user (or a guest/walk-in contact) and one court; booking items are separate child records.
- Walk-in bookings must use the **same court/date/time availability and collision rules** as app bookings. Do not create a separate manual-booking calendar.
- Prevent overlapping active bookings for the same court. Prefer a database exclusion constraint on `(court_id, tstzrange(starts_at, ends_at, '[)'))` for statuses that hold/occupy a slot, using Postgres `btree_gist` as needed. If compatibility prevents that approach, use transaction isolation/locking and prove the race-condition behavior with an integration test. A simple preflight query without a transaction is insufficient.
- `Review` uniqueness should prevent duplicate review for the same booking/user.
- `Payment.providerReference` and `WebhookEvent.providerEventId` should be unique where supplied. `PaymentReceipt` must reference exactly one payment; receipt object paths are private. `VendorPaymentInstructions` must be owned by one vendor and only active instructions are exposed. Manual status transitions must write an audit event.
- `GameRoomMember` unique on `(roomId, userId)`.
- Persist UTC time instants; venue timezone should be `Asia/Karachi` initially unless a venue explicitly has another timezone.

## 6. API contract baseline

The actual final contract must be checked against the frontend source. Use `/api/v1` and REST naming. All endpoints should return consistent JSON and standard HTTP status codes. Use pagination for collection routes.

| Group | Expected endpoints | Authorization |
|---|---|---|
| Health | `GET /health`, `GET /api/v1/health` | Public |
| Auth | `POST /auth/register/player`, `POST /auth/register/vendor`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | Public/authenticated as appropriate |
| User | `GET /users/me`, `PATCH /users/me`, profile/avatar endpoints | Authenticated user |
| Vendor | `GET/PATCH /vendors/me`, onboarding/status endpoints | Vendor |
| Venue discovery | `GET /venues`, `GET /venues/:venueId`, `GET /venues/nearby`, `GET /venues/:venueId/reviews`, `GET /venues/:venueId/courts` | Public/read; sensitive details protected |
| Venue management | `POST /venues`, `PATCH /venues/:venueId`, `DELETE /venues/:venueId` (soft-delete preferred), venue media and amenities endpoints | Owning vendor |
| Courts/facilities | `POST/PATCH/DELETE /venues/:venueId/courts`, operating hours, blocked periods, facilities | Owning vendor |
| Equipment | `GET /venues/:venueId/equipment`, vendor CRUD for equipment/add-ons | Public read; owning vendor writes |
| Availability | `GET /courts/:courtId/availability?date=...` | Public/read; details may require auth |
| Bookings | `POST /bookings`, `GET /bookings/me`, `GET /bookings/:id`, `POST /bookings/:id/cancel` | Player/owner rules |
| Vendor booking manager | `GET /vendors/me/bookings`, `POST /vendors/me/bookings/walk-in`, status/update endpoints | Owning vendor |
| Reviews | `POST /bookings/:bookingId/review`, `PATCH/DELETE /reviews/:reviewId` (within policy) | Eligible booking owner |
| Rooms | create/list/get room, join/leave, invite/private join endpoints | Authenticated; room-specific authorization |
| Chat | list conversations/messages, send message; Socket.IO events | Conversation member |
| Tournaments | create/list/get, join/leave, participants, matches/results | Authenticated; host controls write actions |
| Leaderboard | `GET /leaderboards?scope=...` | Public or authenticated based on frontend |
| Payments | initiate online checkout, get payment status, select pay-at-venue, get vendor transfer instructions, submit receipt, vendor pending-transfer list, approve/reject receipt, mark venue cash collected, provider webhook | Payer/booking participant; owning vendor for review/collection; webhook verified separately |
| Analytics | `GET /vendors/me/analytics?from=...&to=...` | Owning vendor |
| Media | signed upload URL, confirm asset, delete media | Authenticated + owner check |
| Notifications | list/read notification | Authenticated user |

### Consistent API response shape

Success:

```json
{
  "success": true,
  "data": {},
  "meta": { "page": 1, "limit": 20, "total": 0 }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "details": []
  }
}
```

Do not leak stack traces, SQL errors, secrets, hashed passwords or provider credentials in API responses.

## 7. Business rules that must be enforced in the backend

### Authentication and roles

- Hash passwords using bcrypt/bcryptjs with an appropriate work factor; never store plaintext passwords.
- Use short-lived access tokens and longer-lived refresh tokens. Store refresh-token hashes; rotate on refresh; revoke on logout; handle expiry/reuse defensively.
- Validate role and identity on every protected action. A player must not create/edit vendor venues or read another vendor's analytics. A vendor must not create a booking on a venue they do not own.
- Registration should validate normalized email/phone, required profile fields and password policy. Email/phone OTP can be a development-only code if no SMTP/SMS credentials are available; do not pretend it was delivered by a real provider.
- Never store tokens/passwords in logs.

### Venue and location

- Only active/approved venues are public.
- Validate latitude `[-90, 90]`, longitude `[-180, 180]`, positive dimensions, supported sport, price and capacity.
- Venue list endpoints must filter safely by sport, city, facilities, rating and distance.
- Distance filtering must happen in PostGIS, not by downloading all venues into Node.js and calculating distance in a loop.

### Booking and walk-in bookings

- Compute final totals server-side from current court price, duration, add-ons/equipment and discounts. Ignore client-submitted total amounts.
- Use a transaction and unique/exclusion/locking strategy to stop double booking.
- Booking status example: `PENDING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `EXPIRED`; define exact transitions once in code.
- A pending unpaid hold expires after a documented short period; a scheduled cleanup can be a simple endpoint/periodic job only if the deployment supports it. Without a scheduler, expire stale holds during availability/booking operations.
- Walk-in booking records `source = WALK_IN`, creator vendor/manager, optional customer contact, amount/payment method/status and the same court/time range as all other bookings.

### Payments and split contributions

- Use a provider abstraction, e.g. `createCheckout`, `verifyWebhook`, `getPaymentStatus`, `refund` (only if provider flow is approved).
- Use idempotency keys for payment initiation and webhook event processing.
- Store all provider raw event payloads safely after stripping/securing sensitive values; store event ID and processing result for deduplication.
- Verify Safepay HMAC webhook signatures using the exact documented signature procedure and raw request bytes. Follow the latest official Safepay docs, not an unverified blog/sample.
- A return URL is only a user experience signal. Confirm online payment through webhook/server-side status check. Pay-at-venue and bank-transfer receipts use their own vendor-confirmed manual state transitions; neither can be self-confirmed by the player.
- Participant contributions cannot overpay the booking total; use a database transaction/locking to prevent concurrent over-allocation. The sum of verified contributions controls paid amount/status.
- Do not expose any secret API key to the React Native bundle.

### Reviews, chat and rooms

- Only users who completed/are eligible for a venue booking may review that venue, unless the existing frontend explicitly models a different policy.
- Average rating and count must be derived from persisted reviews; don't hard-code a rating.
- Socket.IO connections must authenticate via access token. Joining a conversation room requires checking membership in the database. Persist a message before broadcasting it.
- For private rooms, validate invite code/access; capacity cannot be exceeded in concurrent joins.

### Vendor analytics

- Report counts/revenue/occupancy from database records for a date range; do not simply return static chart values.
- Define metric semantics: bookings counted by start time or created time; revenue counted only from verified paid transactions; occupancy = booked court minutes / available court minutes in range, excluding closed/blocked periods consistently.
- Use PKR minor units internally and format for the frontend.

## 8. Four-day implementation and integration schedule

### Day 1 — Tuesday, November 10: frontend discovery, API contract, database schema and backend skeleton

**Owner:** Ibrahim leads the foundation; Mustansar and Hasham review the frontend mapping and schema from their own local clones.

1. Clone/open the exact frontend repository locally and inspect the actual project before designing endpoints. Read package manifest, navigation trees, every relevant screen/form, existing types/interfaces, API service utilities, mock/dummy data, Redux/context stores and navigation params. Search for all use cases in the frontend.
2. Create a screen-to-API matrix in the root backend README: screen/flow, required fields, calls, response fields, role, errors/loading states and frontend gaps.
3. Agree on the database model and relationships using the entity inventory above, adapting it to actual frontend forms and routes. Identify which flows cannot be supported because the frontend does not currently collect a required field.
4. Create backend repository skeleton, TypeScript/Express app, environment validation, Prisma setup, Supabase PostgreSQL connection, PostGIS extension migration and initial schema migration.
5. Implement only a minimal health route and database connectivity check. Seed sports/amenities and development accounts only if safe and documented.
6. Write all onboarding/setup/architecture/endpoint/schema/team details into **root `README.md` only**.
7. Review schema and API naming with all three members and freeze the first database contract before parallel feature work.

**Day 1 acceptance:** clean install/start; `GET /health` responds; DB connection is verified; PostGIS extension and initial migration succeed; schema is committed; root README contains the real frontend mapping; no second README exists; no feature endpoint is falsely marked complete.

### Day 2 — Wednesday, November 11: authentication, vendor onboarding, venue/catalog APIs

- Implement player and vendor registration/login, refresh/logout/me, profile, role guards and ownership checks.
- Implement vendor onboarding/profile and venue CRUD; courts, dimensions, surface/condition, facilities/parking, opening hours, media metadata and equipment/add-ons.
- Wire signed media uploads if bucket credentials are ready; otherwise use a local/dev storage adapter only for development and keep interface stable.
- Add validation and integration tests for auth, registration uniqueness, vendor ownership and CRUD.
- Connect frontend authentication and core vendor onboarding/venue forms; remove the corresponding mocks.

**Day 2 acceptance:** player and vendor can register/login; tokens persist/refresh/logout; protected routes reject wrong roles; vendor can create/update/list own venue and courts; public venue list is sourced from DB.

### Remaining work — Thursday evening, November 12 through Saturday, November 14

**Reported complete by team:** Codex Prompts 0, 1 and 2 (frontend audit/API contract/schema/skeleton, authentication, vendor and venue foundation). Each new Codex session must still verify those deliverables exist on the checked-out branch; do not rerun or overwrite completed work merely because the session lacks context.

#### Thursday, November 12 evening: finish booking integrity first

- Complete court availability, slot booking, server-calculated price snapshots and concurrent conflict prevention.
- Complete vendor walk-in booking using the same court/time collision rules as app bookings.
- Connect booking history/detail/cancellation and reviews as time permits; verify the already-built maps/nearby APIs if their actual implementation exists.
- Confirm payment-related database structures from Prompt 0 support three methods; request a schema-owner migration only if they do not.

**Tonight's acceptance:** two overlapping app/walk-in booking attempts cannot both succeed; the frontend can create and view a booking; booking state and payment state are separate.

#### Friday, November 13: implement all three checkout methods and split contribution ledger

- Implement Safepay Sandbox hosted checkout only if valid sandbox keys/docs are available; otherwise leave external gateway disabled and demonstrate the clearly labelled development mock only for demo/testing.
- Implement `PAY_AT_VENUE` with vendor-confirmed cash collection and audit trail.
- Implement `BANK_TRANSFER` with venue-specific instructions, private receipt upload and vendor approval/rejection flow.
- Implement payment totals/discount breakdown only to the extent required by the existing frontend; never trust client-supplied amount/discount.
- Implement split contribution ledger so verified online payments, confirmed cash and approved bank transfers are accounted correctly.
- Parallelize rooms/chat, tournament/leaderboard and vendor analytics; integrate the frontend checkout and status views.

**Friday acceptance:** all three methods have distinct, tested state transitions; unverified receipt and uncollected cash do not count as revenue; gateway redirect alone does not mark online payment paid.

#### Saturday, November 14: freeze, integration, QA, release and submission

**Morning:** freeze new feature scope; integrate only reviewed PRs; apply migrations/seed from a clean clone; check Android emulator and physical-device API URLs.

**Afternoon:** execute player/vendor end-to-end tests, including all three checkout choices, provider cash collection, bank proof review, sandbox webhook/status reconciliation (if credentials exist), split contributions, walk-ins, rooms/chat and tournaments. Test authorization, invalid payloads, duplicate webhooks, double bookings and receipt access controls. Update the single root README with actual test outcomes and provider limitations.

**Target feature freeze:** 6:00 pm PKT. **Hard deadline:** 11:59 pm PKT. Reserve at least the final 2–3 hours for regression and submission rather than new features.

## 9. Team responsibilities and branch model

### Responsibility split

| Member | Primary ownership | Required outputs |
|---|---|---|
| **Ibrahim Sattar (BSSE23004)** | Backend lead, frontend contract/schema owner, DB migrations, auth/users, booking/availability/walk-in integration, final integration/release | Day 1 canonical schema/migrations and root README; auth + booking services; migration conflict resolution; release checklist. |
| **Mustansar (BSSE23027)** | Vendor profile, venue/court/facility/equipment APIs, media upload, map/geospatial venue discovery, reviews | Vendor/venue module, ownership tests, Geoapify/PostGIS integration tests, review module. |
| **Hasham (BSSE23053)** | Payment integration/Safepay, split contribution ledger, chat/Socket.IO, game rooms, tournaments/leaderboards, analytics | Provider adapter + webhook tests, contribution module, realtime/community modules, vendor analytics tests. |

This is ownership, not a reason to code incompatible interfaces. All members must read the canonical root README and current merged `develop` branch before starting a task. The schema owner coordinates required changes.

### Branch model

```text
main       = submission/release only; no direct pushes
 develop   = integration branch; PR target for all feature work
feature/backend-foundation       = Day 1 schema/architecture (Ibrahim)
feature/auth-booking              = auth + booking modules (Ibrahim, after foundation merge)
feature/vendor-venue-maps         = vendor/venue/media/maps/reviews (Mustansar)
feature/payments-community        = payment/chat/rooms/tournaments/analytics (Hasham)
```

Use the actual repository's branch names if it already has a defined strategy; do not recreate a branch blindly. Before work: `git status`, `git fetch origin`, checkout the assigned feature branch, pull/rebase from latest `develop`. Commit only scoped work. Open a PR to `develop`, not directly to `main`. Only release lead merges `develop` into `main` after QA.

### Collaboration rules for separate Codex sessions and different computers/accounts

- Codex cannot rely on this conversation or another developer's session. Treat committed `README.md`, `prisma/schema.prisma`, migrations and merged source code as the only shared project truth.
- Every task prompt must instruct Codex to inspect the current working tree and root README first, then run `git status` and check the active branch.
- Do not assume another developer's unmerged local work exists. Never import, overwrite or regenerate their files from memory.
- Work only inside the assigned feature/module. Do not reset, force push, delete unrecognized files or rewrite unrelated modules.
- Use stable endpoint names, DTOs and enums from root README. If a contract is missing, pause that feature and request an explicit decision in the PR rather than inventing a different contract.
- Only Ibrahim (schema owner) edits `prisma/schema.prisma` and `prisma/migrations` during the time-boxed project. Other developers propose schema changes in their PR description; once approved, the owner merges them and updates the README contract. If the team deliberately reassigns ownership, record that decision in root README first.
- Never run destructive migrations, `prisma migrate reset`, `db push --force-reset`, truncate or delete shared data on the shared Supabase instance. Use local test database for destructive testing.
- Each feature PR includes tests, changed file list, migration requirement (yes/no), environment variable names, frontend integration notes and any known limitations.
- No secrets in Git, commits, screenshots or logs. Each person creates their own `.env` from `.env.example`; credentials are shared only through a secure team-approved channel.

## 10. Environment variables

Keep `.env.example` in Git with placeholder values only. Expected names (Codex may adjust to the selected SDKs, then update root README):

```dotenv
NODE_ENV=development
PORT=4000
API_PREFIX=/api/v1
APP_ORIGINS=http://localhost:8081
DATABASE_URL=
DIRECT_URL=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=venue-media
GEOAPIFY_API_KEY=
PAYMENT_PROVIDER=safepay
PAYMENT_ENV=sandbox
SAFEPAY_ENV=sandbox
SAFEPAY_SECRET_KEY=
SAFEPAY_API_KEY=
SAFEPAY_WEBHOOK_SECRET=
SAFEPAY_RETURN_URL=
SAFEPAY_CANCEL_URL=
PAYMENT_RECEIPTS_BUCKET=payment-receipts
# Do not add SWICH_* variables until official Swich docs and issued credentials are available.
```

Only keep `DIRECT_URL` if required by Prisma/Supabase connection mode. Do not invent valid secrets. Document which keys are optional for local-only work and which features stay disabled without them. Add `SOCKET_CORS_ORIGINS` only if Socket.IO requires a separate allowed-origin setting.

## 11. Security and reliability checklist

- HTTPS in any shared deployment; strict CORS allowlist; Helmet; request body size limits; safe error handler; rate limit login/OTP/payment-initiation endpoints.
- Zod validation for body, params and query; normalize email/phone; parameterized database queries.
- Password hashes only; JWT secrets from environment; refresh token rotation/revocation; role + ownership authorization.
- Do not expose Supabase service key, Safepay secret, Geoapify server key, provider webhook secret or database URL to the frontend.
- Verify webhooks with raw bytes/signature; deduplicate event IDs; acknowledge only after safe persistence/processing rules.
- Idempotency for booking creation/payment initiation where retry could duplicate an operation.
- Database transactions for slot booking, contribution totals, room capacity and multi-row workflows.
- Logs must avoid passwords, tokens, full card/payment credentials, private messages and personal identifiers not needed for debugging.
- Avoid trusting client prices, ratings, vendor IDs, role claims or payment success flags.
- Add indexes for common joins/filtering, including venue status/city/sport and PostGIS location.

## 12. Testing and final acceptance checklist

### Backend baseline

- [ ] Clean clone installs with documented Node/package manager versions.
- [ ] `.env.example` covers all required config; missing required env causes a clear startup error.
- [ ] Prisma migrations apply in order; PostGIS extension and spatial index exist.
- [ ] `GET /health` and database health check succeed.
- [ ] One root `README.md` only.

### Auth / role permissions

- [ ] Register player, register vendor, login, refresh, logout, me.
- [ ] Duplicate account and invalid credentials fail safely.
- [ ] Expired/revoked refresh token cannot be reused.
- [ ] Player cannot access vendor route; vendor A cannot mutate vendor B's venue.

### Venues and maps

- [ ] Vendor can create venue, courts, operating hours, facilities, surface/dimensions, photos and add-ons.
- [ ] Public listing filters correctly; nearby uses PostGIS and correct lat/lng order.
- [ ] Map/geocoding provider keys are configured only where needed and attribution is visible.

### Booking and reviews

- [ ] Valid player booking creates a booking with server-calculated totals.
- [ ] Simultaneous requests for overlapping slots cannot both succeed.
- [ ] Walk-in booking blocks the same slot and conflicts with app bookings.
- [ ] Cancellation follows defined policy and frees slot correctly.
- [ ] Only eligible user can review; duplicate reviews rejected; aggregate updates.

### Payment and split payment

- [ ] Checkout displays `Pay 100% Online`, `Pay at Court/Venue`, and `Bank Transfer` when supported by the actual frontend contract.
- [ ] Safepay sandbox checkout/session can be created when keys are configured; secret never reaches frontend.
- [ ] Success/return redirect without verified webhook or provider status does not mark online payment paid.
- [ ] Valid webhook updates payment once; invalid signature rejected; duplicate event is idempotent.
- [ ] Pay-at-venue booking remains `DUE_AT_VENUE` until an authorized vendor/manager records collection with actor and timestamp.
- [ ] Bank transfer shows the correct vendor's configured instructions; receipt is stored privately; payment remains pending until authorized approval.
- [ ] Receipt file type/size and ownership checks are enforced; unauthorized users cannot access proof.
- [ ] Individual contributions cannot exceed amount due; only verified online, vendor-collected cash or approved transfers count as paid.
- [ ] README distinguishes sandbox/demo from live payments and clearly states whether any merchant onboarding was completed.

### Community and analytics

- [ ] Room membership and capacity rules work; private room is not discoverable publicly.
- [ ] Chat requires conversation membership, persists message and emits realtime event.
- [ ] Tournament participant/host rules and leaderboard calculation are deterministic.
- [ ] Vendor analytics return database-backed bookings, verified revenue and occupancy.

### Final integration

- [ ] React Native auth and all high-priority flows use configured API base URL, not stale mock services.
- [ ] Correct base URL works on Android emulator and physical device (if tested).
- [ ] Loading, empty, validation and server error states are handled.
- [ ] Demo data is seeded safely; no real secret/user data in repo.
- [ ] `npm test`, lint/typecheck and build/start commands pass (or documented known failures are honestly listed).
- [ ] Final PRs merged to `develop`; release merged to `main` only after acceptance.

## 13. Scope control — must-have vs defer

**Must-have before deadline:** auth/roles, vendor onboarding, venue/court/equipment CRUD, map coordinates/nearby search, availability and collision-safe app + walk-in bookings, reviews, all three checkout-method workflows (Safepay Sandbox if credentials are available; otherwise explicitly labelled development simulation for the online branch, plus real backend state handling for pay-at-venue and bank transfer), split contribution ledger, persistent chat/rooms if shown as working, tournament/leaderboard basics, vendor analytics, frontend integration and README.

**Defer unless everything above is stable:** multi-provider live payment, actual vendor payouts/escrow, production SMS/email OTP, push notifications, advanced tournament brackets, complex recurring scheduling, recommendations/AI, production moderation, video transcoding, offline maps, complex routing/ETA, distributed microservices, Kubernetes and event streaming.

A deferred feature must not appear as fully functional in the presentation. If a feature requires a third-party account, fee, approval, hardware permission, native rebuild or legal/compliance step, state that clearly in the root README and presentation notes. Pay at venue and bank transfer are manual reconciliation workflows, not online payment gateways. A user-uploaded bank receipt never proves settlement by itself.

## 14. Research references (official documentation / provider pages)

These links were checked while preparing this plan. Re-check provider terms, quotas and versions before production use because plans can change.

### Database and geospatial

- [Supabase Free plan pricing and quotas](https://supabase.com/pricing) — current Free plan database/storage/egress quotas and inactivity pause note.
- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) — low-activity pause behavior.
- [Supabase PostGIS extension guide](https://supabase.com/docs/guides/database/extensions/postgis) — enable PostGIS and use `extensions` schema; geography point and GIST index examples.
- [PostGIS: use ST_DWithin for radius queries](https://postgis.net/documentation/tips/st-dwithin/) — indexed distance/radius filtering recommendation.
- [Prisma: geographic data/PostGIS limitation](https://docs.prisma.io/docs/orm/prisma-client/using-raw-sql/safeql) — use `Unsupported` plus raw SQL for PostGIS fields.

### Maps

- [MapLibre React Native getting started](https://maplibre.org/maplibre-react-native/docs/setup/getting-started/) — React Native compatibility and native setup requirements.
- [MapLibre React Native Expo setup](https://maplibre.org/maplibre-react-native/docs/setup/expo/) — does not run in Expo Go; requires a development build/config plugin.
- [OpenFreeMap](https://openfreemap.org/) — public OSM-derived map styles advertised as free/no key.
- [Geoapify pricing](https://www.geoapify.com/pricing/) — free plan currently advertises 3,000 credits/day, no card, 5 req/s and limited commercial use.
- [Geoapify geocoding API](https://apidocs.geoapify.com/docs/geocoding/) — geocoding API and key requirement.
- [OpenStreetMap standard tile usage policy](https://operations.osmfoundation.org/policies/tiles/) — do not treat OSM standard tile server as unrestricted production map hosting.
- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) — public Nominatim max 1 request/second and usage restrictions; do not build bulk geocoding around it.

### Payments

- [Safepay signup and Sandbox description](https://safepay.pk/signup) — sandbox has no real money, supports test checkout/refund/Quick Links; production account requires KYC/onboarding.
- [Safepay getting started guide](https://safepay.helpscoutdocs.com/article/50-starting-with-safepay-step-by-step-guide) — separate sandbox/production accounts, test cards and sandbox transactions with no financial impact.
- [Safepay merchant onboarding form guide](https://safepay.helpscoutdocs.com/article/118-merchant-onboarding-form) — production business details, owner/manager CNIC, bank account and document requirements; guide notes document preparation may take 1–2 weeks.
- [Swich payment gateway](https://swichnow.io/products/payment-gateway) — its public page advertises local wallets, cards, 1LINK bank transfers and Raast QR.
- [Swich legal terms](https://swichnow.io/legal/terms-of-use) — operated under Numbers Private Limited; lists CNIC/NICOP or entity registration documentation, Pakistani bank account, KYC/KYB, MSA-defined fees and typical T+2 settlement subject to terms.
- [Swich API documentation landing page](https://swichnow.io/developers/api-documentation) and [integration guide](https://swichnow.io/developers/integration-guide) — obtain detailed API schema, test credentials and sandbox conditions directly before implementation.
- [Swich contact](https://swichnow.io/company/contact) — support details to ask about academic sandbox access and merchant requirements.
- [SwichPay](https://swichpay.com/) is a separate similarly named provider; do not assume its APIs, products or sandbox rules apply to Swich/SwichNow.
- [Safepay standard API reference](https://apidocs.getsafepay.com/) — standard API sandbox, test payment methods, merchant authentication and payment APIs.
- [Safepay official Pakistan website](https://safepay.com.pk/) and [Services Agreement](https://safepay.com.pk/legal/content/services-agreement) — provider/company and merchant terms.
- [Safepay Raastwire introduction](https://safepay.mintlify.app/overview/introduction) — Raast payment types, aggregator model and separate sandbox/production endpoints.
- [Safepay Raastwire aggregator access](https://safepay.mintlify.app/overview/create-aggregator) — access request, business details and compliance review required before aggregator credentials are issued.
- [Safepay Raastwire webhook signature verification](https://safepay.mintlify.app/concepts/webhooks) — raw body, timestamp, base64 webhook secret and HMAC-SHA256 procedure.
- [Safepay Raastwire payout lifecycle](https://safepay.mintlify.app/guides/payout-lifecycle) — beneficiary validation, idempotent payout request and asynchronous webhook status handling.
- [Safepay Raast general availability announcement](https://safepay.com.pk/blog/content/safepay-raast) — Raast collection and payout/merchant capabilities announced by Safepay.
- [JazzCash official sandbox documentation v4.2](https://sandbox.jazzcash.com.pk/SandboxDocumentation/v4.2/index.html) — sandbox signup, API tests, payment modes and webhooks.
- [Stripe global availability](https://stripe.com/global) — supported account-country list; Pakistan is not listed in the current supported-country set.

---

## 15. Final instruction to the team

The first day's output is a verified frontend-to-backend contract plus database schema and backend skeleton—not an unreviewed rush into feature endpoints. After the schema is merged and frozen, each developer works on a clearly owned module against the same committed contract. Keep the app runnable every day, integrate continuously, and reserve the final day for end-to-end testing rather than new architecture.
