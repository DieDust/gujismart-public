export type TextEditorPageSave = () => boolean | void | Promise<boolean | void>

export async function saveTextEditorPage(save: TextEditorPageSave): Promise<boolean> {
  try {
    return (await Promise.resolve(save())) !== false
  } catch {
    return false
  }
}

export const TEXT_EDITOR_SAVE_DEBOUNCE_MS = 450

export interface DebouncedPageSaver {
  /**
   * Replace any pending save with this one and (re)start the debounce window.
   * Each scheduled save must carry the complete latest page state so that
   * last-wins merging is safe. The returned promise resolves with the outcome
   * of the save that actually runs for this window.
   */
  schedule: (save: TextEditorPageSave) => Promise<boolean>
  /** Run any pending save immediately (after an in-flight save completes). */
  flush: () => Promise<boolean>
  hasPending: () => boolean
}

// Proofreading actions (save block, undo/redo, drag reorder) each persist the
// full page. Debouncing merges action bursts into one IPC write while flush on
// page switch/unmount guarantees no edit is lost beyond the debounce window.
// Saves are also serialized so an older payload can never land after a newer one.
export function createDebouncedPageSaver(delayMs: number = TEXT_EDITOR_SAVE_DEBOUNCE_MS): DebouncedPageSaver {
  let pendingSave: TextEditorPageSave | null = null
  let pendingWaiters: Array<(saved: boolean) => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<boolean> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const runPending = (): Promise<boolean> => {
    // Seal the page snapshot before waiting: a new page must not replace it.
    const save = pendingSave
    if (!save) return inFlight || Promise.resolve(true)
    pendingSave = null
    const waiters = pendingWaiters
    pendingWaiters = []
    const previous = inFlight
    const execution = (async () => {
      if (previous) await previous
      return saveTextEditorPage(save)
    })()
    inFlight = execution
    void execution.then((saved) => {
      if (inFlight === execution) inFlight = null
      waiters.forEach((resolve) => resolve(saved))
    })
    return execution
  }

  return {
    schedule(save: TextEditorPageSave): Promise<boolean> {
      pendingSave = save
      const promise = new Promise<boolean>((resolve) => pendingWaiters.push(resolve))
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        void runPending()
      }, delayMs)
      return promise
    },
    flush(): Promise<boolean> {
      clearTimer()
      return runPending()
    },
    hasPending(): boolean {
      return pendingSave !== null
    },
  }
}
