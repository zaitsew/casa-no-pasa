import type { Draft, Filters, FlagCode, Lang, Listing } from "../core/schema";
import type { CardResult } from "../engine";
import { formatEur } from "../engine/templates";
import type { Store } from "../engine/store";
import { strings, type Dict, type UiLang } from "./strings";
import { buttonRows, type Keyboard, type Tg } from "./tg";

/** Telegram's copy button takes at most 256 characters. */
export const COPY_TEXT_MAX = 256;
const MAX_FLAG_LINES = 5;
export const MAX_CARDS = 10;

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram rejects a message over 4096 characters; stay under it with room for the markup. */
export const CARD_MAX = 4000;
const LINE_MAX = 240;

/**
 * Shortens PLAIN text so that its escaped form is at most `max` characters. The cut is made on the
 * plain text, before escaping, so an entity or a tag is never split.
 */
export function clipPlain(plain: string, max: number): string {
  if (esc(plain).length <= max) return plain;
  let out = "";
  let used = 1; // the ellipsis
  for (const ch of plain) {
    const n = esc(ch).length;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return `${out.trimEnd()}…`;
}
const line = (plain: string): string => esc(clipPlain(plain, LINE_MAX));

/** A listing with no facts at all: only a link was shared. */
export function isBare(l: Listing): boolean {
  return !l.description && l.priceEur === undefined && l.rooms === undefined && l.areaM2 === undefined && !l.neighbourhood && !l.title;
}

const VERDICT_EMOJI = { go: "🟢", check: "🟡", skip: "🔴" } as const;
const SEVERITY_EMOJI = { block: "⛔", warn: "⚠️", info: "ℹ️" } as const;
const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;
/** Flags that point at a scam rather than at fit. A blocking one turns the card into "Skip: likely scam". */
export const SCAM_CODES: ReadonlySet<FlagCode> = new Set<FlagCode>([
  "deposit_before_viewing",
  "owner_abroad",
  "off_platform_payment",
  "price_far_below_market",
  "keys_by_post",
  "too_good_description",
]);
const EVIDENCE_MAX = 120;

export interface RenderedCard {
  text: string;
  keyboard: Keyboard;
}

export interface CardOptions {
  /** The renter's filters: they give the reasons a flat fits ("50 € under your budget"). */
  filters?: Filters;
  /** Show the reply even on a likely scam: the renter pressed "Show reply anyway" or a language. */
  forceDraft?: boolean;
}

/** True when a blocking scam flag is present. The flag explains; the card never calls a listing safe (D3). */
export const isLikelyScam = (a: CardResult["assessment"]): boolean => a.flags.some((f) => f.severity === "block" && SCAM_CODES.has(f.code));

/** Reasons the flat fits, computed from the listing and the filters only. Never a safety claim (D3). */
function fitReasons(l: Listing, a: CardResult["assessment"], f: Filters | undefined, S: Dict, eurLang: Lang): string[] {
  if (!f) return [];
  const has = (code: FlagCode) => a.flags.some((x) => x.code === code);
  const out: string[] = [];
  if (f.maxPriceEur !== undefined && l.priceEur !== undefined && l.priceEur <= f.maxPriceEur && !has("over_budget")) {
    const gap = f.maxPriceEur - l.priceEur;
    out.push(gap > 0 ? S.underBudget(formatEur(gap, eurLang)) : S.atBudget);
  }
  if (f.zones.length && l.neighbourhood && !has("outside_zones")) out.push(S.inZones);
  return out;
}

/**
 * The listing card, verdict first: the headline says what to do, the next lines say what the flat is,
 * then why (flags with the ad's own words, fit reasons, what to ask), then the reply. A likely scam holds
 * the reply back until the renter asks for it.
 */
export function renderCard(r: CardResult, key: string, ui: UiLang, draft: Draft | null = r.draft, opts: CardOptions = {}): RenderedCard {
  const S = strings(ui);
  const { listing: l, assessment: a } = r;
  const eurLang: Lang = ui === "es" ? "es" : "en";
  const lines: string[] = [];

  const bare = isBare(l);
  const scam = !bare && isLikelyScam(a);
  const source = S.sources[l.source] ?? l.source;
  if (bare) {
    lines.push(`🔗 <b>${esc(source)}</b>`);
    lines.push(S.bareLink);
  } else {
    lines.push(`${VERDICT_EMOJI[a.verdict]} <b>${esc(scam ? S.scamHeadline : (S.verdict[a.verdict] ?? a.verdict))}</b>`);
    const facts = [
      l.priceEur !== undefined ? `<b>${formatEur(l.priceEur, eurLang)}</b>` : undefined,
      l.rooms !== undefined ? S.rooms(l.rooms) : undefined,
      l.areaM2 !== undefined ? `${l.areaM2} m²` : undefined,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
    lines.push([l.neighbourhood ? esc(clipPlain(l.neighbourhood, 60)) : undefined, esc(source)].filter(Boolean).join(" · "));

    const why: string[] = [];
    const flags = [...a.flags].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]).slice(0, MAX_FLAG_LINES);
    const flagLine = (f: (typeof flags)[number]) => {
      why.push(`${SEVERITY_EMOJI[f.severity]} ${line(S.flags[f.code] ?? f.detail)}`);
      if (f.evidence && SCAM_CODES.has(f.code)) why.push(`<i>«${esc(clipPlain(f.evidence, EVIDENCE_MAX))}»</i>`);
    };
    // Problems first, then why it fits, then notes; a likely scam gets no reasons to like it.
    flags.filter((f) => f.severity !== "info").forEach(flagLine);
    if (!scam) for (const reason of fitReasons(l, a, opts.filters, S, eurLang)) why.push(`✅ ${esc(reason)}`);
    flags.filter((f) => f.severity === "info").forEach(flagLine);
    const unknowns = a.unknowns.filter((u) => !u.startsWith("only a link was shared")).map((u) => S.unknowns[u] ?? u);
    if (unknowns.length && !scam) why.push(`❓ ${line(S.confirmBefore(unknowns.join(", ")))}`);
    if (why.length) lines.push("", ...why);
  }
  const notes: string[] = [];
  if (r.possibleDuplicate) notes.push(`♻️ ${S.possibleDuplicate}`);
  if (r.revision) notes.push(`💶 ${S.priceChanged(formatEur(r.revision.oldPriceEur, eurLang), formatEur(r.revision.newPriceEur, eurLang))}`);
  if (r.enriched) notes.push(`🔄 ${S.updated}`);
  if (notes.length) lines.push("", ...notes);

  const held = scam && !opts.forceDraft && draft !== null;
  if (held) lines.push("", S.draftHeld);
  else if (draft) {
    // The draft gets whatever room the other parts leave; it is shortened as plain text.
    const used = lines.join("\n").length + "\n\n<pre></pre>".length;
    lines.push("", `<pre>${esc(clipPlain(draft.text, Math.max(200, CARD_MAX - used)))}</pre>`);
  } else lines.push("", S.noDraft);

  const kb: Keyboard = [];
  const shown = held ? null : draft;
  const reply = [];
  if (shown?.whatsappUrl) reply.push({ text: S.btnWhatsapp, url: shown.whatsappUrl });
  if (shown && shown.text.length <= COPY_TEXT_MAX) reply.push({ text: S.btnCopy, copy_text: { text: shown.text } });
  kb.push(...buttonRows(reply));
  if (l.url) kb.push([{ text: S.btnOpen, url: l.url }]);
  if (held && draft) kb.push([{ text: S.btnDraftAnyway, callback_data: `l:${draft.lang}:${key}` }]);
  if (shown) kb.push((["es", "ca", "en"] as const).map((lang) => ({ text: S.langNames[lang]!, callback_data: `l:${lang}:${key}` })));
  if (!held) {
    kb.push([
      { text: S.btnSent, callback_data: `s:${key}` },
      { text: S.btnViewing, callback_data: `v:${key}` },
    ]);
  }
  kb.push([{ text: S.btnNotForMe, callback_data: `n:${key}` }]);
  return { text: lines.join("\n"), keyboard: kb };
}

/** Sends one card per result (an exact repeat gets one short line). Shared by the webhook and inbound email. */
export async function sendCards(tg: Tg, store: Store, userId: string, chatId: number, results: CardResult[], ui: UiLang): Promise<void> {
  const S = strings(ui);
  for (const r of results.slice(0, MAX_CARDS)) {
    if (r.duplicate) {
      await tg.sendMessage(chatId, S.alreadySeen);
      continue;
    }
    const key = store.listingKey(userId, r.listing.id);
    const card = renderCard(r, key, ui, r.draft, { filters: store.getFilters(userId) });
    await tg.sendMessage(chatId, card.text, { keyboard: card.keyboard });
  }
  if (results.length > MAX_CARDS) await tg.sendMessage(chatId, S.tooMany(results.length - MAX_CARDS));
}
