import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStore, FilesKeyError, openString, parseKey, sealString, TamperError } from "../src/server/files";
import { KEY_HEX } from "./helpers/bot";

const dirs: string[] = [];
const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), "cnp-files-"));
  dirs.push(dir);
  return createFileStore({ dir, key: parseKey(KEY_HEX) });
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("encrypted files", () => {
  it("round-trips and never stores the plaintext", () => {
    const fs = mk();
    const plain = Buffer.from("%PDF-1.7 invented payslip for Ana Prueba");
    const name = fs.put(plain);
    expect(name).toMatch(/^[0-9a-f]{32}\.bin$/);
    expect(readFileSync(join(fs.dir, name)).includes(plain)).toBe(false);
    expect(fs.get(name).equals(plain)).toBe(true);
  });

  it("uses a fresh IV per file", () => {
    const fs = mk();
    const a = readFileSync(join(fs.dir, fs.put(Buffer.from("same"))));
    const b = readFileSync(join(fs.dir, fs.put(Buffer.from("same"))));
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it("detects a changed byte", () => {
    const fs = mk();
    const name = fs.put(Buffer.from("secret document"));
    const p = join(fs.dir, name);
    const blob = readFileSync(p);
    blob[blob.length - 1]! ^= 1;
    writeFileSync(p, blob);
    expect(() => fs.get(name)).toThrow(TamperError);
  });

  it("detects a ciphertext copied under another name", () => {
    const fs = mk();
    const a = fs.put(Buffer.from("document A"));
    const b = fs.put(Buffer.from("document B"));
    writeFileSync(join(fs.dir, b), readFileSync(join(fs.dir, a)));
    expect(() => fs.get(b)).toThrow(TamperError);
  });

  it("refuses a path-like name and a missing file reads as tampering", () => {
    const fs = mk();
    expect(() => fs.get("../../etc/passwd")).toThrow();
    expect(() => fs.get("0".repeat(32) + ".bin")).toThrow(TamperError);
    expect(() => fs.remove("0".repeat(32) + ".bin")).not.toThrow();
  });

  it("rejects a bad key", () => {
    expect(() => parseKey("abc")).toThrow(FilesKeyError);
    expect(() => parseKey(undefined)).toThrow(FilesKeyError);
  });

  it("seals strings and fails with another context", () => {
    const key = parseKey(KEY_HEX);
    const enc = sealString(key, "ctx", "token");
    expect(openString(key, "ctx", enc)).toBe("token");
    expect(() => openString(key, "other", enc)).toThrow(TamperError);
  });
});
