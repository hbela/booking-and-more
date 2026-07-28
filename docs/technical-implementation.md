Here is the technical implementation plan, organized so it can be converted directly into GitHub epics and development tasks.

# Voice-Enabled Booking Engine

## Technical Implementation Plan

**Document version:** 1.0
**Architecture:** Multi-tenant SaaS
**Primary stack:** Next.js, React, Fastify, PostgreSQL, TypeScript
**Initial deployment:** Docker, Coolify, Hetzner
**Initial languages:** Hungarian and English
**Voice strategy:** Push-to-talk transcription with structured commands
**Calendar integration:** Google Calendar
**First pilot:** Sunshine Dental

---

# 1. Implementation Objective

Build a reusable booking platform in which customers and service providers can interact through:

- Standard forms
- Text chat
- Push-to-talk voice
- Optional future realtime voice

Every interface must use the same deterministic booking engine.

The AI layer may:

- Interpret natural-language requests
- Ask for missing information
- Call approved application tools
- Generate user-facing responses

The AI layer must not:

- Directly write to the database
- Directly call Google Calendar
- Decide that a slot is available
- Bypass authorization
- Execute destructive operations without confirmation
- Store the authoritative conversation or booking state

---

# 2. Technical Decisions

## 2.1 Recommended stack

### Frontend

- Next.js with App Router
- React
- TypeScript
- Tailwind CSS
- Shadcn UI
- TanStack Query
- React Hook Form
- Zod
- next-intl or equivalent localization library
- Browser MediaRecorder API
- PWA manifest and service worker

### Backend

- Fastify 5
- TypeScript
- Zod
- PostgreSQL
- Prisma
- Better Auth
- Redis
- BullMQ
- OpenAPI
- Pino structured logging

### Infrastructure

- Docker
- Docker Compose for local development
- Coolify
- Hetzner VPS
- PostgreSQL
- Redis
- S3-compatible object storage only when required
- Resend for transactional email
- Sentry for error monitoring

### Testing

- Vitest
- Fastify inject
- Testcontainers
- Playwright
- MSW where useful
- fast-check for availability-engine property tests

---

# 3. Main Architectural Principle

The platform should use a modular monolith for the first production versions.

```text
Next.js PWA
     │
     ▼
Fastify API
     │
     ├── Authentication
     ├── Tenant management
     ├── Provider management
     ├── Service management
     ├── Availability engine
     ├── Booking engine
     ├── Conversation orchestration
     ├── Voice orchestration
     ├── Calendar integration
     ├── Notification orchestration
     └── Usage metering
     │
     ├── PostgreSQL
     ├── Redis
     └── BullMQ workers
```

A modular monolith is preferable to microservices at this stage because it provides:

- Simpler deployment
- Easier transactions
- Easier debugging
- Lower infrastructure cost
- Shared domain logic
- Faster development

Module boundaries should still be explicit so selected components can be extracted later.

---

# 4. Repository Structure

Use a Turborepo or pnpm workspace.

```text
voice-booking/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   ├── lib/
│   │   ├── messages/
│   │   └── public/
│   │
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── server.ts
│   │   │   ├── config/
│   │   │   ├── plugins/
│   │   │   ├── modules/
│   │   │   ├── integrations/
│   │   │   ├── common/
│   │   │   └── tests/
│   │   └── Dockerfile
│   │
│   └── worker/
│       ├── src/
│       │   ├── worker.ts
│       │   ├── processors/
│       │   └── queues/
│       └── Dockerfile
│
├── packages/
│   ├── db/
│   │   ├── prisma/
│   │   ├── migrations/
│   │   └── src/
│   │
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── booking/
│   │   │   ├── availability/
│   │   │   ├── voice/
│   │   │   └── common/
│   │
│   ├── auth/
│   ├── booking-engine/
│   ├── availability-engine/
│   ├── ai/
│   ├── calendar/
│   ├── notifications/
│   ├── observability/
│   ├── config/
│   ├── eslint-config/
│   └── tsconfig/
│
├── docker/
├── scripts/
├── docs/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

# 5. Application Boundaries

## 5.1 Web application responsibilities

The Next.js application handles:

- Public booking UI
- Staff dashboard
- Provider dashboard
- Voice recording
- Transcript review
- Chat interface
- Booking confirmation cards
- Google Calendar connection UI
- Tenant branding
- Localization
- PWA installation
- Client-side form validation
- Authentication UI

The web application must not contain authoritative availability logic.

## 5.2 API responsibilities

The Fastify API handles:

- Authentication and authorization
- Tenant resolution
- Validation
- Slot generation
- Booking transactions
- Slot holds
- Conversation state
- Voice command interpretation
- Google Calendar integration
- Usage metering
- Audit logging
- Queue scheduling

## 5.3 Worker responsibilities

The worker handles:

- Hold expiration
- Appointment reminders
- Email delivery
- Google Calendar synchronization
- Calendar webhook processing
- Retryable calendar operations
- Usage aggregation
- Retention cleanup
- Failed-job recovery

---

# 6. Fastify Application Structure

Each business capability should be a Fastify module.

```text
apps/api/src/modules/
├── auth/
├── tenants/
├── memberships/
├── providers/
├── services/
├── locations/
├── availability/
├── slots/
├── holds/
├── bookings/
├── customers/
├── conversations/
├── voice/
├── calendar/
├── notifications/
├── usage/
├── subscriptions/
├── audit/
└── health/
```

Recommended module structure:

```text
bookings/
├── booking.routes.ts
├── booking.schemas.ts
├── booking.handlers.ts
├── booking.service.ts
├── booking.repository.ts
├── booking.policy.ts
├── booking.events.ts
├── booking.errors.ts
└── booking.test.ts
```

Request flow:

```text
Route
  ↓
Authentication
  ↓
Tenant context
  ↓
Authorization policy
  ↓
Zod validation
  ↓
Application service
  ↓
Domain operation
  ↓
Repository
  ↓
