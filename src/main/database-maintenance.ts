import { dialog } from 'electron'
import { existsSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type {
  DatabaseMaintenanceResult,
  DatabaseRequiredMaintenance,
  DatabaseRequiredMaintenanceReason,
  DatabaseSearchIndexStorageStat,
  DatabaseStorageDiagnostics,
  DatabaseTableStorageStat,
} from '../shared/types'
import { SEARCH_INDEX_VERSION, SEARCH_NGRAM_INDEX_ENABLED } from './search-index-constants'
import { getDatabase, getDatabaseFilePath, queryOne, run, scheduleDatabaseSave } from './database'
import { emitBackgroundTaskStatus } from './background-tasks'

// Keep rowid-list batches below SQLite's bound-parameter ceiling. Full ngram
// cleanup uses rowid ranges instead, so it can safely sweep much larger slices.
const LEGACY_SEARCH_CLEANUP_BATCH_SIZE = 5_000
const LEGACY_SEARCH_FULL_CLEANUP_ROWID_BATCH_SIZE = 100_000
const LEGACY_SEARCH_CLEANUP_YIELD_MS = 10

interface CountRow {
  count?: number | null
}

interface SampleRow {
  sampleRows?: number | null
  total?: number | null
}

interface RowIdRow {
  rowid: number
}

interface LegacySearchCleanupProgress {
  phase: 'ngram' | 'single-char' | 'positions' | 'staging' | 'completed'
  scannedRowId: number
  estimatedMaxRowId: number
  deletedRows: number
  updatedRows: number
}

type LegacySearchCleanupProgressCallback = (progress: LegacySearchCleanupProgress) => void

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRowIdBatch(sql: string, lastRowId: number): number[] {
  return getDatabase()
    .prepare(sql)
    .all(lastRowId, LEGACY_SEARCH_CLEANUP_BATCH_SIZE)
    .map((row) => Number((row as RowIdRow).rowid || 0))
    .filter((rowid) => Number.isFinite(rowid) && rowid > 0)
}

function runForRowIds(sqlPrefix: string, rowIds: number[], params: unknown[] = []): number {
  if (rowIds.length === 0) return 0
  const placeholders = rowIds.map(() => '?').join(', ')
  const result = getDatabase().prepare(`${sqlPrefix} (${placeholders})`).run(...params, ...rowIds)
  return Number(result.changes || 0)
}

function getRowIdRangeUpperBound(tableName: string, lastRowId: number, batchSize: number): number {
  const offset = Math.max(0, Math.floor(batchSize) - 1)
  const row = queryOne<RowIdRow>(
    `SELECT rowid FROM ${tableName} WHERE rowid > ? ORDER BY rowid LIMIT 1 OFFSET ?`,
    [lastRowId, offset],
  )
  if (row?.rowid) return Number(row.rowid)
  return numberValue(queryOne<CountRow>(`SELECT MAX(rowid) AS count FROM ${tableName} WHERE rowid > ?`, [lastRowId])?.count)
}

function runRowIdRangeDelete(tableName: string, lowerExclusiveRowId: number, upperInclusiveRowId: number): number {
  if (upperInclusiveRowId <= lowerExclusiveRowId) return 0
  const result = getDatabase()
    .prepare(`DELETE FROM ${tableName} WHERE rowid > ? AND rowid <= ?`)
    .run(lowerExclusiveRowId, upperInclusiveRowId)
  return Number(result.changes || 0)
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function formatCount(value: number): string {
  return Number(value || 0).toLocaleString()
}

function emitDatabaseMaintenanceProgress(progress: LegacySearchCleanupProgress): void {
  const estimatedMaxRowId = Math.max(1, Number(progress.estimatedMaxRowId || 0))
  const scannedRowId = Math.max(0, Number(progress.scannedRowId || 0))
  const phaseProgress = clampProgress(scannedRowId / estimatedMaxRowId)
  const overallProgress = progress.phase === 'ngram'
    ? 0.02 + phaseProgress * 0.95
    : progress.phase === 'single-char'
      ? 0.02 + phaseProgress * 0.46
      : progress.phase === 'positions'
        ? 0.5 + phaseProgress * 0.45
        : progress.phase === 'staging'
          ? 0.97
          : 1

  const phaseLabel = progress.phase === 'single-char'
    ? '正在清理旧版单字索引'
    : progress.phase === 'ngram'
      ? '正在清理巨大 ngram 候选索引'
    : progress.phase === 'positions'
      ? '正在移除旧版位置数据'
      : progress.phase === 'staging'
        ? '正在清理暂存索引'
        : '数据库瘦身完成'
  const changedRows = Number(progress.deletedRows || 0) + Number(progress.updatedRows || 0)
  const message = progress.phase === 'completed' && changedRows === 0
    ? `旧版数据库检查完成：已扫描约 ${formatCount(estimatedMaxRowId)} 行索引，未发现需要清理的旧版单字索引或持久化位置数据`
    : `${phaseLabel}：已扫描约 ${formatCount(Math.min(scannedRowId, estimatedMaxRowId))}/${formatCount(estimatedMaxRowId)} 行，已删除 ${formatCount(progress.deletedRows)} 行，已更新 ${formatCount(progress.updatedRows)} 行`

  emitBackgroundTaskStatus({
    taskId: 'database-maintenance:legacy-search-cleanup',
    kind: 'database-maintenance',
    status: progress.phase === 'completed' ? 'completed' : 'processing',
    progress: clampProgress(overallProgress),
    completedCount: scannedRowId,
    totalCount: estimatedMaxRowId,
    message,
  })
}

function estimateTableRows(tableName: string): number {
  try {
    return numberValue(queryOne<CountRow>(`SELECT MAX(rowid) AS count FROM ${tableName}`)?.count)
  } catch {
    return 0
  }
}

function estimateSampledRows(tableName: string, predicate: string, estimatedRows: number): number {
  if (estimatedRows <= 0) return 0
  try {
    const row = queryOne<SampleRow>(
      `SELECT COUNT(*) AS sampleRows,
              COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS total
       FROM (SELECT * FROM ${tableName} LIMIT 512)`,
    )
    const sampleRows = numberValue(row?.sampleRows)
    if (sampleRows <= 0) return 0
    return Math.round((numberValue(row?.total) / sampleRows) * estimatedRows)
  } catch {
    return 0
  }
}

function estimateSampledBytes(tableName: string, expression: string, estimatedRows: number): number {
  if (estimatedRows <= 0) return 0
  try {
    const row = queryOne<SampleRow>(
      `SELECT COUNT(*) AS sampleRows,
              COALESCE(SUM(${expression}), 0) AS total
       FROM (SELECT * FROM ${tableName} LIMIT 512)`,
    )
    const sampleRows = numberValue(row?.sampleRows)
    if (sampleRows <= 0) return 0
    return Math.round((numberValue(row?.total) / sampleRows) * estimatedRows)
  } catch {
    return 0
  }
}

function getStoragePragma(name: string): number {
  try {
    const row = getDatabase().pragma(name, { simple: true }) as unknown
    return numberValue(row)
  } catch {
    return 0
  }
}

function getSafeTables(): DatabaseTableStorageStat[] {
  const tables = [
    'documents',
    'pages',
    'page_ocr_versions',
    'folders',
    'document_folders',
    'tags',
    'document_tags',
    'metadata_candidates',
    'search_index_segments',
    'search_ngram_index',
    'search_index_segments_staging',
    'search_ngram_index_staging',
    'pages_fts',
    'search_segments_fts',
    'search_segments_trigram',
    'ai_chat_sessions',
    'ai_chat_turns',
    'ai_results',
    'page_ai_layout_cache',
    'page_translation_cache',
    'library_state_cache',
  ]
  return tables.map((tableName) => ({ tableName, rowCount: estimateTableRows(tableName) }))
}

function getSearchIndexStorage(): DatabaseSearchIndexStorageStat {
  const ngramRows = estimateTableRows('search_ngram_index')
  const segmentRows = estimateTableRows('search_index_segments')
  return {
    ngramRows,
    singleCharNgramRows: estimateSampledRows('search_ngram_index', 'length(gram) <= 1', ngramRows),
    ngramPositionsBytes: estimateSampledBytes('search_ngram_index', 'length(positions)', ngramRows),
    segmentRows,
    segmentTextBytes: estimateSampledBytes('search_index_segments', 'length(text) + length(normalized_text)', segmentRows),
    segmentOffsetMapBytes: estimateSampledBytes('search_index_segments', 'length(offset_map)', segmentRows),
    pagesFtsRows: estimateTableRows('pages_fts'),
    searchSegmentsFtsRows: estimateTableRows('search_segments_fts'),
    searchSegmentsTrigramRows: estimateTableRows('search_segments_trigram'),
  }
}

function buildWarnings(diagnostics: Omit<DatabaseStorageDiagnostics, 'warnings' | 'requiredMaintenance'>): string[] {
  const warnings: string[] = []
  if (diagnostics.freelistBytes > diagnostics.databaseBytes * 0.15) {
    warnings.push('数据库存在较多空闲页，压缩后可能释放明显磁盘空间。')
  }
  if (diagnostics.searchIndex.singleCharNgramRows > 0) {
    warnings.push('检测到旧版单字 ngram 索引，建议清理并重建轻量索引。')
  }
  if (diagnostics.searchIndex.ngramPositionsBytes > 1024 * 1024 * 256) {
    warnings.push('检索索引位置数据较大，可能是数据库膨胀的主要来源。')
  }
  return warnings
}

function buildRequiredMaintenance(diagnostics: Omit<DatabaseStorageDiagnostics, 'warnings' | 'requiredMaintenance'>): DatabaseRequiredMaintenance {
  const reasons: DatabaseRequiredMaintenanceReason[] = []
  if (diagnostics.searchIndex.ngramRows > 0) reasons.push('legacy-ngram-index')
  if (diagnostics.searchIndex.singleCharNgramRows > 0) reasons.push('legacy-single-char-ngram')
  if (diagnostics.searchIndex.ngramPositionsBytes > 0) reasons.push('legacy-ngram-positions')

  if (reasons.length === 0) {
    return {
      required: false,
      reasons: [],
      title: '',
      message: '',
      actionLabel: '',
    }
  }

  return {
    required: true,
    reasons,
    title: '需要升级文献库数据库',
    message: '检测到旧版搜索索引仍保存在当前数据库中。继续使用会占用大量空间，并可能影响新版检索与维护任务。请先按指引完成升级；升级不会删除文献、OCR 文本或 PDF 原文。',
    actionLabel: '开始升级数据库',
  }
}

export function getDatabaseStorageDiagnostics(): DatabaseStorageDiagnostics {
  const databasePath = getDatabaseFilePath()
  const pageSize = getStoragePragma('page_size')
  const pageCount = getStoragePragma('page_count')
  const freelistCount = getStoragePragma('freelist_count')
  const base = {
    databasePath,
    databaseBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
    pageSize,
    pageCount,
    freelistCount,
    freelistBytes: pageSize * freelistCount,
    checkedAt: new Date().toISOString(),
    searchIndexVersion: SEARCH_INDEX_VERSION,
    tables: getSafeTables(),
    searchIndex: getSearchIndexStorage(),
  }
  return {
    ...base,
    warnings: buildWarnings(base),
    requiredMaintenance: buildRequiredMaintenance(base),
  }
}

export async function exportDatabaseStorageDiagnostics(): Promise<DatabaseMaintenanceResult> {
  const diagnostics = getDatabaseStorageDiagnostics()
  const result = await dialog.showSaveDialog({
    title: '导出数据库诊断报告',
    defaultPath: join(dirname(diagnostics.databasePath), `gujismart-db-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) {
    return { success: false, message: '已取消导出' }
  }
  writeFileSync(result.filePath, JSON.stringify(diagnostics, null, 2), 'utf-8')
  return { success: true, message: '数据库诊断报告已导出', path: result.filePath }
}

export async function clearLegacySearchNgramIndex(onProgress: LegacySearchCleanupProgressCallback = emitDatabaseMaintenanceProgress): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  const estimatedMaxRowId = Math.max(1, Number(before.searchIndex.ngramRows || 0))
  try {
    let deletedRows = 0
    let updatedRows = 0
    if (!SEARCH_NGRAM_INDEX_ENABLED) {
      onProgress({ phase: 'ngram', scannedRowId: 0, estimatedMaxRowId, deletedRows, updatedRows })
      let lastDeleteRowId = 0
      while (true) {
        const upperRowId = getRowIdRangeUpperBound(
          'search_ngram_index',
          lastDeleteRowId,
          LEGACY_SEARCH_FULL_CLEANUP_ROWID_BATCH_SIZE,
        )
        if (upperRowId <= lastDeleteRowId) break
        deletedRows += runRowIdRangeDelete('search_ngram_index', lastDeleteRowId, upperRowId)
        lastDeleteRowId = upperRowId
        onProgress({ phase: 'ngram', scannedRowId: lastDeleteRowId, estimatedMaxRowId, deletedRows, updatedRows })
        await delay(LEGACY_SEARCH_CLEANUP_YIELD_MS)
      }
    } else {
      onProgress({ phase: 'single-char', scannedRowId: 0, estimatedMaxRowId, deletedRows, updatedRows })
      let lastDeleteRowId = 0
      while (true) {
        const rowIds = getRowIdBatch(
          'SELECT rowid FROM search_ngram_index WHERE rowid > ? AND length(gram) <= 1 ORDER BY rowid LIMIT ?',
          lastDeleteRowId,
        )
        if (rowIds.length === 0) break
        lastDeleteRowId = rowIds[rowIds.length - 1]
        deletedRows += runForRowIds('DELETE FROM search_ngram_index WHERE rowid IN', rowIds)
        onProgress({ phase: 'single-char', scannedRowId: lastDeleteRowId, estimatedMaxRowId, deletedRows, updatedRows })
        await delay(LEGACY_SEARCH_CLEANUP_YIELD_MS)
      }

      onProgress({ phase: 'positions', scannedRowId: 0, estimatedMaxRowId, deletedRows, updatedRows })
      let lastUpdateRowId = 0
      while (true) {
        const rowIds = getRowIdBatch(
          "SELECT rowid FROM search_ngram_index WHERE rowid > ? AND positions <> '[]' ORDER BY rowid LIMIT ?",
          lastUpdateRowId,
        )
        if (rowIds.length === 0) break
        lastUpdateRowId = rowIds[rowIds.length - 1]
        updatedRows += runForRowIds('UPDATE search_ngram_index SET positions = ? WHERE rowid IN', rowIds, ['[]'])
        onProgress({ phase: 'positions', scannedRowId: lastUpdateRowId, estimatedMaxRowId, deletedRows, updatedRows })
        await delay(LEGACY_SEARCH_CLEANUP_YIELD_MS)
      }
    }

    onProgress({ phase: 'staging', scannedRowId: estimatedMaxRowId, estimatedMaxRowId, deletedRows, updatedRows })
    run('DELETE FROM search_ngram_index_staging')
    scheduleDatabaseSave()
    const after = getDatabaseStorageDiagnostics()
    onProgress({ phase: 'completed', scannedRowId: estimatedMaxRowId, estimatedMaxRowId, deletedRows, updatedRows })
    return {
      success: true,
      message: SEARCH_NGRAM_INDEX_ENABLED
        ? '已分批清理旧版单字索引并移除持久化位置数据。数据库文件大小会在执行“压缩数据库”后真正释放到磁盘。'
        : '已分批清理巨大 ngram 候选索引；搜索会改用 FTS 与真实文本核验，准确性不受影响但短词搜索可能变慢。数据库文件大小会在执行“压缩数据库”后真正释放到磁盘。',
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes,
      deletedRows,
      updatedRows,
    }
  } catch (error) {
    emitBackgroundTaskStatus({
      taskId: 'database-maintenance:legacy-search-cleanup',
      kind: 'database-maintenance',
      status: 'error',
      progress: 1,
      errorMessage: error instanceof Error ? error.message : String(error),
      message: '清理搜索索引失败',
    })
    return {
      success: false,
      message: '清理搜索索引失败',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function compactDatabase(): DatabaseMaintenanceResult {
  const databasePath = getDatabaseFilePath()
  const beforeBytes = fileSize(databasePath)
  try {
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    getDatabase().exec('VACUUM')
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    const afterBytes = fileSize(databasePath)
    return {
      success: true,
      message: `数据库压缩完成：${basename(databasePath)}`,
      beforeBytes,
      afterBytes,
    }
  } catch (error) {
    return {
      success: false,
      message: '数据库压缩失败，原数据库未被删除。',
      beforeBytes,
      afterBytes: fileSize(databasePath),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function optimizeLegacyDatabaseStorage(): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  const cleaned = await clearLegacySearchNgramIndex()
  if (!cleaned.success) {
    return cleaned
  }

  const after = getDatabaseStorageDiagnostics()
  const optimizedRows = Number(cleaned.deletedRows || 0) + Number(cleaned.updatedRows || 0)

  return {
    success: true,
    message: optimizedRows > 0
      ? SEARCH_NGRAM_INDEX_ENABLED
        ? `旧版数据库优化完成：已分批处理 ${optimizedRows.toLocaleString()} 行旧搜索索引数据。为避免软件长时间未响应，本步骤不会自动压缩数据库；如需立刻释放磁盘空间，请在空闲时单独点击“压缩数据库”。当前可压缩空闲页约 ${formatStorageBytes(after.freelistBytes)}。`
        : `数据库瘦身完成：已分批清理 ${optimizedRows.toLocaleString()} 行 ngram 候选索引。搜索将改用 FTS 与真实文本核验，准确性不受影响但短词搜索可能变慢。本步骤不会自动压缩数据库；如需释放磁盘空间，请在空闲时单独点击“压缩数据库”。当前可压缩空闲页约 ${formatStorageBytes(after.freelistBytes)}。`
      : `数据库检查完成：未发现需要清理的 ngram 候选索引或旧版位置数据。如需释放磁盘空间，请在空闲时单独点击“压缩数据库”。当前可压缩空闲页约 ${formatStorageBytes(after.freelistBytes)}。`,
    beforeBytes: before.databaseBytes,
    afterBytes: after.databaseBytes,
    deletedRows: cleaned.deletedRows,
    updatedRows: cleaned.updatedRows,
  }
}
