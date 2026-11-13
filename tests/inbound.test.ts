import { afterEach, describe, expect, it } from "vitest";
import { HEAD, POST } from "../app/api/inbound/[alias]/route";
import { sha256Hex } from "../src/server/auth";
import { GMAIL_FORWARDING_SENDER } from "../src/server/inbound";
import { harness, INBOUND_SECRET, type Harness } from "./helpers/bot";

let h: Harness;
afterEach(() => h?.cleanup());

const ALIAS = "0123456789abcdef0123456789abcdef";
function setup() {
  h = harness();
  h.addRenter(7001);
  h.rt.store.setInboundAlias("7001", sha256Hex(ALIAS));
}
const post = (alias: string, body: unknown, secret: string | null = INBOUND_SECRET) =>
  POST(new Request(`https://x.test/api/inbound/${alias}`, { method: "POST", headers: { "content-type": "application/json", ...(secret !== null ? { "x-casanopasa-inbound": secret } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ alias }) });

const mail = { from: "Portal alerts", subject: "New flat in Gràcia", text: "Piso en Gràcia, 75 m2, 3 hab. 1.250 €/mes. Larga duración." };

const head = (alias: string, secret: string | null = INBOUND_SECRET) =>
  HEAD(new Request(`https://x.test/api/inbound/${alias}`, { method: "HEAD", headers: secret !== null ? { "x-casanopasa-inbound": secret } : {} }), { params: Promise.resolve({ alias }) });

describe("inbound email", () => {
  it("HEAD says whether an alias exists: 204 known, 404 unknown or malformed, 401 without the secret, no body", async () => {
    setup();
    const known = await head(ALIAS);
    expect(known.status).toBe(204);
    expect(await known.text()).toBe("");
    expect((await head(ALIAS.toUpperCase())).status).toBe(204);
    expect((await head("f".repeat(32))).status).toBe(404);
    expect((await head("7001")).status).toBe(404);
    expect((await head(ALIAS, null)).status).toBe(401);
    expect((await head(ALIAS, "nope")).status).toBe(401);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("rejects a missing or wrong secret and an unconfigured server", async () => {
    setup();
    expect((await post(ALIAS, mail, null)).status).toBe(401);
    expect((await post(ALIAS, mail, "nope")).status).toBe(401);
    h.cleanup();
    h = harness({ CASANOPASA_INBOUND_SECRET: "" });
    expect((await post(ALIAS, mail, "")).status).toBe(401);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("answers 404 for an unknown or malformed alias and sends nothing", async () => {
    setup();
    expect((await post("f".repeat(32), mail)).status).toBe(404);
    expect((await post("7001", mail)).status).toBe(404);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    setup();
    expect((await post(ALIAS, { nope: 1 })).status).toBe(400);
  });

  it("turns an alert email into cards for the alias's renter", async () => {
    setup();
    const r = await post(ALIAS, mail);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, cards: 1 });
    const sent = h.tg.last("sendMessage")!;
    expect(sent.body.chat_id).toBe(7001);
    expect(String(sent.body.text)).toContain("1,250");
    expect(h.rt.store.events("7001").map((e) => e.kind)).toEqual(["card_shown"]);
  });

  it("falls back to the html body when there is no text", async () => {
    setup();
    const r = await post(ALIAS, { ...mail, text: "", html: "<p>Piso en Gràcia, 75 m2, 3 hab. 1.250 €/mes.</p>" });
    expect(r.status).toBe(200);
    expect(String(h.tg.last("sendMessage")!.body.text)).toContain("1,250");
  });

  it("relays Gmail's forwarding confirmation instead of reading it as a listing", async () => {
    setup();
    const r = await post(ALIAS, { from: `Mail Team <${GMAIL_FORWARDING_SENDER}>`, subject: "Forwarding confirmation", text: "Confirmation code: 123456 <b>click</b>" });
    expect(await r.json()).toEqual({ ok: true, relayed: true });
    const text = String(h.tg.last("sendMessage")!.body.text);
    expect(text).toContain("Confirmation code: 123456");
    expect(text).toContain("&lt;b&gt;"); // escaped, not interpreted
    expect(h.rt.store.usage().listings).toBe(0);
  });

  it("gives the renter an address once with /email, and a new one on request", async () => {
    h = harness();
    h.addRenter(7001);
    await h.say(7001, "/email");
    const addr = /<code>([0-9a-f]{32})@in\.casanopasa\.fabriquefutur\.com<\/code>/.exec(String(h.tg.last("sendMessage")!.body.text));
    expect(addr).not.toBeNull();
    expect(h.rt.store.userForAliasHash(sha256Hex(addr![1]!))).toBe("7001");
    await h.say(7001, "/email");
    expect(h.tg.texts().at(-1)).toMatch(/shown only once/);
    await h.press(7001, "em:new");
    const next = /<code>([0-9a-f]{32})@/.exec(String(h.tg.last("sendMessage")!.body.text))![1]!;
    expect(next).not.toBe(addr![1]);
    expect(h.rt.store.userForAliasHash(sha256Hex(addr![1]!))).toBeUndefined();
  });
});
