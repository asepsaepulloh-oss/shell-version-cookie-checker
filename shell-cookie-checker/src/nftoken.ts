// Netflix iOS API — fetches a short-lived nftoken login URL from a NetflixId cookie.

const NF_IOS_API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48";

const NF_IOS_QUERY = new URLSearchParams({
  appVersion: "15.48.1",
  config: '{"gamesInTrailersEnabled":"false"}',
  device_type: "NFAPPL-02-",
  esn: "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  idiom: "phone",
  iosVersion: "15.8.5",
  languages: "en-US",
  locale: "en-US",
  maxDeviceWidth: "375",
  model: "saget",
  odpAware: "true",
  path: '["account","token","default"]',
  pathFormat: "graph",
  responseFormat: "json",
}).toString();

const NF_IOS_HEADERS: Record<string, string> = {
  "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
  "x-netflix.request.attempt": "1",
  "x-netflix.context.app-version": "15.48.1",
  "x-netflix.client.type": "argo",
  "x-netflix.client.ftl.esn":
    "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  "x-netflix.context.locales": "en-US",
  "x-netflix.argo.translated": "true",
  "accept-language": "en-US;q=1",
};

export function parseNetflixId(content: string): string {
  // Netscape TSV format (tab-separated, 7+ columns)
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("\t");
    if (parts.length >= 7 && parts[5]?.trim().toLowerCase() === "netflixid") {
      return parts.slice(6).join(" ").trim();
    }
  }

  // Raw cookie header string: key=val; key=val
  const raw = content.match(/(?<![A-Za-z])NetflixId=([^;\s,\n\r]+)/i);
  if (raw?.[1]) return raw[1].trim();

  // JSON array / { cookies: [] } format
  try {
    const parsed: unknown = JSON.parse(content);
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>)?.["cookies"] as unknown[]) ?? [];
    for (const c of arr) {
      const obj = c as Record<string, unknown>;
      if (String(obj["name"] ?? "").toLowerCase() === "netflixid") {
        return String(obj["value"] ?? "");
      }
    }
  } catch {
    /* not JSON */
  }

  return "";
}

export interface NfTokenResult {
  url: string;
  expiresAt: Date | null;
  expiresInMinutes: number | null;
}

export async function fetchNfToken(cookieContent: string): Promise<NfTokenResult> {
  const netflixId = parseNetflixId(cookieContent);
  if (!netflixId) {
    throw new Error("NetflixId cookie not found. Check that the file contains a valid Netflix cookie.");
  }

  const res = await fetch(`${NF_IOS_API_URL}?${NF_IOS_QUERY}`, {
    method: "GET",
    headers: { ...NF_IOS_HEADERS, Cookie: `NetflixId=${netflixId}` },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Cookie is invalid or expired — Netflix rejected it.");
    }
    const body = await res.text().catch(() => "");
    throw new Error(`Netflix API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const tokenData = (
    ((data["value"] as Record<string, unknown>)?.["account"] as Record<string, unknown>)
      ?.["token"] as Record<string, unknown>
  )?.["default"] as Record<string, unknown> | undefined;

  const nfTokenStr = tokenData?.["token"] as string | undefined;
  if (!nfTokenStr) {
    throw new Error("Netflix API did not return a token. Cookie may be expired.");
  }

  let expiresEpoch = (tokenData?.["expires"] as number | null) ?? null;
  if (typeof expiresEpoch === "number" && String(expiresEpoch).length === 13) {
    expiresEpoch = Math.floor(expiresEpoch / 1000);
  }

  const expiresAt = expiresEpoch ? new Date(expiresEpoch * 1000) : null;
  const expiresInMinutes = expiresAt
    ? Math.round((expiresAt.getTime() - Date.now()) / 60_000)
    : null;

  return {
    url: `https://www.netflix.com/browse?nftoken=${encodeURIComponent(nfTokenStr)}`,
    expiresAt,
    expiresInMinutes,
  };
}
