/**
 * Inbound-only SMTP receiver for alert emails (see README "Alert emails").
 *
 * Mail for `<32-hex alias>@in.casanopasa.fabriquefutur.com` arrives here, is parsed, and is handed to the app as
 * `POST {CASANOPASA_APP_URL}/api/inbound/<alias>`. This process never sends mail, never relays, never offers AUTH.
 * It keeps nothing: the message lives in memory until the app answers, and nothing about it is logged except
 * counts and status codes (no addresses, no subjects, no bodies, no client IPs).
 *
 * One recipient per message (`maxRecipients: 1`): the extra RCPT gets 452 and the sender retries it in a second
 * transaction. A message to a second renter would be a second delivery, and the app takes one alias per request.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import PostalMime from "postal-mime";

/** Same default as INBOUND_DOMAIN in src/bot/handler.ts (a test keeps them equal); CASANOPASA_INBOUND_DOMAIN overrides. */
export const DEFAULT_INBOUND_DOMAIN = "in.casanopasa.fabriquefutur.com";
export const MAX_MESSAGE_BYTES = 2_000_000;
export const MAX_CLIENTS = 20;
/** Idle time before the connection is dropped. Longer than APP_TIMEOUT_MS: the socket is idle while the app works. */
export const SOCKET_TIMEOUT_MS = 90_000;
/** The app reads the email, calls the hub for each listing and sends the cards; this is the most we wait. */
export const APP_TIMEOUT_MS = 60_000;
export const RATE_LIMIT_PER_MINUTE = 60;
/** The app refuses a JSON body over 1,000,000 characters (413), so the payload is cut to fit under this. */
export const MAX_PAYLOAD_CHARS = 900_000;

export interface Reply {
  code: number;
  message: string;
}

// --- Pure functions ------------------------------------------------------------------------------

/** The alias in a recipient address when it is `<32 hex>@<domain>` (case-insensitive), lower-cased; otherwise null. */
export function aliasFromRecipient(address: string, domain: string = DEFAULT_INBOUND_DOMAIN): string | null {
  const m = /^([0-9a-f]{32})@(.+)$/i.exec(address.trim());
  if (!m || m[2]!.toLowerCase() !== domain.trim().toLowerCase()) return null;
  return m[1]!.toLowerCase();
}

/** What the SMTP client hears for the app's HTTP status; `null` stands for a network error or a timeout. */
export function mapAppStatus(status: number | null): Reply {
  if (status !== null && status >= 200 && status < 300) return { code: 250, message: "2.0.0 Message accepted" };
  if (status === 404) return { code: 550, message: "5.1.1 Unknown recipient" };
  if (status === 401 || status === 413 || status === 400) return { code: 554, message: "5.6.0 Message refused" };
  return { code: 451, message: "4.3.0 Temporary failure, try again later" };
}

