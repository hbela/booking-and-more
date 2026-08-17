Below is a build-ready PRD based on a white-label booking SaaS with forms, chat, push-to-talk voice, Google Calendar synchronization, and optional realtime voice.

# Voice-Enabled Booking Engine

## Product Requirements Document

**Document version:** 1.0
**Product type:** Multi-tenant SaaS booking platform
**Initial market:** Service businesses such as dental clinics, doctors, consultants, beauty salons, therapists, repair services, and professional service providers
**Primary platforms:** Responsive web application and installable PWA
**Planned mobile support:** Expo React Native application
**Backend:** Fastify, TypeScript, PostgreSQL
**Calendar integration:** Google Calendar
**Voice strategy:** Push-to-talk by default, optional realtime voice as a premium feature

---

# 1. Product Summary

The Voice-Enabled Booking Engine is a multi-tenant booking platform that allows:

1. Service providers to manage their schedules and availability using voice, chat, or a conventional dashboard.
2. Customers to search for available services and book appointments using voice, chat, or standard forms.
3. Businesses to connect their Google Calendars without making Google Calendar the sole source of booking availability.
4. Voice interactions to remain significantly less expensive than traditional telephone-based voice agents.

The system will use voice as an input and output interface over a deterministic booking engine.

The AI layer may interpret requests and call approved application tools, but it must not independently determine availability, modify calendars, or create bookings without backend validation.

---

# 2. Product Vision

Enable any service business to offer a modern, multilingual, voice-enabled booking experience without requiring:

- A telephone voice agent
- A call center
- Complex chatbot configuration
- Expensive always-connected realtime audio
- Manual calendar administration
- Custom booking software development

The long-term vision is to create a reusable booking infrastructure that supports:

- White-label booking applications
- Embeddable booking widgets
- Provider-specific booking pages
- Voice-based schedule administration
- Cross-provider service discovery
- ChatGPT and assistant integrations
- Marketplace-style provider search

---

# 3. Problem Statement

Traditional booking systems rely heavily on forms, manual calendar management, phone calls, and administrative staff.

Customers may struggle with:

- Finding suitable appointment times
- Navigating complex booking forms
- Understanding service options
- Booking in a non-native language
- Rescheduling or cancelling appointments
- Using small mobile interfaces
- Calling during business hours

Service providers may struggle with:

- Keeping working hours up to date
- Managing schedule exceptions
- Synchronizing personal and business calendars
- Handling cancellations and rescheduling
- Avoiding double bookings
- Answering repetitive booking calls
- Training staff to use complex scheduling systems

Existing voice agents can solve some of these problems, but telephone-based agents introduce significant recurring costs for:

- Telephony
- Speech-to-text
- Language-model processing
- Text-to-speech
- Long-running realtime sessions
- Voice orchestration platforms

The proposed product reduces these costs by using short push-to-talk interactions over web and mobile interfaces.

---

# 4. Product Principles

## 4.1 The booking engine is authoritative

The database and booking service determine whether a slot is available.

The language model may request a booking operation, but it cannot override business rules.

## 4.2 Voice is an interface, not the business logic

Forms, chat, and voice use the same backend operations.

```text
Forms
Chat
Push-to-talk voice
Optional realtime voice
        ↓
Booking application tools
        ↓
Fastify booking engine
        ↓
PostgreSQL and calendar synchronization
```

## 4.3 Write operations require confirmation

Actions that modify schedules or bookings must be confirmed by the user.

Examples:

- Creating a booking
- Cancelling a booking
- Rescheduling a booking
- Blocking provider availability
- Changing recurring working hours
- Opening additional appointment times

## 4.4 Visual confirmation accompanies voice

Important information must be shown on screen, even when the interaction is voice-first.

The user must be able to review:

- Recognized speech
- Selected service
- Provider
- Date and time
- Duration
- Price, when applicable
- Customer details
- Cancellation policy
- Final action

## 4.5 Cost-efficient voice is the default

The default interaction model is:

1. User presses and holds a microphone button.
2. User speaks a short command.
3. Audio recording stops.
4. Speech is transcribed.
5. The application interprets the request.
6. The backend executes a read-only operation or presents a confirmation.
7. The response appears as text.
8. The response may optionally be spoken using device text-to-speech.

Realtime speech-to-speech is not required for the MVP.

---

# 5. Goals

## 5.1 Primary goals

- Allow providers to manage availability using natural voice commands.
- Allow customers to find and book appointments using voice.
- Support standard forms and chat as alternatives to voice.
- Synchronize bookings with Google Calendar.
- Prevent double bookings.
- Support multiple providers, services, locations, and calendars.
- Create a reusable multi-tenant SaaS architecture.
- Keep voice-processing costs predictable.
- Support Hungarian and English in the first production version.
- Provide a foundation for German and additional languages.

## 5.2 Secondary goals

- Reduce the number of incoming booking-related phone calls.
- Reduce staff time spent managing calendars.
- Improve mobile booking conversion.
- Improve accessibility.
- Support white-label deployments.
- Allow businesses to embed booking functionality on existing websites.
- Provide appointment reminders and confirmations.

## 5.3 Non-goals for the MVP

- Telephone calling
- Outbound marketing calls
- Full call-center functionality
- Emergency medical triage
- Medical diagnosis
- Insurance eligibility verification
- Complex marketplace ranking
- Customer reviews
- Commission-based marketplace payments
- Fully autonomous booking without confirmation
- Supporting every calendar provider
- Native iOS and Android applications at initial launch
- Open-ended general-purpose AI assistance

---

# 6. Target Users

## 6.1 Business owner

Examples:

- Dental clinic owner
- Private doctor
- Beauty salon owner
- Consultant
- Therapist
- Repair service owner

