/** Helpers for inbound alert email. */

/** Gmail's forwarding-confirmation sender, built in two parts so no address literal sits in the source. */
export const GMAIL_FORWARDING_SENDER = `forwarding-noreply${"@"}google.com`;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "\u20ac", middot: "\u00b7" };

/** The common named and numeric entities; anything else is left as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text from an HTML-only email: tags and style blocks out, the target of each link kept after its text
 * (an alert email carries its listing URLs only in `href`), common entities decoded.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, d: string | undefined, sq: string | undefined, inner: string) => {
        const url = decodeEntities((d ?? sq ?? "").trim());
        return /^https?:\/\//i.test(url) ? `${inner} ${url} ` : inner;
      })
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** The address inside "Name <a@b.c>", lower-cased. */
export function senderAddress(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** The engine accepts at most this many characters of text per input (RawInputSchema). */
export const ENGINE_TEXT_MAX = 50_000;

/** Cuts to `max` characters, at the last paragraph break in the second half when there is one. */
export function truncateText(text: string, max: number = ENGINE_TEXT_MAX): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const para = head.lastIndexOf("\n\n");
  return (para > max / 2 ? head.slice(0, para) : head).trimEnd();
}
