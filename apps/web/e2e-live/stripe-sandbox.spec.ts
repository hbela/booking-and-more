import { randomUUID } from "node:crypto";
import { allowWrites, call, expect, ownerUsage, test, type Owner } from "./fixtures";

// Only the staging Peach Seesaw Sandbox catalogue; never discover or mutate live prices.
const accountId = "acct_1U90I8GT7MbFlwt0";
const prices = {
  STARTER: "price_1UKLC6GT7MbFlwt02E5DMnrq",
  PROFESSIONAL: "price_1UKLC7GT7MbFlwt0bqN5ZPdM",
  PROFESSIONAL_PLUS: "price_1UKLC8GT7MbFlwt0Rm4A3pBd",
  LEGACY_STARTER: "price_1UE5ITGT7MbFlwt0ZHZLWf5t",
  LEGACY_PROFESSIONAL: "price_1UE5JoGT7MbFlwt0sY1LzBTu",
} as const;
type Plan = "STARTER" | "PROFESSIONAL" | "PROFESSIONAL_PLUS";
interface Subscription {
  id: string;
  status: string;
  latest_invoice: string;
  items: { data: { id: string; current_period_start: number; current_period_end: number }[] };
}

async function stripe<T>(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  fields?: Record<string, string>,
): Promise<T> {
  const secret = process.env["STAGING_E2E_STRIPE_SECRET_KEY"];
  if (!secret?.startsWith("sk_test_"))
    throw new Error("Set STAGING_E2E_STRIPE_SECRET_KEY to a Peach Seesaw Sandbox test key.");
  let response;
  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": "2026-07-29.dahlia",
        ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
        ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(fields ? { body: new URLSearchParams(fields) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      "Stripe Sandbox request failed; inspect this test run's sandbox resources before retrying.",
    );
  }
  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { code?: string; type?: string; param?: string };
    };
    throw new Error(
      `Stripe Sandbox HTTP ${response.status}: ${body.error?.code ?? body.error?.type ?? "unknown"}; parameter ${body.error?.param ?? "none"}`,
    );
  }
  return (await response.json()) as T;
}

async function waitPlan(owner: Owner, plan: Plan, status = "ACTIVE") {
  await expect
    .poll(async () => (await ownerUsage(owner)).subscription, {
      message: `Real Stripe webhook must activate ${plan} / ${status}`,
      timeout: 90_000,
      intervals: [2000, 3000, 5000],
    })
    .toMatchObject({ plan, status });
  const usage = await ownerUsage(owner);
  expect(usage.chatUsage.limit).toBe(plan === "STARTER" ? 0 : plan === "PROFESSIONAL" ? 150 : 300);
  const me = await call(owner.api, "GET", "/v1/me", 200, { headers: owner.headers });
  expect(((await me.json()) as { features: { assistant: boolean } }).features.assistant).toBe(
    plan !== "STARTER",
  );
}

async function advance(clockId: string, frozenTime: number) {
  await stripe(`test_helpers/test_clocks/${clockId}/advance`, "POST", {
    frozen_time: String(frozenTime),
  });
  await expect
    .poll(
      async () => (await stripe<{ status: string }>(`test_helpers/test_clocks/${clockId}`)).status,
      {
        timeout: 90_000,
        intervals: [2000, 3000, 5000],
        message: "Stripe test clock must finish advancing",
      },
    )
    .toBe("ready");
}

