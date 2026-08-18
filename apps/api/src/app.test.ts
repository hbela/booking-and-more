import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "./app.js";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp } from "./app.js";
import { TENANT_HEADER } from "./plugins/tenant-context.plugin.js";

/**
 * Driven through `fastify.inject()` — no listening socket, no port conflicts,
 * runnable unattended in CI.
 */
describe("api", () => {
  let app: AppInstance;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL:
          process.env["TEST_DATABASE_URL"] ??
          "postgresql://postgres:postgres@localhost:5432/booking_and_more_test",
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });

    app = await buildApp({ env, logger: false, rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /health/live", () => {
    it("returns 200 without touching any dependency", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ok" });
      expect(response.json().uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("echoes a request id so a caller can quote it in a bug report", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.headers["x-request-id"]).toMatch(/^req_/);
    });

    it("honours an inbound request id so traces survive the proxy hop", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { "x-request-id": "req_from_gateway" },
      });

      expect(response.headers["x-request-id"]).toBe("req_from_gateway");
    });

    it("rejects a malformed inbound request id rather than logging it", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { "x-request-id": "evil\ninjected log line" },
      });

      expect(response.headers["x-request-id"]).toMatch(/^req_/);
    });
  });

  describe("GET /health/ready", () => {
    it("reports postgres as ok and redis as not_configured", async () => {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.status).toBe("ok");
      expect(body.checks.postgres.status).toBe("ok");
      // Redis is optional until Epic 5 — absent must not read as unhealthy.
      expect(body.checks.redis.status).toBe("not_configured");
      expect(body.version).toBe("0.1.0");
    });

    it("never leaks a connection string", async () => {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.body).not.toContain("postgresql://");
      expect(response.body).not.toContain("password");
    });
  });

  describe("error envelope", () => {
    it("returns 404 in the standard envelope for an unknown route", async () => {
      const response = await app.inject({ method: "GET", url: "/no-such-route" });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: expect.any(String),
          requestId: expect.any(String),
        },
      });
    });

    it("does not reflect a booking-management bearer credential in a 404", async () => {
      const token = "secret-management-token";
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/bookings/${token}/not-a-route`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(token);
      expect(response.json().error.message).toBe("Route GET does not exist.");
    });

    it("returns 422 in the standard envelope when the body fails its schema", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/health/echo",
        payload: { message: "" },
      });

      expect(response.statusCode).toBe(422);

      const body = response.json();
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(body.error.requestId).toEqual(expect.any(String));
      expect(body.error.details.issues).toBeInstanceOf(Array);
    });

    it("returns 422 when a required field is missing entirely", async () => {
      const response = await app.inject({ method: "POST", url: "/health/echo", payload: {} });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it("carries the same requestId in the envelope and the response header", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/health/echo",
        payload: {},
        headers: { "x-request-id": "req_correlate_me" },
      });

      expect(response.json().error.requestId).toBe("req_correlate_me");
      expect(response.headers["x-request-id"]).toBe("req_correlate_me");
    });

    it("accepts a valid body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/health/echo",
        payload: { message: "hello" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().message).toBe("hello");
    });

    it("strips fields the response schema does not declare", async () => {
      // Response serialization is driven by the Zod schema, so a handler cannot
      // accidentally leak an internal field. This is the property that dies the
      // moment someone casts req.body to `any` (CLAUDE.md rule 2).
      const response = await app.inject({
        method: "POST",
        url: "/health/echo",
        payload: { message: "hello", extra: "should not come back" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("should not come back");
    });
  });

  describe("cors", () => {
    it("allows the configured web origin", async () => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/health/live",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      });

      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });

    it("does not reflect an arbitrary origin", async () => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/health/live",
        headers: {
          origin: "https://evil.example.com",
          "access-control-request-method": "GET",
        },
      });

      expect(response.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
    });

    it("allows every header the web app actually sends", async () => {
      // The gap this closes: a header the API reads but CORS does not allow
      // fails only in a browser, and only on preflight. Every other test here
      // uses inject(), which does not preflight — so `X-Tenant-Id` was missing
      // from the allow-list through all of Epic 1 and nothing noticed.
      const sent = ["content-type", "authorization", "x-request-id", TENANT_HEADER];

      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/providers",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": sent.join(","),
        },
      });

      expect(response.statusCode).toBeLessThan(300);

      const allowed = String(response.headers["access-control-allow-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((header) => header.trim());

      for (const header of sent) {
        expect(allowed, `${header} must survive preflight`).toContain(header);
      }
    });
  });

  describe("openapi", () => {
    it("documents the health routes with their schemas", async () => {
      const spec = app.swagger() as unknown as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };

      expect(spec.paths["/health/live"]?.["get"]).toBeDefined();
      expect(spec.paths["/health/ready"]?.["get"]).toBeDefined();

      // The point of rule 2: routes carry real response schemas, so the spec is
      // not an empty shell.
      expect(spec.paths["/health/live"]?.["get"]?.responses["200"]).toBeDefined();
      expect(spec.paths["/health/echo"]?.["post"]?.responses["422"]).toBeDefined();
    });
  });

  describe("security headers", () => {
    it("sets the helmet defaults", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  describe("rate-limit identity", () => {
    it("does not let a directly connected caller rotate X-Forwarded-For identities", async () => {
      const env = loadEnv({
        source: {
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
          APP_BASE_URL: "http://localhost:3000",
          API_BASE_URL: "http://localhost:3001",
          DATABASE_URL:
            process.env["TEST_DATABASE_URL"] ??
            "postgresql://postgres:postgres@localhost:5432/booking_and_more_test",
          BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
        },
        loadDotenvFile: false,
      });
      const limitedApp = await buildApp({ env, logger: false });

      try {
        await limitedApp.ready();
        let response;
        for (let request = 0; request <= 300; request += 1) {
          response = await limitedApp.inject({
            method: "POST",
            url: "/health/echo",
            remoteAddress: "203.0.113.10",
            headers: { "x-forwarded-for": `198.51.100.${String(request % 250)}` },
            payload: { message: "same caller" },
          });
        }

        expect(response?.statusCode).toBe(429);
        expect(response?.json().error.code).toBe(ErrorCodes.RATE_LIMITED);
      } finally {
        await limitedApp.close();
      }
    });
  });
});
