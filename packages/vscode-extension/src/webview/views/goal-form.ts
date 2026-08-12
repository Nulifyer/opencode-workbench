export type GoalFormPreset = "quick" | "bounded" | "thorough"

export interface GoalLimitDraft {
  unlimited: boolean
  value: string
}

export interface GoalCriterionDraft {
  id: string
  value: string
}

export interface GoalFormDraft {
  objective: string
  criteria: GoalCriterionDraft[]
  tokenBudget: GoalLimitDraft
  maxAutoTurns: GoalLimitDraft
  maxDurationSeconds: GoalLimitDraft
  verifierEnabled: boolean
  verifierModel: string
  verifierAgent: string
  verifierTimeoutMilliseconds: string
  repeatedBlockThreshold: string
  expectedSettlementGeneration: number
}

export interface GoalFormSource {
  objective?: string
  /** Rows from a projection, or newline-delimited text from a lightweight host. */
  acceptanceCriteria?: readonly string[] | string
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
  verifier?: {
    enabled?: boolean
    model?: string | null
    agent?: string | null
    timeoutMilliseconds?: number
    repeatedBlockThreshold?: number
  }
  settlementGeneration?: number
}

export interface GoalFormOption {
  value: string
  label: string
  description?: string
}

export interface GoalFormRenderOptions {
  models?: readonly GoalFormOption[]
  agents?: readonly GoalFormOption[]
}

export interface GoalFormError {
  field: string
  message: string
}

export interface GoalFormValidation {
  valid: boolean
  errors: GoalFormError[]
}

export interface GoalConfigurationPayload {
  expectedSettlementGeneration: number
  objective: string
  acceptanceCriteria: string[]
  tokenBudget: number | null
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  verifier: {
    enabled: boolean
    model: string | null
    agent: string | null
    timeoutMilliseconds: number
    repeatedBlockThreshold: number
  }
}

export const GOAL_FORM_LIMITS = {
  objectiveCharacters: 4_000,
  criteria: 100,
  criterionCharacters: 2_000,
  numericMaximum: 1_000_000_000,
  verifierIdentifierCharacters: 1_024,
  verifierTimeoutMinimum: 1_000,
  verifierTimeoutMaximum: 300_000,
  repeatedBlockMinimum: 1,
  repeatedBlockMaximum: 10,
} as const

const PRESETS: Record<GoalFormPreset, {
  tokenBudget: number
  maxAutoTurns: number
  maxDurationSeconds: number
  verifierTimeoutMilliseconds: number
  repeatedBlockThreshold: number
}> = {
  quick: {
    tokenBudget: 20_000,
    maxAutoTurns: 4,
    maxDurationSeconds: 900,
    verifierTimeoutMilliseconds: 45_000,
    repeatedBlockThreshold: 2,
  },
  bounded: {
    tokenBudget: 100_000,
    maxAutoTurns: 12,
    maxDurationSeconds: 3_600,
    verifierTimeoutMilliseconds: 60_000,
    repeatedBlockThreshold: 3,
  },
  thorough: {
    tokenBudget: 250_000,
    maxAutoTurns: 30,
    maxDurationSeconds: 10_800,
    verifierTimeoutMilliseconds: 120_000,
    repeatedBlockThreshold: 3,
  },
}

export class GoalFormValidationError extends Error {
  constructor(readonly errors: GoalFormError[]) {
    super(errors.map((error) => error.message).join("; "))
    this.name = "GoalFormValidationError"
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  )
}

function characters(value: string): number {
  return [...value].length
}

function limitDraft(value: number | null | undefined): GoalLimitDraft {
  return value === null || value === undefined
    ? { unlimited: true, value: "" }
    : { unlimited: false, value: String(value) }
}

function criterionID(index: number): string {
  return `criterion-${index + 1}`
}

/** Converts projected rows or newline-delimited entry into editable rows. */
export function normalizeGoalCriteria(criteria: readonly string[] | string | undefined, fallback: string): string[] {
  const values = typeof criteria === "string" ? criteria.split(/\r?\n/) : criteria ? [...criteria] : []
  const normalized = values.map((value) => value.trim()).filter(Boolean)
  return normalized.length ? normalized.slice(0, GOAL_FORM_LIMITS.criteria) : [fallback]
}

