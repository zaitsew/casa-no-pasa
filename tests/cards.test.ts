import { afterEach, describe, expect, it } from "vitest";
import { renderCard } from "../src/bot/cards";
import type { CardResult } from "../src/engine";
import { assess } from "../src/engine/assess";
import { AD_ES, filters, listing, NOW } from "./fixtures";
import { buttons, harness, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const card = (h: Harness) => h.tg.last("sendMessage")!;
const callbacks = (h: Harness) => buttons(h.tg.keyboardOf(card(h))).filter((b) => b.callback_data);

describe("listing card", () => {
  it("renders a full listing: header, flags, unknowns, draft in <pre>, buttons", async () => {
    h = harness();
    h.addRenter(7001);
    h.rt.store.setFilters("7001", filters({ maxPriceEur: 1000, zones: ["Eixample"] }));
    await h.say(7001, `${AD_ES}\nhttps://www.idealista.com/inmueble/98765432/`);
    const text = String(card(h).body.text);
    expect(text).toMatch(/^[🟢🟡🔴] <b>\d+<\/b>\/100/u);
    expect(text).toContain("1,250");
    expect(text).toContain("75 m²");
    expect(text).toContain("Idealista");
    expect(text).toMatch(/⛔|⚠️/u); // over budget / outside zones come first
    expect(text).toMatch(/<pre>[\s\S]*Ana Prueba[\s\S]*<\/pre>/);
    expect(text.split("\n").filter((l) => /^(⛔|⚠️|ℹ️)/u.test(l)).length).toBeLessThanOrEqual(5);
    const kb = buttons(h.tg.keyboardOf(card(h)));
    const labels = kb.map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(["Open listing", "Español", "Català", "English", "Sent ✓", "Viewing booked", "Not for me"]));
    expect(kb.find((b) => b.text === "Open listing")?.url).toContain("idealista.com/inmueble/98765432");
  });

  it("puts the confirm-before-sending line for unknowns", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "Piso en Gràcia 900 euros al mes, 2 habitaciones");
    expect(String(card(h).body.text)).toMatch(/Confirm before sending: /);
  });

  it("answers a bare link with the short card and a generic draft", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "https://www.idealista.com/inmueble/11112222/");
    const text = String(card(h).body.text);
    expect(text).toMatch(/screenshot or the ad text/);
    expect(text).toContain("<pre>");
    expect(text).not.toMatch(/\/100/);
  });

  it("flags a possible duplicate and a price change", async () => {
    h = harness();
    h.addRenter(7001);
    const ad = "Piso en Poblenou, 80 m2, 3 hab. 1.400 €/mes. Larga duración.";
    await h.say(7001, ad);
    await h.say(7001, ad);
    expect(String(card(h).body.text)).toMatch(/Possible duplicate/);

    const url = "https://www.idealista.com/inmueble/55556666/";
    await h.say(7001, `Piso en Sants 70 m2 3 hab 1.300 €/mes ${url}`);
    await h.say(7001, `Piso en Sants 70 m2 3 hab 1.200 €/mes ${url}`);
    expect(String(card(h).body.text)).toMatch(/Price changed from 1,300 € to 1,200 €/);
  });

  it("says so, with no card, for an exact repeat of a portal listing", async () => {
    h = harness();
    h.addRenter(7001);
    const msg = "Piso en Sants 70 m2 3 hab 1.300 €/mes https://www.idealista.com/inmueble/77778888/";
    await h.say(7001, msg);
    await h.say(7001, msg);
    expect(h.tg.texts().at(-1)).toMatch(/already saw/i);
  });

  it("downloads the largest photo and passes it to the engine as an image", async () => {
    h = harness();
    h.addRenter(7001);
    h.tg.downloads.set("files/big", Buffer.from("fake-jpeg-bytes"));
    h.tg.downloads.set("files/small", Buffer.from("x"));
    await h.say(7001, "", { text: undefined, caption: "from a story", photo: [{ file_id: "small", file_size: 1 }, { file_id: "big", file_size: 15 }] });
    expect(h.tg.sent.filter((s) => s.method === "getFile").map((s) => s.body.file_id)).toEqual(["big"]);
    expect(h.tg.last("sendChatAction")?.body.action).toBe("typing");
    expect(h.rt.store.usage().listings).toBeGreaterThanOrEqual(0);
  });

  it("does not use copy_text when the draft is over 256 characters, and uses it below", () => {
    const base: CardResult = { listing: listing(), assessment: assess(listing(), filters()), draft: null, duplicate: false, possibleDuplicate: false, secondsToCard: 1 };
    const mk = (n: number): CardResult => ({ ...base, draft: { listingId: "x", lang: "es", text: "a".repeat(n), origin: "template" } });
    const copy = (c: CardResult) => buttons(renderCard(c, "k", "en").keyboard).filter((b) => b.copy_text);
    expect(copy(mk(257))).toHaveLength(0);
    expect(copy(mk(256))).toHaveLength(1);
    expect(copy(mk(256))[0]!.copy_text!.text).toHaveLength(256);
    expect(NOW).toBeTruthy();
  });
});

describe("card buttons", () => {
  async function sendCard() {
    h = harness();
    h.addRenter(7001);
    h.addRenter(7002);
    await h.say(7001, `${AD_ES}\nhttps://www.idealista.com/inmueble/98765432/`);
    return callbacks(h);
  }

  it("records sent, viewing and not_for_me for the owner", async () => {
    const cb = await sendCard();
    await h.press(7001, cb.find((b) => b.text === "Sent ✓")!.callback_data!);
    await h.press(7001, cb.find((b) => b.text === "Viewing booked")!.callback_data!);
    await h.press(7001, cb.find((b) => b.text === "Not for me")!.callback_data!);
    expect(h.rt.store.events("7001").map((e) => e.kind)).toEqual(["card_shown", "sent", "viewing", "not_for_me"]);
  });

  it("refuses another renter's key and records nothing", async () => {
    const cb = await sendCard();
    for (const b of cb) await h.press(7002, b.callback_data!);
    expect(h.rt.store.events("7001").map((e) => e.kind)).toEqual(["card_shown"]);
    expect(h.rt.store.events("7002")).toHaveLength(0);
    expect(h.tg.sent.filter((s) => s.method === "editMessageText")).toHaveLength(0);
    expect(h.tg.last("answerCallbackQuery")?.body.text).toMatch(/expired/);
  });

  it("re-drafts in another language and edits the message", async () => {
    const cb = await sendCard();
    await h.press(7001, cb.find((b) => b.text === "English")!.callback_data!, 321);
    const edit = h.tg.last("editMessageText")!;
    expect(edit.body.message_id).toBe(321);
    expect(String(edit.body.text)).toMatch(/Hello|Hi|Dear/i);
    expect(String(edit.body.text)).toContain("<pre>");
  });

  it("an unknown key does nothing", async () => {
    await sendCard();
    await h.press(7001, "s:bogus-key");
    expect(h.rt.store.events("7001").map((e) => e.kind)).toEqual(["card_shown"]);
  });
});