Primary needs:

- Configure services and availability
- Connect Google Calendar
- Manage staff and providers
- Review bookings
- Block unavailable periods
- Open additional appointment times
- Monitor booking activity
- Control branding and settings

## 6.2 Service provider

Examples:

- Dentist
- Dental hygienist
- Doctor
- Hairdresser
- Therapist
- Consultant

Primary needs:

- Review personal schedule
- Manage availability
- Block time
- Reschedule appointments
- View customer details
- Receive notifications

## 6.3 Receptionist or assistant

Primary needs:

- Create bookings for customers
- Search schedules
- Reschedule appointments
- Cancel appointments
- Manage patient or customer details
- Review voice interaction history
- Correct booking errors

## 6.4 Customer

Primary needs:

- Find a suitable service
- Find available times
- Book an appointment
- Reschedule or cancel
- Receive confirmation
- Use voice, chat, or forms
- Use the application without creating a password when permitted

## 6.5 Platform administrator

Primary needs:

- Manage tenants
- Review usage
- Monitor voice costs
- Suspend abusive accounts
- Manage subscriptions
- Review system health
- Investigate failed integrations

---

# 7. Primary Use Cases

## 7.1 Provider manages availability by voice

The provider says:

> “Block my calendar this Friday from 1 PM until 5 PM.”

The system:

1. Transcribes the request.
2. Resolves the date in the provider’s timezone.
3. Detects affected appointments.
4. Displays the proposed action.
5. Warns about conflicts.
6. Requests confirmation.
7. Creates an availability exception.
8. Synchronizes the change with Google Calendar when applicable.
9. Records the audit event.

## 7.2 Provider opens additional appointment time

The provider says:

> “Open next Saturday from 9 AM until 1 PM for dental cleanings.”

The system:

1. Identifies the provider.
2. Resolves the date and timezone.
3. Identifies the service.
4. Validates service duration and buffers.
5. Generates possible slots.
6. Displays a preview.
7. Requests confirmation.
8. Creates an availability exception.

## 7.3 Customer searches for an appointment

The customer says:

> “I need a dental cleaning next Wednesday after 4 PM.”

The system:

1. Transcribes the request.
2. Extracts the service.
3. Resolves the date.
4. Resolves the time window.
5. Searches available providers and locations.
6. Returns a small number of suitable options.
7. Allows the customer to select one by voice or touch.

## 7.4 Customer books an appointment

The customer selects a slot.

The system:

1. Verifies the slot.
2. Creates a temporary hold.
3. Collects required customer information.
4. Presents the final booking summary.
5. Requests explicit confirmation.
6. Converts the hold into a confirmed booking.
7. Creates the Google Calendar event.
8. Sends confirmation.
9. Records an audit event.

## 7.5 Customer reschedules an appointment

The customer identifies the booking using:

- Secure booking link
- Booking reference
- Authenticated account
- Email verification
- SMS verification in a later version

The system:

1. Retrieves the booking.
2. Searches replacement slots.
3. Places a hold on the selected slot.
4. Shows the change summary.
5. Requests confirmation.
6. Updates the booking transactionally.
7. Updates the calendar event.
8. Sends an updated confirmation.

---

# 8. User Experience Modes

## 8.1 Form mode

Traditional visual booking flow.

Suitable for:

- Users who prefer direct control
- Accessibility fallback
- Low-bandwidth environments
- Situations where microphone access is unavailable

## 8.2 Chat mode

Text-based conversational booking.

Example:

> Customer: I need a cleaning next Tuesday afternoon.

> Application: I found appointments at 2:00 PM, 3:30 PM, and 5:00 PM. Which time works best?

## 8.3 Push-to-talk voice mode

Default voice experience.

Interaction:

1. Press microphone button.
2. Speak.
3. Release or tap stop.
4. Review transcript.
5. Submit automatically or edit before submission.
6. Receive text and optional spoken response.

## 8.4 Realtime conversation mode

Optional premium mode.

Characteristics:

- Continuous conversational session
- User interruption
- Spoken responses
- Tool calling
- Session duration limits
- Usage quotas
- Higher cost

Realtime mode must use the same booking tools and confirmation rules as all other interfaces.

---

# 9. Functional Requirements

# 9.1 Tenant management

The platform must support multiple independent businesses.

Each tenant must have:

- Name
- Slug
- Logo
- Brand colors
- Default language
- Default timezone
- Contact details
- Booking URL
- Cancellation policy
- Privacy policy
- Booking settings
- Notification settings
- Subscription plan
- Usage limits

Example booking URL:

```text
https://booking.example.com/sunshine-dental
```

Optional custom domain:

```text
https://booking.sunshine-dental.hu
```

---

# 9.2 User authentication and authorization

Supported roles:

```ts
type Role = "PLATFORM_ADMIN" | "OWNER" | "ADMIN" | "PROVIDER" | "ASSISTANT" | "CUSTOMER";
```

Permissions must be tenant-scoped.

Examples:

- OWNER can manage billing and tenant settings.
- ADMIN can manage services, staff, schedules, and bookings.
- PROVIDER can manage their own availability and appointments.
- ASSISTANT can manage bookings but not billing.
  > **Deviation, 2026-08-17** — an ASSISTANT manages the bookings of the providers who have *delegated*
  > their diary to them, not every booking in the organization, and a grant may also cover that provider's
  > availability. See [phase-3-4-diary-delegation.md](phase-3-4-diary-delegation.md) §2.1 for why the
  > all-or-nothing reading was the wrong model, and §2.2 for the migration that kept existing behaviour
  > intact. §6.3's persona is unchanged; only its reach is.
- CUSTOMER can manage their own bookings.
- PLATFORM_ADMIN can manage platform-level operations.

