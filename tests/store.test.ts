import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/engine/store";
import { filters, listing, NOW, profile } from "./fixtures";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cnp-"));
  store = openStore(join(dir, "t.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("round-trips profile and filters, with default filters", () => {
    expect(store.getProfile("u1")).toBeUndefined();
    expect(store.getFilters("u1").longTermOnly).toBe(true);
    store.setProfile(profile());
    store.setFilters("u1", filters({ maxPriceEur: 1500 }));
    expect(store.getProfile("u1")?.name).toBe("Ana Prueba");
    expect(store.getFilters("u1").maxPriceEur).toBe(1500);
  });

  it("portal id: same price is a duplicate, a new price is a revision", () => {
    const a = listing({ id: "idealista:1", portalId: "1", source: "idealista", priceEur: 1200 });
    expect(store.saveListing("u1", a)).toEqual({ status: "new" });
    expect(store.saveListing("u1", a)).toEqual({ status: "duplicate" });
    expect(store.saveListing("u1", { ...a, priceEur: 1100 })).toEqual({ status: "revision", oldPriceEur: 1200, newPriceEur: 1100 });
    expect(store.getListing("u1", "idealista:1")?.priceEur).toBe(1100);
    expect(store.occurrences("u1", "idealista:1")).toHaveLength(3);
  });

  it("hash only: a repeat is a possible duplicate and every occurrence is kept", () => {
    const a = listing({ id: "hash:abc", source: "instagram" });
    expect(store.saveListing("u1", a).status).toBe("new");
    expect(store.saveListing("u1", { ...a, source: "facebook", seenAt: "2026-11-11T11:00:00.000Z" }).status).toBe("possible_duplicate");
    expect(store.occurrences("u1", "hash:abc").map((o) => o.source)).toEqual(["instagram", "facebook"]);
  });

  it("renters do not see each other's listings", () => {
    store.saveListing("u1", listing({ id: "x" }));
    expect(store.saveListing("u2", listing({ id: "x" })).status).toBe("new");
    expect(store.getListing("u3", "x")).toBeUndefined();
  });

  it("records events, rejects unknown kinds, and computes usage", () => {
    store.saveListing("u1", listing({ id: "x" }));
    for (const s of [2, 4, 6]) store.recordEvent("u1", "x", "card_shown", `2026-11-11T10:00:0${s}.000Z`, NOW.replace("10:00:00", "10:00:00"));
    store.recordEvent("u1", "x", "copied", NOW);
    store.recordEvent("u1", "x", "sent", NOW);
    store.recordEvent("u1", "x", "viewing", NOW);
    expect(() => store.recordEvent("u1", "x", "bogus" as never, NOW)).toThrow();
    expect(store.events("u1", "card_shown")).toHaveLength(3);
    expect(store.usage()).toEqual({ users: 1, listings: 1, cards: 3, copied: 1, sent: 1, viewings: 1, median_seconds_to_card: 4 });
  });

  it("reports not_enough_data with fewer than three cards", () => {
    expect(store.usage().median_seconds_to_card).toBe("not_enough_data");
  });

  it("purges old listings and deletes a renter", () => {
    store.saveListing("u1", listing({ id: "old", seenAt: "2026-01-01T00:00:00.000Z" }));
    store.saveListing("u1", listing({ id: "new", seenAt: NOW }));
    expect(store.purgeListings(90, new Date(NOW))).toBe(1);
    expect(store.getListing("u1", "old")).toBeUndefined();
    store.setProfile(profile());
    store.recordEvent("u1", "new", "copied", NOW);
    store.deleteUser("u1");
    expect(store.getProfile("u1")).toBeUndefined();
    expect(store.getListing("u1", "new")).toBeUndefined();
    expect(store.events("u1")).toEqual([]);
    expect(store.usage().users).toBe(0);
  });
});

describe("enrichment", () => {
  it("a sparse portal listing seen again with facts is enriched, not a duplicate", () => {
    const sparse = listing({ id: "idealista:7", portalId: "7", source: "idealista", priceEur: undefined, areaM2: undefined, rooms: undefined, neighbourhood: undefined, description: undefined, evidence: {} });
    expect(store.saveListing("u1", sparse)).toEqual({ status: "new" });
    const full = listing({ id: "idealista:7", portalId: "7", source: "idealista", priceEur: 1200 });
    const r = store.saveListing("u1", full);
    expect(r.status).toBe("enriched");
    const stored = store.getListing("u1", "idealista:7")!;
    expect(stored).toMatchObject({ priceEur: 1200, areaM2: 75, rooms: 3, neighbourhood: "Gràcia" });
    expect(stored.evidence.areaM2).toBe("75 m²");
    expect(store.saveListing("u1", full)).toEqual({ status: "duplicate" });
  });

  it("keeps existing values when the price is unchanged", () => {
    const a = listing({ id: "idealista:8", portalId: "8", source: "idealista", rooms: 2, areaM2: undefined });
    store.saveListing("u1", a);
    store.saveListing("u1", { ...a, rooms: 5, areaM2: 60 });
    expect(store.getListing("u1", "idealista:8")).toMatchObject({ rooms: 2, areaM2: 60 });
  });
});
