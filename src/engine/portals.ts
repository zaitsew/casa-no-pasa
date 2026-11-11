import type { Source } from "../core/schema";

export interface PortalHit {
  source: Source;
  url: string;
  /** The portal's own listing id, when the URL carries one. */
  portalId?: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

/** URLs in a text, trailing punctuation removed. */
export function findUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Source and portal id of one URL. Null when the host is not a known portal or social network. */
export function detectPortal(rawUrl: string): PortalHit | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const hit = (source: Source, portalId?: string): PortalHit => ({ source, url: rawUrl, ...(portalId ? { portalId } : {}) });

  if (hostIs(host, "idealista.com")) return hit("idealista", path.match(/\/inmueble\/(\d+)/)?.[1]);
  if (hostIs(host, "fotocasa.es")) return hit("fotocasa", path.match(/\/(\d{6,})\/d\b/)?.[1]);
  if (hostIs(host, "habitaclia.com")) return hit("habitaclia", path.match(/-i(\d+)\.htm/)?.[1]);
  if (hostIs(host, "pisos.com")) return hit("pisos", path.match(/(\d{6,})(?:_\d+)?\/?$/)?.[1]);
  if (hostIs(host, "badi.com")) return hit("badi", path.match(/\/rooms?\/(\d+)/)?.[1]);
  if (hostIs(host, "instagram.com")) return hit("instagram");
  if (hostIs(host, "facebook.com") || hostIs(host, "fb.com") || host === "fb.me") return hit("facebook");
  if (host === "t.me" || hostIs(host, "telegram.me")) return hit("telegram");
  return null;
}

/** Every known portal or social URL in the text, in order, without repeats. */
export function detectPortals(text: string): PortalHit[] {
  const seen = new Set<string>();
  const out: PortalHit[] = [];
  for (const url of findUrls(text)) {
    const hit = detectPortal(url);
    if (!hit || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
  }
  return out;
}
