/**
 * A small Markdown to HTML converter for the repo's own docs (docs/PRIVACY.md): headings, paragraphs,
 * lists, tables, inline code, bold, italic and links. Everything is HTML-escaped first.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(raw: string): string {
  return esc(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head = [], ...body] = rows;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        let t = lines[i]!.replace(/^\s*[-*]\s+/, "");
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) t += ` ${lines[i]!.trim()}`, i++;
        items.push(`<li>${inline(t)}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|\s*\||\s*[-*]\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
