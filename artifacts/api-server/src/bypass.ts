import axios from "axios";
import { logger } from "./lib/logger";

export function isValidUrl(text: string): boolean {
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────
function extractMetaRefresh(html: string, baseUrl: string): string | null {
  const m = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'\s>]+)/i,
  );
  if (!m?.[1]) return null;
  try { return new URL(m[1], baseUrl).href; } catch { return null; }
}

function extractJsRedirect(html: string, baseUrl: string): string | null {
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
    /document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
    /window\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
    /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) try { return new URL(m[1], baseUrl).href; } catch { continue; }
  }
  return null;
}

// Detect pages that explicitly block datacenter / VPN IPs
function isVpnBlockPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("vpn detected") ||
    lower.includes("disable vpn") ||
    lower.includes("vpn or proxy") ||
    lower.includes("turn off vpn") ||
    lower.includes("please disable your vpn") ||
    (lower.includes("vpn") && lower.includes("proxy") && lower.includes("blocked"))
  );
}

// ─── AdLinkFly CSRF + /links/go bypass ───────────────────────────────────────
// Used for shorteners running AdLinkFly without Cloudflare/VPN blocks.
async function adLinkFlyBypass(startUrl: string): Promise<string | null> {
  const base = new URL(startUrl).origin;
  const cookieJar: Record<string, string> = {};

  function mergeCookies(setCookieHeaders: string | string[] | undefined): void {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const h of headers) {
      const pair = h.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && !["refrer", "gt"].includes(k)) cookieJar[k] = v;
    }
  }

  function cookieString(): string {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
  const headers = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  };

  // Step 1: GET the shortlink page → collect session cookies + CSRF token
  let pageHtml: string;
  try {
    const r = await axios.get(startUrl, {
      timeout: 10_000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers,
    });
    mergeCookies(r.headers["set-cookie"]);
    pageHtml = String(r.data);
  } catch { return null; }

  // If Cloudflare or VPN block, bail
  if (isVpnBlockPage(pageHtml)) return null;

  const csrfMatch = pageHtml.match(/name="csrf-token"\s+content="([^"]+)"/);
  const csrf = csrfMatch?.[1];
  if (!csrf) return null;

  // Step 2: POST to /links/go
  try {
    const r = await axios.post(`${base}/links/go`, null, {
      timeout: 10_000,
      validateStatus: () => true,
      headers: {
        ...headers,
        Cookie: cookieString(),
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrf,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: startUrl,
      },
      params: undefined,
    });
    mergeCookies(r.headers["set-cookie"]);
    if (r.data?.url) return String(r.data.url);
  } catch {/* ignore */}

  return null;
}

// ─── Fast HTTP redirect chain ─────────────────────────────────────────────────
async function httpChase(startUrl: string): Promise<{ url: string; vpnBlocked: boolean }> {
  let current = startUrl;
  const visited = new Set<string>();

  for (let i = 0; i < 20; i++) {
    if (visited.has(current)) break;
    visited.add(current);

    let res: Awaited<ReturnType<typeof axios.get>>;
    try {
      res = await axios.get(current, {
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 10_000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const loc = err.response.headers["location"] as string | undefined;
        if (loc && [301, 302, 303, 307, 308].includes(err.response.status)) {
          try { current = new URL(loc, current).href; continue; } catch { break; }
        }
      }
      break;
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers["location"] as string | undefined;
      if (loc) { try { current = new URL(loc, current).href; continue; } catch { break; } }
      break;
    }

    const ct = (res.headers["content-type"] as string) ?? "";
    if (ct.includes("text/html") && res.data) {
      const html = String(res.data);

      // Detect VPN block before wasting more time
      if (isVpnBlockPage(html)) {
        return { url: current, vpnBlocked: true };
      }

      const meta = extractMetaRefresh(html, current);
      if (meta && meta !== current) { current = meta; continue; }
      const js = extractJsRedirect(html, current);
      if (js && js !== current) { current = js; continue; }
    }
    break;
  }

  return { url: current, vpnBlocked: false };
}

// ─── Public API ───────────────────────────────────────────────────────────────
export class VpnBlockedError extends Error {
  constructor(public readonly url: string) {
    super("VPN/proxy block detected");
    this.name = "VpnBlockedError";
  }
}

export interface BypassResult {
  originalUrl: string;
  finalUrl: string;
  timeTakenMs: number;
}

export async function bypassLink(inputUrl: string): Promise<BypassResult> {
  const start = Date.now();
  const originalUrl = inputUrl.startsWith("http") ? inputUrl : `https://${inputUrl}`;

  // Try AdLinkFly-specific bypass first (fast, no browser needed)
  const adResult = await adLinkFlyBypass(originalUrl).catch(() => null);
  if (adResult && adResult !== originalUrl) {
    logger.info({ originalUrl, finalUrl: adResult }, "Bypassed via AdLinkFly API");
    return { originalUrl, finalUrl: adResult, timeTakenMs: Date.now() - start };
  }

  // Fall back to HTTP redirect chasing
  const { url: finalUrl, vpnBlocked } = await httpChase(originalUrl);

  if (vpnBlocked) {
    throw new VpnBlockedError(originalUrl);
  }

  return { originalUrl, finalUrl, timeTakenMs: Date.now() - start };
}
