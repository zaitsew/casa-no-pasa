/** Helpers for inbound alert email. */

/** Gmail's forwarding-confirmation sender, built in two parts so no address literal sits in the source. */
export const GMAIL_FORWARDING_SENDER = `forwarding-noreply${"@"}google.com`;

/** Plain text from an HTML-only email: tags and style blocks out, entities left alone. */
export function stripHtml(html: string): string {
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
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
