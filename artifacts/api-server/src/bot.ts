import { Telegraf } from "telegraf";
import { logger } from "./lib/logger";
import { bypassLink, isValidUrl } from "./bypass";

const token = process.env["TELEGRAM_BOT_TOKEN"];

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required.");
}

const bot = new Telegraf(token);

// /start command
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 *Welcome to the Link Bypasser Bot!*\n\n` +
      `Send me any shortened or redirect link and I'll resolve it to the final destination.\n\n` +
      `*Supported shorteners:* vplink.in, v2links, linkvertise, exe.io, adf.ly, bit.ly, and many more.\n\n` +
      `Just paste a link and I'll do the rest! 🚀`,
    { parse_mode: "Markdown" },
  );
});

// /help command
bot.help(async (ctx) => {
  await ctx.reply(
    `*Link Bypasser Bot — Help*\n\n` +
      `📎 *How to use:*\n` +
      `Simply send any link and the bot will follow all redirects and return the final URL.\n\n` +
      `*Commands:*\n` +
      `/start — Welcome message\n` +
      `/help — Show this help\n\n` +
      `*Tips:*\n` +
      `• Works with most URL shorteners and redirect chains\n` +
      `• Handles HTTP redirects, meta\\-refresh, and JS redirects`,
    { parse_mode: "Markdown" },
  );
});

// Handle text messages — look for URLs
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();

  // Skip commands we don't handle
  if (text.startsWith("/")) return;

  // Try to extract the first URL from the message
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const rawInput = urlMatch ? urlMatch[0] : text;

  if (!isValidUrl(rawInput)) {
    await ctx.reply(
      `❌ That doesn't look like a valid URL.\n\nPlease send a link starting with http:// or https://`,
    );
    return;
  }

  const processingMsg = await ctx.reply("⏳ Resolving link...");

  try {
    const start = Date.now();
    const result = await bypassLink(rawInput);
    const timeSec = ((Date.now() - start) / 1000).toFixed(1);

    const isSameUrl = result.finalUrl === result.originalUrl;

    if (isSameUrl) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `*Original Link:*\n✅ ${escapeMarkdown(result.originalUrl)}\n\n` +
          `*Result:* No redirects found — this is already the final URL\\.\n\n` +
          `_Time Taken: ${timeSec} seconds_`,
        { parse_mode: "MarkdownV2" },
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `*Original Link:*\n✅ ${escapeMarkdown(result.originalUrl)}\n\n` +
          `*Bypassed Link:*\n✅ ${escapeMarkdown(result.finalUrl)}\n\n` +
          `_Time Taken: ${timeSec} seconds \\| Hops: ${result.hops}_`,
        { parse_mode: "MarkdownV2" },
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to bypass link");
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `❌ Failed to resolve the link\\. The URL may be unreachable or protected\\.`,
      { parse_mode: "MarkdownV2" },
    );
  }
});

// Error handler
bot.catch((err, ctx) => {
  logger.error({ err, update: ctx.update }, "Bot error");
});

function escapeMarkdown(text: string): string {
  // Escape MarkdownV2 special characters
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function startBot(): void {
  logger.info("Starting Telegram bot...");
  bot.launch().catch((err) => {
    logger.error({ err }, "Bot launch failed");
  });

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

export default bot;
