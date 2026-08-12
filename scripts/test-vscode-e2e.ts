import { runTests } from "@vscode/test-electron"
import { build } from "esbuild"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startSyntheticOpenCodeServer } from "../packages/vscode-extension/test/e2e/synthetic-opencode-server.ts"

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)))
const extensionDevelopmentPath = path.join(repository, "packages", "vscode-extension")
const extensionTestsSource = path.join(extensionDevelopmentPath, "test", "e2e", "index.ts")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-workbench-vscode-e2e-"))
const extensionTestsPath = path.join(root, "extension-tests.cjs")
const workspace = path.join(root, "workspace")
const userData = path.join(root, "user-data")
const extensions = path.join(root, "extensions")
const environmentFile = path.join(root, "server.env")

let failure: unknown
let server: Awaited<ReturnType<typeof startSyntheticOpenCodeServer>> | undefined
try {
  server = await startSyntheticOpenCodeServer()
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(path.join(userData, "User"), { recursive: true }),
    fs.mkdir(extensions, { recursive: true }),
  ])
  await build({
    entryPoints: [extensionTestsSource],
    outfile: extensionTestsPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
  })
  const settings = {
    "opencodeWorkbench.serverMode": "external",
    "opencodeWorkbench.serverUrl": server.url,
    "opencodeWorkbench.serverUsername": server.username,
    "opencodeWorkbench.serverEnvironmentFile": environmentFile,
  }
  await Promise.all([
    fs.writeFile(path.join(userData, "User", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`),
    fs.writeFile(environmentFile, `OPENCODE_SERVER_PASSWORD=${server.password}\n`, { mode: 0o600 }),
  ])

  await runTests({
    version: process.env.VSCODE_E2E_VERSION ?? "1.106.0",
    vscodeExecutablePath: process.env.VSCODE_E2E_EXECUTABLE || undefined,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      "--disable-extensions",
      "--disable-workspace-trust",
    ],
    extensionTestsEnv: {
      ELECTRON_RUN_AS_NODE: undefined,
      OPENCODE_WORKBENCH_E2E_SERVER_URL: server.url,
      OPENCODE_WORKBENCH_E2E_SERVER_USERNAME: server.username,
      OPENCODE_WORKBENCH_E2E_SERVER_PASSWORD: server.password,
    },
  })
} catch (error) {
  failure = error
} finally {
  const cleanupErrors: unknown[] = []
  await server?.close().catch((error) => cleanupErrors.push(error))
  await fs.rm(root, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error))
  if (cleanupErrors.length) {
    const cleanupFailure = new AggregateError(cleanupErrors, "VS Code E2E cleanup failed")
    failure = failure
      ? new AggregateError([failure, cleanupFailure], "VS Code E2E run and cleanup failed")
      : cleanupFailure
  }
}
if (failure) throw failure