for (const [catalogue, priceId] of Object.entries(prices)) {
  const plan = catalogue.replace("LEGACY_", "") as Plan;
  test(`Stripe Sandbox: ${catalogue} real webhooks and entitlements${catalogue === "STARTER" ? ", upgrade, downgrade and failed renewal" : ""}`, async ({
    owner,
    live,
  }) => {
    allowWrites();
    expect(
      (await stripe<{ id: string }>("account")).id,
      "Only the configured staging Sandbox may be mutated",
    ).toBe(accountId);
    const price = await stripe<{ livemode: boolean; active: boolean; currency: string }>(
      `prices/${priceId}`,
    );
    expect(price.livemode).toBe(false);
    expect(price.active).toBe(true);
    expect(price.currency).toBe("huf");
    const run = `e2e-billing-${randomUUID().slice(0, 8)}`;
    let clockId: string | undefined;
    let subscriptionId: string | undefined;
    let paymentLinkId: string | undefined;
    let scoped: Owner | undefined;
    try {
      const created = await call(owner.api, "POST", "/v1/tenants", 201, {
        data: { name: run, slug: run, defaultLanguage: "en", defaultTimezone: "Europe/Budapest" },
      });
      const tenant = (await created.json()) as { id: string };
      scoped = { ...owner, tenantId: tenant.id, headers: { "X-Tenant-Id": tenant.id } };
      if (!catalogue.startsWith("LEGACY_")) {
        const link = await call(owner.api, "POST", "/v1/billing/subscribe", 201, {
          headers: scoped.headers,
          data: { plan },
        });
        const payment = (await link.json()) as { paymentUrl: string };
        expect(new URL(payment.paymentUrl).hostname).toBe("buy.stripe.com");
        const links = await stripe<{
          data: { id: string; metadata: { tenantId?: string }; livemode: boolean }[];
        }>("payment_links?limit=100");
        const matching = links.data.find((item) => item.metadata.tenantId === tenant.id);
        if (!matching)
          throw new Error("Created checkout link not found in the verified staging Sandbox.");
        paymentLinkId = matching.id;
        expect(matching.livemode).toBe(false);
        // Check our checkout-link integration, but do not automate Stripe's protected hosted UI.
        await stripe(`payment_links/${paymentLinkId}`, "POST", { active: "false" });
      }
      const clock = await stripe<{ id: string }>("test_helpers/test_clocks", "POST", {
        frozen_time: String(Math.floor(Date.now() / 1000)),
        name: run,
      });
      clockId = clock.id;
      const customer = await stripe<{ id: string }>("customers", "POST", {
        name: run,
        email: live.config.email,
        test_clock: clockId,
        "metadata[e2eRun]": run,
        payment_method: "pm_card_visa",
        "invoice_settings[default_payment_method]": "pm_card_visa",
        "address[line1]": "1 Test Street",
        "address[city]": "Budapest",
        "address[postal_code]": "1011",
        "address[country]": "HU",
      });
      let subscription = await stripe<Subscription>("subscriptions", "POST", {
        customer: customer.id,
        "items[0][price]": priceId,
        "metadata[tenantId]": tenant.id,
        "metadata[e2eRun]": run,
        payment_behavior: "error_if_incomplete",
      });
      subscriptionId = subscription.id;
      expect(subscription.status).toBe("active");
      await waitPlan(scoped, plan);
      if (catalogue === "STARTER") {
        for (const upgrade of ["PROFESSIONAL", "PROFESSIONAL_PLUS"] as const) {
          const oldInvoice = subscription.latest_invoice;
          subscription = await stripe<Subscription>(`subscriptions/${subscriptionId}`, "POST", {
            "items[0][id]": subscription.items.data[0]!.id,
            "items[0][price]": prices[upgrade],
            proration_behavior: "always_invoice",
            payment_behavior: "error_if_incomplete",
          });
          expect(subscription.latest_invoice).not.toBe(oldInvoice);
          const invoice = await stripe<{
            status: string;
            billing_reason: string;
            amount_paid: number;
          }>(`invoices/${subscription.latest_invoice}`);
          expect(invoice.status).toBe("paid");
          expect(invoice.billing_reason).toBe("subscription_update");
          expect(invoice.amount_paid).toBeGreaterThan(0);
          await waitPlan(scoped, upgrade);
        }
        const item = subscription.items.data[0]!;
        const schedule = await stripe<{ id: string }>("subscription_schedules", "POST", {
          from_subscription: subscriptionId,
        });
        await stripe(`subscription_schedules/${schedule.id}`, "POST", {
          end_behavior: "release",
          "phases[0][start_date]": String(item.current_period_start),
          "phases[0][end_date]": String(item.current_period_end),
          "phases[0][items][0][price]": prices.PROFESSIONAL_PLUS,
          "phases[1][start_date]": String(item.current_period_end),
          "phases[1][duration][interval]": "month",
          "phases[1][duration][interval_count]": "1",
          "phases[1][items][0][price]": prices.PROFESSIONAL,
          "phases[1][proration_behavior]": "none",
        });
        await expect
          .poll(async () => (await ownerUsage(scoped!)).subscription, {
            timeout: 90_000,
            intervals: [2000, 5000],
          })
          .toMatchObject({ plan: "PROFESSIONAL_PLUS", pendingPlan: "PROFESSIONAL" });
        // Let the downgrade renewal invoice finalize before installing a declining card.
        // Otherwise the next clock advance retries that older invoice for an entire month.
        await advance(clockId, item.current_period_end + 7200);
        await waitPlan(scoped, "PROFESSIONAL");
        expect((await ownerUsage(scoped)).subscription?.pendingPlan).toBeNull();
        subscription = await stripe<Subscription>(`subscriptions/${subscriptionId}`);
        await expect
          .poll(
            async () =>
              (await stripe<{ status: string }>(`invoices/${subscription.latest_invoice}`)).status,
            { timeout: 90_000, intervals: [2000, 5000] },
          )
          .toBe("paid");
        // This test payment method attaches successfully but declines later charges.
        const declined = await stripe<{ id: string }>("payment_methods", "POST", {
          type: "card",
          "card[token]": "tok_chargeCustomerFail",
        });
        await stripe(`payment_methods/${declined.id}/attach`, "POST", { customer: customer.id });
        await stripe(`subscriptions/${subscriptionId}`, "POST", {
          default_payment_method: declined.id,
        });
        await advance(clockId, subscription.items.data[0]!.current_period_end + 3600);
        await waitPlan(scoped, "PROFESSIONAL", "PAST_DUE");
      }
    } finally {
      test.setTimeout(test.info().timeout + 120_000);
      try {
        if (paymentLinkId)
          await stripe(`payment_links/${paymentLinkId}`, "POST", { active: "false" });
        if (subscriptionId) {
          const current = await stripe<Subscription>(`subscriptions/${subscriptionId}`);
          if (current.status !== "canceled")
            await stripe(`subscriptions/${subscriptionId}`, "DELETE");
          if (scoped)
            await expect
              .poll(async () => (await ownerUsage(scoped!)).subscription?.status, {
                timeout: 90_000,
                intervals: [2000, 5000],
              })
              .toBe("CANCELED");
        }
      } finally {
        if (clockId) await stripe(`test_helpers/test_clocks/${clockId}`, "DELETE");
        // Tenant creation changes the owner's active tenant. Restore the original test tenant.
        await call(owner.api, "POST", `/v1/tenants/${owner.tenantId}/activate`, 204);
      }
    }
  });
}