Database
```

---

# 7. Fastify Plugins

Create reusable Fastify plugins for infrastructure concerns.

```text
plugins/
├── config.plugin.ts
├── database.plugin.ts
├── redis.plugin.ts
├── auth.plugin.ts
├── tenant-context.plugin.ts
├── authorization.plugin.ts
├── idempotency.plugin.ts
├── queue.plugin.ts
├── openapi.plugin.ts
├── rate-limit.plugin.ts
├── audit.plugin.ts
├── request-context.plugin.ts
└── error-handler.plugin.ts
```

## 7.1 Request context

Every request should receive:

```ts
interface RequestContext {
  requestId: string;
  userId?: string;
  tenantId?: string;
  membershipId?: string;
  role?: Role;
  sessionId?: string;
}
```

Use AsyncLocalStorage or Fastify request decoration so logs and audit events automatically include the context.

## 7.2 Tenant context

Tenant resolution may come from:

- Authenticated membership
- Public tenant slug
- Custom domain mapping
- API key

Never trust a client-provided tenant ID without validating access.

---

# 8. Authentication and Authorization

## 8.1 Staff authentication

Use Better Auth for:

- Owner accounts
- Administrators
- Providers
- Assistants
- Platform administrators

Initial sign-in methods:

- Email and password
- Google sign-in optionally

## 8.2 Customer authentication

Support three customer access models:

1. Guest booking session
2. Secure booking-management token
3. Optional registered customer account

A customer should not be forced to create a password to book an appointment.

## 8.3 Roles

```ts
export const Roles = {
  PLATFORM_ADMIN: "PLATFORM_ADMIN",
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  PROVIDER: "PROVIDER",
  ASSISTANT: "ASSISTANT",
  CUSTOMER: "CUSTOMER",
} as const;
```

## 8.4 Permission model

Use explicit permissions rather than role checks scattered throughout handlers.

```ts
export const Permissions = {
  TENANT_MANAGE: "tenant:manage",
  BILLING_MANAGE: "billing:manage",
  PROVIDER_MANAGE: "provider:manage",
  SERVICE_MANAGE: "service:manage",
  AVAILABILITY_MANAGE_ALL: "availability:manage:all",
  AVAILABILITY_MANAGE_OWN: "availability:manage:own",
  BOOKING_READ_ALL: "booking:read:all",
  BOOKING_MANAGE_ALL: "booking:manage:all",
  BOOKING_READ_OWN: "booking:read:own",
} as const;
```

Example policy:

```ts
function canBlockProviderTime(actor: AuthenticatedActor, providerId: string): boolean {
  if (actor.permissions.includes("availability:manage:all")) {
    return true;
  }

  return actor.permissions.includes("availability:manage:own") && actor.providerId === providerId;
}
```

---

# 9. Database Design

Use UUIDs or CUID2 identifiers.

All tenant-owned tables must include `tenant_id`.

Use UTC timestamps in PostgreSQL and convert them for display using the relevant timezone.

---

# 10. Core Database Entities

## 10.1 Tenant

```text
tenants
- id
- name
- slug
- status
- default_language
- default_timezone
- logo_url
- primary_color
- contact_email
- contact_phone
- booking_policy
- privacy_policy_url
- cancellation_policy
- created_at
- updated_at
```

Constraints:

- Unique tenant slug
- Valid IANA timezone
- Status must be active, suspended, trial, or closed

## 10.2 User

Better Auth may own the principal user tables.

Application-specific user data should remain separate where practical.

## 10.3 Membership

```text
memberships
- id
- tenant_id
- user_id
- role
- provider_id nullable
- status
- invited_by
- joined_at
- created_at
- updated_at
```

Unique constraint:

```text
tenant_id + user_id
```

## 10.4 Provider

```text
providers
- id
- tenant_id
- display_name
- description
- email
- phone
- timezone
- languages
- active
- online_booking_enabled
- minimum_notice_minutes
- maximum_advance_days
- created_at
- updated_at
```

Store languages as a PostgreSQL text array or normalized join table.

## 10.5 Service

```text
services
- id
- tenant_id
- name
- slug
- description
- duration_minutes
- buffer_before_minutes
- buffer_after_minutes
- price_minor
- currency
- active
- requires_approval
- minimum_notice_minutes
- maximum_advance_days
- created_at
- updated_at
```

Store prices as integer minor units.

Example:

```text
$125.00 → 12500
```

## 10.6 Provider service

```text
provider_services
- id
- tenant_id
- provider_id
- service_id
- custom_duration_minutes nullable
- custom_price_minor nullable
- active
```

Unique constraint:

```text
provider_id + service_id
```

## 10.7 Location

```text
locations
- id
- tenant_id
- name
- type
- address_line_1
- address_line_2
- city
- postal_code
- country_code
- timezone
- latitude
- longitude
- active
- created_at
- updated_at
```

Location types:

- PHYSICAL
- ONLINE
- HOME_VISIT
- TELEPHONE

## 10.8 Provider location

```text
provider_locations
- provider_id
- location_id
- active
```

## 10.9 Working hours

```text
working_hours
- id
- tenant_id
- provider_id
- location_id nullable
- weekday
- start_time
- end_time
- valid_from nullable
- valid_until nullable
- active
```

Allow multiple periods per day.

Example:

```text
Monday 09:00–12:00
Monday 13:00–17:00
```

## 10.10 Availability exception

```text
availability_exceptions
- id
- tenant_id
- provider_id
- location_id nullable
- service_id nullable
- exception_type
- start_at
- end_at
- reason
- source
- created_by
- created_at
```

Exception types:

- UNAVAILABLE
- ADDITIONAL_AVAILABILITY

Sources:

- DASHBOARD
- VOICE
- CHAT
- CALENDAR
- API

## 10.11 Customer

```text
customers
- id
- tenant_id
- external_reference nullable
- full_name
- email
- phone
- preferred_language
- timezone nullable
- marketing_consent
- created_at
- updated_at
```

Create normalized email and phone fields for matching.

Do not automatically merge records based only on name.

## 10.12 Booking hold

```text
booking_holds
- id
- tenant_id
- provider_id
- service_id
- location_id nullable
- customer_id nullable
- session_id
- start_at
- end_at
- status
- expires_at
- idempotency_key
- created_at
- updated_at
```

Hold statuses:

- ACTIVE
- CONFIRMED
- RELEASED
- EXPIRED

## 10.13 Booking

```text
bookings
- id
- tenant_id
- customer_id
- provider_id
- service_id
- location_id nullable
- hold_id nullable
- start_at
- end_at
- status
- source
- customer_name_snapshot
- customer_email_snapshot
- customer_phone_snapshot
- service_name_snapshot
- price_minor_snapshot nullable
- currency_snapshot nullable
- notes
- cancellation_reason
- cancelled_at nullable
- created_by_user_id nullable
- idempotency_key
- version
- created_at
- updated_at
```

Booking sources:

- FORM
- CHAT
- VOICE
- STAFF
- API

## 10.14 Calendar integration

```text
calendar_integrations
- id
- tenant_id
- provider_id nullable
- user_id
- provider_type
- account_email
- encrypted_access_token
- encrypted_refresh_token
- access_token_expires_at
- scopes
- status
- last_error
- created_at
- updated_at
```

## 10.15 Calendar mapping

```text
calendar_mappings
- id
- tenant_id
- calendar_integration_id
- provider_id
- external_calendar_id
- calendar_name
- read_busy
- write_bookings
- active
```

## 10.16 Calendar event mapping

```text
calendar_event_mappings
- id
- tenant_id
- booking_id
- calendar_mapping_id
- external_event_id
- external_event_etag
- sync_status
- last_synced_at
- last_error
```

## 10.17 Conversation session

```text
conversation_sessions
- id
- tenant_id
- user_id nullable
- customer_id nullable
- role
- channel
- language
- timezone
- status
- current_intent
- state_json
- pending_action_json
- expires_at
- created_at
- updated_at
```

Channels:

- CHAT
- VOICE
- REALTIME_VOICE

## 10.18 Conversation message

```text
conversation_messages
- id
- session_id
- sender
- message_type
- content
- structured_content_json
- created_at
```

## 10.19 Voice interaction

```text
voice_interactions
- id
- tenant_id
- session_id
- user_id nullable
- audio_duration_ms
- transcription_provider
- transcription_model
- transcript
- detected_language
- interpretation_status
- intent
- estimated_cost_minor
- audio_retained
- created_at
```

## 10.20 Audit log

```text
audit_logs
- id
- tenant_id
- actor_type
- actor_id nullable
- action
- entity_type
- entity_id
- before_json nullable
- after_json nullable
- request_id
- ip_address
- user_agent
- created_at
```

Audit logs should be append-only.

---

# 11. Booking Concurrency

## 11.1 MVP capacity model

For the first release, assume:

```text
One provider can serve one booking at a time.
```

Support for group capacity can be added later.

## 11.2 PostgreSQL exclusion constraint

Use a PostgreSQL range exclusion constraint to prevent overlapping active bookings.

Example migration concept:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
ADD CONSTRAINT prevent_provider_booking_overlap
EXCLUDE USING gist (
  provider_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
)
WHERE (
  status IN ('PENDING', 'CONFIRMED')
);
```

