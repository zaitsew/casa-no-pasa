import { afterEach, describe, expect, it } from "vitest";
import { renderCard } from "../src/bot/cards";
import { FIELDS, inferContract } from "../src/bot/fields";
import type { UiLang } from "../src/bot/strings";
import type { Keyboard } from "../src/bot/tg";
import { sha256Hex } from "../src/server/auth";
import { buttons, harness, type Harness } from "./helpers/bot";
import { assess } from "../src/engine/assess";
import type { CardResult } from "../src/engine";
import { filters, listing } from "./fixtures";

let h: Harness;
afterEach(() => h?.cleanup());

const startOnboarding = async (id = 9001) => {
  h.rt.store.createInvite(sha256Hex(`c${id}`));
  await h.say(id, `/start c${id}`);
  await h.press(id, "pn:ok");
  await h.say(id, "Ana");
  await h.press(id, "fu:start"); // the questionnaire starts from the occupation
};

describe("contract inference", () => {
  it.each([
    ["product manager, permanent contract", "permanent"],
    ["Camarera, contrato Indefinido", "permanent"],
    ["enginyer, contracte indefinit", "permanent"],
    ["программист, бессрочный контракт", "permanent"],
    ["designer on a fixed-term deal", "temporary"],
    ["profesor temporal", "temporary"],
    ["маркетолог, срочный", "temporary"],
    ["Freelancer UX", "self-employed"],
    ["soy autónomo", "self-employed"],
    ["дизайнер ИП", "self-employed"],
    ["estudiante de máster", "student"],
    ["студент", "student"],
  ])("%s -> %s", (text, want) => expect(inferContract(text)).toBe(want));

  it("matches whole words only and returns nothing when no word fits", () => {
    expect(inferContract("impermanent dreams")).toBeUndefined();
    expect(inferContract("studentship")).toBeUndefined();
    expect(inferContract("product manager")).toBeUndefined();
  });

  it("skips the contract question during onboarding", async () => {
    h = harness();
    await startOnboarding();
    await h.say(9001, "product manager, permanent contract");
    expect(h.rt.store.getProfile("9001")).toMatchObject({ occupation: "product manager, permanent contract", contract: "permanent" });
    expect(h.tg.texts().at(-1)).toMatch(/Net monthly income/);
    expect(h.tg.texts().join("\n")).not.toMatch(/Contract type\?/);
  });

  it("still asks when the answer names no contract", async () => {
    h = harness();
    await startOnboarding();
    await h.say(9001, "product manager");
    expect(h.tg.texts().at(-1)).toMatch(/Contract type\?/);
  });
});

describe("readable keyboards", () => {
  it("puts the contract choices in rows of 2-2-1", async () => {
    h = harness();
    await startOnboarding();
    await h.say(9001, "product manager");
    const rows = h.tg.keyboardOf(h.tg.last()).filter((r) => r[0]?.callback_data?.startsWith("f:contract"));
    expect(rows.map((r) => r.length)).toEqual([2, 2, 1]);
  });

  const noCrowdedRow = (kb: Keyboard, where: string) => {
    for (const row of kb) {
      if (row.some((b) => b.text.length > 8)) expect(row.length, `${where}: ${row.map((b) => b.text).join(" | ")}`).toBeLessThanOrEqual(2);
    }
  };

  it.each(["en", "es", "ru"] as const)("no keyboard row crowds long labels (%s)", async (ui) => {
    h = harness();
    const lang = ui === "es" ? "ca" : ui;
    const id = 9100;
    h.addRenter(id);
    const say = (text: string) =>
      h.rt.bot.handleUpdate({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1_800_000_000, chat: { id, type: "private" }, from: { id, language_code: lang }, text } });
    const press = (data: string) =>
      h.rt.bot.handleUpdate({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: "cb", from: { id, language_code: lang }, data, message: { message_id: 5, chat: { id, type: "private" } } } });
    const check = (where: string) => noCrowdedRow(h.tg.keyboardOf(h.tg.last()), where);
    for (const f of FIELDS) {
      await press(`pe:${f.key}`);
      check(`ask ${f.key}`);
    }
    for (const c of ["/profile", "/filters", "/docs", "/delete", "/dossier"]) {
      await say(c);
      check(c);
    }
    await press("dp:ok");
    check("docs");
    h.tg.clear();
    const l = listing({ url: "https://www.idealista.com/inmueble/1/" });
    const r: CardResult = { listing: l, assessment: assess(l, filters()), draft: { listingId: "x", lang: "es", text: "Hola", origin: "template", whatsappUrl: "https://wa.me/1?text=Hola" }, duplicate: false, possibleDuplicate: false, secondsToCard: 1 };
    const rendered = renderCard(r, "k", ui as UiLang);
    noCrowdedRow(rendered.keyboard, "card");
    expect(buttons(rendered.keyboard).length).toBeGreaterThan(3);
  });
});

