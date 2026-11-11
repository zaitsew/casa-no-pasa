import type { TgUpdate } from "../../../src/bot/handler";
import { safeEqual } from "../../../src/server/auth";
import { json } from "../../../src/server/http";
import { getRuntime, purgeIfDue } from "../../../src/server/runtime";

export const dynamic = "force-dynamic";

/** Telegram webhook. Only a request that carries the secret token header is read at all. */
export async function POST(req: Request): Promise<Response> {
  const rt = getRuntime();
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), rt.webhookSecret)) return json({ error: "forbidden" }, 401);
  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  purgeIfDue(rt);
  try {
    await rt.bot.handleUpdate(update);
  } catch (err) {
    // Answer 200 so Telegram does not retry a poison update; log the error class only, never content.
    console.error(`[casanopasa] update failed: ${(err as Error).name}`);
  }
  return json({ ok: true });
}
