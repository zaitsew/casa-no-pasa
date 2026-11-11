import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/engine/store";
import { sha256Hex } from "../src/server/auth";

describe("scripts/invite.mjs", () => {
  it("prints a code and a link whose code the store accepts exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "cnp-invite-"));
    try {
      const db = join(dir, "t.db");
      openStore(db).close(); // the app creates the tables on first start
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/invite.mjs"], {
        env: { ...process.env, CASANOPASA_DB_PATH: db, TELEGRAM_BOT_USERNAME: "@casa_test_bot" },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const code = /code: (\S+)/.exec(r.stdout)![1]!;
      expect(r.stdout).toContain(`https://t.me/casa_test_bot?start=${code}`);
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const s = openStore(db);
      expect(s.redeemInvite(sha256Hex(code), "42")).toBe(true);
      expect(s.redeemInvite(sha256Hex(code), "43")).toBe(false);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says what to do when the tables do not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "cnp-invite-"));
    try {
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/invite.mjs"], { env: { ...process.env, CASANOPASA_DB_PATH: join(dir, "empty.db") }, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/start the app once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