/** Creates an editable form draft from the bounded goal projection. */
export function createGoalFormDraft(source: GoalFormSource = {}): GoalFormDraft {
  const objective = source.objective ?? ""
  const criteria = normalizeGoalCriteria(source.acceptanceCriteria, objective)
  return {
    objective,
    criteria: criteria.slice(0, GOAL_FORM_LIMITS.criteria).map((value, index) => ({ id: criterionID(index), value })),
    tokenBudget: limitDraft(source.tokenBudget),
    maxAutoTurns: limitDraft(source.maxAutoTurns),
    maxDurationSeconds: limitDraft(source.maxDurationSeconds),
    verifierEnabled: source.verifier?.enabled === true,
    verifierModel: source.verifier?.model ?? "",
    verifierAgent: source.verifier?.agent ?? "",
    verifierTimeoutMilliseconds: String(source.verifier?.timeoutMilliseconds ?? 60_000),
    repeatedBlockThreshold: String(source.verifier?.repeatedBlockThreshold ?? 3),
    expectedSettlementGeneration: source.settlementGeneration ?? 0,
  }
}

/** Applies a preset without replacing the objective, criteria, or verifier identity. */
export function applyGoalFormPreset(draft: GoalFormDraft, preset: GoalFormPreset): GoalFormDraft {
  const values = PRESETS[preset]
  return {
    ...draft,
    criteria: draft.criteria.map((criterion) => ({ ...criterion })),
    tokenBudget: { unlimited: false, value: String(values.tokenBudget) },
    maxAutoTurns: { unlimited: false, value: String(values.maxAutoTurns) },
    maxDurationSeconds: { unlimited: false, value: String(values.maxDurationSeconds) },
    verifierEnabled: true,
    verifierTimeoutMilliseconds: String(values.verifierTimeoutMilliseconds),
    repeatedBlockThreshold: String(values.repeatedBlockThreshold),
  }
}

export function addGoalCriterion(draft: GoalFormDraft, value = ""): GoalFormDraft {
  if (draft.criteria.length >= GOAL_FORM_LIMITS.criteria) return draft
  const existing = new Set(draft.criteria.map((criterion) => criterion.id))
  let index = draft.criteria.length + 1
  while (existing.has(`criterion-${index}`)) index += 1
  return {
    ...draft,
    criteria: [...draft.criteria.map((criterion) => ({ ...criterion })), { id: `criterion-${index}`, value }],
  }
}

export function removeGoalCriterion(draft: GoalFormDraft, id: string): GoalFormDraft {
  if (draft.criteria.length <= 1) return draft
  return {
    ...draft,
    criteria: draft.criteria.filter((criterion) => criterion.id !== id).map((criterion) => ({ ...criterion })),
  }
}

export function moveGoalCriterion(draft: GoalFormDraft, id: string, direction: -1 | 1): GoalFormDraft {
  const criteria = draft.criteria.map((criterion) => ({ ...criterion }))
  const index = criteria.findIndex((criterion) => criterion.id === id)
  const next = index + direction
  if (index < 0 || next < 0 || next >= criteria.length) return draft
  ;[criteria[index], criteria[next]] = [criteria[next]!, criteria[index]!]
  return { ...draft, criteria }
}

function parsePositiveInteger(
  field: string,
  label: string,
  value: string,
  minimum: number,
  maximum: number,
  errors: GoalFormError[],
): number | undefined {
  const normalized = value.trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    errors.push({ field, message: `${label} must be a positive integer.` })
    return undefined
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push({
      field,
      message: `${label} must be between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}.`,
    })
    return undefined
  }
  return parsed
}

function parseLimit(
  field: string,
  label: string,
  draft: GoalLimitDraft,
  errors: GoalFormError[],
): number | null | undefined {
  return draft.unlimited
    ? null
    : parsePositiveInteger(field, label, draft.value, 1, GOAL_FORM_LIMITS.numericMaximum, errors)
}

function normalizedIdentifier(field: string, label: string, value: string, errors: GoalFormError[]): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (characters(normalized) > GOAL_FORM_LIMITS.verifierIdentifierCharacters) {
    errors.push({
      field,
      message: `${label} must be at most ${GOAL_FORM_LIMITS.verifierIdentifierCharacters.toLocaleString()} characters.`,
    })
    return null
  }
  return normalized
}

