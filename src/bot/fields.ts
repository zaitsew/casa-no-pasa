import { FiltersSchema, ProfileSchema, type Filters, type Profile } from "../core/schema";
import type { Store } from "../engine/store";
import type { Dict } from "./strings";

/**
 * The questions the bot asks, in order: profile first, then filters. Each field knows how to read an answer
 * (text or a button value) and how to write it with the engine store. Answers are checked against the
 * schema caps, so a too-long answer gets a short reply instead of an exception.
 */

export type FieldKey =
  | "name" | "occupation" | "contract" | "income" | "occupants" | "pets" | "moveIn" | "availability" | "pitch" | "phone" | "lang"
  | "maxPrice" | "minRooms" | "zones" | "needPets" | "longOnly";

export type ErrorKey = "badNumber" | "badDate" | "badPhone" | "tooLong";
export type PromptKey = "qName" | "qOccupation" | "qContract" | "qIncome" | "qOccupants" | "qPets" | "qMoveIn" | "qAvailability" | "qPitch" | "qPhone" | "qLang" | "fMaxPrice" | "fMinRooms" | "fZones" | "fPets" | "fLong";

export interface Field {
  key: FieldKey;
  section: "profile" | "filters";
  /** text: free answer; choice: buttons only. */
  input: "text" | "choice";
  choices?: Array<{ value: string; label: (S: Dict) => string }>;
  prompt: PromptKey;
  skippable: boolean;
}

const LANG_CHOICES = (["es", "ca", "en"] as const).map((v) => ({ value: v, label: (S: Dict) => S.langNames[v]! }));
const CONTRACT_CHOICES = (["permanent", "temporary", "self-employed", "student", "other"] as const).map((v) => ({ value: v, label: (S: Dict) => S.contractLabels[v]! }));
const YES_NO = [
  { value: "1", label: (S: Dict) => S.yes },
  { value: "0", label: (S: Dict) => S.no },
];

export const FIELDS: Field[] = [
  { key: "name", section: "profile", input: "text", prompt: "qName", skippable: false },
  { key: "occupation", section: "profile", input: "text", prompt: "qOccupation", skippable: true },
  { key: "contract", section: "profile", input: "choice", choices: CONTRACT_CHOICES, prompt: "qContract", skippable: true },
  { key: "income", section: "profile", input: "text", prompt: "qIncome", skippable: true },
  { key: "occupants", section: "profile", input: "text", prompt: "qOccupants", skippable: true },
  { key: "pets", section: "profile", input: "text", prompt: "qPets", skippable: true },
  { key: "moveIn", section: "profile", input: "text", prompt: "qMoveIn", skippable: true },
  { key: "availability", section: "profile", input: "text", prompt: "qAvailability", skippable: true },
  { key: "pitch", section: "profile", input: "text", prompt: "qPitch", skippable: true },
  { key: "phone", section: "profile", input: "text", prompt: "qPhone", skippable: true },
  { key: "lang", section: "profile", input: "choice", choices: LANG_CHOICES, prompt: "qLang", skippable: true },
  { key: "maxPrice", section: "filters", input: "text", prompt: "fMaxPrice", skippable: true },
  { key: "minRooms", section: "filters", input: "text", prompt: "fMinRooms", skippable: true },
  { key: "zones", section: "filters", input: "text", prompt: "fZones", skippable: true },
  { key: "needPets", section: "filters", input: "choice", choices: YES_NO, prompt: "fPets", skippable: true },
  { key: "longOnly", section: "filters", input: "choice", choices: YES_NO, prompt: "fLong", skippable: true },
];

export const fieldByKey = (key: string): Field | undefined => FIELDS.find((f) => f.key === key);
export const nextField = (key: FieldKey): Field | undefined => FIELDS[FIELDS.findIndex((f) => f.key === key) + 1];

// --- Parsing -----------------------------------------------------------------------------------

export function parseInteger(text: string, min: number, max: number): number | undefined {
  let t = text.replace(/[€\s]/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, "");
  if (!/^\d+([.,]\d+)?$/.test(t)) return undefined;
  const n = Math.round(parseFloat(t.replace(",", ".")));
  return n >= min && n <= max ? n : undefined;
}

export function parseDate(text: string): string | undefined {
  const t = text.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])] as [number, number, number];
  else if ((r = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])] as [number, number, number];
  else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

const NONE_WORDS = /^(no|none|nope|nada|ninguna?|nein|нет|-)$/i;

// --- Applying ----------------------------------------------------------------------------------

export type ApplyResult = { ok: true } | { ok: false; error: ErrorKey };

/** Writes one answer. `value` undefined means skipped (the field is cleared, except the name). */
export function applyAnswer(store: Store, userId: string, field: Field, value: string | undefined): ApplyResult {
  const text = value?.trim();
  const empty = text === undefined || text === "";
  if (field.section === "profile") return applyProfile(store, userId, field.key, empty ? undefined : text);
  return applyFilter(store, userId, field.key, empty ? undefined : text);
}

function saveProfile(store: Store, userId: string, patch: Partial<Profile>, clear: Array<keyof Profile> = []): ApplyResult {
  const base = store.getProfile(userId);
  const merged: Record<string, unknown> = { ...(base ?? { userId, occupants: 1 }), ...patch, userId };
  for (const k of clear) delete merged[k];
  const parsed = ProfileSchema.safeParse(merged);
  if (!parsed.success) return { ok: false, error: "tooLong" };
  store.setProfile(parsed.data);
  return { ok: true };
}

