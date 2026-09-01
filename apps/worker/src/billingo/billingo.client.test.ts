import { describe, expect, it, vi } from "vitest";
import { BillingoApiError, createBillingoClient } from "./billingo.client.js";

describe("Billingo client", () => {
  it("authenticates requests and encodes partner searches", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createBillingoClient({
      apiKey: "secret-test-key",
      baseUrl: "https://api.billingo.hu/v3/",
      fetch: fetcher,
    });

    await client.findPartners("teszt+partner@example.com");

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://api.billingo.hu/v3/partners?per_page=100&query=teszt%2Bpartner%40example.com",
    );
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-API-KEY": "secret-test-key",
    });
  });

  it("turns a vendor lookup 404 into no document", async () => {
    const client = createBillingoClient({
      apiKey: "key",
      baseUrl: "https://api.billingo.hu/v3",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("not found", { status: 404 })),
    });

    await expect(client.getDocumentByVendorId("in_123")).resolves.toBeNull();
  });

  it("surfaces bounded API errors and retry timing without leaking the key", async () => {
    const client = createBillingoClient({
      apiKey: "never-log-this-key",
      baseUrl: "https://api.billingo.hu/v3",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("rate limited", { status: 429, headers: { "retry-after": "12" } }),
        ),
    });

    let thrown: unknown;
    try {
      await client.listBankAccounts();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BillingoApiError);
    expect(thrown).toMatchObject({ status: 429, retryAfterSeconds: 12 });
    expect((thrown as Error).message).not.toContain("never-log-this-key");
  });

  it("posts Stripe-derived document data unchanged", async () => {
    const document = {
      id: 91,
      invoice_number: "TEST-2026-1",
      gross_total: 24_990,
      currency: "HUF",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(document), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createBillingoClient({
      apiKey: "key",
      baseUrl: "https://api.billingo.hu/v3",
      fetch: fetcher,
    });

    await client.createDocument({
      vendor_id: "in_paid",
      partner_id: 7,
      block_id: 8,
      bank_account_id: 9,
      type: "invoice",
      fulfillment_date: "2026-09-01",
      due_date: "2026-09-01",
      payment_method: "bankcard",
      language: "hu",
      currency: "HUF",
      electronic: true,
      paid: true,
      items: [
        {
          name: "Booking and More — AI Receptionist",
          unit_price: 24_990,
          unit_price_type: "gross",
          quantity: 1,
          unit: "hó",
          vat: "AAM",
        },
      ],
      comment: "Stripe invoice: in_paid",
    });

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ vendor_id: "in_paid", paid: true, currency: "HUF" });
    expect(body["items"]).toEqual([
      expect.objectContaining({ unit_price: 24_990, vat: "AAM", unit_price_type: "gross" }),
    ]);
  });
});