Customer booking may support guest checkout.

Provider and staff actions require authentication.

---

# 9.3 Provider management

The system must allow authorized users to:

- Create providers
- Edit provider profiles
- Assign providers to locations
- Assign services to providers
- Assign calendars
- Define provider languages
- Define provider-specific working hours
- Enable or disable online booking
- Configure minimum notice
- Configure maximum advance booking period
- Configure service-specific buffers

Provider fields:

```ts
interface Provider {
  id: string;
  tenantId: string;
  userId?: string;
  displayName: string;
  description?: string;
  timezone: string;
  languages: string[];
  active: boolean;
  onlineBookingEnabled: boolean;
}
```

> **Recorded deviation — `userId` is on the membership, not the provider.**
> The implementation reversed this pointer in Epic 2 and it is not coming back:
> `memberships.provider_id` carries it, with a unique index so at most one login can hold a diary. The
> reasons are that a provider is a **diary** rather than a login — the front desk can keep a visiting
> hygienist's schedule for somebody with no account — and that a _role_ belongs to a membership, so the
> thing that says "this person is the provider here" belongs beside the thing that says "this person is an
> admin there". Pointing from the provider would also make a second organization's diary for the same person
> ambiguous. See [phase-2-providers-services-locations.md](phase-2-providers-services-locations.md) §3.2 and
> [phase-9-provider-onboarding.md](phase-9-provider-onboarding.md), which is where the link finally gets
> populated as part of accepting an invitation. Never written down until 2026-08-04.

---

# 9.4 Service management

Each tenant may configure multiple services.

Service fields:

```ts
interface Service {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  price?: number;
  currency?: string;
  active: boolean;
  requiresApproval: boolean;
  maximumAdvanceDays?: number;
  minimumNoticeMinutes?: number;
}
```

The service may be assigned to:

- One or more providers
- One or more locations
- Specific rooms or equipment
- Specific booking rules

---

# 9.5 Location management

The system must support:

- Physical locations
- Online appointments
- Home visits
- Telephone consultations

Location fields:

- Name
- Address
- Timezone
- Geographic coordinates
- Contact details
- Active status
- Supported services
- Assigned providers

---

# 9.6 Availability management

Availability must support:

- Weekly recurring schedules
- Date-specific exceptions
- Breaks
- Holidays
- Additional opening periods
- Provider-specific rules
- Location-specific rules
- Service-specific rules
- Busy intervals from external calendars

Example recurring schedule:

```json
{
  "weekday": 1,
  "startTime": "09:00",
  "endTime": "17:00"
}
```

Example exception:

```json
{
  "date": "2026-07-31",
  "type": "UNAVAILABLE",
  "startTime": "13:00",
  "endTime": "17:00",
  "reason": "Personal appointment"
}
```

Availability calculation must consider:

```text
Recurring working hours
+ Additional opening periods
- Availability exceptions
- Existing bookings
- Booking buffers
- External calendar busy periods
- Required resources
- Temporary slot holds
- Minimum notice rules
- Maximum booking window
```

---

# 9.7 Slot generation

The backend must generate bookable slots based on:

- Service duration
- Buffer duration
- Provider availability
- Location availability
- Resource availability
- Existing bookings
- External calendar busy periods
- Slot interval
- Tenant timezone
- Provider timezone
- Customer-requested time window

Example request:

```http
GET /v1/public/tenants/:tenantSlug/slots
  ?serviceId=service_123
  &providerId=provider_456
  &dateFrom=2026-08-01
  &dateTo=2026-08-07
```

Example response:

```json
{
  "slots": [
    {
      "providerId": "provider_456",
      "serviceId": "service_123",
      "startAt": "2026-08-05T14:00:00+02:00",
      "endAt": "2026-08-05T14:30:00+02:00",
      "locationId": "location_789"
    }
  ]
}
```

Returned slots are proposals and are not guaranteed until a hold is created.

---

# 9.8 Slot holds

The system must support temporary holds.

Default hold duration:

```text
5 minutes
```

Hold lifecycle:

```text
AVAILABLE
   ↓
HELD
   ↓
CONFIRMED
```

Alternative lifecycle:

```text
HELD
   ↓
EXPIRED
   ↓
AVAILABLE
```

A hold must include:

- Tenant
- Provider
- Service
- Location
- Start and end time
- Customer session
- Expiration time
- Status

The system must prevent multiple active holds for the same exclusive capacity.

---

# 9.9 Booking management

Booking statuses:

```ts
type BookingStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW" | "EXPIRED";
```

Booking fields:

```ts
interface Booking {
  id: string;
  tenantId: string;
  customerId?: string;
  providerId: string;
  serviceId: string;
  locationId?: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  notes?: string;
  source: "FORM" | "CHAT" | "VOICE" | "STAFF" | "API";
  calendarEventId?: string;
  createdAt: string;
  updatedAt: string;
}
```

Authorized users must be able to:

- Create bookings
- View bookings
- Update booking details
- Reschedule bookings
- Cancel bookings
- Mark appointments completed
- Mark no-shows
- Search and filter bookings

---

# 9.10 Google Calendar integration

The platform must support Google OAuth for business users.

Required capabilities:

- Connect a Google account
- Select one or more calendars
- Read busy intervals
- Create booking events
- Update booking events
- Delete or cancel booking events
- Detect externally modified events
- Reconnect expired authorization
- Disconnect integration

The system must not depend on calendar event titles to identify bookings.

The database must store:

- Integration account ID
- Calendar ID
- External event ID
- Synchronization status
- Last synchronization time
- Token metadata
- Error state

OAuth refresh tokens must be encrypted at rest.

