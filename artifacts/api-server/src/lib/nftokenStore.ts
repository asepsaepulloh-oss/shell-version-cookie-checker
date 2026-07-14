interface NfTokenEntry {
  nftokenUrl: string;
  cookieContent: string;
  expiresAt: number;
}

const store = new Map<string, NfTokenEntry>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

export function storeNfToken(token: string, nftokenUrl: string, cookieContent: string): void {
  store.set(token, { nftokenUrl, cookieContent, expiresAt: Date.now() + TTL_MS });
}

export function getNfTokenEntry(token: string): NfTokenEntry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, TTL_MS).unref();
