import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TgUpdate } from "../../src/bot/handler";
import { createTg, type Keyboard } from "../../src/bot/tg";
import { openStore } from "../../src/engine/store";
import { createFileStore, parseKey } from "../../src/server/files";
import { buildRuntime, setRuntime, type Runtime } from "../../src/server/runtime";
import { profile } from "../fixtures";

/** A fresh random 32-byte key per test run. */
export const KEY_HEX = randomBytes(32).toString("hex");
export const WEBHOOK_SECRET = "test-webhook-secret";
export const INBOUND_SECRET = "test-inbound-secret";
export const PUBLIC_URL = "https://casanopasa.example.test";

export interface Sent {
  method: string;
  body: Record<string, any>;
}

/** A fake api.telegram.org: records every call; serves files registered in `downloads`. */
export function fakeTelegram() {
  const sent: Sent[] = [];
  const downloads = new Map<string, Buffer>();
  let messageId = 100;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const file = /\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (file) {
      const bytes = downloads.get(file[1]!);
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("nope", { status: 404 });
    }
    const method = /\/bot[^/]+\/(\w+)$/.exec(url)![1]!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: `files/${body.file_id}`, file_size: downloads.get(`files/${body.file_id}`)?.length } });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: ++messageId } });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return {
    sent,
    downloads,
    fetch: doFetch,
    /** sendMessage texts, in order. */
    texts: () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => String(s.body.text)),
    last: (method = "sendMessage") => sent.filter((s) => s.method === method).at(-1),
    keyboardOf: (s: Sent | undefined): Keyboard => s?.body.reply_markup?.inline_keyboard ?? [],
    clear: () => sent.splice(0),
  };
}

export interface Harness {
  rt: Runtime;
  tg: ReturnType<typeof fakeTelegram>;
  dir: string;
  clock: { now: Date };
  cleanup(): void;
  /** A linked renter with a profile. */
  addRenter(id: number, over?: Parameters<typeof profile>[0]): void;
  say(from: number, text: string, extra?: Record<string, unknown>): Promise<void>;
  press(from: number, data: string, messageId?: number): Promise<void>;
}

let updateId = 1;

export function harness(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "cnp-"));
  const tg = fakeTelegram();
  const clock = { now: new Date("2026-11-11T10:00:30.000Z") };
  const store = openStore(":memory:");
  const rt = buildRuntime({
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, CASANOPASA_INBOUND_SECRET: INBOUND_SECRET, CASANOPASA_PUBLIC_URL: PUBLIC_URL, CASANOPASA_FILES_KEY: KEY_HEX, CASANOPASA_FILES_DIR: join(dir, "files"), ...env },
    fetch: tg.fetch,
    store,
    tg: createTg({ token: "123:abc", fetch: tg.fetch }),
    now: () => clock.now,
  });
  setRuntime(rt);
  let closed = false;
  const h: Harness = {
    rt,
    tg,
    dir,
    clock,
    cleanup() {
      if (closed) return;
      closed = true;
      setRuntime(undefined);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
    addRenter(id, over = {}) {
      store.upsertUser(String(id), String(id));
      store.setProfile(profile({ userId: String(id), ...over }));
    },
    async say(from, text, extra = {}) {
      const u: TgUpdate = { update_id: updateId++, message: { message_id: 1, date: Math.floor(clock.now.getTime() / 1000) - 5, chat: { id: from, type: "private" }, from: { id: from, language_code: "en" }, text, ...extra } };
      await rt.bot.handleUpdate(u);
    },
    async press(from, data, messageId = 500) {
      await rt.bot.handleUpdate({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: from, language_code: "en" }, data, message: { message_id: messageId, chat: { id: from, type: "private" } } } });
    },
  };
  return h;
}

export const fileStoreFor = (dir: string) => createFileStore({ dir: join(dir, "files-direct"), key: parseKey(KEY_HEX) });

export const buttons = (kb: Keyboard) => kb.flat();
