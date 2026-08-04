import { fzfScore, prepareFzf, rankFzf, rankPreparedFzf, workspaceSearchPaths } from "../src/fuzzy.ts"

Deno.test("fzf ranking is case-insensitive and rewards basename prefixes", () => {
  const ranked = rankFzf("read", ["src/thread.ts", "docs/reading-list.md", "README.md", "packages/reader.ts"])
  if (ranked[0] !== "README.md" || !ranked.includes("docs/reading-list.md")) throw new Error(`Unexpected fuzzy order: ${ranked.join(", ")}`)
})

Deno.test("fzf ranking supports sparse path queries and rejects missing characters", () => {
  const ranked = rankFzf("svct", ["src/views/chat-view.ts", "src/session-controller.ts", "README.md"])
  if (ranked[0] !== "src/views/chat-view.ts" || fzfScore("xyz", "README.md") !== undefined) throw new Error("Fuzzy subsequence matching failed")
})

Deno.test("prepared fzf indexes preserve deterministic bounded ranking", () => {
  const candidates = ["src/model.ts", "src/model.test.ts", "README.md", "docs/models.md", "src/Model.ts"]
  const prepared = prepareFzf(candidates)
  const expected = rankFzf("mod", candidates, 3)
  if (JSON.stringify(rankPreparedFzf("mod", prepared, 3)) !== JSON.stringify(expected)) throw new Error("Prepared ranking changed results")
  if (rankPreparedFzf("mod", prepared, 0).length !== 0) throw new Error("Prepared ranking ignored zero limit")
})

Deno.test("workspace search includes parent directories as mention targets", () => {
  const paths = workspaceSearchPaths([
    "packages/vscode-extension/src/index.ts",
    "packages/shared/src/index.ts",
  ])
  for (const expected of ["packages/vscode-extension", "packages/vscode-extension/src", "packages", "packages/shared"]) {
    if (!paths.includes(expected)) throw new Error(`Missing workspace directory: ${expected}`)
  }
  const ranked = rankFzf("vscode-extension", paths)
  if (ranked[0] !== "packages/vscode-extension") throw new Error(`Folder was not the best mention match: ${ranked.join(", ")}`)
})

Deno.test("workspace search does not invent prefix paths for root files", () => {
  const paths = workspaceSearchPaths(["README.md", "src/main.ts"])
  if (!paths.includes("README.md") || !paths.includes("src") || paths.some((value) =>
    (value !== "README.md" && "README.md".startsWith(value)) || (value !== "src" && "src".startsWith(value))
  )) {
    throw new Error(`Workspace search invented a root-file prefix: ${paths.join(", ")}`)
  }
})
