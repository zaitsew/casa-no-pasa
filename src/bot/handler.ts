import { randomBytes } from "node:crypto";
import type { Lang, RawInput } from "../core/schema";
import type { CasaEngine } from "../engine";
import { UserGoneError } from "../engine/store";
import { formatEur } from "../engine/templates";
import { sha256Hex } from "../server/auth";
import type { FileStore } from "../server/files";
import { activeDossierUrl, createGrant, type Expiry } from "../server/grants";
import { esc, renderCard, sendCards } from "./cards";
import { sampleCardText } from "./sample";
import { applyAnswer, fieldByKey, FIELDS, INCOME_YEARLY_ABOVE, inferContract, nextField, parseInteger, showValue, type Field } from "./fields";
import { pickUiLang, strings, type UiLang } from "./strings";
import { buttonRows, type Keyboard, type Tg } from "./tg";

/**
 * The webhook brain. Identity is `from.id` of the update and nothing else; only private chats are served.
 * Conversation state (which question is open, which documents are ticked) lives in the store, per renter.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOC_MIMES = ["application/pdf", "image/jpeg", "image/png"];
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
const DOC_LABELS = ["id", "contract", "payslip", "bank", "reference", "other"] as const;

export interface BotDeps {
  engine: CasaEngine;
  tg: Tg;
  /** Absent when CASANOPASA_FILES_KEY is not set: documents and dossiers are off. */
  files?: FileStore;
  filesKey?: Buffer;
  publicUrl: string;
  /** False when CASANOPASA_INBOUND_SECRET is not set. */
  inboundEnabled?: boolean;
  inboundDomain?: string;
  now?: () => Date;
}

type Flow =
  | { kind: "field"; key: string; onboarding: boolean; pendingIncome?: number; welcome?: boolean }
  | { kind: "docs"; label?: string }
  | { kind: "dossier"; docIds: string[]; selected: number[] };

interface State {
  ui?: UiLang;
  ack?: { profile?: boolean; docs?: boolean };
  /** True once the renter has had their first real card (and the one follow-up that comes with it). */
  firstCard?: boolean;
  flow?: Flow;
}

interface TgUser { id: number; first_name?: string; language_code?: string }
interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
}
export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
}

export const INBOUND_DOMAIN = "in.casanopasa.fabriquefutur.com";