function configuration(draft: GoalFormDraft): { payload?: GoalConfigurationPayload; errors: GoalFormError[] } {
  const errors: GoalFormError[] = []
  const objective = draft.objective.trim()
  if (!objective) errors.push({ field: "objective", message: "Enter a goal objective." })
  else if (characters(objective) > GOAL_FORM_LIMITS.objectiveCharacters) {
    errors.push({
      field: "objective",
      message: `Goal objective must be at most ${GOAL_FORM_LIMITS.objectiveCharacters.toLocaleString()} characters.`,
    })
  }

  if (!draft.criteria.length) {
    errors.push({ field: "criteria", message: "Add at least one independently checkable acceptance criterion." })
  }
  if (draft.criteria.length > GOAL_FORM_LIMITS.criteria) {
    errors.push({ field: "criteria", message: `Use at most ${GOAL_FORM_LIMITS.criteria} acceptance criteria.` })
  }
  const ids = new Set<string>()
  const acceptanceCriteria = draft.criteria.map((criterion, index) => {
    const field = `criterion:${criterion.id || index}`
    if (!criterion.id || ids.has(criterion.id)) {
      errors.push({ field, message: `Acceptance criterion ${index + 1} has an invalid row identity.` })
    }
    ids.add(criterion.id)
    const normalized = criterion.value.trim()
    if (!normalized) errors.push({ field, message: `Acceptance criterion ${index + 1} must not be empty.` })
    else if (characters(normalized) > GOAL_FORM_LIMITS.criterionCharacters) {
      errors.push({
        field,
        message: `Acceptance criterion ${
          index + 1
        } must be at most ${GOAL_FORM_LIMITS.criterionCharacters.toLocaleString()} characters.`,
      })
    }
    return normalized
  })

  const tokenBudget = parseLimit("tokenBudget", "Token budget", draft.tokenBudget, errors)
  const maxAutoTurns = parseLimit("maxAutoTurns", "Auto-turn limit", draft.maxAutoTurns, errors)
  const maxDurationSeconds = parseLimit("maxDurationSeconds", "Duration limit", draft.maxDurationSeconds, errors)
  const verifierModel = normalizedIdentifier("verifierModel", "Verifier model", draft.verifierModel, errors)
  const verifierAgent = normalizedIdentifier("verifierAgent", "Verifier agent", draft.verifierAgent, errors)
  const verifierTimeoutMilliseconds = parsePositiveInteger(
    "verifierTimeoutMilliseconds",
    "Verifier timeout",
    draft.verifierTimeoutMilliseconds,
    GOAL_FORM_LIMITS.verifierTimeoutMinimum,
    GOAL_FORM_LIMITS.verifierTimeoutMaximum,
    errors,
  )
  const repeatedBlockThreshold = parsePositiveInteger(
    "repeatedBlockThreshold",
    "Repeated blocked-verdict threshold",
    draft.repeatedBlockThreshold,
    GOAL_FORM_LIMITS.repeatedBlockMinimum,
    GOAL_FORM_LIMITS.repeatedBlockMaximum,
    errors,
  )
  if (!Number.isSafeInteger(draft.expectedSettlementGeneration) || draft.expectedSettlementGeneration < 0) {
    errors.push({
      field: "expectedSettlementGeneration",
      message: "Goal settlement generation is invalid; refresh the goal before saving.",
    })
  }

  if (
    errors.length || tokenBudget === undefined || maxAutoTurns === undefined || maxDurationSeconds === undefined ||
    verifierTimeoutMilliseconds === undefined || repeatedBlockThreshold === undefined
  ) return { errors }
  return {
    errors,
    payload: {
      expectedSettlementGeneration: draft.expectedSettlementGeneration,
      objective,
      acceptanceCriteria,
      tokenBudget,
      maxAutoTurns,
      maxDurationSeconds,
      verifier: {
        enabled: draft.verifierEnabled,
        model: verifierModel,
        agent: verifierAgent,
        timeoutMilliseconds: verifierTimeoutMilliseconds,
        repeatedBlockThreshold,
      },
    },
  }
}

export function validateGoalFormDraft(draft: GoalFormDraft): GoalFormValidation {
  const result = configuration(draft)
  return { valid: result.errors.length === 0, errors: result.errors }
}

/** Produces the structured, host-ready configuration or throws with field errors. */
export function serializeGoalFormDraft(draft: GoalFormDraft): GoalConfigurationPayload {
  const result = configuration(draft)
  if (!result.payload) throw new GoalFormValidationError(result.errors)
  return result.payload
}

function selected(value: string, current: string): string {
  return value === current ? " selected" : ""
}

