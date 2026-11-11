import { AssessmentSchema, type Assessment, type Filters, type Flag, type Listing } from "../core/schema";
import { numWord } from "./extract";
import { clip, findFolded, fold } from "./text";

/**
 * Pure, deterministic assessment. Flags explain, never clear (D3). Law notes are "check" notes with
 * links, never a verdict (D4). A mandatory filter whose fact is missing is an unknown, and the verdict is
 * then at best "check": unknown is not a match.
 */

/**
 * Rough guard, not market data: a flat in Barcelona city rented for less than this many euros per m2
 * per month is far below anything the market offers, whatever the neighbourhood. No neighbourhood
 * statistics are invented here; the Sprint 2 price comparison will use Barcelona open data.
 */
export const MIN_EUR_PER_M2_BARCELONA = 10;

export const LINKS = {
  serpavi: { label: "Official Spanish rent index (SERPAVI)", url: "https://serpavi.mivau.gob.es/" },
  gencat: { label: "Generalitat de Catalunya: renting a home", url: "https://habitatge.gencat.cat/ca/ambits/lloguer/" },
};

const SCAM = {
  deposit_before_viewing: [
    /fianza (?:antes|por adelantado|previa)|(?:senal|reserva|fianza|deposito)[^.\n]{0,40}antes de (?:ver|visitar)|antes de (?:ver|visitar)[^.\n]{0,50}(?:fianza|deposito|senal|reserva|transferencia)|pagar? (?:la )?(?:fianza|reserva|senal) (?:sin|antes)|deposit (?:before|prior to) (?:viewing|seeing|a viewing|visit)|(?:pay|send|transfer)[^.\n]{0,30}(?:deposit|reservation)[^.\n]{0,30}(?:before|without) (?:viewing|seeing|visit)|fianca abans de (?:veure|visitar)|abans de veure[^.\n]{0,40}(?:fianca|reserva)/,
  ],
  owner_abroad: [
    /estoy en el extranjero|estoy fuera de espana|estoy fuera del pais|vivo en el extranjero|propietario (?:esta )?en el extranjero|(?:i am|i'm) (?:currently )?(?:abroad|overseas|out of (?:the )?(?:country|spain))|(?:i|we) (?:live|am living) abroad|soc a l'estranger|estic a l'estranger|visc a l'estranger/,
  ],
  off_platform_payment: [
    /western union|moneygram|airbnb|paysafe|gift ?card|tarjeta regalo|bitcoin|criptomonedas?|crypto(?:currency)?|transferencia a (?:una )?cuenta (?:en el )?extranjer/,
  ],
  keys_by_post: [
    /te envio las llaves|te enviare las llaves|enviar(?:e|te|le)? las llaves|llaves por (?:correo|mensajeria|paquete|courier)|(?:send|post|ship)(?:ing)? (?:you )?the keys|keys (?:by|via) (?:post|courier|mail)|t'envio les claus|claus per (?:correu|missatgeria)/,
  ],
} as const;

const HYPE: RegExp[] = [/sin fianza/, /sin aval/, /sin nomina/, /sin papeles/, /sin contrato/, /todo incluido/, /gastos incluidos/, /chollo/, /oportunidad unica/, /sense fianca/, /no deposit/, /no paperwork/, /no contract/];

const SEASONAL_STRONG = /alquiler de temporada|lloguer de temporada|seasonal (?:rental|let|contract)|contrato de temporada|por meses|11 meses|once meses|temporada|short[- ]term (?:rental|let)|corta estancia/;
const SEASONAL_STUDENTS = /(?:solo|exclusivamente|unicamente|ideal(?: para)?|para) estudiantes|students only|only students|ideal for students|nomes estudiants|per a estudiants/;
const MIN_MONTHS = /minimo (?:de )?(\d{1,2}) meses|(\d{1,2}) meses (?:de )?(?:minimo|como minimo)|minimum (?:of )?(\d{1,2}) months|minim (?:de )?(\d{1,2}) mesos/;

const AGENCY_FEE = /honorarios|comision de (?:la )?agencia|comision de (?:la )?inmobiliaria|gastos de agencia|agency fees?|agency commission|honoraris|comissio d'agencia/g;
const NEGATION_BEFORE = /(?:sin|no|0|cero|without|no hay|sense)\s*$/;

const MONTH_WORD = "(\\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|one|two|three|four|five|six|quatre|cinc|sis)";
const FIANZA_MONTHS = [
  new RegExp(`${MONTH_WORD}\\s+mes(?:es)?\\s+de\\s+fianza`),
  new RegExp(`fianza\\s*(?:de|:)?\\s*${MONTH_WORD}\\s+mes`),
  new RegExp(`${MONTH_WORD}\\s+months?(?:'s)?\\s+(?:of\\s+)?(?:security\\s+)?deposit`),
  new RegExp(`(?:security\\s+)?deposit\\s*(?:of|:)?\\s*${MONTH_WORD}\\s+months?`),
  new RegExp(`${MONTH_WORD}\\s+mesos?\\s+de\\s+fianca`),
];
const GUARANTEE_MONTHS = [
  new RegExp(`${MONTH_WORD}\\s+mes(?:es)?\\s+(?:de\\s+)?(?:garantia|aval|deposito adicional|garantia adicional)`),
  new RegExp(`(?:garantia|aval)(?: adicional)?\\s*(?:de|:)?\\s*${MONTH_WORD}\\s+mes`),
  new RegExp(`${MONTH_WORD}\\s+months?(?:'s)?\\s+(?:of\\s+)?(?:additional\\s+)?guarantee`),
];

function maxMonths(text: string, res: RegExp[]): { months: number; evidence: string } | undefined {
  let best: { months: number; evidence: string } | undefined;
  for (const re of res) {
    const m = re.exec(text);
    if (!m) continue;
    const n = numWord(m[1] ?? "");
    if (n !== undefined && (!best || n > best.months)) best = { months: n, evidence: m[0] };
  }
  return best;
}

function norm(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, " ").trim();
}

