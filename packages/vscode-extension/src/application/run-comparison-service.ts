import type { EvidenceReference, RunComparisonRow, RunGroup } from "@opencode-workbench/shared"
import { DiffService } from "./diff-service.js"
import { userFacingError } from "./error-presentation.js"
import type { GitRunner } from "./worktree-service.js"

export class RunComparisonService {
  constructor(private readonly git: GitRunner) {}

  async compare(group: RunGroup, observations: Readonly<Record<string, { evidence?: EvidenceReference[]; tokens?: number; cost?: number; verifierState?: string }>> = {}): Promise<RunComparisonRow[]> {
    return await Promise.all(group.runs.map(async (run) => {
      const observation = observations[run.id]
      const taskEvidence = observation?.evidence?.filter((entry) => entry.kind === "task" || entry.kind === "test") ?? []
      const diagnosticEvidence = observation?.evidence?.filter((entry) => entry.kind === "diagnostics") ?? []
      const taskOutcomes: RunComparisonRow["taskOutcomes"] = !taskEvidence.length ? "not-recorded"
        : taskEvidence.every((entry) => entry.status === "passed") ? "passed"
        : taskEvidence.every((entry) => entry.status === "failed") ? "failed"
        : "mixed"
      const latestDiagnostics = diagnosticEvidence.reduce<EvidenceReference | undefined>((latest, entry) =>
        !latest || entry.observedAt >= latest.observedAt ? entry : latest, undefined)
      const diagnostics: RunComparisonRow["diagnostics"] = !latestDiagnostics || latestDiagnostics.status === "unknown" || latestDiagnostics.status === "warning" ? "not-recorded"
        : latestDiagnostics.status === "failed" ? "has-errors"
        : "clean"
      let stats = { files: 0, additions: 0, deletions: 0, binary: false }
      let limitation: string | undefined
      try {
        if (run.session.directory !== "pending") {
          const capture = await new DiffService(this.git).capture({ repository: run.session.directory, scope: "branch", baseRef: group.baseRef })
          stats = {
            files: capture.snapshot.files.length,
            additions: capture.snapshot.files.reduce((total, file) => total + file.additions, 0),
            deletions: capture.snapshot.files.reduce((total, file) => total + file.deletions, 0),
            binary: capture.snapshot.files.some((file) => file.binary),
          }
          if (!capture.snapshot.complete) limitation = capture.snapshot.truncationReason ?? "Diff capture is incomplete"
        } else limitation = "Run directory was not created"
      } catch (error) {
        limitation = `Git comparison unavailable: ${userFacingError(error)}`.slice(0, 2_000)
      }
      return {
        runID: run.id,
        status: run.phase,
        model: run.model,
        agent: run.agent,
        variant: run.variant,
        elapsedMilliseconds: run.startedAt === undefined ? undefined : Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt),
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
    }))
  }

  markdown(group: RunGroup, rows: RunComparisonRow[]): string {
    const lines = [
      `# Run comparison: ${group.title}`,
      "",
      "No AI winner is selected. Metrics below are objective observations; unavailable evidence is labeled.",
      "",
      "| Run | Status | Model / agent / variant | Elapsed | Changed files | Diff | Tasks | Diagnostics | Goal / verifier | Tokens | Cost | Blocker / limitation |",
      "|---|---|---|---:|---:|---:|---|---|---|---:|---:|---|",
    ]
    for (const row of rows) lines.push(`| ${row.runID} | ${row.status} | ${[row.model, row.agent, row.variant].filter(Boolean).join(" / ")} | ${row.elapsedMilliseconds === undefined ? "—" : `${Math.round(row.elapsedMilliseconds / 1000)}s`} | ${row.changedFiles} | +${row.additions} −${row.deletions} | ${row.taskOutcomes} | ${row.diagnostics} | ${row.verifierState ?? "not-recorded"} | ${row.tokens ?? "—"} | ${row.cost === undefined ? "—" : row.cost.toFixed(4)} | ${(row.blocker ?? row.limitation ?? "").replaceAll("|", "\\|")} |`)
    return `${lines.join("\n")}\n`
  }
}
