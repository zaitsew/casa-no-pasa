// Prints a fresh single-use invite code and its Telegram link. Plain Node (node:sqlite only), so the same
// file runs on the laptop and, copied into the deploy bundle, inside the container:
//   node scripts/invite.mjs                       local database (CASANOPASA_DB_PATH)
//   docker compose exec -T casanopasa node /app/invite.mjs
// The code is shown once; only its SHA-256 hash is stored (the store's `invites` table, src/engine/store.ts).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = (process.env.CASANOPASA_DB_PATH ?? "").trim() || "./data/casanopasa.db";
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
const code = randomBytes(16).toString("base64url");
const hash = createHash("sha256").update(code).digest("hex");
try {
  db.prepare("INSERT INTO invites (code_hash, created_at) VALUES (?, ?)").run(hash, new Date().toISOString());
} catch (err) {
  console.error(/no such table/i.test(String(err)) ? "The database has no invites table yet: start the app once (GET /api/health runs the migrations), then retry." : `could not store the invite: ${err.message}`);
  process.exit(1);
}
db.close();
const bot = (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
console.log(`code: ${code}`);
console.log(bot ? `link: https://t.me/${bot}?start=${code}` : "link: set TELEGRAM_BOT_USERNAME, then the link is https://t.me/<username>?start=<code>");
