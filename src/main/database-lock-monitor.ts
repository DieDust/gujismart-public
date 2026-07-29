import { getErrorMessage } from '../shared/errors'
import type {
  DatabaseBusyIncident,
  DatabaseLockActivity,
  DatabaseLockActivityCategory,
  DatabaseLockActivityState,
} from '../shared/types'

export interface DatabaseActivityDescriptor {
  category: DatabaseLockActivityCategory
  label: string
  state?: DatabaseLockActivityState
  detail?: string
}

interface InternalDatabaseActivity extends DatabaseActivityDescriptor {
  id: string
  startedAtMs: number
  state: DatabaseLockActivityState
}

const MAX_RECENT_BUSY_INCIDENTS = 20
const activeDatabaseActivities = new Map<string, InternalDatabaseActivity>()
const recentBusyIncidents: DatabaseBusyIncident[] = []
let nextActivityId = 0
let nextIncidentId = 0

export function beginDatabaseActivity(descriptor: DatabaseActivityDescriptor): string {
  nextActivityId += 1
  const id = `db-activity:${process.pid}:${nextActivityId}`
  activeDatabaseActivities.set(id, {
    ...descriptor,
    id,
    state: descriptor.state || 'waiting',
    startedAtMs: Date.now(),
  })
  return id
}

export function updateDatabaseActivity(
  id: string,
  update: Partial<Pick<InternalDatabaseActivity, 'state' | 'detail' | 'label'>>,
): void {
  const activity = activeDatabaseActivities.get(id)
  if (!activity) return
  activeDatabaseActivities.set(id, { ...activity, ...update })
}

export function finishDatabaseActivity(id: string): void {
  activeDatabaseActivities.delete(id)
}

export function recordDatabaseBusyIncident(
  activityId: string | null,
  error: unknown,
  waitedMs: number,
  outcome: DatabaseBusyIncident['outcome'],
  fallbackLabel = '未登记数据库操作',
): void {
  const activity = activityId ? activeDatabaseActivities.get(activityId) : null
  nextIncidentId += 1
  recentBusyIncidents.unshift({
    id: `db-busy:${process.pid}:${nextIncidentId}`,
    operationLabel: activity?.label || fallbackLabel,
    occurredAt: new Date().toISOString(),
    waitedMs: Math.max(0, Math.round(waitedMs)),
    outcome,
    error: getErrorMessage(error).slice(0, 500),
  })
  if (recentBusyIncidents.length > MAX_RECENT_BUSY_INCIDENTS) {
    recentBusyIncidents.length = MAX_RECENT_BUSY_INCIDENTS
  }
}

function toPublicActivity(activity: InternalDatabaseActivity, now: number): DatabaseLockActivity {
  return {
    id: activity.id,
    category: activity.category,
    label: activity.label,
    state: activity.state,
    startedAt: new Date(activity.startedAtMs).toISOString(),
    elapsedMs: Math.max(0, now - activity.startedAtMs),
    ...(activity.detail ? { detail: activity.detail } : {}),
  }
}

export function getDatabaseActivitySnapshot(): {
  activeActivities: DatabaseLockActivity[]
  recentBusyIncidents: DatabaseBusyIncident[]
} {
  const now = Date.now()
  return {
    activeActivities: [...activeDatabaseActivities.values()]
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((activity) => toPublicActivity(activity, now)),
    recentBusyIncidents: recentBusyIncidents.map((incident) => ({ ...incident })),
  }
}

export function resetDatabaseLockMonitorForTests(): void {
  activeDatabaseActivities.clear()
  recentBusyIncidents.length = 0
}
