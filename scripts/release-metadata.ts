export interface ReleaseOpenCodeCompatibilityInput {
  minimumOpenCode?: string
  maximumOpenCodeExclusive?: string
  buildOpenCodeVersion?: string
}

export interface ReleaseOpenCodeCompatibility {
  minimumOpenCode: string
  maximumOpenCodeExclusive: string
}

interface SemanticVersion {
  major: number
  minor: number
  patch: number
}

const EXACT_SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseExactSemanticVersion(name: string, version: string | undefined): SemanticVersion {
  const match = version?.match(EXACT_SEMANTIC_VERSION)
  if (!match) throw new Error(`${name} must be an exact semantic version`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

export function validateReleaseOpenCodeCompatibility(
  input: ReleaseOpenCodeCompatibilityInput,
): ReleaseOpenCodeCompatibility {
  const minimum = parseExactSemanticVersion("compatibility.minimumOpenCode", input.minimumOpenCode)
  const maximum = parseExactSemanticVersion(
    "compatibility.maximumOpenCodeExclusive",
    input.maximumOpenCodeExclusive,
  )
  const build = parseExactSemanticVersion("@opencode-ai/plugin build dependency", input.buildOpenCodeVersion)

  if (compareVersions(minimum, maximum) >= 0) {
    throw new Error("OpenCode compatibility minimum must be lower than its exclusive maximum")
  }
  if (minimum.major !== maximum.major) {
    throw new Error("OpenCode compatibility must stay within the configured major line")
  }
  if (compareVersions(build, minimum) < 0 || compareVersions(build, maximum) >= 0) {
    throw new Error("The @opencode-ai/plugin build dependency must be inside the declared OpenCode compatibility range")
  }

  return {
    minimumOpenCode: input.minimumOpenCode!,
    maximumOpenCodeExclusive: input.maximumOpenCodeExclusive!,
  }
}
