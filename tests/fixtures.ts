import type { Filters, Listing, Profile, RawInput } from "../src/core/schema";
import { FiltersSchema, ListingSchema, ProfileSchema } from "../src/core/schema";

/** All text below is invented. Phone numbers are the +34 600 000 000 style. */
export const NOW = "2026-11-11T10:00:00.000Z";

export const text = (t: string, receivedAt = NOW): RawInput => ({ kind: "text", text: t, receivedAt });

export const AD_ES = `Se alquila piso en Gràcia, Barcelona. 75 m², 3 hab., 2 baños, ascensor, amueblado.
Alquiler de larga duración. 1.250 €/mes. Disponible el 1 de diciembre.
Particular a particular, no se admiten mascotas. Llamar al 600 000 001.`;

export function listing(over: Partial<Listing> = {}): Listing {
  return ListingSchema.parse({
    id: "hash:test",
    source: "other",
    city: "Barcelona",
    contract: "long",
    priceEur: 1250,
    areaM2: 75,
    rooms: 3,
    neighbourhood: "Gràcia",
    availableFrom: "2026-12-01",
    description: "Piso en Gràcia, 75 m2, 3 hab.",
    evidence: { priceEur: "1.250 €/mes", neighbourhood: "Gràcia", areaM2: "75 m²", rooms: "3 hab." },
    seenAt: NOW,
    ...over,
  });
}

export function filters(over: Partial<Filters> = {}): Filters {
  return FiltersSchema.parse(over);
}

export function profile(over: Partial<Profile> = {}): Profile {
  return ProfileSchema.parse({
    userId: "u1",
    name: "Ana Prueba",
    occupation: "software engineer",
    contract: "permanent",
    netMonthlyIncomeEur: 2800,
    occupants: 2,
    moveInFrom: "2026-12-01",
    availability: "weekdays after 18:00",
    phone: "+34 600 000 000",
    replyLang: "es",
    ...over,
  });
}
