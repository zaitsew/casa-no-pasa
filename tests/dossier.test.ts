import { afterEach, describe, expect, it } from "vitest";
import { GET as page } from "../app/d/[token]/route";
import { GET as download } from "../app/d/[token]/file/[id]/route";
import { createGrant, hashToken } from "../src/server/grants";
import { parseKey } from "../src/server/files";
import { AD_ES } from "./fixtures";
import { harness, KEY_HEX, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const PDF = Buffer.from("%PDF-1.4 invented payslip");
const PNG = Buffer.from("invented-png-bytes");

function setup() {
  h = harness();
  h.addRenter(7001, { pitch: "Quiet and tidy." });
  h.addRenter(7002);
  const { store, files } = h.rt;
  const add = (userId: string, id: string, label: string, mime: string, bytes: Buffer) => {
    store.addDocument({ id, userId, label, mime, size: bytes.length, fileName: files!.put(bytes) });
  };
  add("7001", "d1", "payslip", "application/pdf", PDF);
  add("7001", "d2", "id", "image/png", PNG);
  add("7002", "other", "id", "application/pdf", Buffer.from("someone else"));
  const grant = (ids: string[], ttl: "24h" | "7d" = "24h") => createGrant(store, parseKey(KEY_HEX), "7001", ids, ttl, h.clock.now);
  return { grant };
}

const ctx = (token: string, id?: string) => ({ params: Promise.resolve({ token, id: id ?? "" }) });
const get = (token: string, lang = "") => page(new Request(`https://x.test/d/${token}${lang}`), ctx(token));
const file = (token: string, id: string) => download(new Request(`https://x.test/d/${token}/file/${id}`), ctx(token, id));

function expectPrivateHeaders(r: Response) {
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
}

describe("dossier grants", () => {
  it("shows the page in Spanish by default and in English on request, with only what is set", async () => {
    const { grant } = setup();
    const { token } = grant(["d1"]);
    const es = await get(token);
    expect(es.status).toBe(200);
    expectPrivateHeaders(es);
    const html = await es.text();
    expect(html).toContain("Ana Prueba");
    expect(html).toContain("Ficha del inquilino");
    expect(html).toContain("Quiet and tidy.");
    expect(html).toContain("Nómina");
    expect(html).not.toContain("DNI");
    expect(html).not.toContain("2800"); // income is never on the page
    expect(html).toContain(`/d/${token}/file/d1`);
    expect(html).not.toContain("/file/d2"); // not ticked
    const en = await (await get(token, "?lang=en")).text();
    expect(en).toContain("Tenant file");
    expect(en).toContain("Payslip");
  });

  it("stores only a hash of the token", () => {
    const { grant } = setup();
    const { token } = grant(["d1"]);
    expect(h.rt.store.getGrantByHash(token)).toBeUndefined();
    const row = h.rt.store.getGrantByHash(hashToken(token))!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("streams the decrypted file for an active grant, in scope", async () => {
    const { grant } = setup();
    const { token } = grant(["d1"]);
    const r = await file(token, "d1");
    expect(r.status).toBe(200);
    expectPrivateHeaders(r);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await r.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("refuses a document outside the grant's scope and another renter's document", async () => {
    const { grant } = setup();
    const { token } = grant(["d1", "other"]); // "other" belongs to 7002: the scope may name it, the owner check drops it
    expect((await file(token, "d2")).status).toBe(404);
    expect((await file(token, "other")).status).toBe(404);
    expect((await file(token, "missing")).status).toBe(404);
    const html = await (await get(token)).text();
    expect(html).not.toContain("/file/other");
  });

  it("answers 410 after expiry, on the page and the file", async () => {
    const { grant } = setup();
    const { token } = grant(["d1"], "24h");
    h.clock.now = new Date(h.clock.now.getTime() + 24 * 3_600_000 + 1000);
    const p = await get(token);
    expect(p.status).toBe(410);
    expectPrivateHeaders(p);
    expect(await p.text()).toMatch(/caducado/);
    const f = await file(token, "d1");
    expect(f.status).toBe(410);
    expectPrivateHeaders(f);
  });

  it("answers 410 after /revoke and for an unknown token", async () => {
    const { grant } = setup();
    const { token } = grant(["d1"]);
    expect((await file(token, "d1")).status).toBe(200);
    await h.say(7001, "/revoke");
    expect((await get(token)).status).toBe(410);
    expect((await file(token, "d1")).status).toBe(410);
    expect((await get("A".repeat(22))).status).toBe(410);
    expect((await get("short")).status).toBe(410);
  });

  it("answers 404 when the file was deleted from storage or changed", async () => {
    const { grant } = setup();
    const { token } = grant(["d1"]);
    h.rt.files!.remove(h.rt.store.getDocument("7001", "d1")!.fileName);
    expect((await file(token, "d1")).status).toBe(404);
  });
});

describe("dossier through the bot", () => {
  it("creates a grant from ticked documents, shows the link once, and drafts carry it", async () => {
    setup();
    await h.say(7001, "/dossier");
    expect(h.tg.texts().at(-1)).toMatch(/Tick the documents/);
    await h.press(7001, "ds:0");
    await h.press(7001, "dx:7d");
    const msg = String(h.tg.last("sendMessage")!.body.text);
    const url = /https:\/\/casanopasa\.example\.test\/d\/([A-Za-z0-9_-]{22})/.exec(msg);
    expect(url).not.toBeNull();
    const token = url![1]!;
    const g = h.rt.store.getGrantByHash(hashToken(token))!;
    expect(g.docIds).toHaveLength(1);
    expect(g.tokenEnc).not.toContain(token);
    expect((await get(token)).status).toBe(200);

    await h.say(7001, AD_ES);
    expect(String(h.tg.last("sendMessage")!.body.text)).toContain(`/d/${token}`);

    await h.say(7001, "/revoke");
    await h.say(7001, AD_ES.replace("1.250", "1.260"));
    expect(String(h.tg.last("sendMessage")!.body.text)).not.toContain(`/d/${token}`);
  });

  it("accepts PDF/JPEG/PNG up to 10 MB with a label, and shows the privacy notice before the first upload", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "/docs");
    expect(h.tg.texts().at(-1)).toMatch(/encrypted on the server/);
    await h.press(7001, "dp:ok");
    await h.press(7001, "dl:payslip");
    h.tg.downloads.set("files/f1", PDF);
    await h.say(7001, "", { text: undefined, document: { file_id: "f1", file_size: PDF.length, mime_type: "application/pdf", file_name: "x.pdf" } });
    const docs = h.rt.store.listDocuments("7001");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ label: "payslip", mime: "application/pdf", size: PDF.length });
    expect(h.rt.files!.get(docs[0]!.fileName).equals(PDF)).toBe(true);

    await h.say(7001, "", { text: undefined, document: { file_id: "f2", file_size: 11 * 1024 * 1024, mime_type: "application/pdf" } });
    await h.say(7001, "", { text: undefined, document: { file_id: "f3", file_size: 10, mime_type: "application/zip" } });
    expect(h.rt.store.listDocuments("7001")).toHaveLength(1);
    expect(h.tg.texts().slice(-2)).toEqual([expect.stringMatching(/over 10 MB/), expect.stringMatching(/only accept PDF/)]);
  });
});
