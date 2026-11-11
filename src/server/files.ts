import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Encrypted document storage (D5). AES-256-GCM, a random 96-bit IV per file, the file name as additional
 * authenticated data (so a ciphertext copied under another name fails to open). Layout of a stored file:
 * IV (12 bytes) | auth tag (16 bytes) | ciphertext. File names are random; the renter's label lives in the store.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const NAME_RE = /^[0-9a-f]{32}\.bin$/;

export class FilesKeyError extends Error {}
export class TamperError extends Error {}

/** 32 bytes from a 64-character hex string. */
export function parseKey(hex: string | undefined): Buffer {
  const h = (hex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new FilesKeyError("CASANOPASA_FILES_KEY must be 64 hex characters (generate one with: openssl rand -hex 32)");
  return Buffer.from(h, "hex");
}

export function seal(key: Buffer, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(key: Buffer, aad: string, blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new TamperError("stored file is too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LEN));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  try {
    return Buffer.concat([d.update(blob.subarray(IV_LEN + TAG_LEN)), d.final()]);
  } catch {
    throw new TamperError("stored file failed authentication");
  }
}

export function sealString(key: Buffer, aad: string, s: string): string {
  return seal(key, aad, Buffer.from(s, "utf8")).toString("base64url");
}

export function openString(key: Buffer, aad: string, enc: string): string {
  return open(key, aad, Buffer.from(enc, "base64url")).toString("utf8");
}

export interface FileStore {
  /** Encrypts and writes; returns the random stored name. */
  put(plain: Buffer): string;
  /** Decrypts. Throws TamperError when the file was changed or swapped. */
  get(name: string): Buffer;
  /** Deletes the file; a missing file is fine. */
  remove(name: string): void;
  /** Where the files live (for tests). */
  dir: string;
}

export function filesDir(env: Record<string, string | undefined> = process.env): string {
  return env.CASANOPASA_FILES_DIR?.trim() || "./data/files";
}

export function createFileStore(opts: { dir: string; key: Buffer }): FileStore {
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pathOf = (name: string) => {
    if (!NAME_RE.test(name)) throw new Error("invalid stored file name");
    return join(dir, name);
  };
  return {
    dir,
    put(plain) {
      const name = `${randomBytes(16).toString("hex")}.bin`;
      writeFileSync(pathOf(name), seal(opts.key, name, plain), { mode: 0o600, flag: "wx" });
      return name;
    },
    get(name) {
      const p = pathOf(name);
      if (!existsSync(p)) throw new TamperError("stored file is missing");
      return open(opts.key, name, readFileSync(p));
    },
    remove(name) {
      rmSync(pathOf(name), { force: true });
    },
  };
}

/** Best effort: tighten permissions on an existing directory. */
export function tightenDir(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to change */
  }
}
