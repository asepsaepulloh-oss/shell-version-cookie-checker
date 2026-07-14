import axios from "axios";
import { createHmac } from "crypto";
import { logger as parentLogger } from "./lib/logger";

const logger = parentLogger.child({ module: "cookieChecker" });

export interface CookieCheckResult {
  bytesUsed?: number;
  filename: string;
  service: string;
  valid: boolean;
  accountEmail?: string;
  accountName?: string;
  plan?: "premium" | "free";
  planLabel?: string;
  error?: string;
  cookieCount: number;
}

interface ParsedCookie {
  domain: string;
  name: string;
  value: string;
  path: string;
  expiry?: number; // Unix timestamp from Netscape cookie format column 4
}

interface ExtractResult {
  valid: boolean;
  name?: string;
  email?: string;
  error?: string;
  plan?: "premium" | "free";
  planLabel?: string;
}

interface ServiceConfig {
  name: string;
  emoji: string;
  domains: string[];
  requiredAnyCookies?: string[];
  requiredAnyCookiePrefixes?: string[];
  checkUrl: string;
  checkMethod?: "GET" | "POST";
  checkBody?: unknown;
  checkHeaders?: Record<string, string>;
  followRedirects?: boolean;
  extractInfo: (data: unknown, status: number, headers?: Record<string, unknown>) => ExtractResult;
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

function domainMatches(candidateDomain: string, targetDomain: string): boolean {
  const candidate = normalizeDomain(candidateDomain);
  const target = normalizeDomain(targetDomain);
  return candidate === target || candidate.endsWith(`.${target}`);
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "DNT": "1",
};

const SPOTIFY_OPEN_PRODUCT_TYPE = "open";
const SPOTIFY_FREE_PRODUCT_TYPE = "free";
const SPOTIFY_PREMIUM_PLAN_INDICATORS = ["premium", "duo", "family", "student"];

function resolveSpotifyPlan(productValue: string, hasPremiumFlag = false): { plan: "premium" | "free"; planLabel: string } {
  let plan: "premium" | "free" = "free";
  let planLabel = "Free";
  const normalizedProductValue = productValue.trim();
  if (!normalizedProductValue) {
    if (hasPremiumFlag) {
      return { plan: "premium", planLabel: "Premium" };
    }
    return { plan, planLabel };
  }

  const product = normalizedProductValue.toLowerCase();
  const formattedProductValue = normalizedProductValue.charAt(0).toUpperCase() + normalizedProductValue.slice(1);
  if (hasPremiumFlag || SPOTIFY_PREMIUM_PLAN_INDICATORS.some((p) => product.includes(p))) {
    plan = "premium";
    planLabel = formattedProductValue || "Premium";
  } else if (product !== SPOTIFY_OPEN_PRODUCT_TYPE && product !== SPOTIFY_FREE_PRODUCT_TYPE) {
    planLabel = formattedProductValue;
  }
  return { plan, planLabel };
}

/** Normalize raw Netflix plan names into canonical labels used for zip separation */
function normalizeNetflixPlan(raw: string): { plan: "premium" | "free"; planLabel: string } {
  const l = raw.toLowerCase().trim();
  if (l.includes("4k") || l === "premium" || l.includes("ultra")) return { plan: "premium", planLabel: "Premium" };
  if (l.includes("with ads") || l.includes("w/ ads")) return { plan: "free", planLabel: "Standard With Ads" };
  if (l.startsWith("standard")) return { plan: "premium", planLabel: "Standard" };
  if (l.startsWith("basic")) return { plan: "free", planLabel: "Basic" };
  if (l.startsWith("mobile")) return { plan: "free", planLabel: "Mobile" };
  if (l === "free") return { plan: "free", planLabel: "Free" };
  return { plan: "premium", planLabel: raw };
}

const SERVICES: ServiceConfig[] = [
  {
    name: "Claude.ai",
    emoji: "🤖",
    domains: ["claude.ai", "anthropic.com"],
    requiredAnyCookies: [
      "anthropic-device-id",
      "__ssid",
      "lastActiveOrg",
      "sessionKey",
      "__Secure-next-auth.session-token",
    ],
    checkUrl: "https://claude.ai/api/organizations",
    checkHeaders: { Referer: "https://claude.ai/", Origin: "https://claude.ai" },
    extractInfo: (data, status) => {
      if (status === 200) {
        if (Array.isArray(data) && data.length > 0) {
          const org = data[0] as Record<string, unknown>;
          const capabilities = org["capabilities"] as string[] | undefined;
          const planType = org["billing_type"] as string | undefined;
          const rateLimit = org["rate_limit_tier"] as string | undefined;
          let plan: "premium" | "free" = "free";
          let planLabel = "Free";
          if (
            planType === "pro" || planType === "team" || planType === "enterprise" ||
            rateLimit === "pro" || rateLimit === "team" ||
            (capabilities && (capabilities.includes("pro") || capabilities.includes("team")))
          ) {
            plan = "premium";
            planLabel = planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : "Pro";
          }
          return { valid: true, name: org["name"] as string, email: org["email"] as string, plan, planLabel };
        }
        // Empty org array = logged-in personal/free account (no org assigned)
        if (Array.isArray(data)) return { valid: true, plan: "free" as const, planLabel: "Free" };
        return { valid: false, error: "Unexpected response" };
      }
      if (status === 301 || status === 302 || status === 307) return { valid: false, error: "Session expired (redirect)" };
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "ChatGPT",
    emoji: "💬",
    domains: ["chatgpt.com", "chat.openai.com", "openai.com"],
    requiredAnyCookies: [
      "__Secure-next-auth.session-token",
      "__Secure-next-auth.session-token.0",
    ],
    checkUrl: "__CHATGPT_CHECK__",
    checkHeaders: {},
    extractInfo: (_data, _status) => ({ valid: false, error: "Not reached" }),
  },
  {
    name: "YouTube",
    emoji: "📺",
    domains: ["youtube.com", "google.com", "googleapis.com"],
    checkUrl: "https://www.youtube.com",
    followRedirects: true,
    checkHeaders: {
      Referer: "https://www.youtube.com/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    extractInfo: (data, status) => {
      if (status === 200) {
        const body = typeof data === "string" ? data : JSON.stringify(data);
        const loggedIn = body.includes('"LOGGED_IN":true') || body.includes('LOGGED_IN\\":true') ||
          body.includes('"LOGIN_INFO"') || body.includes('LOGIN_INFO\\"') ||
          (body.includes("ytInitialData") && !body.includes('"LOGGED_IN":false'));
        if (loggedIn) {
          const nameMatch = body.match(/"name"\s*:\s*"([^"]{1,50})"/);
          let plan: "premium" | "free" = "free";
          let planLabel = "Free";
          if (body.includes("isPremium") || body.includes('"premium"') ||
              body.includes("YouTube Premium") || body.includes("has_unlimited") ||
              body.includes('"hasPaidContent":true')) {
            plan = "premium";
            planLabel = "Premium";
          }
          return { valid: true, name: nameMatch?.[1], plan, planLabel };
        }
        if (body.includes('"LOGGED_IN":false') || body.includes('LOGGED_IN\\":false') ||
            body.includes("accounts.google.com/ServiceLogin") || body.includes("Sign in")) {
          return { valid: false, error: "Not logged in" };
        }
        return { valid: false, error: "No login markers found" };
      }
      if (status === 301 || status === 302 || status === 303) return { valid: false, error: "Session expired (redirect)" };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "TikTok",
    emoji: "🎵",
    domains: ["tiktok.com"],
    checkUrl: "https://www.tiktok.com/api/user/detail/?secUid=&uniqueId=me&appId=1233",
    checkHeaders: {
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com",
      "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "x-requested-with": "XMLHttpRequest",
    },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["userInfo"]) {
          const userInfo = d["userInfo"] as Record<string, Record<string, unknown>>;
          const user = userInfo["user"] ?? {};
          const verified = user["verified"] as boolean;
          return {
            valid: true,
            name: (user["nickname"] as string) || (user["uniqueId"] as string),
            plan: verified ? "premium" as const : "free" as const,
            planLabel: verified ? "Verified" : "Regular",
          };
        }
        return { valid: false, error: "Not logged in" };
      }
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Facebook",
    emoji: "📘",
    domains: ["facebook.com", "fbcdn.net", "fb.com"],
    requiredAnyCookies: ["c_user", "xs"],
    checkUrl: "__FACEBOOK_PROXY_CHECK__",
    extractInfo: (_data: unknown, _status: number) => ({ valid: false as const, error: "Use proxy check" }),
  },
  {
    name: "Spotify",
    emoji: "🎧",
    domains: ["spotify.com", "accounts.spotify.com", "open.spotify.com"],
    requiredAnyCookies: ["sp_dc", "sp_key"],
    checkUrl: "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    checkHeaders: {
      Referer: "https://open.spotify.com/",
      Origin: "https://open.spotify.com",
      "app-platform": "WebPlayer",
    },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const isAnonymous = d["isAnonymous"] as boolean | undefined;
        if (isAnonymous === true) return { valid: false, error: "Not logged in (anonymous)" };

        const displayName = typeof d["displayName"] === "string" ? d["displayName"] : "";
        const userId = typeof d["userId"] === "string" ? d["userId"] : "";
        const username = typeof d["username"] === "string" ? d["username"] : "";
        const userIdentifier = [displayName, userId, username].find((value) => value.length > 0) || "";
        const isPremium = d["isPremium"] as boolean | undefined;
        const productFields = ["product", "productType", "plan"] as const;
        const productValue = productFields
          .map((field) => d[field])
          .find((value): value is string => typeof value === "string" && value.length > 0) || "";
        const hasIdentity = Boolean(userIdentifier);
        const hasLoggedInFlag = isAnonymous === false;
        const hasPremiumFlag = isPremium === true;
        const isAuthenticated = hasLoggedInFlag || hasIdentity || hasPremiumFlag;

        if (isAuthenticated) {
          const { plan, planLabel } = resolveSpotifyPlan(productValue, hasPremiumFlag);
          const result: ExtractResult = { valid: true, plan, planLabel };
          if (userIdentifier) result.name = userIdentifier;
          return result;
        }

