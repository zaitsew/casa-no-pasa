/**
 * `npm run telegram-setup` registers the webhook and the command menus with Telegram.
 * `npm run telegram-setup -- --check` only prints what is missing and calls nothing.
 */
import { existsSync } from "node:fs";
import { COMMANDS, type UiLang } from "../src/bot/strings";
import { createTg } from "../src/bot/tg";

if (existsSync(".env")) process.loadEnvFile(".env");

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "CASANOPASA_PUBLIC_URL"] as const;
const missing: string[] = REQUIRED.filter((k) => !process.env[k]?.trim());
const url = process.env.CASANOPASA_PUBLIC_URL?.trim() ?? "";
if (url && !/^https:\/\//.test(url)) missing.push("CASANOPASA_PUBLIC_URL must start with https:// (Telegram only calls HTTPS webhooks)");
if (!process.env.CASANOPASA_FILES_KEY?.trim()) console.log("note: CASANOPASA_FILES_KEY is not set: documents and dossier links stay off.");
if (!process.env.CASANOPASA_INBOUND_SECRET?.trim()) console.log("note: CASANOPASA_INBOUND_SECRET is not set: alert email stays off.");

if (missing.length) {
  console.log("MISSING:");
  for (const m of missing) console.log(`  - ${m}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log(`ok: would set the webhook to ${url.replace(/\/+$/, "")}/api/telegram and the command menus (en, es, ru).`);
  process.exit(0);
}

const tg = createTg();
await tg.setWebhook(`${url.replace(/\/+$/, "")}/api/telegram`, process.env.TELEGRAM_WEBHOOK_SECRET!.trim());
await tg.setMyCommands(COMMANDS.en);
for (const lang of Object.keys(COMMANDS) as UiLang[]) await tg.setMyCommands(COMMANDS[lang], lang);
console.log(`webhook set; commands set for en, es, ru. Bot: https://t.me/${process.env.TELEGRAM_BOT_USERNAME!.trim().replace(/^@/, "")}`);