Prisma does not need to understand this constraint directly. Add it using a custom SQL migration.

## 11.3 Hold protection

Active holds must also prevent conflicting holds and bookings.

A practical implementation is to create a shared capacity reservation table:

```text
capacity_reservations
- id
- tenant_id
- provider_id
- booking_id nullable
- hold_id nullable
- start_at
- end_at
- status
- expires_at nullable
```

Use one exclusion constraint across reservations:

```sql
ALTER TABLE capacity_reservations
ADD CONSTRAINT prevent_capacity_overlap
EXCLUDE USING gist (
  provider_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
)
WHERE (
  status = 'ACTIVE'
);
```

A hold creates an active reservation.

A confirmed booking replaces or adopts that reservation within the same transaction.

## 11.4 Hold creation transaction

```text
BEGIN

1. Validate tenant, provider, service, and location.
2. Calculate the requested end time.
3. Verify recurring availability.
4. Verify exceptions.
5. Verify external busy periods.
6. Insert capacity reservation.
7. Insert booking hold.
8. Commit.

COMMIT
```

A conflicting reservation causes the database insert to fail.

Return:

```json
{
  "code": "SLOT_NO_LONGER_AVAILABLE",
  "message": "This appointment was just reserved by another customer."
}
```

## 11.5 Booking confirmation transaction

```text
BEGIN

1. Lock booking hold.
2. Validate hold status.
3. Validate expiration.
4. Create or update customer.
5. Insert booking.
6. Update reservation with booking ID.
7. Mark hold confirmed.
8. Insert audit event.
9. Insert outbox events.
10. Commit.

COMMIT
```

Google Calendar and email operations should happen after the database commit.

---

# 12. Transactional Outbox

Do not directly publish queue jobs inside critical database transactions.

Create an outbox table:

```text
outbox_events
- id
- tenant_id
- event_type
- aggregate_type
- aggregate_id
- payload_json
- status
- available_at
- attempts
- created_at
- processed_at nullable
```

Examples:

- BOOKING_CONFIRMED
- BOOKING_RESCHEDULED
- BOOKING_CANCELLED
- AVAILABILITY_CHANGED
- CALENDAR_SYNC_REQUESTED
- EMAIL_REQUESTED
- REMINDER_SCHEDULE_REQUESTED

The worker polls or receives events and publishes the corresponding BullMQ jobs.

This prevents cases where:

- The booking commits but the queue message is lost.
- The queue message is published but the booking transaction rolls back.

---

# 13. Availability Engine

Create a pure TypeScript package:

```text
packages/availability-engine
```

The engine must not import Fastify, Prisma, Redis, or external APIs.

## 13.1 Input

```ts
interface AvailabilityQuery {
  providerId: string;
  serviceDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  dateFrom: string;
  dateTo: string;
  timezone: string;
  slotIntervalMinutes: number;
  workingPeriods: TimePeriod[];
  additionalPeriods: DateTimePeriod[];
  unavailablePeriods: DateTimePeriod[];
  bookings: DateTimePeriod[];
  activeHolds: DateTimePeriod[];
  externalBusyPeriods: DateTimePeriod[];
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
}
```

## 13.2 Output

```ts
interface AvailableSlot {
  startAt: string;
  endAt: string;
  occupiedFrom: string;
  occupiedUntil: string;
}
```

`occupiedFrom` and `occupiedUntil` include buffers.

## 13.3 Calculation steps

```text
1. Generate working periods in the provider timezone.
2. Add additional availability.
3. Subtract unavailable exceptions.
4. Subtract confirmed bookings.
5. Subtract active holds.
6. Subtract external calendar busy periods.
7. Apply service duration and buffers.
8. Generate slots according to slot interval.
9. Apply minimum notice.
10. Apply maximum advance window.
11. Return slots in chronological order.
```

## 13.4 Timezone rules

- Store timestamps in UTC.
- Store recurring working hours as local wall-clock times.
- Interpret schedules using the provider or location timezone.
- Handle daylight-saving transitions explicitly.
- Never calculate recurring hours by manually adding UTC offsets.
- Display absolute dates before confirmation.

## 13.5 Availability tests

Required cases:

- Multiple working periods on one day
- Lunch break
- Additional Saturday opening
- Full-day exception
- Partial-day exception
- Service buffers
- Appointment crossing midnight
- Daylight-saving start
- Daylight-saving end
- External calendar conflict
- Active hold conflict
- Minimum notice
- Maximum advance window
- Back-to-back appointments
- Slot interval different from service duration

---

# 14. Booking Engine

Create:

```text
packages/booking-engine
```

Core operations:

```ts
interface BookingEngine {
  searchSlots(input: SearchSlotsInput): Promise<SearchSlotsResult>;
  createHold(input: CreateHoldInput): Promise<CreateHoldResult>;
  releaseHold(input: ReleaseHoldInput): Promise<void>;
  confirmBooking(input: ConfirmBookingInput): Promise<Booking>;
  prepareReschedule(input: PrepareRescheduleInput): Promise<BookingPreview>;
  confirmReschedule(input: ConfirmRescheduleInput): Promise<Booking>;
  prepareCancellation(input: PrepareCancellationInput): Promise<CancellationPreview>;
  confirmCancellation(input: ConfirmCancellationInput): Promise<Booking>;
}
```

Business rules belong here rather than in route handlers.

---

# 15. API Design

All APIs should use:

- JSON
- Zod validation
- Standard error envelopes
- Request IDs
- Idempotency keys for writes
- OpenAPI documentation

## 15.1 Error format

```json
{
  "error": {
    "code": "SLOT_NO_LONGER_AVAILABLE",
    "message": "This appointment is no longer available.",
    "requestId": "req_123",
    "details": {}
  }
}
```

