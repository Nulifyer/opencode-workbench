import type { EvidenceReference, RunComparisonRow, RunGroup, TaskArtifact } from "@opencode-workbench/shared"
import { DiffService } from "./diff-service.js"
import { userFacingError } from "./error-presentation.js"
import type { GitRunner } from "./worktree-service.js"

export interface RunComparisonExportReference {
  groupID: string
  artifactID: string
  revision: number
}

function markdownCell(value: unknown): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>")
}

/** Formats only stored objective rows. It performs no comparison, scoring, or model invocation. */
export function runComparisonMarkdown(group: RunGroup, rows: readonly RunComparisonRow[]): string {
  const lines = [
    `# Run comparison: ${markdownCell(group.title)}`,
    "",
    "Rows are exported from the stored objective comparison artifact. No winner or score is inferred, and this export invokes no model.",
    "",
    "| Run | Phase | Model / agent / variant | Elapsed (ms) | Changed files | Additions | Deletions | Tasks | Diagnostics | Verifier | Tokens | Cost | Complete | Blocker / limitation |",
    "|---|---|---|---:|---:|---:|---:|---|---|---|---:|---:|---|---|",
  ]
  for (const row of rows) {
    const values = [
      row.runID,
      row.status,
      [row.model, row.agent, row.variant].filter((value): value is string => Boolean(value)).join(" / "),
      row.elapsedMilliseconds ?? "—",
      row.changedFiles,
      row.additions,
      row.deletions,
      row.taskOutcomes,
      row.diagnostics,
      row.verifierState ?? "not-recorded",
      row.tokens ?? "—",
      row.cost ?? "—",
      row.complete ? "yes" : "no",
      row.blocker ?? row.limitation ?? "",
    ]
    lines.push(`| ${values.map(markdownCell).join(" | ")} |`)
  }
  return `${lines.join("\n")}\n`
}

/** Resolves the exact artifact revision shown by the webview before formatting its stored rows. */
export function exactRunComparisonMarkdown(
  group: RunGroup,
  artifacts: readonly TaskArtifact[],
  reference: RunComparisonExportReference,
): string {
  if (reference.groupID !== group.id) throw new Error("Run comparison export group changed")
  const artifact = artifacts.find((candidate) => candidate.id === reference.artifactID)
  if (
    !artifact || artifact.kind !== "run-comparison" || artifact.lifecycle !== "active" ||
    artifact.payload.groupID !== group.id
  ) {
    throw new Error("Run comparison artifact is no longer available")
  }
  if (artifact.revision !== reference.revision) throw new Error("Run comparison changed; export the refreshed matrix")
  return runComparisonMarkdown(group, artifact.payload.rows)
}

export class RunComparisonService {
  constructor(private readonly git: GitRunner) {}

  async compare(
    group: RunGroup,
    observations: Readonly<
      Record<string, { evidence?: EvidenceReference[]; tokens?: number; cost?: number; verifierState?: string }>
    > = {},
  ): Promise<RunComparisonRow[]> {
    const rows = new Array<RunComparisonRow>(group.runs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < group.runs.length) {
        const index = next
        next += 1
        const run = group.runs[index]!
        const observation = observations[run.id]
        const taskEvidence = observation?.evidence?.filter((entry) => entry.kind === "task" || entry.kind === "test") ??
          []
        const diagnosticEvidence = observation?.evidence?.filter((entry) => entry.kind === "diagnostics") ?? []
        const taskOutcomes: RunComparisonRow["taskOutcomes"] = !taskEvidence.length
          ? "not-recorded"
          : taskEvidence.every((entry) => entry.status === "passed")
          ? "passed"
          : taskEvidence.every((entry) => entry.status === "failed")
          ? "failed"
          : "mixed"
        const latestDiagnostics = diagnosticEvidence.reduce<EvidenceReference | undefined>(
          (latest, entry) => !latest || entry.observedAt >= latest.observedAt ? entry : latest,
          undefined,
        )
        const diagnostics: RunComparisonRow["diagnostics"] =
          !latestDiagnostics || latestDiagnostics.status === "unknown" || latestDiagnostics.status === "warning"
            ? "not-recorded"
            : latestDiagnostics.status === "failed"
            ? "has-errors"
            : "clean"
        let stats = { files: 0, additions: 0, deletions: 0, binary: false }
        let limitation: string | undefined
        try {
          if (run.session.sessionID !== "pending") {
            const capture = await new DiffService(this.git).capture({
              repository: run.session.directory,
              scope: "branch",
              baseRef: group.baseRef,
            })
            stats = {
              files: capture.snapshot.files.length,
              additions: capture.snapshot.files.reduce((total, file) => total + file.additions, 0),
              deletions: capture.snapshot.files.reduce((total, file) => total + file.deletions, 0),
              binary: capture.snapshot.files.some((file) => file.binary),
            }
            if (!capture.snapshot.complete) {
              limitation = capture.snapshot.truncationReason ?? "Diff capture is incomplete"
            }
          } else limitation = "Run directory was not created"
        } catch (error) {
          limitation = `Git comparison unavailable: ${userFacingError(error)}`.slice(0, 2_000)
        }
        rows[index] = {
          runID: run.id,
          status: run.phase,
          model: run.model,
          agent: run.agent,
          variant: run.variant,
          elapsedMilliseconds: run.startedAt === undefined
            ? undefined
            : Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt),
          changedFiles: stats.files,
          additions: stats.additions,
          deletions: stats.deletions,
          taskOutcomes,
          diagnostics,
          verifierState: observation?.verifierState,
          tokens: observation?.tokens,
          cost: observation?.cost,
          blocker: run.error ? userFacingError(run.error.message) : undefined,
          complete: !limitation && !stats.binary,
          limitation: limitation ?? (stats.binary ? "Binary file line totals are not representable" : undefined),
        } satisfies RunComparisonRow
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, group.runs.length) }, worker))
    return rows
  }

  markdown(group: RunGroup, rows: RunComparisonRow[]): string {
    return runComparisonMarkdown(group, rows)
  }
}
