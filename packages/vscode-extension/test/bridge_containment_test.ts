import { assertEquals } from "jsr:@std/assert@1"
import { bridgeContextIsContained, pathIsContained } from "../src/application/bridge-containment.ts"

Deno.test("worktree bridge rejects root-checkout and sibling-worktree contexts", async () => {
  const parent = await Deno.makeTempDir()
  try {
    const root = `${parent}/root`
    const run = `${parent}/run`
    const nested = `${run}/src`
    await Deno.mkdir(root)
    await Deno.mkdir(nested, { recursive: true })
    const runReal = await Deno.realPath(run)

    assertEquals(await bridgeContextIsContained(runReal, { worktree: run, directory: nested }), true)
    assertEquals(await bridgeContextIsContained(runReal, { worktree: root, directory: root }), false)
    assertEquals(await bridgeContextIsContained(runReal, { worktree: run, directory: root }), false)
    assertEquals(pathIsContained(runReal, `${runReal}/src/file.ts`), true)
    assertEquals(pathIsContained(runReal, `${parent}/root/file.ts`), false)
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})

Deno.test("worktree bridge resolves symlinks before containment", async () => {
  const parent = await Deno.makeTempDir()
  try {
    const run = `${parent}/run`
    const outside = `${parent}/outside`
    await Deno.mkdir(run)
    await Deno.mkdir(outside)
    await Deno.symlink(outside, `${run}/escape`)
    const runReal = await Deno.realPath(run)
    assertEquals(await bridgeContextIsContained(runReal, { worktree: run, directory: `${run}/escape` }), false)
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})