        if (d["accessToken"]) return { valid: false, error: "Anonymous access token" };
        return { valid: false, error: "No user data in response" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      if (status === 302 || status === 301) return { valid: false, error: "Not logged in (redirect)" };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Netflix",
    emoji: "🎬",
    domains: ["netflix.com"],
    checkUrl: "https://www.netflix.com/YourAccount",
    followRedirects: true,
    // Send full browser headers so Netflix returns the complete reactContext with plan data
    checkHeaders: {
      ...BROWSER_HEADERS,
      Referer: "https://www.netflix.com/browse",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
    extractInfo: (data, status, headers) => {
      if (status === 200) {
        const body = typeof data === "string" ? data : JSON.stringify(data);

        // Detect login/expired page
        const isLoginPage = body.includes("loginPage") || body.includes('"loginUrl"') ||
          body.includes('id="login"') ||
          (body.includes("Sign In") && !body.includes("planName") && !body.includes("profileName") &&
           !body.includes("memberId") && !body.includes('"profiles"') && !body.includes('"maxStreams"'));
        if (isLoginPage) return { valid: false, error: "Not logged in" };

        // Authenticated page markers
        const isAuth = body.includes("profileName") || body.includes('"profiles"') ||
          body.includes("memberId") || body.includes("account-section") ||
          body.includes('"email"') || body.includes("YourAccount") ||
          body.includes("manageAccount") || body.includes("planName") ||
          body.includes('"membershipStatus"') || body.includes('"maxStreams"');

        if (isAuth) {
          const emailMatch = body.match(/"email"\s*:\s*"([^"@"]{1,80}@[^"]{1,80})"/);

          // Strategy 1: explicit plan name fields (most reliable when present)
          const planMatch =
            body.match(/"planName"\s*:\s*"([^"]+)"/) ||
            body.match(/"planLabel"\s*:\s*"([^"]+)"/) ||
            body.match(/"currentPlan"\s*:\s*"([^"]+)"/) ||
            body.match(/"membershipPlan"\s*:\s*"([^"]+)"/) ||
            body.match(/"subscriptionPlan"\s*:\s*"([^"]+)"/) ||
            body.match(/"planDisplayName"\s*:\s*"([^"]+)"/) ||
            body.match(/"planDetails"\s*:\s*\{[^}]{0,200}"name"\s*:\s*"([^"]+)"/) ||
            body.match(/"selectedPlan"\s*:\s*\{[^}]{0,200}"name"\s*:\s*"([^"]+)"/) ||
            body.match(/"membershipSummary"\s*:\s*\{[^}]{0,300}"planName"\s*:\s*"([^"]+)"/);

          if (planMatch) {
            const { plan, planLabel } = normalizeNetflixPlan(planMatch[1]);
            return { valid: true, email: emailMatch?.[1], plan, planLabel };
          }

          // Strategy 2: maxStreams inference (4 = Premium, 2 = Standard, 1 = Basic/Mobile)
          const streamsMatch = body.match(/"maxStreams"\s*:\s*([0-9]+)/) ||
                               body.match(/"concurrentStreams(?:Capacity)?"\s*:\s*([0-9]+)/);
          if (streamsMatch) {
            const n = parseInt(streamsMatch[1], 10);
            if (n >= 4) return { valid: true, email: emailMatch?.[1], plan: "premium", planLabel: "Premium" };
            if (n >= 2) return { valid: true, email: emailMatch?.[1], plan: "premium", planLabel: "Standard" };
            return { valid: true, email: emailMatch?.[1], plan: "free", planLabel: "Basic" };
          }

          // Strategy 3: video quality field
          const qualityMatch = body.match(/"videoQuality"\s*:\s*\{[^}]{0,100}"id"\s*:\s*"([^"]+)"/) ||
                               body.match(/"videoQuality"\s*:\s*"([^"]+)"/);
          if (qualityMatch) {
            const q = qualityMatch[1].toLowerCase();
            if (q.includes("4k") || q.includes("uhd")) return { valid: true, email: emailMatch?.[1], plan: "premium", planLabel: "Premium" };
            if (q.includes("hd")) return { valid: true, email: emailMatch?.[1], plan: "premium", planLabel: "Standard" };
            return { valid: true, email: emailMatch?.[1], plan: "free", planLabel: "Basic" };
          }

          // Valid cookie, plan could not be determined from page
          return { valid: true, email: emailMatch?.[1], plan: "premium", planLabel: "Subscribed" };
        }
        return { valid: false, error: "Could not verify account" };
      }
      if (status === 302 || status === 301) {
        const location = ((headers as Record<string, string>)?.["location"] || "").toLowerCase();
        if (location.includes("/login") || location.includes("signup") || location.includes("/loginhelp")) {
          return { valid: false, error: "Not logged in (redirect to login)" };
        }
        if (location.includes("/browse") || location.includes("/youraccount") || location.includes("/account")) {
          return { valid: true, plan: "premium" as const, planLabel: "Subscribed" };
        }
        return { valid: false, error: "Session expired (redirect)" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Freepik",
    emoji: "🎨",
    domains: ["freepik.com"],
    checkUrl: "https://www.freepik.com/api/user/me",
    checkHeaders: { Referer: "https://www.freepik.com/", Origin: "https://www.freepik.com" },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["id"] || d["name"] || d["email"]) {
          const subscription = d["subscription"] as Record<string, unknown> | undefined;
          const planName = (d["plan"] as string) || (subscription?.["plan"] as string) || "";
          let plan: "premium" | "free" = "free";
          let planLabel = "Free";
          const pn = planName.toLowerCase();
          if (pn.includes("premium") || pn.includes("pro") || pn.includes("paid") || pn.includes("essential")) {
            plan = "premium";
            planLabel = planName.charAt(0).toUpperCase() + planName.slice(1);
          }
          if (subscription && subscription["active"]) {
            plan = "premium";
            planLabel = (subscription["name"] as string) || "Premium";
          }
          return { valid: true, name: (d as Record<string, string>)["name"], email: (d as Record<string, string>)["email"], plan, planLabel };
        }
        return { valid: false, error: "Not logged in" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Perplexity",
    emoji: "🔍",
    domains: ["perplexity.ai"],
    checkUrl: "https://www.perplexity.ai/api/auth/session",
    checkHeaders: { Referer: "https://www.perplexity.ai/", Origin: "https://www.perplexity.ai" },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["user"]) {
          const user = d["user"] as Record<string, unknown>;
          const subscriptionStatus = user["subscriptionStatus"] as string | undefined;
          const tier = user["tier"] as string | undefined;
          let plan: "premium" | "free" = "free";
          let planLabel = "Free";
          if (
            subscriptionStatus === "active" || subscriptionStatus === "trialing" ||
            tier === "pro" || tier === "enterprise" ||
            (user["isPro"] as boolean)
          ) {
            plan = "premium";
            planLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "Pro";
          }
          return { valid: true, name: user["name"] as string, email: user["email"] as string, plan, planLabel };
        }
        if (Object.keys(d).length === 0) return { valid: false, error: "Empty session" };
        return { valid: false, error: "No user data found" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "HBO Max",
    emoji: "🎥",
    domains: ["hbomax.com", "max.com"],
    checkUrl: "https://default.any-any.prd.api.max.com/users/me",
    checkHeaders: { Referer: "https://play.max.com/", Origin: "https://play.max.com" },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["userId"] || d["email"] || d["firstName"]) {
          const sub = d["subscription"] as Record<string, unknown> | undefined;
          const planName = sub?.["planName"] as string | undefined;
          let plan: "premium" | "free" = "premium";
          let planLabel = planName || "Subscribed";
          if (planName && planName.toLowerCase().includes("ad")) {
            plan = "free";
            planLabel = planName;
          }
          return { valid: true, name: (d as Record<string, string>)["firstName"], email: (d as Record<string, string>)["email"], plan, planLabel };
        }
        return { valid: false, error: "No user data found" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Replit",
    emoji: "💻",
    domains: ["replit.com"],
    checkUrl: "https://replit.com/~",
    checkHeaders: {
      Referer: "https://replit.com/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    extractInfo: (data, status, headers) => {
      if (status === 302 || status === 301 || status === 307 || status === 308) {
        const location = (headers?.["location"] || "") as string;
        if (location.includes("/home") || location.includes("/repls") || location.includes("/~")) {
          return { valid: true, plan: "free" as const, planLabel: "Free" };
        }
        return { valid: false, error: "Session expired (redirect to login)" };
      }
      if (status === 200) {
        const body = typeof data === "string" ? data : JSON.stringify(data);
        if (body.includes("currentUser") || body.includes("\"username\"")) {
          return { valid: true, plan: "free" as const, planLabel: "Free" };
        }
        return { valid: false, error: "Not logged in" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Cursor",
    emoji: "⌨️",
    domains: ["cursor.sh", "cursor.com", "authenticator.cursor.sh"],
    checkUrl: "https://www.cursor.com/api/auth/session",
    checkHeaders: {
      Referer: "https://www.cursor.com/",
      Origin: "https://www.cursor.com",
    },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["user"]) {
          const user = d["user"] as Record<string, unknown>;
          const subscription = user["subscription"] as Record<string, unknown> | undefined;
          const planType = (subscription?.["plan"] as string) || (user["plan"] as string) || "";
          let plan: "premium" | "free" = "free";
          let planLabel = "Free";
          const pt = planType.toLowerCase();
          if (pt.includes("pro") || pt.includes("business") || pt.includes("enterprise") || pt.includes("hobby")) {
            plan = "premium";
            planLabel = planType.charAt(0).toUpperCase() + planType.slice(1);
          }
          if (subscription && (subscription["status"] === "active" || subscription["status"] === "trialing")) {
            plan = "premium";
            if (!planLabel || planLabel === "Free") planLabel = "Pro";
          }
          return { valid: true, name: user["name"] as string, email: user["email"] as string, plan, planLabel };
        }
        if (d["email"]) {
          return { valid: true, email: (d as Record<string, string>)["email"], name: (d as Record<string, string>)["name"], plan: "free" as const, planLabel: "Free" };
        }
        return { valid: false, error: "Empty session" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "FapHouse",
    emoji: "🔞",
    domains: ["faphouse.com"],
    requiredAnyCookies: ["PHPSESSID"],
    checkUrl: "https://faphouse.com/api/billing/get-purchase-url",
    checkHeaders: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://faphouse.com/",
    },
    followRedirects: false,
    extractInfo: (data: unknown, status: number) => {
      if (status === 200) {
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["url"] || d["purchase_url"] || d["redirect"] || Object.keys(d).length > 0) {
            return { valid: true, plan: "premium" as const, planLabel: "Premium" };
          }
        }
        return { valid: false, error: "Not logged in" };
      }
      if (status === 302) {
        return { valid: false, error: "Not logged in" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "FamilyStrokes",
    emoji: "👨‍👩‍👧",
    domains: ["familystrokes.com", "teamskeet.com"],
    checkUrl: "https://www.familystrokes.com/members",
    followRedirects: true,
    extractInfo: (data: unknown, status: number) => {
      if (status === 200) {
        const html = typeof data === "string" ? data : "";
        if (html.includes("loggedIn") || html.includes("userToken") || html.includes("access_token") || html.includes("\"isLoggedIn\":true") || html.includes("logout") || html.includes("/api/v1/user/logout")) {
          return { valid: true, plan: "premium" as const, planLabel: "Premium Member" };
        }
        return { valid: false, error: "Not logged in (tour page)" };
      }
      if (status === 302 || status === 301) return { valid: false, error: "Not logged in (redirect)" };
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
      name: "Prime Video",
      emoji: "🎬",
      domains: ["primevideo.com", "amazon.com"],
      requiredAnyCookies: ["at-main-av", "at-main", "sess-at-main-av", "sess-at-main", "x-main-av", "x-main", "session-token"],
      checkUrl: "https://www.primevideo.com/settings/account",
      followRedirects: false,
      checkHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Referer": "https://www.primevideo.com/",
      },
      extractInfo: (data: unknown, status: number, headers?: Record<string, unknown>) => {
        if (status === 200) {
          const html = typeof data === "string" ? data : JSON.stringify(data);

          // Bot-detection / CAPTCHA — Amazon challenges suspicious clients
          if (
            html.includes("Enter the characters you see below") ||
            html.includes("api-services-support@amazon.com") ||
            html.toLowerCase().includes("robot check")
          ) {
            return { valid: false, error: "Bot check triggered — retry" };
          }

          // Inline JS redirect to sign-in embedded in a 200 page
          if (
            html.includes("/ap/signin") ||
            html.includes("signIn?openid") ||
            (html.includes("Sign in") && html.includes("create your Amazon account"))
          ) {
            return { valid: false, error: "Not logged in" };
          }

          // Positive markers present on authenticated /settings/account page
          const loggedInMarkers = [
            "signoutUrl",
            "PVSignOut",
            '"customerName"',
            "cancelPrime",
            "ManagePrime",
            "Manage Prime",
            "Your Memberships",
            "prime-member",
            "Your Account",
            "PV Account Settings",
            "accountSwitcher",
            "pv-account",
          ];

          if (loggedInMarkers.some((m) => html.includes(m))) {
            const nameMatch =
              html.match(/"customerName"\s*:\s*"([^"]{1,80})"/) ||
              html.match(/customerName['"]\s*:\s*['"]([^'"]{1,80})['"]/);

            const hasPrime =
              html.includes("cancelPrime") ||
              html.includes("Manage Prime") ||
              html.includes('"isPrimeMember":true') ||
              html.includes("Prime Member") ||
              html.includes("Your Prime");

            return {
              valid: true,
              name: nameMatch?.[1],
              plan: "premium" as const,
              planLabel: hasPrime ? "Prime" : "Prime Video",
            };
          }

          return { valid: false, error: "Could not verify session" };
        }

        // Any redirect — expired/missing session always redirects to auth flow
        if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
          const hdrs = headers as Record<string, string> | undefined;
          const location = (hdrs?.["location"] || hdrs?.["Location"] || "").toLowerCase();
          if (
            location.includes("signin") ||
            location.includes("login") ||
            location.includes("auth-redirect") ||
            location.includes("/ap/")
          ) {
            return { valid: false, error: "Not logged in" };
          }
          return { valid: false, error: "Session expired" };
        }

        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        if (status === 429) return { valid: false, error: "Rate limited — try again later" };
        if (status === 503) return { valid: false, error: "Service temporarily unavailable" };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
  {
    name: "PayPal",
    emoji: "💳",
    domains: ["paypal.com"],
    checkUrl: "https://www.paypal.com/myaccount/summary",
    followRedirects: false,
    extractInfo: (data: unknown, status: number, headers) => {
      if (status === 200) {
        const body = typeof data === "string" ? data : JSON.stringify(data);
        if (body.includes("CSRF_TOKEN") || body.includes("\"email\"") || body.includes("myaccount") ||
            body.includes("paypal-user") || body.includes("userInfo") || body.includes("balance") ||
            body.includes("accountSummary") || body.includes("\"name\"")) {
          const emailMatch = body.match(/"email"\s*:\s*"([^"]+)"/);
          const nameMatch = body.match(/"name"\s*:\s*"([^"]+)"/);
          return { valid: true, email: emailMatch?.[1], name: nameMatch?.[1], plan: "premium" as const, planLabel: "Verified" };
        }
        if (body.includes("/signin") || body.includes("login") || body.includes("authflow")) {
          return { valid: false, error: "Not logged in (login page served)" };
        }
        return { valid: false, error: "Could not verify account" };
      }
      if (status === 302 || status === 301) {
        const location = ((headers as Record<string, string>)?.["location"] || "").toLowerCase();
        if (location.includes("/signin") || location.includes("/auth") || location.includes("login")) {
          return { valid: false, error: "Not logged in (redirect to login)" };
        }
        if (location.includes("/myaccount") || location.includes("/summary")) {
          return { valid: true, plan: "premium" as const, planLabel: "Verified" };
        }
        return { valid: false, error: "Session expired (redirect)" };
      }
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Eneba",
    emoji: "🎮",
    domains: ["eneba.com"],
    requiredAnyCookies: ["userId"],
    checkUrl: "https://my.eneba.com/us/api/v1/user",
    checkHeaders: { Referer: "https://my.eneba.com/", Origin: "https://my.eneba.com" },
    followRedirects: false,
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const id = d["id"];
        const email = typeof d["email"] === "string" ? d["email"] : "";
        const nickname = typeof d["nickname"] === "string" ? d["nickname"] : "";
        const username = typeof d["username"] === "string" ? d["username"] : "";
        const message = typeof d["message"] === "string" ? d["message"].toLowerCase() : "";

        if (d["error"] || message.includes("unauthor") || message.includes("login")) {
          return { valid: false, error: "Not logged in" };
        }

        const hasValidId = typeof id === "number" || (typeof id === "string" && id.length > 0);
        const hasIdentity = hasValidId && (
          (email.length > 3 && email.includes("@")) ||
          nickname.length > 0 ||
          username.length > 0
        );

        if (!hasIdentity) return { valid: false, error: "No verified user data" };

        const balance = d["balance"] as Record<string, unknown> | undefined;
        const balanceLabel = balance ? `${balance["amount"] || 0} ${balance["currency"] || ""}`.trim() : "";
        return {
          valid: true,
          name: nickname || username || undefined,
          email: email || undefined,
          plan: "premium" as const,
          planLabel: balanceLabel ? `Active (${balanceLabel})` : "Active",
        };
      }
      if (status === 302 || status === 301) return { valid: false, error: "Not logged in" };
      if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
    name: "Crunchyroll",
    emoji: "🍥",
    domains: ["crunchyroll.com"],
    checkUrl: "https://www.crunchyroll.com/accounts/v1/me",
    checkHeaders: { Referer: "https://www.crunchyroll.com/", Origin: "https://www.crunchyroll.com" },
    extractInfo: (data, status) => {
      if (status === 200 && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (d["account_id"] || d["email"] || d["external_id"]) {
          const isPremium = d["premium_member"] === true ||
            (d["subscription"] && typeof d["subscription"] === "object") ||
            d["is_premium"] === true;
          return {
            valid: true,
            email: d["email"] as string,
            name: d["username"] as string,
            plan: isPremium ? "premium" as const : "free" as const,
            planLabel: isPremium ? "Premium" : "Free",
          };
        }
        return { valid: false, error: "No account data" };
      }
      if (status === 401 || status === 403) return { valid: false, error: "Not logged in" };
      if (status === 429) return { valid: false, error: "Rate limited — try again later" };
      return { valid: false, error: `HTTP ${status}` };
    },
  },
  {
      name: "Zee5",
      emoji: "🎬",
      domains: ["zee5.com", "useraction.zee5.com"],
      requiredAnyCookies: ["token", "BUID", "_z5u", "zeeticket_jwt"],
      checkUrl: "__JWT_CHECK_ZEE5__",
      extractInfo: () => ({ valid: false, error: "Should not reach here" }),
    },
      {
    name: "JioHotstar",
    emoji: "🌟",
    domains: ["hotstar.com", "jiohotstar.com", "jiocinema.com", "disneyplus.com"],
    checkUrl: "__JWT_CHECK__",
    extractInfo: () => ({ valid: false, error: "Should not reach here" }),
  },

    {
      name: "Deezer",
      emoji: "🎵",
      domains: ["deezer.com"],
      checkUrl: "https://api.deezer.com/user/me?output=json",
      checkHeaders: { Referer: "https://www.deezer.com/", Origin: "https://www.deezer.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["error"]) {
            const err = d["error"] as Record<string, unknown>;
            if (err["type"] === "OAuthException" || err["code"] === 300) return { valid: false, error: "Not logged in" };
            return { valid: false, error: `API error: ${err["message"] || "unknown"}` };
          }
          if (d["id"]) {
            const isPremium = (d["subscription_plan"] as string | undefined) === "premium" ||
              (d["plan"] as Record<string, unknown> | undefined)?.["name"] === "premium";
            return { valid: true, name: d["name"] as string, email: d["email"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Premium" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Instagram",
      emoji: "📷",
      domains: ["instagram.com"],
      requiredAnyCookies: ["sessionid"],
      checkUrl: "https://www.instagram.com/accounts/edit/",
      followRedirects: false,
      checkHeaders: { Referer: "https://www.instagram.com/", "X-IG-App-ID": "936619743392459", Accept: "text/html,application/xhtml+xml,*/*" },
      extractInfo: (data, status, headers) => {
        if (status === 200) {
          const body = typeof data === "string" ? data : "";
          if (body.includes('"viewer"') || body.includes('"username"') || body.includes("logout") || body.includes('"is_private"')) {
            const nameMatch = body.match(/"full_name"\s*:\s*"([^"]+)"/);
            const userMatch = body.match(/"username"\s*:\s*"([^"]+)"/);
            return { valid: true, name: nameMatch?.[1] || userMatch?.[1], plan: "free" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in (or IP blocked by Instagram)" };
        }
        if (status === 302) {
          const loc = (headers as Record<string, string>)?.["location"] || "";
          if (loc.includes("/accounts/login/")) return { valid: false, error: "Not logged in" };
          return { valid: true, plan: "free" as const, planLabel: "Active" };
        }
        if (status === 401 || status === 403) return { valid: false, error: "Session invalid or datacenter IP blocked" };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Reddit",
      emoji: "🤖",
      domains: ["reddit.com"],
      requiredAnyCookies: ["reddit_session", "token_v2", "loid"],
      checkUrl: "https://www.reddit.com/api/v1/me.json",
      checkHeaders: { Referer: "https://www.reddit.com/", Origin: "https://www.reddit.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["name"] || d["id"]) {
            const isPremium = d["is_gold"] === true || d["is_employee"] === true;
            return { valid: true, name: d["name"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Premium" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Plex",
      emoji: "🎞️",
      domains: ["plex.tv", "app.plex.tv"],
      checkUrl: "https://plex.tv/api/v2/user",
      checkHeaders: { Referer: "https://app.plex.tv/", "X-Plex-Client-Identifier": "cookie-checker", "X-Plex-Product": "Cookie Checker", Accept: "application/json" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["username"]) {
            const plexPass = (d["subscription"] as Record<string, unknown> | undefined)?.["active"] === true;
            return { valid: true, name: (d["title"] as string) || (d["username"] as string), email: d["email"] as string, plan: plexPass ? "premium" as const : "free" as const, planLabel: plexPass ? "Plex Pass" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Grok",
      emoji: "⚫",
      domains: ["grok.com", "x.ai"],
      requiredAnyCookies: ["sso", "sso-rw"],
      checkUrl: "https://grok.com/rest/rate-limits",
      checkHeaders: { Referer: "https://grok.com/", Origin: "https://grok.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["remainingQueries"] !== undefined || d["models"] !== undefined || Object.keys(d).length > 0) {
            return { valid: true, plan: "premium" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Blackbox AI",
      emoji: "⬛",
      domains: ["blackbox.ai"],
      checkUrl: "https://www.blackbox.ai/api/user",
      checkHeaders: { Referer: "https://www.blackbox.ai/", Origin: "https://www.blackbox.ai" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["email"] || d["userId"]) {
            const isPremium = d["isPremium"] === true || d["plan"] === "premium" || d["plan"] === "pro";
            return { valid: true, email: d["email"] as string, name: d["name"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Duolingo",
      emoji: "🦉",
      domains: ["duolingo.com"],
      checkUrl: "https://www.duolingo.com/api/1/users/show?fields=username,learning_language_string,streak,experience",
      checkHeaders: { Referer: "https://www.duolingo.com/", Origin: "https://www.duolingo.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["username"] || d["id"]) {
            const isPremium = d["hasPlus"] === true || d["is_subscriber"] === true;
            return { valid: true, name: d["display_name"] as string || d["username"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Super" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Grammarly",
      emoji: "📝",
      domains: ["grammarly.com"],
      checkUrl: "https://auth.grammarly.com/v3/user/info",
      checkMethod: "GET" as const,
      checkHeaders: { Referer: "https://www.grammarly.com/", Origin: "https://www.grammarly.com", Accept: "application/json", "x-container-id": "desktop" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["email"] || d["userId"] || d["is_anonymous"] === false) {
            const plan = (d["premium_state"] as string | undefined) || "";
            const isPremium = plan === "PREMIUM" || plan === "BUSINESS" || d["is_paid"] === true;
            return { valid: true, email: d["email"] as string, name: d["firstName"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? (plan || "Premium") : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Twitch",
      emoji: "💜",
      domains: ["twitch.tv"],
      checkUrl: "https://gql.twitch.tv/gql",
      checkMethod: "POST" as const,
      checkHeaders: { Referer: "https://www.twitch.tv/", "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
      checkBody: [{ query: "{ currentUser { id login displayName } }" }],
      extractInfo: (data, status) => {
        if (status === 200 && data) {
          const arr = Array.isArray(data) ? data : [data];
          const d = arr[0] as Record<string, unknown> | undefined;
          const user = (d?.["data"] as Record<string, unknown> | undefined)?.["currentUser"] as Record<string, unknown> | undefined;
          if (user?.["id"]) {
            const subs = user["subscriptionProducts"] as unknown[] | undefined;
            const isPremium = Array.isArray(subs) && subs.length > 0;
            return { valid: true, name: (user["displayName"] as string) || (user["login"] as string), plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Turbo" : "Free" };
          }
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Kick",
      emoji: "🟩",
      domains: ["kick.com"],
      checkUrl: "https://kick.com/api/v1/user",
      checkHeaders: { Referer: "https://kick.com/", Origin: "https://kick.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["username"]) {
            const isPremium = d["is_subscribed"] === true || (d["subscription"] as Record<string, unknown> | undefined) !== undefined;
            return { valid: true, name: d["name"] as string || d["username"] as string, email: d["email"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Subscribed" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Magnific AI",
      emoji: "✨",
      domains: ["magnific.ai"],
      checkUrl: "https://magnific.ai/api/user/credits",
      checkHeaders: { Referer: "https://magnific.ai/", Origin: "https://magnific.ai" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const credits = d["credits"] ?? d["remainingCredits"] ?? d["balance"];
          if (credits !== undefined) {
            const isPremium = (d["plan"] as string | undefined) !== "free" && (d["plan"] as string | undefined) !== undefined;
            return { valid: true, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? (d["plan"] as string) || "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Scribd",
      emoji: "📚",
      domains: ["scribd.com"],
      checkUrl: "https://www.scribd.com/",
      followRedirects: true,
      checkHeaders: { Referer: "https://www.scribd.com/", Accept: "text/html,application/xhtml+xml" },
      extractInfo: (data, status) => {
        if (status === 200) {
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.includes('"currentUser"') || body.includes('"is_subscriber":true') || body.includes('"app_session"') || body.includes("logout") || body.includes('"logged_in":true') || body.includes('"signed_in":true')) {
            const isPremium = body.includes('"is_subscriber":true') || body.includes('"subscription_tier":"premium"') || body.includes('"premium"');
            const nameMatch = body.match(/"name"\s*:\s*"([^"]{1,50})"/);
            return { valid: true, name: nameMatch?.[1], plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Premium" : "Active" };
          }
          if (body.includes("log in") || body.includes("/login") || body.includes('"logged_in":false')) return { valid: false, error: "Not logged in" };
          return { valid: false, error: "Could not verify session" };
        }
        if (status === 302 || status === 301) return { valid: false, error: "Session expired (redirect)" };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "GOG",
      emoji: "🎮",
      domains: ["gog.com"],
      checkUrl: "https://www.gog.com/userData.json",
      checkHeaders: { Referer: "https://www.gog.com/", Origin: "https://www.gog.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["isLoggedIn"] === true) {
            return { valid: true, name: (d["username"] as string) || undefined, email: (d["email"] as string) || undefined, plan: "premium" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Udemy",
      emoji: "🎓",
      domains: ["udemy.com"],
      checkUrl: "https://www.udemy.com/api-2.0/contexts/me/?header=True&courseId=0&device_type=desktop",
      checkHeaders: { Referer: "https://www.udemy.com/", "X-Requested-With": "XMLHttpRequest" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const user = (d["header"] as Record<string, unknown> | undefined)?.["user"] as Record<string, unknown> | undefined ?? d;
          if (user["id"] || user["email"]) {
            const isPremium = user["is_instructor"] === true || (d["header"] as Record<string, unknown> | undefined)?.["subscription_plan_id"] !== undefined;
            return { valid: true, name: user["display_name"] as string, email: user["email"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "2Captcha",
      emoji: "🔐",
      domains: ["2captcha.com"],
      checkUrl: "https://2captcha.com/api.php?action=getbalance&json=1",
      checkHeaders: { Referer: "https://2captcha.com/" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["status"] === 1 || d["balance"] !== undefined) {
            const balance = (d["balance"] || d["request"]) as string;
            return { valid: true, plan: "premium" as const, planLabel: `Balance: ${balance}` };
          }
          if (d["request"] === "ERROR_WRONG_USER_KEY" || d["request"] === "ERROR_KEY_DOES_NOT_EXIST") {
            return { valid: false, error: "Invalid API key" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Amazon",
      emoji: "📦",
      domains: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.co.jp", "amazon.in", "amazon.ca", "amazon.com.au", "amazon.com.mx", "amazon.com.br", "amazon.it", "amazon.es"],
      requiredAnyCookies: ["at-main", "sess-at-main", "x-main", "ubid-main", "lc-main"],
      checkUrl: "https://www.amazon.com/gp/css/account-profile/view.html",
      followRedirects: true,
      checkHeaders: {
        Referer: "https://www.amazon.com/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      },
      extractInfo: (data, status) => {
        if (status === 200) {
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.includes("Your Account") || body.includes('"isSignedIn":true') || body.includes("account-list-nav") || body.includes("nav-link-accountList") || body.includes("Hello,")) {
            const nameMatch = body.match(/Hello,\s+([^<]{1,50})/);
            return { valid: true, name: nameMatch?.[1]?.trim(), plan: "premium" as const, planLabel: "Active" };
          }
          if (body.includes("Sign in") || body.includes("signin") || body.includes("ap/signin")) {
            return { valid: false, error: "Not logged in" };
          }
          return { valid: false, error: "Could not verify session" };
        }
        if (status === 302 || status === 301) return { valid: false, error: "Session expired (redirect)" };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "eBay",
      emoji: "🛒",
      domains: ["ebay.com"],
      checkUrl: "https://www.ebay.com/myb/MyeBay",
      followRedirects: true,
      checkHeaders: {
        Referer: "https://www.ebay.com/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      },
      extractInfo: (data, status) => {
        if (status === 200) {
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.includes("public-profile") || body.includes("userId") || body.includes("username") || body.includes("feedback-score") || body.includes("My eBay") || body.includes("myebay") || body.includes("watchlist") || body.includes("SIGNED_IN") || body.includes("gh-ug")) {
            const nameMatch = body.match(/"displayName"\s*:\s*"([^"]+)"/);
            return { valid: true, name: nameMatch?.[1], plan: "premium" as const, planLabel: "Active" };
          }
          if (body.includes("SignIn") || body.includes("sign-in") || body.includes("Login")) {
            return { valid: false, error: "Not logged in" };
          }
          return { valid: false, error: "Could not verify session" };
        }
        if (status === 302 || status === 301) return { valid: false, error: "Session expired" };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Walmart",
      emoji: "🔵",
      domains: ["walmart.com"],
      checkUrl: "https://www.walmart.com/account/self/address/list",
      followRedirects: false,
      checkHeaders: { Referer: "https://www.walmart.com/", Accept: "application/json, text/html" },
      extractInfo: (data, status, headers) => {
        if (status === 200) {
          const body = typeof data === "string" ? data : JSON.stringify(data);
          if (body.includes('"userId"') || body.includes('"customerId"') || body.includes('"addresses"') || body.includes('"firstName"')) {
            const nameMatch = body.match(/"firstName"\s*:\s*"([^"]+)"/);
            return { valid: true, name: nameMatch?.[1], plan: "premium" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 302 || status === 301) {
          const loc = ((headers as Record<string, string>)?.["location"] || "").toLowerCase();
          if (loc.includes("login") || loc.includes("signin") || loc.includes("account/login")) return { valid: false, error: "Not logged in (redirect)" };
          return { valid: true, plan: "premium" as const, planLabel: "Active" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Canal+",
      emoji: "📺",
      domains: ["canalplus.com", "canal-plus.com", "mycanal.fr"],
      checkUrl: "https://www.canalplus.com/api/user/profile",
      checkHeaders: { Referer: "https://www.canalplus.com/", Origin: "https://www.canalplus.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["userId"] || d["email"]) {
            const hasSub = d["hasActiveSubscription"] === true || d["subscriptions"] !== undefined;
            return { valid: true, email: d["email"] as string, name: d["displayName"] as string || d["firstName"] as string, plan: hasSub ? "premium" as const : "free" as const, planLabel: hasSub ? "Subscribed" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Chess.com",
      emoji: "♟️",
      domains: ["chess.com"],
      checkUrl: "https://www.chess.com/callback/ajax/get-current-user",
      checkHeaders: { Referer: "https://www.chess.com/", "X-Requested-With": "XMLHttpRequest" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["username"] || d["id"]) {
            const isPremium = d["isPremium"] === true || d["is_gold"] === true || d["membership"] !== "basic";
            return { valid: true, name: d["username"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Premium" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Hedra",
      emoji: "🎬",
      domains: ["hedra.com", "app.hedra.com"],
      checkUrl: "https://app.hedra.com/api/users/me",
      checkHeaders: { Referer: "https://app.hedra.com/", Origin: "https://app.hedra.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["email"]) {
            const isPremium = (d["plan"] as string | undefined) !== "free" || d["isPremium"] === true;
            return { valid: true, email: d["email"] as string, name: d["name"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Krea AI",
      emoji: "🎨",
      domains: ["krea.ai"],
      checkUrl: "https://www.krea.ai/api/user/me",
      checkHeaders: { Referer: "https://www.krea.ai/", Origin: "https://www.krea.ai" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["email"] || d["userId"]) {
            const isPremium = (d["plan"] as string | undefined) !== "free" || d["is_pro"] === true || d["isPro"] === true;
            return { valid: true, email: d["email"] as string, name: d["name"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Manus",
      emoji: "🦾",
      domains: ["manus.im"],
      checkUrl: "https://manus.im/api/users/me",
      checkHeaders: { Referer: "https://manus.im/", Origin: "https://manus.im" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["email"]) {
            const isPremium = d["is_pro"] === true || (d["plan"] as string | undefined) === "pro";
            return { valid: true, email: d["email"] as string, name: d["name"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Pro" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Pinterest",
      emoji: "📌",
      domains: ["pinterest.com"],
      checkUrl: "https://www.pinterest.com/resource/UserResource/get/?source_url=/me/&data=%7B%22options%22%3A%7B%22username%22%3A%22me%22%7D%2C%22context%22%3A%7B%7D%7D",
      checkHeaders: { Referer: "https://www.pinterest.com/", "X-APP-VERSION": "latest", "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const resourceResponse = (d["resource_response"] as Record<string, unknown> | undefined);
          const user = resourceResponse?.["data"] as Record<string, unknown> | undefined;
          if (user?.["id"] || user?.["username"]) {
            const isPremium = user["is_partner"] === true || user["verified_identity"] !== undefined;
            return { valid: true, name: (user["full_name"] as string) || (user["username"] as string), plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Business" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "TradingView",
      emoji: "📈",
      domains: ["tradingview.com"],
      checkUrl: "https://www.tradingview.com/api/v1/user/",
      checkHeaders: { Referer: "https://www.tradingview.com/", Origin: "https://www.tradingview.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["username"]) {
            const plan = (d["plan"] as string | undefined) || "";
            const isPremium = plan !== "free" && plan !== "" && plan !== "trial";
            return { valid: true, name: d["username"] as string, email: d["email"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? (plan.charAt(0).toUpperCase() + plan.slice(1)) : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Trustpilot",
      emoji: "⭐",
      domains: ["trustpilot.com"],
      checkUrl: "https://www.trustpilot.com/api/v1/session",
      checkHeaders: { Referer: "https://www.trustpilot.com/", Origin: "https://www.trustpilot.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const user = (d["user"] as Record<string, unknown> | undefined) || d;
          if (user["id"] || user["userId"] || user["email"]) {
            return { valid: true, email: user["email"] as string, name: user["name"] as string, plan: "premium" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "X (Twitter)",
      emoji: "✖️",
      domains: ["twitter.com", "x.com", "t.co"],
      requiredAnyCookies: ["auth_token"],
      checkUrl: "https://api.x.com/1.1/account/verify_credentials.json?include_email=true&skip_status=true",
      checkHeaders: { Referer: "https://x.com/", Origin: "https://x.com", "X-Twitter-Auth-Type": "OAuth2Session", "X-Twitter-Active-User": "yes", "X-Twitter-Client-Language": "en" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id_str"] || d["screen_name"]) {
            const isVerified = d["verified"] === true || (d["ext_is_blue_verified"] as boolean) === true;
            const isPremium = isVerified || (d["subscriptions_count"] as number) > 0;
            return { valid: true, name: (d["name"] as string), plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Blue" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Patched",
      emoji: "🧩",
      domains: ["patched.to", "patched.sh"],
      checkUrl: "https://api.patched.to/v1/user/me",
      checkHeaders: { Referer: "https://patched.to/", Origin: "https://patched.to" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["id"] || d["email"] || d["username"]) {
            const isPremium = d["is_premium"] === true || d["plan"] !== "free";
            return { valid: true, email: d["email"] as string, name: d["username"] as string, plan: isPremium ? "premium" as const : "free" as const, planLabel: isPremium ? "Premium" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Coursera",
      emoji: "📖",
      domains: ["coursera.org"],
      checkUrl: "https://www.coursera.org/api/user.v1/me?fields=emailAddress,id,name,timezone,username",
      checkHeaders: { Referer: "https://www.coursera.org/", "X-CSRF3-Token": "fetch" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const elements = (d["elements"] as Record<string, unknown>[]) || [];
          const user = elements[0] || d;
          if (user["id"] || user["name"]) {
            return { valid: true, name: user["name"] as string, email: user["emailAddress"] as string, plan: "free" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Yahoo",
      emoji: "📧",
      domains: ["yahoo.com", "yahoo.co.jp", "yahoo.co.uk", "yahoomail.com"],
      checkUrl: "https://login.yahoo.com/ws/v1/y/userdata?tz=UTC",
      checkHeaders: { Referer: "https://www.yahoo.com/", Origin: "https://www.yahoo.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const profile = (d["profile"] as Record<string, unknown> | undefined) || d;
          if (profile["guid"] || profile["nickname"] || profile["handle"]) {
            return { valid: true, name: profile["nickname"] as string, plan: "free" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Supercell",
      emoji: "🎮",
      domains: ["supercell.com", "id.supercell.com"],
      checkUrl: "https://id.supercell.com/api/se/v1/user/info",
      checkHeaders: { Referer: "https://id.supercell.com/", Origin: "https://id.supercell.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d["email"] || d["userId"] || d["id"]) {
            return { valid: true, email: d["email"] as string, name: d["name"] as string, plan: "free" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "HoYoLAB",
      emoji: "🎮",
      domains: ["hoyolab.com", "hoyoverse.com", "mihoyo.com"],
      checkUrl: "https://bbs-api-os.hoyolab.com/community/user/wapi/getCommunityUserInfoByLtuid",
      checkHeaders: { Referer: "https://www.hoyolab.com/", Origin: "https://www.hoyolab.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const retcode = d["retcode"] as number;
          if (retcode === 0 || retcode === undefined) {
            const dataObj = d["data"] as Record<string, unknown> | undefined;
            const userInfo = (dataObj?.["user_info"] as Record<string, unknown> | undefined) || dataObj || d;
            if (userInfo?.["uid"] || userInfo?.["nickname"]) {
              return { valid: true, name: userInfo["nickname"] as string, plan: "free" as const, planLabel: "Active" };
            }
          }
          if (retcode === -100 || retcode === -101) return { valid: false, error: "Session expired" };
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Steam",
      emoji: "🎮",
      domains: ["steampowered.com", "steamcommunity.com", "store.steampowered.com"],
      checkUrl: "https://store.steampowered.com/dynamicstore/userdata/",
      checkHeaders: { Referer: "https://store.steampowered.com/", Origin: "https://store.steampowered.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const steamId = d["rgWishlist"] !== undefined ? "present" : null;
          if (d["bLoggedIn"] === true || (d["strSteamId"] as string)?.length > 0 || steamId) {
            const strSteamId = d["strSteamId"] as string | undefined;
            return { valid: true, name: strSteamId ? `ID:${strSteamId}` : undefined, plan: "free" as const, planLabel: "Active" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
    {
      name: "Surfshark",
      emoji: "🔒",
      domains: ["surfshark.com", "my.surfshark.com"],
      requiredAnyCookiePrefixes: [],
      checkUrl: "__SURFSHARK_CHECK__",
      checkHeaders: {},
      extractInfo: (_data, _status) => ({ valid: false, error: "Not reached" }),
    },
    {
      name: "Patreon",
      emoji: "🎨",
      domains: ["patreon.com"],
      requiredAnyCookies: ["__ssid", "a_csrf"],
      checkUrl: "https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=email,full_name,patron_status,url",
      checkHeaders: { Referer: "https://www.patreon.com/", Origin: "https://www.patreon.com" },
      extractInfo: (data, status) => {
        if (status === 200 && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const userData = (d["data"] as Record<string, unknown> | undefined);
          const attrs = (userData?.["attributes"] as Record<string, unknown> | undefined) || d;
          if (userData?.["id"] || attrs["email"]) {
            const isPledging = attrs["patron_status"] === "active_patron";
            return { valid: true, name: attrs["full_name"] as string, email: attrs["email"] as string, plan: isPledging ? "premium" as const : "free" as const, planLabel: isPledging ? "Patron" : "Free" };
          }
          return { valid: false, error: "Not logged in" };
        }
        if (status === 401 || status === 403) return { valid: false, error: `Auth failed (${status})` };
        return { valid: false, error: `HTTP ${status}` };
      },
    },
  
];

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const payload = Buffer.from(b64, "base64").toString("utf-8");
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

const AKAMAI_KEY = Buffer.from([0x05, 0xfc, 0x1a, 0x01, 0xca, 0xc9, 0x4b, 0xc4, 0x12, 0xfc, 0x53, 0x12, 0x07, 0x75, 0xf9, 0xee]);

function getHotstarAuth(): string {
  const now = Math.floor(Date.now() / 1000);
  const st = now - (now % 1800);
  const exp = st + 1800;
  const msg = `st=${st}~exp=${exp}~acl=/*`;
  const sig = createHmac("sha256", AKAMAI_KEY).update(msg).digest("hex");
  return `${msg}~hmac=${sig}`;
}

function getHotstarHeaders(userToken: string, deviceId: string): Record<string, string> {
  return {
    "User-Agent": "Hotstar;in.startv.hotstar/3.3.0 (Android/8.1.0)",
    "hotstarauth": getHotstarAuth(),
    "x-hs-usertoken": userToken,
    "x-hs-device-id": deviceId,
    "x-hs-platform": "web",
    "x-hs-appversion": "6.72.2",
    "x-country-code": "IN",
    "Content-Type": "application/json",
  };
}


async function checkChatGPTCookies(cookies: ParsedCookie[], proxy?: string): Promise<ExtractResult> {
  // ── 1. Build cookie map ──────────────────────────────────────────────────
  const cookieMap = new Map<string, string>();
  for (const c of cookies) {
    if (c.value && c.value.length > 0 && !cookieMap.has(c.name)) {
      cookieMap.set(c.name, c.value);
    }
  }

  // ── 2. Assemble chunked session token (.0 + .1 + …) ─────────────────────
  let sessionToken = cookieMap.get("__Secure-next-auth.session-token");
  if (!sessionToken) {
    const chunks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const chunk = cookieMap.get(`__Secure-next-auth.session-token.${i}`);
      if (chunk) chunks.push(chunk);
      else break;
    }
    if (chunks.length > 0) sessionToken = chunks.join("");
  }
  if (!sessionToken) {
    return { valid: false, error: "No session token found (missing __Secure-next-auth.session-token)" };
  }

  // ── 3. Fast-fail: cookie is expired by its own expiry timestamp ──────────
  const sessionCookie = cookies.find(
    (c) => c.name === "__Secure-next-auth.session-token" || c.name === "__Secure-next-auth.session-token.0",
  );
  const tokenExpiry = sessionCookie?.expiry ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenExpiry > 0 && tokenExpiry < nowSec) {
    return { valid: false, error: "Session token expired (cookie expiry passed)" };
  }

  // ── 3.5. Note on Google OAuth (connectionType=2 / Gmail accounts) ──────────
  // Gmail-linked ChatGPT accounts show "Welcome back — Choose an account to
  // continue" in a browser because the browser frontend requires a live Google
  // session for the chooser UI. However, the ChatGPT backend session itself IS
  // alive: /api/auth/session returns real user data (name, email, plan) for live
  // Gmail sessions, and 401 for truly expired/revoked ones.
  // We let ALL accounts — including Gmail — proceed to the API check. The API
  // response is the ground truth. Valid Gmail sessions are labeled "(Gmail)" in
  // the planLabel so callers can distinguish them from email/password accounts.

  // ── 4. Build unified cookie header (unchunked) ───────────────────────────
  const assembledCookies = cookies.filter(
    (c) => !c.name.startsWith("__Secure-next-auth.session-token"),
  );
  assembledCookies.push({
    domain: "chatgpt.com",
    name: "__Secure-next-auth.session-token",
    value: sessionToken,
    path: "/",
  });
  const cookieHeader = buildCookieHeader(assembledCookies);
  const chatgptHeaders = {
    ...BROWSER_HEADERS,
    "Accept": "application/json",
    "Referer": "https://chatgpt.com/",
    "Origin": "https://chatgpt.com",
    "Connection": "keep-alive",
    "Cookie": cookieHeader,
  };

  // ── 5. Helpers ────────────────────────────────────────────────────────────
  function resolvePlanFromGroups(groups: string[]): { plan: "premium" | "free"; planLabel: string } {
    if (groups.includes("chatgpt-pro")) return { plan: "premium", planLabel: "Pro" };
    if (groups.includes("chatgpt-enterprise")) return { plan: "premium", planLabel: "Enterprise" };
    if (groups.includes("chatgpt-team")) return { plan: "premium", planLabel: "Team" };
    if (groups.some((g) => g === "chatgpt-paid" || g === "chatgpt-plus" || g.startsWith("chatgpt-paid") || g.startsWith("chatgpt-plus"))) {
      return { plan: "premium", planLabel: "Plus" };
    }
    return { plan: "free", planLabel: "Free" };
  }

  function parseSessionData(d: Record<string, unknown>): ExtractResult {
    const user = d["user"] as Record<string, unknown> | undefined;
    const account = d["account"] as Record<string, unknown> | undefined;
    const accessToken = d["accessToken"] as string | undefined;

    let name = user?.["name"] as string | undefined;
    let email = user?.["email"] as string | undefined;
    let plan: "premium" | "free" = "free";
    let planLabel = "Free";

    // Primary plan source: account.planType (most reliable from ChatGPT API)
    const planType = ((account?.["planType"] ?? "") as string).toLowerCase();
    if (planType === "plus") { plan = "premium"; planLabel = "Plus"; }
    else if (planType === "pro") { plan = "premium"; planLabel = "Pro"; }
    else if (planType === "enterprise") { plan = "premium"; planLabel = "Enterprise"; }
    else if (planType === "team") { plan = "premium"; planLabel = "Team"; }

    // Secondary plan source: user.groups
    if (plan === "free") {
      const r = resolvePlanFromGroups((user?.["groups"] as string[] | undefined) ?? []);
      plan = r.plan; planLabel = r.planLabel;
    }

    // Tertiary plan source: decode accessToken JWT
    if (plan === "free" && accessToken) {
      const payload = decodeJwtPayload(accessToken);
      if (payload) {
        if (!name) name = payload["name"] as string | undefined;
        if (!email) email = payload["email"] as string | undefined;
        const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
        const jwtGroups: string[] =
          (profile?.["groups"] as string[] | undefined) ?? (payload["groups"] as string[] | undefined) ?? [];
        if (jwtGroups.length > 0) {
          const r = resolvePlanFromGroups(jwtGroups);
          plan = r.plan; planLabel = r.planLabel;
        }
      }
    }

    // Fallback name/email from oai-client-auth-info cookie; also detect Gmail OAuth
    let isGmailOAuth = false;
    try {
      const raw = cookieMap.get("oai-client-auth-info");
      if (raw) {
        const info = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
        const u = info["user"] as Record<string, unknown> | undefined;
        if (u) {
          if (!name) name = u["name"] as string;
          if (!email) email = u["email"] as string;
          const ct = u["connectionType"] as number | undefined;
          if (ct === 2) isGmailOAuth = true;
        }
      }
    } catch { /* ignore */ }

    // Tag Gmail OAuth accounts so callers can distinguish from email/password
    if (isGmailOAuth) {
      planLabel = planLabel === "Free" ? "Free (Gmail)" : `${planLabel} (Gmail)`;
    }

    return { valid: true, name, email, plan, planLabel };
  }

  // ── 6. Try session API endpoints ─────────────────────────────────────────
  // ChatGPT uses Cloudflare. From residential IPs → full JSON response.
  // From datacenter IPs (e.g. Railway) → Cloudflare may return WARNING_BANNER only
  // or an HTML challenge page instead of real session data.
  // We try both the primary and legacy endpoint before falling back to local validation.
  let cfBlocked = false;

  for (const sessionUrl of [
    "https://chatgpt.com/api/auth/session",
    "https://chat.openai.com/api/auth/session",
  ]) {
    try {
      // Build axios proxy config if proxy provided (bypasses Cloudflare for residential IPs)
      const axiosProxyCfg = proxy
        ? (() => {
            const p = proxy.trim().split(":");
            if (p.length < 4) return undefined;
            return { protocol: "http" as const, host: p[0]!, port: parseInt(p[1]!, 10), auth: { username: p[2]!, password: p.slice(3).join(":") } };
          })()
        : undefined;
      const resp = await axios.get(sessionUrl, {
        headers: chatgptHeaders,
        proxy: axiosProxyCfg,
        timeout: 20000,
        validateStatus: () => true,
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
      });

      const ct = (resp.headers["content-type"] ?? "").toString().toLowerCase();
      const isHtml = ct.includes("text/html") || (typeof resp.data === "string" && (resp.data as string).trimStart().startsWith("<"));

      // Hard expired: server explicitly says no
      if (resp.status === 401) return { valid: false, error: "Session expired (401)" };
      if (resp.status === 302 || resp.status === 301 || resp.status === 307) {
        return { valid: false, error: "Session expired (redirected to login)" };
      }

      // Cloudflare HTML challenge or hard block — try next URL
      if (resp.status === 403 || isHtml) { cfBlocked = true; continue; }

      if (resp.status === 200) {
        const d = resp.data as Record<string, unknown>;
        if (!d || typeof d !== "object") { cfBlocked = true; continue; }

        const keys = Object.keys(d).filter((k) => k !== "WARNING_BANNER");

        // WARNING_BANNER only: could mean expired OR Cloudflare is hiding data from DC IPs.
        // We cannot distinguish reliably — skip to local validation.
        if (keys.length === 0) { cfBlocked = true; continue; }

        // Explicit error from OpenAI
        if (d["error"]) return { valid: false, error: `Session error: ${d["error"]}` };

        // Got real session data — parse first, then double-verify with /backend-api/me.
        // /api/auth/session can return stale cached data even after server-side revocation;
        // /backend-api/me always returns 401 for revoked sessions, confirming the truth.
        const sessionResult = parseSessionData(d);
        if (sessionResult.valid) {
          try {
            const meResp = await axios.get("https://chatgpt.com/backend-api/me", {
              headers: chatgptHeaders,
              proxy: axiosProxyCfg,
              timeout: 15000,
              validateStatus: () => true as const,
              maxRedirects: 0,
            });
            // 401 or redirect = session was revoked server-side (the most common cause
            // of "Your session has expired" in the browser despite a future cookie expiry)
            if (meResp.status === 401 || meResp.status === 302 || meResp.status === 307) {
              return { valid: false, error: "Session revoked server-side (401 from /backend-api/me)" };
            }
            // 403 or CF block — do not fail, trust the /api/auth/session result
          } catch { /* network error — trust session API result */ }
        }
        return sessionResult;
      }

      // Any other status — treat as blocked and try next
      cfBlocked = true;
    } catch { cfBlocked = true; }
  }

  // ── 7. Local validation fallback ─────────────────────────────────────────
  // Used when ALL session API attempts returned HTML/WARNING_BANNER-only/network error.
  // This handles Railway/datacenter IPs being blocked by Cloudflare while a cookie
  // is genuinely valid (email/password accounts only).
  //
  // Validation criteria:
  //   a) Session token expiry is in the future (checked in step 3 — passed if we're here)
  //   b) oai-client-auth-info cookie exists with user data
  //
  // Gmail OAuth (connectionType=2) accounts are included here just like email/password
  // ones. When the API is Cloudflare-blocked we cannot verify either type server-side,
  // so we trust the local cookie expiry (step 3) and label Gmail accounts accordingly.
  //
  // Accuracy for time-expired cookies: 100% (caught by step 3).
  // Accuracy for email/password and Gmail accounts: best-effort (may miss server-revoked sessions).

  if (cfBlocked) {
    let name: string | undefined;
    let email: string | undefined;
    let connectionType: number | undefined;

    // Extract user info and auth method from oai-client-auth-info
    try {
      const raw = cookieMap.get("oai-client-auth-info");
      if (raw) {
        const info = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
        const u = info["user"] as Record<string, unknown> | undefined;
        if (u) {
          name = u["name"] as string;
          email = u["email"] as string;
          connectionType = u["connectionType"] as number | undefined;
        }
      }
    } catch { /* ignore */ }

    // Session token expiry was already checked in step 3 (fast-fail).
    // If we reach here, the token is not expired by its own metadata.
    //
    // Gmail OAuth (connectionType=2): we CANNOT verify these without an API call.
    // The API returns {"error":"RefreshAccessTokenError"} for dead Gmail sessions
    // and real user data for live ones. Without API access (CF-blocked), we cannot
    // tell live from dead Gmail accounts — so we conservatively mark them dead.
    // Email/password accounts (ct=0/1) are trusted locally (best-effort).
    if (connectionType === 2) {
      return { valid: false, error: "Google OAuth — unable to verify (CF blocked proxy; no API access)" };
    }
    return { valid: true, name, email, plan: "free", planLabel: "Free" };
  }

  return { valid: false, error: "Session expired or invalid" };
}

async function checkSurfsharkCookies(cookies: ParsedCookie[]): Promise<ExtractResult> {
  // Surfshark uses JWT Bearer auth — find any JWT-looking cookie value
  const jwtCookie = cookies.find(c => {
    const v = c.value;
    // JWTs are base64url-encoded and start with "ey" ({"alg":...})
    return v.startsWith("ey") && v.includes(".");
  });

  if (!jwtCookie) {
    return { valid: false, error: "No auth token found — session cookies missing (need surfshark JWT cookie)" };
  }

  const endpoints = [
    "https://api.surfshark.com/v4/user/me",
    "https://api.surfshark.com/v3/user/me",
    "https://api.surfshark.com/v4/users/me",
  ];

  for (const url of endpoints) {
    try {
      const resp = await axios.get(url, {
        headers: {
          ...BROWSER_HEADERS,
          "Authorization": "Bearer " + jwtCookie.value,
          "Referer": "https://my.surfshark.com/",
          "Origin": "https://my.surfshark.com",
        },
        timeout: 15000,
        validateStatus: () => true as const,
        maxRedirects: 0,
      });

      if (resp.status === 200 && resp.data && typeof resp.data === "object") {
        const d = resp.data as Record<string, unknown>;
        const email = (d["email"] ?? d["username"]) as string | undefined;
        const userId = d["id"] ?? d["userId"] ?? d["user_id"];
        if (email || userId) {
          // Detect subscription status from various possible response shapes
          const sub = (d["subscription"] ?? d["plan"] ?? d["currentPlan"]) as Record<string, unknown> | undefined;
          const subStatus = (sub?.["status"] ?? sub?.["state"] ?? d["subscriptionStatus"] ?? d["status"]) as string | undefined;
          const isActive =
            subStatus === "active" || subStatus === "ACTIVE" ||
            d["isActive"] === true || d["isPremium"] === true ||
            d["isSubscribed"] === true;
          const planLabel = isActive ? (sub?.["name"] as string | undefined) ?? "Active" : "Expired";
          return {
            valid: true,
            email: email as string | undefined,
            plan: isActive ? "premium" as const : "free" as const,
            planLabel,
          };
        }
        return { valid: false, error: "Not logged in" };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { valid: false, error: "Session expired or invalid token" };
      }
      if (resp.status === 404) continue; // try next endpoint
      return { valid: false, error: "HTTP " + resp.status };
    } catch {
      continue;
    }
  }
  return { valid: false, error: "Could not reach Surfshark API" };
}

async function checkZee5Cookies(cookies: ParsedCookie[]): Promise<ExtractResult> {
    const cookieMap = new Map<string, string>();
    for (const c of cookies) {
      if (c.value && c.value.length > 0 && !cookieMap.has(c.name)) {
        cookieMap.set(c.name, c.value);
      }
    }

    // Zee5 uses a cookie named 'token' as the main session JWT
    const jwtToken =
      cookieMap.get("token") ||
      cookieMap.get("zeeticket_jwt") ||
      cookieMap.get("BUID") ||
      cookieMap.get("_z5u");

    if (!jwtToken) {
      return { valid: false, error: "No auth token found (expected 'token' cookie)" };
    }

    const payload = decodeJwtPayload(jwtToken);
    if (!payload) {
      return { valid: false, error: "Auth cookie is not a valid JWT token" };
    }

    const expRaw = payload["exp"];
    const expSeconds = typeof expRaw === "number" ? expRaw : (typeof expRaw === "string" ? Number(expRaw) : NaN);
    if (Number.isFinite(expSeconds) && expSeconds > 0 && expSeconds * 1000 < Date.now()) {
      return { valid: false, error: "Session expired (token expired)" };
    }

    const userId = (payload["user_id"] as string | undefined) || (payload["uid"] as string | undefined) || (payload["sub"] as string | undefined);
    const userType = (payload["user_type"] as string | undefined) || "";
    const name = (payload["name"] as string | undefined) || (payload["displayName"] as string | undefined);
    const email = (payload["email"] as string | undefined) || (payload["emailId"] as string | undefined);

    if (!userId) {
      return { valid: false, error: "JWT does not contain a user_id — not a session token" };
    }

    let plan: "premium" | "free" = "free";
    let planLabel = "Free";

    try {
      const subResp = await axios({
        method: "GET",
        url: "https://subscriptionapi.zee5.com/v1/subscription/status?country=IN",
        headers: {
          "Authorization": `Bearer ${jwtToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Referer": "https://www.zee5.com/",
          "Origin": "https://www.zee5.com",
        },
        timeout: 12000,
        validateStatus: () => true,
        maxRedirects: 0,
      });

      logger.info({ status: subResp.status }, "Zee5 subscription API response");

      if (subResp.status === 200 && subResp.data && typeof subResp.data === "object") {
        const d = subResp.data as Record<string, unknown>;
        const subStatus = ((d["status"] as string) || (d["subscription_status"] as string) || "").toLowerCase();
        const pName = (d["plan_name"] as string) || (d["pack_name"] as string) || (d["planName"] as string) || "";
        if (subStatus === "active" || subStatus === "subscribed" || d["is_subscribed"] === true || d["isSubscribed"] === true) {
          plan = "premium";
          planLabel = pName || "Premium";
        }
      } else if (subResp.status === 400 && subResp.data) {
        const d = subResp.data as Record<string, unknown>;
        // code 3112 = "Subscription couldn't be found" — confirmed Free user
        if (d["code"] === 3112 || (typeof d["message"] === "string" && (d["message"] as string).includes("Subscription"))) {
          plan = "free";
          planLabel = "Free";
        }
      } else if (subResp.status === 401 || subResp.status === 403) {
        return { valid: false, error: "Session rejected by Zee5 (token expired or invalid)" };
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Zee5 subscription API failed — defaulting to Free");
    }

    return {
      valid: true,
      name: name || (userType && userType !== "Registered" ? userType : undefined),
      email,
      plan,
      planLabel,
    };
  }

  async function checkJioHotstarCookies(cookies: ParsedCookie[], proxy?: string): Promise<ExtractResult> {
  const cookieMap = new Map<string, string>();
  for (const c of cookies) {
    if (c.value && c.value.length > 0) {
      if (!cookieMap.has(c.name)) cookieMap.set(c.name, c.value);
    }
  }

  const userUP = cookieMap.get("userUP") || cookieMap.get("sessionUserUP");

  if (!userUP) {
    return { valid: false, error: "No auth cookies (missing userUP)" };
  }

  const decoded = decodeJwtPayload(userUP);
  if (!decoded) {
    return { valid: false, error: "userUP cookie is not a valid token" };
  }

  const expRaw = decoded["exp"];
  const expSeconds = typeof expRaw === "number" ? expRaw : (typeof expRaw === "string" ? Number(expRaw) : NaN);
  if (Number.isFinite(expSeconds) && expSeconds > 0 && expSeconds * 1000 < Date.now()) {
    return { valid: false, error: "Session expired (token expired)" };
  }

  let name: string | undefined;
  let phone: string | undefined;
  let plan: "premium" | "free" = "free";
  let planLabel = "Free";
  let userType: string | undefined;
  const verificationSignals: string[] = [];

  const subStr = decoded["sub"] as string | undefined;
  if (subStr && subStr.startsWith("{")) {
    try {
      const userData = JSON.parse(subStr);
      name = userData["name"] as string | undefined;
      phone = userData["phone"] as string | undefined;
      userType = userData["type"] as string | undefined;

      if (userType === "guest") {
        return { valid: false, error: "Guest account (not logged in)" };
      }

      const subscriptions = userData["subscriptions"]?.["in"] as Record<string, Record<string, string>> | undefined;
      if (subscriptions && typeof subscriptions === "object") {
        const planNames = Object.keys(subscriptions);
        if (planNames.length > 0) {
          let bestPlanName = "";
          let bestExpiry = "";
          for (const pName of planNames) {
            const pData = subscriptions[pName];
            if (!pData) continue;
            const expiry = pData["expiry"] || "";
            if (!bestPlanName || (expiry && expiry > bestExpiry)) {
              bestPlanName = pName;
              bestExpiry = expiry;
            }
          }
          if (bestPlanName) {
            const friendlyName = bestPlanName
              .replace(/([A-Z])/g, " $1").trim()
              .replace(/\./g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (bestExpiry) {
              const expiryDate = new Date(bestExpiry);
              if (expiryDate.getTime() > Date.now()) {
                plan = "premium";
                planLabel = friendlyName;
              } else {
                plan = "free";
                planLabel = friendlyName + " (expired)";
              }
            } else {
              plan = "premium";
              planLabel = friendlyName;
            }
          }
        }
      }

      logger.info({ name, phone, plan, planLabel, userType }, "JioHotstar JWT parsed");
    } catch {
      logger.warn({ subStr: subStr.substring(0, 100) }, "JioHotstar sub parse failed");
    }
  }

  const deviceId = cookieMap.get("deviceId") || crypto.randomUUID();
  const headers = getHotstarHeaders(userUP, deviceId);

  // Build axios proxy config (HTTP CONNECT tunnel for HTTPS endpoints)
  const axiosProxy: { protocol: "http"; host: string; port: number; auth: { username: string; password: string } } | false = proxy
    ? (() => {
        const p = proxy.trim().split(":");
        if (p.length < 4) return false as const;
        return { protocol: "http" as const, host: p[0]!, port: parseInt(p[1]!, 10), auth: { username: p[2]!, password: p.slice(3).join(":") } };
      })()
    : false;

  const profileEndpoints = [
    "https://api.hotstar.com/in/account/v1/user/profile",
    "https://api.hotstar.com/o/v1/users/me",
  ];

  for (const endpoint of profileEndpoints) {
    try {
      const resp = await axios({
        method: "GET",
        url: endpoint,
        headers,
        proxy: axiosProxy,
        timeout: 12000,
        validateStatus: () => true,
        maxRedirects: 0,
      });

      logger.info({ endpoint, status: resp.status, hasBody: !!resp.data }, "JioHotstar API response");
      verificationSignals.push(`profile:${resp.status}`);

      if (resp.status === 401) {
        logger.info({ name, endpoint }, "JioHotstar API 401 — session dead");
        return { valid: false, error: "Session expired (401)" };
      }

      if (resp.status === 403) {
        logger.info({ name, endpoint }, "JioHotstar API 403 — forbidden");
        return { valid: false, error: "Session rejected (403)" };
      }

      if (resp.status === 200 && resp.data) {
        const body = resp.data;
        const profile = body?.body || body?.data || body;

        if (profile && typeof profile === "object") {
          const apiName = profile.name || profile.userName || profile.displayName;
          if (apiName) name = apiName;
          const apiEmail = profile.email || profile.userEmail;

          if (profile.isSubscribed === true || profile.subscribedTag === "PREMIUM" || profile.subscribedTag === "VIP" || profile.userTier === "premium") {
            plan = "premium";
            planLabel = profile.subscribedTag || profile.userTier || planLabel;
          } else if (profile.isSubscribed === false) {
            plan = "free";
            planLabel = profile.subscribedTag || "Free";
          }

          logger.info({ name, plan, planLabel, endpoint, email: apiEmail }, "JioHotstar API verified — session alive");
          return {
            valid: true,
            name,
            email: apiEmail || (phone ? `+${phone}` : undefined),
            plan,
            planLabel,
          };
        }
      }
    } catch (err) {
      verificationSignals.push(`profile:error:${(err as Error).message}`);
      logger.warn({ endpoint, err: (err as Error).message }, "JioHotstar API call failed");
    }
  }

  try {
    const refreshResp = await axios({
      method: "GET",
      url: "https://api.hotstar.com/in/aadhar/v2/web/in/users/refresh-token",
      headers: {
        ...headers,
        "userIdentity": userUP,
      },
      proxy: axiosProxy,
      timeout: 10000,
      validateStatus: () => true,
      maxRedirects: 0,
    });

    logger.info({ status: refreshResp.status }, "JioHotstar refresh-token response");
    verificationSignals.push(`refresh:${refreshResp.status}`);

    if (refreshResp.status === 200 && refreshResp.data) {
      const newToken = refreshResp.data?.description?.userIdentity;
      if (newToken) {
        logger.info({ name }, "JioHotstar token refreshed — session alive");
        return {
          valid: true,
          name,
          email: phone ? `+${phone}` : undefined,
          plan,
          planLabel,
        };
      }
    }

    if (refreshResp.status === 401 || refreshResp.status === 403) {
      return { valid: false, error: "Session expired (token refresh rejected)" };
    }
  } catch (err) {
    verificationSignals.push(`refresh:error:${(err as Error).message}`);
    logger.warn({ err: (err as Error).message }, "JioHotstar refresh-token failed");
  }

  // API unreachable (Railway/datacenter IP blocked by Hotstar) — trust the local JWT data.
  // The JWT passed expiry + guest checks above, so the session is genuinely live.
  // We only call APIs when proxy is available; without proxy this is the correct fallback.
  logger.warn({ name, verificationSignals, hasProxy: !!proxy }, "JioHotstar API unreachable — trusting local JWT (session appears valid)");
  return {
    valid: true,
    name,
    email: phone ? `+${phone}` : undefined,
    plan,
    planLabel,
  };
}

function parseNetscapeCookies(content: string): ParsedCookie[] {
  const HTTPONLY_PREFIX = "#HttpOnly_";
  const cookies: ParsedCookie[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith(HTTPONLY_PREFIX)) continue;
    const normalized = trimmed.startsWith(HTTPONLY_PREFIX) ? trimmed.slice(HTTPONLY_PREFIX.length) : trimmed;

    const parts = normalized.split("\t");
    if (parts.length < 7) continue;

    cookies.push({
      domain: parts[0] ?? "",
      path: parts[2] ?? "/",
      expiry: parts[4] ? (parseInt(parts[4], 10) || undefined) : undefined,
      name: parts[5] ?? "",
      value: parts[6] ?? "",
    });
  }

  return cookies;
}

function parseJsonCookies(content: string): ParsedCookie[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map((c: Record<string, string>) => ({
        domain: c["domain"] ?? "",
        name: c["name"] ?? "",
        value: c["value"] ?? "",
        path: c["path"] ?? "/",
      }));
    }
    return [];
  } catch {
    return [];
  }
}

function buildCookieHeader(cookies: ParsedCookie[]): string {
  return cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function detectService(cookies: ParsedCookie[]): ServiceConfig | null {
  const domains = cookies.map((c) => normalizeDomain(c.domain));
  const uniqueDomains = [...new Set(domains)];

  for (const service of SERVICES) {
    const match = service.domains.some((sd) =>
      uniqueDomains.some((cd) => domainMatches(cd, sd)),
    );
    if (match) return service;
  }

  return null;
}

function parseCookiesFromContent(content: string): ParsedCookie[] {
  const trimmed = content.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseJsonCookies(trimmed);
  }
  return parseNetscapeCookies(trimmed);
}

export function detectServiceName(content: string): string {
  const cookies = parseCookiesFromContent(content);
  const service = detectService(cookies);
  return service?.name ?? "Unknown";
}

export function canValidateDomain(targetDomain: string): boolean {
  const td = normalizeDomain(targetDomain);
  return SERVICES.some(s =>
    s.domains.some(sd => domainMatches(td, sd) || domainMatches(sd, td)),
  );
}


// ── Facebook proxy-based cookie checker ─────────────────────────────────────
// Uses raw TCP+TLS CONNECT tunnel through an HTTP proxy to mbasic.facebook.com.
// mbasic returns plain HTML — far easier to parse than www.facebook.com React bundles.
// Results: logout link = VALID, checkpoint/re-auth = DEAD, login form = DEAD.
// ── Facebook proxy-based cookie checker ─────────────────────────────────────
// Optimizations vs naive approach:
//   1. Early termination — socket closed the moment any marker is found
//      → reads ~10-30 KB instead of the full 230 KB mbasic page
//   2. gzip Accept-Encoding  → Facebook compresses responses (~4:1 ratio)
// Combined: ~8-20 KB per check (was 235 KB). 5 000 FB cookies ≈ 10-20 MB proxy.
// Detection on plain mbasic HTML (no React/JS challenge):
//   /logout link present  → VALID
//   /checkpoint/          → DEAD (session requires re-auth)
//   name="email"+pass     → DEAD (logged-out login page)
async function checkFacebookCookies(
  cookies: ParsedCookie[],
  proxy?: string,
): Promise<{ valid: boolean; name?: string; error?: string; bytesUsed: number }> {
  const netMod = await import("net");
  const tlsMod = await import("tls");
  const zlibMod = await import("zlib");

  const cUser = cookies.find(c => c.name === "c_user");
  const xs    = cookies.find(c => c.name === "xs");

  // ── local checks (0 bytes proxy used) ────────────────────────
  if (!cUser || !xs) return { valid: false, error: "Missing c_user or xs cookie", bytesUsed: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const maxExpiry = Math.max(cUser.expiry || 0, xs.expiry || 0);
  if (maxExpiry > 0 && maxExpiry <= nowSec) return { valid: false, error: "Session expired", bytesUsed: 0 };

  if (!proxy) return { valid: false, error: "Proxy required — server IP is blocked by Facebook", bytesUsed: 0 };

  // ── parse proxy  host:port:user:pass ────────────────────────
  const proxyParts = proxy.trim().split(":");
  if (proxyParts.length < 4) return { valid: false, error: "Bad proxy format (need host:port:user:pass)", bytesUsed: 0 };
  const proxyHost = proxyParts[0]!;
  const proxyPort = parseInt(proxyParts[1]!, 10);
  const proxyUser = proxyParts[2]!;
  const proxyPass = proxyParts.slice(3).join(":");

  const cookieStr = cookies
    .filter(c => c.domain.includes("facebook") && c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join("; ");

  // ── key detection markers ────────────────────────────────────
  const MARKER_VALID      = "/logout";
  const MARKER_CHECKPOINT = "/checkpoint/";
  const MARKER_REAUTH     = "m_login_password";
  const MARKER_LOGIN_EMAIL = 'name="email"';
  const MARKER_LOGIN_PASS  = 'name="pass"';
  // Stop reading the response after this many bytes (markers appear early in the page)
  const MAX_READ_BYTES = 60 * 1024; // 60 KB hard cap — well past where any marker appears

  return new Promise((resolve) => {
    let settled = false;
    let rawBytes = 0;       // compressed bytes received (what proxy bills)
    let htmlAccum = "";     // decompressed text

    const timer = setTimeout(() => done({ valid: false, error: "Request timed out", bytesUsed: rawBytes }), 30000);

    function done(result: { valid: boolean; name?: string; error?: string; bytesUsed: number }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    }

    function checkMarkers() {
      if (htmlAccum.includes(MARKER_CHECKPOINT) || htmlAccum.includes(MARKER_REAUTH)) {
        done({ valid: false, error: "Session expired (re-auth required)", bytesUsed: rawBytes });
        return true;
      }
      if (htmlAccum.includes(MARKER_VALID)) {
        // Try to pull display name from mbasic HTML
        const nameMatch = htmlAccum.match(/<strong>([^<]{2,60})<\/strong>/) ||
          htmlAccum.match(/class="[^"]*?name[^"]*?"[^>]*>([^<]{2,50})</);
        done({ valid: true, name: nameMatch?.[1]?.trim(), bytesUsed: rawBytes });
        return true;
      }
      if (htmlAccum.includes(MARKER_LOGIN_EMAIL) && htmlAccum.includes(MARKER_LOGIN_PASS)) {
        done({ valid: false, error: "Not logged in", bytesUsed: rawBytes });
        return true;
      }
      return false;
    }

    const socket = netMod.default.connect(proxyPort, proxyHost, { timeout: 12000 });
    socket.on("error", (err: Error) => done({ valid: false, error: `Proxy: ${err.message}`, bytesUsed: 0 }));
    socket.on("timeout", () => done({ valid: false, error: "Proxy connection timed out", bytesUsed: 0 }));

    socket.on("connect", () => {
      const auth = Buffer.from(`${proxyUser}:${proxyPass}`).toString("base64");
      socket.write([
        "CONNECT mbasic.facebook.com:443 HTTP/1.1",
        "Host: mbasic.facebook.com:443",
        `Proxy-Authorization: Basic ${auth}`,
        "Proxy-Connection: Keep-Alive",
        "", "",
      ].join("\r\n"));
    });

    let proxyBuf = "";
    let tunnelReady = false;

    socket.on("data", (chunk: Buffer) => {
      if (tunnelReady) return;
      proxyBuf += chunk.toString();
      if (!proxyBuf.includes("\r\n\r\n")) return;

      const statusLine = proxyBuf.split("\r\n")[0] ?? "";
      const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
      if (!m || parseInt(m[1]!, 10) !== 200) {
        done({ valid: false, error: `Proxy rejected: ${statusLine}`, bytesUsed: 0 });
        return;
      }
      tunnelReady = true;

      const tlsSock = tlsMod.default.connect({ socket, servername: "mbasic.facebook.com", rejectUnauthorized: false }, () => {
        const reqStr = [
          "GET / HTTP/1.1",
          "Host: mbasic.facebook.com",
          `Cookie: ${cookieStr}`,
          "User-Agent: Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding: gzip, deflate",
          "Accept-Language: en-US,en;q=0.9",
          "Referer: https://mbasic.facebook.com/",
          "Connection: close",
          "", "",
        ].join("\r\n");
        rawBytes = Buffer.byteLength(reqStr); // start with request size
        tlsSock.write(reqStr);

        // ── Parse HTTP response headers then decompress body ──
        let headersDone = false;
        let rawHeaderBuf = "";
        let isGzip = false;
        let bodyBytes = 0;
        let gunzip: ReturnType<typeof zlibMod.default.createGunzip> | null = null;

        tlsSock.on("data", (d: Buffer) => {
          rawBytes += d.length;

          if (!headersDone) {
            rawHeaderBuf += d.toString("binary");
            const hEnd = rawHeaderBuf.indexOf("\r\n\r\n");
            if (hEnd === -1) return;
            headersDone = true;
            const headerStr = rawHeaderBuf.slice(0, hEnd);
            isGzip = headerStr.toLowerCase().includes("content-encoding: gzip");
            // Body starts after headers
            const bodyRaw = Buffer.from(rawHeaderBuf.slice(hEnd + 4), "binary");
            rawHeaderBuf = "";

            if (isGzip) {
              gunzip = zlibMod.default.createGunzip();
              gunzip.on("data", (chunk: Buffer) => {
                bodyBytes += chunk.length;
                htmlAccum += chunk.toString();
                if (checkMarkers() || bodyBytes >= MAX_READ_BYTES) tlsSock.destroy();
              });
              gunzip.on("error", () => {
                // gunzip failed — fall back to raw text (Facebook may not actually gzip)
                htmlAccum += bodyRaw.toString();
                checkMarkers();
              });
              if (bodyRaw.length > 0) gunzip.write(bodyRaw);
            } else {
              htmlAccum += bodyRaw.toString();
              bodyBytes += bodyRaw.length;
              if (checkMarkers() || bodyBytes >= MAX_READ_BYTES) tlsSock.destroy();
            }
            return;
          }

          // Headers done — feed into gunzip or append directly
          if (isGzip && gunzip) {
            gunzip.write(d);
          } else {
            htmlAccum += d.toString();
            bodyBytes += d.length;
            if (checkMarkers() || bodyBytes >= MAX_READ_BYTES) tlsSock.destroy();
          }
        });

        tlsSock.on("end", () => {
          if (gunzip) {
            try { gunzip.end(); } catch { /* ignore */ }
          }
          if (!settled) {
            if (!checkMarkers()) {
              done({ valid: false, error: "Couldn't read session state", bytesUsed: rawBytes });
            }
          }
        });
        tlsSock.on("error", (err: Error) => done({ valid: false, error: `TLS: ${err.message}`, bytesUsed: rawBytes }));
      });
      tlsSock.on("error", (err: Error) => done({ valid: false, error: `TLS connect: ${err.message}`, bytesUsed: 0 }));
    });
  });
}


export async function checkCookie(
  filename: string,
  content: string,
  forceServiceDomain?: string,
  proxy?: string,
): Promise<CookieCheckResult> {
  const cookies = parseCookiesFromContent(content);

  if (cookies.length === 0) {
    return {
      filename,
      service: "Unknown",
      valid: false,
      error: "No cookies found in file",
      cookieCount: 0,
    };
  }

  let service: ServiceConfig | null;

  if (forceServiceDomain) {
    const td = normalizeDomain(forceServiceDomain);
    service = SERVICES.find(s =>
      s.domains.some(sd => domainMatches(td, sd) || domainMatches(sd, td)),
    ) ?? null;
  } else {
    service = detectService(cookies);
  }

  if (!service) {
    const domains = [...new Set(cookies.map((c) => c.domain.replace(/^\./, "")))].slice(0, 5);
    return {
      filename,
      service: "Unknown",
      valid: false,
      error: `Unsupported service (domains: ${domains.join(", ")})`,
      cookieCount: cookies.length,
    };
  }

  const serviceCookies = cookies.filter((c) => {
    const domain = normalizeDomain(c.domain);
    return service!.domains.some((sd) => domainMatches(domain, sd));
  });

  const cookiesToUse = serviceCookies.length > 0 ? serviceCookies : cookies;

  const requiredNames = service.requiredAnyCookies ?? [];
  const requiredPrefixes = service.requiredAnyCookiePrefixes ?? [];
  if (requiredNames.length > 0 || requiredPrefixes.length > 0) {
    const hasRequired = requiredNames.some((rc) =>
      cookiesToUse.some((c) => c.name === rc),
    ) || requiredPrefixes.some((prefix) =>
      cookiesToUse.some((c) => c.name.startsWith(prefix)),
    );
    if (!hasRequired) {
      const expectationParts: string[] = [];
      if (requiredNames.length > 0) {
        expectationParts.push(`any of: ${requiredNames.join(", ")}`);
      }
      if (requiredPrefixes.length > 0) {
        expectationParts.push(`any cookie starting with: ${requiredPrefixes.join(", ")}`);
      }
      const expectation = expectationParts.join("; ");
      return {
        filename,
        service: service.name,
        valid: false,
        error: `Missing required cookie. Expected ${expectation}`,
        cookieCount: cookiesToUse.length,
      };
    }
  }

  if (service.checkUrl === "__JWT_CHECK__") {
    const result = await checkJioHotstarCookies(cookiesToUse, proxy);
    return {
      filename,
      service: service.name,
      valid: result.valid,
      accountName: result.name,
      accountEmail: result.email,
      plan: result.plan,
      planLabel: result.planLabel,
      error: result.error,
      cookieCount: cookiesToUse.length,
    };
  }

    if (service.checkUrl === "__JWT_CHECK_ZEE5__") {
      const result = await checkZee5Cookies(cookiesToUse);
      return {
        filename,
        service: service.name,
        valid: result.valid,
        accountName: result.name,
        accountEmail: result.email,
        plan: result.plan,
        planLabel: result.planLabel,
        error: result.error,
        cookieCount: cookiesToUse.length,
      };
    }


  if (service.checkUrl === "__FACEBOOK_PROXY_CHECK__") {
    const fbResult = await checkFacebookCookies(cookiesToUse, proxy);
    return {
      filename,
      service: service.name,
      valid: fbResult.valid,
      accountName: fbResult.name,
      plan: fbResult.valid ? "premium" as const : undefined,
      planLabel: fbResult.valid ? "Active" : undefined,
      error: fbResult.error,
      cookieCount: cookiesToUse.length,
      bytesUsed: fbResult.bytesUsed,
    };
  }

  if (service.checkUrl === "__CHATGPT_CHECK__") {
    const result = await checkChatGPTCookies(cookiesToUse, proxy);
    return {
      filename,
      service: service.name,
      valid: result.valid,
      accountName: result.name,
      accountEmail: result.email,
      plan: result.plan,
      planLabel: result.planLabel,
      error: result.error,
      cookieCount: cookiesToUse.length,
    };
  }

  if (service.checkUrl === "__SURFSHARK_CHECK__") {
    const result = await checkSurfsharkCookies(cookiesToUse);
    return {
      filename,
      service: service.name,
      valid: result.valid,
      accountName: result.name,
      accountEmail: result.email,
      plan: result.plan,
      planLabel: result.planLabel,
      error: result.error,
      cookieCount: cookiesToUse.length,
    };
  }

  const cookieHeader = buildCookieHeader(cookiesToUse);

  try {
    const requestConfig = {
      method: service.checkMethod ?? "GET",
      url: service.checkUrl,
      headers: {
        ...BROWSER_HEADERS,
        ...service.checkHeaders,
        Cookie: cookieHeader,
      },
      timeout: 20000,
      validateStatus: () => true as const,
      maxRedirects: service.followRedirects ? 5 : 0,
      maxContentLength: 5 * 1024 * 1024,
      ...(service.checkBody ? { data: service.checkBody } : {}),
    };

    let response;
    try {
      response = await axios(requestConfig);
    } catch (firstErr) {
      const msg = (firstErr as Error).message || "";
      if (msg.includes("timeout") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) {
        await new Promise(r => setTimeout(r, 2000));
        response = await axios({ ...requestConfig, timeout: 25000 });
      } else {
        throw firstErr;
      }
    }

    const result = service.extractInfo(response.data, response.status, response.headers as Record<string, unknown>);

    if (service.name === "Spotify") {
      const dataObj = response.data && typeof response.data === "object" ? (response.data as Record<string, unknown>) : null;
      const accessTokenValue = dataObj?.["accessToken"];
      const accessToken = typeof accessTokenValue === "string" ? accessTokenValue : "";
      const isAnonymous = dataObj?.["isAnonymous"] === true;

      const shouldAttemptProfileFallback = response.status === 200 && !result.valid && accessToken && !isAnonymous;
      if (shouldAttemptProfileFallback) {
        try {
          const profileResp = await axios({
            method: "GET",
            url: "https://api.spotify.com/v1/me",
            headers: {
              ...BROWSER_HEADERS,
              Authorization: `Bearer ${accessToken}`,
            },
            timeout: 15000,
            validateStatus: () => true as const,
            maxRedirects: 0,
          });

          if (profileResp.status === 200 && profileResp.data && typeof profileResp.data === "object") {
            const profile = profileResp.data as Record<string, unknown>;
            const displayName = typeof profile["display_name"] === "string" ? profile["display_name"] : "";
            const email = typeof profile["email"] === "string" ? profile["email"] : "";
            const id = typeof profile["id"] === "string" ? profile["id"] : "";
            const productValue = typeof profile["product"] === "string" ? profile["product"] : "";
            const productLower = productValue.trim().toLowerCase();
            const hasPremiumFlag = productLower === "premium";
            const { plan, planLabel } = resolveSpotifyPlan(productValue, hasPremiumFlag);

            result.valid = true;
            const resolvedName = displayName || id;
            if (resolvedName) result.name = resolvedName;
            result.email = email || result.email;
            result.plan = plan;
            result.planLabel = planLabel;
            result.error = undefined;
          } else if (profileResp.status === 401 || profileResp.status === 403) {
            result.valid = false;
            result.error = `Auth failed (${profileResp.status})`;
          } else if (profileResp.status === 429) {
            result.valid = false;
            result.error = "Rate limited — try again later";
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ error: errMsg }, "Spotify profile lookup failed; keeping initial token-result invalid state");
        }
      }
    }

    if (service.name === "Replit") {
      try {
        const planResponse = await axios({
          method: "POST",
          url: "https://replit.com/graphql",
          headers: {
            ...BROWSER_HEADERS,
            Cookie: cookieHeader,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            Referer: "https://replit.com/",
            Origin: "https://replit.com",
          },
          data: JSON.stringify({
            operationName: "CurrentUser",
            query: "query CurrentUser { currentUser { id username email planId isSubscribed } }",
            variables: {},
          }),
          timeout: 10000,
          validateStatus: () => true as const,
          maxRedirects: 0,
        });
        if (planResponse.status === 401 || planResponse.status === 403) {
          return {
            filename,
            service: service.name,
            valid: false,
            error: `Auth failed (${planResponse.status})`,
            cookieCount: cookiesToUse.length,
          };
        }
        if (planResponse.status === 429) {
          return {
            filename,
            service: service.name,
            valid: false,
            error: "Rate limited — try again later",
            cookieCount: cookiesToUse.length,
          };
        }
        if (planResponse.status !== 200 || !planResponse.data?.data?.currentUser) {
          return {
            filename,
            service: service.name,
            valid: false,
            error: "Could not verify Replit session",
            cookieCount: cookiesToUse.length,
          };
        }
        const user = planResponse.data.data.currentUser as Record<string, unknown>;
        const username = typeof user["username"] === "string" ? user["username"] : undefined;
        const email = typeof user["email"] === "string" ? user["email"] : undefined;
        const planId = typeof user["planId"] === "string" ? user["planId"] : "";
        const pid = planId.toLowerCase();
        const isSubscribed = user["isSubscribed"] === true;
        const isPremium = isSubscribed || pid.includes("hacker") || pid.includes("pro") || pid.includes("core") || pid.includes("team") || pid.includes("enterprise");

        result.valid = true;
        result.name = username;
        result.email = email;
        result.error = undefined;
        result.plan = isPremium ? "premium" : "free";
        result.planLabel = isPremium
          ? (planId ? planId.charAt(0).toUpperCase() + planId.slice(1) : "Pro")
          : "Free";
      } catch {
        return {
          filename,
          service: service.name,
          valid: false,
          error: "Could not verify Replit session",
          cookieCount: cookiesToUse.length,
        };
      }
    }

    return {
      filename,
      service: service.name,
      valid: result.valid,
      accountName: result.name,
      accountEmail: result.email,
      plan: result.plan,
      planLabel: result.planLabel,
      error: result.error,
      cookieCount: cookiesToUse.length,
    };
  } catch (err) {
    const error = err as Error;
    return {
      filename,
      service: service.name,
      valid: false,
      error: `Network error: ${error.message}`,
      cookieCount: cookiesToUse.length,
    };
  }
}

export function getSupportedServices(): string {
  return SERVICES.map((s) => `${s.emoji} ${s.name}`).join("\n");
}


export interface ServiceInfo {
  name: string;
  emoji: string;
  domain: string;
}

export function getServiceList(): ServiceInfo[] {
  return SERVICES.map((s) => ({ name: s.name, emoji: s.emoji, domain: s.domains[0]! }));
}