Calendar synchronization failures must not silently delete or invalidate confirmed bookings.

The database remains authoritative for platform bookings.

---

# 9.11 Voice transcription

The application must:

- Request microphone permission
- Record audio
- Display recording state
- Allow cancellation
- Limit recording duration
- Upload audio securely
- Transcribe the audio
- Display the transcript
- Allow transcript correction
- Submit the final transcript for interpretation

Recommended maximum command duration for the MVP:

```text
30 seconds
```

The application should warn users before recording begins if audio is transmitted to a third-party AI provider.

Raw audio retention should be disabled by default.

---

# 9.12 Voice command interpretation

The language model must produce structured commands rather than free-form actions.

Example owner command:

```json
{
  "intent": "BLOCK_TIME",
  "confidence": 0.94,
  "parameters": {
    "providerId": "provider_123",
    "date": "2026-07-31",
    "startTime": "13:00",
    "endTime": "17:00"
  },
  "requiresConfirmation": true
}
```

Example customer command:

```json
{
  "intent": "SEARCH_SLOTS",
  "confidence": 0.91,
  "parameters": {
    "service": "dental cleaning",
    "dateFrom": "2026-08-05",
    "dateTo": "2026-08-05",
    "timeFrom": "16:00",
    "timeTo": "20:00",
    "language": "en"
  },
  "requiresConfirmation": false
}
```

The system must validate all structured output using a schema library such as Zod.

Invalid or incomplete commands must not be executed.

---

# 9.13 Supported voice intents

## Provider intents

```text
GET_TODAY_SCHEDULE
GET_SCHEDULE
GET_FREE_PERIODS
BLOCK_TIME
OPEN_ADDITIONAL_TIME
SET_RECURRING_HOURS
REMOVE_AVAILABILITY_EXCEPTION
CREATE_BOOKING
RESCHEDULE_BOOKING
CANCEL_BOOKING
GET_BOOKING_DETAILS
```

## Customer intents

```text
LIST_SERVICES
GET_SERVICE_DETAILS
SEARCH_SLOTS
SELECT_SLOT
HOLD_SLOT
CREATE_BOOKING
GET_BOOKING
RESCHEDULE_BOOKING
CANCEL_BOOKING
GET_LOCATION_DETAILS
GET_PROVIDER_DETAILS
```

## Unsupported intent handling

When the request is outside scope, the assistant must respond with a bounded message.

Example:

> “I can help you find, book, reschedule, or cancel an appointment. I cannot provide medical advice.”

---

# 9.14 Confirmation workflow

Every write operation must follow this lifecycle:

```text
UNDERSTAND
   ↓
VALIDATE
   ↓
PREVIEW
   ↓
CONFIRM
   ↓
EXECUTE
   ↓
REPORT RESULT
```

Example confirmation card:

```text
Block availability

Provider: Dr. Anna Kovács
Date: Friday, July 31, 2026
Time: 1:00 PM–5:00 PM
Affected appointments: 0

[Confirm] [Edit] [Cancel]
```

Voice confirmation may be accepted using statements such as:

- “Yes”
- “Confirm”
- “Go ahead”
- “Book it”

Ambiguous statements must not be treated as confirmation.

---

# 9.15 Conversation state

The system must maintain a server-side conversation state.

Example state:

```ts
interface BookingConversationState {
  sessionId: string;
  tenantId: string;
  userId?: string;
  role: "OWNER" | "PROVIDER" | "ASSISTANT" | "CUSTOMER";
  language: string;
  timezone: string;
  currentIntent?: string;
  collectedFields: Record<string, unknown>;
  selectedServiceId?: string;
  selectedProviderId?: string;
  selectedSlot?: {
    startAt: string;
    endAt: string;
  };
  holdId?: string;
  pendingAction?: {
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expiresAt: string;
}
```

The language model must not be the sole storage location for booking state.

---

# 9.16 Customer information collection

Required fields must be configurable per tenant and service.

Possible fields:

- Full name
- Email
- Phone number
- Date of birth
- Notes
- Preferred language
- Consent acceptance
- New or returning customer

Sensitive data collection must be minimized.

Medical or clinical details must not be collected in the MVP unless a separate compliant workflow is implemented.

---

# 9.17 Notifications

The MVP should support email notifications.

Notification types:

- Booking confirmation
- Booking updated
- Booking cancelled
- Provider notification
- Reminder
- Calendar synchronization failure
- Integration disconnected

Later versions may support:

- SMS
- Push notifications
- WhatsApp
- Telegram

Reminder timing must be configurable.

Example:

- 24 hours before
- 2 hours before

---

# 9.18 Booking links

Each confirmed booking must receive a secure management link.

The link may allow the customer to:

- View booking
- Add to calendar
- Reschedule
- Cancel
- Update contact information

The token must:

- Be cryptographically random
- Be revocable
- Expire according to policy
- Avoid exposing sequential booking IDs

---

# 9.19 Searchable provider network

This feature is not required for the first MVP but should be considered in the data model.

Future search filters may include:

- Service
- Location
- Distance
- Language
- Date
- Time window
- Price
- Remote availability
- Earliest available appointment

Providers must explicitly opt in to public discovery.

---

# 10. Voice Interaction Requirements

## 10.1 Transcript-first experience

The user must see what the application understood.

Example:

```text
You said:
“I need a cleaning next Wednesday afternoon.”
```

The user can:

- Accept
- Edit
- Record again
- Cancel

## 10.2 Handling relative dates

The system must resolve relative expressions using:

- Current date
- Tenant timezone
- Provider timezone
- User timezone when available

Examples:

- Tomorrow
- Next Tuesday
- This Friday
- In two weeks
- After lunch
- Early afternoon
- Around 5

