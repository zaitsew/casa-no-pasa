import { PRIVATE_HEADERS } from "../../../src/server/http";
import { resolveGrant } from "../../../src/server/grants";
import { getRuntime } from "../../../src/server/runtime";
import { pickDossierLang, renderDossier, renderGone } from "../../../src/web/dossier-html";

export const dynamic = "force-dynamic";

const HTML = { ...PRIVATE_HEADERS, "Content-Type": "text/html; charset=utf-8" };

/**
 * The dossier page. A route handler rather than a page component because an expired link must answer
 * HTTP 410, which a page cannot set. The grant is checked on every request.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const lang = pickDossierLang(new URL(req.url).searchParams.get("lang"));
  const rt = getRuntime();
  const g = resolveGrant(rt.store, token, rt.now());
  if (!g) return new Response(renderGone(lang), { status: 410, headers: HTML });
  return new Response(renderDossier({ lang, token, profile: g.profile, documents: g.documents, expiresAt: g.grant.expiresAt }), { status: 200, headers: HTML });
}
