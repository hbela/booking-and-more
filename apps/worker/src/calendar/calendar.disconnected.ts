import { buildAppUrl } from "@bam/contracts";
import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  buildDedupeKey,
  NotificationChannels,
  NotificationTypes,
  resolveLocale,
  utcDayOf,
} from "@bam/notification-engine";

import { NotificationJobs, QueueNames, type QueueRegistry } from "../queues.js";

/**
 * Tell somebody their Google grant has gone.
 * docs/phase-6-google-calendar-part-1.md §6.
 *
 * ## Why this writes a notification row directly
 *
 * Every other notification in the system is planned from an outbox event, because
 * every other one originates in a *request*: somebody booked, somebody
 * subscribed, somebody invited. This one originates in the **worker** — a Google
 * API call came back saying the grant is gone — and there is no outbox event to
 * plan from. `dispatchBillingNotice` has the same shape for the same reason: a
 * Stripe webhook knows about a subscription and nothing about who should read it.
 *
 * So the row is written here, and from there it is an ordinary notification: the
 * sender renders it, the retry policy applies, the sweep recovers it.
 *
 * ## Who it goes to
 *
 * `integration.userId` — whoever granted the consent. **Only they can re-consent
 * to their own Google account**; an owner cannot do it for them, so an email to
 * the owner alone would name an action its recipient could not take.
 *
 * The fallback is the first active `OWNER`, and the condition for it is worth
 * stating precisely because the obvious reading is wrong. `CalendarIntegration.
 * userId` is NOT NULL and cascades, so the consenting **user** is always there —
 * a `?? owner` on the relation would be unreachable code. What is reachable is
 * that they are no longer *of this organization*: a member can be removed or
 * suspended while their account lives on, and mailing a departed colleague about
 * a clinic's diary is both useless and a small disclosure. So the test is an
 * ACTIVE membership rather than the existence of a row, and when it fails the
 * owner gets an email they have to act on by asking somebody — which is still
 * better than nobody knowing the diary has stopped filling.
 *
 * ## Once a day, and one honest caveat
 *
 * The dedupe key is `(integrationId, utcDayOf(now))`, which was designed in
 * phase 5 before anything could produce it. A broken grant fails every row it
 * touches, so without a key this would send one email per queued booking — which
 * is how a well-meant alert becomes the reason somebody filters our address.
 *
 * The caveat: a **UTC** day means the nag lands on the day's first failure
 * whenever that is, not at a civilised hour. Accepted rather than solved, because
 * solving it means knowing the recipient's zone, and the alternative — a fixed
 * hour in the organization's zone — would delay the first alert by up to a day.
 */

export interface CalendarDisconnectedOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  appBaseUrl: string;
}

/**
 * Never throws.
 *
 * A failure to *tell* somebody the sync is broken must not also fail the sync
 * work that discovered it — the row has already been marked, and that is the
 * durable part. Logged loudly and swallowed, the same call `audit.plugin.ts`
 * makes for the same reason.
 */
export async function notifyCalendarDisconnected(
  args: { tenantId: string; integrationId: string; reason: string; now: Date },
  options: CalendarDisconnectedOptions,
): Promise<{ notified: boolean }> {
  try {
    return await write(args, options);
  } catch (error) {
    options.logger.error(
      { err: error, integrationId: args.integrationId },
      "calendar: could not queue the disconnection email",
    );
    return { notified: false };
  }
}

async function write(
  args: { tenantId: string; integrationId: string; reason: string; now: Date },
  options: CalendarDisconnectedOptions,
): Promise<{ notified: boolean }> {
  const integration = await options.prisma.calendarIntegration.findFirst({
    where: { id: args.integrationId, tenantId: args.tenantId },
    select: {
      id: true,
      userId: true,
      accountEmail: true,
      provider: { select: { displayName: true } },
      tenant: {
        select: {
          name: true,
          defaultLanguage: true,
          // Every active member, so one query answers both questions: is the
          // person who consented still here, and who is the owner if not. A
          // clinic has a handful, so loading them beats two round trips.
          memberships: {
            where: { status: "ACTIVE" },
            select: { userId: true, role: true, user: { select: { email: true, name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (integration === null) return { notified: false };

  const members = integration.tenant.memberships;

  // The person who consented, but only while they are still of this
  // organization; otherwise the owner. See the note at the top of the file for
  // why this tests the membership rather than the user.
  const recipient =
    members.find((member) => member.userId === integration.userId)?.user ??
    members.find((member) => member.role === "OWNER")?.user;

  if (recipient === undefined || recipient.email === "") {
    options.logger.warn(
      { integrationId: args.integrationId },
      "calendar: nobody to tell that the connection is broken",
    );
    return { notified: false };
  }

  const scheduledAt = args.now;

  let created: { id: string };

  try {
    created = await options.prisma.notification.create({
      data: {
        tenantId: args.tenantId,
        type: NotificationTypes.CALENDAR_DISCONNECTED,
        channel: NotificationChannels.EMAIL,
        recipient: recipient.email,
        template: "calendar-disconnected",
        // The organization's language. The recipient is staff, and staff read
        // the language the organization was onboarded in — the same call
        // `PROVIDER_INVITED` makes, and for the same reason.
        locale: resolveLocale({ tenantLanguage: integration.tenant.defaultLanguage }),
        scheduledAt,
        dedupeKey: buildDedupeKey({
          type: NotificationTypes.CALENDAR_DISCONNECTED,
          channel: NotificationChannels.EMAIL,
          integrationId: integration.id,
          dayIso: utcDayOf(scheduledAt.toISOString()),
        }),
        payload: {
          organizationName: integration.tenant.name,
          recipientName: recipient.name,
          accountEmail: integration.accountEmail,
          providerName: integration.provider?.displayName ?? null,
          // Locale-prefixed like every link in every email
          // (docs/phase-9-owner-language-and-return-paths.md §2).
          reconnectUrl: buildAppUrl({
            baseUrl: options.appBaseUrl,
            path: "/dashboard/integrations",
            locale: integration.tenant.defaultLanguage,
          }),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    // The unique index on `(tenant_id, dedupe_key)` decides that today's email
    // has already been committed to — never a SELECT first (rule 14). This is
    // the ordinary path once a broken grant starts failing rows in bulk, so it
    // is silent rather than logged.
    if (isUniqueViolation(error)) return { notified: false };
    throw error;
  }

  await options.queues[QueueNames.NOTIFICATIONS].add(
    NotificationJobs.SEND,
    { tenantId: args.tenantId, notificationId: created.id },
    { jobId: created.id },
  );

  options.logger.warn(
    { integrationId: integration.id, reason: args.reason },
    "calendar: connection needs re-consent; told the person who granted it",
  );

  return { notified: true };
}

/** Prisma's unique-constraint code, duck-typed so it survives bundle boundaries. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
