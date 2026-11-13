import { createServer as createHttp, type IncomingMessage, type Server as HttpServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { INBOUND_DOMAIN } from "../src/bot/handler";
import {
  aliasFromRecipient, buildPayload, createMxServer, DEFAULT_INBOUND_DOMAIN, formatFrom, mapAppStatus, MAX_PAYLOAD_CHARS, RateLimiter,
  type MxOptions,
} from "../src/mx/server";

const ALIAS = "0123456789abcdef0123456789abcdef";
const DOMAIN = DEFAULT_INBOUND_DOMAIN;
const SECRET = "test-secret";
// Fictional sender and renter addresses only (example.com is reserved for documentation).
const PORTAL = `alerts${"@"}example.com`;

describe("pure functions", () => {
  it("keeps the default domain equal to the one the bot hands out", () => {
    expect(DEFAULT_INBOUND_DOMAIN).toBe(INBOUND_DOMAIN);
  });

  it("accepts only <32 hex>@<domain>, case-insensitively, and returns the lower-case alias", () => {
    expect(aliasFromRecipient(`${ALIAS}@${DOMAIN}`)).toBe(ALIAS);
    expect(aliasFromRecipient(`${ALIAS.toUpperCase()}@${DOMAIN.toUpperCase()}`)).toBe(ALIAS);
    expect(aliasFromRecipient(`${ALIAS}@example.com`)).toBeNull();
    expect(aliasFromRecipient(`${ALIAS}@x.${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`${ALIAS}0@${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`${ALIAS.slice(1)}@${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`${"g".repeat(32)}@${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`postmaster@${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`a${ALIAS}@${DOMAIN}`)).toBeNull();
    expect(aliasFromRecipient(`${ALIAS}@${DOMAIN}`, "other.example.org")).toBeNull();
  });

  it("maps the app's answer to an SMTP reply", () => {
    expect(mapAppStatus(200).code).toBe(250);
    expect(mapAppStatus(204).code).toBe(250);
    expect(mapAppStatus(404).code).toBe(550);
    for (const s of [400, 401, 413]) expect(mapAppStatus(s).code).toBe(554);
    for (const s of [500, 502, 503, 429, null]) expect(mapAppStatus(s).code).toBe(451);
  });

  it("formats the sender as Name <addr> and strips what would break the parser", () => {
    expect(formatFrom("Portal Alerts", PORTAL)).toBe(`Portal Alerts <${PORTAL}>`);
    expect(formatFrom(undefined, PORTAL)).toBe(PORTAL);
    expect(formatFrom('Evil <x> "y"', PORTAL)).toBe(`Evil x y <${PORTAL}>`);
    expect(formatFrom("Only name", undefined)).toBe("Only name");
  });

  it("builds the payload: html only without text, a fitted body, the envelope sender as fallback", () => {
    expect(buildPayload({ from: { name: "N", address: PORTAL }, subject: "S", text: " hi ", html: "<p>hi</p>" })).toEqual({ from: `N <${PORTAL}>`, subject: "S", text: "hi" });
    expect(buildPayload({ subject: "S", html: "<p>hi</p>" }, PORTAL)).toEqual({ from: PORTAL, subject: "S", text: "", html: "<p>hi</p>" });
    const big = buildPayload({ from: { address: PORTAL }, text: '"\n'.repeat(900_000) });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    expect(big.text.length).toBeGreaterThan(1000);
  });

  it("limits connections per client in a sliding window", () => {
    const rl = new RateLimiter(3, 1000);
    expect([0, 10, 20, 30].map((t) => rl.allow("a", t))).toEqual([true, true, true, false]);
    expect(rl.allow("b", 30)).toBe(true);
    expect(rl.allow("a", 1005)).toBe(true);
  });
});

// --- Integration: a real SMTP conversation against a fake app ------------------------------------------

interface Seen {
  url: string;
  secret: string | undefined;
  body: Record<string, unknown>;
}

let http: HttpServer | undefined;
let mx: ReturnType<typeof createMxServer> | undefined;
let tlsDir: string | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (mx ? mx.close(() => r()) : r()));
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  mx = undefined;
  http = undefined;
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
  tlsDir = undefined;
});

async function start(status: number, extra: Partial<MxOptions> = {}) {
  const seen: Seen[] = [];
  const logs: Record<string, string | number>[] = [];
  http = createHttp((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", secret: req.headers["x-casanopasa-inbound"] as string | undefined, body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => http!.listen(0, "127.0.0.1", r));
  const appUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  mx = createMxServer({ appUrl, secret: SECRET, log: (l) => logs.push(l), ...extra });
  await new Promise<void>((r) => mx!.listen(0, "127.0.0.1", r));
  const port = (mx.server.address() as AddressInfo).port;
  const send = (to: string | string[], mail: Record<string, unknown> = {}, tls = false) =>
    nodemailer
      .createTransport({ host: "127.0.0.1", port, secure: false, ...(tls ? { requireTLS: true, tls: { rejectUnauthorized: false } } : { ignoreTLS: true }) })
      .sendMail({ from: `Portal Alerts <${PORTAL}>`, to, subject: "New flats", text: "Piso en Gracia, 1.200 EUR/mes", ...mail });
  return { seen, logs, port, send };
}

/** A bare SMTP client: sends lines, collects replies. */
function raw(port: number) {
  const socket = connect(port, "127.0.0.1");
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (d) => (buf += d));
  socket.on("error", () => undefined);
  const waitFor = async (re: RegExp, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = re.exec(buf);
      if (m) {
        const out = buf;
        buf = "";
        return out;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${re} in ${JSON.stringify(buf.slice(-200))}`);
  };
  return { socket, waitFor, say: (s: string) => socket.write(`${s}\r\n`) };
}

describe("SMTP receiver", () => {
  it("delivers a message to the app with the secret header and answers 250", async () => {
    const { seen, send, logs } = await start(200);
    const info = await send(`${ALIAS}@${DOMAIN}`);
    expect(info.response).toMatch(/^250 /);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`/api/inbound/${ALIAS}`);
    expect(seen[0]!.secret).toBe(SECRET);
    expect(seen[0]!.body).toEqual({ from: `Portal Alerts <${PORTAL}>`, subject: "New flats", text: "Piso en Gracia, 1.200 EUR/mes" });
    // The log carries counts and codes, never an address or a body.
    const logged = JSON.stringify(logs);
    expect(logged).toContain('"app_status":200');
    expect(logged).not.toContain("Piso");
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain(ALIAS);
  });

  it("takes the alias in upper case and passes the lower-case alias on", async () => {
    const { seen, send } = await start(200);
    await send(`${ALIAS.toUpperCase()}@${DOMAIN.toUpperCase()}`);
    expect(seen[0]!.url).toBe(`/api/inbound/${ALIAS}`);
  });

  it("sends html when the message has no plain text part", async () => {
    const { seen, send } = await start(200);
    await send(`${ALIAS}@${DOMAIN}`, { text: undefined, html: '<p>Piso <a href="https://www.idealista.com/inmueble/10000001/">ver</a></p>' });
    const body = seen[0]!.body;
    expect(typeof body.text === "string").toBe(true);
    expect(String(body.text) + String(body.html)).toContain("https://www.idealista.com/inmueble/10000001/");
  });

  it("rejects a recipient that is not an alias at RCPT with 550 and never calls the app", async () => {
    const { seen, send } = await start(200);
    await expect(send(`someone${"@"}example.com`)).rejects.toMatchObject({ responseCode: 550 });
    await expect(send(`postmaster@${DOMAIN}`)).rejects.toMatchObject({ responseCode: 550 });
    await expect(send(`${ALIAS}@x.${DOMAIN}`)).rejects.toMatchObject({ responseCode: 550 });
    expect(seen).toHaveLength(0);
  });

  it("accepts one recipient per message: a second gets 452", async () => {
    const { port } = await start(200);
    const c = raw(port);
    await c.waitFor(/^220 /m);
    c.say("EHLO t.example.org");
    await c.waitFor(/^250 .*$/m);
    c.say(`MAIL FROM:<${PORTAL}>`);
    await c.waitFor(/^250 /m);
    c.say(`RCPT TO:<${ALIAS}@${DOMAIN}>`);
    await c.waitFor(/^250 /m);
    c.say(`RCPT TO:<${"b".repeat(32)}@${DOMAIN}>`);
    expect(await c.waitFor(/^\d{3} /m)).toMatch(/^452 /);
    c.socket.destroy();
  });

  it.each([[404, 550], [401, 554], [400, 554], [413, 554], [500, 451]] as const)("maps the app's HTTP %i to SMTP %i", async (status, code) => {
    const { send } = await start(status);
    await expect(send(`${ALIAS}@${DOMAIN}`)).rejects.toMatchObject({ responseCode: code });
  });

  it("answers 451 when the app is unreachable", async () => {
    const { send } = await start(200, { appUrl: "http://127.0.0.1:1" });
    await expect(send(`${ALIAS}@${DOMAIN}`)).rejects.toMatchObject({ responseCode: 451 });
  });

  it("answers 451 at RCPT when no secret is configured", async () => {
    const { send } = await start(200, { secret: "" });
    await expect(send(`${ALIAS}@${DOMAIN}`)).rejects.toMatchObject({ responseCode: 451 });
  });

  it("refuses an oversized message on the stream even when the client does not declare SIZE", async () => {
    const { seen, port } = await start(200, { maxMessageBytes: 20_000 });
    const c = raw(port);
    await c.waitFor(/^220 /m);
    c.say("EHLO t.example.org");
    const ehlo = await c.waitFor(/^250 [^\r\n]*\r?\n?$/m);
    expect(ehlo).toMatch(/SIZE 20000/);
    expect(ehlo).not.toMatch(/AUTH/);
    expect(ehlo).not.toMatch(/STARTTLS/);
    c.say(`MAIL FROM:<${PORTAL}>`);
    await c.waitFor(/^250 /m);
    c.say(`RCPT TO:<${ALIAS}@${DOMAIN}>`);
    await c.waitFor(/^250 /m);
    c.say("DATA");
    await c.waitFor(/^354 /m);
    c.socket.write("Subject: big\r\n\r\n");
    for (let i = 0; i < 40; i++) c.socket.write(`${"x".repeat(998)}\r\n`);
    c.say(".");
    expect(await c.waitFor(/^\d{3} /m)).toMatch(/^552 /);
    expect(seen).toHaveLength(0);
    c.socket.destroy();
  });

  it("refuses AUTH", async () => {
    const { port } = await start(200);
    const c = raw(port);
    await c.waitFor(/^220 /m);
    c.say("EHLO t.example.org");
    await c.waitFor(/^250 /m);
    c.say("AUTH PLAIN AGZvbwBiYXI=");
    expect(await c.waitFor(/^\d{3} /m)).toMatch(/^5\d\d /);
    c.socket.destroy();
  });

  const hasOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasOpenssl)("offers STARTTLS when a certificate is given and delivers over it", async () => {
    tlsDir = mkdtempSync(join(tmpdir(), "mx-tls-test-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tlsDir, "key.pem"), "-out", join(tlsDir, "cert.pem"), "-days", "1", "-subj", "/CN=casanopasa.example.org"], { stdio: "ignore" });
    const tls = { key: readFileSync(join(tlsDir, "key.pem"), "utf8"), cert: readFileSync(join(tlsDir, "cert.pem"), "utf8") };
    const { seen, send } = await start(200, { tls });
    const info = await send(`${ALIAS}@${DOMAIN}`, {}, true);
    expect(info.response).toMatch(/^250 /);
    expect(seen).toHaveLength(1);
  });
});
