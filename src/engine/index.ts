import { RawInputSchema, type Assessment, type Draft, type Engine, type Filters, type Lang, type Listing, type Profile, type RawInput } from "../core/schema";
import type { AiOptions } from "./ai";
import { assess } from "./assess";
import { draft } from "./draft";
import { extract } from "./extract";
import { openStore, type Store } from "./store";

export * from "./ai";
export * from "./assess";
export * from "./draft";
export * from "./extract";
export * from "./portals";
export * from "./store";

export interface CardResult {
  listing: Listing;
  assessment: Assessment;
  /** Null when the renter has no profile yet. */
  draft: Draft | null;
  /** Same portal id and same price seen before, with nothing the stored listing lacked: nothing new to show. */
  duplicate: boolean;
  /** Same portal id seen again with facts the stored listing lacked (a bare link, then the ad). `listing` is the merged one; show a full card. */
  enriched?: true;
  /** No portal id and the same facts as an earlier listing. Still assessed, drafted and shown. */
  possibleDuplicate: boolean;
  /** Same portal id, different price. */
  revision?: { oldPriceEur: number; newPriceEur: number };
  /** Seconds from receivedAt to the card. */
  secondsToCard: number;
}

export interface EngineOptions extends AiOptions {
  store?: Store;
  now?: () => Date;
}

export interface CasaEngine extends Engine {
  store: Store;
  /** `opts.dossierUrl` is put in the draft when set; without it nothing changes. */
  handleInput(userId: string, raw: RawInput, opts?: { dossierUrl?: string }): Promise<CardResult[]>;
}

export function createEngine(opts: EngineOptions = {}): CasaEngine {
  const store = opts.store ?? openStore();
  const now = opts.now ?? (() => new Date());
  const ai: AiOptions = { env: opts.env, fetch: opts.fetch, timeoutMs: opts.timeoutMs };

  return {
    store,
    extract: (input, userId) => extract(input, userId, ai),
    assess: (listing: Listing, filters: Filters) => assess(listing, filters),
    draft: (listing: Listing, profile: Profile, o?: { lang?: Lang; dossierUrl?: string }) => draft(listing, profile, { ...ai, ...o }),

    async handleInput(userId, rawInput, o) {
      const raw = RawInputSchema.parse(rawInput);
      store.upsertUser(userId);
      const listings = await extract(raw, userId, ai);
      const filters = store.getFilters(userId);
      const profile = store.getProfile(userId);
      const out: CardResult[] = [];
      for (const listing of listings) {
        const saved = store.saveListing(userId, listing);
        const shown = saved.status === "enriched" ? saved.listing : listing;
        const duplicate = saved.status === "duplicate";
        const assessment = assess(shown, filters);
        const reply = profile ? await draft(shown, profile, { ...ai, ...(o?.dossierUrl ? { dossierUrl: o.dossierUrl } : {}) }) : null;
        const at = now();
        if (!duplicate) store.recordEvent(userId, listing.id, "card_shown", at.toISOString(), raw.receivedAt);
        out.push({
          listing: shown,
          assessment,
          draft: reply,
          duplicate,
          ...(saved.status === "enriched" ? { enriched: true as const } : {}),
          possibleDuplicate: saved.status === "possible_duplicate",
          ...(saved.status === "revision" ? { revision: { oldPriceEur: saved.oldPriceEur, newPriceEur: saved.newPriceEur } } : {}),
          secondsToCard: Math.max(0, (at.getTime() - Date.parse(raw.receivedAt)) / 1000),
        });
      }
      return out;
    },
  };
}
