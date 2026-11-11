import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string compare. Both sides are hashed first so a length difference does not leak and
 * `timingSafeEqual` always gets equal-length buffers. An empty expected secret never matches: a server
 * with the secret unset refuses everyone.
 */
export function safeEqual(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || given === null || given === undefined) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