Before a write operation, the system must show the absolute date and time.

## 10.3 Handling ambiguity

Example:

> “Book me Friday afternoon.”

The system may ask:

> “Do you mean Friday, July 31, 2026?”

If multiple services match:

> “Do you want a dental cleaning or a dental examination?”

The system should ask one question at a time.

## 10.4 Error recovery

When transcription confidence is low:

> “I may have misunderstood the service name. Please say it again or select it from the list.”

When no slot is available:

> “There are no available appointments Wednesday after 4 PM. The closest alternatives are Thursday at 4:30 PM and Friday at 5:00 PM.”

## 10.5 Spoken responses

The MVP may use:

- Browser speech synthesis
- Device speech synthesis
- Text-only responses

Paid cloud text-to-speech should be optional.

Long responses should not be spoken in full.

---

# 11. Cost-Control Requirements

The platform must measure voice and AI usage per tenant.

Tracked metrics:

- Audio input duration
- Transcription requests
- Language-model input tokens
- Language-model output tokens
- Text-to-speech characters or audio duration
- Realtime session duration
- Failed requests
- Cost estimate per interaction
- Monthly tenant usage

Cost controls:

- Maximum recording duration
- Maximum conversation turns
- Session expiration
- Tenant monthly quotas
- Realtime voice disabled by default
- Cached service and provider descriptions
- Small model for intent extraction
- Deterministic responses where possible
- Device text-to-speech by default
- Summarized conversation context
- No continuous microphone streaming in standard mode

Example plan limits:

```text
Starter
- Forms and chat
- 100 voice commands per month
- No realtime mode

Professional
- 1,000 voice commands per month
- Optional realtime minutes

Enterprise
- Custom usage and limits
```

Exact commercial pricing is outside the scope of this PRD.

---

# 12. Non-Functional Requirements

## 12.1 Performance

Target response times:

- Dashboard API reads: under 500 ms at p95
- Slot search: under 1.5 seconds at p95
- Slot hold creation: under 800 ms at p95
- Booking confirmation: under 2 seconds excluding third-party delays
- Voice transcription: results should normally appear within several seconds
- Calendar synchronization should not block the booking transaction indefinitely

## 12.2 Availability

Initial target:

```text
99.5% monthly availability
```

Later target:

```text
99.9% monthly availability
```

## 12.3 Scalability

The architecture should support:

- Thousands of tenants
- Multiple providers per tenant
- Multiple locations per tenant
- High read volume for slot searches
- Background calendar synchronization
- Horizontal API scaling

## 12.4 Accessibility

The application should support:

- Keyboard navigation
- Visible focus states
- Screen readers
- High contrast
- Text alternatives
- Form fallback for every voice action
- Captions and transcripts
- Large touch targets

Target standard:

```text
WCAG 2.1 AA
```

## 12.5 Localization

Initial languages:

- Hungarian
- English

Planned languages:

- German
- French

Localization must cover:

- Interface text
- Voice prompts
- Email notifications
- Dates
- Times
- Numbers
- Currency
- Timezones
- Service names and descriptions

Internal values should remain language-neutral.

---

# 13. Security Requirements

## 13.1 Authentication

- Secure session cookies for web
- Token-based authentication for mobile
- Passwordless or OAuth support may be added
- Multi-factor authentication should be considered for owners and administrators

## 13.2 Authorization

Every protected API request must validate:

- User identity
- Tenant membership
- Role
- Resource ownership
- Requested action

Tenant IDs supplied by clients must not be trusted without server-side membership validation.

## 13.3 Data protection

- TLS for all network communication
- Encryption for OAuth refresh tokens
- Secure secret management
- No API keys in frontend applications
- Sensitive values redacted from logs
- Configurable data retention
- Audit logging for administrative actions

## 13.4 Voice security

- Audio uploads must use authenticated or short-lived signed requests
- Audio file type and size must be validated
- Recordings must not be publicly accessible
- Raw recordings should be deleted after transcription by default
- Voice commands must not bypass authorization
- Transcripts must be treated as untrusted input

## 13.5 Tool-calling security

The language model must only access an allowlist of tools.

Each tool must independently enforce:

- Authentication
- Authorization
- Input validation
- Business rules
- Idempotency
- Audit logging

The AI must never receive direct database credentials or Google OAuth tokens.

---

# 14. Privacy and Compliance

The product must support GDPR-oriented privacy controls.

Required capabilities:

- Privacy notice
- Consent where required
- Data export
- Data correction
- Data deletion
- Retention controls
- Processor and subprocessor documentation
- Audit logs
- Tenant data isolation
- Configurable voice recording retention
- Data processing agreements for business customers

The product must clearly distinguish:

- Booking and contact data
- Voice recordings
- Voice transcripts
- Calendar data
- Application analytics
- AI provider processing

For healthcare customers, the MVP should be positioned as an appointment scheduling system rather than a medical record system.

The MVP must avoid collecting unnecessary medical information.

---

# 15. Proposed Technical Architecture

