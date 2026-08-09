import { assertEquals, assertRejects } from "jsr:@std/assert"
import { executeAndCaptureTask, type TaskProcessEvent } from "../src/application/task-evidence-service.ts"

Deno.test("task evidence subscribes before execution and captures an immediate completion", async () => {
  const execution = {}
  let listener!: (event: TaskProcessEvent<object>) => void
  let disposed = false
  const result = await executeAndCaptureTask(async () => {
    listener({ execution, exitCode: 0 })
    return execution
  }, (next) => {
    listener = next
    return { dispose: () => { disposed = true } }
  }, 1_000)
  assertEquals(result, 0)
  assertEquals(disposed, true)
})

Deno.test("task evidence cleans up failed starts and timeouts", async () => {
  let disposals = 0
  const subscribe = (_listener: (event: TaskProcessEvent<object>) => void) => ({ dispose: () => { disposals++ } })
  await assertRejects(() => executeAndCaptureTask(async () => { throw new Error("start failed") }, subscribe, 1_000), Error, "start failed")
  await assertRejects(() => executeAndCaptureTask(async () => ({}), subscribe, 1), Error, "timed out")
  assertEquals(disposals, 2)
})