describe("income sanity", () => {
  const income = () => h.rt.store.getProfile("9001")?.netMonthlyIncomeEur;

  it("offers monthly or keep for a yearly-looking figure and saves nothing yet", async () => {
    h = harness();
    h.addRenter(9001);
    await h.press(9001, "pe:income");
    await h.say(9001, "70000");
    expect(h.tg.texts().at(-1)).toMatch(/yearly figure\. Save 5,833 € a month\?/);
    const kb = buttons(h.tg.keyboardOf(h.tg.last()));
    expect(kb.map((b) => b.text)).toEqual(["5,833 € / month", "Keep 70,000 €"]);
    expect(income()).not.toBe(70000);
    expect(income()).not.toBe(5833);
  });

  it("saves round(n/12) on the monthly button, then shows the edited section", async () => {
    h = harness();
    h.addRenter(9001);
    await h.press(9001, "pe:income");
    await h.say(9001, "70000");
    await h.press(9001, "ic:m");
    expect(income()).toBe(5833);
    expect(h.tg.texts().at(-2)).toBe("Saved.");
    expect(h.tg.texts().at(-1)).toMatch(/Your profile/);
  });

  it("saves the figure as given on the keep button", async () => {
    h = harness();
    h.addRenter(9001);
    await h.press(9001, "pe:income");
    await h.say(9001, "70.000");
    await h.press(9001, "ic:k");
    expect(income()).toBe(70000);
  });

  it("does not ask at or below 15000, and ignores a stale button", async () => {
    h = harness();
    h.addRenter(9001);
    await h.press(9001, "pe:income");
    await h.say(9001, "15000");
    expect(income()).toBe(15000);
    await h.press(9001, "ic:m"); // no open question: ignored
    expect(income()).toBe(15000);
  });

  it("continues onboarding after the choice", async () => {
    h = harness();
    await startOnboarding();
    await h.say(9001, "dev, permanent");
    await h.say(9001, "70000");
    await h.press(9001, "ic:m");
    expect(h.rt.store.getProfile("9001")?.netMonthlyIncomeEur).toBe(5833);
    expect(h.tg.texts().at(-1)).toMatch(/How many people/);
  });
});

describe("fixable answers", () => {
  it("shows the profile with edit buttons when onboarding ends", async () => {
    h = harness();
    await startOnboarding();
    for (const f of FIELDS.slice(1)) {
      await h.press(9001, `fs:${f.key}`);
    }
    const texts = h.tg.texts();
    expect(texts.at(-2)).toMatch(/All set/);
    expect(texts.at(-1)).toMatch(/Your profile/);
    const kb = buttons(h.tg.keyboardOf(h.tg.last()));
    expect(kb.map((b) => b.callback_data)).toEqual(FIELDS.filter((f) => f.section === "profile").map((f) => `pe:${f.key}`));
  });

  it("every pe:<field> button opens that question", async () => {
    h = harness();
    h.addRenter(9001);
    for (const f of FIELDS) {
      h.tg.clear();
      await h.press(9001, `pe:${f.key}`);
      expect(h.tg.sent.some((s) => s.method === "sendMessage"), f.key).toBe(true);
    }
  });
});
