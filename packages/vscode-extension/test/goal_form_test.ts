import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert"
import {
  addGoalCriterion,
  applyGoalFormPreset,
  createGoalFormDraft,
  GOAL_FORM_LIMITS,
  type GoalFormDraft,
  goalFormMarkup,
  GoalFormValidationError,
  moveGoalCriterion,
  normalizeGoalCriteria,
  removeGoalCriterion,
  serializeGoalFormDraft,
  validateGoalFormDraft,
} from "../src/webview/views/goal-form.ts"

Deno.test("goal form imports row or newline criteria and serializes a bounded host payload", () => {
  assertEquals(normalizeGoalCriteria(" First\r\n\n Second \n", "fallback"), ["First", "Second"])
  assertEquals(normalizeGoalCriteria([], "Fallback criterion"), ["Fallback criterion"])

  const draft = createGoalFormDraft({
    objective: "  Ship the workbench  ",
    acceptanceCriteria: " Tests pass \n\n Evidence is visible ",
    tokenBudget: null,
    maxAutoTurns: 7,
    maxDurationSeconds: null,
    verifier: {
      enabled: true,
      model: "  provider/reviewer  ",
      agent: "  review  ",
      timeoutMilliseconds: 9_000,
      repeatedBlockThreshold: 2,
    },
    settlementGeneration: 9,
  })

  assertEquals(draft.criteria.map((criterion) => criterion.value), ["Tests pass", "Evidence is visible"])
  assertEquals(serializeGoalFormDraft(draft), {
    expectedSettlementGeneration: 9,
    objective: "Ship the workbench",
    acceptanceCriteria: ["Tests pass", "Evidence is visible"],
    tokenBudget: null,
    maxAutoTurns: 7,
    maxDurationSeconds: null,
    verifier: {
      enabled: true,
      model: "provider/reviewer",
      agent: "review",
      timeoutMilliseconds: 9_000,
      repeatedBlockThreshold: 2,
    },
  })
})

Deno.test("goal form presets and criterion row helpers remain immutable and bounded", () => {
  const original = createGoalFormDraft({
    objective: "Ship",
    acceptanceCriteria: ["One", "Two"],
    tokenBudget: null,
    maxAutoTurns: null,
    maxDurationSeconds: null,
    verifier: { model: "model", agent: "agent" },
    settlementGeneration: 4,
  })
  const quick = applyGoalFormPreset(original, "quick")
  assertEquals(quick.tokenBudget, { unlimited: false, value: "20000" })
  assertEquals(quick.maxAutoTurns, { unlimited: false, value: "4" })
  assertEquals(quick.maxDurationSeconds, { unlimited: false, value: "900" })
  assertEquals(quick.verifierTimeoutMilliseconds, "45000")
  assertEquals(quick.repeatedBlockThreshold, "2")
  assertEquals(quick.verifierEnabled, true)
  assertEquals(quick.verifierModel, "model")
  assertEquals(quick.verifierAgent, "agent")
  assertEquals(quick.expectedSettlementGeneration, 4)
  assertEquals(original.tokenBudget, { unlimited: true, value: "" })

  const thorough = applyGoalFormPreset(original, "thorough")
  assertEquals(thorough.tokenBudget.value, "250000")
  assertEquals(thorough.maxAutoTurns.value, "30")
  assertEquals(thorough.maxDurationSeconds.value, "10800")

  const added = addGoalCriterion(original, "Three")
  assertEquals(added.criteria.map((criterion) => [criterion.id, criterion.value]), [
    ["criterion-1", "One"],
    ["criterion-2", "Two"],
    ["criterion-3", "Three"],
  ])
  const moved = moveGoalCriterion(added, "criterion-3", -1)
  assertEquals(moved.criteria.map((criterion) => criterion.value), ["One", "Three", "Two"])
  assertEquals(removeGoalCriterion(moved, "criterion-3").criteria.map((criterion) => criterion.value), ["One", "Two"])

  const one = createGoalFormDraft({ objective: "Only", acceptanceCriteria: ["Only"] })
  assertEquals(removeGoalCriterion(one, "criterion-1"), one)
  const full: GoalFormDraft = {
    ...one,
    criteria: Array.from(
      { length: GOAL_FORM_LIMITS.criteria },
      (_, index) => ({ id: `row-${index}`, value: `Criterion ${index}` }),
    ),
  }
  assertEquals(addGoalCriterion(full, "Overflow"), full)
})

