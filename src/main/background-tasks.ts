import { BrowserWindow } from 'electron'
import type { BackgroundTaskProgressEvent } from '../shared/types'
import { taskStateFromLegacyBackgroundEvent } from '../shared/task-contract'

const BACKGROUND_TASK_STATUS_MIN_INTERVAL_MS = 1000
type BackgroundTaskInput = Omit<BackgroundTaskProgressEvent, 'updatedAt' | 'taskState'> & { updatedAt?: string }
const throttledTaskTimers = new Map<string, ReturnType<typeof setTimeout>>()
const throttledTaskPayloads = new Map<string, BackgroundTaskInput>()
const lastTaskStatusEmittedAt = new Map<string, number>()

function sendBackgroundTaskStatus(payload: BackgroundTaskInput): void {
  const event: BackgroundTaskProgressEvent = {
    ...payload,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    taskState: taskStateFromLegacyBackgroundEvent({
      ...payload,
      updatedAt: payload.updatedAt || new Date().toISOString(),
    }),
  }

  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('background:taskStatusChanged', event)
    }
  }
}

export function emitBackgroundTaskStatus(payload: BackgroundTaskInput): void {
  const taskId = String(payload.taskId || '')
  const shouldThrottle = taskId && (payload.status === 'queued' || payload.status === 'processing')
  if (!shouldThrottle) {
    const timer = throttledTaskTimers.get(taskId)
    if (timer) clearTimeout(timer)
    throttledTaskTimers.delete(taskId)
    throttledTaskPayloads.delete(taskId)
    lastTaskStatusEmittedAt.set(taskId, Date.now())
    sendBackgroundTaskStatus(payload)
    return
  }

  const now = Date.now()
  const lastEmittedAt = lastTaskStatusEmittedAt.get(taskId) || 0
  const elapsed = now - lastEmittedAt
  if (elapsed >= BACKGROUND_TASK_STATUS_MIN_INTERVAL_MS) {
    lastTaskStatusEmittedAt.set(taskId, now)
    sendBackgroundTaskStatus(payload)
    return
  }

  throttledTaskPayloads.set(taskId, payload)
  if (!throttledTaskTimers.has(taskId)) {
    throttledTaskTimers.set(taskId, setTimeout(() => {
      throttledTaskTimers.delete(taskId)
      const latestPayload = throttledTaskPayloads.get(taskId)
      throttledTaskPayloads.delete(taskId)
      if (!latestPayload) return
      lastTaskStatusEmittedAt.set(taskId, Date.now())
      sendBackgroundTaskStatus(latestPayload)
    }, Math.max(0, BACKGROUND_TASK_STATUS_MIN_INTERVAL_MS - elapsed)))
  }
}
