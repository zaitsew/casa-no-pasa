import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/telegram/route";
import { sha256Hex } from "../src/server/auth";
import { harness, INBOUND_SECRET, WEBHOOK_SECRET, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const req = (body: unknown, secret?: string) =>
  new Request("https://x.test/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== undefined ? { "x-telegram-bot-api-secret-token": secret } : {}) },
    body: JSON.stringify(body),
  });
const update = (text: string, id = 9001) => ({ update_id: id, message: { message_id: 1, date: 1_800_000_000, chat: { id, type: "private" }, from: { id, language_code: "en" }, text } });

describe("webhook secret", () => {
  it("rejects a missing or wrong secret and never reads the update", async () => {
    h = harness();
    expect((await POST(req(update("/start x")))).status).toBe(401);
    expect((await POST(req(update("/start x"), "wrong"))).status).toBe(401);
    expect((await POST(req(update("/start x"), WEBHOOK_SECRET + "x"))).status).toBe(401);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("refuses everything when no secret is configured", async () => {
    h = harness({ TELEGRAM_WEBHOOK_SECRET: "" });
    expect((await POST(req(update("hi"), ""))).status).toBe(401);
    expect((await POST(req(update("hi")))).status).toBe(401);
  });

  it("accepts the right secret and answers 200", async () => {
    h = harness();
    const res = await POST(req(update("hello"), WEBHOOK_SECRET));
    expect(res.status).toBe(200);
    expect(h.tg.texts()).toHaveLength(1);
  });
});

describe("access is invite-only", () => {
  it("gives an unknown user one polite line and stores nothing", async () => {
    h = harness();
    await POST(req(update("https://www.idealista.com/inmueble/12345678/"), WEBHOOK_SECRET));
    const texts = h.tg.texts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/private beta/i);
    expect(h.rt.store.usage().users).toBe(0);
    expect(h.rt.store.usage().listings).toBe(0);
  });

  it("treats a wrong invite code like any unknown user", async () => {
    h = harness();
    await h.say(9001, "/start not-a-code");
    expect(h.tg.texts()[0]).toMatch(/private beta/i);
    expect(h.rt.store.isLinked("9001")).toBe(false);
  });

  it("links a user with a valid code, once", async () => {
    h = harness();
    h.rt.store.createInvite(sha256Hex("code-one"));
    await h.say(9001, "/start code-one");
    expect(h.rt.store.isLinked("9001")).toBe(true);
    const texts = h.tg.texts();
    expect(texts[0]).toMatch(/You are in/);
    expect(texts[1]).toMatch(/Before we start/); // the privacy notice comes first

    await h.say(9002, "/start code-one");
    expect(h.rt.store.isLinked("9002")).toBe(false);
    expect(h.tg.texts().at(-1)).toMatch(/private beta/i);
  });

  it("accepts the code pasted on its own or as the whole link, for a chat already started", async () => {
    h = harness();
    h.rt.store.createInvite(sha256Hex("Zq9TestCodeOnly_xY12ab"));
    h.rt.store.createInvite(sha256Hex("Abcdefghijklmnop_-1234"));
    await h.say(9001, "/start");
    expect(h.tg.texts().at(-1)).toMatch(/paste the invite code/);
    await h.say(9001, "  Zq9TestCodeOnly_xY12ab ");
    expect(h.rt.store.isLinked("9001")).toBe(true);
    await h.say(9002, "https://t.me/casa_agent?start=Abcdefghijklmnop_-1234");
    expect(h.rt.store.isLinked("9002")).toBe(true);
  });

  it("does not treat ordinary text as a code", async () => {
    h = harness();
    await h.say(9003, "hola, busco piso");
    await h.say(9003, "short");
    expect(h.rt.store.isLinked("9003")).toBe(false);
    expect(h.tg.texts().every((t) => /private beta/i.test(t))).toBe(true);
  });

  it("ignores group chats and callbacks from unknown users", async () => {
    h = harness();
    await h.rt.bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: -5, type: "group" }, from: { id: 9001 }, text: "hi" } });
    expect(h.tg.sent).toHaveLength(0);
    await h.press(9001, "s:whatever");
    expect(h.tg.last("answerCallbackQuery")?.body.text).toMatch(/private beta/i);
    expect(h.rt.store.events("9001")).toHaveLength(0);
  });
});

describe("onboarding", () => {
  it("shows the notice, then asks questions one by one, and rejects over-long answers", async () => {
    h = harness();
    h.rt.store.createInvite(sha256Hex("c"));
    await h.say(9001, "/start c");
    await h.press(9001, "pn:ok");
    expect(h.tg.texts().at(-1)).toMatch(/your name/i);
    await h.say(9001, "N".repeat(150));
    expect(h.tg.texts().at(-1)).toMatch(/too long/i);
    expect(h.rt.store.getProfile("9001")).toBeUndefined();
    await h.say(9001, "Ana Prueba");
    expect(h.rt.store.getProfile("9001")?.name).toBe("Ana Prueba");
    await h.press(9001, "fu:start");
    await h.press(9001, "fs:occupation");
    await h.press(9001, "f:contract:permanent");
    await h.say(9001, "2.800");
    await h.say(9001, "2");
    await h.say(9001, "a cat");
    await h.say(9001, "01/12/2026");
    await h.say(9001, "weekdays after 18:00");
    await h.say(9001, "quiet, non-smoker");
    await h.say(9001, "+34 600 000 000");
    await h.press(9001, "f:lang:ca");
    expect(h.tg.texts().at(-1)).toMatch(/Maximum rent/i);
    await h.say(9001, "1500");
    await h.say(9001, "2");
    await h.say(9001, "Gràcia, Eixample");
    await h.press(9001, "f:needPets:1");
    await h.press(9001, "f:longOnly:1");
    expect(h.tg.texts().at(-2)).toMatch(/All set/);
    expect(h.tg.texts().at(-1)).toMatch(/Your profile/); // the summary, with edit buttons, closes onboarding
    expect(h.rt.store.getProfile("9001")).toMatchObject({ name: "Ana Prueba", netMonthlyIncomeEur: 2800, occupants: 2, pets: "a cat", moveInFrom: "2026-12-01", replyLang: "ca", contract: "permanent" });
    expect(h.rt.store.getFilters("9001")).toMatchObject({ maxPriceEur: 1500, minRooms: 2, zones: ["Gràcia", "Eixample"], needPets: true, longTermOnly: true });
  });

  it("re-asks on a bad number and accepts a button only for the open question", async () => {
    h = harness();
    h.addRenter(9001);
    await h.press(9001, "pe:income");
    await h.say(9001, "a lot");
    expect(h.tg.texts().at(-1)).toMatch(/whole number/i);
    await h.press(9001, "f:lang:en"); // not the open question: ignored
    expect(h.rt.store.getProfile("9001")?.replyLang).toBe("es");
    await h.say(9001, "3000");
    expect(h.rt.store.getProfile("9001")?.netMonthlyIncomeEur).toBe(3000);
  });
});

describe("inbound secret header name", () => {
  it("is distinct from the webhook secret", () => {
    expect(INBOUND_SECRET).not.toBe(WEBHOOK_SECRET);
  });
});