## 15.2 Pagination

Use cursor pagination for large collections.

```json
{
  "items": [],
  "nextCursor": "..."
}
```

---

# 16. Public Booking API

## Tenant information

```http
GET /v1/public/tenants/:tenantSlug
```

Returns:

- Branding
- Languages
- Contact details
- Locations
- Booking policies

## Services

```http
GET /v1/public/tenants/:tenantSlug/services
GET /v1/public/tenants/:tenantSlug/services/:serviceId
```

## Providers

```http
GET /v1/public/tenants/:tenantSlug/providers
GET /v1/public/tenants/:tenantSlug/providers/:providerId
```

## Slot search

```http
POST /v1/public/tenants/:tenantSlug/slots/search
```

Request:

```json
{
  "serviceId": "service_123",
  "providerId": "provider_456",
  "locationId": "location_789",
  "dateFrom": "2026-08-05",
  "dateTo": "2026-08-12",
  "timeFrom": "16:00",
  "timeTo": "20:00",
  "timezone": "Europe/Budapest"
}
```

## Create hold

```http
POST /v1/public/tenants/:tenantSlug/holds
Idempotency-Key: unique-client-value
```

## Release hold

```http
DELETE /v1/public/tenants/:tenantSlug/holds/:holdId
```

## Confirm booking

```http
POST /v1/public/tenants/:tenantSlug/bookings
Idempotency-Key: unique-client-value
```

## Booking management

```http
GET  /v1/public/bookings/:managementToken
POST /v1/public/bookings/:managementToken/reschedule/prepare
POST /v1/public/bookings/:managementToken/reschedule/confirm
POST /v1/public/bookings/:managementToken/cancel/prepare
POST /v1/public/bookings/:managementToken/cancel/confirm
```

---

# 17. Staff API

## Providers

```http
GET    /v1/providers
POST   /v1/providers
GET    /v1/providers/:providerId
PATCH  /v1/providers/:providerId
DELETE /v1/providers/:providerId
```

## Services

```http
GET    /v1/services
POST   /v1/services
GET    /v1/services/:serviceId
PATCH  /v1/services/:serviceId
DELETE /v1/services/:serviceId
```

## Locations

```http
GET    /v1/locations
POST   /v1/locations
PATCH  /v1/locations/:locationId
```

## Availability

```http
GET    /v1/providers/:providerId/working-hours
PUT    /v1/providers/:providerId/working-hours
GET    /v1/providers/:providerId/availability-exceptions
POST   /v1/providers/:providerId/availability-exceptions
PATCH  /v1/availability-exceptions/:exceptionId
DELETE /v1/availability-exceptions/:exceptionId
```

## Bookings

```http
GET    /v1/bookings
POST   /v1/bookings
GET    /v1/bookings/:bookingId
PATCH  /v1/bookings/:bookingId
POST   /v1/bookings/:bookingId/reschedule/prepare
POST   /v1/bookings/:bookingId/reschedule/confirm
POST   /v1/bookings/:bookingId/cancel/prepare
POST   /v1/bookings/:bookingId/cancel/confirm
```

---

# 18. Voice API

## 18.1 Create conversation session

```http
POST /v1/voice/sessions
```

Request:

```json
{
  "tenantSlug": "sunshine-dental",
  "channel": "VOICE",
  "language": "hu",
  "timezone": "Europe/Budapest",
  "context": {
    "serviceId": null,
    "providerId": null
  }
}
```

## 18.2 Upload and transcribe audio

```http
POST /v1/voice/sessions/:sessionId/transcriptions
Content-Type: multipart/form-data
```

Validate:

- MIME type
- Maximum file size
- Maximum duration
- Session ownership
- Rate limit

Recommended accepted formats:

- audio/webm
- audio/ogg
- audio/mp4
- audio/wav

## 18.3 Interpret transcript

```http
POST /v1/voice/sessions/:sessionId/messages
```

Request:

```json
{
  "text": "Szeretnék időpontot jövő szerdán délután négy után."
}
```

Response:

```json
{
  "message": {
    "text": "Milyen kezelésre szeretne időpontot foglalni?"
  },
  "state": {
    "intent": "SEARCH_SLOTS",
    "missingFields": ["serviceId"]
  },
  "ui": {
    "type": "SERVICE_SELECTION",
    "options": []
  }
}
```

## 18.4 Confirm pending action

```http
POST /v1/voice/sessions/:sessionId/actions/:actionId/confirm
```

## 18.5 Cancel pending action

```http
POST /v1/voice/sessions/:sessionId/actions/:actionId/cancel
```

---

# 19. Voice Recording Frontend

Create a reusable component:

```tsx
<PushToTalkButton
  sessionId={sessionId}
  maxDurationSeconds={30}
  onTranscript={handleTranscript}
  onError={handleVoiceError}
/>
```

## 19.1 Recording states

```ts
type RecordingState =
  | "IDLE"
  | "REQUESTING_PERMISSION"
  | "RECORDING"
  | "UPLOADING"
  | "TRANSCRIBING"
  | "REVIEWING"
  | "PROCESSING"
  | "ERROR";
```

## 19.2 User experience

```text
1. User presses the microphone.
2. Permission is requested when necessary.
3. Recording indicator and timer appear.
4. Recording stops when released or after 30 seconds.
5. Audio is uploaded.
6. Transcript appears.
7. User may edit, retry, or submit.
8. Structured interpretation begins.
9. Result appears as text and visual controls.
```

## 19.3 Browser fallback

When MediaRecorder is unavailable:

- Hide voice controls
- Display chat input
- Keep the normal booking form accessible

---

# 20. AI Interpretation Layer

Create:

```text
packages/ai
```

The AI package should expose interfaces, not provider-specific behavior.

```ts
interface TranscriptionProvider {
  transcribe(input: AudioInput): Promise<TranscriptionResult>;
}

interface IntentInterpreter {
  interpret(input: InterpretationInput): Promise<InterpretationResult>;
}

interface ResponseComposer {
  compose(input: ResponseInput): Promise<ResponseResult>;
}
```

Provider implementations:

```text
OpenAITranscriptionProvider
OpenAIIntentInterpreter
TemplateResponseComposer
```

Prefer deterministic template responses for common booking steps.

Use the language model mainly for:

- Intent recognition
- Entity extraction
- Date phrase interpretation
- Natural-language clarification
- Mapping spoken service names to known services

---

# 21. Structured Command Envelope

All interpreted commands must use one shared envelope.

```ts
const CommandEnvelopeSchema = z.object({
  intent: z.enum([
    "LIST_SERVICES",
    "SEARCH_SLOTS",
    "SELECT_SLOT",
    "CREATE_BOOKING",
    "GET_BOOKING",
    "RESCHEDULE_BOOKING",
    "CANCEL_BOOKING",
    "GET_SCHEDULE",
    "GET_FREE_PERIODS",
    "BLOCK_TIME",
    "OPEN_ADDITIONAL_TIME",
  ]),
  confidence: z.number().min(0).max(1),
  parameters: z.record(z.unknown()),
  missingFields: z.array(z.string()),
  requiresConfirmation: z.boolean(),
});
```

