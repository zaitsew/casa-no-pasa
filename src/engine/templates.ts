import type { Lang } from "../core/schema";

/**
 * Reply strings in Spanish, Catalan and English. This file is the only place with es/ca reply copy.
 * Every sentence is optional: draft.ts includes one only when its fact is set.
 */

export interface Strings {
  greeting: (contactName?: string) => string;
  interest: (what: string) => string;
  /** "the flat in Gràcia (1.250 EUR/month)" style phrase pieces. */
  flatWord: string;
  inPlace: (place: string) => string;
  withPrice: (price: string) => string;
  withArea: (m2: number) => string;
  withRooms: (n: number) => string;
  who: (name: string, occupation?: string, contract?: string) => string;
  contractWord: Record<"permanent" | "temporary" | "self-employed" | "student", string>;
  income: (eur: string) => string;
  occupants: (n: number, note?: string) => string;
  pets: (pets: string) => string;
  moveIn: (when: string) => string;
  stay: (months: number) => string;
  availability: (when: string) => string;
  dossier: (url: string) => string;
  phone: (phone: string) => string;
  closing: (name: string) => string;
  /** Used when the listing has no facts at all (a bare link). */
  generic: string;
}

export const STRINGS: Record<Lang, Strings> = {
  es: {
    greeting: (n) => (n ? `Hola ${n}:` : "Hola:"),
    interest: (what) => `Me interesa mucho ${what}.`,
    flatWord: "el piso",
    inPlace: (p) => ` de ${p}`,
    withPrice: (p) => ` (${p} al mes)`,
    withArea: (m) => ` de ${m} m²`,
    withRooms: (n) => ` con ${n} hab.`,
    who: (name, occ, c) => `Soy ${name}${occ ? `, ${occ}` : ""}${c ? `, ${c}` : ""}.`,
    contractWord: { permanent: "contrato indefinido", temporary: "contrato temporal", "self-employed": "autónomo/a", student: "estudiante" },
    income: (e) => `Mis ingresos netos son de ${e} € al mes.`,
    occupants: (n, note) => (n === 1 ? "Viviría yo solo/a" : `Seríamos ${n} personas`) + (note ? ` (${note}).` : "."),
    pets: (p) => `Mascotas: ${p}.`,
    moveIn: (w) => `Podría entrar a vivir a partir del ${w}.`,
    stay: (m) => `Busco quedarme al menos ${m} meses.`,
    availability: (w) => `Puedo visitarlo ${w}.`,
    dossier: (u) => `Aquí tiene mi dossier con la documentación: ${u}`,
    phone: (p) => `Mi teléfono: ${p}.`,
    closing: (n) => `Un saludo,\n${n}`,
    generic: "Me interesa su anuncio de alquiler. ¿Sigue disponible? Me gustaría concertar una visita lo antes posible.",
  },
  ca: {
    greeting: (n) => (n ? `Hola ${n}:` : "Hola:"),
    interest: (what) => `M'interessa molt ${what}.`,
    flatWord: "el pis",
    inPlace: (p) => ` de ${p}`,
    withPrice: (p) => ` (${p} al mes)`,
    withArea: (m) => ` de ${m} m²`,
    withRooms: (n) => ` amb ${n} hab.`,
    who: (name, occ, c) => `Sóc ${name}${occ ? `, ${occ}` : ""}${c ? `, ${c}` : ""}.`,
    contractWord: { permanent: "contracte indefinit", temporary: "contracte temporal", "self-employed": "autònom/a", student: "estudiant" },
    income: (e) => `Els meus ingressos nets són de ${e} € al mes.`,
    occupants: (n, note) => (n === 1 ? "Viuria jo sol/a" : `Serem ${n} persones`) + (note ? ` (${note}).` : "."),
    pets: (p) => `Mascotes: ${p}.`,
    moveIn: (w) => `Podria entrar a viure a partir del ${w}.`,
    stay: (m) => `Busco quedar-me almenys ${m} mesos.`,
    availability: (w) => `Puc visitar-lo ${w}.`,
    dossier: (u) => `Aquí té el meu dossier amb la documentació: ${u}`,
    phone: (p) => `El meu telèfon: ${p}.`,
    closing: (n) => `Una salutació,\n${n}`,
    generic: "M'interessa el vostre anunci de lloguer. Encara està disponible? M'agradaria concertar una visita com abans millor.",
  },
  en: {
    greeting: (n) => (n ? `Hello ${n},` : "Hello,"),
    interest: (what) => `I am very interested in ${what}.`,
    flatWord: "the flat",
    inPlace: (p) => ` in ${p}`,
    withPrice: (p) => ` (${p} a month)`,
    withArea: (m) => ` of ${m} m²`,
    withRooms: (n) => ` with ${n} bedroom${n === 1 ? "" : "s"}`,
    who: (name, occ, c) => `I am ${name}${occ ? `, ${occ}` : ""}${c ? `, ${c}` : ""}.`,
    contractWord: { permanent: "permanent contract", temporary: "temporary contract", "self-employed": "self-employed", student: "student" },
    income: (e) => `My net income is ${e} EUR a month.`,
    occupants: (n, note) => (n === 1 ? "It would be just me" : `There would be ${n} of us`) + (note ? ` (${note}).` : "."),
    pets: (p) => `Pets: ${p}.`,
    moveIn: (w) => `I could move in from ${w}.`,
    stay: (m) => `I am looking to stay at least ${m} months.`,
    availability: (w) => `I can view it ${w}.`,
    dossier: (u) => `My tenant file with the documents is here: ${u}`,
    phone: (p) => `My phone: ${p}.`,
    closing: (n) => `Kind regards,\n${n}`,
    generic: "I am interested in your rental listing. Is it still available? I would like to arrange a viewing as soon as possible.",
  },
};

/** Number with a thousands separator in the reader's convention. */
export function formatEur(n: number, lang: Lang): string {
  const s = String(Math.round(n));
  if (s.length < 4) return `${s} €`;
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, lang === "en" ? "," : ".");
  return `${grouped} €`;
}
