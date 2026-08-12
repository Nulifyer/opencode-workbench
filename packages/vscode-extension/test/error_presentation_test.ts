import { assertEquals, assertStringIncludes } from "jsr:@std/assert"
import { isUserCancellation, userFacingError } from "../src/application/error-presentation.ts"

Deno.test("command errors are bounded and redact credential-shaped values", () => {
  const presented = userFacingError(
    new Error(
      "Authorization: \"Bearer abc123\"\nProxy-Authorization: 'Basic proxy-secret'\nCookie: first=one; second=two\npassword=private https://user:pass@example.com/path\nfailed",
    ),
  )
  assertStringIncludes(presented, "Authorization: [redacted]")
  assertStringIncludes(presented, "password=[redacted]")
  assertStringIncludes(presented, "Cookie: [redacted]")
  assertStringIncludes(presented, "Proxy-Authorization: [redacted]")
  assertStringIncludes(presented, "https://[redacted]@example.com/path failed")
  assertEquals(presented.includes("private"), false)
  assertEquals(presented.includes("proxy-secret"), false)
  assertEquals(userFacingError("x".repeat(3_000)).length, 2_000)
})

Deno.test("explicit cancellation can remain quiet", () => {
  assertEquals(isUserCancellation(new Error("Goal verification cancelled")), true)
  assertEquals(isUserCancellation(new Error("Server failed")), false)
})
