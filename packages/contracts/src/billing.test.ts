import { describe, expect, it } from "vitest";

import {
  daysUntil,
  isLiveSubscription,
  nextTenantStatus,
  planForPrice,
  restoredTenantStatus,
  subscribablePlanSchema,
  subscriptionEffect,
} from "./billing.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

describe("daysUntil", () => {
  it("counts whole days, floored", () => {
    // 3 days and 23 hours is 3 days left, not 4. Rounding up would promise a
    // day the owner does not have.
    expect(daysUntil(new Date("2026-08-03T11:00:00.000Z"), NOW)).toBe(3);
  });

  it("returns null for no deadline, which is not the same as none left", () => {
    // An internal organization has no subscribe_by (phase-9 §2.2). The screen
    // renders no countdown at all rather than "0 days", and that difference is
    // the whole reason this returns null instead of 0.
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil(undefined, NOW)).toBeNull();
  });

  it("floors an overdue deadline at zero rather than going negative", () => {
    expect(daysUntil(new Date("2026-07-27T12:00:00.000Z"), NOW)).toBe(0);
  });

  it("reports zero on the final day", () => {
    expect(daysUntil(new Date("2026-07-30T23:59:00.000Z"), NOW)).toBe(0);
  });
});

describe("subscribablePlanSchema", () => {
  it("accepts the plans that are sold", () => {
    expect(subscribablePlanSchema.parse("STARTER")).toBe("STARTER");
    expect(subscribablePlanSchema.parse("PROFESSIONAL")).toBe("PROFESSIONAL");
  });

  it("refuses INTERNAL, which is not for sale", () => {
    // INTERNAL exists to keep "every ACTIVE tenant has a plan" true, not to be
    // bought. Accepting it here would hand out the product for nothing.
    expect(subscribablePlanSchema.safeParse("INTERNAL").success).toBe(false);
  });
});

describe("planForPrice", () => {
  const prices = { STARTER: "price_starter", PROFESSIONAL: "price_pro" };

  it("maps a configured price to its plan", () => {
    expect(planForPrice("price_pro", prices)).toBe("PROFESSIONAL");
    expect(planForPrice("price_starter", prices)).toBe("STARTER");
  });

  it("returns undefined rather than guessing", () => {
    // Every caller has its own right answer for "unknown" — activation falls
    // back to STARTER because a paid customer must end up active, an update
    // leaves the existing plan alone. Choosing here would take that away.
    expect(planForPrice("price_something_else", prices)).toBeUndefined();
    expect(planForPrice(undefined, prices)).toBeUndefined();
    expect(planForPrice("", prices)).toBeUndefined();
  });

  it("returns undefined when nothing is configured", () => {
    expect(planForPrice("price_starter", {})).toBeUndefined();
  });
});

describe("subscriptionEffect", () => {
  // The whole entitlement rule, row by row. This table is the thing that used
  // to be three fragments in the worker, so it is asserted exhaustively rather
  // than sampled.
  it.each([
    ["trialing", "TRIALING", "TRIAL"],
    ["active", "ACTIVE", "ACTIVE"],
    ["past_due", "PAST_DUE", null],
    ["unpaid", "PAST_DUE", "SUSPENDED"],
    ["canceled", "CANCELED", "SUSPENDED"],
    ["incomplete", "INCOMPLETE", null],
    ["incomplete_expired", "INCOMPLETE", "SUSPENDED"],
    ["paused", "PAST_DUE", "SUSPENDED"],
  ])("maps %s to %s / tenant %s", (stripe, status, tenantStatus) => {
    expect(subscriptionEffect(stripe)).toEqual({ status, tenantStatus });
  });

  it("keeps access on past_due, because Stripe's dunning is the grace period", () => {
    // Suspending on the first declined attempt would revoke access over an
    // expired card usually fixed within a day. Stripe retries and then cancels,
    // which arrives as `deleted` (docs/phase-9-subscription-lifecycle.md §2.3).
    expect(subscriptionEffect("past_due").tenantStatus).toBeNull();
  });

  it("throws on a status nobody has considered", () => {
    // phase-9 §2.7: the predecessor stored Stripe's status as free text, so a
    // value nobody had thought about simply sat in the column being wrong.
    expect(() => subscriptionEffect("quantum_superposition")).toThrow(/Unrecognised/u);
  });
});

