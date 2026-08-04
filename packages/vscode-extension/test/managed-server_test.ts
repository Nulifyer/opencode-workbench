import { ManagedOpenCodeServer, executableInvocation, managedConfigContent, parseListeningAddress, parseVersion, resolveOpenCodeExecutable, supportedVersion, windowsTreeKillInvocation } from "../src/managed-server.ts"

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}

Deno.test("validates supported OpenCode versions and listening addresses", () => {
  assertEquals(parseVersion("1.18.8"), [1, 18, 8])
  assertEquals(supportedVersion("1.18.7"), false)
  assertEquals(supportedVersion("1.18.8"), false)
  assertEquals(supportedVersion("1.18.11"), true)
  assertEquals(supportedVersion("1.18.99"), true)
  assertEquals(supportedVersion("1.19.0-beta.1"), false)
  assertEquals(supportedVersion("2.0.0"), false)
  assertEquals(parseListeningAddress("opencode server listening on http://127.0.0.1:4096"), "http://127.0.0.1:4096")
  assertEquals(parseListeningAddress("opencode server listening on http://0.0.0.0:4096"), undefined)
  assertEquals(parseListeningAddress("opencode server listening on http://127.0.0.1:0"), undefined)
})

Deno.test("injects packaged plugin into JSONC without replacing existing configuration", () => {
  const value = JSON.parse(managedConfigContent(`{
    // Existing inline configuration remains active.
    "model": "acme/model",
    "plugin": ["file:///existing.js",],
  }`, "file:///workbench.js"))
  assertEquals(value, { model: "acme/model", plugin: ["file:///existing.js", "file:///workbench.js"] })
  assertEquals(JSON.parse(managedConfigContent('{"plugin":["file:///workbench.js"]}', "file:///workbench.js")).plugin, ["file:///workbench.js"])
  assertEquals(JSON.parse(managedConfigContent('{"plugin":[["file:///configured.js",{"flag":true}]]}', "file:///workbench.js")).plugin, [["file:///configured.js", { flag: true }], "file:///workbench.js"])
  let rejected = false
  try {
    managedConfigContent('{"plugin":"unsafe"}', "file:///workbench.js")
  } catch {
    rejected = true
  }
  assertEquals(rejected, true)
})

Deno.test("requires absolute executable overrides", async () => {
  let rejected = false
  try {
    await resolveOpenCodeExecutable("opencode")
  } catch {
    rejected = true
  }
  assertEquals(rejected, true)
})

Deno.test("runs Windows command shims through the command interpreter", () => {
  assertEquals(executableInvocation("C:\\Program Files\\OpenCode\\opencode.cmd", ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe"), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '""%OPENCODE_WORKBENCH_CMD_ARG_0%" "%OPENCODE_WORKBENCH_CMD_ARG_1%""'],
    env: { OPENCODE_WORKBENCH_CMD_ARG_0: "C:\\Program Files\\OpenCode\\opencode.cmd", OPENCODE_WORKBENCH_CMD_ARG_1: "--version" },
  })
  const percent = executableInvocation("C:\\100% Real\\opencode.cmd", ["%PATH%"], "win32", "cmd.exe")
  assertEquals(percent.env, { OPENCODE_WORKBENCH_CMD_ARG_0: "C:\\100% Real\\opencode.cmd", OPENCODE_WORKBENCH_CMD_ARG_1: "%PATH%" })
  assertEquals(executableInvocation("C:\\OpenCode\\opencode.exe", ["--version"], "win32"), {
    command: "C:\\OpenCode\\opencode.exe",
    args: ["--version"],
  })
  assertEquals(windowsTreeKillInvocation(42), { command: "taskkill.exe", args: ["/pid", "42", "/t"] })
  assertEquals(windowsTreeKillInvocation(42, true), { command: "taskkill.exe", args: ["/pid", "42", "/t", "/f"] })
})

Deno.test({
  name: "starts and stops an authenticated managed server process",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir()
    const extension = `${root}/extension`
    const executable = `${root}/opencode-test`
    await Deno.mkdir(`${extension}/dist`, { recursive: true })
    await Deno.writeTextFile(`${extension}/dist/opencode-plugin.js`, "export default {}\n")
    await Deno.writeTextFile(executable, `#!/usr/bin/env node
const http = require("node:http")
if (process.argv[2] === "--version") { console.log("1.18.11"); process.exit(0) }
if (process.env.OPENCODE_WORKBENCH_BRIDGE_ID !== "bridge-test") process.exit(2)
const expected = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64")
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) { response.writeHead(401); response.end(); return }
  response.writeHead(200, { "Content-Type": "application/json" })
  if (request.url.startsWith("/config/providers")) response.end('{"providers":[]}')
  else if (request.url.startsWith("/api/session/active")) response.end('{"data":{}}')
  else response.end(request.url.startsWith("/config") ? process.env.OPENCODE_CONFIG_CONTENT : "{}")
})
server.listen(0, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + server.address().port))
`)
    await Deno.chmod(executable, 0o700)
    const manager = new ManagedOpenCodeServer({ directory: root, extensionPath: extension, executablePath: executable, bridgeID: "bridge-test" })
    try {
      const connection = await manager.start()
      assertEquals(connection.baseUrl.startsWith("http://127.0.0.1:"), true)
      assertEquals(connection.username.startsWith("workbench-"), true)
      assertEquals(connection.password.length > 32, true)
    } finally {
      await manager.stop()
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: "uses the configured managed server startup timeout",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir()
    const extension = `${root}/extension`
    const executable = `${root}/opencode-test`
    await Deno.mkdir(`${extension}/dist`, { recursive: true })
    await Deno.writeTextFile(`${extension}/dist/opencode-plugin.js`, "export default {}\n")
    await Deno.writeTextFile(executable, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("1.18.11"); process.exit(0) }
setInterval(() => {}, 1000)
`)
    await Deno.chmod(executable, 0o700)
    const manager = new ManagedOpenCodeServer({ directory: root, extensionPath: extension, executablePath: executable, startupTimeoutMilliseconds: 25 })
    try {
      let message = ""
      try {
        await manager.start()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const deadline = /timed out after (\d+)ms/.exec(message)?.[1]
      if (!(deadline && Number(deadline) > 0 && Number(deadline) <= 25) && message !== "Managed OpenCode server did not become ready within 0.025 seconds") {
        throw new Error(`Configured startup deadline was not applied: ${message}`)
      }
    } finally {
      await manager.stop()
      await Deno.remove(root, { recursive: true })
    }
  },
})
