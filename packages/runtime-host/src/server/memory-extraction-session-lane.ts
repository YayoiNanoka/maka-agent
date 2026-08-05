/**
 * Process-local serialization shared by Memory Extraction and Session retirement.
 * It prevents evidence from disappearing between final validation and commit.
 */
export class MemoryExtractionSessionLane {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.runMany([sessionId], operation);
  }

  async runMany<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(sessionIds)].sort();
    if (keys.length === 0) return operation();
    const predecessors = keys.map((key) => this.#tails.get(key) ?? Promise.resolve());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = Promise.all(predecessors).then(() => held);
    for (const key of keys) this.#tails.set(key, tail);
    await Promise.all(predecessors);
    try {
      return await operation();
    } finally {
      release();
      for (const key of keys) {
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      }
    }
  }
}
