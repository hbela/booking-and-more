import { writeFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const HEARTBEAT_FILE = join(tmpdir(), "bam-worker-heartbeat");
export function writeHeartbeat(): void {
  writeFileSync(HEARTBEAT_FILE, "alive");
}
export function clearHeartbeat(): void {
  rmSync(HEARTBEAT_FILE, { force: true });
}
export function heartbeatHealthy(now = Date.now()): boolean {
  try {
    const age = now - statSync(HEARTBEAT_FILE).mtimeMs;
    // Filesystem timestamps can be fractionally ahead of Date.now() on Windows.
    return age >= -1_000 && age < 150_000;
  } catch {
    return false;
  }
}