Each intent must have a separate parameter schema.

Example:

```ts
const SearchSlotsParametersSchema = z.object({
  serviceId: z.string().optional(),
  serviceQuery: z.string().optional(),
  providerId: z.string().optional(),
  providerQuery: z.string().optional(),
  locationId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  timeFrom: z.string().optional(),
  timeTo: z.string().optional(),
});
```

Never execute parameters before validating against the intent-specific schema.

---

# 22. Conversation State Machine

Use an explicit state machine rather than relying on message history.

Example booking states:

```ts
type CustomerBookingState =
  | "START"
  | "SELECTING_SERVICE"
  | "SELECTING_PROVIDER"
  | "SELECTING_DATE"
  | "SEARCHING_SLOTS"
  | "SELECTING_SLOT"
  | "HOLDING_SLOT"
  | "COLLECTING_CUSTOMER_DETAILS"
  | "AWAITING_CONFIRMATION"
  | "CONFIRMING_BOOKING"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";
```

Provider command states:

```ts
type ProviderCommandState =
  | "START"
  | "INTERPRETING"
  | "RESOLVING_DATE"
  | "CHECKING_CONFLICTS"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING"
  | "COMPLETED"
  | "CANCELLED";
```

## 22.1 Pending action

```ts
interface PendingAction {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  preview: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  confirmationRequired: boolean;
}
```

A confirmation message must reference a specific pending-action ID.

A generic “yes” must never confirm an unknown or expired action.

---

# 23. Tool Execution Model

Separate read tools from write tools.

## 23.1 Read tools

- listServices
- getService
- listProviders
- getProvider
- searchAvailableSlots
- getBooking
- getSchedule
- getFreePeriods

Read tools may execute immediately.

## 23.2 Prepare tools

- prepareBooking
- prepareReschedule
- prepareCancellation
- prepareBlockTime
- prepareOpenAdditionalTime

Prepare tools:

- Validate the request
- Detect conflicts
- Create previews
- Create a slot hold where appropriate
- Create pending actions

## 23.3 Confirm tools

- confirmBooking
- confirmReschedule
- confirmCancellation
- confirmBlockTime
- confirmOpenAdditionalTime

Confirm tools require:

- Valid pending-action ID
- Same session or authenticated user
- Unexpired action
- Explicit user confirmation
- Idempotency protection

---

# 24. Natural-Language Date Handling

Use a hybrid strategy.

## Step 1: AI extraction

The model extracts:

```json
{
  "dateExpression": "next Wednesday",
  "timeExpression": "after four"
}
```

## Step 2: Deterministic resolution

A server-side date resolver receives:

- Current absolute date
- User timezone
- Tenant timezone
- Provider timezone
- Locale
- Extracted expression

## Step 3: Display confirmation

```text
Wednesday, August 5, 2026
After 4:00 PM
Europe/Budapest
```

Write actions must never rely only on an unresolved relative phrase.

---

# 25. Google Calendar Integration

## 25.1 OAuth flow

```text
1. Authenticated staff user chooses Connect Google Calendar.
2. API creates OAuth state record.
3. User is redirected to Google.
4. Google redirects to the backend callback.
5. Backend validates state.
6. Backend exchanges authorization code.
7. Tokens are encrypted.
8. User selects calendars.
9. Calendar mappings are saved.
10. Initial synchronization runs.
```

## 25.2 Token encryption

Encrypt refresh tokens using authenticated encryption such as AES-256-GCM.

Store the master encryption key outside the database:

```text
GOOGLE_TOKEN_ENCRYPTION_KEY
```

Do not log:

- Authorization codes
- Access tokens
- Refresh tokens

## 25.3 Busy-time reads

The slot engine should read external busy periods from a local cache rather than calling Google for every public search.

Suggested model:

```text
external_busy_periods
- id
- tenant_id
- provider_id
- calendar_mapping_id
- external_event_id
- start_at
- end_at
- status
- last_synced_at
```

## 25.4 Synchronization strategy

Use:

- Initial full synchronization
- Incremental synchronization where supported
- Google webhook notifications
- Scheduled reconciliation
- Retry queue

A webhook notification should trigger a background synchronization job.

Do not perform substantial synchronization work inside the webhook request.

## 25.5 Booking event creation

After `BOOKING_CONFIRMED`:

```text
1. Worker receives event.
2. Load booking and calendar mapping.
3. Build external event.
4. Create event using an idempotency strategy.
5. Save event mapping.
6. Mark synchronization successful.
7. Retry transient failures.
```

## 25.6 Calendar failure behavior

A confirmed database booking remains confirmed when calendar synchronization fails.

The dashboard should show:

```text
Calendar sync failed
Retry scheduled
```

---

# 26. Queue Design

BullMQ queues:

```text
calendar-sync
notifications
booking-reminders
hold-expiration
outbox-dispatch
usage-aggregation
retention-cleanup
```

## 26.1 Calendar jobs

- sync-calendar
- create-booking-event
- update-booking-event
- cancel-booking-event
- renew-calendar-watch
- reconcile-calendar

## 26.2 Notification jobs

- send-booking-confirmation
- send-booking-update
- send-booking-cancellation
- send-reminder
- notify-calendar-failure

## 26.3 Retry policy

Use exponential backoff for transient errors.

Do not retry permanent errors indefinitely.

Example categories:

```text
Retry:
- HTTP 429
- HTTP 500–599
- Temporary network failure
- Timeout

Do not retry without intervention:
- OAuth access revoked
- Invalid calendar ID
- Invalid recipient email
- Permission denied
```

Use dead-letter handling for exhausted jobs.

---

# 27. Notifications

Create provider-neutral notification interfaces.

```ts
interface EmailProvider {
  send(input: EmailMessage): Promise<DeliveryResult>;
}
```

Notification records:

```text
notifications
- id
- tenant_id
- booking_id nullable
- customer_id nullable
- type
- channel
- recipient
- template
- locale
- status
- provider_message_id
- attempts
- scheduled_at
- sent_at
- last_error
```

Use localized templates.

Initial templates:

- Booking confirmation
- Booking updated
- Booking cancelled
- Reminder
- Calendar integration disconnected

---

# 28. Frontend Routes

## Public routes

```text
/[tenantSlug]
/[tenantSlug]/services
/[tenantSlug]/book
/[tenantSlug]/book/service
/[tenantSlug]/book/provider
/[tenantSlug]/book/time
/[tenantSlug]/book/details
/[tenantSlug]/book/confirm
/[tenantSlug]/book/success
/booking/manage/[token]
```

## Staff routes

```text
/dashboard
/dashboard/calendar
/dashboard/bookings
/dashboard/bookings/[id]
/dashboard/providers
/dashboard/services
/dashboard/locations
/dashboard/availability
/dashboard/integrations
/dashboard/settings
/dashboard/usage
```

