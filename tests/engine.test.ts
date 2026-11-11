import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type CasaEngine } from "../src/engine";
import { openStore } from "../src/engine/store";
import { AD_ES, filters, profile, text } from "./fixtures";

let dir: string;
let engine: CasaEngine;
let clock = new Date("2026-11-11T10:00:20.000Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cnp-"));
  clock = new Date("2026-11-11T10:00:20.000Z");
  engine = createEngine({ env: {}, now: () => clock, store: openStore(join(dir, "e.db")) });
});
afterEach(() => {
  engine.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("handleInput, AI off", () => {
  it("extracts, assesses, drafts and records the card with its latency", async () => {
    engine.store.setProfile(profile({ userId: "u1" }));
    engine.store.setFilters("u1", filters({ maxPriceEur: 1500, zones: ["Gràcia"] }));
    const [card] = await engine.handleInput("u1", text(AD_ES));
    expect(card!.duplicate).toBe(false);
    expect(card!.listing.priceEur).toBe(1250);
    expect(card!.assessment.verdict).toBe("go"); // every mandatory fact is known and matches; the missing move-in date does not cap it
    expect(card!.assessment.flags.map((f) => f.code)).toContain("stressed_zone_cap_check");
    expect(card!.draft?.origin).toBe("template");
    expect(card!.draft?.whatsappUrl).toContain("https://wa.me/34600000001");
    expect(card!.secondsToCard).toBe(20);
    const ev = engine.store.events("u1", "card_shown");
    expect(ev).toHaveLength(1);
    expect(Date.parse(ev[0]!.at) - Date.parse(ev[0]!.receivedAt!)).toBe(20_000);
  });

  it("marks a portal-id repeat as a duplicate and records no second card", async () => {
    const input = text("https://www.idealista.com/inmueble/12345678/ Piso en Gràcia, Barcelona, 1.100 €/mes");
    expect((await engine.handleInput("u1", input))[0]!.duplicate).toBe(false);
    const again = (await engine.handleInput("u1", input))[0]!;
    expect(again.duplicate).toBe(true);
    expect(engine.store.events("u1", "card_shown")).toHaveLength(1);
  });

  it("reports a price revision and still shows the card", async () => {
    await engine.handleInput("u1", text("https://www.idealista.com/inmueble/12345678/ Piso, 1.100 €/mes"));
    const [card] = await engine.handleInput("u1", text("https://www.idealista.com/inmueble/12345678/ Piso, 1.000 €/mes"));
    expect(card).toMatchObject({ duplicate: false, revision: { oldPriceEur: 1100, newPriceEur: 1000 } });
  });

  it("a hash-only repeat is a possible duplicate and is still assessed and shown", async () => {
    await engine.handleInput("u1", text("Piso en Gràcia, 2 hab., 900 €/mes"));
    const [card] = await engine.handleInput("u1", text("Piso en Gràcia, 2 hab., 900 €/mes"));
    expect(card).toMatchObject({ duplicate: false, possibleDuplicate: true });
    expect(card!.assessment.listingId).toBe(card!.listing.id);
    expect(engine.store.events("u1", "card_shown")).toHaveLength(2);
    expect(engine.store.occurrences("u1", card!.listing.id)).toHaveLength(2);
  });

  it("works without a profile (no draft) and for a bare link", async () => {
    const [card] = await engine.handleInput("u2", text("https://www.instagram.com/stories/inventado/1/"));
    expect(card!.draft).toBeNull();
    expect(card!.assessment.unknowns.some((u) => u.startsWith("only a link"))).toBe(true);
  });
});

describe("handleInput, enrichment", () => {
  it("a bare link and then the ad gives a full card flagged enriched", async () => {
    const [bare] = await engine.handleInput("u1", text("https://www.idealista.com/inmueble/22222222/"));
    expect(bare!.listing.priceEur).toBeUndefined();
    const [full] = await engine.handleInput("u1", text("https://www.idealista.com/inmueble/22222222/ Piso en Gràcia, Barcelona, 75 m², 1.100 €/mes"));
    expect(full).toMatchObject({ duplicate: false, enriched: true });
    expect(full!.listing).toMatchObject({ priceEur: 1100, areaM2: 75 });
    expect(engine.store.events("u1", "card_shown")).toHaveLength(2);
  });
});
