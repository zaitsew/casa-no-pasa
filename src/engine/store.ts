import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FiltersSchema, ListingSchema, ProfileSchema, type Filters, type Listing, type Profile } from "../core/schema";

/**
 * SQLite store. Every function takes the renter's user id; no query reads another renter's rows.
 * Migrations are in code, tracked by `PRAGMA user_version`.
 */

export const EVENT_KINDS = ["card_shown", "copied", "sent", "not_for_me", "viewing"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type SaveResult =
  | { status: "new" }
  /** Same portal id, same price, nothing the stored listing lacks: nothing new. */
  | { status: "duplicate" }
  /** Same portal id seen again with facts the stored listing lacked (a bare link, then the ad). The new facts were merged into the stored listing. */
  | { status: "enriched"; listing: Listing }
  /** No portal id and the same facts hash: probably the same flat, but sparse facts collide, so it is still shown. */
  | { status: "possible_duplicate" }
  /** Same portal id with a different price. The stored listing is replaced by the new one. */
  | { status: "revision"; oldPriceEur: number; newPriceEur: number };

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === "unknown";

/**
 * The stored listing plus every non-empty field of `fresh` it lacks (existing values win). Null when nothing
 * is added. `seenAt`, `id` and `source` are never merged; `evidence` is merged per key.
 */
function mergeMissing(old: Listing, fresh: Listing): Listing | null {
  const out: Record<string, unknown> = { ...old };
  let changed = false;
  for (const [k, v] of Object.entries(fresh)) {
    if (k === "id" || k === "source" || k === "seenAt" || k === "evidence") continue;
    if (isEmpty(v) || !isEmpty((old as Record<string, unknown>)[k])) continue;
    out[k] = v;
    changed = true;
    const e = fresh.evidence[k];
    if (e && !old.evidence[k]) out.evidence = { ...(out.evidence as object), [k]: e };
  }
  return changed ? ListingSchema.parse(out) : null;
}

export const DEFAULT_RETENTION_DAYS = 90;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (id TEXT PRIMARY KEY, telegram_id TEXT UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL);
  CREATE TABLE filters (user_id TEXT PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL);
  CREATE TABLE listings (
    user_id TEXT NOT NULL REFERENCES users(id),
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE occurrences (
    user_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    source TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    price_eur INTEGER
  );
  CREATE INDEX occurrences_listing ON occurrences (user_id, listing_id);
  CREATE TABLE events (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('card_shown','copied','sent','not_for_me','viewing')),
    at TEXT NOT NULL,
    received_at TEXT
  );
  CREATE INDEX events_user_kind ON events (user_id, kind);
  `,
  // S1.2: bot access, conversation state, documents, dossier grants, inbound aliases, card button keys.
  `
  CREATE TABLE invites (code_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, used_by TEXT, used_at TEXT);
  CREATE TABLE bot_state (user_id TEXT PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL);
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX documents_user ON documents (user_id);
  CREATE TABLE grants (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    doc_ids TEXT NOT NULL,
    token_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX grants_user ON grants (user_id);
  CREATE TABLE inbound_aliases (alias_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), created_at TEXT NOT NULL);
  CREATE TABLE listing_keys (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, listing_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX listing_keys_owner ON listing_keys (user_id, listing_id);
  `,
];

export function dbPath(env: Record<string, string | undefined> = process.env): string {
  return env.CASANOPASA_DB_PATH?.trim() || "./data/casanopasa.db";
}

export interface EventRow {
  userId: string;
  listingId: string;
  kind: EventKind;
  at: string;
  receivedAt?: string;
}

export interface Usage {
  users: number;
  listings: number;
  cards: number;
  copied: number;
  sent: number;
  viewings: number;
  median_seconds_to_card: number | "not_enough_data";
}

export interface DocumentRow {
  id: string;
  userId: string;
  label: string;
  mime: string;
  size: number;
  /** Random name of the encrypted file inside the files directory. */
  fileName: string;
  createdAt: string;
}

export interface GrantRow {
  tokenHash: string;
  userId: string;
  docIds: string[];
  /** The token sealed with the files key, so a draft can carry the link. Opaque to the store. */
  tokenEnc: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface Store {
  upsertUser(userId: string, telegramId?: string): void;
  setProfile(profile: Profile): void;
  getProfile(userId: string): Profile | undefined;
  setFilters(userId: string, filters: Filters): void;
  /** Stored filters, or the defaults when none were set. */
  getFilters(userId: string): Filters;
  saveListing(userId: string, listing: Listing): SaveResult;
  getListing(userId: string, id: string): Listing | undefined;
  occurrences(userId: string, listingId: string): Array<{ source: string; seenAt: string; priceEur?: number }>;
  recordEvent(userId: string, listingId: string, kind: EventKind, at: string, receivedAt?: string): void;
  events(userId: string, kind?: EventKind): EventRow[];
  /** Delete listings (and their occurrences) first seen more than `days` ago. Returns how many listings went. */
  purgeListings(days: number, now?: Date): number;
  /** Everything stored for one renter (the /delete command). */
  deleteUser(userId: string): void;
  usage(): Usage;

  // --- Bot access (S1.2). Invite codes are stored as hashes; the code itself is shown once. ---
  createInvite(codeHash: string, at?: string): void;
  /** Single use: true when the code existed and was unused, and the Telegram user is now linked. */
  redeemInvite(codeHash: string, telegramId: string, at?: string): boolean;
  /** A user row with a linked Telegram id exists. */
  isLinked(userId: string): boolean;
  getState(userId: string): unknown | undefined;
  setState(userId: string, state: unknown): void;

  // --- Documents and dossier grants ---
  addDocument(doc: Omit<DocumentRow, "createdAt"> & { createdAt?: string }): void;
  listDocuments(userId: string): DocumentRow[];
  /** Null unless the document belongs to this renter. */
  getDocument(userId: string, id: string): DocumentRow | undefined;
  /** Removes the row (and the id from every grant's scope) and returns it, so the caller can remove the file. */
  removeDocument(userId: string, id: string): DocumentRow | undefined;
  createGrant(g: Omit<GrantRow, "createdAt" | "revoked"> & { createdAt?: string }): void;
  getGrantByHash(tokenHash: string): GrantRow | undefined;
  /** The newest grant that is neither revoked nor expired at `now`. */
  latestActiveGrant(userId: string, now: Date): GrantRow | undefined;
  /** Revokes every grant of the renter; returns how many were still active. */
  revokeGrants(userId: string, now: Date): number;

  // --- Inbound email aliases: one per renter, stored hashed ---
  setInboundAlias(userId: string, aliasHash: string): void;
  hasInboundAlias(userId: string): boolean;
  userForAliasHash(aliasHash: string): string | undefined;

  // --- Opaque keys for card buttons: the key maps to (renter, listing) and nothing else ---
  listingKey(userId: string, listingId: string): string;
  resolveListingKey(key: string): { userId: string; listingId: string } | undefined;

  close(): void;
}

export function openStore(path: string = dbPath()): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const q = {
    upsertUser: db.prepare("INSERT INTO users (id, telegram_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET telegram_id = COALESCE(excluded.telegram_id, users.telegram_id)"),
    setProfile: db.prepare("INSERT INTO profiles (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json"),
    getProfile: db.prepare("SELECT json FROM profiles WHERE user_id = ?"),
    setFilters: db.prepare("INSERT INTO filters (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json"),
    getFilters: db.prepare("SELECT json FROM filters WHERE user_id = ?"),
    getListing: db.prepare("SELECT json FROM listings WHERE user_id = ? AND id = ?"),
    insertListing: db.prepare("INSERT INTO listings (user_id, id, json, first_seen_at) VALUES (?, ?, ?, ?)"),
    updateListing: db.prepare("UPDATE listings SET json = ? WHERE user_id = ? AND id = ?"),
    insertOccurrence: db.prepare("INSERT INTO occurrences (user_id, listing_id, source, seen_at, price_eur) VALUES (?, ?, ?, ?, ?)"),
    occurrences: db.prepare("SELECT source, seen_at, price_eur FROM occurrences WHERE user_id = ? AND listing_id = ? ORDER BY seen_at, rowid"),
    insertEvent: db.prepare("INSERT INTO events (user_id, listing_id, kind, at, received_at) VALUES (?, ?, ?, ?, ?)"),
    events: db.prepare("SELECT user_id, listing_id, kind, at, received_at FROM events WHERE user_id = ? AND (? IS NULL OR kind = ?) ORDER BY n"),
  };

  const nowIso = () => new Date().toISOString();
  const docFrom = (r: { id: string; user_id: string; label: string; mime: string; size: number; file_name: string; created_at: string }): DocumentRow => ({
    id: r.id, userId: r.user_id, label: r.label, mime: r.mime, size: r.size, fileName: r.file_name, createdAt: r.created_at,
  });
  type GrantSql = { token_hash: string; user_id: string; doc_ids: string; token_enc: string; created_at: string; expires_at: string; revoked: number };
  const grantFrom = (r: GrantSql): GrantRow => ({
    tokenHash: r.token_hash, userId: r.user_id, docIds: JSON.parse(r.doc_ids) as string[], tokenEnc: r.token_enc,
    createdAt: r.created_at, expiresAt: r.expires_at, revoked: r.revoked === 1,
  });

  const ensureUser = (userId: string) => q.upsertUser.run(userId, null, new Date().toISOString());

  return {
    upsertUser(userId, telegramId) {
      q.upsertUser.run(userId, telegramId ?? null, new Date().toISOString());
    },
    setProfile(profile) {
      const p = ProfileSchema.parse(profile);
      ensureUser(p.userId);
      q.setProfile.run(p.userId, JSON.stringify(p));
    },
    getProfile(userId) {
      const row = q.getProfile.get(userId) as { json: string } | undefined;
      return row ? ProfileSchema.parse(JSON.parse(row.json)) : undefined;
    },
    setFilters(userId, filters) {
      ensureUser(userId);
      q.setFilters.run(userId, JSON.stringify(FiltersSchema.parse(filters)));
    },
    getFilters(userId) {
      const row = q.getFilters.get(userId) as { json: string } | undefined;
      return FiltersSchema.parse(row ? JSON.parse(row.json) : {});
    },
    saveListing(userId, listing) {
      const l = ListingSchema.parse(listing);
      ensureUser(userId);
      const existing = q.getListing.get(userId, l.id) as { json: string } | undefined;
      q.insertOccurrence.run(userId, l.id, l.source, l.seenAt, l.priceEur ?? null);
      if (!existing) {
        q.insertListing.run(userId, l.id, JSON.stringify(l), l.seenAt);
        return { status: "new" };
      }
      if (!l.portalId) return { status: "possible_duplicate" };
      const old = ListingSchema.parse(JSON.parse(existing.json));
      if (old.priceEur !== undefined && l.priceEur !== undefined && old.priceEur !== l.priceEur) {
        q.updateListing.run(JSON.stringify(l), userId, l.id);
        return { status: "revision", oldPriceEur: old.priceEur, newPriceEur: l.priceEur };
      }
      const merged = mergeMissing(old, l);
      if (merged) {
        q.updateListing.run(JSON.stringify(merged), userId, l.id);
        return { status: "enriched", listing: merged };
      }
      return { status: "duplicate" };
    },
    getListing(userId, id) {
      const row = q.getListing.get(userId, id) as { json: string } | undefined;
      return row ? ListingSchema.parse(JSON.parse(row.json)) : undefined;
    },
    occurrences(userId, listingId) {
      return (q.occurrences.all(userId, listingId) as Array<{ source: string; seen_at: string; price_eur: number | null }>).map((r) => ({
        source: r.source,
        seenAt: r.seen_at,
        ...(r.price_eur !== null ? { priceEur: r.price_eur } : {}),
      }));
    },
    recordEvent(userId, listingId, kind, at, receivedAt) {
      if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind ${kind}`);
      q.insertEvent.run(userId, listingId, kind, at, receivedAt ?? null);
    },
    events(userId, kind) {
      const rows = q.events.all(userId, kind ?? null, kind ?? null) as Array<{ user_id: string; listing_id: string; kind: EventKind; at: string; received_at: string | null }>;
      return rows.map((r) => ({ userId: r.user_id, listingId: r.listing_id, kind: r.kind, at: r.at, ...(r.received_at ? { receivedAt: r.received_at } : {}) }));
    },
    purgeListings(days, now = new Date()) {
      const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM occurrences WHERE (user_id, listing_id) IN (SELECT user_id, id FROM listings WHERE first_seen_at < ?)").run(cutoff);
        db.prepare("DELETE FROM listing_keys WHERE (user_id, listing_id) IN (SELECT user_id, id FROM listings WHERE first_seen_at < ?)").run(cutoff);
        const r = db.prepare("DELETE FROM listings WHERE first_seen_at < ?").run(cutoff);
        db.exec("COMMIT");
        return Number(r.changes);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    deleteUser(userId) {
      db.exec("BEGIN");
      try {
        for (const t of ["events", "occurrences", "listing_keys", "grants", "documents", "inbound_aliases", "bot_state"]) {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
        }
        for (const t of ["listings", "filters", "profiles"]) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
        // The invite row stays (a used code stays used) but no longer names the renter.
        db.prepare("UPDATE invites SET used_by = NULL WHERE used_by = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    usage() {
      const count = (sql: string) => Number((db.prepare(sql).get() as { c: number }).c);
      const secs = (db.prepare("SELECT at, received_at FROM events WHERE kind = 'card_shown' AND received_at IS NOT NULL").all() as Array<{ at: string; received_at: string }>)
        .map((r) => (Date.parse(r.at) - Date.parse(r.received_at)) / 1000)
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
      const median = secs.length < 3 ? "not_enough_data" : Math.round((secs.length % 2 ? secs[(secs.length - 1) / 2]! : (secs[secs.length / 2 - 1]! + secs[secs.length / 2]!) / 2) * 10) / 10;
      return {
        users: count("SELECT COUNT(*) AS c FROM users"),
        listings: count("SELECT COUNT(*) AS c FROM listings"),
        cards: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'card_shown'"),
        copied: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'copied'"),
        sent: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'sent'"),
        viewings: count("SELECT COUNT(*) AS c FROM events WHERE kind = 'viewing'"),
        median_seconds_to_card: median,
      };
    },
    createInvite(codeHash, at) {
      db.prepare("INSERT INTO invites (code_hash, created_at) VALUES (?, ?)").run(codeHash, at ?? nowIso());
    },
    redeemInvite(codeHash, telegramId, at) {
      db.exec("BEGIN");
      try {
        const r = db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL").run(telegramId, at ?? nowIso(), codeHash);
        if (Number(r.changes) !== 1) {
          db.exec("ROLLBACK");
          return false;
        }
        q.upsertUser.run(telegramId, telegramId, nowIso());
        db.exec("COMMIT");
        return true;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    isLinked(userId) {
      return db.prepare("SELECT 1 FROM users WHERE id = ? AND telegram_id IS NOT NULL").get(userId) !== undefined;
    },
    getState(userId) {
      const row = db.prepare("SELECT json FROM bot_state WHERE user_id = ?").get(userId) as { json: string } | undefined;
      return row ? JSON.parse(row.json) : undefined;
    },
    setState(userId, state) {
      ensureUser(userId);
      db.prepare("INSERT INTO bot_state (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json").run(userId, JSON.stringify(state));
    },
    addDocument(d) {
      ensureUser(d.userId);
      db.prepare("INSERT INTO documents (id, user_id, label, mime, size, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(d.id, d.userId, d.label, d.mime, d.size, d.fileName, d.createdAt ?? nowIso());
    },
    listDocuments(userId) {
      return (db.prepare("SELECT * FROM documents WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as Parameters<typeof docFrom>[0][]).map(docFrom);
    },
    getDocument(userId, id) {
      const r = db.prepare("SELECT * FROM documents WHERE user_id = ? AND id = ?").get(userId, id) as Parameters<typeof docFrom>[0] | undefined;
      return r ? docFrom(r) : undefined;
    },
    removeDocument(userId, id) {
      const r = db.prepare("SELECT * FROM documents WHERE user_id = ? AND id = ?").get(userId, id) as Parameters<typeof docFrom>[0] | undefined;
      if (!r) return undefined;
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM documents WHERE user_id = ? AND id = ?").run(userId, id);
        const grants = db.prepare("SELECT token_hash, doc_ids FROM grants WHERE user_id = ?").all(userId) as Array<{ token_hash: string; doc_ids: string }>;
        for (const g of grants) {
          const ids = (JSON.parse(g.doc_ids) as string[]).filter((x) => x !== id);
          db.prepare("UPDATE grants SET doc_ids = ? WHERE token_hash = ?").run(JSON.stringify(ids), g.token_hash);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return docFrom(r);
    },
    createGrant(g) {
      ensureUser(g.userId);
      db.prepare("INSERT INTO grants (token_hash, user_id, doc_ids, token_enc, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)").run(g.tokenHash, g.userId, JSON.stringify(g.docIds), g.tokenEnc, g.createdAt ?? nowIso(), g.expiresAt);
    },
    getGrantByHash(tokenHash) {
      const r = db.prepare("SELECT * FROM grants WHERE token_hash = ?").get(tokenHash) as GrantSql | undefined;
      return r ? grantFrom(r) : undefined;
    },
    latestActiveGrant(userId, now) {
      const r = db.prepare("SELECT * FROM grants WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(userId, now.toISOString()) as GrantSql | undefined;
      return r ? grantFrom(r) : undefined;
    },
    revokeGrants(userId, now) {
      const r = db.prepare("UPDATE grants SET revoked = 1 WHERE user_id = ? AND revoked = 0 AND expires_at > ?").run(userId, now.toISOString());
      db.prepare("UPDATE grants SET revoked = 1 WHERE user_id = ?").run(userId);
      return Number(r.changes);
    },
    setInboundAlias(userId, aliasHash) {
      ensureUser(userId);
      db.prepare("INSERT INTO inbound_aliases (alias_hash, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET alias_hash = excluded.alias_hash, created_at = excluded.created_at").run(aliasHash, userId, nowIso());
    },
    hasInboundAlias(userId) {
      return db.prepare("SELECT 1 FROM inbound_aliases WHERE user_id = ?").get(userId) !== undefined;
    },
    userForAliasHash(aliasHash) {
      const r = db.prepare("SELECT user_id FROM inbound_aliases WHERE alias_hash = ?").get(aliasHash) as { user_id: string } | undefined;
      return r?.user_id;
    },
    listingKey(userId, listingId) {
      const row = db.prepare("SELECT key FROM listing_keys WHERE user_id = ? AND listing_id = ?").get(userId, listingId) as { key: string } | undefined;
      if (row) return row.key;
      const key = randomBytes(9).toString("base64url");
      db.prepare("INSERT INTO listing_keys (key, user_id, listing_id, created_at) VALUES (?, ?, ?, ?)").run(key, userId, listingId, nowIso());
      return key;
    },
    resolveListingKey(key) {
      const r = db.prepare("SELECT user_id, listing_id FROM listing_keys WHERE key = ?").get(key) as { user_id: string; listing_id: string } | undefined;
      return r ? { userId: r.user_id, listingId: r.listing_id } : undefined;
    },
    close() {
      db.close();
    },
  };
}
