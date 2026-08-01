export interface AtomicAdapter {
  read(path: string): Promise<string | undefined>
  writeExclusive(path: string, contents: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  acquireLock(path: string): Promise<() => Promise<void>>
}

export class AtomicJsonStore<T> {
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly adapter: AtomicAdapter,
    private readonly fallback: () => T,
    private readonly parse: (value: unknown) => T,
    private readonly randomID: () => string = () => crypto.randomUUID(),
  ) {}

  async read(): Promise<T> {
    await this.#tail
    return this.readCurrent()
  }

  mutate<R>(mutation: (state: T) => R | Promise<R>): Promise<R> {
    const operation = this.#tail.then(async () => {
      const release = await this.adapter.acquireLock(`${this.path}.lock`)
      try {
        const state = await this.readCurrent()
        const result = await mutation(state)
        await this.writeAtomic(state)
        return result
      } finally {
        await release()
      }
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async readCurrent(): Promise<T> {
    const contents = await this.adapter.read(this.path)
    return contents === undefined ? this.fallback() : this.parse(JSON.parse(contents))
  }

  private async writeAtomic(state: T): Promise<void> {
    const temporary = `${this.path}.tmp-${this.randomID()}`
    try {
      await this.adapter.writeExclusive(temporary, `${JSON.stringify(state)}\n`)
      await this.adapter.rename(temporary, this.path)
    } catch (error) {
      await this.adapter.remove(temporary).catch(() => undefined)
      throw error
    }
  }
}
