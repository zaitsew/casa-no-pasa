import { describe, expect, it } from "vitest";
import { assess, MIN_EUR_PER_M2_BARCELONA } from "../src/engine/assess";
import { filters, listing } from "./fixtures";

const codes = (l: ReturnType<typeof listing>, f = filters()) => assess(l, f).flags.map((x) => x.code);
const desc = (description: string, over = {}) => listing({ description, ...over });

describe("scam flags", () => {
  it("deposit before viewing", () => {
    expect(codes(desc("Para reservar, fianza antes de ver el piso."))).toContain("deposit_before_viewing");
    expect(codes(desc("Send the deposit before viewing please."))).toContain("deposit_before_viewing");
  });
  it("owner abroad", () => {
    expect(codes(desc("Estoy en el extranjero por trabajo."))).toContain("owner_abroad");
    expect(codes(desc("I am currently abroad."))).toContain("owner_abroad");
  });
  it("off-platform payment", () => {
    expect(codes(desc("Pago por Western Union."))).toContain("off_platform_payment");
    expect(codes(desc("El pago se hace a través de Airbnb"))).toContain("off_platform_payment");
  });
  it("keys by post", () => {
    expect(codes(desc("Te envío las llaves por mensajería."))).toContain("keys_by_post");
  });
  it("too good description needs two hype phrases", () => {
    expect(codes(desc("Sin fianza y sin nómina, chollo."))).toContain("too_good_description");
    expect(codes(desc("Sin fianza."))).not.toContain("too_good_description");
  });
  it("price far below the per-m2 floor, only with a confirmed city", () => {
    const cheap = { priceEur: 400, areaM2: 80 };
    expect(400 / 80).toBeLessThan(MIN_EUR_PER_M2_BARCELONA);
    expect(codes(listing(cheap))).toContain("price_far_below_market");
    expect(codes(listing({ ...cheap, city: undefined }))).not.toContain("price_far_below_market");
    expect(codes(listing({ priceEur: 1250, areaM2: 75 }))).not.toContain("price_far_below_market");
  });
  it("a scam block makes the verdict skip", () => {
    expect(assess(desc("fianza antes de ver"), filters()).verdict).toBe("skip");
  });
});

describe("contract", () => {
  it("seasonal signals block when longTermOnly", () => {
    for (const t of ["Alquiler de temporada", "por meses, 11 meses", "Mínimo 6 meses", "minimum of 3 months"]) {
      const a = assess(desc(t), filters());
      expect(a.flags.find((f) => f.code === "seasonal_contract")?.severity, t).toBe("block");
      expect(a.verdict).toBe("skip");
    }
  });
  it("seasonal is a warning when long-term is not required", () => {
    const a = assess(desc("Alquiler de temporada"), filters({ longTermOnly: false }));
    expect(a.flags.find((f) => f.code === "seasonal_contract")?.severity).toBe("warn");
  });
  it("a minimum of 12 months is not seasonal; students is a warning", () => {
    expect(codes(desc("Mínimo 12 meses"))).not.toContain("seasonal_contract");
    expect(assess(desc("Solo estudiantes"), filters()).flags.find((f) => f.code === "seasonal_contract")?.severity).toBe("warn");
  });
  it("a room is flagged", () => {
    expect(codes(listing({ contract: "room" }))).toContain("room_not_flat");
  });
});

describe("filters", () => {
  it("over budget: warn within 10 percent, block beyond", () => {
    expect(assess(listing(), filters({ maxPriceEur: 1200 })).flags.find((f) => f.code === "over_budget")?.severity).toBe("warn");
    expect(assess(listing(), filters({ maxPriceEur: 1000 })).flags.find((f) => f.code === "over_budget")?.severity).toBe("block");
  });
  it("rooms, size, zones, pets, furnished, lift", () => {
    const l = listing({ rooms: 1, areaM2: 40, petsAllowed: false, furnished: false, lift: false });
    const c = codes(l, filters({ minRooms: 2, minAreaM2: 60, zones: ["Eixample"], needPets: true, needFurnished: true, needLift: true }));
    expect(c).toEqual(expect.arrayContaining(["too_few_rooms", "too_small", "outside_zones", "no_pets", "not_furnished", "no_lift"]));
  });
  it("zones match accent- and case-insensitively", () => {
    expect(codes(listing(), filters({ zones: ["GRACIA"] }))).not.toContain("outside_zones");
  });
  it("a clean match is go", () => {
    const a = assess(listing({ lift: true }), filters({ maxPriceEur: 1500, minRooms: 2, zones: ["Gràcia"], needLift: true }));
    expect(a.flags.filter((f) => f.severity !== "info")).toEqual([]);
    expect(a.verdict).toBe("go");
    expect(a.fit).toBeGreaterThanOrEqual(90);
  });
});