function applyProfile(store: Store, userId: string, key: FieldKey, v: string | undefined): ApplyResult {
  switch (key) {
    case "name":
      return v === undefined ? { ok: false, error: "tooLong" } : saveProfile(store, userId, { name: v });
    case "occupation": return v === undefined ? saveProfile(store, userId, {}, ["occupation"]) : saveProfile(store, userId, { occupation: v });
    case "contract": return v === undefined ? saveProfile(store, userId, {}, ["contract"]) : saveProfile(store, userId, { contract: v as Profile["contract"] });
    case "income": {
      if (v === undefined) return saveProfile(store, userId, {}, ["netMonthlyIncomeEur"]);
      const n = parseInteger(v, 1, 1_000_000);
      return n === undefined ? { ok: false, error: "badNumber" } : saveProfile(store, userId, { netMonthlyIncomeEur: n });
    }
    case "occupants": {
      if (v === undefined) return saveProfile(store, userId, { occupants: 1 });
      const n = parseInteger(v, 1, 20);
      return n === undefined ? { ok: false, error: "badNumber" } : saveProfile(store, userId, { occupants: n });
    }
    case "pets": return v === undefined || NONE_WORDS.test(v) ? saveProfile(store, userId, {}, ["pets"]) : saveProfile(store, userId, { pets: v });
    case "moveIn": {
      if (v === undefined) return saveProfile(store, userId, {}, ["moveInFrom"]);
      const d = parseDate(v);
      return d === undefined ? { ok: false, error: "badDate" } : saveProfile(store, userId, { moveInFrom: d });
    }
    case "availability": return v === undefined ? saveProfile(store, userId, {}, ["availability"]) : saveProfile(store, userId, { availability: v });
    case "pitch": return v === undefined ? saveProfile(store, userId, {}, ["pitch"]) : saveProfile(store, userId, { pitch: v.replace(/\s*\n+\s*/g, " ") });
    case "phone": {
      if (v === undefined) return saveProfile(store, userId, {}, ["phone"]);
      if (!/^[+\d][\d\s().\-]*$/.test(v) || v.replace(/\D/g, "").length < 6) return { ok: false, error: "badPhone" };
      return saveProfile(store, userId, { phone: v });
    }
    case "lang": return saveProfile(store, userId, { replyLang: (v ?? "es") as Profile["replyLang"] });
    default: return { ok: false, error: "tooLong" };
  }
}

function applyFilter(store: Store, userId: string, key: FieldKey, v: string | undefined): ApplyResult {
  const cur: Record<string, unknown> = { ...store.getFilters(userId) };
  switch (key) {
    case "maxPrice": {
      if (v === undefined) delete cur.maxPriceEur;
      else {
        const n = parseInteger(v, 1, 100_000);
        if (n === undefined) return { ok: false, error: "badNumber" };
        cur.maxPriceEur = n;
      }
      break;
    }
    case "minRooms": {
      if (v === undefined) delete cur.minRooms;
      else {
        const n = parseInteger(v, 0, 20);
        if (n === undefined) return { ok: false, error: "badNumber" };
        cur.minRooms = n;
      }
      break;
    }
    case "zones": {
      const zones = (v ?? "").split(",").map((z) => z.trim()).filter(Boolean);
      if (zones.length > 20 || zones.some((z) => z.length > 60)) return { ok: false, error: "tooLong" };
      cur.zones = zones;
      break;
    }
    case "needPets": cur.needPets = v === "1"; break;
    case "longOnly": cur.longTermOnly = v === undefined ? true : v === "1"; break;
    default: return { ok: false, error: "tooLong" };
  }
  store.setFilters(userId, FiltersSchema.parse(cur));
  return { ok: true };
}

// --- Display -----------------------------------------------------------------------------------

export function showValue(S: Dict, key: FieldKey, p: Profile | undefined, f: Filters, fmtEur: (n: number) => string): string {
  const v = (x: string | number | undefined): string => (x === undefined || x === "" ? S.notSet : String(x));
  switch (key) {
    case "name": return v(p?.name);
    case "occupation": return v(p?.occupation);
    case "contract": return p?.contract ? (S.contractLabels[p.contract] ?? p.contract) : S.notSet;
    case "income": return p?.netMonthlyIncomeEur !== undefined ? fmtEur(p.netMonthlyIncomeEur) : S.notSet;
    case "occupants": return v(p?.occupants);
    case "pets": return v(p?.pets);
    case "moveIn": return v(p?.moveInFrom);
    case "availability": return v(p?.availability);
    case "pitch": return v(p?.pitch);
    case "phone": return v(p?.phone);
    case "lang": return S.langNames[p?.replyLang ?? "es"] ?? "es";
    case "maxPrice": return f.maxPriceEur !== undefined ? fmtEur(f.maxPriceEur) : S.notSet;
    case "minRooms": return v(f.minRooms);
    case "zones": return f.zones.length ? f.zones.join(", ") : S.notSet;
    case "needPets": return f.needPets ? S.yes : S.no;
    case "longOnly": return f.longTermOnly ? S.yes : S.no;
  }
}