/** `Name <addr>`; the name loses characters that would break the address parser on the other side. */
export function formatFrom(name: string | undefined, address: string | undefined): string {
  const addr = (address ?? "").trim();
  const clean = (name ?? "").replace(/[<>"\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (!addr) return clean;
  return clean ? `${clean} <${addr}>` : addr;
}

export interface InboundPayload {
  from: string;
  subject: string;
  text: string;
  html?: string;
}

interface ParsedMail {
  from?: { name?: string; address?: string };
  subject?: string;
  text?: string;
  html?: string;
}

/**
 * The JSON the app expects. `html` is sent only when there is no text (the app reads it only then). The body is
 * cut so the JSON stays under MAX_PAYLOAD_CHARS: a long newsletter is shortened, never refused.
 */
export function buildPayload(mail: ParsedMail, envelopeFrom = ""): InboundPayload {
  const from = formatFrom(mail.from?.name, mail.from?.address || envelopeFrom).slice(0, 500);
  const subject = (mail.subject ?? "").slice(0, 1000);
  const text = (mail.text ?? "").trim();
  const html = mail.html?.trim() ?? "";
  const payload: InboundPayload = { from, subject, text: text ? text : "", ...(!text && html ? { html } : {}) };
  // JSON escapes can double the length of a text full of quotes or line breaks; shrink until it fits.
  let budget = MAX_PAYLOAD_CHARS / 2;
  while (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS && budget > 1000) {
    payload.text = payload.text.slice(0, budget);
    if (payload.html !== undefined) payload.html = payload.html.slice(0, budget);
    budget = Math.floor(budget * 0.8);
  }
  return payload;
}

/** Sliding window of connection times per client key, in memory. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = RATE_LIMIT_PER_MINUTE, private windowMs = 60_000) {}

  /** True when this connection is allowed (and counts it). */
  allow(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(nowMs);
    return true;
  }

  private sweep(nowMs: number): void {
    for (const [k, v] of this.hits) if (!v.some((t) => nowMs - t < this.windowMs)) this.hits.delete(k);
  }
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

// --- Server ----------------------------------------------------------------------------------------

export interface MxOptions {
  /** Base URL of the app, no trailing slash. */
  appUrl: string;
  /** Shared secret for the x-casanopasa-inbound header. Empty: every RCPT gets 451 (the feature is off). */
  secret: string;
  domain?: string;
  /** TLS key and certificate (PEM). Without both, STARTTLS is not offered. */
  tls?: { key: string; cert: string };
  fetch?: typeof fetch;
  log?: (line: Record<string, string | number>) => void;
  now?: () => number;
  maxClients?: number;
  maxMessageBytes?: number;
  ratePerMinute?: number;
  appTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/** Counts and status codes only. */
const defaultLog = (line: Record<string, string | number>) => console.log(JSON.stringify({ svc: "casanopasa-mx", ...line }));

export function createMxServer(opts: MxOptions): SMTPServer {
  const domain = opts.domain ?? DEFAULT_INBOUND_DOMAIN;
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? Date.now;
  const limit = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const limiter = new RateLimiter(opts.ratePerMinute);
  const appUrl = opts.appUrl.replace(/\/+$/, "");

  const server = new SMTPServer({
    name: domain,
    banner: "casanopasa-mx ESMTP",
    // Inbound only: no AUTH is offered or accepted, and no RCPT is accepted for any other domain, so there is no relay.
    authOptional: true,
    disabledCommands: opts.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
    // Opportunistic TLS between mail servers does not validate certificates (RFC 7435), so the self-signed
    // certificate made at container start is enough. Without a certificate STARTTLS is off: smtp-server would
    // otherwise fall back to a built-in certificate whose private key is public.
    ...(opts.tls ? { key: opts.tls.key, cert: opts.tls.cert } : {}),
    size: limit,
    rejectOversized: true,
    maxClients: opts.maxClients ?? MAX_CLIENTS,
    maxRecipients: 1,
    socketTimeout: opts.socketTimeoutMs ?? SOCKET_TIMEOUT_MS,
    closeTimeout: 5_000,
    disableReverseLookup: true,
    logger: false,

    onConnect(session, cb) {
      const ip = session.remoteAddress;
      if (!isLoopback(ip) && !limiter.allow(ip, now())) {
        log({ ev: "rate_limited" });
        return cb(smtpError(421, "4.7.0 Too many connections, try again later"));
      }
      cb();
    },

    onRcptTo(address, _session, cb) {
      if (!opts.secret) return cb(smtpError(451, "4.3.2 Inbound mail is not configured"));
      if (!aliasFromRecipient(address.address, domain)) {
        log({ ev: "rcpt_rejected", code: 550 });
        return cb(smtpError(550, "5.1.1 Unknown recipient"));
      }
      cb();
    },

    onData(stream, session, cb) {
      void receive(stream, session).then(
        (reply) => (reply.code === 250 ? cb(null, reply.message) : cb(smtpError(reply.code, reply.message))),
        () => cb(smtpError(451, "4.3.0 Temporary failure, try again later")),
      );
    },
  });
  server.on("error", () => log({ ev: "server_error" }));

  async function receive(stream: SMTPServerDataStream, session: SMTPServerSession): Promise<Reply> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Stop keeping bytes once over the limit; the stream still has to be read to the end of the DATA.
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      if (bytes <= limit) chunks.push(chunk as Buffer);
    }
    if (stream.sizeExceeded || bytes > limit) {
      log({ ev: "too_large", code: 552, bytes });
      return { code: 552, message: "5.3.4 Message too large" };
    }
    const alias = aliasFromRecipient(session.envelope.rcptTo[0]?.address ?? "", domain);
    if (!alias) return { code: 550, message: "5.1.1 Unknown recipient" };

    let payload: InboundPayload;
    try {
      const mail = await PostalMime.parse(Buffer.concat(chunks), { maxNestingDepth: 30, maxHeadersSize: 256 * 1024 });
      const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
      payload = buildPayload(mail, envelopeFrom);
    } catch {
      log({ ev: "unparsable", code: 554, bytes });
      return { code: 554, message: "5.6.0 Message could not be parsed" };
    }

    let status: number | null = null;
    try {
      const res = await doFetch(`${appUrl}/api/inbound/${alias}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-casanopasa-inbound": opts.secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.appTimeoutMs ?? APP_TIMEOUT_MS),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      status = null;
    }
    const reply = mapAppStatus(status);
    log({ ev: "delivered", app_status: status ?? 0, smtp_code: reply.code, bytes });
    return reply;
  }

  return server;
}

// --- Process entry ---------------------------------------------------------------------------------

function readTls(dir: string): { key: string; cert: string } | undefined {
  try {
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch {
    return undefined;
  }
}

/** Starts the server from the environment. Called by src/mx/main.ts, the bundle's entry. */
export function main(env: NodeJS.ProcessEnv = process.env): SMTPServer {
  const port = Number(env.MX_PORT) || 2525;
  const secret = (env.CASANOPASA_INBOUND_SECRET ?? "").trim();
  const tls = readTls((env.MX_TLS_DIR ?? "/tmp/mx-tls").trim());
  const server = createMxServer({
    appUrl: (env.CASANOPASA_APP_URL ?? "").trim() || "http://casanopasa:3130",
    secret,
    domain: (env.CASANOPASA_INBOUND_DOMAIN ?? "").trim() || DEFAULT_INBOUND_DOMAIN,
    ...(tls ? { tls } : {}),
  });
  server.listen(port, "0.0.0.0", () => defaultLog({ ev: "listening", port, starttls: tls ? 1 : 0, configured: secret ? 1 : 0 }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}
