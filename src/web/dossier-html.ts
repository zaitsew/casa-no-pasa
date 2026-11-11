import type { Profile } from "../core/schema";
import type { DocumentRow } from "../engine/store";

/**
 * The dossier page, as a plain HTML string: no scripts, no external requests, nothing a landlord's browser
 * could leak the link to. Spanish by default, English with ?lang=en.
 */

export type DossierLang = "es" | "en";

const T = {
  es: {
    title: "Ficha del inquilino",
    sub: "Información que el inquilino comparte contigo",
    occupation: "Ocupación", contract: "Contrato", occupants: "Personas", pets: "Mascotas", moveIn: "Entrada", phone: "Teléfono",
    contracts: { permanent: "Indefinido", temporary: "Temporal", "self-employed": "Autónomo", student: "Estudiante", other: "Otro" } as Record<string, string>,
    docs: "Documentos",
    noDocs: "No se comparten documentos.",
    download: "Descargar",
    expires: "Este enlace caduca el",
    switch: "English",
    goneTitle: "Enlace caducado",
    goneBody: "Este enlace ha caducado o ya no está disponible.",
    docLabels: { id: "NIE / pasaporte", contract: "Contrato de trabajo", payslip: "Nómina", bank: "Extracto bancario", reference: "Referencia", other: "Otro" } as Record<string, string>,
  },
  en: {
    title: "Tenant file",
    sub: "Information the renter shares with you",
    occupation: "Occupation", contract: "Contract", occupants: "People", pets: "Pets", moveIn: "Move-in", phone: "Phone",
    contracts: { permanent: "Permanent", temporary: "Temporary", "self-employed": "Self-employed", student: "Student", other: "Other" } as Record<string, string>,
    docs: "Documents",
    noDocs: "No documents are shared.",
    download: "Download",
    expires: "This link expires on",
    switch: "Español",
    goneTitle: "Link expired",
    goneBody: "This link has expired or is no longer available.",
    docLabels: { id: "NIE / passport", contract: "Employment contract", payslip: "Payslip", bank: "Bank statement", reference: "Reference", other: "Other" } as Record<string, string>,
  },
} as const;

export const pickDossierLang = (v: string | null | undefined): DossierLang => (v === "en" ? "en" : "es");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `:root{color-scheme:light dark;--bg:#f7f6f2;--card:#fff;--text:#1d1b16;--muted:#625e53;--line:#e2dfd4;--accent:#b4411f}
@media (prefers-color-scheme:dark){:root{--bg:#171510;--card:#221f18;--text:#f1eee4;--muted:#b5b0a0;--line:#37332a;--accent:#f08a63}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:1.25rem 1rem 3rem}h1{font-size:1.5rem;margin:.5rem 0 .25rem}h2{font-size:1.05rem;margin:0 0 .5rem}
.sub,.foot{color:var(--muted);font-size:.875rem}.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:1rem 0}
dl{margin:0;display:grid;grid-template-columns:7.5rem 1fr;gap:.4rem .75rem}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:.6rem 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
a{color:var(--accent)}.btn{display:inline-block;padding:.5rem .9rem;border:1px solid var(--accent);border-radius:.5rem;text-decoration:none;font-weight:600;white-space:nowrap}
.pitch{white-space:pre-wrap;overflow-wrap:anywhere}.lang{float:right;font-size:.875rem}`;

function shell(lang: DossierLang, title: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function renderGone(lang: DossierLang): string {
  const t = T[lang];
  return shell(lang, t.goneTitle, `<h1>${t.goneTitle}</h1><p>${t.goneBody}</p>`);
}

export function renderDossier(opts: { lang: DossierLang; token: string; profile: Profile | undefined; documents: DocumentRow[]; expiresAt: string }): string {
  const { lang, token, profile: p, documents } = opts;
  const t = T[lang];
  const other = lang === "es" ? "en" : "es";
  const rows: Array<[string, string]> = [];
  if (p?.occupation) rows.push([t.occupation, p.occupation]);
  if (p?.contract) rows.push([t.contract, t.contracts[p.contract] ?? p.contract]);
  if (p) rows.push([t.occupants, p.occupantsNote ? `${p.occupants} (${p.occupantsNote})` : String(p.occupants)]);
  if (p?.pets) rows.push([t.pets, p.pets]);
  if (p?.moveInFrom) rows.push([t.moveIn, p.moveInFrom]);
  const phone = p?.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a>` : "";
  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + (phone ? `<dt>${t.phone}</dt><dd>${phone}</dd>` : "");
  const docs = documents.length
    ? `<ul>${documents.map((d) => `<li><span>${esc(t.docLabels[d.label] ?? d.label)}</span><a class="btn" href="/d/${encodeURIComponent(token)}/file/${encodeURIComponent(d.id)}">${t.download}</a></li>`).join("")}</ul>`
    : `<p class="sub">${t.noDocs}</p>`;
  const date = opts.expiresAt.slice(0, 10);
  const body = `<a class="lang" href="?lang=${other}">${t.switch}</a><h1>${esc(p?.name ?? t.title)}</h1><p class="sub">${t.sub}</p>
${dl ? `<section class="card"><dl>${dl}</dl></section>` : ""}
${p?.pitch ? `<section class="card pitch">${esc(p.pitch)}</section>` : ""}
<section class="card"><h2>${t.docs}</h2>${docs}</section>
<p class="foot">${t.expires} ${date}.</p>`;
  return shell(lang, `${p?.name ?? t.title} · ${t.title}`, body);
}
