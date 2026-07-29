import type { DatabaseLockActivity, DatabaseLockDiagnostics } from '../shared/types'
import { getDatabaseFilePath } from './database'
import { runDatabaseLockProbeWorkerTask } from './database-diagnostics-worker-client'
import { getDatabaseActivitySnapshot } from './database-lock-monitor'

function isOwnerCandidate(activity: DatabaseLockActivity): boolean {
  return activity.state === 'holding' || activity.state === 'running' || activity.state === 'waiting'
}

export async function getDatabaseLockDiagnostics(): Promise<DatabaseLockDiagnostics> {
  const checkedAt = new Date().toISOString()
  try {
    const probe = await runDatabaseLockProbeWorkerTask({ dbFilePath: getDatabaseFilePath() })
    const snapshot = getDatabaseActivitySnapshot()
    const confirmedOwners = snapshot.activeActivities.filter((activity) => activity.state === 'holding')
    const candidateOwners = snapshot.activeActivities.filter(isOwnerCandidate)

    if (probe.writerAvailable) {
      return {
        status: 'available',
        checkedAt,
        processId: process.pid,
        writerAvailable: true,
        probeElapsedMs: probe.elapsedMs,
        ownerConfidence: 'none',
        message: snapshot.activeActivities.some((activity) => activity.state === 'queued')
          ? '当前写锁可用；仍有数据库任务在队列中等待执行。'
          : '当前 SQLite 写锁可用。',
        activeActivities: snapshot.activeActivities,
        likelyOwners: [],
        recentBusyIncidents: snapshot.recentBusyIncidents,
      }
    }

    if (confirmedOwners.length > 0) {
      return {
        status: 'busy-confirmed-internal',
        checkedAt,
        processId: process.pid,
        writerAvailable: false,
        probeElapsedMs: probe.elapsedMs,
        ownerConfidence: 'confirmed',
        message: '检测到写锁，且本进程有已登记事务正在持有写锁。',
        activeActivities: snapshot.activeActivities,
        likelyOwners: confirmedOwners,
        recentBusyIncidents: snapshot.recentBusyIncidents,
      }
    }

    if (candidateOwners.length > 0) {
      return {
        status: 'busy-internal-candidate',
        checkedAt,
        processId: process.pid,
        writerAvailable: false,
        probeElapsedMs: probe.elapsedMs,
        ownerConfidence: 'candidate',
        message: '检测到写锁；下列本软件任务正在运行或等待，但 SQLite 无法证明具体由哪一个任务持锁。',
        activeActivities: snapshot.activeActivities,
        likelyOwners: candidateOwners,
        recentBusyIncidents: snapshot.recentBusyIncidents,
      }
    }

    return {
      status: 'busy-unattributed',
      checkedAt,
      processId: process.pid,
      writerAvailable: false,
      probeElapsedMs: probe.elapsedMs,
      ownerConfidence: 'none',
      message: '检测到未归属写锁。它可能来自另一个 GujiSmart/旧版本进程，或尚未登记的数据库连接。',
      activeActivities: snapshot.activeActivities,
      likelyOwners: [],
      recentBusyIncidents: snapshot.recentBusyIncidents,
      ...(probe.error ? { probeError: probe.error } : {}),
    }
  } catch (error) {
    const snapshot = getDatabaseActivitySnapshot()
    return {
      status: 'probe-error',
      checkedAt,
      processId: process.pid,
      writerAvailable: false,
      probeElapsedMs: 0,
      ownerConfidence: 'none',
      message: '写锁探测失败，无法判断当前占用来源。',
      activeActivities: snapshot.activeActivities,
      likelyOwners: [],
      recentBusyIncidents: snapshot.recentBusyIncidents,
      probeError: error instanceof Error ? error.message : String(error),
    }
  }
}
