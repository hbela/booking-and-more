import { afterEach, expect, it } from "vitest";
import { clearHeartbeat, heartbeatHealthy, writeHeartbeat } from "./heartbeat.js";

afterEach(clearHeartbeat);
it("fails when missing or stale, and becomes healthy after progress", () => {
  clearHeartbeat();
  expect(heartbeatHealthy()).toBe(false);
  writeHeartbeat();
  expect(heartbeatHealthy()).toBe(true);
  expect(heartbeatHealthy(Date.now() - 10_000)).toBe(false);
  expect(heartbeatHealthy(Date.now() + 151_000)).toBe(false);
  clearHeartbeat();
  expect(heartbeatHealthy()).toBe(false);
});
