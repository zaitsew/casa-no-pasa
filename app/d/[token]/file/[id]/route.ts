import { PRIVATE_HEADERS } from "../../../../../src/server/http";
import { resolveGrant } from "../../../../../src/server/grants";
import { getRuntime } from "../../../../../src/server/runtime";

export const dynamic = "force-dynamic";

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/** Streams one decrypted document. The grant, its scope and the document are re-checked on every request. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; id: string }> }): Promise<Response> {
  const { token, id } = await ctx.params;
  const rt = getRuntime();
  const g = resolveGrant(rt.store, token, rt.now());
  if (!g) return new Response("This link has expired.", { status: 410, headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  const notFound = () => new Response("Not found.", { status: 404, headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  if (!g.grant.docIds.includes(id)) return notFound();
  const doc = g.documents.find((d) => d.id === id);
  if (!doc || !rt.files) return notFound();
  let bytes: Buffer;
  try {
    bytes = rt.files.get(doc.fileName);
  } catch {
    return notFound();
  }
  const name = `${doc.label.replace(/[^a-z0-9_-]/gi, "")}.${EXT[doc.mime] ?? "bin"}`;
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...PRIVATE_HEADERS, "Content-Type": doc.mime, "Content-Length": String(bytes.length), "Content-Disposition": `attachment; filename="${name}"` },
  });
}
