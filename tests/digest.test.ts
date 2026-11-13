import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/inbound/[alias]/route";
import { extract } from "../src/engine/extract";
import { sha256Hex } from "../src/server/auth";
import { stripHtml } from "../src/server/inbound";
import { NOW } from "./fixtures";
import { harness, INBOUND_SECRET, type Harness } from "./helpers/bot";

// An invented, Idealista-style saved-search alert: one email, three flats. Tracking parameters on the links,
// header and footer lines, no real listing or phone number.
const DIGEST_TEXT = `Tus alertas de Idealista

3 nuevos anuncios para tu búsqueda "Alquiler en Barcelona, hasta 1.800 €"

Piso en Carrer de Mallorca, Eixample
1.450 €/mes
3 hab. 85 m²
Ver anuncio: https://www.idealista.com/inmueble/100000001/?xtmc=alert&xtcr=1

Ático en Carrer de Verdi, Vila de Gràcia
1.790 €/mes
2 hab. 70 m²
Ver anuncio: https://www.idealista.com/inmueble/100000002/?xtmc=alert&xtcr=2

Piso en Carrer de Sants, Sants
990 €/mes
1 hab. 45 m²
Ver anuncio: https://www.idealista.com/inmueble/100000003/?xtmc=alert&xtcr=3

Gestiona tus alertas: https://www.idealista.com/mis-alertas
Darte de baja: https://www.idealista.com/baja-alertas?id=abc
`;

const DIGEST_HTML = `<html><head><style>.x{color:red}</style></head><body>
<p>Tus alertas de Idealista</p>
<div><a href="https://www.idealista.com/inmueble/100000001/?xtmc=alert&amp;xtcr=1">Piso en Carrer de Mallorca, Eixample</a><br>1.450 &euro;/mes<br>3 hab. 85 m&sup2;</div>
<div><a href="https://www.idealista.com/inmueble/100000002/?xtmc=alert&amp;xtcr=2">Ático en Carrer de Verdi, Vila de Gràcia</a><br>1.790 &euro;/mes<br>2 hab. 70 m&sup2;</div>
</body></html>`;

const OFF = { env: {} };
const ALIAS = "0123456789abcdef0123456789abcdef";

describe("alert email with several listings", () => {
  it("yields one listing per URL with its own price, rooms and area", async () => {
    const listings = await extract({ kind: "email", text: DIGEST_TEXT, subject: "3 nuevos anuncios", from: `Idealista <alerts${"@"}example.com>`, receivedAt: NOW }, "u1", OFF);
    expect(listings.map((l) => [l.id, l.priceEur, l.rooms, l.areaM2])).toEqual([
      ["idealista:100000001", 1450, 3, 85],
      ["idealista:100000002", 1790, 2, 70],
      ["idealista:100000003", 990, 1, 45],
    ]);
    // The facts have evidence; the footer links (alerts page, unsubscribe) made no listing.
    expect(listings[0]!.evidence.priceEur).toContain("1.450");
    expect(listings.every((l) => l.source === "idealista")).toBe(true);
  });

  it("sends one card per listing through the inbound endpoint, and a repeat creates no new card", async () => {
    let h: Harness | undefined = harness();
    try {
      h.addRenter(7001);
      h.rt.store.setInboundAlias("7001", sha256Hex(ALIAS));
      const post = () =>
        POST(new Request(`https://x.test/api/inbound/${ALIAS}`, { method: "POST", headers: { "content-type": "application/json", "x-casanopasa-inbound": INBOUND_SECRET }, body: JSON.stringify({ from: `Idealista <alerts${"@"}example.com>`, subject: "3 nuevos anuncios", text: DIGEST_TEXT }) }), { params: Promise.resolve({ alias: ALIAS }) });
      const r = await post();
      expect(await r.json()).toEqual({ ok: true, cards: 3 });
      const cards = h.tg.texts();
      expect(cards).toHaveLength(3);
      expect(cards[0]).toContain("1,450");
      expect(cards[1]).toContain("1,790");
      expect(cards[2]).toContain("990");
      expect(h.rt.store.usage().listings).toBe(3);

      h.tg.clear();
      expect(await (await post()).json()).toEqual({ ok: true, cards: 0 });
      expect(h.tg.texts().every((t) => !t.includes("1,450"))).toBe(true);
    } finally {
      h?.cleanup();
      h = undefined;
    }
  });

  it("reads an HTML-only digest: link targets kept, entities decoded", async () => {
    const plain = stripHtml(DIGEST_HTML);
    expect(plain).toContain("https://www.idealista.com/inmueble/100000001/?xtmc=alert&xtcr=1");
    expect(plain).toContain("1.450 €/mes");
    expect(plain).not.toContain("color:red");
    expect(stripHtml('<a href="mailto:x@example.com">mail</a> &lt;b&gt; &#65;')).toBe("mail <b> A");
  });

  it("caps the cards of one email at 10", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `Piso en Eixample\n${1000 + i * 10} €/mes\n2 hab. 60 m²\nhttps://www.idealista.com/inmueble/2000000${String(i).padStart(2, "0")}/`).join("\n\n");
    const listings = await extract({ kind: "email", text: many, subject: "Alertas", receivedAt: NOW }, "u1", OFF);
    expect(listings).toHaveLength(10);
    expect(listings[9]!.priceEur).toBe(1090);
  });
});
