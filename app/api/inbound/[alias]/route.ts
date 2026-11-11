import { z } from "zod";
import { esc, sendCards } from "../../../../src/bot/cards";
import { strings, type UiLang } from "../../../../src/bot/strings";
import { safeEqual, sha256Hex } from "../../../../src/server/auth";
import { json } from "../../../../src/server/http";
import { activeDossierUrl } from "../../../../src/server/grants";
import { GMAIL_FORWARDING_SENDER, senderAddress, stripHtml, truncateText } from "../../../../src/server/inbound";
import { getRuntime, purgeIfDue } from "../../../../src/server/runtime";

export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;
const BodySchema = z.object({
  from: z.string().max(500),
  subject: z.string().max(1000).default(""),
  text: z.string().max(MAX_BODY).default(""),
  html: z.string().max(MAX_BODY).optional(),
});

/**
 * Inbound alert email from the Cloudflare Email Worker. Authenticated by a shared secret header; the renter
 * is found by a random per-renter alias (stored hashed). Nothing about the renter is revealed on failure.
 */
export async function POST(req: Request, ctx: { params: Promise<{ alias: string }> }): Promise<Response> {
  const rt = getRuntime();
  if (!safeEqual(req.headers.get("x-casanopasa-inbound"), rt.inboundSecret)) return json({ error: "forbidden" }, 401);
  const { alias } = await ctx.params;
  const userId = /^[0-9a-f]{32}$/.test(alias.toLowerCase()) ? rt.store.userForAliasHash(sha256Hex(alias.toLowerCase())) : undefined;
  if (!userId) return json({ error: "not_found" }, 404);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(JSON.parse(raw));
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  purgeIfDue(rt);
  // The engine refuses text over 50,000 characters; a long newsletter is cut, not rejected.
  const text = truncateText(body.text.trim() || (body.html ? stripHtml(body.html) : ""));
  const chatId = Number(userId);
  const ui: UiLang = ((rt.store.getState(userId) as { ui?: UiLang } | undefined)?.ui) ?? "en";

  try {
    if (senderAddress(body.from) === GMAIL_FORWARDING_SENDER) {
      const S = strings(ui);
      await rt.tg.sendMessage(chatId, `${S.gmailConfirm}\n\n<b>${esc(body.subject.slice(0, 200))}</b>\n<pre>${esc(text.slice(0, 3000))}</pre>`);
      return json({ ok: true, relayed: true });
    }
    const dossierUrl = activeDossierUrl(rt.store, rt.filesKey, rt.publicUrl, userId, rt.now());
    const results = await rt.engine.handleInput(
      userId,
      { kind: "email", text, subject: body.subject, from: body.from, receivedAt: rt.now().toISOString() },
      dossierUrl ? { dossierUrl } : undefined,
    );
    await sendCards(rt.tg, rt.store, userId, chatId, results, ui);
    return json({ ok: true, cards: results.filter((r) => !r.duplicate).length });
  } catch (err) {
    console.error(`[casanopasa] inbound failed: ${(err as Error).name}`);
    return json({ error: "failed" }, 502);
  }
}
