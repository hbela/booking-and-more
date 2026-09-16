# Wellness and Medicare staging websites

These independent static sites replace `customer-site`. Hungarian is served at `/`, English at `/en/`. All links open `https://app.booking.appointer.hu`. Staff login identifies the organization by its stored Domain field, explicitly included in the URL. Booking and AI Assistant links retain their existing tenant slugs. The referring website domain is never inferred. No secrets or environment variables are required by these sites.

## Organization identity and owner access

| Demo          | Organization Domain field    | Staff login path                      |
| ------------- | ---------------------------- | ------------------------------------- |
| Wellness Demo | `wellness-demo.appointer.hu` | `/wellness-demo.appointer.hu/sign-in` |
| Medicare Demo | `medicare-demo.appointer.hu` | `/medicare-demo.appointer.hu/sign-in` |

English staff links add `/en`. The full domain is matched against the signed-in user's active memberships, using the same normalization as organization provisioning. Parent domains and values with `.hu` removed are not aliases. Legacy `/{slug}/sign-in` bookmarks still work.

Before owner sign-in, the platform administrator must provision the organization with the matching Domain field and assign/invite its owner using the existing administration flow. Use the owner's account for the dashboard; a platform-administrator account opens `/admin`. The website does not create organizations or grant memberships. If provisioning a new organization, choose `wellness` or `medicare` as appropriate only if available; otherwise update that site's booking and chat links to the chosen slug.

## Deployment order

1. Deploy the API and web changes to the **existing staging application resource** first. The membership-list response now includes `domain`; deploy the API before the web and demo links. Keep database, Redis volumes and environment settings intact. This change adds no migration or backend endpoint.
2. Verify `/wellness-demo.appointer.hu/sign-in`, `/medicare-demo.appointer.hu/sign-in` and their `/en` versions over HTTPS. Shared `/sign-in` remains available; platform administrators continue to land on `/admin`.
3. In the existing administrator interface, verify that the `wellness` and `medicare` tenants already exist and inspect their chat entitlements. Do not create tenants, change plans or alter memberships just to make the demo pass. A disabled chat should show the existing readable unavailable state.
4. Create the two separate Coolify resources below and publish them only after the app routes pass the checks.

## Coolify resources

Use the repository and intended staging revision, Dockerfile build pack, and these **separate build contexts**. Paths are relative to the repository root; the Dockerfile path is relative to its context. In Coolify, select the listed base directory and `/Dockerfile` within it.

| Setting                        | Wellness                             | Medicare                             |
| ------------------------------ | ------------------------------------ | ------------------------------------ |
| Base directory / build context | `/demo/wellness`                     | `/demo/medicare`                     |
| Dockerfile within context      | `Dockerfile`                         | `Dockerfile`                         |
| Domain                         | `https://wellness-demo.appointer.hu` | `https://medicare-demo.appointer.hu` |
| Container port                 | `80`                                 | `80`                                 |
| Health check                   | HTTP GET `/`, port 80, expect 200    | HTTP GET `/`, port 80, expect 200    |

Set health checks to a 30-second interval, 3-second timeout, 5-second start period and 3 retries. Both images also declare the equivalent Docker health check. They need no persistent volumes, database, API secrets or public host-port mapping. Coolify's reverse proxy provides HTTPS.

Create DNS A records `wellness-demo` and `medicare-demo` under `appointer.hu`, both pointing to the VPS public IPv4 address. Add AAAA records only if IPv6 routing is configured on that VPS. Configure both HTTPS domains in Coolify and verify certificate issuance and HTTP-to-HTTPS redirects. The existing `wellness` and `medicare` subdomains belong to another application; preserve their DNS records and Coolify resources.

Equivalent local image builds from the repository root:

```sh
docker build -t appointer-wellness-demo demo/wellness
docker build -t appointer-medicare-demo demo/medicare
```

The main application's root Docker build context intentionally excludes `demo`; do not use it for these resources. Retire any obsolete customer-site resource only after both replacement sites are verified. Never remove application or database volumes.

## Acceptance checklist after deployment

- Open both domains at `/` and `/en/`, on a desktop and a narrow mobile viewport. Check readable text, keyboard focus, language navigation and absence of horizontal scrolling.
- Follow all three links on each language version. Hungarian links use `/{slug}/book`, `/{slug}/chat`, `/{domain}/sign-in`; English links add `/en`. The bare app paths `/wellness` and `/medicare` still redirect to booking.
- Booking and chat must display the selected tenant. Chat keeps its four-language selector and Hungarian default, including entry from an English website. Check the unavailable state if an existing tenant has no chat entitlement.
- With existing owner, provider and human assistant accounts, test fresh sign-in and already-signed-in entry. For an account with both memberships, start in Wellness and follow Medicare's login link, then reverse. Confirm activation finishes before any dashboard data loads and the dashboard shows the intended tenant and role permissions.
- With an account lacking the requested membership, confirm an accessible error appears, no other dashboard opens, and “Sign out and use another account” returns to the sign-in form. Repeat with an activation API failure using a test fixture/local interception, without changing staging memberships.
- Shared platform-admin sign-in must reach `/admin` without tenant activation. Tenant login offers no public registration link.
- Check both site health checks and the existing application's `/api/health` through Coolify HTTPS. Record deployed commit, time, domains and results in the release notes.

Local automated tests cover membership matching, activation ordering, rejection, platform-admin routing and explicit language routing. Browser fixtures do not replace the real staging account checks above. DNS changes, image deployment and authenticated staging checks require access to the existing Coolify/DNS resources and test accounts; do not treat source changes as a completed deployment.

## Rollback

Redeploy the previous revision of each affected resource independently. Keep the app revision supporting tenant login while these demo links are public, or take the demo sites offline before rolling the app back. No data rollback is needed for these changes.

## Read-only staging check — 16 September 2026

- The staging app's public booking page returned HTTP 200 and identifies `https://api.booking.appointer.hu` as its API origin.
- `GET /v1/public/tenants/wellness` succeeds. Its `/assistant` endpoint reports `available: false` and the four supported locales. This confirms current public chat unavailability; an administrator must inspect configuration/entitlements to establish the reason.
- Both Medicare public endpoints return HTTP 404 (`TENANT_NOT_FOUND` from `/assistant`). Confirm the existing tenant's exact slug and status in the administrator interface before publishing these links. No tenant was created or renamed.
- The earlier HTTP 200 checks targeted the original subdomains, which belong to another application. They do not validate these demos. The corrected `wellness-demo` and `medicare-demo` domains still require deployment and HTTPS verification. `/medicare/sign-in` on the staging app returned 404, so the new application route was not deployed there at the time of the check.
- Local production build, web lint/type-check, 277 unit tests and 21 browser tests passed. Desktop/mobile checks used the real static HTML/CSS; tenant-login browser checks use simulated API responses. Real-account checks and deployment remain pending.
