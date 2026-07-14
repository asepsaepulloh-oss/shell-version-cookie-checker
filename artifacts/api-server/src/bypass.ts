import axios from "axios";
import { logger } from "./lib/logger";

// Known link shortener / bypass-needed domains
const SUPPORTED_DOMAINS = [
  "vplink.in",
  "v2links.in",
  "v2links.net",
  "linkvertise.com",
  "linkvertise.net",
  "exe.io",
  "exey.io",
  "exee.io",
  "fc.lc",
  "fc-lc.com",
  "sh.st",
  "adf.ly",
  "bc.vc",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "dlvr.it",
  "cutt.ly",
  "rebrand.ly",
  "short.io",
  "soo.gd",
  "s.id",
  "go.ly",
  "shorturl.at",
  "url.rw",
  "clk.sh",
  "gplinks.in",
  "gplinks.co",
  "shrinkme.io",
  "shrink.pe",
  "ouo.io",
  "ouo.press",
  "link1s.com",
];

export function isSupportedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    return SUPPORTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function isValidUrl(text: string): boolean {
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface BypassResult {
  originalUrl: string;
  finalUrl: string;
  timeTakenMs: number;
  hops: number;
}

// Extract meta-refresh URL from HTML
function extractMetaRefresh(html: string, baseUrl: string): string | null {
  const match = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'\s>]+)/i,
  );
  if (!match) return null;
  try {
    return new URL(match[1], baseUrl).href;
  } catch {
    return null;
  }
}

// Extract window.location / document.location JS redirect
function extractJsRedirect(html: string, baseUrl: string): string | null {
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
    /document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
    /window\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
    /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function bypassLink(inputUrl: string): Promise<BypassResult> {
  const start = Date.now();
  let currentUrl = inputUrl.startsWith("http")
    ? inputUrl
    : `https://${inputUrl}`;
  const originalUrl = currentUrl;
  let hops = 0;
  const maxHops = 20;
  const visited = new Set<string>();

  while (hops < maxHops) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    let response: Awaited<ReturnType<typeof axios.get>>;
    try {
      response = await axios.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status < 600,
        timeout: 10000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
    } catch (err: unknown) {
      if (
        axios.isAxiosError(err) &&
        err.response &&
        [301, 302, 303, 307, 308].includes(err.response.status)
      ) {
        const location = err.response.headers["location"] as string | undefined;
        if (location) {
          try {
            currentUrl = new URL(location, currentUrl).href;
            hops++;
            continue;
          } catch {
            break;
          }
        }
      }
      logger.error({ err, url: currentUrl }, "Bypass request failed");
      break;
    }

    const status = response.status;

    // HTTP redirect
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers["location"] as string | undefined;
      if (location) {
        try {
          currentUrl = new URL(location, currentUrl).href;
          hops++;
          continue;
        } catch {
          break;
        }
      }
      break;
    }

    // HTML page — check for meta refresh or JS redirect
    const contentType = (response.headers["content-type"] as string) ?? "";
    if (contentType.includes("text/html") && response.data) {
      const html = String(response.data);

      const metaUrl = extractMetaRefresh(html, currentUrl);
      if (metaUrl && metaUrl !== currentUrl) {
        currentUrl = metaUrl;
        hops++;
        continue;
      }

      const jsUrl = extractJsRedirect(html, currentUrl);
      if (jsUrl && jsUrl !== currentUrl) {
        currentUrl = jsUrl;
        hops++;
        continue;
      }
    }

    // No more redirects
    break;
  }

  return {
    originalUrl,
    finalUrl: currentUrl,
    timeTakenMs: Date.now() - start,
    hops,
  };
}
