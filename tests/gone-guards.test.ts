import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/inbound/[alias]/route";
import { UserGoneError } from "../src/engine/store";
import { sha256Hex } from "../src/server/auth";
import { harness, INBOUND_SECRET, type Harness } from "./helpers/bot";

// Regression tests for the second review round of PR #2 (two P1s), fixed in their own PR.

let h: Harness;
afterEach(() => h?.cleanup());

const PDF = Buffer.from("%PDF-1.4 invented payslip");

describe("a slow path finishing after /delete writes nothing", () => {
  it("recordEvent and a new listingKey throw UserGoneError for a deleted renter", () => {
    h = harness();
    h.addRenter(7001);
    h.rt.store.deleteUser("7001");
    expect(() => h.rt.store.recordEvent("7001", "idealista:1", "card_shown", new Date().toISOString())).toThrow(UserGoneError);
    expect(() => h.rt.store.listingKey("7001", "idealista:1")).toThrow(UserGoneError);
    expect(h.rt.store.events("7001")).toEqual([]);
  });

  it("an alert email arriving for a deleted renter is accepted and keeps nothing", async () => {
    h = harness();
    h.addRenter(7001);
    const alias = "a".repeat(32);
    h.rt.store.setInboundAlias("7001", sha256Hex(alias));
    const realHandle = h.rt.engine.handleInput.bind(h.rt.engine);
    h.rt.engine.handleInput = async (...args) => {
      const results = await realHandle(...args);
      h.rt.store.deleteUser("7001"); // /delete lands while the email is being read
      return results;
    };
    h.tg.clear();
    const r = await POST(
      new Request(`https://x.test/api/inbound/${alias}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-casanopasa-inbound": INBOUND_SECRET },
        body: JSON.stringify({ from: "Portal alerts", subject: "New flat", text: "Piso en Gràcia, 75 m2, 3 hab. 1.250 €/mes. Larga duración." }),
      }),
      { params: Promise.resolve({ alias }) },
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, gone: true });
    expect(h.rt.store.events("7001")).toEqual([]);
    expect(h.tg.texts()).toEqual([]);
  });
});

describe("a committed upload keeps its file", () => {
  it("a failure after addDocument (sending the reply) does not delete the stored file", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "/docs");
    await h.press(7001, "dp:ok");
    await h.press(7001, "dl:payslip");
    h.tg.downloads.set("files/f1", PDF);
    const realSend = h.rt.tg.sendMessage.bind(h.rt.tg);
    let failed = false;
    h.rt.tg.sendMessage = async (...args) => {
      if (!failed && h.rt.store.listDocuments("7001").length > 0) {
        failed = true;
        throw new Error("network");
      }
      return realSend(...args);
    };
    await h.say(7001, "", { text: undefined, document: { file_id: "f1", file_size: PDF.length, mime_type: "application/pdf" } });
    const docs = h.rt.store.listDocuments("7001");
    expect(docs).toHaveLength(1);
    expect(existsSync(h.rt.files!.dir) ? readdirSync(h.rt.files!.dir) : []).toContain(docs[0]!.fileName);
  });
});
