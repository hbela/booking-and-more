import { describe, expect, it } from "vitest";
import {
  dedupeBoilerplate,
  extractLinks,
  fetchSitePage,
  htmlToText,
  isPublicAddress,
  linkScore,
  onSite,
  readSite,
  robotsDisallows,
  SiteReadError,
  type FetchedPage,
  type SiteFetcher,
} from "./site-reader.js";

/** docs/phase-12-site-import.md §1: the website reader, without the network. */

describe("addresses", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.20.1.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("keeps to the organization's domain and its subdomains", () => {
    expect(onSite("wellness.hu", "wellness.hu")).toBe(true);
    expect(onSite("WWW.Wellness.hu.", "wellness.hu")).toBe(true);
    expect(onSite("evilwellness.hu", "wellness.hu")).toBe(false);
    expect(onSite("wellness.hu.evil.test", "wellness.hu")).toBe(false);
  });
});

describe("the real fetcher refuses before connecting", () => {
  const anywhere = () => true;

  it("an IP literal", async () => {
    await expect(fetchSitePage(new URL("http://127.0.0.1/"), anywhere)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("a name that resolves to a private address", async () => {
    await expect(fetchSitePage(new URL("http://localhost/"), anywhere)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("a host the caller does not allow, a port, or another scheme", async () => {
    const wellness = (url: URL) => onSite(url.hostname, "wellness.hu");
    for (const url of [
      "https://evil.test/",
      "https://wellness.hu:8443/",
      "ftp://wellness.hu/",
      "https://user@wellness.hu/",
    ]) {
      await expect(fetchSitePage(new URL(url), wellness)).rejects.toMatchObject({
        reason: "off_site",
      });
    }
  });
});

describe("HTML to text", () => {
  it("keeps headings, lists and paragraphs and drops what is not content", () => {
    const { title, text } = htmlToText(`<!doctype html><html><head><title> Wellness </title>
      <style>body{}</style></head><body>
      <nav><a href="/">Főoldal</a></nav>
      <h1>Rólunk</h1><p>Családi   rendelő &amp; labor.</p>
      <ul><li>Fogkőeltávolítás</li><li>Konzultáció <b>8000 Ft</b></li></ul>
      <script>alert("x")</script><form><input value="secret"></form>
      <p>Első sor<br>Második sor</p></body></html>`);

    expect(title).toBe("Wellness");
    expect(text).toBe(
      [
        "# Rólunk",
        "Családi rendelő & labor.",
        "- Fogkőeltávolítás",
        "- Konzultáció 8000 Ft",
        "Első sor",
        "Második sor",
      ].join("\n"),
    );
  });

  it("removes lines repeated on most pages, keeping them once", () => {
    const page = (url: string, body: string) => ({
      url,
      title: null,
      text: `Wellness Rendelő\n${body}\nMinden jog fenntartva`,
    });
    const pages = dedupeBoilerplate([page("/", "Főoldal"), page("/a", "Árak"), page("/b", "GYIK")]);
    expect(pages.map((entry) => entry.text)).toEqual([
      "Wellness Rendelő\nFőoldal\nMinden jog fenntartva",
      "Árak",
      "GYIK",
    ]);
  });
});

describe("links and robots", () => {
  it("follows same-site pages only, without fragments, files or account screens", () => {
    const links = extractLinks(
      `<a href="/arak#top">Árak</a><a href="/arak">Árak</a>
       <a href="https://www.wellness.hu/gyik">GYIK</a>
       <a href="https://evil.test/">x</a><a href="mailto:a@b.hu">m</a>
       <a href="/arlista.pdf">pdf</a><a href="/wp-admin/">admin</a>`,
      new URL("https://wellness.hu/"),
      "wellness.hu",
    );
    expect(links.map(String)).toEqual(["https://wellness.hu/arak", "https://www.wellness.hu/gyik"]);
  });

  it("reads the pages that name what the import is after first", () => {
    const score = (path: string) => linkScore(new URL(`https://wellness.hu${path}`));
    expect(score("/szolgáltatások")).toBeGreaterThan(score("/blog/2024/hirek"));
    expect(score("/gyik")).toBeGreaterThan(score("/galeria"));
  });

  it("applies the rules for every crawler and no other", () => {
    expect(
      robotsDisallows(
        [
          "User-agent: Googlebot",
          "Disallow: /only-google",
          "",
          "User-agent: *",
          "Disallow: /private",
          "Disallow:",
          "# Disallow: /commented",
        ].join("\n"),
      ),
    ).toEqual(["/private"]);
  });
});

describe("the crawl", () => {
  /** A scripted site: path → HTML, or an error. */
  function site(pages: Record<string, string | SiteReadError>, contentType = "text/html") {
    const asked: string[] = [];
    const fetcher: SiteFetcher = (url, allow) => {
      asked.push(url.pathname);
      if (!allow(url)) return Promise.reject(new SiteReadError("off_site"));
      const page = pages[url.pathname];
      if (page === undefined) return Promise.reject(new SiteReadError("http_status"));
      if (page instanceof SiteReadError) return Promise.reject(page);
      const fetched: FetchedPage = {
        url,
        contentType: url.pathname === "/robots.txt" ? "text/plain" : contentType,
        body: page,
      };
      return Promise.resolve(fetched);
    };
    return { fetcher, asked };
  }

  it("reads the home page, then the best links, honouring robots.txt and the page limit", async () => {
    const { fetcher, asked } = site({
      "/": `<h1>Wellness</h1><a href="/galeria">G</a><a href="/arak">Á</a>
            <a href="/gyik">F</a><a href="/titkos-szolgaltatas">T</a><a href="/rolunk">R</a>`,
      "/robots.txt": "User-agent: *\nDisallow: /titkos",
      "/arak": "<p>Fogkőeltávolítás 12 000 Ft</p>",
      "/gyik": "<p>Van parkoló? Igen.</p>",
      "/rolunk": "<p>Családi rendelő.</p>",
      "/galeria": "<p>Képek</p>",
    });
    const pages = await readSite("wellness.hu", fetcher, { maxPages: 3 });

    expect(pages.map((page) => new URL(page.url).pathname)).toEqual(["/", "/arak", "/gyik"]);
    expect(asked).not.toContain("/titkos-szolgaltatas");
  });

  it("fails when the home page cannot be read, and says why", async () => {
    const blocked = site({ "/": new SiteReadError("blocked_address") });
    await expect(readSite("wellness.hu", blocked.fetcher)).rejects.toMatchObject({
      reason: "blocked_address",
    });
    // A refused address is not tried again on another scheme.
    expect(blocked.asked).toEqual(["/"]);

    const notHtml = site({ "/": "%PDF" }, "application/pdf");
    await expect(readSite("wellness.hu", notHtml.fetcher)).rejects.toMatchObject({
      reason: "not_html",
    });

    const empty = site({ "/": "<div id='root'></div><script>render()</script>" });
    await expect(readSite("wellness.hu", empty.fetcher)).rejects.toMatchObject({
      reason: "no_text",
    });
  });
});
