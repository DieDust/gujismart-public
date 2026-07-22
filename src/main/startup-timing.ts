/**
 * Cold-start phase timing for diagnosing large-library open latency.
 *
 * - Always logs to console with prefix [StartupTiming]
 * - Optionally publishes UI snapshots to the startup splash window
 *
 * Example console:
 *   [StartupTiming] +12ms BEGIN initDatabase
 *   [StartupTiming] +840ms END initDatabase duration=828ms
 *   [StartupTiming] SUMMARY total=4521ms phases=...
 */

export type StartupTimingPhaseRecord = {
  name: string
  startedAtMs: number
  endedAtMs: number
  durationMs: number
  /** Milliseconds since process boot epoch when the phase ended. */
  sinceBootMs: number
}

export type StartupTimingUiPhase = {
  name: string
  label: string
  durationMs: number
}

export type StartupTimingUiOpenPhase = {
  name: string
  label: string
}

export type StartupTimingUiSnapshot = {
  bootAtMs: number
  sinceBootMs: number
  currentPhase: string | null
  currentLabel: string
  currentDetail?: string
  phases: StartupTimingUiPhase[]
  openPhases: StartupTimingUiOpenPhase[]
  lastEvent?: string
  /** Test builds keep the splash open; true when main window is up and recovery has finished (or timed out). */
  diagnosticsReady?: boolean
  diagnosticsReadyAtMs?: number
  diagnosticsReadyReason?: string
}

type StartupTimingUiPublisher = (snapshot: StartupTimingUiSnapshot) => void

const bootAtMs = Date.now()
const completedPhases: StartupTimingPhaseRecord[] = []
const openPhases = new Map<string, number>()
let summaryLogged = false
let lastEventLabel = ''
let lastEventDetail = ''
let uiPublisher: StartupTimingUiPublisher | null = null
let publishTimer: ReturnType<typeof setTimeout> | null = null
let diagnosticsReady = false
let diagnosticsReadyAtMs = 0
let diagnosticsReadyReason = ''

/** User-facing Chinese labels for known phase ids. Unknown ids fall back to the raw name. */
const PHASE_LABELS: Record<string, string> = {
  'main-module-loaded': '主进程模块已加载',
  'app-when-ready': 'Electron 已就绪',
  'startup-splash-open': '启动进度窗口已打开',
  initDatabase: '打开文献库数据库',
  'initDatabase.open-sqlite': '连接 SQLite / WAL',
  'initDatabase.schema-migrate': '数据库结构检查与迁移',
  'initDatabase.ensure-fts': '全文检索结构检查',
  'initDatabase.seed-defaults': '写入默认配置',
  initializeSettingsSecurity: '初始化设置安全模块',
  registerAllIpcHandlers: '注册主进程接口',
  createWindow: '创建主窗口',
  'window-shown': '主窗口已显示',
  'renderer-did-finish-load': '界面资源加载完成',
  'startup-recovery-scheduled': '已安排启动恢复任务',
  'startup-maintenance-scheduled': '已安排延迟维护任务',
  'startup-recovery-delay': '等待首屏后再恢复后台任务',
  'startup-recovery-begin': '开始启动恢复',
  'startup-recovery': '启动恢复（整体）',
  'startup-recovery.ocr-jobs': '恢复中断的 OCR 任务',
  'startup-recovery.reset-interrupted-jobs': '重置中断的索引/缓存任务',
  'startup-recovery.pdf-compression-sources': '恢复中断的 PDF 压缩源',
  'startup-recovery.interrupted-imports': '修复中断的导入记录',
  'startup-recovery.reconcile-completed-ocr': '核对已完成 OCR 状态',
  'startup-recovery.search-status': '整理搜索索引状态',
  'startup-recovery.temp-dirs': '清理临时目录',
  'startup-recovery.orphan-storage': '清理孤立存储目录',
  'startup-recovery.resume-deletes': '接续未完成的删除任务',
  'startup-recovery-complete': '启动恢复完成',
  'startup-recovery-canceled': '启动恢复已取消',
  'startup-maintenance': '延迟启动维护（整体）',
  'startup-maintenance.database': '数据库延迟维护',
  'startup-maintenance.metadata-tags': '元数据标签核对',
  'startup-maintenance.metadata-tags-skipped-large-library': '大库跳过元数据标签自动重建',
  'startup-maintenance.metadata-reclassification-scheduled': '已安排元数据重分类',
  'preload-local-resource-paths': '预加载本地资源路径白名单',
  startAutoBackupScheduler: '启动自动备份调度',
  'startup-failed': '启动失败',
}

function sinceBoot(now = Date.now()): number {
  return Math.max(0, now - bootAtMs)
}

function labelFor(name: string): string {
  const key = String(name || '').trim()
  return PHASE_LABELS[key] || key || '未命名阶段'
}

function formatPhaseList(): string {
  if (completedPhases.length === 0) return '(none)'
  return completedPhases
    .map((phase) => `${phase.name}=${phase.durationMs}ms`)
    .join(', ')
}