export function zoneMatches(listing: Pick<Listing, "neighbourhood" | "district" | "address">, zones: string[]): boolean | undefined {
  const known = [listing.neighbourhood, listing.district, listing.address].filter((v): v is string => !!v).map(norm);
  if (known.length === 0) return undefined;
  return zones.some((z) => {
    const nz = norm(z);
    return nz.length > 0 && known.some((k) => k.includes(nz) || nz.includes(k));
  });
}

export function isBarcelona(listing: Pick<Listing, "city">): boolean | undefined {
  if (!listing.city) return undefined;
  return norm(listing.city) === "barcelona";
}

/** Fit 0-100, verdict, flags (with evidence), unknowns and official links. Same input, same output. */
export function assess(listing: Listing, filters: Filters): Assessment {
  const text = [listing.title, listing.description].filter(Boolean).join("\n");
  const flags: Flag[] = [];
  const unknowns: string[] = [];
  const links: Assessment["links"] = [];
  const add = (f: Flag) => flags.push(f.evidence ? { ...f, evidence: clip(f.evidence, 160) } : f);
  const ev = (re: RegExp | readonly RegExp[]) => {
    for (const r of Array.isArray(re) ? re : [re as RegExp]) {
      const e = findFolded(text, r);
      if (e) return e;
    }
    return undefined;
  };

  // --- Scam signals -------------------------------------------------------------------------
  const dep = ev(SCAM.deposit_before_viewing);
  if (dep) add({ code: "deposit_before_viewing", severity: "block", detail: "The ad asks for a deposit or reservation before you can see the flat.", evidence: dep });
  const abroad = ev(SCAM.owner_abroad);
  if (abroad) add({ code: "owner_abroad", severity: "warn", detail: "The advertiser says they are abroad, which is common in rental scams: do not pay until you have seen the flat and met the landlord or an agent.", evidence: abroad });
  const offPlatform = ev(SCAM.off_platform_payment);
  if (offPlatform) add({ code: "off_platform_payment", severity: "block", detail: "The ad mentions a payment route (money transfer service, Airbnb, gift cards or crypto) that is not a normal rental payment.", evidence: offPlatform });
  const keys = ev(SCAM.keys_by_post);
  if (keys) add({ code: "keys_by_post", severity: "block", detail: "The advertiser offers to send the keys instead of a viewing.", evidence: keys });

  const hype = HYPE.map((r) => findFolded(text, r)).filter((e): e is string => !!e);
  if (hype.length >= 2) add({ code: "too_good_description", severity: "warn", detail: "The ad promises unusually easy terms (no deposit, no paperwork, everything included); check what is really asked.", evidence: hype.join(" / ") });

  const barcelona = isBarcelona(listing);
  const rentable = listing.contract !== "seasonal" && listing.contract !== "room";
  if (listing.priceEur && listing.areaM2 && barcelona === true && rentable) {
    const perM2 = listing.priceEur / listing.areaM2;
    if (perM2 < MIN_EUR_PER_M2_BARCELONA) {
      add({ code: "price_far_below_market", severity: "warn", detail: `The rent is about ${perM2.toFixed(1)} EUR per m2, far below what flats in Barcelona city normally cost: check carefully before paying anything.`, evidence: listing.evidence.priceEur });
    }
  }

  // --- Contract -----------------------------------------------------------------------------
  const strong = ev(SEASONAL_STRONG);
  const minM = MIN_MONTHS.exec(fold(text));
  const minMonths = minM ? Number(minM[1] ?? minM[2] ?? minM[3] ?? minM[4]) : undefined;
  const short = minMonths !== undefined && minMonths < 12 ? minM![0] : undefined;
  const students = ev(SEASONAL_STUDENTS);
  if (listing.contract === "seasonal" || strong || short) {
    add({
      code: "seasonal_contract",
      severity: filters.longTermOnly ? "block" : "warn",
      detail: "The ad points to a seasonal or short contract, not a long-term home rental (LAU art. 2 housing lease).",
      evidence: strong ?? short ?? listing.evidence.contract,
    });
  } else if (students) {
    add({ code: "seasonal_contract", severity: "warn", detail: "The ad targets students, which often means a seasonal contract: check the contract type and length.", evidence: students });
  }
  if (listing.contract === "room") {
    add({ code: "room_not_flat", severity: "warn", detail: "This is a room in a shared home, not a whole flat.", evidence: listing.evidence.contract });
  }

  // --- Fit to filters -----------------------------------------------------------------------
  if (filters.maxPriceEur !== undefined) {
    if (listing.priceEur === undefined) unknowns.push("price not stated");
    else if (listing.priceEur > filters.maxPriceEur) {
      add({
        code: "over_budget",
        severity: listing.priceEur > filters.maxPriceEur * 1.1 ? "block" : "warn",
        detail: `The rent is ${listing.priceEur} EUR a month, above your limit of ${filters.maxPriceEur} EUR.`,
        evidence: listing.evidence.priceEur,
      });
    }
  }
  if (filters.minRooms !== undefined) {
    if (listing.rooms === undefined) unknowns.push("number of bedrooms not stated");
    else if (listing.rooms < filters.minRooms) add({ code: "too_few_rooms", severity: "warn", detail: `The flat has ${listing.rooms} bedroom(s); you asked for at least ${filters.minRooms}.`, evidence: listing.evidence.rooms });
  }
  if (filters.minAreaM2 !== undefined) {
    if (listing.areaM2 === undefined) unknowns.push("area not stated");
    else if (listing.areaM2 < filters.minAreaM2) add({ code: "too_small", severity: "warn", detail: `The flat is ${listing.areaM2} m2; you asked for at least ${filters.minAreaM2} m2.`, evidence: listing.evidence.areaM2 });
  }
  if (filters.zones.length > 0) {
    const match = zoneMatches(listing, filters.zones);
    if (match === undefined) unknowns.push("neighbourhood not stated");
    else if (!match) add({ code: "outside_zones", severity: "warn", detail: `The flat is in ${listing.neighbourhood ?? listing.district ?? "an area"} which is not in your chosen zones.`, evidence: listing.evidence.neighbourhood ?? listing.evidence.district });
  }
  if (filters.needPets) {
    if (listing.petsAllowed === undefined) unknowns.push("pets policy not stated");
    else if (!listing.petsAllowed) add({ code: "no_pets", severity: "block", detail: "The ad says pets are not allowed and you need to bring one.", evidence: listing.evidence.petsAllowed });
  }
  if (filters.needFurnished !== undefined) {
    if (listing.furnished === undefined) unknowns.push("furnished or unfurnished not stated");
    else if (filters.needFurnished && !listing.furnished) add({ code: "not_furnished", severity: "block", detail: "The flat is unfurnished and you want it furnished.", evidence: listing.evidence.furnished });
  }
  if (filters.needLift) {
    if (listing.lift === undefined) unknowns.push("lift not stated");
    else if (!listing.lift) add({ code: "no_lift", severity: "warn", detail: "The flat has no lift and you need one.", evidence: listing.evidence.lift });
  }
  if (filters.longTermOnly && listing.contract === "unknown" && !flags.some((f) => f.code === "seasonal_contract")) {
    unknowns.push("contract type not stated (long-term or seasonal)");
  } else if (listing.contract === "unknown" && !filters.longTermOnly) {
    unknowns.push("contract type not stated");
  }

  // --- Law notes (D4) ---------------------------------------------------------------------
  if (rentable) {
    if (barcelona === true) {
      add({
        code: "stressed_zone_cap_check",
        severity: "info",
        detail: "Barcelona is a stressed rental zone: check the rent against the official rent index before you agree, because the legal cap depends on facts an ad rarely states (previous rent, landlord type).",
      });
      links.push(LINKS.serpavi, LINKS.gencat);
    } else if (barcelona === undefined) {
      add({
        code: "stressed_zone_cap_check",
        severity: "info",
        detail: "The ad does not name the municipality: whether a rent cap applies depends on the municipality, so check it on the official rent index.",
      });
      links.push(LINKS.serpavi, LINKS.gencat);
    }
  }
  const fee = (() => {
    const folded = fold(text);
    for (const m of folded.matchAll(AGENCY_FEE)) {
      if (!NEGATION_BEFORE.test(folded.slice(Math.max(0, m.index - 14), m.index))) return text.slice(m.index, m.index + m[0].length + 30);
    }
    return undefined;
  })();
  if (fee) {
    add({ code: "agency_fee_charged", severity: "warn", detail: "The ad appears to ask the tenant for agency fees; since Ley 12/2023 these fall on the landlord, so check before you pay.", evidence: fee });
  }
  const fianza = maxMonths(fold(text), FIANZA_MONTHS);
  const extra = maxMonths(fold(text), GUARANTEE_MONTHS);
  if (fianza || extra) {
    const total = (fianza?.months ?? (extra ? 1 : 0)) + (extra?.months ?? 0);
    if (total > 3) {
      add({
        code: "deposit_over_legal",
        severity: "warn",
        detail: `The ad asks for ${total} months of deposit and guarantee together; LAU art. 36 allows one month of fianza plus up to two months of additional guarantee, so check.`,
        evidence: [fianza?.evidence, extra?.evidence].filter(Boolean).join(" + "),
      });
    }
  }

  // --- Unknowns that are not filters --------------------------------------------------------
  if (!listing.description && listing.priceEur === undefined && listing.rooms === undefined && listing.areaM2 === undefined) {
    unknowns.push("only a link was shared: send a screenshot or paste the ad text so the facts can be read");
  }
  if (listing.priceEur === undefined && !unknowns.includes("price not stated")) unknowns.push("price not stated");
  if (!listing.availableFrom) unknowns.push("available date not stated");

  // --- Score --------------------------------------------------------------------------------
  let fit = 100;
  for (const f of flags) fit -= f.severity === "block" ? 40 : f.severity === "warn" ? 15 : 0;
  fit -= Math.min(unknowns.length, 5) * 3;
  fit = Math.max(0, Math.min(100, fit));

  const hasBlock = flags.some((f) => f.severity === "block");
  const hasWarn = flags.some((f) => f.severity === "warn");
  const mandatoryUnknown = unknowns.some((u) => !u.startsWith("available date"));
  const verdict = hasBlock || fit < 30 ? "skip" : hasWarn || mandatoryUnknown || fit < 70 ? "check" : "go";

  return AssessmentSchema.parse({ listingId: listing.id, fit, verdict, flags, unknowns, links });
}