## Voice interface

The voice interface should be available inside the normal booking flow rather than as a separate isolated page.

Example:

```text
┌──────────────────────────────────────────┐
│ What would you like to book?             │
│                                          │
│ [ Type a message... ]                    │
│                                          │
│ [ Hold to speak ]                        │
│                                          │
│ Or choose a service below                │
└──────────────────────────────────────────┘
```

---

# 29. Frontend Feature Structure

```text
apps/web/features/
├── tenant/
├── authentication/
├── services/
├── providers/
├── availability/
├── booking/
├── booking-management/
├── chat/
├── voice/
├── calendar/
├── notifications/
├── settings/
└── usage/
```

Each feature should contain:

```text
components/
hooks/
queries/
mutations/
schemas/
types/
utils/
```

---

# 30. Public Booking Flow

## Step 1: Tenant page

Load:

- Branding
- Services
- Locations
- Languages
- Policies

## Step 2: Service selection

Selection methods:

- Touch
- Text
- Voice

## Step 3: Provider selection

Support:

- Specific provider
- Any available provider

## Step 4: Date and slot search

Return a limited set of useful options.

Do not return hundreds of time slots to the conversational interface.

## Step 5: Hold creation

Create a hold as soon as the user selects a slot.

Show countdown:

```text
This time is reserved for 4:38
```

## Step 6: Customer details

Collect only configured required fields.

## Step 7: Final preview

Display:

- Service
- Provider
- Location
- Absolute date
- Time
- Duration
- Price
- Customer details
- Cancellation policy

## Step 8: Confirmation

Submit with idempotency key.

## Step 9: Success

Display:

- Booking reference
- Management link
- Add-to-calendar option
- Confirmation-delivery status

---

# 31. Provider Voice Flow

Example command:

> “Block Friday afternoon because I will be away.”

Technical flow:

```text
1. Create or resume voice session.
2. Transcribe audio.
3. Interpret BLOCK_TIME intent.
4. Resolve provider from authenticated membership.
5. Resolve Friday to absolute date.
6. Resolve afternoon using tenant rules.
7. Query existing bookings.
8. Create preview.
9. Store pending action.
10. Display conflicts and proposed change.
11. Request confirmation.
12. Confirm pending action.
13. Insert availability exception.
14. Emit AVAILABILITY_CHANGED.
15. Record audit event.
```

Tenant settings should define approximate dayparts:

```json
{
  "morning": {
    "from": "08:00",
    "to": "12:00"
  },
  "afternoon": {
    "from": "12:00",
    "to": "17:00"
  },
  "evening": {
    "from": "17:00",
    "to": "21:00"
  }
}
```

---

# 32. Idempotency

Require `Idempotency-Key` for:

- Hold creation
- Booking confirmation
- Rescheduling
- Cancellation
- Calendar write operations
- Voice action confirmation

Store:

```text
idempotency_keys
- id
- tenant_id
- key
- operation
- request_hash
- response_status
- response_body
- expires_at
- created_at
```

When the same key is submitted again:

- Return the original result if the request is identical.
- Reject if the body differs.

---

# 33. Rate Limiting

Apply different policies.

## Public slot search

Example:

```text
60 requests per minute per IP and tenant
```

## Voice transcription

Example:

```text
10 requests per minute per session
30-second maximum audio duration
```

## Booking confirmation

Example:

```text
10 attempts per hour per IP and tenant
```

## Authentication

Use stricter limits for sign-in and password-reset endpoints.

Rate limits should be configurable rather than hardcoded.

---

# 34. Security Implementation

## 34.1 API security

- Validate all inputs with Zod.
- Use parameterized database access.
- Enforce tenant context on every repository operation.
- Use secure HTTP-only cookies.
- Enable CSRF protection where appropriate.
- Restrict CORS.
- Configure security headers.
- Set request-body size limits.
- Apply file-upload validation.
- Redact sensitive logs.

## 34.2 Repository pattern

Repositories should require tenant ID explicitly.

```ts
bookingRepository.findById({
  tenantId,
  bookingId,
});
```

Avoid:

```ts
bookingRepository.findById(bookingId);
```

This reduces accidental cross-tenant reads.

## 34.3 Voice uploads

Validate:

- Content type
- Magic bytes where possible
- Maximum file size
- Maximum duration
- Session authorization

Delete raw audio after successful transcription unless retention is enabled.

## 34.4 Booking-management tokens

Store only a hash of the management token.

```text
Raw token → customer URL
SHA-256 hash → database
```

Generate at least 32 random bytes.

## 34.5 Audit requirements

Audit:

- Booking creation
- Booking cancellation
- Booking rescheduling
- Availability changes
- Provider changes
- Service changes
- Calendar connection
- Calendar disconnection
- Role changes
- Voice-confirmed write actions

---

# 35. Privacy and Retention

Recommended defaults:

```text
Raw voice audio: Delete after transcription
Voice transcripts: 30 days
Conversation sessions: 30 days
Application audit logs: 12 months
Failed job payloads: 30 days
Booking records: Tenant-defined
```

Retention must be tenant-configurable where legally appropriate.

Create cleanup jobs for:

- Expired holds
- Expired sessions
- Raw audio
- Old transcripts
- Expired management tokens
- Old idempotency keys
- Completed outbox events

---

# 36. Observability

## 36.1 Logs

Use structured Pino logs.

Include:

```json
{
  "requestId": "req_123",
  "tenantId": "tenant_123",
  "userId": "user_123",
  "sessionId": "session_123",
  "bookingId": "booking_123",
  "module": "booking"
}
```

Do not log:

- Full voice audio
- OAuth tokens
- Passwords
- Complete medical notes
- Sensitive customer details

## 36.2 Metrics

Track:

- HTTP latency
- Slot-search latency
- Booking confirmations
- Booking failures
- Reservation conflicts
- Active holds
- Expired holds
- Calendar-sync failures
- Queue depth
- Email delivery failures
- Audio duration
- Voice command success
- Voice command correction rate
- AI cost per interaction

## 36.3 Error tracking

Use separate Sentry projects or environments for:

- Web
- API
- Worker

Attach tenant and request context without including sensitive content.

---

# 37. Usage Metering

Create usage events.

```text
usage_events
- id
- tenant_id
- user_id nullable
- category
- quantity
- unit
- provider
- model
- estimated_cost_minor
- metadata_json
- occurred_at
```

Categories:

- VOICE_TRANSCRIPTION
- AI_INPUT_TOKENS
- AI_OUTPUT_TOKENS
- TTS_CHARACTERS
- REALTIME_AUDIO_SECONDS
- EMAIL_SENT
- BOOKING_CREATED

Aggregate daily and monthly:

```text
usage_aggregates
- tenant_id
- period
- category
- quantity
- estimated_cost_minor
```

Before processing voice:

```ts
await usagePolicy.assertAllowed({
  tenantId,
  category: "VOICE_TRANSCRIPTION",
  requestedQuantity: audioDurationSeconds,
});
```

