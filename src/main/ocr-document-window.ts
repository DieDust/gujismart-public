type PendingTask<T> = {
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  releaseWhen?: Promise<void>
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

type QueuedTask<T> = PendingTask<T> & { limit: number }

export class SlidingWindowScheduler {
  private activeCount = 0
  /** Per-running-task slot limits; capacity is min(active limits ∪ next limit). */
  private readonly activeSlotLimits: number[] = []
  private readonly queue: Array<QueuedTask<unknown>> = []
  private readonly documentTails = new Map<string, Promise<void>>()

  run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    const taskLimit = normalizeLimit(limit)
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject, limit: taskLimit } as QueuedTask<unknown>)
      this.drain()
    })
  }

  private runUntilReleased(limit: number, task: () => Promise<void>, releaseWhen: Promise<void>): Promise<void> {
    const taskLimit = normalizeLimit(limit)
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject, limit: taskLimit, releaseWhen } as QueuedTask<unknown>)
      this.drain()
    })
  }

  async runForDocument(
    documentId: string,
    limit: number,
    task: () => Promise<void>,
    releaseWhen?: Promise<void>,
  ): Promise<void> {
    const key = String(documentId || '').trim()
    if (!key) {
      if (releaseWhen) return this.runUntilReleased(limit, task, releaseWhen)
      return this.run(limit, task)
    }

    const previous = this.documentTails.get(key) || Promise.resolve()
    let releaseCurrent: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    this.documentTails.set(key, current)

    await previous
    try {
      if (releaseWhen) return await this.runUntilReleased(limit, task, releaseWhen)
      return await this.run(limit, task)
    } finally {
      releaseCurrent()
      if (this.documentTails.get(key) === current) this.documentTails.delete(key)
    }
  }

  private currentCapacity(nextLimit: number): number {
    // If any running task asked for serial (1), keep the whole window serial
    // until it finishes — otherwise a heavy book + light books would pile up.
    if (this.activeSlotLimits.some((limit) => limit <= 1)) return 1
    if (nextLimit <= 1) return this.activeCount === 0 ? 1 : 0
    const activeMin = this.activeSlotLimits.length > 0
      ? Math.min(...this.activeSlotLimits)
      : nextLimit
    return Math.max(1, Math.min(activeMin, nextLimit))
  }

  private drain(): void {
    while (this.queue.length > 0) {
      // Use the next task's requested concurrency so concurrent batch/import OCR
      // callers do not permanently shrink/expand a shared mutable limit mid-flight.
      const nextLimit = this.queue[0]?.limit || 1
      const capacity = this.currentCapacity(nextLimit)
      if (this.activeCount >= capacity) break
      const pending = this.queue.shift()
      if (!pending) return
      this.activeCount += 1
      this.activeSlotLimits.push(pending.limit)
      const work = pending.run()
      const tracked = pending.releaseWhen
        ? Promise.race([work, pending.releaseWhen])
        : work
      void tracked
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.activeCount -= 1
          const idx = this.activeSlotLimits.indexOf(pending.limit)
          if (idx >= 0) this.activeSlotLimits.splice(idx, 1)
          this.drain()
        })
    }
  }
}

export const globalOcrDocumentWindow = new SlidingWindowScheduler()
export const heavyPdfOcrDocumentWindow = new SlidingWindowScheduler()
