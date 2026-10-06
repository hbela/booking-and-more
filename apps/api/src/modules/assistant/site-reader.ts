import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { HTMLElement, parse, TextNode, type Node } from "node-html-parser";

/**
 * Reads the organization's own website for the knowledge import
 * (docs/phase-12-site-import.md §1).
 *
 * The API sits on the same private network as PostgreSQL and Redis
 * (phase-10 §2.9), and a domain can resolve to any address its owner likes, so
 * every connection is checked *at connect time*: the socket's own DNS lookup
 * rejects a non-public address, which leaves no window between a check and the
 * connection for a rebinding resolver to use. Every redirect hop is checked
 * again, and may not leave the organization's domain.
 *
 * The pure parts — address classification, link ranking, HTML to text, robots
 * rules, boilerplate removal — are exported for tests. Nothing here logs page
 * content (rule 6).
 */

export type SiteReadFailure =
  | "blocked_address"
  | "off_site"
  | "not_html"
  | "timeout"
  | "http_status"
  | "unreachable"
  | "no_text";

export class SiteReadError extends Error {
  constructor(readonly reason: SiteReadFailure) {
    super(`The website could not be read (${reason}).`);
  }
}

export interface FetchedPage {
  /** After redirects. */
  url: URL;
  contentType: string;
  /** Decoded. Empty for a body that is not text, which is never read. */
  body: string;
}

/**
 * One URL, redirects followed. `allow` is asked about every hop — the start
 * included — and a hop it refuses fails the fetch with `off_site`. Pages and
 * robots.txt go through the same function, so neither escapes the checks.
 */
export type SiteFetcher = (url: URL, allow: (url: URL) => boolean) => Promise<FetchedPage>;

export interface SitePage {
  url: string;
  title: string | null;
  text: string;
}

// --- Addresses ---------------------------------------------------------------

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** False for anything that is not a routable public address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // An IPv4-mapped address (::ffff:127.0.0.1) is the IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

/** The organization's domain or one of its subdomains — never a lookalike. */
export function onSite(host: string, domain: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, "");
  return name === domain || name.endsWith(`.${domain}`);
}

// --- Fetching ----------------------------------------------------------------

const PAGE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "BookingAndMoreImporter/1.0";
const TEXT_TYPES = /text\/html|application\/xhtml|text\/plain/iu;
const HTML_TYPES = /text\/html|application\/xhtml/iu;

/** Resolve, then refuse unless every address is public (no partial trust). */
const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      callback(new SiteReadError("blocked_address"), "", 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const sniffed = /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head.toString("latin1"))?.[1];
  return sniffed ?? "utf-8";
}

function decode(body: Buffer, contentType: string): string {
  const charset = charsetOf(contentType, body.subarray(0, 4096));
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function requestOnce(
  url: URL,
): Promise<{ status: number; location: string | null; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: checkedLookup,
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.5" },
        timeout: PAGE_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "");
        const location = response.headers.location ?? null;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }
        if (!TEXT_TYPES.test(contentType)) {
          response.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          // Keep the first 2 MB rather than fail: the text is near the top.
          if (size >= MAX_BODY_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) response.destroy();
        });
        const done = () =>
          resolve({
            status,
            location,
            contentType,
            body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES),
          });
        response.on("end", done);
        response.on("close", done);
        response.on("error", () => done());
      },
    );
    request.on("timeout", () => request.destroy(new SiteReadError("timeout")));
    request.on("error", (error) =>
      reject(error instanceof SiteReadError ? error : new SiteReadError("unreachable")),
    );
    request.end();
  });
}

function permitted(url: URL): boolean {
  return (
    (url.protocol === "https:" || url.protocol === "http:") && url.port === "" && !url.username
  );
}

/** The real fetcher. Tests inject their own through `buildApp({ siteFetcher })`. */
export const fetchSitePage: SiteFetcher = async (start, allow) => {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    // An IP literal never reaches `lookup`, so it is checked here; `allow`
    // refuses one anyway, because a domain is never an address.
    if (!permitted(url) || !allow(url)) throw new SiteReadError("off_site");
    if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0)
      throw new SiteReadError("blocked_address");
    const response = await requestOnce(url);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (hop >= MAX_REDIRECTS) throw new SiteReadError("http_status");
      url = new URL(response.location, url);
      continue;
    }
    if (response.status !== 200) throw new SiteReadError("http_status");
    return {
      url,
      contentType: response.contentType,
      body: decode(response.body, response.contentType),
    };
  }
};

