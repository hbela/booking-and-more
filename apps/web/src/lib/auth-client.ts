"use client";

import { API_BASE_URL } from "@/lib/api-origin";

import { createAuthClient } from "better-auth/react";

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
