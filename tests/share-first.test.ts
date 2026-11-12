import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/server/auth";
import { AD_ES } from "./fixtures";
import { buttons, harness, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const ID = 9001;
const from = (first_name?: string) => ({ id: ID, language_code: "en", ...(first_name ? { first_name } : {}) });

/** Links the renter and accepts the privacy notice, as Telegram would send it (with or without a first name). */
async function join(first_name?: string) {
  h.rt.store.createInvite(sha256Hex("code"));
  await h.say(ID, "/start code", { from: from(first_name) });
  await h.rt.bot.handleUpdate({
    update_id: 777_000 + Math.floor(Math.random() * 1000),
    callback_query: { id: "pn", from: from(first_name), data: "pn:ok", message: { message_id: 500, chat: { id: ID, type: "private" } } },
  });
}
const offers = () => h.tg.texts().filter((t) => /sound like you/.test(t));

describe("share first: no questions before the first value", () => {
  it("privacy OK sends the intro, an example card and the call to action, with no question and no AI call", async () => {
    h = harness();
    const extract = vi.spyOn(h.rt.engine, "extract");
    const draft = vi.spyOn(h.rt.engine, "draft");
    await join("Marta");
    const texts = h.tg.texts();
    const i = texts.findIndex((t) => /Before we start/.test(t));
    const after = texts.slice(i + 1);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatch(/I help you answer flat listings first/);
    expect(after[1]).toMatch(/^📋 <b>Example<\/b>/);
    expect(after[1]).toContain("Gràcia");
    expect(after[1]).toMatch(/⛔/u); // the real assessment flags the deposit before a viewing
    expect(after[1]).toContain("Marta"); // the template draft uses the renter's own name
    expect(after[2]).toBe("Send me any listing: a link, text, a screenshot, or a forwarded post.");
    for (const q of [/your name/i, /What do you do/, /Contract type/, /income/i, /Maximum rent/]) expect(after.join("\n")).not.toMatch(q);
    // The example is inert: no keyboard on it, nothing stored, no model call.
    const example = h.tg.sent.find((s) => s.method === "sendMessage" && /Example/.test(String(s.body.text)))!;
    expect(example.body.reply_markup).toBeUndefined();
    expect(h.rt.store.usage().listings).toBe(0);
    expect(h.rt.store.usage().cards).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    expect(h.tg.sent.every((s) => ["sendMessage", "answerCallbackQuery", "sendChatAction"].includes(s.method))).toBe(true);
  });

  it("creates a name-only profile from the Telegram first name", async () => {
    h = harness();
    await join("Marta");
    const p = h.rt.store.getProfile(String(ID));
    expect(p).toMatchObject({ name: "Marta", replyLang: "es" });
    expect(p?.occupants).toBeUndefined(); // household size is a fact the renter has not given
    expect(p?.occupation).toBeUndefined();
    expect(p?.netMonthlyIncomeEur).toBeUndefined();
    expect(p?.phone).toBeUndefined();
  });

  it("asks only the name when Telegram sends no first name, then shows the welcome", async () => {
    h = harness();
    await join();
    expect(h.tg.texts().at(-1)).toMatch(/your name/i);
    expect(h.rt.store.getProfile(String(ID))).toBeUndefined();
    await h.say(ID, "Ana Prueba");
    expect(h.rt.store.getProfile(String(ID))?.name).toBe("Ana Prueba");
    const texts = h.tg.texts();
    expect(texts.at(-3)).toMatch(/I help you answer/);
    expect(texts.at(-2)).toMatch(/Example/);
    expect(texts.at(-1)).toMatch(/Send me any listing/);
    expect(texts.join("\n")).not.toMatch(/What do you do/);
  });

  it("drafts a real listing at once with the name-only profile, never inventing facts", async () => {
    h = harness();
    await join("Marta");
    h.tg.clear();
    await h.say(ID, AD_ES);
    const card = h.tg.sent.find((s) => s.method === "sendMessage" && /<pre>/.test(String(s.body.text)))!;
    const body = String(card.body.text);
    expect(body).toContain("Marta");
    expect(body).not.toMatch(/ingresos|income|€ netos|trabajo|contrato indefinido/i);
    expect(body).not.toMatch(/yo solo|Seríamos|just me|of us|sol\/a/); // no household claim either
    expect(h.rt.store.usage().listings).toBe(1);
  });
});

describe("share first: the one follow-up", () => {
  it("comes after the first real card only, with Start and Later and a /filters line", async () => {
    h = harness();
    await join("Marta");
    h.tg.clear();
    await h.say(ID, AD_ES);
    expect(offers()).toHaveLength(1);
    const msg = h.tg.last()!;
    expect(String(msg.body.text)).toBe("Want the reply to sound like you? A few short questions, all optional.\n\n/filters sets your budget and zones.");
    expect(buttons(h.tg.keyboardOf(msg)).map((b) => b.text)).toEqual(["Start", "Later"]);

    h.tg.clear();
    await h.say(ID, `${AD_ES}\nCalle de Verdi 12, otro anuncio`);
    expect(h.tg.sent.some((s) => s.method === "sendMessage" && /<pre>/.test(String(s.body.text)))).toBe(true);
    expect(offers()).toHaveLength(0);
  });

  it("Start runs the questionnaire from the occupation, with contract inference", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, AD_ES);
    await h.press(ID, "fu:start");
    expect(h.tg.texts().at(-1)).toMatch(/What do you do/);
    await h.say(ID, "product manager, permanent contract");
    expect(h.rt.store.getProfile(String(ID))).toMatchObject({ name: "Marta", contract: "permanent" });
    expect(h.tg.texts().at(-1)).toMatch(/Net monthly income/);
  });

  it("Later after Start closes the questionnaire, so the next listing gets a card", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, AD_ES);
    await h.press(ID, "fu:start");
    await h.press(ID, "fu:later");
    h.tg.clear();
    await h.say(ID, `${AD_ES}\nCalle de Verdi 12, otro anuncio`);
    expect(h.rt.store.getProfile(String(ID))?.occupation).toBeUndefined();
    expect(h.tg.sent.some((s) => s.method === "sendMessage" && /<pre>/.test(String(s.body.text)))).toBe(true);
  });

  it("Later drops the buttons and asks nothing", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, AD_ES);
    h.tg.clear();
    await h.press(ID, "fu:later");
    expect(h.tg.sent.filter((s) => s.method === "sendMessage")).toHaveLength(0);
    expect(h.tg.last("editMessageReplyMarkup")?.body.reply_markup.inline_keyboard).toEqual([]);
  });
});

describe("share first: commands", () => {
  it("/start for a linked renter says welcome back", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, "/start");
    expect(h.tg.texts().at(-1)).toMatch(/Welcome back/);
  });

  it("/profile shows the section with edit buttons for a name-only profile", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, "/profile");
    expect(h.tg.texts().at(-1)).toMatch(/Your profile[\s\S]*Name: Marta[\s\S]*Occupation: not set/);
    expect(buttons(h.tg.keyboardOf(h.tg.last())).some((b) => b.callback_data === "pe:occupation")).toBe(true);
  });

  it("/filters keeps working", async () => {
    h = harness();
    await join("Marta");
    await h.say(ID, "/filters");
    expect(h.tg.texts().at(-1)).toMatch(/Your filters/);
  });
});