Deno.test("goal form validation reports every bounded field and rejects stale settlement data", () => {
  const invalid: GoalFormDraft = {
    ...createGoalFormDraft({ objective: "Ship", acceptanceCriteria: ["Done"] }),
    objective: " ",
    criteria: [
      { id: "duplicate", value: "" },
      { id: "duplicate", value: "x".repeat(GOAL_FORM_LIMITS.criterionCharacters + 1) },
    ],
    tokenBudget: { unlimited: false, value: "0" },
    maxAutoTurns: { unlimited: false, value: "1.5" },
    maxDurationSeconds: { unlimited: false, value: String(GOAL_FORM_LIMITS.numericMaximum + 1) },
    verifierModel: "m".repeat(GOAL_FORM_LIMITS.verifierIdentifierCharacters + 1),
    verifierAgent: "a".repeat(GOAL_FORM_LIMITS.verifierIdentifierCharacters + 1),
    verifierTimeoutMilliseconds: String(GOAL_FORM_LIMITS.verifierTimeoutMinimum - 1),
    repeatedBlockThreshold: String(GOAL_FORM_LIMITS.repeatedBlockMaximum + 1),
    expectedSettlementGeneration: -1,
  }
  const validation = validateGoalFormDraft(invalid)
  const fields = new Set(validation.errors.map((error) => error.field))
  assertEquals(validation.valid, false)
  for (
    const field of [
      "objective",
      "criterion:duplicate",
      "tokenBudget",
      "maxAutoTurns",
      "maxDurationSeconds",
      "verifierModel",
      "verifierAgent",
      "verifierTimeoutMilliseconds",
      "repeatedBlockThreshold",
      "expectedSettlementGeneration",
    ]
  ) assert(fields.has(field), `Expected validation error for ${field}`)

  assertThrows(
    () => serializeGoalFormDraft(invalid),
    GoalFormValidationError,
    "Enter a goal objective",
  )
})

Deno.test("goal form markup escapes draft and catalog content and exposes accessible controls", () => {
  const draft = createGoalFormDraft({
    objective: '<img src=x onerror="boom"> Ship',
    acceptanceCriteria: ['No <script>alert("x")</script>'],
    tokenBudget: null,
    maxAutoTurns: null,
    maxDurationSeconds: null,
    verifier: {
      enabled: true,
      model: 'provider/model"><img src=x>',
      agent: "review-agent",
      timeoutMilliseconds: 60_000,
      repeatedBlockThreshold: 3,
    },
    settlementGeneration: 7,
  })
  draft.criteria[0]!.id = 'row" data-injected="true'
  const markup = goalFormMarkup(draft, {
    models: [{ value: 'provider/model"><img src=x>', label: "Model <fast>", description: 'The "best" one' }],
    agents: [{ value: "review-agent", label: "Reviewer & auditor" }],
  })

  assert(!markup.includes("<img"))
  assert(!markup.includes("<script"))
  assert(!markup.includes('data-injected="true"'))
  assertStringIncludes(markup, "&lt;img src=x onerror=&quot;boom&quot;&gt; Ship")
  assertStringIncludes(markup, "No &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
  assertStringIncludes(markup, "Model &lt;fast&gt; · The &quot;best&quot; one")
  assertStringIncludes(markup, 'data-goal-preset="quick"')
  assertStringIncludes(markup, 'data-goal-preset="bounded"')
  assertStringIncludes(markup, 'data-goal-preset="thorough"')
  assertStringIncludes(markup, 'name="expectedSettlementGeneration" value="7"')
  assertStringIncludes(markup, 'name="verifierEnabled" checked')
  assertStringIncludes(markup, 'class="goal-unlimited-warning" role="status"')
  assertStringIncludes(markup, 'data-goal-form-action="verify"')
  assert(!markup.includes('role="alert"'))

  const invalidMarkup = goalFormMarkup(createGoalFormDraft())
  assertStringIncludes(invalidMarkup, 'role="alert"')
  assertStringIncludes(invalidMarkup, 'aria-invalid="true"')
  assertStringIncludes(invalidMarkup, 'aria-describedby="goal-form-validation-note"')
})