describe("isLiveSubscription", () => {
  it("counts the statuses that mean somebody is entitled right now", () => {
    expect(isLiveSubscription("ACTIVE")).toBe(true);
    expect(isLiveSubscription("TRIALING")).toBe(true);
    // Access continues while Stripe retries — dunning is the grace period.
    expect(isLiveSubscription("PAST_DUE")).toBe(true);
    // INTERNAL: no Stripe counterpart, but very much a live entitlement.
    expect(isLiveSubscription("NOT_APPLICABLE")).toBe(true);
  });

  /**
   * The bug this function was extracted to fix.
   *
   * The `Subscription` row outlives the subscription — cancellation sets
   * CANCELED and keeps the row so `trialUsedAt` can stop a second free trial —
   * so the screen's "is there a row" test told a cancelled customer their
   * subscription was active and everything was unlocked, while the API
   * correctly let them subscribe again.
   */
  it("does not count a row that outlived its subscription", () => {
    expect(isLiveSubscription("CANCELED")).toBe(false);
    expect(isLiveSubscription("INCOMPLETE")).toBe(false);
  });

  it("treats no subscription at all as not live", () => {
    expect(isLiveSubscription(null)).toBe(false);
    expect(isLiveSubscription(undefined)).toBe(false);
  });
});

describe("nextTenantStatus", () => {
  it("suspends from any live state", () => {
    expect(nextTenantStatus("ACTIVE", "SUSPENDED")).toBe("SUSPENDED");
    expect(nextTenantStatus("TRIAL", "SUSPENDED")).toBe("SUSPENDED");
    expect(nextTenantStatus("PENDING_SUBSCRIPTION", "SUSPENDED")).toBe("SUSPENDED");
  });

  /**
   * The refusal this function exists for.
   *
   * SUSPENDED has two causes — Stripe cancelled, or a platform admin
   * intervened — and the tenant row does not record which. Without this, an
   * organization suspended for abuse would be reactivated by any subscription
   * event reporting `active`, including a redelivery of one from before the
   * suspension (customer-portal §3.3).
   */
  it("never revives a suspended or closed organization", () => {
    expect(nextTenantStatus("SUSPENDED", "ACTIVE")).toBeNull();
    expect(nextTenantStatus("SUSPENDED", "TRIAL")).toBeNull();
    expect(nextTenantStatus("CLOSED", "ACTIVE")).toBeNull();
    expect(nextTenantStatus("CLOSED", "TRIAL")).toBeNull();
  });

  it("promotes a pending organization once it pays", () => {
    expect(nextTenantStatus("PENDING_SUBSCRIPTION", "TRIAL")).toBe("TRIAL");
    expect(nextTenantStatus("TRIAL", "ACTIVE")).toBe("ACTIVE");
  });

  it("reports no change rather than a redundant write", () => {
    expect(nextTenantStatus("ACTIVE", "ACTIVE")).toBeNull();
    expect(nextTenantStatus("SUSPENDED", "SUSPENDED")).toBeNull();
    expect(nextTenantStatus("ACTIVE", null)).toBeNull();
  });
});

describe("restoredTenantStatus", () => {
  it("returns a trialling organization to TRIAL, not ACTIVE", () => {
    // The bug this exists to stop: reactivating used to hardcode ACTIVE, so the
    // tenant claimed ACTIVE while its subscription row still said TRIALING.
    expect(restoredTenantStatus("TRIALING")).toBe("TRIAL");
  });

  it("returns a paying organization to ACTIVE", () => {
    expect(restoredTenantStatus("ACTIVE")).toBe("ACTIVE");
  });

  it("restores access while Stripe is still retrying", () => {
    // §2.3: dunning is the grace period, so PAST_DUE keeps access — and must
    // therefore also get it back.
    expect(restoredTenantStatus("PAST_DUE")).toBe("ACTIVE");
  });

  it("restores an INTERNAL organization, which has no Stripe status", () => {
    expect(restoredTenantStatus("NOT_APPLICABLE")).toBe("ACTIVE");
  });

  it("sends an organization with no live subscription back to PENDING_SUBSCRIPTION", () => {
    // Never ACTIVE: an active organization with no subscription is the state
    // phase-9 §2.2 forbids, and reactivation used to create it out of nothing.
    expect(restoredTenantStatus("CANCELED")).toBe("PENDING_SUBSCRIPTION");
    expect(restoredTenantStatus("INCOMPLETE")).toBe("PENDING_SUBSCRIPTION");
    expect(restoredTenantStatus(null)).toBe("PENDING_SUBSCRIPTION");
    expect(restoredTenantStatus(undefined)).toBe("PENDING_SUBSCRIPTION");
  });
});