describe("unknown is not a match", () => {
  it("each missing fact behind a mandatory filter goes to unknowns and caps the verdict at check", () => {
    const l = listing({ neighbourhood: undefined, district: undefined, petsAllowed: undefined, lift: undefined, furnished: undefined, priceEur: undefined, contract: "unknown" });
    const a = assess(l, filters({ zones: ["Gràcia"], needPets: true, needLift: true, needFurnished: true, maxPriceEur: 1500 }));
    expect(a.unknowns).toEqual(expect.arrayContaining([
      "neighbourhood not stated", "pets policy not stated", "lift not stated", "furnished or unfurnished not stated", "price not stated",
      "contract type not stated (long-term or seasonal)",
    ]));
    expect(a.verdict).toBe("check");
  });
  it("an unknown contract is at best check", () => {
    expect(assess(listing({ contract: "unknown" }), filters({ maxPriceEur: 2000 })).verdict).toBe("check");
  });
  it("a bare link asks for a screenshot or the ad text", () => {
    const a = assess(listing({ description: undefined, priceEur: undefined, areaM2: undefined, rooms: undefined, city: undefined, neighbourhood: undefined, evidence: {} }), filters());
    expect(a.unknowns.some((u) => u.startsWith("only a link was shared"))).toBe(true);
    expect(a.verdict).toBe("check");
  });
});

describe("law notes (D4)", () => {
  it("Barcelona long-term gets the stressed-zone note and both links", () => {
    const a = assess(listing(), filters());
    const note = a.flags.find((f) => f.code === "stressed_zone_cap_check");
    expect(note?.severity).toBe("info");
    expect(note?.detail).toMatch(/Barcelona is a stressed rental zone/);
    expect(a.links.map((l) => l.url)).toEqual(["https://serpavi.mivau.gob.es/", "https://habitatge.gencat.cat/ca/ambits/lloguer/"]);
  });
  it("an unknown city gets a municipality note, not the Barcelona claim", () => {
    const note = assess(listing({ city: undefined }), filters()).flags.find((f) => f.code === "stressed_zone_cap_check");
    expect(note?.detail).toMatch(/municipality/);
    expect(note?.detail).not.toMatch(/Barcelona/);
  });
  it("another city gets no note", () => {
    expect(codes(listing({ city: "Girona" }))).not.toContain("stressed_zone_cap_check");
  });
  it("seasonal listings get no cap note", () => {
    expect(codes(listing({ contract: "seasonal" }))).not.toContain("stressed_zone_cap_check");
  });
  it("agency fees charged, but not 'sin honorarios'", () => {
    expect(codes(desc("Honorarios de agencia: un mes de renta."))).toContain("agency_fee_charged");
    expect(codes(desc("Comisión de la agencia a cargo del inquilino"))).toContain("agency_fee_charged");
    expect(codes(desc("Sin honorarios para el inquilino."))).not.toContain("agency_fee_charged");
  });
  it("deposit over the legal total", () => {
    expect(codes(desc("Fianza: 2 meses de fianza y 3 meses de garantía adicional."))).toContain("deposit_over_legal");
    expect(codes(desc("1 mes de fianza y 2 meses de garantía"))).not.toContain("deposit_over_legal");
    expect(codes(desc("Fianza de 6 meses"))).toContain("deposit_over_legal");
  });
});

describe("determinism", () => {
  it("returns the same assessment for the same input", () => {
    const l = desc("Estoy en el extranjero. Honorarios de agencia.");
    expect(assess(l, filters())).toEqual(assess(l, filters()));
  });
});