export function createBot(deps: BotDeps) {
  const { engine, tg } = deps;
  const store = engine.store;
  const now = deps.now ?? (() => new Date());
  const seen: number[] = [];

  const getState = (u: string): State => (store.getState(u) as State | undefined) ?? {};
  const putState = (u: string, s: State) => store.setState(u, s);
  const setFlow = (u: string, flow: Flow | undefined) => {
    const s = getState(u);
    if (flow) s.flow = flow;
    else delete s.flow;
    putState(u, s);
  };
  const fmtEur = (ui: UiLang) => (n: number) => formatEur(n, ui === "es" ? "es" : "en");
  const privacyUrl = () => `${deps.publicUrl.replace(/\/+$/, "")}/privacy`;

  // --- Questions ---------------------------------------------------------------------------------
  async function ask(userId: string, chatId: number, field: Field, ui: UiLang, onboarding: boolean) {
    const S = strings(ui);
    setFlow(userId, { kind: "field", key: field.key, onboarding });
    const kb: Keyboard = [];
    if (field.choices) kb.push(...buttonRows(field.choices.map((c) => ({ text: c.label(S), callback_data: `f:${field.key}:${c.value}` }))));
    if (field.skippable) kb.push([{ text: S.skip, callback_data: `fs:${field.key}` }]);
    await tg.sendMessage(chatId, S[field.prompt], kb.length ? { keyboard: kb } : undefined);
  }

  async function afterAnswer(userId: string, chatId: number, field: Field, ui: UiLang, onboarding: boolean) {
    const S = strings(ui);
    const open = getState(userId).flow;
    if (open?.kind === "field" && open.welcome) {
      setFlow(userId, undefined);
      return sendWelcome(userId, chatId, ui);
    }
    if (onboarding) {
      const next = nextField(field.key);
      if (next) {
        if (next.section === "filters" && field.section === "profile") await tg.sendMessage(chatId, S.fIntro);
        return ask(userId, chatId, next, ui, true);
      }
      setFlow(userId, undefined);
      await tg.sendMessage(chatId, S.onboardingDone);
      // Every answer is one tap from a fix: show the summary with its edit buttons.
      return showSection(userId, chatId, "profile", ui);
    }
    setFlow(userId, undefined);
    await tg.sendMessage(chatId, S.saved);
    return showSection(userId, chatId, field.section, ui);
  }

  async function submitAnswer(userId: string, chatId: number, field: Field, value: string | undefined, ui: UiLang, onboarding: boolean, confirmed = false) {
    const S = strings(ui);
    if (field.key === "income" && value !== undefined && !confirmed) {
      // A figure this high is most likely yearly: ask before saving anything.
      const n = parseInteger(value.trim(), 1, 1_000_000);
      if (n !== undefined && n > INCOME_YEARLY_ABOVE) {
        const fmt = fmtEur(ui);
        setFlow(userId, { kind: "field", key: field.key, onboarding, pendingIncome: n });
        return tg.sendMessage(chatId, S.incomeYearly(fmt(Math.round(n / 12))), {
          keyboard: [[
            { text: S.incomeMonthlyBtn(fmt(Math.round(n / 12))), callback_data: `ic:m:${n}` },
            { text: S.incomeKeepBtn(fmt(n)), callback_data: `ic:k:${n}` },
          ]],
        });
      }
    }
    const r = applyAnswer(store, userId, field, value);
    if (!r.ok) return tg.sendMessage(chatId, S[r.error]);
    // "product manager, permanent contract" already answers the contract question.
    if (field.key === "occupation" && value !== undefined) {
      const contract = inferContract(value);
      const contractField = fieldByKey("contract");
      if (contract && contractField && applyAnswer(store, userId, contractField, contract).ok) {
        return afterAnswer(userId, chatId, contractField, ui, onboarding);
      }
    }
    return afterAnswer(userId, chatId, field, ui, onboarding);
  }

  async function showSection(userId: string, chatId: number, section: "profile" | "filters", ui: UiLang) {
    const S = strings(ui);
    const p = store.getProfile(userId);
    const f = store.getFilters(userId);
    const fields = FIELDS.filter((x) => x.section === section);
    const lines = [`<b>${section === "profile" ? S.profileTitle : S.filtersTitle}</b>`];
    for (const x of fields) lines.push(`${esc(S.fieldLabels[x.key]!)}: ${esc(showValue(S, x.key, p, f, fmtEur(ui)))}`);
    lines.push("", S.editHint);
    const kb: Keyboard = [];
    for (let i = 0; i < fields.length; i += 2) kb.push(fields.slice(i, i + 2).map((x) => ({ text: S.fieldLabels[x.key]!, callback_data: `pe:${x.key}` })));
    await tg.sendMessage(chatId, lines.join("\n"), { keyboard: kb });
  }

  /** No questions before the first value: a name-only profile, one intro line, an example card, then "send me a listing". */
  async function startOnboarding(userId: string, chatId: number, ui: UiLang, firstName?: string) {
    const S = strings(ui);
    const st = getState(userId);
    if (!st.ack?.profile) {
      return tg.sendMessage(chatId, S.privacyNotice(privacyUrl()), { keyboard: [[{ text: S.ok, callback_data: "pn:ok" }]] });
    }
    if (store.getProfile(userId)) return tg.sendMessage(chatId, S.welcomeBack);
    const nameField = FIELDS[0]!;
    const name = firstName?.trim().slice(0, 100);
    if (name && applyAnswer(store, userId, nameField, name).ok) return sendWelcome(userId, chatId, ui);
    // No usable first name from Telegram: this is the only question.
    await ask(userId, chatId, nameField, ui, false);
    const flow = getState(userId).flow;
    if (flow?.kind === "field") setFlow(userId, { ...flow, welcome: true });
  }

  async function sendWelcome(userId: string, chatId: number, ui: UiLang) {
    const S = strings(ui);
    const profile = store.getProfile(userId);
    await tg.sendMessage(chatId, S.welcomeIntro);
    if (profile) await tg.sendMessage(chatId, sampleCardText(profile, store.getFilters(userId), ui));
    await tg.sendMessage(chatId, S.sendListing);
  }

  // --- Documents ---------------------------------------------------------------------------------
  async function showDocs(userId: string, chatId: number, ui: UiLang) {
    const S = strings(ui);
    const st = getState(userId);
    if (!st.ack?.docs) {
      return tg.sendMessage(chatId, S.privacyDocs, { keyboard: [[{ text: S.ok, callback_data: "dp:ok" }]] });
    }
    const docs = store.listDocuments(userId);
    const lines = docs.length ? [`<b>${S.docsList}</b>`, ...docs.map((d) => `• ${esc(S.docsLabels[d.label] ?? d.label)} (${Math.max(1, Math.round(d.size / 1024))} KB)`)] : [S.docsEmpty];
    lines.push("", S.docsPick);
    const kb: Keyboard = [];
    for (let i = 0; i < DOC_LABELS.length; i += 2) kb.push(DOC_LABELS.slice(i, i + 2).map((l) => ({ text: S.docsLabels[l]!, callback_data: `dl:${l}` })));
    for (const d of docs) kb.push([{ text: S.docsDeleteBtn(S.docsLabels[d.label] ?? d.label), callback_data: `dd:${d.id}` }]);
    await tg.sendMessage(chatId, lines.join("\n"), { keyboard: kb });
  }

  async function uploadDocument(userId: string, chatId: number, m: TgMessage, label: string, ui: UiLang) {
    const S = strings(ui);
    const photo = m.photo?.at(-1);
    const fileId = m.document?.file_id ?? photo?.file_id;
    const mime = m.document?.mime_type ?? "image/jpeg";
    const declared = m.document?.file_size ?? photo?.file_size;
    if (!fileId) return;
    if (!DOC_MIMES.includes(mime)) return tg.sendMessage(chatId, S.docsWrongType);
    if (declared !== undefined && declared > MAX_FILE_BYTES) return tg.sendMessage(chatId, S.docsTooBig);
    if (!deps.files) return tg.sendMessage(chatId, S.dossierNoKey);
    let fileName: string | undefined;
    let committed = false;
    try {
      await tg.sendChatAction(chatId);
      const info = await tg.getFile(fileId);
      if (info.size !== undefined && info.size > MAX_FILE_BYTES) return await tg.sendMessage(chatId, S.docsTooBig);
      const bytes = await tg.downloadFile(info.path);
      if (bytes.length > MAX_FILE_BYTES) return await tg.sendMessage(chatId, S.docsTooBig);
      fileName = deps.files.put(bytes);
      store.addDocument({ id: randomBytes(16).toString("hex"), userId, label, mime, size: bytes.length, fileName, createdAt: now().toISOString() });
      committed = true; // from here a row owns the file: a later failure (e.g. sending the reply) must not delete it
      setFlow(userId, { kind: "docs", label });
      await tg.sendMessage(chatId, S.docsSaved(esc(S.docsLabels[label] ?? label)));
    } catch (err) {
      // The file is on disk but no row owns it: never leave an orphan (after /delete, or on any failure).
      if (fileName && !committed) {
        try {
          deps.files?.remove(fileName);
        } catch {
          /* already gone */
        }
      }
      // The renter deleted themselves while the upload was running: say nothing, keep nothing.
      if (err instanceof UserGoneError) return;
      await tg.sendMessage(chatId, S.docsFailed);
    }
  }

  // --- Dossier -----------------------------------------------------------------------------------
  function dossierKeyboard(ui: UiLang, docIds: string[], selected: number[], userId: string): Keyboard {
    const S = strings(ui);
    const kb: Keyboard = docIds.map((id, i) => {
      const d = store.getDocument(userId, id);
      return [{ text: `${selected.includes(i) ? "☑" : "☐"} ${S.docsLabels[d?.label ?? "other"] ?? d?.label ?? ""}`, callback_data: `ds:${i}` }];
    });
    kb.push([
      { text: S.dossierExpiry24, callback_data: "dx:24h" },
      { text: S.dossierExpiry7, callback_data: "dx:7d" },
    ]);
    return kb;
  }

  async function startDossier(userId: string, chatId: number, ui: UiLang) {
    const S = strings(ui);
    if (!store.getProfile(userId)) return tg.sendMessage(chatId, S.dossierNeedProfile);
    if (!deps.filesKey) return tg.sendMessage(chatId, S.dossierNoKey);
    const docIds = store.listDocuments(userId).map((d) => d.id);
    setFlow(userId, { kind: "dossier", docIds, selected: [] });
    await tg.sendMessage(chatId, S.dossierPick, { keyboard: dossierKeyboard(ui, docIds, [], userId) });
  }

  // --- Delete ------------------------------------------------------------------------------------
  function eraseEverything(userId: string) {
    for (const d of store.listDocuments(userId)) {
      try {
        deps.files?.remove(d.fileName);
      } catch {
        /* a missing file is already gone */
      }
    }
    store.deleteUser(userId);
  }

  // --- Listings ----------------------------------------------------------------------------------
  async function buildRaw(m: TgMessage, ui: UiLang, chatId: number): Promise<RawInput | null> {
    const receivedAt = new Date(m.date * 1000).toISOString();
    const text = m.text ?? m.caption ?? "";
    const photo = m.photo?.at(-1);
    const doc = m.document;
    if (photo || (doc && (IMAGE_MIMES as readonly string[]).includes(doc.mime_type ?? ""))) {
      const fileId = (photo ?? doc)!.file_id;
      const mime = (photo ? "image/jpeg" : doc!.mime_type) as (typeof IMAGE_MIMES)[number];
      const declared = (photo ?? doc)!.file_size;
      if (declared !== undefined && declared > MAX_FILE_BYTES) {
        await tg.sendMessage(chatId, strings(ui).docsTooBig);
        return null;
      }
      const info = await tg.getFile(fileId);
      const bytes = await tg.downloadFile(info.path);
      return { kind: "image", text, imageBase64: bytes.toString("base64"), imageMime: mime, receivedAt };
    }
    if (doc) {
      await tg.sendMessage(chatId, strings(ui).pdfNotRead);
      return null;
    }
    if (!text.trim()) return null;
    return { kind: "text", text, receivedAt };
  }

  async function handleListingInput(userId: string, chatId: number, m: TgMessage, ui: UiLang) {
    const S = strings(ui);
    try {
      await tg.sendChatAction(chatId);
      const raw = await buildRaw(m, ui, chatId);
      if (!raw) return;
      const dossierUrl = activeDossierUrl(store, deps.filesKey, deps.publicUrl, userId, now());
      const results = await engine.handleInput(userId, raw, dossierUrl ? { dossierUrl } : undefined);
      if (results.length === 0) return void (await tg.sendMessage(chatId, S.failed));
      await sendCards(tg, store, userId, chatId, results, ui);
      // After the first real card only: offer the questionnaire once.
      const st = getState(userId);
      if (!st.firstCard && results.some((r) => !r.duplicate)) {
        putState(userId, { ...st, firstCard: true });
        await tg.sendMessage(chatId, S.followUp, { keyboard: [[{ text: S.followUpStart, callback_data: "fu:start" }, { text: S.followUpLater, callback_data: "fu:later" }]] });
      }
    } catch (err) {
      if (err instanceof UserGoneError) return;
      await tg.sendMessage(chatId, S.failed).catch(() => undefined);
    }
  }

  // An invite arrives as "/start <code>" from the t.me link, or pasted on its own: Telegram does not
  // resend the link's payload when the chat was already started, so a bare code (or the whole link) counts too.
  function inviteCode(text: string): string | undefined {
    const t = text.trim();
    return (
      /^\/start(?:@\w+)?\s+(\S+)/.exec(t)?.[1] ??
      /^https?:\/\/t\.me\/\w+\?start=([A-Za-z0-9_-]+)$/.exec(t)?.[1] ??
      /^([A-Za-z0-9_-]{16,64})$/.exec(t)?.[1]
    );
  }

  // --- Messages ----------------------------------------------------------------------------------
  async function onMessage(m: TgMessage) {
    if (!m.from || m.chat.type !== "private") return;
    const userId = String(m.from.id);
    const chatId = m.chat.id;
    const ui = pickUiLang(m.from.language_code);
    const S = strings(ui);
    const text = m.text ?? "";

    if (!store.isLinked(userId)) {
      const code = inviteCode(text);
      if (code && store.redeemInvite(sha256Hex(code), userId, now().toISOString())) {
        putState(userId, { ui });
        await tg.sendMessage(chatId, S.linked);
        return startOnboarding(userId, chatId, ui, m.from.first_name);
      }
      return void (await tg.sendMessage(chatId, S.betaOnly));
    }

    const st = getState(userId);
    if (st.ui !== ui) putState(userId, { ...st, ui });

    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
    if (cmd) {
      setFlow(userId, undefined);
      switch (cmd) {
        case "start":
          return store.getProfile(userId) ? void (await tg.sendMessage(chatId, S.welcomeBack)) : startOnboarding(userId, chatId, ui, m.from.first_name);
        case "help": return void (await tg.sendMessage(chatId, S.help));
        case "cancel": return void (await tg.sendMessage(chatId, S.cancelled));
        case "profile": return store.getProfile(userId) ? showSection(userId, chatId, "profile", ui) : startOnboarding(userId, chatId, ui, m.from.first_name);
        case "filters": return showSection(userId, chatId, "filters", ui);
        case "docs": return showDocs(userId, chatId, ui);
        case "dossier": return startDossier(userId, chatId, ui);
        case "revoke": return void (await tg.sendMessage(chatId, S.revoked(store.revokeGrants(userId, now()))));
        case "delete":
          return void (await tg.sendMessage(chatId, S.deleteAsk, { keyboard: [[{ text: S.deleteYes, callback_data: "del:yes" }, { text: S.cancel, callback_data: "del:no" }]] }));
        case "email": return emailCommand(userId, chatId, ui, false);
        default: return void (await tg.sendMessage(chatId, S.unknownCommand));
      }
    }

    const flow = getState(userId).flow;
    if (flow?.kind === "field" && m.text) {
      const field = fieldByKey(flow.key);
      if (field?.input === "text") return submitAnswer(userId, chatId, field, m.text, ui, flow.onboarding);
      if (field) return ask(userId, chatId, field, ui, flow.onboarding);
    }
    if (flow?.kind === "docs" && flow.label && (m.document || m.photo)) return uploadDocument(userId, chatId, m, flow.label, ui);
    return handleListingInput(userId, chatId, m, ui);
  }

  async function emailCommand(userId: string, chatId: number, ui: UiLang, force: boolean) {
    const S = strings(ui);
    if (!deps.inboundEnabled) return void (await tg.sendMessage(chatId, S.emailOff));
    if (!force && store.hasInboundAlias(userId)) {
      return void (await tg.sendMessage(chatId, S.emailExists, { keyboard: [[{ text: S.emailNew, callback_data: "em:new" }]] }));
    }
    const alias = randomBytes(16).toString("hex");
    store.setInboundAlias(userId, sha256Hex(alias));
    await tg.sendMessage(chatId, S.emailMade(`${alias}@${deps.inboundDomain ?? INBOUND_DOMAIN}`));
  }

  // --- Callbacks ---------------------------------------------------------------------------------
  async function onCallback(q: NonNullable<TgUpdate["callback_query"]>) {
    const msg = q.message;
    const ui = pickUiLang(q.from.language_code);
    const S = strings(ui);
    const userId = String(q.from.id);
    if (!msg || msg.chat.type !== "private" || !q.data) return void (await tg.answerCallbackQuery(q.id));
    if (!store.isLinked(userId)) return void (await tg.answerCallbackQuery(q.id, S.betaOnly));
    const chatId = msg.chat.id;
    const [act = "", a = "", b = ""] = q.data.split(":");
    const ack = (text?: string) => tg.answerCallbackQuery(q.id, text);

    // Listing buttons: the key maps to (renter, listing); the pressing user must be that renter.
    if (act === "s" || act === "v" || act === "n" || act === "l") {
      const key = act === "l" ? b : a;
      const hit = store.resolveListingKey(key);
      if (!hit || hit.userId !== userId) return void (await ack(S.expiredButton));
      if (act === "l") {
        const lang = a as Lang;
        const listing = store.getListing(userId, hit.listingId);
        const profile = store.getProfile(userId);
        if (!["es", "ca", "en"].includes(lang) || !listing) return void (await ack(S.expiredButton));
        if (!profile) return void (await ack(S.noProfile));
        await ack();
        const dossierUrl = activeDossierUrl(store, deps.filesKey, deps.publicUrl, userId, now());
        const d = await engine.draft(listing, profile, { lang, ...(dossierUrl ? { dossierUrl } : {}) });
        const card = renderCard(
          { listing, assessment: engine.assess(listing, store.getFilters(userId)), draft: d, duplicate: false, possibleDuplicate: false, secondsToCard: 0 },
          key, ui, d,
        );
        return tg.editMessageText(chatId, msg.message_id, card.text, { keyboard: card.keyboard });
      }
      const kind = act === "s" ? "sent" : act === "v" ? "viewing" : "not_for_me";
      store.recordEvent(userId, hit.listingId, kind, now().toISOString());
      return void (await ack(kind === "sent" ? S.markedSent : kind === "viewing" ? S.markedViewing : S.markedNotForMe));
    }

    switch (act) {
      case "pn": {
        const st = getState(userId);
        putState(userId, { ...st, ack: { ...st.ack, profile: true } });
        await ack();
        return startOnboarding(userId, chatId, ui, q.from.first_name);
      }
      case "fu": {
        await ack();
        if (a === "start" && store.getProfile(userId)) return ask(userId, chatId, FIELDS[1]!, ui, true);
        // "Later": drop the buttons so the offer is not left hanging.
        return tg.editMessageReplyMarkup(chatId, msg.message_id, []).catch(() => undefined);
      }
      case "dp": {
        const st = getState(userId);
        putState(userId, { ...st, ack: { ...st.ack, docs: true } });
        await ack();
        return showDocs(userId, chatId, ui);
      }
      case "f":
      case "fs":
      case "pe": {
        await ack();
        const field = fieldByKey(a);
        if (!field) return;
        if (act === "pe") return ask(userId, chatId, field, ui, false);
        const flow = getState(userId).flow;
        // Only answer the question that is open for this renter.
        if (flow?.kind !== "field" || flow.key !== field.key) return;
        if (act === "f" && !field.choices?.some((c) => c.value === b)) return;
        return submitAnswer(userId, chatId, field, act === "fs" ? undefined : b, ui, flow.onboarding);
      }
      case "ic": {
        await ack();
        const flow = getState(userId).flow;
        const field = fieldByKey("income");
        if (flow?.kind !== "field" || flow.key !== "income" || flow.pendingIncome === undefined || !field || (a !== "m" && a !== "k")) return;
        // The button names the figure it was shown for: an older prompt's button must not save a newer answer.
        if (b !== String(flow.pendingIncome)) return void (await tg.sendMessage(chatId, S.expiredButton));
        const n = flow.pendingIncome;
        return submitAnswer(userId, chatId, field, String(a === "m" ? Math.round(n / 12) : n), ui, flow.onboarding, true);
      }
      case "dl": {
        await ack();
        if (!(DOC_LABELS as readonly string[]).includes(a)) return;
        setFlow(userId, { kind: "docs", label: a });
        return void (await tg.sendMessage(chatId, S.docsSend(esc(S.docsLabels[a]!))));
      }
      case "dd": {
        const doc = store.removeDocument(userId, a);
        if (doc) {
          try { deps.files?.remove(doc.fileName); } catch { /* already gone */ }
        }
        await ack(doc ? S.docsDeleted : S.expiredButton);
        return showDocs(userId, chatId, ui);
      }
      case "ds": {
        const flow = getState(userId).flow;
        if (flow?.kind !== "dossier") return void (await ack(S.expiredButton));
        const i = Number(a);
        if (!Number.isInteger(i) || i < 0 || i >= flow.docIds.length) return void (await ack());
        const selected = flow.selected.includes(i) ? flow.selected.filter((x) => x !== i) : [...flow.selected, i];
        setFlow(userId, { ...flow, selected });
        await ack();
        return tg.editMessageReplyMarkup(chatId, msg.message_id, dossierKeyboard(ui, flow.docIds, selected, userId));
      }
      case "dx": {
        const flow = getState(userId).flow;
        if (flow?.kind !== "dossier" || (a !== "24h" && a !== "7d") || !deps.filesKey) return void (await ack(S.expiredButton));
        await ack();
        // Scope = ticked documents that still belong to this renter.
        const docIds = flow.selected.map((i) => flow.docIds[i]).filter((id): id is string => !!id && !!store.getDocument(userId, id));
        const g = createGrant(store, deps.filesKey, userId, docIds, a as Expiry, now());
        setFlow(userId, undefined);
        const until = g.expiresAt.slice(0, 16).replace("T", " ") + " UTC";
        const url = `${deps.publicUrl.replace(/\/+$/, "")}/d/${g.token}`;
        return void (await tg.sendMessage(chatId, `${docIds.length ? "" : `${S.dossierNoDocs}\n\n`}${S.dossierCreated(url, until)}`, { parse: "none" }));
      }
      case "del": {
        await ack();
        if (a === "yes") {
          eraseEverything(userId);
          return void (await tg.sendMessage(chatId, S.deleted));
        }
        return void (await tg.sendMessage(chatId, S.cancelled));
      }
      case "em":
        await ack();
        return emailCommand(userId, chatId, ui, true);
      default:
        return void (await ack());
    }
  }

  return {
    /** Processes one update. Repeated update ids (Telegram retries) are skipped. */
    async handleUpdate(update: TgUpdate): Promise<void> {
      if (typeof update.update_id === "number") {
        if (seen.includes(update.update_id)) return;
        seen.push(update.update_id);
        if (seen.length > 1000) seen.shift();
      }
      try {
        if (update.callback_query) await onCallback(update.callback_query);
        else if (update.message) await onMessage(update.message);
      } catch (err) {
        if (err instanceof UserGoneError) return; // deleted mid-request: nothing to write, nothing to say
        throw err;
      }
    },
  };
}

export type Bot = ReturnType<typeof createBot>;
