import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/inbound/[alias]/route";
import { clipPlain, renderCard } from "../src/bot/cards";
import { createTg } from "../src/bot/tg";
import type { CardResult } from "../src/engine";
import { assess } from "../src/engine/assess";
import { UserGoneError } from "../src/engine/store";
import { sha256Hex } from "../src/server/auth";
import { createGrant } from "../src/server/grants";
import { parseKey } from "../src/server/files";
import { purgeIfDue } from "../src/server/runtime";
import { AD_ES, filters, listing } from "./fixtures";
import { fakeTelegram, harness, INBOUND_SECRET, KEY_HEX, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const PDF = Buffer.from("%PDF-1.4 invented payslip");

describe("review fix: an in-flight request cannot recreate a deleted renter", () => {
  it("a document upload finishing after /delete leaves no user, no document row and no file", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "/docs");
    await h.press(7001, "dp:ok");
    await h.press(7001, "dl:payslip");
    h.tg.downloads.set("files/f1", PDF);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realGetFile = h.rt.tg.getFile.bind(h.rt.tg);
    h.rt.tg.getFile = async (id) => {
      await gate; // a slow Telegram download
      return realGetFile(id);
    };
    const upload = h.say(7001, "", { text: undefined, document: { file_id: "f1", file_size: PDF.length, mime_type: "application/pdf" } });
    await h.say(7001, "/delete");
    await h.press(7001, "del:yes");
    expect(h.rt.store.isLinked("7001")).toBe(false);
    h.tg.clear();

    release();
    await upload;
    expect(h.rt.store.isLinked("7001")).toBe(false);
    expect(h.rt.store.listDocuments("7001")).toEqual([]);
    expect(h.rt.store.getState("7001")).toBeUndefined();
    expect(existsSync(h.rt.files!.dir) ? readdirSync(h.rt.files!.dir) : []).toEqual([]);
    expect(h.tg.texts()).toEqual([]); // replies nothing
  });

  it("a listing save, grant and alias after /delete throw instead of creating the renter", () => {
    h = harness();
    h.addRenter(7001);
    h.rt.store.deleteUser("7001");
    const key = parseKey(KEY_HEX);
    expect(() => h.rt.store.saveListing("7001", listing())).toThrow(UserGoneError);
    expect(() => createGrant(h.rt.store, key, "7001", [], "24h", h.clock.now)).toThrow(UserGoneError);
    expect(() => h.rt.store.setInboundAlias("7001", "x".repeat(64))).toThrow(UserGoneError);
    expect(() => h.rt.store.setState("7001", {})).toThrow(UserGoneError);
    expect(() => h.rt.store.addDocument({ id: "z", userId: "7001", label: "id", mime: "application/pdf", size: 1, fileName: "n" })).toThrow(UserGoneError);
    expect(h.rt.store.usage()).toMatchObject({ listings: 0 });
    expect(h.rt.store.isLinked("7001")).toBe(false);
  });

  it("a listing message that is still being processed when /delete lands is not saved", async () => {
    h = harness();
    h.addRenter(7001);
    const pending = h.say(7001, AD_ES);
    h.rt.store.deleteUser("7001"); // lands before the in-flight request reaches its writes
    await pending;
    expect(h.rt.store.isLinked("7001")).toBe(false);
    expect(h.rt.store.usage()).toMatchObject({ users: 0, listings: 0 });
    expect(h.tg.texts()).toEqual([]);
  });
});

