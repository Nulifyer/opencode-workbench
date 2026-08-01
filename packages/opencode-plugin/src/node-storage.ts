import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AtomicAdapter } from "./atomic-store.ts"

const MAX_STATE_BYTES = 2 * 1024 * 1024
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

export function dataDirectory(environment: Record<string, string | undefined> = process.env): string {
  return join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-workbench")
}

export class NodeAtomicAdapter implements AtomicAdapter {
  async prepare(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  }

  async read(path: string): Promise<string | undefined> {
    try {
      const info = await stat(path)
      if (info.size > MAX_STATE_BYTES) throw new Error("opencode-workbench state exceeds the size limit")
      return await readFile(path, "utf8")
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    }
  }

  async writeExclusive(path: string, contents: string): Promise<void> {
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("opencode-workbench state exceeds the size limit")
    await this.prepare(path)
    const file = await open(path, "wx", 0o600)
    try {
      await file.writeFile(contents, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true })
  }

  async acquireLock(path: string): Promise<() => Promise<void>> {
    await this.prepare(path)
    const started = Date.now()
    const owner = `${process.pid}:${crypto.randomUUID()}`
    const ownerPath = join(path, "owner")
    while (true) {
      try {
        await mkdir(path, { mode: 0o700 })
        const file = await open(ownerPath, "wx", 0o600)
        await file.writeFile(owner, "utf8")
        await file.close()
        return async () => {
          const current = await readFile(ownerPath, "utf8").catch(() => "")
          if (current === owner) await this.remove(path)
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
        const info = await stat(path).catch(() => undefined)
        const currentOwner = await readFile(ownerPath, "utf8").catch(() => "")
        const ownerPid = Number(currentOwner.split(":", 1)[0])
        const stale = info && Date.now() - info.mtimeMs > LOCK_STALE_MS
        if (stale && (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid))) {
          const confirmedOwner = await readFile(ownerPath, "utf8").catch(() => "")
          if (confirmedOwner !== currentOwner) continue
          const quarantine = `${path}.stale-${crypto.randomUUID()}`
          try {
            await rename(path, quarantine)
            await this.remove(quarantine)
          } catch (takeoverError) {
            if (errorCode(takeoverError) !== "ENOENT") throw takeoverError
          }
          continue
        }
        if (Date.now() - started >= LOCK_WAIT_MS) throw new Error("Timed out waiting for the state lock")
        await sleep(20)
      }
    }
  }
}