---

# 38. Localization

Store internal enums and IDs in English.

Translate user-facing content.

Example messages:

```text
apps/web/messages/
├── en.json
├── hu.json
├── de.json
└── fr.json
```

Service names may require tenant-managed translations:

```text
service_translations
- service_id
- locale
- name
- description
```

Voice interpretation should receive:

- Current language
- Supported service translations
- Provider names
- Location names
- Tenant-specific terminology

For Hungarian names, avoid automatically spelling or correcting names without confirmation.

---

# 39. Testing Strategy

## 39.1 Unit tests

Test pure business logic:

- Availability calculations
- Date resolution
- Permission policies
- Hold expiration
- Booking state transitions
- Intent schemas
- Cost calculations

## 39.2 Property tests

Use property-based tests for the availability engine.

Examples:

- Generated slots never overlap busy periods.
- Generated slots always fall inside availability.
- Slots always satisfy service duration.
- Slots never violate minimum notice.
- Confirmed reservations never overlap for capacity one.

## 39.3 Repository integration tests

Use a real PostgreSQL instance through Testcontainers.

Test:

- Tenant isolation
- Unique constraints
- Exclusion constraints
- Transactions
- Concurrent hold creation
- Booking confirmation
- Rollbacks

## 39.4 Fastify integration tests

Use `fastify.inject()`.

Test:

- Authentication
- Authorization
- Validation errors
- Idempotency
- Rate limiting
- Error serialization
- OpenAPI contracts

## 39.5 External integration tests

Mock:

- Google Calendar API
- Transcription provider
- Language-model provider
- Email provider

Include:

- Token expiration
- Rate limiting
- Network failures
- Duplicate webhooks
- Retry behavior

## 39.6 End-to-end tests

Use Playwright.

Critical paths:

1. Owner creates provider and service.
2. Owner configures working hours.
3. Customer searches slots.
4. Customer places hold.
5. Customer confirms booking.
6. Booking appears in dashboard.
7. Customer reschedules.
8. Customer cancels.
9. Customer books using chat.
10. Customer books using push-to-talk with mocked transcription.
11. Provider blocks availability using voice.
12. Two users attempt to book the same slot.

---

# 40. CI Pipeline

GitHub Actions pipeline:

```text
1. Install dependencies.
2. Validate formatting.
3. Run ESLint.
4. Run TypeScript checks.
5. Run unit tests.
6. Start PostgreSQL and Redis.
7. Apply migrations.
8. Run integration tests.
9. Build packages.
10. Build API.
11. Build worker.
12. Build web.
13. Run selected Playwright smoke tests.
```

Pull requests must fail when:

- Type checking fails
- Tests fail
- Prisma schema is invalid
- Migrations cannot be applied
- OpenAPI contracts change unexpectedly
- Production builds fail

---

# 41. Deployment Architecture

Recommended Coolify services:

```text
voice-booking-web
voice-booking-api
voice-booking-worker
voice-booking-postgres
voice-booking-redis
```

Suggested domains:

```text
booking.appointer.hu
api.booking.appointer.hu
```

Staging:

```text
booking-dev.appointer.hu
api-booking-dev.appointer.hu
```

## 41.1 Deployment order

```text
1. Build images.
2. Back up database.
3. Apply backward-compatible migrations.
4. Deploy API.
5. Deploy worker.
6. Deploy web.
7. Run health checks.
8. Run smoke test.
```

## 41.2 Health endpoints

```http
GET /health/live
GET /health/ready
```

`live` verifies the process is running.

`ready` verifies:

- PostgreSQL
- Redis
- Required configuration
- Worker connectivity where appropriate

---

# 42. Environment Configuration

Example:

```env
NODE_ENV=production
APP_BASE_URL=
API_BASE_URL=
DATABASE_URL=
REDIS_URL=

BETTER_AUTH_SECRET=
BETTER_AUTH_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_TOKEN_ENCRYPTION_KEY=

OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=
OPENAI_INTERPRETATION_MODEL=

RESEND_API_KEY=
EMAIL_FROM=

SENTRY_DSN=
LOG_LEVEL=info

VOICE_MAX_DURATION_SECONDS=30
VOICE_AUDIO_RETENTION_ENABLED=false
BOOKING_HOLD_DURATION_SECONDS=300
```

Validate all environment variables at startup.

The application should fail fast when required values are missing.

---

# 43. Database Migration Strategy

Use Prisma migrations plus custom SQL where needed.

Custom SQL is required for:

- `btree_gist`
- Exclusion constraints
- Partial indexes
- Specialized database policies

Migration rules:

- Never edit an applied production migration.
- Test migrations against a production-like database.
- Prefer expand-and-contract changes.
- Do not remove columns in the same release that stops writing them.
- Back up before destructive migrations.

---

# 44. Development Epics

# Epic 0 — Repository and infrastructure

## Deliverables

- pnpm workspace
- Turborepo
- Next.js application
- Fastify application
- Worker application
- Shared TypeScript configuration
- PostgreSQL
- Redis
- Prisma
- Docker Compose
- GitHub Actions
- Sentry
- Health checks

## Exit criteria

- All applications run locally.
- CI passes.
- Staging deployment works.
- API can connect to PostgreSQL and Redis.

---

# Epic 1 — Authentication and tenancy

## Deliverables

- Better Auth integration
- Tenant creation
- Memberships
- Roles
- Permission policies
- Tenant context
- Invitation flow
- Audit logging

## Exit criteria

- An owner can create a tenant.
- An owner can invite an administrator or provider.
- Users cannot access another tenant’s data.
- Role permissions are covered by tests.

---

# Epic 2 — Providers, services, and locations

## Deliverables

- Provider CRUD
- Service CRUD
- Location CRUD
- Provider-service assignment
- Provider-location assignment
- Dashboard screens
- Localization fields

## Exit criteria

- An owner can fully configure one clinic.
- Inactive services and providers cannot be publicly booked.

---

# Epic 3 — Availability engine

## Deliverables

- Working-hours model
- Availability exceptions
- Pure calculation package
- Slot generation
- Timezone support
- Unit and property tests
- Provider availability dashboard

## Exit criteria

- Slots correctly reflect schedules, breaks, buffers, and exceptions.
- Daylight-saving tests pass.
- Slot calculations are deterministic.

---

# Epic 4 — Booking engine

## Deliverables

- Booking holds
- Capacity reservations
- PostgreSQL exclusion constraint
- Booking confirmation
- Rescheduling
- Cancellation
- Management tokens
- Idempotency
- Public booking forms

## Exit criteria

- A customer can complete a booking.
- Two concurrent users cannot confirm the same exclusive slot.
- Holds expire automatically.
- Rescheduling is transactional.

---

# Epic 5 — Notifications

## Deliverables

- Outbox events
- BullMQ setup
- Email provider
- Localized templates
- Booking confirmations
- Cancellation notices
- Reminders
- Delivery tracking

## Exit criteria

