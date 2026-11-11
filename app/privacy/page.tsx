import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { markdownToHtml } from "../../src/web/markdown";

export const metadata: Metadata = { title: "Privacy" };
// Rendered once at build time from docs/PRIVACY.md.
export const dynamic = "force-static";

export default function Privacy() {
  const html = markdownToHtml(readFileSync(join(process.cwd(), "docs", "PRIVACY.md"), "utf8"));
  return (
    <main className="doc">
      <article dangerouslySetInnerHTML={{ __html: html }} />
      <p className="foot">
        <a href="/">Casa No Pasa</a>
      </p>
    </main>
  );
}
