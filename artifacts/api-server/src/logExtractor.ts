import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";

export interface ExtractedCookieFile {
  sourceId: string;
  domainContent: string;
  domainCookieCount: number;
}

export interface ExtractedServiceData {
  domain: string;
  files: ExtractedCookieFile[];
  totalDomainCookies: number;
}

export interface LogExtractionReport {
  totalCookiesFound: number;
  services: ExtractedServiceData[];
  totalFilesScanned: number;
}

interface JsonCookieRaw {
  domain?: unknown;
  name?: unknown;
  value?: unknown;
  path?: unknown;
  secure?: unknown;
  expirationDate?: unknown;
  expires?: unknown;
}

function isCookieEntry(entryName: string): boolean {
  const lower = entryName.toLowerCase().replace(/\\/g, "/");
  const parts = lower.split("/");

  for (const part of parts) {
    if (part === "cookies" || part === "cookie") return true;
  }

  const filename = parts[parts.length - 1] || "";

  // Netscape / plain text cookie files
  if (filename.startsWith("cookie") && (filename.endsWith(".txt") || filename.endsWith(".log") || filename.endsWith(".json"))) return true;
  if (filename.includes("cookies") && (filename.endsWith(".txt") || filename.endsWith(".json"))) return true;

  // Browser-exported JSON cookie files (e.g. Chrome_Default.json, cookies.json)
  if (filename.endsWith(".json") && (filename.includes("cookie") || filename.includes("browser") || filename.includes("chrome") || filename.includes("firefox") || filename.includes("edge"))) return true;

  return false;
}

function isJunkLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("The Best")) return true;
  if (trimmed.startsWith("t.me/")) return true;
  if (trimmed.startsWith("Reserve Link")) return true;
  if (trimmed.startsWith("Buy:")) return true;
  if (trimmed.startsWith("@")) return true;
  if (trimmed.includes("telegram") && trimmed.includes("t.me")) return true;
  return false;
}

function extractDomain(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const parts = trimmed.split("\t");
  if (parts.length >= 7) {
    return (parts[0] || "").replace(/^\./, "").toLowerCase();
  }
  return null;
}

function domainMatches(cookieDomain: string, targetDomain: string): boolean {
  const clean = cookieDomain.replace(/^\./, "").toLowerCase();
  const target = targetDomain.replace(/^\./, "").toLowerCase();
  return clean === target || clean.endsWith("." + target);
}

function isNetscapeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const parts = trimmed.split("\t");
  return parts.length >= 7;
}

function cleanLines(rawContent: string): string[] {
  return rawContent.split("\n").filter(line => {
    if (isJunkLine(line)) return false;
    const t = line.trim();
    return t.startsWith("#") || isNetscapeLine(line);
  });
}

function parseJsonCookieLines(rawContent: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return [];
  }

  let records: JsonCookieRaw[] = [];
  if (Array.isArray(parsed)) {
    records = parsed as JsonCookieRaw[];
  } else if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p["cookies"])) records = p["cookies"] as JsonCookieRaw[];
  }

  const lines: string[] = [];
  for (const rec of records) {
    const domain = typeof rec.domain === "string" ? rec.domain.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const value = typeof rec.value === "string" ? rec.value : "";
    if (!domain || !name || !value) continue;

    const path = typeof rec.path === "string" && rec.path.trim().length > 0 ? rec.path.trim() : "/";
    const secure = rec.secure === true ? "TRUE" : "FALSE";
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const expiryRaw = rec.expirationDate ?? rec.expires;
    const expiryNum = typeof expiryRaw === "number" ? expiryRaw : (typeof expiryRaw === "string" ? Number(expiryRaw) : 0);
    let expiry = Number.isFinite(expiryNum) && expiryNum > 0 ? Math.floor(expiryNum) : 0;
    if (expiry > 9999999999) {
      expiry = Math.floor(expiry / 1000);
    }

    lines.push(`${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`);
  }

  return lines;
}

function collectCookieLines(rawContent: string): string[] {
  const netscapeLines = cleanLines(rawContent).filter(l => isNetscapeLine(l));
  const jsonLines = parseJsonCookieLines(rawContent);
  return [...new Set([...netscapeLines, ...jsonLines])];
}