function buildUiSnapshot(now = Date.now()): StartupTimingUiSnapshot {
  const open = [...openPhases.keys()]
  const currentPhase = open.length > 0 ? open[open.length - 1] : null
  let currentLabel = currentPhase
    ? labelFor(currentPhase)
    : (lastEventLabel || '正在启动…')
  let currentDetail = currentPhase
    ? `技术名：${currentPhase}${lastEventDetail ? ` · ${lastEventDetail}` : ''}`
    : (lastEventDetail || '请稍候，大文献库首次打开可能需要更长时间')

  if (diagnosticsReady) {
    currentLabel = '启动诊断完成 · 请截图本窗口'
    currentDetail = diagnosticsReadyReason
      ? `测试版：主程序已可用，请截图整窗发给开发者（含总用时与阶段毫秒）。原因：${diagnosticsReadyReason}`
      : '测试版：主程序已可用，请截图整窗发给开发者（含总用时与阶段毫秒）'
  }

  return {
    bootAtMs,
    sinceBootMs: diagnosticsReady && diagnosticsReadyAtMs > 0 ? diagnosticsReadyAtMs : sinceBoot(now),
    currentPhase,
    currentLabel,
    currentDetail,
    phases: completedPhases.map((phase) => ({
      name: phase.name,
      label: labelFor(phase.name),
      durationMs: phase.durationMs,
    })),
    openPhases: open.map((name) => ({
      name,
      label: labelFor(name),
    })),
    lastEvent: lastEventLabel || undefined,
    diagnosticsReady,
    diagnosticsReadyAtMs: diagnosticsReady ? diagnosticsReadyAtMs : undefined,
    diagnosticsReadyReason: diagnosticsReady ? diagnosticsReadyReason : undefined,
  }
}

/** Test-build only: freeze splash as a screenshot-friendly report without closing it. */
export function markStartupDiagnosticsSession(options: {
  diagnosticsReady: boolean
  readyReason?: string
}): void {
  diagnosticsReady = options.diagnosticsReady === true
  if (diagnosticsReady) {
    diagnosticsReadyAtMs = sinceBoot()
    diagnosticsReadyReason = String(options.readyReason || '').trim()
  } else {
    diagnosticsReadyAtMs = 0
    diagnosticsReadyReason = ''
  }
  schedulePublishUi()
}

function schedulePublishUi(): void {
  if (!uiPublisher) return
  if (publishTimer) return
  // Coalesce rapid nested phase marks so the splash does not thrash.
  publishTimer = setTimeout(() => {
    publishTimer = null
    try {
      uiPublisher?.(buildUiSnapshot())
    } catch {
      // Splash may have been destroyed mid-publish.
    }
  }, 32)
}

export function setStartupTimingUiPublisher(publisher: StartupTimingUiPublisher | null): void {
  uiPublisher = publisher
  if (publisher) schedulePublishUi()
}

export function getStartupTimingUiSnapshot(): StartupTimingUiSnapshot {
  return buildUiSnapshot()
}

/**
 * Start a named phase. Call the returned function when the phase ends.
 * Nested phases with different names are supported; same name restarts the open mark.
 */
export function beginStartupPhase(name: string): () => void {
  const phaseName = String(name || 'unnamed').trim() || 'unnamed'
  const startedAtMs = Date.now()
  openPhases.set(phaseName, startedAtMs)
  console.log(`[StartupTiming] +${sinceBoot(startedAtMs)}ms BEGIN ${phaseName}`)
  schedulePublishUi()

  let finished = false
  return () => {
    if (finished) return
    finished = true
    const endedAtMs = Date.now()
    const markedStart = openPhases.get(phaseName) ?? startedAtMs
    openPhases.delete(phaseName)
    const durationMs = Math.max(0, endedAtMs - markedStart)
    const record: StartupTimingPhaseRecord = {
      name: phaseName,
      startedAtMs: markedStart,
      endedAtMs,
      durationMs,
      sinceBootMs: sinceBoot(endedAtMs),
    }
    completedPhases.push(record)
    console.log(
      `[StartupTiming] +${record.sinceBootMs}ms END ${phaseName} duration=${durationMs}ms`,
    )
    schedulePublishUi()
  }
}

/** Measure an async phase and always end the mark, even on throw. */
export async function withStartupPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
  const end = beginStartupPhase(name)
  try {
    return await work()
  } finally {
    end()
  }
}

/** Measure a sync phase and always end the mark, even on throw. */
export function withStartupPhaseSync<T>(name: string, work: () => T): T {
  const end = beginStartupPhase(name)
  try {
    return work()
  } finally {
    end()
  }
}

/** Instant mark for one-shot events (window shown, recovery scheduled, …). */
export function markStartupEvent(name: string, detail?: string): void {
  const phaseName = String(name || 'event').trim() || 'event'
  const now = Date.now()
  const suffix = detail ? ` ${detail}` : ''
  lastEventLabel = labelFor(phaseName)
  lastEventDetail = detail ? String(detail) : ''
  console.log(`[StartupTiming] +${sinceBoot(now)}ms EVENT ${phaseName}${suffix}`)
  schedulePublishUi()
}

/**
 * Print a one-line summary of completed phases.
 * Safe to call multiple times; only the first call logs unless force=true.
 */
export function logStartupTimingSummary(reason = 'checkpoint', force = false): void {
  if (summaryLogged && !force) return
  summaryLogged = true
  const now = Date.now()
  const openNames = [...openPhases.keys()]
  const openNote = openNames.length > 0 ? ` open=[${openNames.join(', ')}]` : ''
  console.log(
    `[StartupTiming] SUMMARY reason=${reason} total=${sinceBoot(now)}ms phases=[${formatPhaseList()}]${openNote}`,
  )
  schedulePublishUi()
}

export function getStartupTimingSnapshot(): {
  bootAtMs: number
  sinceBootMs: number
  phases: StartupTimingPhaseRecord[]
  openPhases: string[]
} {
  return {
    bootAtMs,
    sinceBootMs: sinceBoot(),
    phases: completedPhases.slice(),
    openPhases: [...openPhases.keys()],
  }
}
