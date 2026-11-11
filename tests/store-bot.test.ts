import { describe, expect, it } from "vitest";
import { openStore } from "../src/engine/store";
import { sha256Hex } from "../src/server/auth";

describe("store: bot tables", () => {
  it("redeems an invite once and links the user", () => {
    const s = openStore(":memory:");
    s.createInvite("h1");
    expect(s.isLinked("77")).toBe(false);
    expect(s.redeemInvite("h1", "77")).toBe(true);
    expect(s.isLinked("77")).toBe(true);
    expect(s.redeemInvite("h1", "78")).toBe(false);
    expect(s.isLinked("78")).toBe(false);
    expect(s.redeemInvite("unknown", "79")).toBe(false);
  });

  it("keeps state per user", () => {
    const s = openStore(":memory:");
    s.setState("1", { a: 1 });
    expect(s.getState("1")).toEqual({ a: 1 });
    expect(s.getState("2")).toBeUndefined();
  });

  it("maps listing keys to the owner only and reuses a key per listing", () => {
    const s = openStore(":memory:");
    s.upsertUser("1");
    const k = s.listingKey("1", "hash:x");
    expect(s.listingKey("1", "hash:x")).toBe(k);
    expect(s.resolveListingKey(k)).toEqual({ userId: "1", listingId: "hash:x" });
    expect(s.resolveListingKey("nope")).toBeUndefined();
    expect(k.length).toBeLessThanOrEqual(16);
  });

  it("scopes documents to their owner and drops them from grants", () => {
    const s = openStore(":memory:");
    s.upsertUser("1");
    s.upsertUser("2");
    s.addDocument({ id: "d1", userId: "1", label: "id", mime: "application/pdf", size: 3, fileName: "a.bin" });
    expect(s.getDocument("2", "d1")).toBeUndefined();
    s.createGrant({ tokenHash: "t", userId: "1", docIds: ["d1"], tokenEnc: "x", expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(s.removeDocument("2", "d1")).toBeUndefined();
    expect(s.removeDocument("1", "d1")?.fileName).toBe("a.bin");
    expect(s.getGrantByHash("t")?.docIds).toEqual([]);
  });

  it("finds the newest active grant and revokes all", () => {
    const s = openStore(":memory:");
    s.upsertUser("1");
    const now = new Date("2026-11-11T00:00:00Z");
    s.createGrant({ tokenHash: "old", userId: "1", docIds: [], tokenEnc: "o", createdAt: "2026-11-10T00:00:00Z", expiresAt: "2026-11-10T12:00:00Z" });
    s.createGrant({ tokenHash: "new", userId: "1", docIds: [], tokenEnc: "n", createdAt: "2026-11-11T00:00:00Z", expiresAt: "2026-11-12T00:00:00Z" });
    expect(s.latestActiveGrant("1", now)?.tokenHash).toBe("new");
    expect(s.revokeGrants("1", now)).toBe(1);
    expect(s.latestActiveGrant("1", now)).toBeUndefined();
    expect(s.getGrantByHash("new")?.revoked).toBe(true);
  });

  it("keeps one alias per renter and finds the renter by its hash", () => {
    const s = openStore(":memory:");
    s.upsertUser("1");
    s.setInboundAlias("1", sha256Hex("a"));
    s.setInboundAlias("1", sha256Hex("b"));
    expect(s.userForAliasHash(sha256Hex("a"))).toBeUndefined();
    expect(s.userForAliasHash(sha256Hex("b"))).toBe("1");
  });

  it("deleteUser removes every bot table row for the renter and only theirs", () => {
    const s = openStore(":memory:");
    s.createInvite("h");
    s.redeemInvite("h", "1");
    s.upsertUser("2", "2");
    s.setState("1", { x: 1 });
    s.setState("2", { x: 2 });
    s.addDocument({ id: "d", userId: "1", label: "id", mime: "image/png", size: 1, fileName: "f.bin" });
    s.createGrant({ tokenHash: "t", userId: "1", docIds: ["d"], tokenEnc: "x", expiresAt: "2030-01-01T00:00:00Z" });
    s.setInboundAlias("1", "ah");
    s.listingKey("1", "l");
    s.deleteUser("1");
    expect(s.isLinked("1")).toBe(false);
    expect(s.getState("1")).toBeUndefined();
    expect(s.listDocuments("1")).toEqual([]);
    expect(s.getGrantByHash("t")).toBeUndefined();
    expect(s.userForAliasHash("ah")).toBeUndefined();
    expect(s.getState("2")).toEqual({ x: 2 });
    expect(s.redeemInvite("h", "3")).toBe(false);
  });
});