export function extractLogsForDomains(zipBuffer: Buffer, targetDomains: string[]): LogExtractionReport {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  const normalizedTargets = [...new Set(
    targetDomains
      .map(d => d.trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean),
  )];

  const serviceFiles = new Map<string, ExtractedCookieFile[]>();
  for (const domain of normalizedTargets) {
    serviceFiles.set(domain, []);
  }

  let totalCookiesFound = 0;
  let totalFilesScanned = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isCookieEntry(entry.entryName)) continue;

    totalFilesScanned++;
    const rawContent = entry.getData().toString("utf-8");
    const cookieLines = collectCookieLines(rawContent);
    if (cookieLines.length === 0) continue;

    const domainLines = new Map<string, string[]>();

    for (const line of cookieLines) {
      const domain = extractDomain(line);
      if (!domain) continue;

      for (const target of normalizedTargets) {
        if (domainMatches(domain, target)) {
          if (!domainLines.has(target)) domainLines.set(target, []);
          domainLines.get(target)!.push(line);
        }
      }
    }

    if (domainLines.size === 0) continue;

    const pathParts = entry.entryName.split("/");
    const pcId = pathParts[0] || "unknown";
    const browserProfile = pathParts.length > 2 ? pathParts.slice(2).join("_").replace(/\.txt$/, "") : entry.name.replace(/\.txt$/, "");
    const sourceId = `${pcId}/${browserProfile}`;


    for (const [targetDomain, matchingLines] of domainLines) {
      if (matchingLines.length === 0) continue;

      const domainContent = "# Netscape HTTP Cookie File\n# Source: " + entry.entryName + "\n\n" + matchingLines.join("\n") + "\n";

      const files = serviceFiles.get(targetDomain)!;
      files.push({
        sourceId,
        domainContent,
        domainCookieCount: matchingLines.length,
      });
      totalCookiesFound += matchingLines.length;
    }
  }

  const results: ExtractedServiceData[] = [];

  for (const [domain, files] of serviceFiles) {
    if (files.length === 0) continue;

    const totalServiceCookies = files.reduce((sum, f) => sum + f.domainCookieCount, 0);

    results.push({
      domain,
      files,
      totalDomainCookies: totalServiceCookies,
    });
  }

  results.sort((a, b) => b.totalDomainCookies - a.totalDomainCookies);

  return {
    totalCookiesFound,
    services: results,
    totalFilesScanned,
  };
}

