import { createBot, INBOUND_DOMAIN, type Bot } from "../bot/handler";
import { createTg, type Tg } from "../bot/tg";
import { createEngine, type CasaEngine } from "../engine";
import type { Env } from "../engine/ai";
import { DEFAULT_RETENTION_DAYS, openStore, type Store } from "../engine/store";
import { createFileStore, filesDir, parseKey, type FileStore } from "./files";

/** Everything the route handlers need, built once from the environment (or injected by tests). */
export interface Runtime {
  engine: CasaEngine;
  store: Store;
  tg: Tg;
  bot: Bot;
  files?: FileStore;
  filesKey?: Buffer;
  publicUrl: string;
  webhookSecret: string;
  inboundSecret: string;
  inboundDomain: string;
  now: () => Date;
  /** Epoch ms of the last retention purge by this process. */
  lastPurgeAt?: number;
}

export interface RuntimeOptions {
  env?: Env;
  fetch?: typeof fetch;
  store?: Store;
  tg?: Tg;
  now?: () => Date;
}

export function buildRuntime(opts: RuntimeOptions = {}): Runtime {
  const env = opts.env ?? process.env;
  const store = opts.store ?? openStore(undefined, { strictUsers: true });
  const now = opts.now ?? (() => new Date());
  const engine = createEngine({ store, env, fetch: opts.fetch, now });
  const tg = opts.tg ?? createTg({ env, fetch: opts.fetch });
  let filesKey: Buffer | undefined;
  let files: FileStore | undefined;
  if (env.CASANOPASA_FILES_KEY?.trim()) {
    try {
      filesKey = parseKey(env.CASANOPASA_FILES_KEY);
      files = createFileStore({ dir: filesDir(env), key: filesKey });
    } catch (err) {
      console.warn(`[casanopasa] documents are off: ${(err as Error).message}`);
    }
  }
  const publicUrl = (env.CASANOPASA_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const inboundSecret = (env.CASANOPASA_INBOUND_SECRET ?? "").trim();
  const inboundDomain = (env.CASANOPASA_INBOUND_DOMAIN ?? "").trim() || INBOUND_DOMAIN;
  const bot = createBot({ engine, tg, files, filesKey, publicUrl, inboundEnabled: inboundSecret !== "", inboundDomain, now });
  return { engine, store, tg, bot, files, filesKey, publicUrl, webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim(), inboundSecret, inboundDomain, now };
}

let current: Runtime | undefined;

export function getRuntime(): Runtime {
  current ??= buildRuntime();
  return current;
}

/** Tests inject a runtime; pass undefined to reset. */
export function setRuntime(rt: Runtime | undefined): void {
  current = rt;
}

const PURGE_EVERY_MS = 3_600_000;

/**
 * Deletes listings older than the retention period (docs/PRIVACY.md), at most once an hour per process.
 * The webhook and the inbound route both call it; a later cron can call it too. Returns the number purged,
 * or undefined when it was not due.
 */
export function purgeIfDue(rt: Runtime): number | undefined {
  const t = rt.now().getTime();
  if (rt.lastPurgeAt !== undefined && t - rt.lastPurgeAt < PURGE_EVERY_MS) return undefined;
  rt.lastPurgeAt = t;
  try {
    return rt.store.purgeListings(DEFAULT_RETENTION_DAYS, rt.now());
  } catch {
    return undefined; // retried in an hour
  }
}
