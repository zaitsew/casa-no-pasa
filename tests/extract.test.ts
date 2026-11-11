import { describe, expect, it } from "vitest";
import { acceptModelFields, extract, findPhones, findPrice, listingId, splitListings } from "../src/engine/extract";
import { AD_ES, NOW, text } from "./fixtures";

const OFF = { env: {} };

describe("deterministic extraction", () => {
  it("reads the facts of a Spanish ad", async () => {
    const [l] = await extract(text(AD_ES), "u1", OFF);
    expect(l).toMatchObject({
      priceEur: 1250, areaM2: 75, rooms: 3, bathrooms: 2, lift: true, furnished: true, petsAllowed: false,
      contract: "long", advertiser: "private", city: "Barcelona", district: "Gràcia", contactPhone: "600 000 001", adLang: "es",
    });
    expect(l!.evidence.priceEur).toBe("1.250 €/mes");
    expect(l!.id.startsWith("hash:")).toBe(true);
  });

  it("detects seasonal and room listings", async () => {
    const [s] = await extract(text("Alquiler de temporada, piso en Eixample, 900 €/mes"), "u1", OFF);
    expect(s!.contract).toBe("seasonal");
    const [r] = await extract(text("Alquilo habitación en Poblenou, 450 € al mes"), "u1", OFF);
    expect(r!.contract).toBe("room");
  });

  it("does not default the city", async () => {
    const [l] = await extract(text("Piso luminoso, 2 hab., 900 €/mes"), "u1", OFF);
    expect(l!.city).toBeUndefined();
  });

  it("uses the portal id as the id and the source from the url", async () => {
    const [l] = await extract(text("https://www.idealista.com/inmueble/12345678/ 800 €/mes"), "u1", OFF);
    expect(l).toMatchObject({ id: "idealista:12345678", source: "idealista", portalId: "12345678", priceEur: 800 });
  });

  it("a bare link gives one sparse listing with no description", async () => {
    const [l] = await extract(text("https://www.instagram.com/stories/inventado/123/"), "u1", OFF);
    expect(l).toMatchObject({ source: "instagram" });
    expect(l!.description).toBeUndefined();
    expect(l!.priceEur).toBeUndefined();
  });

  it("hash ids ignore case, accents and spacing in the description", () => {
    const base = { source: "other" as const, priceEur: 900, areaM2: 50, rooms: 2, neighbourhood: "Gràcia" };
    expect(listingId({ ...base, description: "Piso  LUMINOSO" })).toBe(listingId({ ...base, neighbourhood: "gracia", description: "piso luminoso" }));
  });

  it("price and phone helpers", () => {
    expect(findPrice("Precio 950 euros al mes")?.priceEur).toBe(950);
    expect(findPrice("€1250 / mes, fianza 2 meses")?.priceEur).toBe(1250);
    expect(findPrice("año 2026, 75 m2")).toBeUndefined();
    expect(findPhones("Llama al +34 600 000 002 o al 600000003")).toEqual(["+34 600 000 002", "600000003"]);
  });

  it("splits an alert email into one listing per link", async () => {
    const body = [
      "Nuevos pisos para ti",
      "Piso en Eixample, 1.100 €/mes, 2 hab.\nhttps://www.idealista.com/inmueble/10000001/",
      "Piso en Sants, 950 €/mes, 1 hab.\nhttps://www.idealista.com/inmueble/10000002/",
    ].join("\n\n");
    const listings = await extract({ kind: "email", text: body, subject: "Alerta", receivedAt: NOW }, "u1", OFF);
    expect(listings.map((l) => [l.id, l.priceEur])).toEqual([["idealista:10000001", 1100], ["idealista:10000002", 950]]);
    expect(splitListings("one listing only https://www.idealista.com/inmueble/1/")).toHaveLength(1);
  });
});

