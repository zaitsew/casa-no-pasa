/**
 * `npm run invite` prints a fresh invite code and link.
 *   npm run invite                    against the local database
 *   npm run invite -- --remote        against the droplet's database (ssh + docker compose exec)
 *   npm run invite -- --remote --host user@host
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const hostIdx = args.indexOf("--host");
const host = hostIdx >= 0 ? args[hostIdx + 1] : "deploy@159.89.99.84";

const r = remote
  ? spawnSync("ssh", ["-o", "BatchMode=yes", host!, "cd /srv && docker compose exec -T casanopasa node /app/invite.mjs"], { stdio: "inherit" })
  : spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/invite.mjs"], { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
