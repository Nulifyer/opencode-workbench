import path from "node:path"
import { fileURLToPath } from "node:url"
import { ManagedOpenCodeServer } from "../src/managed-server.ts"
import { OpenCodeClient } from "../src/opencode-client.ts"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => resolve = next)
  return { promise, resolve }
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("OPENCODE_") || /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|API)/i.test(key)) delete environment[key]
  }
  environment.HOME = path.join(root, "home")
  environment.XDG_CONFIG_HOME = path.join(root, "config")
  environment.XDG_DATA_HOME = path.join(root, "data")
  environment.XDG_CACHE_HOME = path.join(root, "cache")
  environment.XDG_STATE_HOME = path.join(root, "state")
  return environment
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds)),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

Deno.test("installed OpenCode serves Workbench contracts without a model prompt", async () => {
  const integrationExecutable = Deno.env.get("OPENCODE_INTEGRATION_EXECUTABLE")
  if (!integrationExecutable) throw new Error("Set OPENCODE_INTEGRATION_EXECUTABLE to an absolute OpenCode executable path")
  const expectedVersion = Deno.env.get("OPENCODE_INTEGRATION_VERSION") ?? "1.18.11"
  const root = await Deno.makeTempDir({ prefix: "opencode-workbench-real-" })
  const workspace = path.join(root, "workspace")
  await Deno.mkdir(workspace)
  const extensionPath = fileURLToPath(new URL("../../../", import.meta.url))
  const output: string[] = []
  const manager = new ManagedOpenCodeServer({
    directory: workspace,
    extensionPath,
    executablePath: integrationExecutable,
    environment: isolatedEnvironment(root),
    output: { appendLine: (line) => output.push(line) },
  })
  let client: OpenCodeClient | undefined
  let createdID: string | undefined
  let forkedID: string | undefined
  let failure: unknown
  const streamAbort = new AbortController()
  try {
    const connection = await manager.start()
    client = new OpenCodeClient(connection)
    const health = await client.health()
    if (health.version !== expectedVersion) throw new Error(`Expected OpenCode ${expectedVersion}, received ${health.version}`)
    const formatterStatus = await client.formatter()
    const mcpStatus = await client.mcp()
    if (!Array.isArray(formatterStatus) || !formatterStatus.every((formatter) => typeof formatter === "object" && formatter !== null &&
      "name" in formatter && typeof formatter.name === "string" && "extensions" in formatter && Array.isArray(formatter.extensions) &&
      "enabled" in formatter && typeof formatter.enabled === "boolean") || typeof mcpStatus !== "object" || mcpStatus === null || Array.isArray(mcpStatus)) {
      throw new Error("OpenCode returned an incompatible formatter or MCP status contract")
    }

    const opened = deferred<void>()
    const createdEvent = deferred<string>()
    const stream = client.events(
      streamAbort.signal,
      () => opened.resolve(undefined),
      (event) => {
        const info = event.properties.info
        if (event.type === "session.created" && typeof info === "object" && info && "id" in info && typeof info.id === "string") createdEvent.resolve(info.id)
      },
    ).catch((error) => {
      if (!streamAbort.signal.aborted) throw error
    })
    await within(opened.promise)
    const created = await client.createSession("Workbench integration")
    createdID = created.id
    if (await within(createdEvent.promise) !== created.id) throw new Error("OpenCode SSE did not report the created session")
    const renamed = await client.renameSession(created.id, "Workbench integration renamed")
    if (renamed.title !== "Workbench integration renamed") throw new Error("OpenCode did not return the renamed session")
    const forked = await client.forkSession(created.id)
    forkedID = forked.id
    if (forked.id === created.id) throw new Error("OpenCode fork reused the source session ID")
    const listed = await client.listSessions()
    if (!listed.some((session) => session.id === created.id) || !listed.some((session) => session.id === forked.id)) {
      throw new Error("OpenCode session listing omitted a created or forked session")
    }
    const history = await client.messageHistory(created.id)
    if (history.messages.length || history.legacyMessageIDs.length || history.v2MessageIDs.length) throw new Error("New OpenCode session unexpectedly contained messages")
    if (await client.deleteSession(forked.id) !== true || await client.deleteSession(created.id) !== true) throw new Error("OpenCode did not delete integration sessions")
    forkedID = undefined
    createdID = undefined
    streamAbort.abort()
    await stream
  } catch (error) {
    failure = new Error(`${error instanceof Error ? error.message : String(error)}\nManaged OpenCode output:\n${output.join("\n")}`)
  } finally {
    const cleanupErrors: unknown[] = []
    streamAbort.abort()
    if (client && forkedID) await client.deleteSession(forkedID).catch((error) => cleanupErrors.push(error))
    if (client && createdID) await client.deleteSession(createdID).catch((error) => cleanupErrors.push(error))
    await manager.stop().catch((error) => cleanupErrors.push(error))
    await Deno.remove(root, { recursive: true }).catch((error) => cleanupErrors.push(error))
    if (cleanupErrors.length) {
      const cleanupFailure = new AggregateError(cleanupErrors, "Real integration cleanup failed")
      failure = failure ? new AggregateError([failure, cleanupFailure], "Real integration and cleanup failed") : cleanupFailure
    }
  }
  if (failure) throw failure
})