```text
┌────────────────────────────────────────────┐
│ Next.js web application / PWA              │
│                                            │
│ Public booking                             │
│ Staff dashboard                            │
│ Chat interface                             │
│ Push-to-talk interface                     │
│ Confirmation cards                         │
└─────────────────────┬──────────────────────┘
                      │ HTTPS
                      ▼
┌────────────────────────────────────────────┐
│ Fastify API                                │
│                                            │
│ Authentication and RBAC                    │
│ Tenant management                          │
│ Service management                         │
│ Availability engine                        │
│ Slot generation                            │
│ Booking orchestration                      │
│ Voice command orchestration                │
│ Calendar integration                       │
│ Notification orchestration                 │
└─────────────┬───────────────┬──────────────┘
              │               │
              ▼               ▼
┌─────────────────────┐  ┌───────────────────┐
│ PostgreSQL          │  │ Background worker │
│                     │  │                   │
│ Tenants             │  │ Reminders         │
│ Users               │  │ Hold expiration   │
│ Providers           │  │ Calendar sync     │
│ Availability        │  │ Retry processing  │
│ Bookings            │  │ Notifications     │
│ Holds               │  │ Usage aggregation │
│ Integrations        │  └─────────┬─────────┘
│ Audit logs          │            │
└─────────────────────┘            ▼
                         ┌────────────────────┐
                         │ External services  │
                         │                    │
                         │ Google Calendar    │
                         │ Email provider     │
                         │ Speech-to-text     │
                         │ Language model     │
                         │ Optional TTS       │
                         └────────────────────┘
```

---

# 16. Recommended Technology Stack

## Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- Shadcn UI or Material UI
- TanStack Query
- React Hook Form
- Zod
- Web Audio API or MediaRecorder
- PWA support

## Backend

- Fastify
- TypeScript
- Zod
- PostgreSQL
- Prisma or Drizzle
- Redis for short-lived state, rate limits, and queues
- Background worker process
- OpenAPI documentation

## Integrations

- Google OAuth
- Google Calendar API
- OpenAI speech-to-text
- Small language model with structured output
- Browser or device speech synthesis
- Resend or comparable email provider
- Sentry
- Structured application logging

## Deployment

- Docker
- Hetzner VPS
- Coolify
- Managed or self-hosted PostgreSQL
- Redis
- Object storage only when audio retention is enabled

---

# 17. Core Data Model

Primary entities:

```text
Tenant
User
Membership
Provider
Service
ProviderService
Location
ProviderLocation
WorkingHours
AvailabilityException
Resource
Booking
BookingHold
Customer
CalendarIntegration
CalendarMapping
CalendarEventMapping
ConversationSession
VoiceInteraction
Notification
AuditLog
UsageRecord
Subscription
```

## 17.1 Important relationships

```text
Tenant
 ├── Memberships
 ├── Providers
 ├── Services
 ├── Locations
 ├── Customers
 ├── Bookings
 ├── CalendarIntegrations
 └── UsageRecords

Provider
 ├── Services
 ├── Locations
 ├── WorkingHours
 ├── AvailabilityExceptions
 └── Bookings

Booking
 ├── Customer
 ├── Provider
 ├── Service
 ├── Location
 ├── CalendarEventMapping
 └── AuditLogs
```

---

# 18. Booking Concurrency Design

Double-booking prevention must be implemented at the database level.

Recommended approach:

1. Start database transaction.
2. Lock relevant capacity record or slot.
3. Recalculate availability.
4. Reject if no capacity remains.
5. Create hold.
6. Commit transaction.

During confirmation:

1. Start transaction.
2. Lock hold.
3. Verify hold is active and unexpired.
4. Verify availability again.
5. Create booking.
6. Mark hold as confirmed.
7. Commit transaction.
8. Create calendar event asynchronously or synchronously with bounded timeout.

For providers with exclusive capacity, PostgreSQL exclusion constraints may be considered.

Conceptual rule:

```text
A provider cannot have overlapping active bookings unless capacity is greater than one.
```

Calendar synchronization must not be relied on as the locking mechanism.

---

# 19. API Requirements

## 19.1 Public booking APIs

```http
GET    /v1/public/tenants/:slug
GET    /v1/public/tenants/:slug/services
GET    /v1/public/tenants/:slug/providers
GET    /v1/public/tenants/:slug/slots
POST   /v1/public/holds
POST   /v1/public/bookings
GET    /v1/public/bookings/:token
POST   /v1/public/bookings/:token/reschedule
POST   /v1/public/bookings/:token/cancel
```

## 19.2 Staff APIs

```http
GET    /v1/bookings
POST   /v1/bookings
GET    /v1/bookings/:id
PATCH  /v1/bookings/:id
POST   /v1/bookings/:id/reschedule
POST   /v1/bookings/:id/cancel

GET    /v1/providers
POST   /v1/providers
PATCH  /v1/providers/:id

GET    /v1/services
POST   /v1/services
PATCH  /v1/services/:id

GET    /v1/availability
POST   /v1/availability/exceptions
PATCH  /v1/availability/exceptions/:id
DELETE /v1/availability/exceptions/:id
```

## 19.3 Voice APIs

```http
POST   /v1/voice/transcriptions
POST   /v1/voice/interpret
POST   /v1/voice/sessions
GET    /v1/voice/sessions/:id
POST   /v1/voice/sessions/:id/messages
POST   /v1/voice/sessions/:id/confirm
POST   /v1/voice/sessions/:id/cancel
```

## 19.4 Calendar APIs

```http
GET    /v1/integrations/google/connect
GET    /v1/integrations/google/callback
GET    /v1/integrations/google/calendars
POST   /v1/integrations/google/calendars/select
POST   /v1/integrations/google/sync
DELETE /v1/integrations/google
```

---

# 20. AI Tool Definitions

The AI orchestration layer may call application tools such as:

```ts
interface BookingTools {
  listServices(input: ListServicesInput): Promise<ListServicesResult>;
  findAvailableSlots(input: FindAvailableSlotsInput): Promise<FindAvailableSlotsResult>;
  createSlotHold(input: CreateSlotHoldInput): Promise<CreateSlotHoldResult>;
  prepareBooking(input: PrepareBookingInput): Promise<BookingPreview>;
  confirmBooking(input: ConfirmBookingInput): Promise<BookingResult>;
  getBooking(input: GetBookingInput): Promise<BookingResult>;
  prepareReschedule(input: PrepareRescheduleInput): Promise<ReschedulePreview>;
  confirmReschedule(input: ConfirmRescheduleInput): Promise<BookingResult>;
  prepareCancellation(input: PrepareCancellationInput): Promise<CancellationPreview>;
  confirmCancellation(input: ConfirmCancellationInput): Promise<BookingResult>;
}
```