- Booking emails are sent asynchronously.
- Failed email jobs retry safely.
- Duplicate events do not send duplicate messages.

---

# Epic 6 — Google Calendar

## Deliverables

- OAuth flow
- Encrypted token storage
- Calendar selection
- Busy-period synchronization
- Booking-event creation
- Booking-event update
- Cancellation synchronization
- Webhooks
- Reconciliation job
- Integration-health dashboard

## Exit criteria

- External busy periods affect slot results.
- Confirmed bookings create calendar events.
- Calendar failures do not invalidate bookings.
- Revoked access is detected and displayed.

---

# Epic 7 — Chat booking

## Deliverables

- Conversation sessions
- Explicit state machine
- Intent interpretation
- Tool allowlist
- Service selection
- Slot search
- Hold creation
- Customer-detail collection
- Confirmation cards
- Chat UI

## Exit criteria

- A customer can complete a booking by chat.
- All write operations require explicit confirmation.
- State survives page refresh within the session lifetime.

---

# Epic 8 — Push-to-talk voice

## Deliverables

- MediaRecorder component
- Audio upload
- Transcription provider
- Transcript review
- Voice usage metering
- Customer voice booking
- Provider availability commands
- Browser speech synthesis
- Audio-retention cleanup

## Exit criteria

- A customer can search and book using push-to-talk.
- A provider can create an availability exception using voice.
- Voice and chat use the same conversation state machine.
- Raw recordings are deleted according to policy.

---

# Epic 9 — SaaS administration

## Deliverables

- Subscription plans
- Usage quotas
- Tenant suspension
- Platform administration
- Branding
- Custom domains
- Usage dashboard
- Cost estimates

## Exit criteria

- Voice usage can be limited per tenant.
- Suspended tenants cannot accept new bookings.
- Owners can view monthly usage.

---

# Epic 10 — Production hardening

## Deliverables

- Security review
- Load testing
- Backup verification
- Disaster-recovery procedure
- GDPR export and deletion
- Accessibility review
- Retention jobs
- Operational runbooks
- Production alerts

## Exit criteria

- Backup restoration is tested.
- Core booking workflows meet performance targets.
- Security and tenant-isolation tests pass.
- Operational alerts are configured.

---

# 45. Recommended Implementation Order

The first vertical slice should be:

```text
Tenant
  ↓
Provider
  ↓
Service
  ↓
Working hours
  ↓
Slot search
  ↓
Slot hold
  ↓
Booking confirmation
  ↓
Email confirmation
  ↓
Google Calendar event
```

Do not begin with voice.

Voice should be added after the deterministic form-based workflow is reliable.

Recommended order:

```text
1. Foundation
2. Authentication and tenants
3. Providers and services
4. Availability
5. Booking concurrency
6. Public form booking
7. Notifications
8. Google Calendar
9. Chat
10. Push-to-talk voice
11. Commercial SaaS features
12. Realtime voice
```

---

# 46. First Development Backlog

## Foundation

- Initialize pnpm workspace.
- Configure Turborepo.
- Create web, API, and worker applications.
- Add shared TypeScript configuration.
- Add ESLint and formatting.
- Add Docker Compose.
- Add PostgreSQL and Redis.
- Add Prisma.
- Add Fastify health routes.
- Add CI workflow.
- Add Sentry.

## Authentication

- Configure Better Auth.
- Create tenant schema.
- Create membership schema.
- Add owner registration.
- Add tenant switcher.
- Add tenant context.
- Add permission middleware.
- Add tenant-isolation tests.

## Booking configuration

- Implement provider CRUD.
- Implement service CRUD.
- Implement location CRUD.
- Assign providers to services.
- Assign providers to locations.
- Add working-hours editor.
- Add availability-exception editor.

## Booking core

- Build availability-engine package.
- Implement slot-search API.
- Implement hold table.
- Implement capacity-reservation table.
- Add exclusion constraint.
- Implement hold expiration.
- Implement booking confirmation.
- Add booking-management token.
- Implement cancellation.
- Implement rescheduling.

## Public UI

- Build tenant landing page.
- Build service selection.
- Build provider selection.
- Build date and time selection.
- Build customer-details form.
- Build confirmation screen.
- Build booking-success screen.
- Build management-link screen.

## Integrations

- Add transactional outbox.
- Add BullMQ.
- Add Resend.
- Add booking confirmation email.
- Add Google OAuth.
- Add calendar selection.
- Add busy-period synchronization.
- Add calendar event creation.

## Conversational interfaces

- Create conversation-session model.
- Implement state machine.
- Implement chat UI.
- Implement structured intent extraction.
- Implement prepare-and-confirm actions.
- Add voice recorder.
- Add transcription.
- Add transcript editing.
- Add provider voice commands.

---

# 47. Definition of Done

A task is complete only when:

- Implementation is merged.
- Type checking passes.
- Unit tests exist.
- Relevant integration tests exist.
- Tenant isolation is verified.
- Errors use the standard response format.
- Logs contain request context.
- Sensitive data is not logged.
- API contracts are documented.
- Localization keys are included.
- Accessibility behavior is reviewed.
- Audit events are added for important writes.
- Metrics are added where appropriate.
- Deployment succeeds in staging.

---

# 48. MVP Release Gate

The MVP is ready for a Sunshine Dental pilot when:

1. Sunshine Dental can configure providers and services.
2. Working hours and exceptions can be managed.
3. Customers can book through forms.
4. Customers can book through chat.
5. Customers can use push-to-talk for slot search and booking.
6. Providers can block or open availability using voice.
7. Concurrent bookings cannot exceed capacity.
8. Confirmed bookings synchronize with Google Calendar.
9. Email confirmations are delivered.
10. Hungarian and English are supported.
11. Voice usage is metered.
12. Raw audio is deleted by default.
13. All write actions require confirmation.
14. Tenant isolation tests pass.
15. Backup and restore procedures have been tested.

---

# 49. First Production Architecture

```text
Internet
   │
   ▼
Coolify reverse proxy
   │
   ├── Next.js PWA
   │
   ├── Fastify API
   │
   └── Worker
          │
          ├── PostgreSQL
          ├── Redis
          ├── Google Calendar
          ├── OpenAI APIs
          ├── Resend
          └── Sentry
```

This architecture is sufficient for the first production tenants.

Separate microservices should only be introduced when actual scaling, security, or team-ownership requirements justify them.

---

# 50. Final Engineering Recommendation

The implementation should begin with a complete deterministic booking workflow before any AI or voice functionality is introduced.

The correct technical progression is:

```text
Reliable booking engine
        ↓
Google Calendar integration
        ↓
Chat-based tool orchestration
        ↓
Push-to-talk voice input
        ↓
Optional realtime voice
```

This ensures that voice remains a replaceable interface over a reliable transactional system rather than becoming the foundation of the booking logic.

The strongest first coding milestone is **Epic 0 through the first half of Epic 4**, ending with a form-based booking that safely creates a temporary hold and prevents overlapping reservations.
