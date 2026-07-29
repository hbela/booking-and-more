import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Epic 4 through real HTTP.
 *
 * The arithmetic is proved in @bam/booking-engine and the exclusion constraint
 * in @bam/db, both without a stack. What is proved here is everything neither
 * can see: that a hold really removes a slot from the next search, that two
 * customers racing for one appointment end with one booking and one honest
 * error, that a management token reaches exactly one booking, and that none of
 * it crosses a tenant boundary.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Random and file-prefixed — see the note in catalogue.test.ts. */
const RUN = `bk${randomBytes(4).toString("hex")}`;

/** A Monday far enough ahead to clear any default booking window. */
const MONDAY = "2026-09-07";

describe.skipIf(!databaseUrl)("bookings", () => {
  let app: AppInstance;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });

    app = await buildApp({ env, logger: false, rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    // Explicit order: bookings hold a RESTRICT reference to customers, so the
    // tenant cascade cannot be relied on to unwind them in a safe sequence.
    const tenants = await app.prisma.tenant.findMany({
      where: { slug: { endsWith: RUN } },
      select: { id: true },
    });
    const tenantIds = tenants.map((tenant) => tenant.id);

    if (tenantIds.length > 0) {
      const where = { tenantId: { in: tenantIds } };
      await app.prisma.capacityReservation.deleteMany({ where });
      await app.prisma.booking.deleteMany({ where });
      await app.prisma.bookingHold.deleteMany({ where });
      await app.prisma.customer.deleteMany({ where });
      await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }

    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

  async function signUp(label: string): Promise<{ cookie: string; email: string; id: string }> {
    const email = `${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: "correct-horse-battery-staple", name: label },
    });
    expect(response.statusCode, `sign-up failed: ${response.body}`).toBeLessThan(400);

    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const cookie = cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie, email, id: user!.id };
  }

  function as(cookie: string, tenantId?: string) {
    return { cookie, ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }) };
  }

  /** A fresh idempotency key. Every write endpoint requires one. */
  function key(): Record<string, string> {
    return { "idempotency-key": randomBytes(12).toString("hex") };
  }

  interface Clinic {
    owner: { cookie: string; id: string };
    tenantId: string;
    slug: string;
    providerId: string;
    serviceId: string;
    locationId: string;
  }

  /**
   * A clinic in UTC with one provider working Monday 09:00-17:00.
   *
   * UTC deliberately: the zone arithmetic is exhaustively tested in the
   * availability engine, and using it here means a slot at "09:00" is the
   * instant the test names rather than something that has to be recomputed
   * every time a reader checks an assertion.
   */
  async function clinic(
    label: string,
    options: { requiresApproval?: boolean; durationMinutes?: number } = {},
  ): Promise<Clinic> {
    const owner = await signUp(label);
    const slug = `${label}-${RUN}`;

    const tenantResponse = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(owner.cookie),
      payload: { name: label, slug, defaultTimezone: "UTC", defaultLanguage: "en" },
    });
    expect(tenantResponse.statusCode, tenantResponse.body).toBe(201);
    const tenantId = tenantResponse.json().id as string;

    const create = async (url: string, payload: Record<string, unknown>): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: as(owner.cookie, tenantId),
        payload,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(201);
      return response.json().id as string;
    };

    const providerId = await create("/v1/providers", {
      displayName: "Dr. Kovács Anna",
      timezone: "UTC",
    });
    const serviceId = await create("/v1/services", {
      name: "Consultation",
      durationMinutes: options.durationMinutes ?? 60,
      ...(options.requiresApproval === true ? { requiresApproval: true } : {}),
    });
    const locationId = await create("/v1/locations", {
      name: "Main surgery",
      type: "PHYSICAL",
      addressLine1: "Váci út 1",
      timezone: "UTC",
    });

    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/services`,
      headers: as(owner.cookie, tenantId),
      payload: { services: [{ serviceId }] },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/locations`,
      headers: as(owner.cookie, tenantId),
      payload: { locations: [{ locationId }] },
    });

    const hours = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/working-hours`,
      headers: as(owner.cookie, tenantId),
      payload: { workingHours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }] },
    });
    expect(hours.statusCode, hours.body).toBe(200);

    return { owner, tenantId, slug, providerId, serviceId, locationId };
  }

  /** Slots a stranger is offered, through the public API. */
  async function publicSlots(site: Clinic, day = MONDAY): Promise<string[]> {
    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/slots/search`,
      payload: { serviceId: site.serviceId, dateFrom: day, dateTo: day },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().items as { startAt: string }[]).map((slot) => slot.startAt);
  }

  async function takeHold(site: Clinic, startAt: string, sessionId = `session-${RUN}`) {
    return app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/holds`,
      headers: key(),
      payload: { serviceId: site.serviceId, providerId: site.providerId, startAt, sessionId },
    });
  }

  async function confirm(site: Clinic, holdId: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/bookings`,
      headers: key(),
      payload: {
        holdId,
        customer: { fullName: "Nagy Péter", email: `peter-${RUN}@example.test` },
        ...overrides,
      },
    });
  }

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------

  describe("booking end to end", () => {
    it("takes a customer from a slot search to a confirmed appointment", async () => {
      // Epic 4's first exit criterion, start to finish.
      const site = await clinic("endtoend");

      const slots = await publicSlots(site);
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0]).toBe(`${MONDAY}T09:00:00.000Z`);

      const held = await takeHold(site, slots[0]!);
      expect(held.statusCode, held.body).toBe(201);
      expect(held.json().remainingSeconds).toBeGreaterThan(0);
      expect(held.json().remainingSeconds).toBeLessThanOrEqual(300);

      const booked = await confirm(site, held.json().id as string);
      expect(booked.statusCode, booked.body).toBe(201);

      const body = booked.json();
      expect(body.status).toBe("CONFIRMED");
      expect(body.startAt).toBe(slots[0]);
      expect(body.reference).toMatch(/^[2-9A-HJ-NP-TV-Z]{6}$/);
      expect(body.managementToken).toBeTruthy();

      // The snapshot is what the customer was told, not a join.
      expect(body.serviceName).toBe("Consultation");
      expect(body.customerName).toBe("Nagy Péter");
    });

    it("writes the audit row and the outbox event with the booking", async () => {
      // Both inside the transaction, deliberately unlike the fire-and-forget
      // audit plugin: a booking whose creation left no trace is a dispute
      // nobody can settle, and a confirmation nobody was told to send is a
      // customer who turns up to a clinic that is not expecting them.
      const site = await clinic("trail");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      expect(booked.statusCode, booked.body).toBe(201);

      const booking = await app.prisma.booking.findFirst({
        where: { tenantId: site.tenantId },
      });

      const audit = await app.prisma.auditLog.findFirst({
        where: { tenantId: site.tenantId, entityType: "Booking", action: "booking.created" },
      });
      expect(audit?.entityId).toBe(booking!.id);

      const outbox = await app.prisma.outboxEvent.findFirst({
        where: { tenantId: site.tenantId, aggregateId: booking!.id },
      });
      expect(outbox?.eventType).toBe("BOOKING_CONFIRMED");
      expect(outbox?.status).toBe("PENDING");
    });

    it("honours a service that requires approval", async () => {
      // The field has existed since Epic 2 with a comment promising this.
      const site = await clinic("approval", { requiresApproval: true });
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);

      expect(booked.statusCode, booked.body).toBe(201);
      expect(booked.json().status).toBe("PENDING");

      // And it still holds the slot: the customer asked first, and a slow
      // decision must not cost them the appointment.
      const after = await publicSlots(site);
      expect(after).not.toContain(slots[0]);

      const outbox = await app.prisma.outboxEvent.findFirst({
        where: { tenantId: site.tenantId },
      });
      expect(outbox?.eventType).toBe("BOOKING_REQUESTED");
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — the exit criterion
  // -------------------------------------------------------------------------

  describe("two people, one slot", () => {
    it("gives the slot to exactly one of two simultaneous holds", async () => {
      // Epic 4's second exit criterion. Issued together rather than in
      // sequence, so the two requests genuinely overlap and the winner is
      // decided by PostgreSQL rather than by the order the test wrote them.
      const site = await clinic("racehold");
      const slots = await publicSlots(site);

      const [first, second] = await Promise.all([
        takeHold(site, slots[0]!, "session-one-aaaa"),
        takeHold(site, slots[0]!, "session-two-bbbb"),
      ]);

      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([201, 409]);

      const loser = first.statusCode === 409 ? first : second;
      expect(loser.json().error.code).toBe(ErrorCodes.SLOT_NO_LONGER_AVAILABLE);

      // Exactly one reservation exists, not two and not zero.
      const reservations = await app.prisma.capacityReservation.count({
        where: { tenantId: site.tenantId, status: "ACTIVE" },
      });
      expect(reservations).toBe(1);
    });

    it("stops staff booking over a customer who is mid-checkout", async () => {
      // The hold is not advisory. A front desk booking the same time while a
      // customer fills in the form is the same conflict as two customers.
      const site = await clinic("midcheckout");
      const slots = await publicSlots(site);

      const held = await takeHold(site, slots[0]!);
      expect(held.statusCode).toBe(201);

      const staffBooking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: { ...as(site.owner.cookie, site.tenantId), ...key() },
        payload: {
          providerId: site.providerId,
          serviceId: site.serviceId,
          startAt: slots[0],
          customer: { fullName: "Walk-in" },
        },
      });

      expect(staffBooking.statusCode, staffBooking.body).toBe(409);
      expect(staffBooking.json().error.code).toBeOneOf([
        ErrorCodes.SLOT_NO_LONGER_AVAILABLE,
        ErrorCodes.SLOT_NOT_BOOKABLE,
      ]);
    });

    it("removes a held slot from the next search and puts it back on release", async () => {
      // The Phase 3 gap, closed. The slot search fed the engine empty booking
      // and hold lists until this epic; now it reads capacity_reservations,
      // which is the same table the exclusion constraint enforces.
      const site = await clinic("searchgap");
      const before = await publicSlots(site);

      const held = await takeHold(site, before[0]!);
      expect(held.statusCode).toBe(201);

      const during = await publicSlots(site);
      expect(during).not.toContain(before[0]);

      const released = await app.inject({
        method: "DELETE",
        url: `/v1/public/tenants/${site.slug}/holds/${held.json().id as string}?sessionId=session-${RUN}`,
      });
      expect(released.statusCode, released.body).toBe(204);

      const after = await publicSlots(site);
      expect(after).toContain(before[0]);
    });
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  describe("holds expire", () => {
    it("refuses to confirm a hold that has run out, and frees the slot for the next customer", async () => {
      // Epic 4's third exit criterion, and the awkward half of it. There is no
      // scheduler until Epic 5, so the reservation is still ACTIVE in the
      // database and still blocking the constraint. What makes the slot usable
      // again is the sweep inside the next hold's transaction.
      const site = await clinic("expiry");
      const slots = await publicSlots(site);

      const held = await takeHold(site, slots[0]!);
      const holdId = held.json().id as string;

      // Reach past the API to age the hold: the alternative is a test that
      // sleeps for five minutes.
      //
      // `createdAt` moves too, and not for tidiness — the
      // `booking_holds_expiry_after_creation` CHECK refuses a hold that expires
      // before it existed, so backdating only `expiresAt` is rejected by the
      // database. The constraint catching the test is the constraint working.
      await app.prisma.bookingHold.update({
        where: { id: holdId },
        data: {
          createdAt: new Date(Date.now() - 3_600_000),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      await app.prisma.capacityReservation.updateMany({
        where: { holdId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const tooLate = await confirm(site, holdId);
      expect(tooLate.statusCode, tooLate.body).toBe(409);
      expect(tooLate.json().error.code).toBe(ErrorCodes.HOLD_EXPIRED);

      // The search already treats it as free, even before anything swept it.
      expect(await publicSlots(site)).toContain(slots[0]);

      // And the next customer can genuinely take it: the sweep runs inside the
      // transaction that claims the slot.
      const next = await takeHold(site, slots[0]!, "session-next-cccc");
      expect(next.statusCode, next.body).toBe(201);

      const swept = await app.prisma.capacityReservation.findFirst({ where: { holdId } });
      expect(swept?.status).toBe("RELEASED");
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("replays the first response instead of booking twice", async () => {
      // The customer on a train whose confirmation response never arrived.
      const site = await clinic("idem");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);

      const payload = {
        holdId: held.json().id as string,
        customer: { fullName: "Nagy Péter", email: `retry-${RUN}@example.test` },
      };
      const headers = key();

      const first = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${site.slug}/bookings`,
        headers,
        payload,
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${site.slug}/bookings`,
        headers,
        payload,
      });

      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().reference).toBe(first.json().reference);

      const count = await app.prisma.booking.count({ where: { tenantId: site.tenantId } });
      expect(count).toBe(1);
    });

    it("refuses a key reused for a different request", async () => {
      // A key generated once per page rather than once per action. Answering
      // this with the first response would confirm an appointment nobody asked
      // for.
      const site = await clinic("idemreuse");
      const slots = await publicSlots(site);
      const headers = key();

      const first = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${site.slug}/holds`,
        headers,
        payload: {
          serviceId: site.serviceId,
          providerId: site.providerId,
          startAt: slots[0],
          sessionId: `session-${RUN}`,
        },
      });
      expect(first.statusCode, first.body).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${site.slug}/holds`,
        headers,
        payload: {
          serviceId: site.serviceId,
          providerId: site.providerId,
          startAt: slots[2],
          sessionId: `session-${RUN}`,
        },
      });

      expect(second.statusCode, second.body).toBe(409);
      expect(second.json().error.code).toBe(ErrorCodes.IDEMPOTENCY_KEY_REUSED);
    });

    it("refuses a write with no idempotency key at all", async () => {
      const site = await clinic("idemmissing");
      const slots = await publicSlots(site);

      const response = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${site.slug}/holds`,
        payload: {
          serviceId: site.serviceId,
          providerId: site.providerId,
          startAt: slots[0],
          sessionId: `session-${RUN}`,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(ErrorCodes.IDEMPOTENCY_KEY_REQUIRED);
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation and rescheduling
  // -------------------------------------------------------------------------

  describe("cancelling", () => {
    it("puts the slot back on sale", async () => {
      const site = await clinic("cancel");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      expect(await publicSlots(site)).not.toContain(slots[0]);

      const preview = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/cancel/prepare`,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().allowed).toBe(true);

      const cancelled = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/cancel/confirm`,
        headers: key(),
        payload: { reason: "Changed my mind" },
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().status).toBe("CANCELLED");

      expect(await publicSlots(site)).toContain(slots[0]);
    });

    it("refuses to cancel twice", async () => {
      const site = await clinic("cancetwice");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      const first = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/cancel/confirm`,
        headers: key(),
        payload: {},
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/cancel/confirm`,
        headers: key(),
        payload: {},
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe(ErrorCodes.BOOKING_ALREADY_CANCELLED);
    });
  });

  describe("rescheduling", () => {
    it("moves a booking and frees the time it left", async () => {
      const site = await clinic("resched");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      const moved = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/reschedule/confirm`,
        headers: key(),
        payload: { newStartAt: slots[4] },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().startAt).toBe(slots[4]);

      const after = await publicSlots(site);
      expect(after).toContain(slots[0]);
      expect(after).not.toContain(slots[4]);
    });

    it("moves to an overlapping later time without colliding with itself", async () => {
      // A 60-minute booking at 09:00 moving to 09:30 overlaps its own current
      // reservation. Without excluding it from the search, the most ordinary
      // reschedule there is would be impossible.
      const site = await clinic("overlapself");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      const moved = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/reschedule/confirm`,
        headers: key(),
        payload: { newStartAt: slots[2] },
      });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().startAt).toBe(slots[2]);
    });

    it("leaves the booking where it was when the new time is taken", async () => {
      // Epic 4's fourth exit criterion: rescheduling is transactional. The
      // reservation is moved rather than released and re-acquired, so a
      // collision rolls back to exactly the state before.
      const site = await clinic("reschedclash");
      const slots = await publicSlots(site);

      const firstHold = await takeHold(site, slots[0]!, "session-aaa-1111");
      const firstBooking = await confirm(site, firstHold.json().id as string);
      const token = firstBooking.json().managementToken as string;

      const secondHold = await takeHold(site, slots[4]!, "session-bbb-2222");
      const secondBooked = await confirm(site, secondHold.json().id as string, {
        customer: { fullName: "Kiss Éva", email: `eva-${RUN}@example.test` },
      });
      expect(secondBooked.statusCode, secondBooked.body).toBe(201);

      const clash = await app.inject({
        method: "POST",
        url: `/v1/public/bookings/${token}/reschedule/confirm`,
        headers: key(),
        payload: { newStartAt: slots[4] },
      });
      expect(clash.statusCode, clash.body).toBeGreaterThanOrEqual(409);

      // Untouched: same time, same reservation.
      const unchanged = await app.inject({ method: "GET", url: `/v1/public/bookings/${token}` });
      expect(unchanged.json().startAt).toBe(slots[0]);

      const reservations = await app.prisma.capacityReservation.count({
        where: { tenantId: site.tenantId, status: "ACTIVE" },
      });
      expect(reservations).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Management tokens
  // -------------------------------------------------------------------------

  describe("management links", () => {
    it("reaches exactly one booking and reveals nothing else", async () => {
      const site = await clinic("token");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      const found = await app.inject({ method: "GET", url: `/v1/public/bookings/${token}` });
      expect(found.statusCode, found.body).toBe(200);
      expect(found.json().reference).toBe(booked.json().reference);

      // The public shape is its own type, not the staff one filtered
      // (CLAUDE.md rule 12). None of the tenant's operational metadata is here.
      expect(found.json()).not.toHaveProperty("version");
      expect(found.json()).not.toHaveProperty("customerId");
      expect(found.json()).not.toHaveProperty("source");
      expect(found.json()).not.toHaveProperty("notes");
    });

    it("refuses a token that is not one of ours", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/bookings/${randomBytes(32).toString("base64url")}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);
    });

    it("stores only a hash, so a database leak hands over no working links", async () => {
      const site = await clinic("tokenhash");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      const booked = await confirm(site, held.json().id as string);
      const token = booked.json().managementToken as string;

      const stored = await app.prisma.booking.findFirst({
        where: { tenantId: site.tenantId },
        select: { managementTokenHash: true },
      });

      expect(stored?.managementTokenHash).not.toBe(token);
      expect(stored?.managementTokenHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("refuses to read or change another tenant's booking", async () => {
      const [alpha, beta] = await Promise.all([clinic("isoalpha"), clinic("isobeta")]);

      const slots = await publicSlots(alpha);
      const held = await takeHold(alpha, slots[0]!);
      const booked = await confirm(alpha, held.json().id as string);
      const bookingId = (
        await app.prisma.booking.findFirstOrThrow({ where: { tenantId: alpha.tenantId } })
      ).id;
      expect(booked.statusCode).toBe(201);

      // Beta's owner, asking for alpha's booking under beta's tenant header.
      const read = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(beta.owner.cookie, beta.tenantId),
      });
      expect(read.statusCode).toBe(404);
      expect(read.json().error.code).toBe(ErrorCodes.BOOKING_NOT_FOUND);

      const cancel = await app.inject({
        method: "POST",
        url: `/v1/bookings/${bookingId}/cancel/confirm`,
        headers: { ...as(beta.owner.cookie, beta.tenantId), ...key() },
        payload: {},
      });
      expect(cancel.statusCode).toBe(404);

      // And asking under alpha's header without a membership there is refused
      // too — a client-supplied tenant id is a hint, never a grant.
      const spoofed = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(beta.owner.cookie, alpha.tenantId),
      });
      expect(spoofed.statusCode).toBeOneOf([403, 404]);
    });

    it("will not hold a slot on another tenant's provider", async () => {
      const [alpha, beta] = await Promise.all([clinic("crossalpha"), clinic("crossbeta")]);
      const slots = await publicSlots(alpha);

      // Beta's public page, alpha's provider and service ids.
      const response = await app.inject({
        method: "POST",
        url: `/v1/public/tenants/${beta.slug}/holds`,
        headers: key(),
        payload: {
          serviceId: alpha.serviceId,
          providerId: alpha.providerId,
          startAt: slots[0],
          sessionId: `session-${RUN}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  describe("policy", () => {
    it("refuses a public booking with no way to reach the customer", async () => {
      // Staff may book a walk-in with a name alone — they are standing there. A
      // booking made over the internet with no contact detail is one nobody can
      // confirm, remind, or tell about a cancellation.
      const site = await clinic("nocontact");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);

      const response = await confirm(site, held.json().id as string, {
        customer: { fullName: "Anonymous" },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it("refuses a slot the schedule does not offer", async () => {
      // 03:00 on a Monday is outside working hours. Distinct from "taken":
      // nothing is competing for it, the clinic is simply shut.
      const site = await clinic("closed");

      const response = await takeHold(site, `${MONDAY}T03:00:00.000Z`);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.SLOT_NOT_BOOKABLE);
    });

    it("lets staff book at shorter notice than the public may", async () => {
      // The notice window governs strangers. A receptionist fitting somebody in
      // is the business exercising its own judgement, and refusing it would
      // only teach people to work around the system.
      const site = await clinic("shortnotice");

      // A one-day horizon puts the test Monday well outside what the public
      // may book. The advance window rather than the notice window only
      // because the notice field caps at 30 days and the fixture is further
      // out than that; both are the same rule from opposite ends.
      await app.inject({
        method: "PATCH",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { maximumAdvanceDays: 1 },
      });

      const slots = await publicSlots(site);
      expect(slots).toHaveLength(0);

      const staffBooking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: { ...as(site.owner.cookie, site.tenantId), ...key() },
        payload: {
          providerId: site.providerId,
          serviceId: site.serviceId,
          startAt: `${MONDAY}T09:00:00.000Z`,
          customer: { fullName: "Walk-in" },
        },
      });

      expect(staffBooking.statusCode, staffBooking.body).toBe(201);
      expect(staffBooking.json().source).toBe("STAFF");
    });
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  describe("who may see which diary", () => {
    it("shows a provider only their own bookings", async () => {
      const site = await clinic("ownonly");

      // A second provider, and a login linked to the first.
      const second = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.owner.cookie, site.tenantId),
        payload: { displayName: "Dr. Béla", timezone: "UTC" },
      });
      const secondProviderId = second.json().id as string;

      const clinician = await signUp("clinician");
      await app.prisma.membership.create({
        data: {
          tenantId: site.tenantId,
          userId: clinician.id,
          role: "PROVIDER",
          status: "ACTIVE",
          providerId: site.providerId,
        },
      });

      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      await confirm(site, held.json().id as string);

      // Their own diary, with no filter sent: narrowed rather than refused.
      const mine = await app.inject({
        method: "GET",
        url: "/v1/bookings",
        headers: as(clinician.cookie, site.tenantId),
      });
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.json().items).toHaveLength(1);

      // Somebody else's, asked for explicitly.
      const theirs = await app.inject({
        method: "GET",
        url: `/v1/bookings?providerId=${secondProviderId}`,
        headers: as(clinician.cookie, site.tenantId),
      });
      expect(theirs.statusCode).toBe(403);
    });

    it("refuses a provider whose membership is not linked to a diary", async () => {
      // An unpopulated field must never act as a wildcard: without the guard,
      // omitting the filter would list the whole tenant.
      const site = await clinic("unlinked");

      const stranger = await signUp("unlinkedprov");
      await app.prisma.membership.create({
        data: {
          tenantId: site.tenantId,
          userId: stranger.id,
          role: "PROVIDER",
          status: "ACTIVE",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/bookings",
        headers: as(stranger.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Staff editing
  // -------------------------------------------------------------------------

  describe("recording what happened", () => {
    it("marks a booking completed without freeing its slot", async () => {
      // The appointment happened. Releasing the reservation would let a
      // careless backfill write a second booking over a past one.
      const site = await clinic("completed");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      await confirm(site, held.json().id as string);

      const booking = await app.prisma.booking.findFirstOrThrow({
        where: { tenantId: site.tenantId },
      });

      const updated = await app.inject({
        method: "PATCH",
        url: `/v1/bookings/${booking.id}`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { status: "COMPLETED" },
      });

      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().status).toBe("COMPLETED");

      const reservation = await app.prisma.capacityReservation.findFirst({
        where: { bookingId: booking.id },
      });
      expect(reservation?.status).toBe("ACTIVE");
    });

    it("refuses an illegal status change", async () => {
      const site = await clinic("illegal");
      const slots = await publicSlots(site);
      const held = await takeHold(site, slots[0]!);
      await confirm(site, held.json().id as string);

      const booking = await app.prisma.booking.findFirstOrThrow({
        where: { tenantId: site.tenantId },
      });

      await app.inject({
        method: "PATCH",
        url: `/v1/bookings/${booking.id}`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { status: "COMPLETED" },
      });

      // COMPLETED is terminal. Reopening it is not a transition, because the
      // capacity question cannot be answered by a status field.
      const reopen = await app.inject({
        method: "PATCH",
        url: `/v1/bookings/${booking.id}`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { status: "CONFIRMED" },
      });

      expect(reopen.statusCode).toBe(409);
      expect(reopen.json().error.code).toBe(ErrorCodes.BOOKING_NOT_MODIFIABLE);
    });
  });
});
