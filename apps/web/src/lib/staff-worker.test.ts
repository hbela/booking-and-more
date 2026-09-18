import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
function worker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const match = vi.fn((path: string) => Promise.resolve(new Response(path)));
  const addAll = vi.fn(() => Promise.resolve());
  const fetch = vi.fn(() => Promise.resolve(new Response("network")));
  const caches = {
    open: vi.fn(() => Promise.resolve({ match, addAll })),
    keys: vi.fn(() =>
      Promise.resolve(["bam-staff-offline-old", "bam-staff-offline-v1", "unrelated-app"]),
    ),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  runInNewContext(source, {
    self: {
      location: { origin: "https://app.example.test" },
      addEventListener: (name: string, callback: (event: unknown) => void) => {
        listeners[name] = callback;
      },
    },
    Request,
    Response,
    URL,
    Promise,
    fetch,
    caches,
  });
  function request(path: string, mode = "navigate", method = "GET") {
    const respondWith = vi.fn();
    listeners["fetch"]!({
      request: { url: new URL(path, "https://app.example.test").href, method, mode },
      respondWith,
    });
    return respondWith;
  }
  return { listeners, match, addAll, fetch, caches, request };
}

describe("staff offline worker", () => {
  it.each([
    "/dashboard",
    "/dashboard/bookings",
    "/en/dashboard",
    "/en/sign-in",
    "/hu/dashboard",
    "/en/wellness-demo.appointer.hu/sign-in",
  ])("uses a localized fallback on network failure: %s", async (path) => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError("offline"));
    const result = w.request(path);
    const response = (await result.mock.calls[0]![0]) as Response;
    expect(await response.text()).toBe(
      `/pwa/offline-${path.startsWith("/en/") ? "en" : "hu"}.html`,
    );
  });
  it.each([
    ["/wellness-demo/book", "navigate", "GET"],
    ["/en/wellness-demo/chat", "navigate", "GET"],
    ["/booking/manage/token", "navigate", "GET"],
    ["/api/health", "cors", "GET"],
    ["/en/dashboard?_rsc=abc", "cors", "GET"],
    ["/dashboard", "navigate", "POST"],
    ["https://api.example.test/v1/bookings", "cors", "GET"],
  ])("does not intercept %s (%s %s)", (path, mode, method) => {
    const w = worker();
    expect(w.request(path, mode, method)).not.toHaveBeenCalled();
    expect(w.caches.open).not.toHaveBeenCalled();
  });
  it("never stores online staff documents and preserves server errors", async () => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const result = w.request("/dashboard");
    expect(((await result.mock.calls[0]![0]) as Response).status).toBe(503);
    expect(w.caches.open).not.toHaveBeenCalled();
  });
  it("precaches only the four public fallback assets", async () => {
    // Node Request needs absolute URLs; resolve the worker's relative install URLs.
    const installed: Request[][] = [];
    let pending: Promise<unknown> | undefined;
    const listeners: Record<string, (event: unknown) => void> = {};
    class OriginRequest extends Request {
      constructor(input: string, init: RequestInit) {
        super(new URL(input, "https://app.example.test"), init);
      }
    }
    runInNewContext(source, {
      self: {
        addEventListener: (name: string, callback: (event: unknown) => void) => {
          listeners[name] = callback;
        },
      },
      Request: OriginRequest,
      caches: {
        open: () =>
          Promise.resolve({
            addAll: (requests: Request[]) => {
              installed.push(requests);
              return Promise.resolve();
            },
          }),
      },
    });
    listeners["install"]!({
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });
    await pending;
    expect(installed[0]!.map((r) => new URL(r.url).pathname)).toEqual([
      "/pwa/offline-en.html",
      "/pwa/offline-hu.html",
      "/pwa/offline.css",
      "/booking-and-more-mark.svg",
    ]);
    expect(installed[0]!.every((r) => r.credentials === "omit")).toBe(true);
  });
  it("cleans up only obsolete caches owned by this worker", async () => {
    const w = worker();
    let pending: Promise<unknown> | undefined;
    w.listeners["activate"]!({
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });
    await pending;
    expect(w.caches.delete.mock.calls).toEqual([["bam-staff-offline-old"]]);
  });
});
