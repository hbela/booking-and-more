export function parseApiOrigin(value: string | undefined, production: boolean): string {
  if (!value && !production) return "http://localhost:3001";
  if (!value) throw new Error("NEXT_PUBLIC_API_BASE_URL is required in production.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be an absolute origin.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (production && url.protocol !== "https:")
  ) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL must be an HTTPS origin in production, without credentials, path, query or fragment.",
    );
  }
  return url.origin;
}
export const API_BASE_URL = parseApiOrigin(
  process.env["NEXT_PUBLIC_API_BASE_URL"],
  process.env.NODE_ENV === "production",
);
