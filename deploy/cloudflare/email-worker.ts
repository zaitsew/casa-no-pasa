/**
 * Cloudflare Email Worker for Casa No Pasa alert emails. Source only: it is not built or deployed by this
 * repo (a later setup step, see README "Alert emails"). It receives mail sent to
 * `<alias>@in.casanopasa.fabriquefutur.com`, parses it and POSTs JSON to the app:
 *
 *   POST {CASANOPASA_URL}/api/inbound/<alias>
 *   x-casanopasa-inbound: {CASANOPASA_INBOUND_SECRET}
 *   {"from": "...", "subject": "...", "text": "...", "html": "..."}
 *
 * Worker settings: variable CASANOPASA_URL, secret CASANOPASA_INBOUND_SECRET, dependency `postal-mime`.
 */
import PostalMime from "postal-mime";

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

interface Env {
  CASANOPASA_URL: string;
  CASANOPASA_INBOUND_SECRET: string;
}

const MAX_RAW_BYTES = 2_000_000;

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) return message.setReject("message too large");
    const alias = message.to.split("@")[0]?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{32}$/.test(alias)) return message.setReject("unknown recipient");

    const parsed = await PostalMime.parse(message.raw);
    const res = await fetch(`${env.CASANOPASA_URL.replace(/\/+$/, "")}/api/inbound/${alias}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-casanopasa-inbound": env.CASANOPASA_INBOUND_SECRET },
      body: JSON.stringify({
        from: parsed.from?.address ? `${parsed.from.name ?? ""} <${parsed.from.address}>`.trim() : message.from,
        subject: parsed.subject ?? "",
        text: parsed.text ?? "",
        ...(parsed.html ? { html: parsed.html } : {}),
      }),
    });
    // An unknown alias (404) or a wrong secret (401) is rejected so the sender's server sees a bounce.
    if (!res.ok) message.setReject(`not accepted (${res.status})`);
  },
};
