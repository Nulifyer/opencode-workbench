import MarkdownIt from "markdown-it"

export interface MarkdownRenderOptions {
  fencedCode?: (content: string, language: string) => string
  inlineCode?: (content: string) => string | undefined
  link?: (url: string, title: string) => string
  workspaceMention?: (value: string) => string | undefined
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  )
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string {
  const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })
  renderer.inline.ruler.before("text", "workspace_mention", (state, silent) => {
    const match = /^@<([^>\r\n]+)>/.exec(state.src.slice(state.pos))
    if (!match) return false
    if (!silent) state.push("workspace_mention", "", 0).content = match[1]!
    state.pos += match[0].length
    return true
  })
  renderer.core.ruler.after("inline", "task_lists", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children?.length || token.children[0]!.type !== "text") continue
      const text = token.children[0]!
      const match = /^\[([ xX])\][ \t]+/.exec(text.content)
      if (!match) continue
      text.content = text.content.slice(match[0].length)
      const checkbox = new state.Token("html_inline", "", 0)
      checkbox.content = `<input type="checkbox" disabled${match[1]!.toLowerCase() === "x" ? " checked" : ""}> `
      token.children.unshift(checkbox)
    }
  })
  renderer.validateLink = (target) => safeHttpUrl(target) !== undefined
  renderer.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!
    const language = token.info.trim().split(/\s+/, 1)[0] ?? ""
    return options.fencedCode?.(token.content, language) ??
      `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${
        escapeHtml(token.content)
      }</code></pre>\n`
  }
  renderer.renderer.rules.code_block = (tokens, index) => {
    const content = tokens[index]!.content
    return options.fencedCode?.(content, "") ?? `<pre><code>${escapeHtml(content)}</code></pre>\n`
  }
  renderer.renderer.rules.code_inline = (tokens, index) => {
    const content = tokens[index]!.content
    return options.inlineCode?.(content) ?? `<code>${escapeHtml(content)}</code>`
  }
  renderer.renderer.rules.workspace_mention = (tokens, index) => {
    const content = tokens[index]!.content
    return options.workspaceMention?.(content) ?? escapeHtml(`@<${content}>`)
  }
  renderer.renderer.rules.link_open = (tokens, index) => {
    const token = tokens[index]!
    const url = safeHttpUrl(token.attrGet("href") ?? "")
    if (!url) return "<a>"
    const title = token.attrGet("title") ?? url
    return options.link?.(url, title) ?? `<a href="#" data-url="${escapeHtml(url)}" title="${escapeHtml(title)}">`
  }
  renderer.renderer.rules.table_open = () => '<div class="markdown-table-wrap"><table>'
  renderer.renderer.rules.table_close = () => "</table></div>\n"
  return renderer.render(source.replace(/\r\n/g, "\n"))
}
