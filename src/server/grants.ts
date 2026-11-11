import { randomBytes } from "node:crypto";
import type { Profile } from "../core/schema";
import type { DocumentRow, GrantRow, Store } from "../engine/store";
import { sha256Hex } from "./auth";
import { openString, sealString } from "./files";

/**
 * Dossier grants (PLAN: "Dossier grants"). A token is 128 random bits (base64url), shown to the renter once
 * and stored as a SHA-256 hash. The store also keeps the token sealed with the files key so a reply draft can
 * carry the link; without that key the database alone cannot rebuild a link.
 */

export const EXPIRIES = { "24h": 24 * 3_600_000, "7d": 7 * 86_400_000 } as const;
export type Expiry = keyof typeof EXPIRIES;

export const hashToken = (token: string) => sha256Hex(token);
const aad = (userId: string) => `grant:${userId}`;

export function createGrant(store: Store, key: Buffer, userId: string, docIds: string[], expiry: Expiry, now: Date): { token: string; expiresAt: string } {
  const token = randomBytes(16).toString("base64url");
  const expiresAt = new Date(now.getTime() + EXPIRIES[expiry]).toISOString();
  store.createGrant({ tokenHash: hashToken(token), userId, docIds, tokenEnc: sealString(key, aad(userId), token), createdAt: now.toISOString(), expiresAt });
  return { token, expiresAt };
}

export const dossierUrlFor = (publicUrl: string, token: string) => `${publicUrl.replace(/\/+$/, "")}/d/${token}`;

/** The link for the renter's newest active grant, for drafts. Undefined when none or the key is unusable. */
export function activeDossierUrl(store: Store, key: Buffer | undefined, publicUrl: string | undefined, userId: string, now: Date): string | undefined {
  if (!key || !publicUrl) return undefined;
  const g = store.latestActiveGrant(userId, now);
  if (!g) return undefined;
  try {
    return dossierUrlFor(publicUrl, openString(key, aad(userId), g.tokenEnc));
  } catch {
    return undefined;
  }
}

export interface ResolvedGrant {
  grant: GrantRow;
  profile: Profile | undefined;
  /** Only documents that are in the grant's scope and still exist. */
  documents: DocumentRow[];
}

/** Null for an unknown, expired or revoked token: the caller shows one neutral page for all three. */
export function resolveGrant(store: Store, token: string, now: Date): ResolvedGrant | null {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const grant = store.getGrantByHash(hashToken(token));
  if (!grant || grant.revoked || Date.parse(grant.expiresAt) <= now.getTime()) return null;
  const documents = grant.docIds.map((id) => store.getDocument(grant.userId, id)).filter((d): d is DocumentRow => d !== undefined);
  return { grant, profile: store.getProfile(grant.userId), documents };
}
