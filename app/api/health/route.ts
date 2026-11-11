import { json } from "../../../src/server/http";
import { getRuntime } from "../../../src/server/runtime";

export const dynamic = "force-dynamic";

/** Liveness for the container healthcheck. Opening the store here also runs the migrations at boot. */
export function GET(): Response {
  try {
    getRuntime().store.usage();
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