// --- Text --------------------------------------------------------------------

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "template",
  "nav",
  "head",
  "button",
  "select",
  "object",
  "canvas",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "blockquote",
  "table",
  "tr",
  "td",
  "th",
  "dl",
  "dt",
  "dd",
  "ul",
  "ol",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "pre",
  "hr",
]);

/**
 * Readable text: headings as `#`, list items as `-`, one block per line.
 * Markup the model would only spend tokens on is gone.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const root = parse(html, { comment: false });
  const title = root.querySelector("title")?.text.trim() || null;
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    const line = current.replace(/\s+/gu, " ").trim();
    if (line && !/^(?:#+|-)$/u.test(line)) lines.push(line);
    current = "";
  };
  const walk = (node: Node) => {
    if (node instanceof TextNode) {
      current += node.text;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.rawTagName?.toLowerCase() ?? "";
    if (SKIP.has(tag)) return;
    const heading = /^h([1-6])$/u.exec(tag);
    if (heading) {
      flush();
      current = `${"#".repeat(Number(heading[1]))} `;
      node.childNodes.forEach(walk);
      flush();
    } else if (tag === "li") {
      flush();
      current = "- ";
      node.childNodes.forEach(walk);
      flush();
    } else if (tag === "br") {
      flush();
    } else if (BLOCK.has(tag)) {
      flush();
      node.childNodes.forEach(walk);
      flush();
    } else {
      node.childNodes.forEach(walk);
    }
  };
  (root.querySelector("body") ?? root).childNodes.forEach(walk);
  flush();
  return { title, text: lines.join("\n") };
}

/** Same-site links on a page, without fragments, files or account screens. */
export function extractLinks(html: string, base: URL, domain: string): URL[] {
  const root = parse(html, { comment: false });
  const seen = new Set<string>();
  const links: URL[] = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    let url: URL;
    try {
      url = new URL(anchor.getAttribute("href") ?? "", base);
    } catch {
      continue;
    }
    url.hash = "";
    if (!permitted(url) || !onSite(url.hostname, domain)) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3|ics)$/iu.test(url.pathname))
      continue;
    if (
      /\/(?:wp-admin|wp-login|login|admin|cart|kosar|checkout|feed|tag|author)(?:\/|$)/iu.test(
        url.pathname,
      )
    )
      continue;
    const key = `${url.hostname}${url.pathname.replace(/\/$/u, "")}${url.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url);
  }
  return links;
}

const KEYWORDS = [
  "szolgaltatas",
  "kezeles",
  "arak",
  "araink",
  "arlista",
  "gyik",
  "kerdes",
  "rolunk",
  "bemutatkozas",
  "csapat",
  "kapcsolat",
  "services",
  "treatments",
  "prices",
  "pricing",
  "faq",
  "about",
  "team",
  "contact",
  "leistungen",
  "preise",
  "ueber",
  "tarifs",
  "propos",
];

/** Higher is read first: pages whose path names what the import is after. */
export function linkScore(url: URL): number {
  const path = decodeURIComponent(url.pathname)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const hits = KEYWORDS.filter((keyword) => path.includes(keyword)).length;
  const depth = path.split("/").filter(Boolean).length;
  return hits * 10 - depth - (url.search ? 5 : 0);
}

/** `Disallow` prefixes that apply to every crawler (`User-agent: *`). */
export function robotsDisallows(robots: string): string[] {
  const rules: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/u)) {
    const line = raw.replace(/#.*/u, "").trim();
    const match = /^([\w-]+)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (field === "disallow" && value && agents.includes("*")) rules.push(value);
    }
  }
  return rules;
}

/**
 * Lines that appear on most pages — header, footer, cookie banner — are kept
 * on the first page only.
 */
export function dedupeBoilerplate(pages: SitePage[]): SitePage[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const line of new Set(page.text.split("\n")))
      counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const threshold = Math.ceil(pages.length / 2);
  return pages.map((page, index) =>
    index === 0
      ? page
      : {
          ...page,
          text: page.text
            .split("\n")
            .filter((line) => (counts.get(line) ?? 0) < threshold)
            .join("\n"),
        },
  );
}

// --- Crawl -------------------------------------------------------------------

export const MAX_PAGES = 12;
export const MAX_TEXT_CHARACTERS = 60_000;
const CRAWL_DEADLINE_MS = 40_000;
const BATCH = 4;

/**
 * The home page, then the best-ranked same-site links, up to {@link MAX_PAGES}
 * and {@link MAX_TEXT_CHARACTERS}. A page that fails is skipped; only a home
 * page that cannot be read fails the whole import.
 */
export async function readSite(
  domain: string,
  fetchPage: SiteFetcher,
  options: { maxPages?: number; deadlineMs?: number } = {},
): Promise<SitePage[]> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const deadline = Date.now() + (options.deadlineMs ?? CRAWL_DEADLINE_MS);
  const allow = (url: URL) => onSite(url.hostname, domain);

  const page = async (url: URL) => {
    const fetched = await fetchPage(url, allow);
    if (!HTML_TYPES.test(fetched.contentType)) throw new SiteReadError("not_html");
    return fetched;
  };

  let home: FetchedPage | null = null;
  let failure: SiteReadError = new SiteReadError("unreachable");
  for (const start of [`https://${domain}/`, `http://${domain}/`, `https://www.${domain}/`]) {
    try {
      home = await page(new URL(start));
      break;
    } catch (error) {
      failure = error instanceof SiteReadError ? error : new SiteReadError("unreachable");
      // An address we refuse is refused on every scheme; trying again would
      // only make a second connection attempt to it.
      if (failure.reason === "blocked_address") throw failure;
    }
  }
  if (!home) throw failure;

  let disallow: string[] = [];
  try {
    const robots = await fetchPage(new URL("/robots.txt", home.url), allow);
    if (/text\/plain/iu.test(robots.contentType)) disallow = robotsDisallows(robots.body);
  } catch {
    // No robots.txt, or not text: nothing is disallowed.
  }
  const allowedPath = (url: URL) => !disallow.some((prefix) => url.pathname.startsWith(prefix));

  const pages: SitePage[] = [];
  const visited = new Set<string>();
  const keyOf = (url: URL) => `${url.hostname}${url.pathname.replace(/\/$/u, "")}${url.search}`;
  const candidates = new Map<string, URL>();
  const take = (fetched: FetchedPage) => {
    visited.add(keyOf(fetched.url));
    const { title, text } = htmlToText(fetched.body);
    if (text) pages.push({ url: fetched.url.toString(), title, text });
    for (const link of extractLinks(fetched.body, fetched.url, domain)) {
      const key = keyOf(link);
      if (!visited.has(key) && allowedPath(link)) candidates.set(key, link);
    }
  };
  take(home);

  while (pages.length < maxPages && candidates.size > 0 && Date.now() < deadline) {
    const batch = [...candidates.entries()]
      .sort((a, b) => linkScore(b[1]) - linkScore(a[1]))
      .slice(0, Math.min(BATCH, maxPages - pages.length));
    for (const [key] of batch) {
      candidates.delete(key);
      visited.add(key);
    }
    const results = await Promise.allSettled(batch.map(([, url]) => page(url)));
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      // A redirect onto a page already read adds nothing.
      const landed = keyOf(result.value.url);
      if (landed !== batch[index]![0] && visited.has(landed)) continue;
      take(result.value);
    }
  }

  const deduped = dedupeBoilerplate(pages).filter((page) => page.text.trim());
  if (deduped.length === 0) throw new SiteReadError("no_text");
  let budget = MAX_TEXT_CHARACTERS;
  return deduped.flatMap((page) => {
    if (budget <= 0) return [];
    const text = page.text.slice(0, budget);
    budget -= text.length;
    return [{ ...page, text }];
  });
}
