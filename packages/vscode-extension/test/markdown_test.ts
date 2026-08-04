import { renderMarkdown } from "../src/webview/markdown.ts"

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) throw new Error(`Expected ${JSON.stringify(value)} to include ${JSON.stringify(expected)}`)
}

Deno.test("renders CommonMark blocks and inline formatting", () => {
  const html = renderMarkdown("Heading\n=======\n\n> - **Nested**\n>   - `item`\n\n    indented code\n\n~~deleted~~ and *emphasized*")
  assertIncludes(html, "<h1>Heading</h1>")
  assertIncludes(html, "<blockquote>")
  assertIncludes(html, "<ul>")
  assertIncludes(html, "<strong>Nested</strong>")
  assertIncludes(html, "<code>item</code>")
  assertIncludes(html, "<pre><code>indented code")
  assertIncludes(html, "<s>deleted</s>")
  assertIncludes(html, "<em>emphasized</em>")
})

Deno.test("renders GFM tables and safe links while escaping HTML", () => {
  const html = renderMarkdown("| One | Two |\n| --- | ---: |\n| a | b |\n\nhttps://example.com\n\n<script>alert(1)</script>\n\n[javascript](javascript:alert(1))")
  assertIncludes(html, "<table>")
  assertIncludes(html, "style=\"text-align:right\"")
  assertIncludes(html, "data-url=\"https://example.com/\"")
  assertIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;")
  assertIncludes(html, "[javascript](javascript:alert(1))")
})

Deno.test("preserves workspace mentions through the Markdown tokenizer", () => {
  assertIncludes(renderMarkdown("Inspect @<src/main.ts>", { workspaceMention: (value) => `<button data-file="${value}">${value}</button>` }), "<button data-file=\"src/main.ts\">src/main.ts</button>")
})

Deno.test("renders GFM task-list checkboxes", () => {
  const html = renderMarkdown("- [ ] Pending\n- [x] Done")
  assertIncludes(html, '<input type="checkbox" disabled> Pending')
  assertIncludes(html, '<input type="checkbox" disabled checked> Done')
})
