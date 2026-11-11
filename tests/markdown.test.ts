import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { markdownToHtml } from "../src/web/markdown";

describe("markdownToHtml", () => {
  it("renders headings, lists, tables, code and escapes HTML", () => {
    const html = markdownToHtml("# T\n\nA <b>x</b> `c` **b** [l](https://e.test)\n\n- one\n  more\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("<code>c</code>");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain('<a href="https://e.test"');
    expect(html).toContain("<li>one more</li>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders the real privacy notice", () => {
    const html = markdownToHtml(readFileSync("docs/PRIVACY.md", "utf8"));
    expect(html).toContain("<h1>Privacy</h1>");
    expect(html).toContain("<table>");
  });
});
