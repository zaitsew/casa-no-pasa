import { z } from "zod";

/**
 * The engine contract. Every surface (Telegram bot, inbound email, web) talks to the engine through these
 * types only. See docs/PLAN.md for the decisions (D1–D6) they encode.
 */

export const SOURCES = ["idealista", "fotocasa", "habitaclia", "pisos", "badi", "instagram", "facebook", "telegram", "whatsapp", "other"] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

export const LANGS = ["es", "ca", "en"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;

/** What the renter handed us: shared text, a link, a screenshot, or a forwarded alert email. */
export const RawInputSchema = z.object({
  kind: z.enum(["text", "image", "email"]),
  /** Text, the email's plain-text body, or a caption. */
  text: z.string().max(50_000).default(""),
  /** Base64 image for screenshots (jpeg/png/webp), at most one per input. */
  imageBase64: z.string().optional(),
  imageMime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  /** Email subject and sender, when kind = email. */
  subject: z.string().optional(),
  from: z.string().optional(),
  receivedAt: z.string().datetime(),
});
export type RawInput = z.infer<typeof RawInputSchema>;

/**
 * One flat. Every field except `id`, `source` and `seenAt` is optional: an Instagram story may give only a
 * price and a neighbourhood. `evidence` keeps the source sentence for each extracted fact (D2).
 */
export const ListingSchema = z.object({
  /** Stable dedupe key: `<source>:<portal id>` when a portal id is known, else `hash:<sha256 of normalised facts>`. */
  id: z.string(),
  source: SourceSchema,
  url: z.string().url().optional(),
  portalId: z.string().optional(),
  title: z.string().optional(),
  priceEur: z.number().int().positive().optional(),
  /** Community fees when stated separately. */
  feesEur: z.number().int().nonnegative().optional(),
  areaM2: z.number().positive().optional(),
  rooms: z.number().int().nonnegative().optional(),
  bathrooms: z.number().int().nonnegative().optional(),
  floor: z.string().optional(),
  neighbourhood: z.string().optional(),
  district: z.string().optional(),
  /** Only when the ad or the model (with evidence) names it. Unknown is not Barcelona. */
  city: z.string().optional(),
  address: z.string().optional(),
  furnished: z.boolean().optional(),
  petsAllowed: z.boolean().optional(),
  lift: z.boolean().optional(),
  availableFrom: z.string().optional(),
  /** "long" = vivienda habitual (LAU art. 2); "seasonal" = temporada; unknown when the ad does not say. */
  contract: z.enum(["long", "seasonal", "room", "unknown"]).default("unknown"),
  advertiser: z.enum(["private", "agency", "unknown"]).default("unknown"),
  contactPhone: z.string().optional(),
  contactName: z.string().optional(),
  description: z.string().max(5000).optional(),
  /** Language the ad is written in, used for the default reply language. */
  adLang: LangSchema.optional(),
  evidence: z.record(z.string(), z.string()).default({}),
  seenAt: z.string().datetime(),
});
export type Listing = z.infer<typeof ListingSchema>;

/** The renter. Only facts the renter typed; nothing inferred. */
export const ProfileSchema = z.object({
  userId: z.string(),
  name: z.string().min(1).max(100),
  /** One line, e.g. "Product manager at a software company, permanent contract". */
  occupation: z.string().max(200).optional(),
  contract: z.enum(["permanent", "temporary", "self-employed", "student", "other"]).optional(),
  netMonthlyIncomeEur: z.number().int().positive().optional(),
  occupants: z.number().int().positive().optional(),
  occupantsNote: z.string().max(200).optional(),
  pets: z.string().max(150).optional(),
  moveInFrom: z.string().max(80).optional(),
  stayMonthsMin: z.number().int().positive().optional(),
  /** Free text the renter wants in every reply, e.g. "non-smoker, quiet, references from my last landlord". */
  pitch: z.string().max(400).optional(),
  /** Viewing availability as the renter would say it, e.g. "weekdays after 18:00, any time Saturday". */
  availability: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  replyLang: LangSchema.default("es"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const FiltersSchema = z.object({
  maxPriceEur: z.number().int().positive().optional(),
  minRooms: z.number().int().nonnegative().optional(),
  minAreaM2: z.number().positive().optional(),
  /** Neighbourhood or district names; empty = any. Matched accent- and case-insensitively. */
  zones: z.array(z.string()).default([]),
  needPets: z.boolean().default(false),
  needFurnished: z.boolean().optional(),
  needLift: z.boolean().default(false),
  longTermOnly: z.boolean().default(true),
});
export type Filters = z.infer<typeof FiltersSchema>;

export const FLAG_CODES = [
  // scam signals
  "deposit_before_viewing",
  "owner_abroad",
  "off_platform_payment",
  "price_far_below_market",
  "keys_by_post",
  "too_good_description",
  // fit
  "seasonal_contract",
  "room_not_flat",
  "over_budget",
  "outside_zones",
  "too_few_rooms",
  "too_small",
  "no_pets",
  "not_furnished",
  "no_lift",
  // law (D4)
  "stressed_zone_cap_check",
  "agency_fee_charged",
  "deposit_over_legal",
] as const;
export const FlagCodeSchema = z.enum(FLAG_CODES);
export type FlagCode = z.infer<typeof FlagCodeSchema>;

export const FlagSchema = z.object({
  code: FlagCodeSchema,
  severity: z.enum(["block", "warn", "info"]),
  /** One sentence for the renter, in English; surfaces translate via their string tables. */
  detail: z.string(),
  /** The ad text that triggered it, when any. */
  evidence: z.string().optional(),
});
export type Flag = z.infer<typeof FlagSchema>;

export const AssessmentSchema = z.object({
  listingId: z.string(),
  /** 0–100: fit to filters minus penalties for flags. Not a safety score (D3). */
  fit: z.number().int().min(0).max(100),
  verdict: z.enum(["go", "check", "skip"]),
  flags: z.array(FlagSchema),
  /** Facts the card should ask the renter to confirm before sending, e.g. "contract type not stated". */
  unknowns: z.array(z.string()),
  /** Official links relevant to this listing (rent index, tenant rights). */
  links: z.array(z.object({ label: z.string(), url: z.string().url() })),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const DraftSchema = z.object({
  listingId: z.string(),
  lang: LangSchema,
  text: z.string().max(1200),
  /** "model" when the hub wrote it and it passed the fact check; "template" otherwise (D2, D6). */
  origin: z.enum(["model", "template"]),
  /** wa.me deep link with the text filled in, when the listing has a phone. */
  whatsappUrl: z.string().url().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

/** Engine entry points. Implementations live in src/engine; surfaces depend on this interface only. */
export interface Engine {
  extract(input: RawInput, userId: string): Promise<Listing[]>;
  assess(listing: Listing, filters: Filters): Assessment;
  draft(listing: Listing, profile: Profile, opts?: { lang?: Lang; dossierUrl?: string }): Promise<Draft>;
}
