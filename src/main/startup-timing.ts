/**
 * Cold-start phase timing for diagnosing large-library open latency.
 *
 * - Console: [StartupTiming]
 * - UI splash: Chinese labels + wall-clock timeline (not just active work ms)
 *
 * Important: "总用时" is wall-clock from process boot. Phase durations are active
 * work between begin/end; nested phases nest inside parents; idle gaps (e.g. 8s
 * recovery delay, renderer load) appear as "未计量间隔".
 */

export type StartupTimingPhaseRecord = {
  name: string
  startedAtMs: number
  endedAtMs: number
  durationMs: number
  /** Wall-clock offset when phase started (ms since boot). */
  startedSinceBootMs: number
  /** Wall-clock offset when phase ended (ms since boot). */
  endedSinceBootMs: number
}

export type StartupTimingUiPhase = {
  name: string
  label: string
  durationMs: number
  startedSinceBootMs: number
  endedSinceBootMs: number
  /** True when this phase is fully nested inside another measured phase. */
  nested: boolean
}

export type StartupTimingUiOpenPhase = {
  name: string
  label: string
  startedSinceBootMs: number
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
  diagnosticsReady?: boolean
  diagnosticsReadyAtMs?: number
  diagnosticsReadyReason?: string
  /** Sum of leaf (non-nested) phase durations — comparable to wall clock. */
  measuredLeafWorkMs: number
  /** Wall clock minus leaf work (idle waits, uninstrumented gaps). */
  unaccountedGapMs: number
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

/** User-facing Chinese labels for known phase ids. */
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
  'startup-recovery-delay': '排队启动恢复（极短让出主线程）',
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
    .map((phase) => `${phase.name}=${phase.durationMs}ms@+${phase.startedSinceBootMs}`)
    .join(', ')
}

function isNestedPhase(
  phase: StartupTimingPhaseRecord,
  all: StartupTimingPhaseRecord[],
): boolean {
  return all.some((other) => (
    other !== phase
    && other.startedAtMs <= phase.startedAtMs
    && other.endedAtMs >= phase.endedAtMs
    && (other.startedAtMs < phase.startedAtMs || other.endedAtMs > phase.endedAtMs)
  ))
}

function buildUiPhases(): StartupTimingUiPhase[] {
  return completedPhases
    .slice()
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.endedAtMs - b.endedAtMs)
    .map((phase) => ({
      name: phase.name,
      label: labelFor(phase.name),
      durationMs: phase.durationMs,
      startedSinceBootMs: phase.startedSinceBootMs,
      endedSinceBootMs: phase.endedSinceBootMs,
      nested: isNestedPhase(phase, completedPhases),
    }))
}

function sumLeafWorkMs(phases: StartupTimingUiPhase[]): number {
  return phases
    .filter((phase) => !phase.nested)
    .reduce((sum, phase) => sum + Math.max(0, phase.durationMs), 0)
}

function buildUiSnapshot(now = Date.now()): StartupTimingUiSnapshot {
  const open = [...openPhases.entries()]
    .map(([name, startedAtMs]) => ({
      name,
      label: labelFor(name),
      startedSinceBootMs: Math.max(0, startedAtMs - bootAtMs),
    }))
    .sort((a, b) => a.startedSinceBootMs - b.startedSinceBootMs)

  const currentPhase = open.length > 0 ? open[open.length - 1].name : null
  let currentLabel = currentPhase
    ? labelFor(currentPhase)
    : (lastEventLabel || '正在启动…')
  let currentDetail = currentPhase
    ? `技术名：${currentPhase}${lastEventDetail ? ` · ${lastEventDetail}` : ''}`
    : (lastEventDetail || '请稍候，大文献库首次打开可能需要更长时间')

  const phases = buildUiPhases()
  const wallMs = diagnosticsReady && diagnosticsReadyAtMs > 0 ? diagnosticsReadyAtMs : sinceBoot(now)
  const measuredLeafWorkMs = sumLeafWorkMs(phases)
  const unaccountedGapMs = Math.max(0, wallMs - measuredLeafWorkMs)

  if (diagnosticsReady) {
    currentLabel = '启动诊断完成 · 请截图本窗口'
    currentDetail = [
      `墙钟总用时 ${formatDurationZh(wallMs)}`,
      `已计量工作（不含嵌套重复） ${formatDurationZh(measuredLeafWorkMs)}`,
      `未计量间隔（等待/加载空档） ${formatDurationZh(unaccountedGapMs)}`,
      diagnosticsReadyReason ? `原因：${diagnosticsReadyReason}` : '',
    ].filter(Boolean).join(' · ')
  }

  return {
    bootAtMs,
    sinceBootMs: wallMs,
    currentPhase,
    currentLabel,
    currentDetail,
    phases,
    openPhases: open,
    lastEvent: lastEventLabel || undefined,
    diagnosticsReady,
    diagnosticsReadyAtMs: diagnosticsReady ? diagnosticsReadyAtMs : undefined,
    diagnosticsReadyReason: diagnosticsReady ? diagnosticsReadyReason : undefined,
    measuredLeafWorkMs,
    unaccountedGapMs,
  }
}

/** Format for UI: short work in ms, longer spans in seconds. */
export function formatDurationZh(ms: number): string {
  const value = Math.max(0, Math.round(Number(ms) || 0))
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(2)} 秒（${value} ms）`
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
      startedSinceBootMs: Math.max(0, markedStart - bootAtMs),
      endedSinceBootMs: Math.max(0, endedAtMs - bootAtMs),
    }
    completedPhases.push(record)
    console.log(
      `[StartupTiming] +${record.endedSinceBootMs}ms END ${phaseName} duration=${durationMs}ms start=+${record.startedSinceBootMs}ms`,
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
  const snap = buildUiSnapshot(now)
  console.log(
    `[StartupTiming] SUMMARY reason=${reason} wall=${snap.sinceBootMs}ms leafWork=${snap.measuredLeafWorkMs}ms gap=${snap.unaccountedGapMs}ms phases=[${formatPhaseList()}]${openNote}`,
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
