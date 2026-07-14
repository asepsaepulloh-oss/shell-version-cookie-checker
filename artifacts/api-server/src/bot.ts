import { Telegraf } from "telegraf";
import { logger } from "./lib/logger";
import { bypassLink, isValidUrl, VpnBlockedError } from "./bypass";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required.");

const bot = new Telegraf(token);

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 <b>Welcome to the Link Bypasser Bot!</b>\n\n` +
      `Send me any shortened or redirect link and I'll resolve it to the final destination.\n\n` +
      `<b>Commands:</b>\n` +
      `/start — Welcome message\n` +
      `/help — Usage instructions\n\n` +
      `Just paste any link and I'll bypass it! 🚀`,
    { parse_mode: "HTML" },
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.help(async (ctx) => {
  await ctx.reply(
    `<b>Link Bypasser Bot — Help</b>\n\n` +
      `📎 <b>How to use:</b>\n` +
      `Send any shortened or redirect link. The bot follows all redirect chains and returns the final URL.\n\n` +
      `<b>Works best with:</b>\n` +
      `• bit.ly, tinyurl.com, t.co, shorturl.at\n` +
      `• AdLinkFly-based shorteners (without VPN blocks)\n` +
      `• Any URL with standard HTTP redirects\n\n` +
      `<b>Limitation:</b>\n` +
      `Sites that actively block datacenter/server IPs (VPN detection) cannot be bypassed from a server. ` +
      `If you hit this, try opening the link directly in your browser.`,
    { parse_mode: "HTML" },
  );
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  // Extract first URL from the message
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const rawInput = urlMatch ? urlMatch[0] : text;

  if (!isValidUrl(rawInput)) {
    await ctx.reply(
      `❌ That doesn't look like a valid URL.\n\nSend a link starting with <code>http://</code> or <code>https://</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const processingMsg = await ctx.reply("⏳ Resolving link...");

  const edit = (html: string) =>
    ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, html, {
      parse_mode: "HTML",
    });

  try {
    const result = await bypassLink(rawInput);
    const timeSec = (result.timeTakenMs / 1000).toFixed(1);

    if (result.finalUrl === result.originalUrl) {
      await edit(
        `<b>Original Link:</b>\n✅ ${result.originalUrl}\n\n` +
          `<b>Result:</b> No redirect found — this is the final URL already.\n\n` +
          `<i>Time Taken: ${timeSec} seconds</i>`,
      );
    } else {
      await edit(
        `<b>Original Link:</b>\n✅ ${result.originalUrl}\n\n` +
          `<b>Bypassed Link:</b>\n✅ ${result.finalUrl}\n\n` +
          `<i>Time Taken: ${timeSec} seconds</i>`,
      );
    }
  } catch (err) {
    if (err instanceof VpnBlockedError) {
      await edit(
        `⚠️ <b>VPN/Proxy Block Detected</b>\n\n` +
          `<b>Link:</b> ${rawInput}\n\n` +
          `This site actively blocks server and datacenter IPs. ` +
          `It cannot be bypassed remotely.\n\n` +
          `<b>What you can do:</b>\n` +
          `• Open the link directly in your browser\n` +
          `• Disable any VPN/proxy on your device first`,
      );
    } else {
      logger.error({ err }, "Failed to bypass link");
      await edit(
        `❌ <b>Failed to resolve link</b>\n\n` +
          `The URL may be unreachable, expired, or requires a login.\n\n` +
          `<i>${rawInput}</i>`,
      );
    }
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error({ err, update: ctx.update }, "Bot error");
});

export function startBot(): void {
  logger.info("Starting Telegram bot...");
  bot.launch().catch((err) => {
    logger.error({ err }, "Bot launch failed");
  });
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

export default bot;
