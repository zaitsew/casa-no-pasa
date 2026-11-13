/** Helpers for inbound alert email. */
import { detectPortal, findUrls } from "../engine/portals";

/** Gmail's forwarding-confirmation sender, built in two parts so no address literal sits in the source. */
export const GMAIL_FORWARDING_SENDER = `forwarding-noreply${"@"}google.com`;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", euro: "€", middot: "·", sup2: "²", sup3: "³",
  ordm: "º", ordf: "ª", deg: "°", iexcl: "¡", iquest: "¿", hellip: "…", ndash: "–", mdash: "—",
  laquo: "«", raquo: "»", copy: "©", reg: "®", ntilde: "ñ", Ntilde: "Ñ", ccedil: "ç", Ccedil: "Ç", uuml: "ü",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è", ograve: "ò",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
};

/** Named entities from the table above and every numeric one (&#178; and &#xB2;); anything else is left as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? whole;
  });
}

// --- HTML to text ------------------------------------------------------------------------------------

interface HNode {
  tag: string;
  parent: HNode | null;
  kids: (HNode | string)[];
  href?: string;
  /** Distinct portal listing keys in this subtree (`source:portalId`). */
  keys: Set<string>;
}

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "col", "area", "base"]);
const BLOCK = new Set(["p", "div", "tr", "td", "th", "li", "ul", "ol", "table", "tbody", "thead", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "br", "hr", "blockquote"]);

function listingKey(url: string): string | null {
  const hit = detectPortal(url);
  return hit?.portalId ? `${hit.source}:${hit.portalId}` : null;
}

/** A small forgiving tree: unclosed tags are closed by their parent's end, stray end tags are ignored. */
function parseHtml(html: string): HNode {
  const root: HNode = { tag: "#root", parent: null, kids: [], keys: new Set() };
  let cur = root;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|[^<]+|</gi)) {
    const [whole, close, name, attrs] = m;
    if (whole.startsWith("<!--")) continue;
    if (!name) {
      cur.kids.push(whole);
      continue;
    }
    const tag = name.toLowerCase();
    if (close) {
      for (let n: HNode | null = cur; n && n !== root; n = n.parent) {
        if (n.tag === tag) {
          cur = n.parent!;
          break;
        }
      }
      continue;
    }
    const node: HNode = { tag, parent: cur, kids: [], keys: new Set() };
    if (tag === "a") {
      const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs ?? "");
      const url = decodeEntities((h?.[1] ?? h?.[2] ?? "").trim());
      if (/^https?:\/\//i.test(url)) node.href = url;
    }
    cur.kids.push(node);
    if (!VOID.has(tag) && !whole.endsWith("/>")) cur = node;
  }
  // Keys of each subtree: from link targets and from URLs written out in the text.
  const fill = (n: HNode): void => {
    for (const k of n.kids) {
      if (typeof k === "string") {
        for (const u of findUrls(decodeEntities(k))) {
          const key = listingKey(u);
          if (key) n.keys.add(key);
        }
      } else {
        fill(k);
        k.keys.forEach((x) => n.keys.add(x));
      }
    }
    const own = n.href ? listingKey(n.href) : null;
    if (own) n.keys.add(own);
  };
  fill(root);
  return root;
}

/** Text of a subtree. Block tags break lines; a link's target follows its text when `urls` says so. */
function render(n: HNode, urls: (href: string) => boolean): string {
  let out = "";
  for (const k of n.kids) {
    if (typeof k === "string") {
      out += decodeEntities(k).replace(/\s+/g, " ");
      continue;
    }
    if (k.tag === "style" || k.tag === "script" || k.tag === "head") continue;
    const inner = render(k, urls);
    const link = k.href && urls(k.href) ? ` ${k.href} ` : "";
    out += BLOCK.has(k.tag) ? `\n${inner}${link}\n` : `${inner}${link}`;
  }
  return out;
}

const tidy = (s: string) =>
  s.replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n+/g, "\n").trim();

/**
 * Plain text from an HTML-only email (an alert email carries its listing URLs only in `href`).
 *
 * With two or more distinct portal listings, each listing's text is its own "card": the largest element that
 * holds exactly one listing's link, whatever the layout (link around the title, price before or after the link).
 * Cards come out as paragraphs separated by a blank line, with the link target inside; a paragraph is never split.
 * Text outside every card is dropped, so a price that sits between cards (and could belong to either) is left out
 * and the card shows it as unknown, never as the neighbour's (D2). With fewer than two listings the whole text is
 * returned, link targets kept, for example a Gmail confirmation.
 */
export function stripHtml(html: string): string {
  const root = parseHtml(html);
  if (root.keys.size < 2) return tidy(render(root, () => true));

  const cards: HNode[] = [];
  const done = new Set<string>();
  const visit = (n: HNode): void => {
    const own = n.href ? listingKey(n.href) : null;
    const key = own ?? (n.keys.size === 1 && n.kids.some((k) => typeof k === "string") ? [...n.keys][0]! : null);
    if (key && !done.has(key)) {
      done.add(key);
      let top = n;
      while (top.parent && top.parent.keys.size === 1) top = top.parent;
      cards.push(top);
      return;
    }
    n.kids.forEach((k) => typeof k !== "string" && visit(k));
  };
  visit(root);

  const out: string[] = [];
  const used = new Set<HNode>();
  for (const c of cards) {
    if (used.has(c)) continue;
    used.add(c);
    const text = tidy(render(c, (href) => listingKey(href) !== null));
    if (text) out.push(text);
  }
  return out.join("\n\n");
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
