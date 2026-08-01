import { parsePermission, validateServerUrl } from "../src/opencode-client.ts"

function throws(operation: () => void, pattern: RegExp): void {
  try {
    operation()
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return
    throw error
  }
  throw new Error("Expected operation to throw")
}

Deno.test("server URL accepts loopback HTTP and remote HTTPS", () => {
  validateServerUrl("http://127.0.0.1:4096")
  validateServerUrl("http://[::1]:4096")
  validateServerUrl("https://opencode.example.test")
})

Deno.test("server URL rejects credential leaks and remote cleartext", () => {
  throws(() => validateServerUrl("http://192.168.1.20:4096"), /numeric loopback/)
  throws(() => validateServerUrl("http://localhost:4096"), /numeric loopback/)
  throws(() => validateServerUrl("https://user:secret@example.test"), /must not contain credentials/)
})

Deno.test("current permission events expose permission and patterns", () => {
  const permission = parsePermission({
    type: "permission.asked",
    properties: {
      id: "request",
      sessionID: "session",
      permission: "bash",
      patterns: ["rm protected"],
      always: ["bash:*"],
      metadata: { command: "rm protected" },
    },
  })
  if (permission?.type !== "bash" || permission.pattern?.[0] !== "rm protected" || permission.protocol !== "current") {
    throw new Error("Current permission event fields were not preserved")
  }
  const v2 = parsePermission({
    type: "permission.v2.asked",
    properties: {
      id: "request-v2",
      sessionID: "session",
      action: "read",
      resources: [".env"],
      save: ["*.env"],
      metadata: {},
    },
  })
  if (v2?.protocol !== "v2" || v2.always?.[0] !== "*.env") throw new Error("V2 permission scope was not preserved")
  if (parsePermission({ type: "permission.asked", properties: { id: "request", sessionID: "session" } })) {
    throw new Error("Incomplete permission event was accepted")
  }
})