Owner tools:

```ts
interface AvailabilityTools {
  getSchedule(input: GetScheduleInput): Promise<ScheduleResult>;
  findFreePeriods(input: FindFreePeriodsInput): Promise<FreePeriodResult>;
  prepareBlockTime(input: BlockTimeInput): Promise<BlockTimePreview>;
  confirmBlockTime(input: ConfirmActionInput): Promise<ActionResult>;
  prepareOpenTime(input: OpenTimeInput): Promise<OpenTimePreview>;
  confirmOpenTime(input: ConfirmActionInput): Promise<ActionResult>;
}
```

The distinction between `prepare` and `confirm` should be enforced in code.

---

# 21. Observability

The platform must collect:

- Request logs
- Error logs
- Booking lifecycle events
- Calendar synchronization events
- Voice transcription failures
- AI interpretation failures
- Confirmation abandonment
- Slot search latency
- Hold expiration
- Notification delivery status
- Usage and cost estimates

Each request should include:

- Request ID
- Tenant ID
- User ID when available
- Session ID
- Booking ID when applicable

Sensitive customer data must be redacted.

---

# 22. Analytics and Product Metrics

## 22.1 Activation metrics

- Tenant created
- First provider created
- First service created
- Google Calendar connected
- First availability configured
- First successful booking

## 22.2 Booking metrics

- Slot searches
- Booking-start rate
- Booking completion rate
- Booking abandonment rate
- Reschedule rate
- Cancellation rate
- No-show rate
- Average time to complete booking

## 22.3 Voice metrics

- Voice button usage
- Successful transcription rate
- Transcript correction rate
- Successful intent recognition rate
- Average turns per completed booking
- Voice-to-booking conversion
- Average audio duration
- Average AI cost per completed booking
- Voice fallback to form rate

## 22.4 Business metrics

- Active tenants
- Active providers
- Monthly bookings
- Monthly recurring revenue
- Customer acquisition cost
- Tenant churn
- Revenue per tenant
- AI and infrastructure cost per tenant

---

# 23. MVP Scope

## 23.1 Included

- Multi-tenant architecture
- Owner and provider authentication
- Tenant settings
- Provider management
- Service management
- One or more locations
- Recurring working hours
- Availability exceptions
- Public booking page
- Slot search
- Slot holds
- Booking confirmation
- Booking cancellation
- Booking rescheduling
- Google Calendar connection
- Google Calendar busy-time lookup
- Calendar event creation and update
- Email confirmations
- Push-to-talk voice input
- Speech transcription
- Structured intent extraction
- Visual confirmation cards
- Hungarian and English
- Usage logging
- Audit logging
- Basic admin dashboard

## 23.2 Excluded

- Telephone integration
- Realtime speech-to-speech
- SMS
- Payments
- Marketplace discovery
- Reviews
- Native mobile applications
- Multiple external calendar providers
- Advanced healthcare records
- Insurance workflows
- AI-generated medical advice

---

# 24. Delivery Phases

## Phase 0 — Technical foundation

Deliverables:

- Monorepo
- Fastify API
- Next.js application
- PostgreSQL
- Authentication
- Multi-tenant authorization
- Docker development environment
- CI pipeline
- Error monitoring

Exit criteria:

- Tenant-scoped users can sign in.
- Cross-tenant access is blocked.
- API documentation is available.
- Production deployment works.

## Phase 1 — Deterministic booking engine

Deliverables:

- Providers
- Services
- Locations
- Working hours
- Exceptions
- Slot calculation
- Holds
- Bookings
- Cancellation
- Rescheduling

Exit criteria:

- A customer can complete a booking using forms.
- Concurrent attempts cannot double-book a provider.
- Holds expire automatically.
- All booking actions are audited.

## Phase 2 — Google Calendar integration

Deliverables:

- Google OAuth
- Calendar selection
- Busy-time lookup
- Event creation
- Event update
- Event cancellation
- Synchronization retries
- Integration health status

Exit criteria:

- External busy periods remove conflicting slots.
- Confirmed bookings create calendar events.
- Rescheduling updates events.
- Integration failures are visible.

## Phase 3 — Chat booking

Deliverables:

- Chat interface
- Conversation sessions
- Structured tool calls
- Booking confirmation cards
- Error recovery
- Multilingual prompts

Exit criteria:

- A customer can book through chat.
- Chat uses the same booking APIs as forms.
- Write actions require confirmation.

## Phase 4 — Push-to-talk voice

Deliverables:

- Microphone recording
- Audio upload
- Transcription
- Transcript editing
- Voice intent extraction
- Provider voice commands
- Customer voice booking
- Device speech synthesis

Exit criteria:

- A customer can complete a booking using push-to-talk.
- A provider can block and open availability using voice.
- Every write action receives explicit confirmation.
- Voice usage is tracked per tenant.

## Phase 5 — Commercial SaaS features

Deliverables:

- Subscription plans
- Tenant usage limits
- Branding
- Custom domains
- Embeddable widget
- Billing dashboard
- Platform administration

## Phase 6 — Premium realtime voice

Deliverables:

- WebRTC realtime sessions
- Interruptible conversation
- Realtime tool calling
- Session duration limits
- Premium quotas
- Cost monitoring

## Phase 7 — Provider network

Deliverables:

- Public provider profiles
- Search across tenants
- Location and language filters
- Earliest-availability search
- Provider opt-in
- Marketplace governance

