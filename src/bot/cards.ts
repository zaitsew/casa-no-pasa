import type { Draft, Lang, Listing } from "../core/schema";
import type { CardResult } from "../engine";
import { formatEur } from "../engine/templates";
import type { Store } from "../engine/store";
import { strings, type UiLang } from "./strings";
import type { Keyboard, Tg } from "./tg";

/** Telegram's copy button takes at most 256 characters. */
export const COPY_TEXT_MAX = 256;
const MAX_FLAG_LINES = 5;
export const MAX_CARDS = 10;

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A listing with no facts at all: only a link was shared. */
export function isBare(l: Listing): boolean {
  return !l.description && l.priceEur === undefined && l.rooms === undefined && l.areaM2 === undefined && !l.neighbourhood && !l.title;
}

const VERDICT_EMOJI = { go: "🟢", check: "🟡", skip: "🔴" } as const;
const SEVERITY_EMOJI = { block: "⛔", warn: "⚠️", info: "ℹ️" } as const;
const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;

export interface RenderedCard {
  text: string;
  keyboard: Keyboard;
}

export function renderCard(r: CardResult, key: string, ui: UiLang, draft: Draft | null = r.draft): RenderedCard {
  const S = strings(ui);
  const { listing: l, assessment: a } = r;
  const eurLang: Lang = ui === "es" ? "es" : "en";
  const lines: string[] = [];

  const bare = isBare(l);
  const source = S.sources[l.source] ?? l.source;
  if (bare) {
    lines.push(`🔗 <b>${esc(source)}</b>`);
    lines.push(S.bareLink);
  } else {
    const head = [
      `${VERDICT_EMOJI[a.verdict]} <b>${a.fit}</b>/100 ${esc(S.verdict[a.verdict] ?? a.verdict)}`,
      l.priceEur !== undefined ? formatEur(l.priceEur, eurLang) : undefined,
      l.rooms !== undefined ? S.rooms(l.rooms) : undefined,
      l.areaM2 !== undefined ? `${l.areaM2} m²` : undefined,
      l.neighbourhood ? esc(l.neighbourhood) : undefined,
      esc(source),
    ].filter(Boolean);
    lines.push(head.join(" · "));

    const flags = [...a.flags].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]).slice(0, MAX_FLAG_LINES);
    for (const f of flags) lines.push(`${SEVERITY_EMOJI[f.severity]} ${esc(S.flags[f.code] ?? f.detail)}`);
    const unknowns = a.unknowns.filter((u) => !u.startsWith("only a link was shared")).map((u) => S.unknowns[u] ?? u);
    if (unknowns.length) lines.push(`❓ ${esc(S.confirmBefore(unknowns.join(", ")))}`);
  }
  if (r.possibleDuplicate) lines.push(`♻️ ${S.possibleDuplicate}`);
  if (r.revision) lines.push(`💶 ${S.priceChanged(formatEur(r.revision.oldPriceEur, eurLang), formatEur(r.revision.newPriceEur, eurLang))}`);
  if (r.enriched) lines.push(`🔄 ${S.updated}`);

  if (draft) lines.push("", `<pre>${esc(draft.text)}</pre>`);
  else lines.push("", S.noDraft);

  const kb: Keyboard = [];
  const row1 = [];
  if (l.url) row1.push({ text: S.btnOpen, url: l.url });
  if (draft?.whatsappUrl) row1.push({ text: S.btnWhatsapp, url: draft.whatsappUrl });
  if (draft && draft.text.length <= COPY_TEXT_MAX) row1.push({ text: S.btnCopy, copy_text: { text: draft.text } });
  if (row1.length) kb.push(row1);
  if (draft) kb.push((["es", "ca", "en"] as const).map((lang) => ({ text: S.langNames[lang]!, callback_data: `l:${lang}:${key}` })));
  kb.push([
    { text: S.btnSent, callback_data: `s:${key}` },
    { text: S.btnViewing, callback_data: `v:${key}` },
  ]);
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
    const card = renderCard(r, key, ui);
    await tg.sendMessage(chatId, card.text, { keyboard: card.keyboard });
  }
  if (results.length > MAX_CARDS) await tg.sendMessage(chatId, S.tooMany(results.length - MAX_CARDS));
}
