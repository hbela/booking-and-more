"use client";

import { createAuthClient } from "better-auth/react";

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";

/**
 * Better Auth browser client.
 *
 * The API is a separate origin, so every call must send credentials explicitly —
 * without `credentials: "include"` the session cookie is silently dropped and
 * sign-in appears to succeed while leaving the user signed out.
 */
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  basePath: "/v1/auth",
  fetchOptions: { credentials: "include" },
});

export const { signIn, signUp, signOut, useSession } = authClient;