describe("review fix: a card never exceeds Telegram's limit and never cuts markup", () => {
  const valid = (html: string) => {
    // Every tag opened is closed, no half tag, no half entity.
    expect(html).not.toMatch(/<[^>]*$/);
    expect(html).not.toMatch(/&[a-z]*$/);
    expect((html.match(/<pre>/g) ?? []).length).toBe((html.match(/<\/pre>/g) ?? []).length);
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
  };

  it("clipPlain cuts plain text so that the escaped form fits, entities whole", () => {
    const out = clipPlain("<&>".repeat(500), 100);
    const escaped = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(escaped.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…")).toBe(true);
    expect(clipPlain("short", 100)).toBe("short");
  });

  it("a 6,000-character draft with many long flags renders under 4,096 and well-formed", () => {
    const l = listing({ priceEur: 5000, description: "x" });
    const a = assess(l, filters({ maxPriceEur: 500, zones: ["Nowhere"], minRooms: 6 }));
    const manyFlags = Array.from({ length: 12 }, (_, i) => ({ code: `custom_${i}`, severity: "warn" as const, detail: `<flag ${i}> & ${"detail ".repeat(100)}` }));
    const r: CardResult = {
      listing: l,
      assessment: { ...a, flags: [...a.flags, ...manyFlags], unknowns: Array.from({ length: 40 }, (_, i) => `unknown <${i}> ${"u".repeat(30)}`) },
      draft: { text: `Hola <&> ${"Soy una persona tranquila y ordenada. ".repeat(160)}`, lang: "es" } as CardResult["draft"],
    } as CardResult;
    const card = renderCard(r, "key", "en");
    expect(card.text.length).toBeLessThan(4096);
    valid(card.text);
    expect(card.text).toContain("<pre>");
    // never a copy button for a draft over 256 characters
    expect(JSON.stringify(card.keyboard)).not.toContain("copy_text");
  });

  it("the Telegram client sends an over-long HTML message as plain text instead of slicing markup", async () => {
    const tg = fakeTelegram();
    const client = createTg({ token: "1:a", fetch: tg.fetch });
    await client.sendMessage(1, `<b>head</b>\n<pre>${"a &amp; b ".repeat(1000)}</pre>`);
    const body = tg.sent[0]!.body;
    expect(String(body.text).length).toBeLessThanOrEqual(4000);
    expect(body.parse_mode).toBeUndefined();
    expect(String(body.text)).not.toMatch(/<|&amp;/);
  });
});

describe("review fix: inbound email", () => {
  const ALIAS = "0123456789abcdef0123456789abcdef";
  const post = (body: unknown | string) =>
    POST(new Request(`https://x.test/api/inbound/${ALIAS}`, { method: "POST", headers: { "content-type": "application/json", "x-casanopasa-inbound": INBOUND_SECRET }, body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ alias: ALIAS }) });
  function setup() {
    h = harness();
    h.addRenter(7001);
    h.rt.store.setInboundAlias("7001", sha256Hex(ALIAS));
  }

  it("cuts a body over the engine's 50,000-character limit at a paragraph instead of failing", async () => {
    setup();
    const para = "Piso en Gràcia, 75 m2, 3 hab. 1.250 €/mes. Larga duración.\n\n";
    const text = para.repeat(Math.ceil(120_000 / para.length));
    expect(text.length).toBeGreaterThan(100_000);
    const r = await post({ from: "Portal alerts", subject: "Many flats", text });
    expect(r.status).toBe(200);
    expect(h.tg.last("sendMessage")).toBeDefined();
  });

  it("rejects only bodies over 1 MB, with 413", async () => {
    setup();
    const r = await post(JSON.stringify({ from: "x", subject: "s", text: "a".repeat(1_100_000) }));
    expect(r.status).toBe(413);
    expect((await post({ from: "x", subject: "s", text: "b".repeat(300_000) })).status).toBe(200);
  });

  it("runs the retention purge, at most once an hour", async () => {
    setup();
    const old = listing({ seenAt: "2026-01-01T10:00:00.000Z", id: "oldoldoldold0001" });
    h.rt.store.saveListing("7001", old);
    expect(h.rt.store.getListing("7001", old.id)).toBeDefined();
    const mail = { from: "Portal alerts", subject: "New", text: "Piso en Gràcia, 75 m2, 3 hab. 1.250 €/mes. Larga duración." };
    expect((await post(mail)).status).toBe(200);
    expect(h.rt.store.getListing("7001", old.id)).toBeUndefined(); // purged by the inbound path

    h.rt.store.saveListing("7001", { ...old, id: "oldoldoldold0002" });
    expect(purgeIfDue(h.rt)).toBeUndefined(); // same hour: not due
    expect(h.rt.store.getListing("7001", "oldoldoldold0002")).toBeDefined();
    h.clock.now = new Date(h.clock.now.getTime() + 3_700_000);
    expect(purgeIfDue(h.rt)).toBe(1);
  });
});
