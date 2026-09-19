export type AppAudience = "staff" | "patient";
export type AppLocale = "hu" | "en";
export type QrAudience = AppAudience | "book" | "chat";

export function validTenantQr(slug: string, audience: string): audience is QrAudience {
  return validTenantApp(slug, "staff") && ["staff", "patient", "book", "chat"].includes(audience);
}

export function tenantQrTarget(slug: string, audience: QrAudience, locale: AppLocale) {
  if (audience === "staff") return tenantAppPaths(slug, audience, locale).install;
  const prefix = locale === "en" ? "/en" : "";
  return `${prefix}/${slug}/${audience === "chat" ? "chat" : "book"}`;
}

export function validTenantApp(slug: string, audience: string): audience is AppAudience {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && ["staff", "patient"].includes(audience)
  );
}

export function tenantAppPaths(slug: string, audience: AppAudience, locale: AppLocale) {
  const prefix = locale === "en" ? "/en" : "";
  return {
    install: `${prefix}/${slug}/install/${audience}`,
    launch: `${prefix}/${slug}/${audience === "staff" ? "sign-in" : "book"}`,
    manifest: `/api/pwa/${slug}/${audience}/manifest?locale=${locale}`,
    qr: `/api/pwa/${slug}/${audience}/qr?locale=${locale}`,
  };
}

export function tenantAppManifest(
  tenant: { id: string; name: string; slug: string },
  audience: AppAudience,
  locale: AppLocale,
) {
  const role =
    locale === "hu"
      ? audience === "staff"
        ? "Munkatársak"
        : "Páciensek"
      : audience === "staff"
        ? "Staff"
        : "Patients";
  return {
    id: `/tenant-apps/${encodeURIComponent(tenant.id)}/${audience}`,
    name: `${tenant.name} · ${role}`,
    short_name: `${tenant.name} · ${role}`,
    start_url: tenantAppPaths(tenant.slug, audience, locale).launch,
    // Shared dashboard and locale routes live outside the tenant URL prefix.
    // IDs distinguish installations; scope does not confer tenant access.
    scope: "/",
    display: "standalone",
    lang: locale,
    background_color: "#ffffff",
    theme_color: "#1f5cd4",
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/pwa/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
