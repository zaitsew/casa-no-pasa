/**
 * The accounts-hub client (D6). Haiku 5.5 runs through the hub as one forced function call.
 * Nothing here throws: no token, `CASANOPASA_AI=off`, a network error, a timeout, a non-2xx answer or a
 * malformed answer all return null and log one line. The engine works without any of it.
 *
 * Messages follow the hub's OpenAI-compatible chat format. Images are an `image_url` content part holding a
 * data URL (the hub translates it to an Anthropic image block; accounts repo, supabase/functions/_shared/chat.ts).
 */

export const AI_MODEL = "claude-haiku-5-5";
export const AI_TIMEOUT_MS = 6000;
export const AI_IMAGE_TIMEOUT_MS = 15000;
const PRODUCT = "casanopasa";

export type Env = Record<string, string | undefined>;

export function aiEnabled(env: Env = process.env): boolean {
  if (!env.ACCOUNTS_SERVICE_CASANOPASA?.trim()) return false;
  if (!env.ACCOUNTS_URL?.trim()) return false;
  return env.CASANOPASA_AI?.trim().toLowerCase() !== "off";
}

export interface AiOptions {
  env?: Env;
  /** Injected in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function log(what: string, reason: string): void {
  console.warn(`[casanopasa-ai] ${what}: ${reason}`);
}

interface ChatCompletion {
  choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
}

/** One forced tool call. Returns the parsed arguments, or null on any failure. */
export async function callTool(
  what: string,
  tool: ToolDef,
  system: string,
  user: string | ContentPart[],
  maxTokens: number,
  opts: AiOptions & { externalUser?: string } = {},
): Promise<unknown | null> {
  const env = opts.env ?? process.env;
  if (!aiEnabled(env)) return null;
  const token = env.ACCOUNTS_SERVICE_CASANOPASA!.trim();
  const base = env.ACCOUNTS_URL!.trim().replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${base}/functions/v1/ai`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-accounts-service": token,
        "x-accounts-product": PRODUCT,
        "x-accounts-external-user": opts.externalUser ?? "owner",
      },
      body: JSON.stringify({
        product: PRODUCT,
        model: AI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [{ type: "function", function: tool }],
        tool_choice: { type: "function", function: { name: tool.name } },
        fallback: [],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(what, `hub answered ${res.status}`);
      return null;
    }
    const data = (await res.json()) as ChatCompletion;
    const call = data.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === tool.name)?.function;
    if (!call || typeof call.arguments !== "string") {
      log(what, "no tool call in the answer");
      return null;
    }
    return JSON.parse(call.arguments);
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    log(what, name === "TimeoutError" || name === "AbortError" ? "timeout" : `${name} calling the hub`);
    return null;
  }
}