export function extractLogsFromDirectory(dirPath: string, targetDomains: string[]): LogExtractionReport {
  const normalizedTargets = [...new Set(
    targetDomains
      .map(d => d.trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean),
  )];

  const serviceFiles = new Map<string, ExtractedCookieFile[]>();
  for (const domain of normalizedTargets) {
    serviceFiles.set(domain, []);
  }

  let totalCookiesFound = 0;
  let totalFilesScanned = 0;

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const relativePath = path.relative(dirPath, fullPath);
        if (!isCookieEntry(relativePath)) continue;

        totalFilesScanned++;
        let rawContent: string;
        try {
          rawContent = fs.readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }

        const cookieLines = collectCookieLines(rawContent);
        if (cookieLines.length === 0) continue;

        const domainLines = new Map<string, string[]>();
        for (const line of cookieLines) {
          const domain = extractDomain(line);
          if (!domain) continue;
          for (const target of normalizedTargets) {
            if (domainMatches(domain, target)) {
              if (!domainLines.has(target)) domainLines.set(target, []);
              domainLines.get(target)!.push(line);
            }
          }
        }

        if (domainLines.size === 0) continue;

        const pathParts = relativePath.split(path.sep);
        const pcId = pathParts[0] || "unknown";
        const browserProfile = pathParts.length > 2 ? pathParts.slice(2).join("_").replace(/\.txt$/, "") : entry.name.replace(/\.txt$/, "");
        const sourceId = `${pcId}/${browserProfile}`;


        for (const [targetDomain, matchingLines] of domainLines) {
          if (matchingLines.length === 0) continue;
          const domainContent = "# Netscape HTTP Cookie File\n# Source: " + relativePath + "\n\n" + matchingLines.join("\n") + "\n";
          const files = serviceFiles.get(targetDomain)!;
          files.push({ sourceId, domainContent, domainCookieCount: matchingLines.length });
          totalCookiesFound += matchingLines.length;
        }
      }
    }
  }

  walkDir(dirPath);

  const results: ExtractedServiceData[] = [];
  for (const [domain, files] of serviceFiles) {
    if (files.length === 0) continue;
    const totalServiceCookies = files.reduce((sum, f) => sum + f.domainCookieCount, 0);
    results.push({ domain, files, totalDomainCookies: totalServiceCookies });
  }
  results.sort((a, b) => b.totalDomainCookies - a.totalDomainCookies);

  return { totalCookiesFound, services: results, totalFilesScanned };
}

  export async function extractLogsFromDirectoryAsync(
      dirPath: string,
      targetDomains: string[],
      onProgress?: (filesScanned: number, totalFiles: number) => void,
    ): Promise<LogExtractionReport> {
      const normalizedTargets = [...new Set(
        targetDomains.map(d => d.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean),
      )];

      const serviceFiles = new Map<string, ExtractedCookieFile[]>();
      for (const domain of normalizedTargets) serviceFiles.set(domain, []);

      let totalCookiesFound = 0;
      let totalFilesScanned = 0;

      // ── First pass: count total scannable files so progress % is accurate ──
      let totalFiles = 0;
      if (onProgress) {
        async function countFiles(dir: string): Promise<void> {
          let entries: fs.Dirent[];
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.isDirectory()) { await countFiles(path.join(dir, entry.name)); continue; }
            if (isCookieEntry(path.relative(dirPath, path.join(dir, entry.name)))) totalFiles++;
          }
        }
        await countFiles(dirPath);
      }

      // ── Second pass: extract with progress callbacks ────────────────────────
      async function walkAsync(dir: string): Promise<void> {
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        await new Promise<void>(r => setImmediate(r));

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { await walkAsync(fullPath); continue; }
          const relativePath = path.relative(dirPath, fullPath);
          if (!isCookieEntry(relativePath)) continue;

          totalFilesScanned++;
            // Yield to event loop on every file — prevents "stuck at X%" for any domain
            await new Promise<void>(r => setImmediate(r));
            if (onProgress) onProgress(totalFilesScanned, totalFiles || totalFilesScanned);

            let rawContent: string;
            try { rawContent = await fs.promises.readFile(fullPath, "utf-8"); } catch { continue; }

          const cookieLines = collectCookieLines(rawContent);
          if (cookieLines.length === 0) continue;

          const domainLines = new Map<string, string[]>();
          for (const line of cookieLines) {
            const domain = extractDomain(line);
            if (!domain) continue;
            for (const target of normalizedTargets) {
              if (domainMatches(domain, target)) {
                if (!domainLines.has(target)) domainLines.set(target, []);
                domainLines.get(target)!.push(line);
              }
            }
          }
          if (domainLines.size === 0) continue;

          const pathParts = relativePath.split(path.sep);
          const pcId = pathParts[0] || "unknown";
          const browserProfile = pathParts.length > 2 ? pathParts.slice(2).join("_").replace(/\.txt$/, "") : entry.name.replace(/\.txt$/, "");
          const sourceId = `${pcId}/${browserProfile}`;

          for (const [targetDomain, matchingLines] of domainLines) {
            if (matchingLines.length === 0) continue;
            const bucket = serviceFiles.get(targetDomain)!;
            if (bucket.length >= 500) continue; // cap at 500 files/domain — prevents memory explosion on huge archives
            const domainContent = "# Netscape HTTP Cookie File\n# Source: " + relativePath + "\n\n" + matchingLines.join("\n") + "\n";
            bucket.push({ sourceId, domainContent, domainCookieCount: matchingLines.length });
            totalCookiesFound += matchingLines.length;
          }
        }
      }

      await walkAsync(dirPath);
      if (onProgress) onProgress(totalFilesScanned, totalFiles || totalFilesScanned);

      const results: ExtractedServiceData[] = [];
      for (const [domain, files] of serviceFiles) {
        if (files.length === 0) continue;
        results.push({ domain, files, totalDomainCookies: files.reduce((s, f) => s + f.domainCookieCount, 0) });
      }
      results.sort((a, b) => b.totalDomainCookies - a.totalDomainCookies);
      return { totalCookiesFound, services: results, totalFilesScanned };
    }
  