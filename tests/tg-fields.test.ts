import { describe, expect, it } from "vitest";
import { parseDate, parseInteger } from "../src/bot/fields";
import { pickUiLang, strings } from "../src/bot/strings";
import { createTg, TgError } from "../src/bot/tg";
import { FLAG_CODES } from "../src/core/schema";

describe("telegram client", () => {
  it("never puts the token in an error", async () => {
    const tg = createTg({ token: "999:SECRET", fetch: (async () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 })) as typeof fetch });
    const err = await tg.sendMessage(1, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TgError);
    expect(String(err.message)).toContain("chat not found");
    expect(String(err.message)).not.toContain("SECRET");
    const net = createTg({
      token: "999:SECRET",
      fetch: (async () => {
        throw new Error("boom https://api.telegram.org/bot999:SECRET/x");
      }) as typeof fetch,
    });
    expect(String(await net.sendMessage(1, "x").catch((e) => e.message))).not.toContain("SECRET");
  });

  it("sends the webhook secret and the allowed updates", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const tg = createTg({
      token: "1:a",
      fetch: (async (u: string, i: RequestInit) => {
        calls.push({ url: String(u), body: JSON.parse(String(i.body)) });
        return Response.json({ ok: true, result: true });
      }) as typeof fetch,
    });
    await tg.setWebhook("https://x.test/api/telegram", "sec");
    expect(calls[0]!.url).toMatch(/setWebhook$/);
    expect(calls[0]!.body).toMatchObject({ secret_token: "sec", allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  });

  it("fails clearly without a token", async () => {
    await expect(createTg({ token: "", env: {} }).sendMessage(1, "x")).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe("strings", () => {
  it("maps language codes", () => {
    expect([pickUiLang("es-ES"), pickUiLang("ca"), pickUiLang("ru"), pickUiLang("de"), pickUiLang(undefined)]).toEqual(["es", "es", "ru", "en", "en"]);
  });
  it("has a flag line in every language for every flag code", () => {
    for (const lang of ["en", "es", "ru"] as const) for (const c of FLAG_CODES) expect(strings(lang).flags[c], `${lang}/${c}`).toBeTruthy();
  });
});

describe("answer parsing", () => {
  it("reads amounts and dates", () => {
    expect(parseInteger("2.800 €", 1, 1e6)).toBe(2800);
    expect(parseInteger("1200", 1, 1e6)).toBe(1200);
    expect(parseInteger("abc", 1, 10)).toBeUndefined();
    expect(parseInteger("0", 1, 10)).toBeUndefined();
    expect(parseDate("01/12/2026")).toBe("2026-12-01");
    expect(parseDate("2026-12-01")).toBe("2026-12-01");
    expect(parseDate("31/02/2026")).toBeUndefined();
    expect(parseDate("soon")).toBeUndefined();
  });
});
