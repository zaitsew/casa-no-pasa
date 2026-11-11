import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrant, hashToken } from "../src/server/grants";
import { parseKey } from "../src/server/files";
import { AD_ES } from "./fixtures";
import { harness, KEY_HEX, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

describe("/delete", () => {
  it("asks first, then removes every row and every file of the renter, and only theirs", async () => {
    h = harness();
    h.addRenter(7001);
    h.addRenter(7002);
    const { store, files } = h.rt;
    await h.say(7001, AD_ES);
    const names = ["a", "b"].map((id, i) => {
      const fileName = files!.put(Buffer.from(`doc ${id}`));
      store.addDocument({ id, userId: "7001", label: "id", mime: "application/pdf", size: 5, fileName });
      return fileName;
    });
    const keepName = files!.put(Buffer.from("keep"));
    store.addDocument({ id: "k", userId: "7002", label: "id", mime: "application/pdf", size: 4, fileName: keepName });
    const { token } = createGrant(store, parseKey(KEY_HEX), "7001", ["a"], "7d", h.clock.now);
    await h.say(7001, "/email");

    await h.say(7001, "/delete");
    expect(h.tg.texts().at(-1)).toMatch(/cannot be undone/);
    expect(store.getProfile("7001")).toBeDefined(); // nothing happens until the button
    await h.press(7001, "del:no");
    expect(store.getProfile("7001")).toBeDefined();

    await h.press(7001, "del:yes");
    expect(store.isLinked("7001")).toBe(false);
    expect(store.getProfile("7001")).toBeUndefined();
    expect(store.getFilters("7001")).toMatchObject({ zones: [] });
    expect(store.listDocuments("7001")).toEqual([]);
    expect(store.events("7001")).toEqual([]);
    expect(store.hasInboundAlias("7001")).toBe(false);
    expect(store.getGrantByHash(hashToken(token))).toBeUndefined();
    for (const n of names) expect(existsSync(join(files!.dir, n))).toBe(false);
    expect(existsSync(join(files!.dir, keepName))).toBe(true);
    expect(store.listDocuments("7002")).toHaveLength(1);
    expect(h.tg.texts().at(-1)).toMatch(/erased/i);
  });
});
