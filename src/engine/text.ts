/** Small text helpers shared by extract, assess and draft. */

/** Lower-case, accent-free, same length as the input for NFC text, so indexes map back to the original. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Index-safe search: finds `re` in the folded text and returns the original substring. */
export function findFolded(text: string, re: RegExp): string | undefined {
  const m = re.exec(fold(text));
  if (!m) return undefined;
  return text.slice(m.index, m.index + m[0].length);
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