function optionMarkup(options: readonly GoalFormOption[], current: string, emptyLabel: string): string {
  const known = new Set(options.map((option) => option.value))
  const retained = current && !known.has(current)
    ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (current)</option>`
    : ""
  return `<option value=""${selected("", current)}>${escapeHtml(emptyLabel)}</option>${retained}${
    options.map((option) => {
      const detail = option.description ? ` · ${option.description}` : ""
      return `<option value="${escapeHtml(option.value)}"${selected(option.value, current)}>${
        escapeHtml(`${option.label}${detail}`)
      }</option>`
    }).join("")
  }`
}

function firstError(errors: readonly GoalFormError[], field: string): GoalFormError | undefined {
  return errors.find((error) => error.field === field)
}

function errorAttributes(error: GoalFormError | undefined, id: string): string {
  return error ? ` aria-invalid="true" aria-describedby="${id}"` : ""
}

function inlineError(error: GoalFormError | undefined, id: string): string {
  return error ? `<small id="${id}" class="goal-form-error">${escapeHtml(error.message)}</small>` : ""
}

function limitMarkup(
  key: "tokenBudget" | "maxAutoTurns" | "maxDurationSeconds",
  label: string,
  unit: string,
  value: GoalLimitDraft,
  errors: readonly GoalFormError[],
): string {
  const error = firstError(errors, key)
  const errorID = `goal-${key}-error`
  return `<div class="goal-limit" data-goal-limit="${key}"><label for="goal-${key}">${
    escapeHtml(label)
  }</label><div class="goal-limit-controls"><input id="goal-${key}" name="${key}" type="number" inputmode="numeric" min="1" max="${GOAL_FORM_LIMITS.numericMaximum}" value="${
    escapeHtml(value.value)
  }"${value.unlimited ? " disabled" : ""}${errorAttributes(error, errorID)}><span>${
    escapeHtml(unit)
  }</span><label class="goal-unlimited"><input type="checkbox" data-goal-unlimited="${key}"${
    value.unlimited ? " checked" : ""
  }> Unlimited</label></div>${inlineError(error, errorID)}</div>`
}

/** Renders escaped, accessible markup without attaching DOM behavior. */
export function goalFormMarkup(draft: GoalFormDraft, options: GoalFormRenderOptions = {}): string {
  const validation = validateGoalFormDraft(draft)
  const errors = validation.errors
  const objectiveError = firstError(errors, "objective")
  const criteriaError = firstError(errors, "criteria")
  const unlimited =
    [draft.tokenBudget, draft.maxAutoTurns, draft.maxDurationSeconds].filter((limit) => limit.unlimited).length
  const summary = errors.length
    ? `<section class="goal-form-errors" role="alert" aria-live="polite"><strong>Fix ${errors.length} goal configuration ${
      errors.length === 1 ? "issue" : "issues"
    }</strong><ul>${errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul></section>`
    : ""
  const criteria = draft.criteria.map((criterion, index) => {
    const error = firstError(errors, `criterion:${criterion.id || index}`)
    const errorID = `goal-criterion-${index}-error`
    return `<li class="goal-criterion" data-goal-criterion-id="${
      escapeHtml(criterion.id)
    }"><label for="goal-criterion-${index}">Criterion ${
      index + 1
    }</label><textarea id="goal-criterion-${index}" name="acceptanceCriteria" rows="2" maxlength="${GOAL_FORM_LIMITS.criterionCharacters}"${
      errorAttributes(error, errorID)
    }>${
      escapeHtml(criterion.value)
    }</textarea><div class="goal-criterion-actions"><button type="button" data-goal-criterion-action="up" aria-label="Move criterion ${
      index + 1
    } up"${
      index === 0 ? " disabled" : ""
    }>Up</button><button type="button" data-goal-criterion-action="down" aria-label="Move criterion ${index + 1} down"${
      index === draft.criteria.length - 1 ? " disabled" : ""
    }>Down</button><button type="button" data-goal-criterion-action="remove" aria-label="Remove criterion ${
      index + 1
    }"${draft.criteria.length <= 1 ? " disabled" : ""}>Remove</button></div>${inlineError(error, errorID)}</li>`
  }).join("")
  const timeoutError = firstError(errors, "verifierTimeoutMilliseconds")
  const thresholdError = firstError(errors, "repeatedBlockThreshold")
  const modelError = firstError(errors, "verifierModel")
  const agentError = firstError(errors, "verifierAgent")
  return `<form id="goal-configuration-form" class="goal-form" data-goal-form novalidate><header><h2>Keep working until done</h2><p>Give OpenCode a clear outcome and independently checkable completion conditions. Exact execution controls stay under Advanced settings.</p></header>${summary}<label for="goal-objective">Objective</label><textarea id="goal-objective" name="objective" rows="3" maxlength="${GOAL_FORM_LIMITS.objectiveCharacters}"${
    errorAttributes(objectiveError, "goal-objective-error")
  }>${escapeHtml(draft.objective)}</textarea>${
    inlineError(objectiveError, "goal-objective-error")
  }<fieldset class="goal-criteria"><legend>Done when</legend><p>Describe outcomes that can be checked, rather than implementation steps.</p>${
    inlineError(criteriaError, "goal-criteria-error")
  }<ol>${criteria}</ol><button type="button" data-goal-criterion-action="add"${
    draft.criteria.length >= GOAL_FORM_LIMITS.criteria ? " disabled" : ""
  }>Add condition</button></fieldset><fieldset class="goal-presets"><legend>Effort</legend><button type="button" data-goal-preset="quick">Short</button><button type="button" data-goal-preset="bounded">Standard</button><button type="button" data-goal-preset="thorough">Extended</button></fieldset><label class="goal-verifier-toggle"><input type="checkbox" name="verifierEnabled"${
    draft.verifierEnabled ? " checked" : ""
  }> Verify before marking the work complete</label><details class="goal-advanced"><summary>Advanced settings</summary><fieldset class="goal-limits"><legend>Exact execution limits</legend>${
    limitMarkup("tokenBudget", "Token budget", "tokens", draft.tokenBudget, errors)
  }${limitMarkup("maxAutoTurns", "Auto-turn limit", "turns", draft.maxAutoTurns, errors)}${
    limitMarkup("maxDurationSeconds", "Duration limit", "seconds", draft.maxDurationSeconds, errors)
  }${
    unlimited
      ? `<p class="goal-unlimited-warning" role="status">${
        unlimited === 3
          ? "All execution limits are unlimited."
          : `${unlimited} execution ${unlimited === 1 ? "limit is" : "limits are"} unlimited.`
      } The goal continues until another limit, a user action, or OpenCode settlement stops it.</p>`
      : ""
  }</fieldset><fieldset class="goal-verifier"><legend>Verification details</legend><label for="goal-verifier-model">Verifier model</label><select id="goal-verifier-model" name="verifierModel"${
    errorAttributes(modelError, "goal-verifier-model-error")
  }>${optionMarkup(options.models ?? [], draft.verifierModel, "Default model")}</select>${
    inlineError(modelError, "goal-verifier-model-error")
  }<label for="goal-verifier-agent">Verifier agent</label><select id="goal-verifier-agent" name="verifierAgent"${
    errorAttributes(agentError, "goal-verifier-agent-error")
  }>${optionMarkup(options.agents ?? [], draft.verifierAgent, "Plan agent (default)")}</select>${
    inlineError(agentError, "goal-verifier-agent-error")
  }<label for="goal-verifier-timeout">Verifier timeout (milliseconds)</label><input id="goal-verifier-timeout" name="verifierTimeoutMilliseconds" type="number" inputmode="numeric" min="${GOAL_FORM_LIMITS.verifierTimeoutMinimum}" max="${GOAL_FORM_LIMITS.verifierTimeoutMaximum}" value="${
    escapeHtml(draft.verifierTimeoutMilliseconds)
  }"${errorAttributes(timeoutError, "goal-verifier-timeout-error")}>${
    inlineError(timeoutError, "goal-verifier-timeout-error")
  }<label for="goal-block-threshold">Repeated blocked-verdict threshold</label><input id="goal-block-threshold" name="repeatedBlockThreshold" type="number" inputmode="numeric" min="${GOAL_FORM_LIMITS.repeatedBlockMinimum}" max="${GOAL_FORM_LIMITS.repeatedBlockMaximum}" value="${
    escapeHtml(draft.repeatedBlockThreshold)
  }"${errorAttributes(thresholdError, "goal-block-threshold-error")}>${
    inlineError(thresholdError, "goal-block-threshold-error")
  }</fieldset></details><input type="hidden" name="expectedSettlementGeneration" value="${draft.expectedSettlementGeneration}"><footer class="goal-form-actions"><button type="button" data-goal-form-action="reset">Reset</button><button type="button" data-goal-form-action="verify">Verify now</button><button type="submit" class="primary-action"${
    validation.valid ? "" : ' aria-describedby="goal-form-validation-note"'
  }>Update goal</button><span id="goal-form-validation-note" class="visually-hidden">The extension host validates all fields and the current goal generation again before sending this configuration to OpenCode.</span></footer></form>`
}