describe("model pass", () => {
  const hubAnswer = (args: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "set_listing_fields", arguments: JSON.stringify(args) } }] } }] }), { status: 200 });
  const env = { ACCOUNTS_URL: "https://hub.invalid", ACCOUNTS_SERVICE_CASANOPASA: "tok" };

  it("keeps fields whose evidence is in the text and drops the rest", async () => {
    const body = "Piso en Sarrià con terraza, contacto Marta. 1.500 €/mes";
    let sent: { body: string } | undefined;
    const fetchFn = (async (_u: unknown, init: { body: string }) => {
      sent = init;
      return hubAnswer({
        contactName: "Marta",
        floor: "tercero",
        title: "Piso con terraza",
        evidence: { contactName: "contacto Marta", floor: "tercer piso", title: "Piso en Sarrià con terraza" },
      });
    }) as unknown as typeof fetch;
    const [l] = await extract(text(body), "u1", { env, fetch: fetchFn });
    expect(l!.contactName).toBe("Marta");
    expect(l!.floor).toBeUndefined();
    expect(l!.title).toBe("Piso con terraza");
    expect(JSON.parse(sent!.body).model).toBe("claude-haiku-5-5");
  });

  it("sends an image as an image_url data URL and accepts the screenshot evidence", async () => {
    let payload: any;
    const fetchFn = (async (_u: unknown, init: { body: string }) => {
      payload = JSON.parse(init.body);
      return hubAnswer({ priceEur: 1300, neighbourhood: "Poblenou", evidence: { priceEur: "screenshot", neighbourhood: "screenshot" } });
    }) as unknown as typeof fetch;
    const [l] = await extract({ kind: "image", text: "", imageBase64: "AAAA", imageMime: "image/png", receivedAt: NOW }, "u1", { env, fetch: fetchFn });
    expect(l).toMatchObject({ priceEur: 1300, neighbourhood: "Poblenou" });
    expect(l!.evidence.priceEur).toBe("screenshot");
    const parts = payload.messages[1].content;
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("falls back to the deterministic result on a hub failure", async () => {
    const fetchFn = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const [l] = await extract(text(AD_ES), "u1", { env, fetch: fetchFn });
    expect(l!.priceEur).toBe(1250);
  });

  it("does not call the hub when the kill switch is off", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return hubAnswer({ evidence: {} }); }) as unknown as typeof fetch;
    await extract(text(AD_ES), "u1", { env: { ...env, CASANOPASA_AI: "off" }, fetch: fetchFn });
    expect(calls).toBe(0);
  });

  it("rejects evidence that is not a substring (text input)", () => {
    expect(acceptModelFields({ priceEur: 900, evidence: { priceEur: "900 euros" } }, "alquiler 1000 euros", false)!.fields).toEqual({});
    expect(acceptModelFields({ priceEur: 900, evidence: { priceEur: "screenshot" } }, "alquiler 900", false)!.fields).toEqual({});
    expect(acceptModelFields({ priceEur: "x" }, "t", false)).toBeNull();
  });
});

describe("review fixes", () => {
  const hubAnswer = (args: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "set_listing_fields", arguments: JSON.stringify(args) } }] } }] }), { status: 200 });
  const env = { ACCOUNTS_URL: "https://hub.invalid", ACCOUNTS_SERVICE_CASANOPASA: "tok" };
  const image = { kind: "image" as const, text: "", imageBase64: "AAAA", imageMime: "image/png" as const, receivedAt: NOW };

  it("image evidence is accepted as the model quoted it, capped at 200 characters", () => {
    const long = "x".repeat(500);
    const r = acceptModelFields({ priceEur: 1300, rooms: 2, evidence: { priceEur: "1.300 €/mes", rooms: long } }, "", true)!;
    expect(r.fields).toMatchObject({ priceEur: 1300, rooms: 2 });
    expect(r.evidence.priceEur).toBe("1.300 €/mes");
    expect(r.evidence.rooms).toHaveLength(200);
    expect(acceptModelFields({ priceEur: 1300, evidence: { priceEur: "1.300 €/mes" } }, "", false)!.fields).toEqual({});
  });

  it("screenshot text reaches the description, but never replaces an ad text", async () => {
    const fetchFn = (async () => hubAnswer({ priceEur: 1300, ocrText: "Alquiler de temporada, 1.300 €/mes", evidence: { priceEur: "1.300 €/mes" } })) as unknown as typeof fetch;
    const [l] = await extract(image, "u1", { env, fetch: fetchFn });
    expect(l!.description).toBe("Alquiler de temporada, 1.300 €/mes");
    const textFetch = (async () => hubAnswer({ ocrText: "ignored", evidence: {} })) as unknown as typeof fetch;
    const [t] = await extract(text("Piso en Gràcia, 900 €/mes"), "u1", { env, fetch: textFetch });
    expect(t!.description).toBe("Piso en Gràcia, 900 €/mes");
    expect(acceptModelFields({ ocrText: "z".repeat(5000), evidence: {} }, "", true)!.ocrText).toHaveLength(3000);
  });

  it("reads thousands separators and decimals", () => {
    const cases: Array<[string, number]> = [
      ["1,250 EUR/month", 1250], ["1.250 €", 1250], ["1 250 €/mes", 1250], ["€1,250.00 / month", 1250], ["1.250,00 euros al mes", 1250],
      ["Precio 950,00 €", 950], ["1,250 euros", 1250], ["1250 € al mes", 1250], ["€ 12.500", 12500],
    ];
    for (const [t, n] of cases) expect(findPrice(t)?.priceEur, t).toBe(n);
    expect(findPrice("1,250 EUR/month")?.evidence).toBe("1,250 EUR/month");
    expect(findPrice("1250 euros al mes")?.priceEur).toBe(1250);
    expect(findPrice("rent 1,250 EUR al mes")?.priceEur).toBe(1250);
  });

  it("splits two listings separated by single newlines", () => {
    const body = "Piso en Eixample, 1.100 €/mes\nhttps://www.idealista.com/inmueble/10000001/\nPiso en Sants, 950 €/mes\nhttps://www.idealista.com/inmueble/10000002/\n\nDarse de baja";
    const blocks = splitListings(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("1.100");
    expect(blocks[0]).not.toContain("10000002");
    expect(blocks[1]).toContain("950");
    expect(blocks[1]).not.toContain("Darse de baja");
    expect(splitListings("Piso 900 €/mes\nhttps://www.idealista.com/inmueble/1/\nhttps://www.idealista.com/inmueble/1/")).toHaveLength(1);
  });
});
