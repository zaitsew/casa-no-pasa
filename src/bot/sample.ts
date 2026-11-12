import { ListingSchema, type Filters, type Profile } from "../core/schema";
import { assess } from "../engine/assess";
import { templateDraft } from "../engine/draft";
import { renderCard } from "./cards";
import { strings, type UiLang } from "./strings";

/**
 * The example card shown right after the privacy notice. The flat is invented (no real address, phone or
 * portal id). It goes through the real assessment and the template draft: no model call, nothing stored,
 * no listing key, no buttons.
 */
const SAMPLE_AT = "2026-01-01T00:00:00.000Z";

export function sampleListing() {
  return ListingSchema.parse({
    id: "example:none",
    source: "other",
    city: "Barcelona",
    neighbourhood: "Gràcia",
    priceEur: 1450,
    areaM2: 62,
    rooms: 2,
    contract: "long",
    description: "Example flat in Gràcia, 62 m², 2 bedrooms. Long-term rental. Reserva con una señal de 500 € antes de ver el piso.",
    evidence: {},
    seenAt: SAMPLE_AT,
  });
}

/** The card text only: a header line, the card, and no keyboard. */
export function sampleCardText(profile: Profile, filters: Filters, ui: UiLang): string {
  const S = strings(ui);
  const listing = sampleListing();
  const draft = { listingId: listing.id, lang: profile.replyLang, text: templateDraft(listing, profile, profile.replyLang), origin: "template" as const };
  const card = renderCard(
    { listing, assessment: assess(listing, filters), draft, duplicate: false, possibleDuplicate: false, secondsToCard: 0 },
    "example",
    ui,
    draft,
  );
  return `${S.sampleHeader}\n\n${card.text}`;
}
