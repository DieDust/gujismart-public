type PendingTask<T> = {
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

type QueuedTask<T> = PendingTask<T> & { limit: number }

export class SlidingWindowScheduler {
  private activeCount = 0
  private readonly queue: Array<QueuedTask<unknown>> = []

  run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    const taskLimit = normalizeLimit(limit)
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject, limit: taskLimit } as QueuedTask<unknown>)
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      // Use the next task's requested concurrency so concurrent batch/import OCR
      // callers do not permanently shrink/expand a shared mutable limit mid-flight.
      const nextLimit = this.queue[0]?.limit || 1
      if (this.activeCount >= nextLimit) break
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
