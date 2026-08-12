export class QuestionCoordinator {
  readonly responding = new Set<string>()
  generation = 0
  revision = 0
  dispose(): void {
    this.responding.clear()
    this.generation += 1
  }
}
