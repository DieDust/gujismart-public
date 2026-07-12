type PendingTask<T> = {
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

export class SlidingWindowScheduler {
  private activeCount = 0
  private limit = 1
  private readonly queue: Array<PendingTask<unknown>> = []

  run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    this.limit = normalizeLimit(limit)
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject } as PendingTask<unknown>)
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeCount < this.limit && this.queue.length > 0) {
      const pending = this.queue.shift()
      if (!pending) return
      this.activeCount += 1
      void pending.run()
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.activeCount -= 1
          this.drain()
        })
    }
  }
}

export const globalOcrDocumentWindow = new SlidingWindowScheduler()
