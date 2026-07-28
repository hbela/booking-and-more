import { NextResponse } from "next/server";

/**
 * Liveness for the web container's Docker healthcheck.
 *
 * Deliberately does not proxy the API's health: this answers "is the Next.js
 * server up", and conflating it with API reachability would make an API blip
 * restart a perfectly healthy web container.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok", service: "web" });
}