---

# 25. Acceptance Criteria

## 25.1 Customer booking

Given an available service and provider:

- The customer can search for slots.
- The customer can select a slot.
- The system can create a temporary hold.
- The customer can provide required details.
- The system shows a complete summary.
- The customer confirms the booking.
- The booking is stored transactionally.
- A calendar event is created.
- A confirmation email is sent.
- The slot is no longer available.

## 25.2 Voice booking

Given microphone permission:

- The customer can record a command.
- The transcript is displayed.
- The transcript can be edited.
- The system extracts the intended booking request.
- Matching slots are shown.
- The customer can select using voice or touch.
- The final booking requires confirmation.
- The voice interaction is included in usage metrics.

## 25.3 Provider voice management

Given an authenticated provider:

- The provider can request their schedule.
- The provider can ask for available periods.
- The provider can request a blocked period.
- The system identifies affected bookings.
- The system displays an action preview.
- The provider must confirm.
- The exception is saved.
- The new availability is reflected in slot searches.

## 25.4 Double-booking protection

Given two simultaneous booking attempts for the same slot:

- No more than the configured capacity can be confirmed.
- The losing request receives an availability conflict.
- The losing customer is offered updated alternatives.

---

# 26. Key Risks and Mitigations

## Risk: Incorrect speech recognition

Mitigation:

- Display transcript
- Allow correction
- Keep commands short
- Use service and provider vocabularies
- Confirm write actions

## Risk: Incorrect date interpretation

Mitigation:

- Resolve timezone explicitly
- Display absolute date
- Speak the final date back
- Require confirmation

## Risk: Double booking

Mitigation:

- Database transactions
- Row locking
- Exclusion constraints where appropriate
- Temporary holds
- Availability recheck before confirmation

## Risk: Calendar synchronization failure

Mitigation:

- Database remains authoritative
- Retry queue
- Integration status dashboard
- Administrative alerts
- Idempotent calendar operations

## Risk: Unpredictable AI costs

Mitigation:

- Push-to-talk default
- Recording duration limits
- Small structured-output model
- Device speech synthesis
- Tenant quotas
- Cost tracking
- Realtime mode disabled by default

## Risk: AI tool misuse

Mitigation:

- Tool allowlist
- Independent authorization
- Zod validation
- Prepare-and-confirm pattern
- Audit logs
- Idempotency keys

## Risk: GDPR and healthcare concerns

Mitigation:

- Data minimization
- Configurable retention
- No medical records in MVP
- Transparent consent
- Processor agreements
- Tenant-controlled privacy settings

## Risk: Customer abandonment during conversational booking

Mitigation:

- Visual progress
- One question at a time
- Form fallback
- Preserve conversation state
- Offer a small number of choices
- Avoid unnecessary questions

---

# 27. Recommended Initial Vertical

The recommended first vertical is dental clinics because the product can be tested with Sunshine Dental.

Initial service examples:

- Dental examination
- Dental cleaning
- Consultation
- Emergency appointment request
- Dental hygiene treatment

The first implementation should avoid clinical triage.

For urgent requests, the application should display a clinic-defined message and contact method.

Example:

> “This booking service does not provide emergency medical advice. For urgent care, contact the clinic directly using the displayed telephone number.”

---

# 28. Recommended First Release

The first commercially useful release should include:

1. A white-label booking PWA.
2. Provider and service administration.
3. Google Calendar synchronization.
4. Public booking by form.
5. Public booking by chat.
6. Push-to-talk voice commands.
7. Provider voice availability management.
8. Email confirmations.
9. Hungarian and English support.
10. Usage and cost monitoring.

Recommended product positioning:

> A voice-enabled online booking system that lets customers book appointments and lets service providers manage availability by speaking—without the cost of a telephone voice agent.

---

# 29. Future Opportunities

- Embeddable React booking widget
- Native Expo application
- SMS and WhatsApp reminders
- Payment deposits
- Cancellation fees
- Group bookings
- Multi-resource bookings
- Waiting lists
- Automatic cancellation-slot offers
- AI-assisted schedule optimization
- Staff scheduling
- Cross-provider marketplace
- ChatGPT app integration
- MCP server for external assistants
- Outlook Calendar integration
- Apple Calendar integration
- Industry-specific templates
- Analytics and demand forecasting
- Voice-assisted customer intake
- Voice accessibility mode
- On-device speech recognition where supported

---

# 30. Open Product Decisions

The following decisions should be finalized before implementation:

1. Whether the first release is a generic SaaS or a Sunshine Dental-specific pilot.
2. Whether Google Calendar events are mirrored from bookings or treated as editable external records.
3. Whether guest customers must verify email before confirmation.
4. Whether customers can book without providing a phone number.
5. Whether services can require manual approval.
6. Whether prices are displayed during booking.
7. Whether booking deposits are planned for the second release.
8. Whether owners can connect multiple Google accounts.
9. Whether a provider can have multiple simultaneous bookings.
10. Whether raw voice recordings are ever retained.
11. Whether the initial public application is Next.js-only or includes Expo.
12. Which subscription and usage limits will be offered.

---

# 31. Final Product Decision

The MVP should not attempt to reproduce a general-purpose telephone voice agent.

It should provide a controlled booking workflow with:

- A deterministic booking engine
- A visual interface
- Chat
- Push-to-talk voice
- Explicit confirmations
- Google Calendar synchronization
- Optional realtime voice only when commercially justified

This design delivers the main convenience of voice booking while maintaining predictable costs, transactional safety, privacy, and control.

The next useful artifact is a technical implementation plan that turns this PRD into epics, database schemas, Fastify modules, API routes, and a phased development backlog.
