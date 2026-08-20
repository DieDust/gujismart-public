import { dialog } from 'electron'
import { existsSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type {
  DatabaseMaintenanceStage,
  DatabaseMaintenanceResult,
  DatabaseMaintenanceState,
  DatabaseRequiredMaintenance,
  DatabaseRequiredMaintenanceReason,
  DatabaseSearchIndexStorageStat,
  DatabaseStorageLayerStat,
  DatabaseStorageDiagnostics,
  DatabaseTableStorageStat,
} from '../shared/types'
import { SEARCH_INDEX_VERSION, SEARCH_NGRAM_INDEX_ENABLED } from './search-index-constants'
import { getDatabase, getDatabaseFilePath, isSearchSegmentsFtsRebuildNeeded, queryAll, queryOne, rebuildSearchTables, run, scheduleDatabaseSave } from './database'
import { emitBackgroundTaskStatus } from './background-tasks'
import { cleanupUnreferencedPagePayloads, externalizeLargePayloads, getPagePayloadStorageStats } from './page-payload-store'
import { resolvePayloadDataDir } from './page-payload-files'
import {
  INLINE_JSON_MAX_CHARS,
  INLINE_TEXT_MAX_CHARS,
  type PagePayloadStorageStats,
} from './page-payload-statistics'
import {
  isDatabaseDiagnosticsWorkerAvailable,
  runDatabaseDiagnosticsWorkerTask,
} from './database-diagnostics-worker-client'

// Keep rowid-list batches below SQLite's bound-parameter ceiling. Full ngram
// cleanup uses rowid ranges instead, so it can safely sweep much larger slices.
const LEGACY_SEARCH_CLEANUP_BATCH_SIZE = 5_000
const LEGACY_SEARCH_FULL_CLEANUP_ROWID_BATCH_SIZE = 100_000
const LEGACY_SEARCH_CLEANUP_YIELD_MS = 10
const STORAGE_MODEL_VERSION = 'sqlite-metadata-external-assets-v1'
const DATABASE_MAINTENANCE_STATE_KEY = 'database_maintenance_state'
const CACHE_VERSION_PREFIX = 'library-sidebar-v2'
const INLINE_PAGE_PAYLOAD_REQUIRED_BYTES = 1024 * 1024
const MIN_NOTICEABLE_FREELIST_BYTES = 8 * 1024 * 1024
const LARGE_FREELIST_BYTES = 64 * 1024 * 1024
const FREELIST_RATIO_RECOMMEND_THRESHOLD = 0.1

interface CountRow {
  count?: number | null
}

interface SampleRow {
  sampleRows?: number | null
  total?: number | null
}

interface PayloadSampleRow {
  sampleRows?: number | null
  candidateRows?: number | null
  candidateBytes?: number | null
}

interface RowIdRow {
  rowid: number
}

interface SettingRow {
  value?: string | null
}

interface TableInfoRow {
  name?: string | null
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

function isDatabaseCompactionWorthwhile(freelistBytes: number, databaseBytes: number): boolean {
  if (!Number.isFinite(freelistBytes) || freelistBytes <= 0) return false
  if (freelistBytes >= LARGE_FREELIST_BYTES) return true
  return freelistBytes >= MIN_NOTICEABLE_FREELIST_BYTES
    && freelistBytes >= Math.max(1, databaseBytes) * FREELIST_RATIO_RECOMMEND_THRESHOLD
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

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function numberField(record: Record<string, unknown>, key: string): number {
  return numberValue(record[key])
}

function isMaintenanceStage(value: unknown): value is DatabaseMaintenanceStage {
  return typeof value === 'string' && [
    'idle',
    'diagnose',
    'cleanup-legacy-index',
    'externalize-page-payloads',
    'queue-lightweight-index',
    'compact',
    'verify',
    'completed',
    'failed',
  ].includes(value)
}

function defaultMaintenanceState(): DatabaseMaintenanceState {
  return {
    stage: 'idle',
    canResume: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    oldIndexRowsRemaining: 0,
    legacyIndexPresent: false,
    lightweightIndexQueued: false,
    compactionRecommended: false,
    migrationVersion: STORAGE_MODEL_VERSION,
  }
}

function readPersistedMaintenanceState(): DatabaseMaintenanceState {
  try {
    const row = queryOne<SettingRow>('SELECT value FROM settings WHERE key = ?', [DATABASE_MAINTENANCE_STATE_KEY])
    if (!row?.value) return defaultMaintenanceState()
    const parsed: unknown = JSON.parse(row.value)
    if (!isRecord(parsed)) return defaultMaintenanceState()
    return {
      stage: isMaintenanceStage(parsed.stage) ? parsed.stage : 'idle',
      canResume: booleanField(parsed, 'canResume'),
      lastStartedAt: stringField(parsed, 'lastStartedAt'),
      lastCompletedAt: stringField(parsed, 'lastCompletedAt'),
      lastError: stringField(parsed, 'lastError'),
      oldIndexRowsRemaining: numberField(parsed, 'oldIndexRowsRemaining'),
      legacyIndexPresent: booleanField(parsed, 'legacyIndexPresent'),
      lightweightIndexQueued: booleanField(parsed, 'lightweightIndexQueued'),
      compactionRecommended: booleanField(parsed, 'compactionRecommended'),
      migrationVersion: stringField(parsed, 'migrationVersion') || STORAGE_MODEL_VERSION,
    }
  } catch {
    return defaultMaintenanceState()
  }
}

function tableHasColumn(tableName: string, columnName: string): boolean {
  try {
    return getDatabase()
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .some((row) => String((row as TableInfoRow).name || '') === columnName)
  } catch {
    return false
  }
}

function persistMaintenanceState(patch: Partial<DatabaseMaintenanceState>): DatabaseMaintenanceState {
  const next = { ...readPersistedMaintenanceState(), ...patch, migrationVersion: STORAGE_MODEL_VERSION }
  if (tableHasColumn('settings', 'updated_at')) {
    run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [DATABASE_MAINTENANCE_STATE_KEY, JSON.stringify(next), nowIso()],
    )
  } else {
    run(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [DATABASE_MAINTENANCE_STATE_KEY, JSON.stringify(next)],
    )
  }
  scheduleDatabaseSave()
  return next
}

function getActiveSearchMaintenanceJobCount(): number {
  try {
    const row = queryOne<{ count?: number | null }>(
      "SELECT COUNT(*) AS count FROM search_index_status WHERE status IN ('queued', 'processing')",
    )
    return Number(row?.count || 0)
  } catch {
    return 0
  }
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
      ? '正在清理旧版 ngram 候选索引'
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
    'page_translation_units',
    'library_state_cache',
  ]
  return tables.map((tableName) => ({ tableName, rowCount: estimateTableRows(tableName) }))
}

function getSearchIndexStorage(): DatabaseSearchIndexStorageStat {
  const ngramRows = estimateTableRows('search_ngram_index')
  const segmentRows = estimateTableRows('search_index_segments')
  const segmentTextBytes = estimateSampledBytes('search_index_segments', 'length(text) + length(normalized_text)', segmentRows)
  const segmentOffsetMapBytes = estimateSampledBytes('search_index_segments', 'length(offset_map)', segmentRows)
  return {
    ngramRows,
    singleCharNgramRows: estimateSampledRows('search_ngram_index', 'length(gram) <= 1', ngramRows),
    ngramPositionsBytes: estimateSampledBytes('search_ngram_index', 'length(positions)', ngramRows),
    segmentRows,
    segmentTextBytes,
    segmentOffsetMapBytes,
    pagesFtsRows: estimateTableRows('pages_fts'),
    searchSegmentsFtsRows: estimateTableRows('search_segments_fts'),
    searchSegmentsTrigramRows: estimateTableRows('search_segments_trigram'),
    enterpriseSearchMigrationRecommended: isSearchSegmentsFtsRebuildNeeded(),
  }
}

function getStartupSearchIndexStorage(): DatabaseSearchIndexStorageStat {
  const ngramRows = estimateTableRows('search_ngram_index')
  return {
    ngramRows,
    singleCharNgramRows: estimateSampledRows('search_ngram_index', 'length(gram) <= 1', ngramRows),
    ngramPositionsBytes: estimateSampledBytes('search_ngram_index', 'length(positions)', ngramRows),
    segmentRows: 0,
    segmentTextBytes: 0,
    segmentOffsetMapBytes: 0,
    pagesFtsRows: 0,
    searchSegmentsFtsRows: 0,
    searchSegmentsTrigramRows: 0,
    enterpriseSearchMigrationRecommended: isSearchSegmentsFtsRebuildNeeded(),
  }
}

function estimateBoundedPayloadCandidates(
  tableName: string,
  columns: string,
  predicate: string,
  expression: string,
): { rows: number; bytes: number } {
  const estimatedRows = estimateTableRows(tableName)
  if (estimatedRows <= 0) return { rows: 0, bytes: 0 }
  try {
    const row = queryOne<PayloadSampleRow>(
      `SELECT COUNT(*) AS sampleRows,
              COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS candidateRows,
              COALESCE(SUM(CASE WHEN ${predicate} THEN ${expression} ELSE 0 END), 0) AS candidateBytes
       FROM (SELECT ${columns} FROM ${tableName} ORDER BY rowid DESC LIMIT 512)`,
    )
    const sampleRows = numberValue(row?.sampleRows)
    if (sampleRows <= 0) return { rows: 0, bytes: 0 }
    const scale = estimatedRows / sampleRows
    return {
      rows: Math.min(estimatedRows, Math.round(numberValue(row?.candidateRows) * scale)),
      bytes: Math.round(numberValue(row?.candidateBytes) * scale),
    }
  } catch {
    return { rows: 0, bytes: 0 }
  }
}

function getBoundedStartupPagePayloadStats(): PagePayloadStorageStats {
  const pageCandidates = estimateBoundedPayloadCandidates(
    'pages',
    'ocr_text, ocr_result, proofed_text, ocr_text_ref, ocr_result_ref, proofed_text_ref',
    `((ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ${INLINE_TEXT_MAX_CHARS})
      OR ((ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ${INLINE_JSON_MAX_CHARS})
      OR ((proofed_text_ref IS NULL OR proofed_text_ref = '') AND length(COALESCE(proofed_text, '')) > ${INLINE_TEXT_MAX_CHARS})`,
    "length(COALESCE(ocr_text, '')) + length(COALESCE(ocr_result, '')) + length(COALESCE(proofed_text, ''))",
  )
  const versionCandidates = estimateBoundedPayloadCandidates(
    'page_ocr_versions',
    'ocr_text, ocr_result, ocr_text_ref, ocr_result_ref',
    `((ocr_text_ref IS NULL OR ocr_text_ref = '') AND length(COALESCE(ocr_text, '')) > ${INLINE_TEXT_MAX_CHARS})
      OR ((ocr_result_ref IS NULL OR ocr_result_ref = '') AND length(COALESCE(ocr_result, '')) > ${INLINE_JSON_MAX_CHARS})`,
    "length(COALESCE(ocr_text, '')) + length(COALESCE(ocr_result, ''))",
  )
  const aiCacheCandidates = estimateBoundedPayloadCandidates(
    'page_ai_layout_cache',
    'result_text, result_text_ref',
    `(result_text_ref IS NULL OR result_text_ref = '') AND length(COALESCE(result_text, '')) > ${INLINE_TEXT_MAX_CHARS}`,
    "length(COALESCE(result_text, ''))",
  )
  const translationCandidates = estimateBoundedPayloadCandidates(
    'page_translation_cache',
    'source_text, translation_text, source_text_ref, translation_text_ref',
    `((source_text_ref IS NULL OR source_text_ref = '') AND length(COALESCE(source_text, '')) > ${INLINE_TEXT_MAX_CHARS})
      OR ((translation_text_ref IS NULL OR translation_text_ref = '') AND length(COALESCE(translation_text, '')) > ${INLINE_TEXT_MAX_CHARS})`,
    "length(COALESCE(source_text, '')) + length(COALESCE(translation_text, ''))",
  )
  const candidates = [pageCandidates, versionCandidates, aiCacheCandidates, translationCandidates]
  return {
    externalFileCount: 0,
    externalBytes: 0,
    referencedFileCount: 0,
    missingReferencedFileCount: 0,
    orphanedFileCount: 0,
    orphanedBytes: 0,
    estimatedMissingReferencedBytes: 0,
    inlineCandidateRows: candidates.reduce((sum, item) => sum + item.rows, 0),
    inlineCandidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
  }
}

function tableRowCount(tables: DatabaseTableStorageStat[], tableName: string): number {
  return tables.find((table) => table.tableName === tableName)?.rowCount || 0
}

function estimateStorageLayers(
  tables: DatabaseTableStorageStat[],
  searchIndex: DatabaseSearchIndexStorageStat,
  payloadStats: PagePayloadStorageStats,
): DatabaseStorageLayerStat[] {
  const metadataRows = [
    'documents',
    'folders',
    'document_folders',
    'tags',
    'document_tags',
    'metadata_candidates',
    'ai_chat_sessions',
    'ai_chat_turns',
    'ai_results',
  ].reduce((sum, table) => sum + tableRowCount(tables, table), 0)
  const documentTextRows = tableRowCount(tables, 'pages') + tableRowCount(tables, 'page_ocr_versions')
  const searchRows = searchIndex.ngramRows
    + searchIndex.segmentRows
    + searchIndex.pagesFtsRows
    + searchIndex.searchSegmentsFtsRows
    + searchIndex.searchSegmentsTrigramRows
  const cacheRows = tableRowCount(tables, 'page_ai_layout_cache')
    + tableRowCount(tables, 'page_translation_cache')
    + tableRowCount(tables, 'page_translation_units')
    + tableRowCount(tables, 'library_state_cache')
  return [
    { kind: 'metadata', label: '元数据与关系', rowCount: metadataRows, estimatedBytes: 0 },
    {
      kind: 'document-text',
      label: '页面文本与 OCR 结果',
      rowCount: documentTextRows,
      estimatedBytes: payloadStats.inlineCandidateBytes,
    },
    {
      kind: 'external-payload',
      label: '外置页面大字段',
      rowCount: payloadStats.externalFileCount,
      estimatedBytes: payloadStats.externalBytes,
    },
    {
      kind: 'search-index',
      label: '检索候选索引',
      rowCount: searchRows,
      estimatedBytes: searchIndex.ngramPositionsBytes + searchIndex.segmentOffsetMapBytes,
    },
    { kind: 'cache', label: '可重建缓存', rowCount: cacheRows, estimatedBytes: 0 },
    { kind: 'runtime', label: '运行维护状态', rowCount: tableRowCount(tables, 'search_index_status'), estimatedBytes: 0 },
  ]
}

function hasLegacyCacheVersion(): boolean {
  try {
    const row = queryOne<{ cache_json?: string | null }>(
      'SELECT cache_json FROM library_state_cache WHERE cache_key = ?',
      ['library-sidebar-v1'],
    )
    if (!row?.cache_json) return false
    const parsed: unknown = JSON.parse(row.cache_json)
    if (!isRecord(parsed)) return true
    const version = typeof parsed.version === 'string' ? parsed.version : ''
    return !version.startsWith(CACHE_VERSION_PREFIX)
  } catch {
    return false
  }
}

function buildWarnings(diagnostics: Omit<DatabaseStorageDiagnostics, 'warnings' | 'requiredMaintenance'>): string[] {
  const warnings: string[] = []
  if (diagnostics.freelistBytes > diagnostics.databaseBytes * 0.15) {
    warnings.push('数据库存在较多空闲页，压缩后可能释放明显磁盘空间。')
  }
  if (diagnostics.searchIndex.singleCharNgramRows > 0) {
    warnings.push('检测到旧版单字检索索引，建议清理并重建轻量索引。')
  }
  if (diagnostics.searchIndex.ngramPositionsBytes > 1024 * 1024 * 256) {
    warnings.push('检索索引位置数据较大，可能是数据库膨胀的主要来源。')
  }
  if (diagnostics.searchIndex.enterpriseSearchMigrationRecommended) {
    warnings.push('新版全文索引结构需要校准。点击一键升级后，软件会在后台重建轻量索引；这不会阻止进入软件。')
  }
  const documentTextLayer = diagnostics.storageLayers.find((layer) => layer.kind === 'document-text')
  if (Number(documentTextLayer?.estimatedBytes || 0) > INLINE_PAGE_PAYLOAD_REQUIRED_BYTES) {
    warnings.push('检测到较大的页面 OCR 内容仍保存在数据库内部。建议先迁移为外置压缩大字段，再压缩数据库以释放磁盘空间。')
  }
  if (diagnostics.externalPayloads.orphanedFileCount > 0) {
    warnings.push('检测到未被数据库记录引用的外置大字段文件，清理后可释放部分空间。')
  }
  if (diagnostics.externalPayloads.missingReferencedFileCount > 0) {
    warnings.push('检测到数据库引用的外置大字段文件缺失，可能导致版式还原坐标、OCR 结果、检索或导出不完整。请从包含 storage/page-payloads 的完整备份恢复，或重新 OCR 受影响页面。')
  }
  return warnings
}

function buildRequiredMaintenance(diagnostics: Omit<DatabaseStorageDiagnostics, 'warnings' | 'requiredMaintenance'>): DatabaseRequiredMaintenance {
  const reasons: DatabaseRequiredMaintenanceReason[] = []
  if (diagnostics.searchIndex.ngramRows > 0) reasons.push('legacy-ngram-index')
  if (diagnostics.searchIndex.singleCharNgramRows > 0) reasons.push('legacy-single-char-ngram')
  if (diagnostics.searchIndex.ngramPositionsBytes > 0) reasons.push('legacy-ngram-positions')
  if (diagnostics.searchIndex.enterpriseSearchMigrationRecommended) reasons.push('enterprise-search-index')
  const documentTextLayer = diagnostics.storageLayers.find((layer) => layer.kind === 'document-text')
  if (Number(documentTextLayer?.estimatedBytes || 0) > INLINE_PAGE_PAYLOAD_REQUIRED_BYTES) reasons.push('inline-page-payloads')

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
    title: '需要升级并压缩文献库数据库',
    message: '检测到当前文献库还没有完全适配新版企业级数据库结构。请先完成旧索引清理、轻量全文索引升级、页面大字段迁移和数据库压缩；本流程不会删除文献、OCR 文本或 PDF 原文。',
    actionLabel: '升级并压缩数据库',
  }
}

function buildDatabaseStorageDiagnostics(pagePayloadStats: PagePayloadStorageStats): DatabaseStorageDiagnostics {
  const databasePath = getDatabaseFilePath()
  const databaseBytes = fileSize(databasePath)
  const pageSize = getStoragePragma('page_size')
  const pageCount = getStoragePragma('page_count')
  const freelistCount = getStoragePragma('freelist_count')
  const freelistBytes = pageSize * freelistCount
  const compactionRecommended = isDatabaseCompactionWorthwhile(freelistBytes, databaseBytes)
  const tables = getSafeTables()
  const searchIndex = getSearchIndexStorage()
  const persistedMaintenanceState = readPersistedMaintenanceState()
  const legacyIndexPresent = searchIndex.ngramRows > 0 || searchIndex.singleCharNgramRows > 0 || searchIndex.ngramPositionsBytes > 0
  let maintenanceState: DatabaseMaintenanceState = {
    ...persistedMaintenanceState,
    oldIndexRowsRemaining: searchIndex.ngramRows,
    legacyIndexPresent,
    compactionRecommended,
    canResume: persistedMaintenanceState.stage !== 'idle'
      && persistedMaintenanceState.stage !== 'completed'
      && (persistedMaintenanceState.stage !== 'failed' || persistedMaintenanceState.canResume),
    migrationVersion: STORAGE_MODEL_VERSION,
  }
  const base = {
    databasePath,
    databaseBytes,
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
    pageSize,
    pageCount,
    freelistCount,
    freelistBytes,
    checkedAt: new Date().toISOString(),
    searchIndexVersion: SEARCH_INDEX_VERSION,
    storageModelVersion: STORAGE_MODEL_VERSION,
    tables,
    storageLayers: estimateStorageLayers(tables, searchIndex, pagePayloadStats),
    externalPayloads: {
      fileCount: pagePayloadStats.externalFileCount,
      referencedFileCount: pagePayloadStats.referencedFileCount,
      missingReferencedFileCount: pagePayloadStats.missingReferencedFileCount,
      orphanedFileCount: pagePayloadStats.orphanedFileCount,
      bytes: pagePayloadStats.externalBytes,
      estimatedOrphanedBytes: pagePayloadStats.orphanedBytes,
      estimatedMissingReferencedBytes: pagePayloadStats.estimatedMissingReferencedBytes,
    },
    searchIndex,
    maintenanceState,
  }
  const requiredMaintenance = buildRequiredMaintenance(base)
  if (
    maintenanceState.stage === 'queue-lightweight-index'
    && !requiredMaintenance.required
    && getActiveSearchMaintenanceJobCount() === 0
  ) {
    maintenanceState = {
      ...persistMaintenanceState({
        stage: 'completed',
        canResume: false,
        lastCompletedAt: nowIso(),
        lastError: null,
        oldIndexRowsRemaining: searchIndex.ngramRows,
        legacyIndexPresent,
        lightweightIndexQueued: false,
        compactionRecommended,
      }),
      oldIndexRowsRemaining: searchIndex.ngramRows,
      legacyIndexPresent,
      compactionRecommended,
    }
  }
  const normalizedBase = { ...base, maintenanceState }
  return {
    ...normalizedBase,
    warnings: buildWarnings(normalizedBase),
    requiredMaintenance,
  }
}

export function getDatabaseStartupStorageDiagnostics(): DatabaseStorageDiagnostics {
  const databasePath = getDatabaseFilePath()
  const databaseBytes = fileSize(databasePath)
  const pageSize = getStoragePragma('page_size')
  const pageCount = getStoragePragma('page_count')
  const freelistCount = getStoragePragma('freelist_count')
  const freelistBytes = pageSize * freelistCount
  const compactionRecommended = isDatabaseCompactionWorthwhile(freelistBytes, databaseBytes)
  const pagePayloadStats = getBoundedStartupPagePayloadStats()
  const searchIndex = getStartupSearchIndexStorage()
  const persistedMaintenanceState = readPersistedMaintenanceState()
  const legacyIndexPresent = searchIndex.ngramRows > 0
    || searchIndex.singleCharNgramRows > 0
    || searchIndex.ngramPositionsBytes > 0
  const maintenanceState: DatabaseMaintenanceState = {
    ...persistedMaintenanceState,
    oldIndexRowsRemaining: searchIndex.ngramRows,
    legacyIndexPresent,
    compactionRecommended,
    canResume: persistedMaintenanceState.stage !== 'idle'
      && persistedMaintenanceState.stage !== 'completed'
      && (persistedMaintenanceState.stage !== 'failed' || persistedMaintenanceState.canResume),
    migrationVersion: STORAGE_MODEL_VERSION,
  }
  const base = {
    databasePath,
    databaseBytes,
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
    pageSize,
    pageCount,
    freelistCount,
    freelistBytes,
    checkedAt: new Date().toISOString(),
    searchIndexVersion: SEARCH_INDEX_VERSION,
    storageModelVersion: STORAGE_MODEL_VERSION,
    tables: [],
    storageLayers: estimateStorageLayers([], searchIndex, pagePayloadStats),
    externalPayloads: {
      fileCount: 0,
      referencedFileCount: 0,
      missingReferencedFileCount: 0,
      orphanedFileCount: 0,
      bytes: 0,
      estimatedOrphanedBytes: 0,
      estimatedMissingReferencedBytes: 0,
    },
    searchIndex,
    maintenanceState,
  }
  const normalizedBase = { ...base, requiredMaintenance: buildRequiredMaintenance(base) }
  return {
    ...normalizedBase,
    warnings: buildWarnings(normalizedBase),
  }
}

export function getDatabaseStorageDiagnostics(): DatabaseStorageDiagnostics {
  return buildDatabaseStorageDiagnostics(getPagePayloadStorageStats())
}

export async function getDatabaseStorageDiagnosticsAsync(): Promise<DatabaseStorageDiagnostics> {
  if (!isDatabaseDiagnosticsWorkerAvailable()) return getDatabaseStorageDiagnostics()
  try {
    const pagePayloadStats = await runDatabaseDiagnosticsWorkerTask({
      dbFilePath: getDatabaseFilePath(),
      dataDir: resolvePayloadDataDir(),
    })
    return buildDatabaseStorageDiagnostics(pagePayloadStats)
  } catch (error) {
    console.warn('[DatabaseDiagnostics] Worker scan failed, falling back to main process', error)
    return getDatabaseStorageDiagnostics()
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
    persistMaintenanceState({
      stage: 'cleanup-legacy-index',
      canResume: true,
      lastStartedAt: nowIso(),
      lastError: null,
      oldIndexRowsRemaining: before.searchIndex.ngramRows,
      legacyIndexPresent: before.maintenanceState.legacyIndexPresent,
      compactionRecommended: before.freelistBytes > 0,
    })
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
    persistMaintenanceState({
      stage: 'verify',
      canResume: false,
      oldIndexRowsRemaining: after.searchIndex.ngramRows,
      legacyIndexPresent: after.maintenanceState.legacyIndexPresent,
      compactionRecommended: after.freelistBytes > 0,
    })
    onProgress({ phase: 'completed', scannedRowId: estimatedMaxRowId, estimatedMaxRowId, deletedRows, updatedRows })
    return {
      success: true,
      message: SEARCH_NGRAM_INDEX_ENABLED
        ? '已分批清理旧版单字索引并移除持久化位置数据。数据库文件大小会在执行“压缩数据库”后真正释放到磁盘。'
        : '已分批清理旧版 ngram 候选索引；搜索会改用 FTS 与真实文本核验，准确性不受影响但短词搜索可能变慢。数据库文件大小会在执行“压缩数据库”后真正释放到磁盘。',
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes,
      deletedRows,
      updatedRows,
    }
  } catch (error) {
    persistMaintenanceState({
      stage: 'failed',
      canResume: true,
      lastError: error instanceof Error ? error.message : String(error),
    })
    emitBackgroundTaskStatus({
      taskId: 'database-maintenance:legacy-search-cleanup',
      kind: 'database-maintenance',
      status: 'error',
      progress: 1,
      errorMessage: error instanceof Error ? error.message : String(error),
      message: '娓呯悊鎼滅储绱㈠紩澶辫触',
    })
    return {
      success: false,
      message: '娓呯悊鎼滅储绱㈠紩澶辫触',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function compactDatabase(): DatabaseMaintenanceResult {
  const databasePath = getDatabaseFilePath()
  const beforeBytes = fileSize(databasePath)
  try {
    persistMaintenanceState({
      stage: 'compact',
      canResume: true,
      lastStartedAt: nowIso(),
      lastError: null,
    })
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    getDatabase().exec('VACUUM')
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    const afterBytes = fileSize(databasePath)
    persistMaintenanceState({
      stage: 'completed',
      canResume: false,
      lastCompletedAt: nowIso(),
      lastError: null,
      compactionRecommended: false,
    })
    return {
      success: true,
      message: `数据库压缩完成：${basename(databasePath)}`,
      beforeBytes,
      afterBytes,
    }
  } catch (error) {
    persistMaintenanceState({
      stage: 'failed',
      canResume: true,
      lastError: error instanceof Error ? error.message : String(error),
      compactionRecommended: true,
    })
    return {
      success: false,
      message: '数据库压缩失败，原数据库未被删除。',
      beforeBytes,
      afterBytes: fileSize(databasePath),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function externalizePagePayloadStorage(): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  try {
    persistMaintenanceState({
      stage: 'externalize-page-payloads',
      canResume: true,
      lastStartedAt: nowIso(),
      lastError: null,
      compactionRecommended: before.freelistBytes > 0,
    })

    let totalRows = 0
    let totalFields = 0
    let totalBytes = 0
    for (;;) {
      const batch = externalizeLargePayloads({ limit: 500 })
      totalRows += batch.externalizedRows
      totalFields += batch.externalizedFields
      totalBytes += batch.externalizedBytes
      emitBackgroundTaskStatus({
        taskId: 'database-maintenance:page-payload-externalize',
        kind: 'database-maintenance',
        status: batch.scannedRows > 0 ? 'processing' : 'completed',
        progress: batch.scannedRows > 0 ? 0.5 : 1,
        completedCount: totalRows,
        message: `正在迁移大文本与 OCR 大字段：已处理 ${formatCount(totalRows)} 行。`,
      })
      if (batch.scannedRows === 0 || batch.externalizedFields === 0) break
      await delay(LEGACY_SEARCH_CLEANUP_YIELD_MS)
    }

    scheduleDatabaseSave()
    const after = getDatabaseStorageDiagnostics()
    persistMaintenanceState({
      stage: 'verify',
      canResume: false,
      lastCompletedAt: nowIso(),
      lastError: null,
      compactionRecommended: true,
    })
    return {
      success: true,
      message: `页面大字段迁移完成：已迁移 ${formatCount(totalFields)} 个大字段，约 ${formatStorageBytes(totalBytes)}。请继续压缩数据库以释放数据库文件空间。`,
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes,
      updatedRows: totalRows,
    }
  } catch (error) {
    persistMaintenanceState({
      stage: 'failed',
      canResume: true,
      lastError: error instanceof Error ? error.message : String(error),
      compactionRecommended: true,
    })
    return {
      success: false,
      message: '页面大字段迁移失败，原数据库未被删除。',
      beforeBytes: before.databaseBytes,
      afterBytes: getDatabaseStorageDiagnostics().databaseBytes,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function hasInlinePagePayloadMaintenance(diagnostics: DatabaseStorageDiagnostics): boolean {
  const documentTextLayer = diagnostics.storageLayers.find((layer) => layer.kind === 'document-text')
  return Number(documentTextLayer?.estimatedBytes || 0) > INLINE_PAGE_PAYLOAD_REQUIRED_BYTES
    || diagnostics.requiredMaintenance.reasons.includes('inline-page-payloads')
}

export async function cleanupExternalPagePayloadStorage(): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  try {
    persistMaintenanceState({
      stage: 'externalize-page-payloads',
      canResume: true,
      lastStartedAt: nowIso(),
      lastError: null,
      compactionRecommended: before.freelistBytes > 0,
    })
    emitBackgroundTaskStatus({
      taskId: 'database-maintenance:external-payload-cleanup',
      kind: 'database-maintenance',
      status: 'processing',
      progress: 0.2,
      completedCount: 0,
      message: '正在扫描外置大字段引用。',
    })
    const cleanup = cleanupUnreferencedPagePayloads()
    scheduleDatabaseSave()
    emitBackgroundTaskStatus({
      taskId: 'database-maintenance:external-payload-cleanup',
      kind: 'database-maintenance',
      status: 'completed',
      progress: 1,
      completedCount: cleanup.deletedFiles,
      totalCount: cleanup.scannedFiles,
      message: `已清理 ${formatCount(cleanup.deletedFiles)} 个未引用的大字段文件。`,
    })
    persistMaintenanceState({
      stage: 'verify',
      canResume: false,
      lastCompletedAt: nowIso(),
      lastError: null,
      compactionRecommended: before.freelistBytes > 0,
    })
    return {
      success: true,
      message: `未引用大字段清理完成：已删除 ${formatCount(cleanup.deletedFiles)} 个文件，约 ${formatStorageBytes(cleanup.deletedBytes)}。`,
      beforeBytes: before.externalPayloads.bytes,
      afterBytes: getDatabaseStorageDiagnostics().externalPayloads.bytes,
      deletedRows: cleanup.deletedFiles,
    }
  } catch (error) {
    persistMaintenanceState({
      stage: 'failed',
      canResume: true,
      lastError: error instanceof Error ? error.message : String(error),
      compactionRecommended: true,
    })
    return {
      success: false,
      message: '未引用大字段清理失败，数据库记录未被更改。',
      beforeBytes: before.externalPayloads.bytes,
      afterBytes: getDatabaseStorageDiagnostics().externalPayloads.bytes,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Superseded OCR artifacts keep a full copy of every historical OCR result and
// grow without bound on re-OCR. Rows referenced as the active artifact or as a
// proofreading base are never touched; everything else is provenance-only.
const OCR_HISTORY_PRUNE_BATCH_SIZE = 2_000

const PRUNABLE_OCR_ARTIFACT_SELECT = `
  SELECT a.rowid AS rowid FROM ocr_artifact_versions a
  WHERE a.status IN ('superseded', 'error')
    AND a.id NOT IN (SELECT active_ocr_artifact_id FROM pages WHERE active_ocr_artifact_id IS NOT NULL)
    AND a.id NOT IN (SELECT proof_base_artifact_id FROM pages WHERE proof_base_artifact_id IS NOT NULL)
    AND a.id NOT IN (SELECT artifact_id FROM ocr_page_active_artifacts)`

const PRUNABLE_OCR_ATTEMPT_SELECT = `
  SELECT t.rowid AS rowid FROM ocr_page_attempts t
  WHERE t.status IN ('completed', 'error', 'canceled')
    AND t.id NOT IN (SELECT attempt_id FROM ocr_artifact_versions WHERE attempt_id IS NOT NULL)`

const PRUNABLE_OCR_RUN_SELECT = `
  SELECT r.rowid AS rowid FROM ocr_runs r
  WHERE r.status IN ('completed', 'error', 'canceled')
    AND r.id NOT IN (SELECT run_id FROM ocr_artifact_versions WHERE run_id IS NOT NULL)
    AND r.id NOT IN (SELECT run_id FROM ocr_page_attempts WHERE run_id IS NOT NULL)`

async function deletePrunableOcrRowsInBatches(
  selectSql: string,
  tableName: 'ocr_artifact_versions' | 'ocr_page_attempts' | 'ocr_runs',
  onProgress: (deletedSoFar: number) => void,
): Promise<number> {
  let deleted = 0
  for (;;) {
    const rows = queryAll<RowIdRow>(`${selectSql} LIMIT ?`, [OCR_HISTORY_PRUNE_BATCH_SIZE])
    if (rows.length === 0) return deleted
    const placeholders = rows.map(() => '?').join(', ')
    run(`DELETE FROM ${tableName} WHERE rowid IN (${placeholders})`, rows.map((row) => row.rowid))
    deleted += rows.length
    onProgress(deleted)
    await delay(LEGACY_SEARCH_CLEANUP_YIELD_MS)
  }
}

export async function pruneOcrArtifactHistory(): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  const taskId = 'database-maintenance:ocr-history-prune'
  try {
    persistMaintenanceState({
      stage: 'externalize-page-payloads',
      canResume: true,
      lastStartedAt: nowIso(),
      lastError: null,
      compactionRecommended: before.freelistBytes > 0,
    })
    emitBackgroundTaskStatus({
      taskId,
      kind: 'database-maintenance',
      status: 'processing',
      progress: 0.05,
      completedCount: 0,
      message: '正在扫描可清理的 OCR 历史版本。',
    })

    let deletedRows = 0
    const reportProgress = (message: string) => (deletedSoFar: number) => {
      emitBackgroundTaskStatus({
        taskId,
        kind: 'database-maintenance',
        status: 'processing',
        progress: 0.5,
        completedCount: deletedRows + deletedSoFar,
        message: `${message}：已删除 ${formatCount(deletedRows + deletedSoFar)} 行。`,
      })
    }
    const deletedArtifacts = await deletePrunableOcrRowsInBatches(
      PRUNABLE_OCR_ARTIFACT_SELECT,
      'ocr_artifact_versions',
      reportProgress('正在清理被取代的 OCR 历史版本'),
    )
    deletedRows += deletedArtifacts
    const deletedAttempts = await deletePrunableOcrRowsInBatches(
      PRUNABLE_OCR_ATTEMPT_SELECT,
      'ocr_page_attempts',
      reportProgress('正在清理历史 OCR 任务记录'),
    )
    deletedRows += deletedAttempts
    const deletedRuns = await deletePrunableOcrRowsInBatches(
      PRUNABLE_OCR_RUN_SELECT,
      'ocr_runs',
      reportProgress('正在清理历史 OCR 任务记录'),
    )
    deletedRows += deletedRuns

    // Historical artifacts may have been the last reference to externalized
    // payload files; sweep them in the same action so disk space is returned.
    let cleanedPayloadFiles = 0
    let cleanedPayloadBytes = 0
    if (deletedArtifacts > 0) {
      const cleanup = cleanupUnreferencedPagePayloads()
      cleanedPayloadFiles = cleanup.deletedFiles
      cleanedPayloadBytes = cleanup.deletedBytes
    }

    scheduleDatabaseSave()
    const after = getDatabaseStorageDiagnostics()
    persistMaintenanceState({
      stage: 'verify',
      canResume: false,
      lastCompletedAt: nowIso(),
      lastError: null,
      compactionRecommended: deletedRows > 0 || after.freelistBytes > 0,
    })
    emitBackgroundTaskStatus({
      taskId,
      kind: 'database-maintenance',
      status: 'completed',
      progress: 1,
      completedCount: deletedRows,
      message: deletedRows > 0
        ? `OCR 历史版本清理完成：已删除 ${formatCount(deletedRows)} 行。`
        : '没有发现可清理的 OCR 历史版本。',
    })
    return {
      success: true,
      message: deletedRows > 0
        ? `OCR 历史版本清理完成：已删除 ${formatCount(deletedArtifacts)} 个被取代的历史 OCR 版本和 ${formatCount(deletedAttempts + deletedRuns)} 条历史任务记录${cleanedPayloadFiles > 0 ? `，并清理 ${formatCount(cleanedPayloadFiles)} 个未引用大字段文件（约 ${formatStorageBytes(cleanedPayloadBytes)}）` : ''}。当前使用中的 OCR 结果与校对底稿未受影响；请在空闲时点击“压缩数据库”释放数据库文件空间。`
        : '没有发现可清理的 OCR 历史版本：所有 OCR 结果都是当前使用中或被校对底稿引用的版本。',
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes,
      deletedRows,
    }
  } catch (error) {
    persistMaintenanceState({
      stage: 'failed',
      canResume: true,
      lastError: error instanceof Error ? error.message : String(error),
      compactionRecommended: true,
    })
    emitBackgroundTaskStatus({
      taskId,
      kind: 'database-maintenance',
      status: 'error',
      progress: 1,
      completedCount: 0,
      message: 'OCR 历史版本清理失败。',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      message: 'OCR 历史版本清理失败，当前使用中的 OCR 结果未受影响。',
      beforeBytes: before.databaseBytes,
      afterBytes: getDatabaseStorageDiagnostics().databaseBytes,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function optimizeLegacyDatabaseStorage(): Promise<DatabaseMaintenanceResult> {
  const before = getDatabaseStorageDiagnostics()
  const hasLegacySearchMaintenance = before.searchIndex.ngramRows > 0
    || before.searchIndex.singleCharNgramRows > 0
    || before.searchIndex.ngramPositionsBytes > 0
  const needsEnterpriseSearchMigration = !!before.searchIndex.enterpriseSearchMigrationRecommended
  const needsPagePayloadMigration = hasInlinePagePayloadMaintenance(before)

  persistMaintenanceState({
    stage: 'diagnose',
    canResume: true,
    lastStartedAt: nowIso(),
    lastError: null,
    oldIndexRowsRemaining: before.searchIndex.ngramRows,
    legacyIndexPresent: before.maintenanceState.legacyIndexPresent,
    compactionRecommended: before.freelistBytes > 0 || needsPagePayloadMigration,
  })

  let cleaned: DatabaseMaintenanceResult = {
    success: true,
    message: '旧搜索索引已经清理完成。',
    beforeBytes: before.databaseBytes,
    afterBytes: before.databaseBytes,
    deletedRows: 0,
    updatedRows: 0,
  }

  if (hasLegacySearchMaintenance) {
    cleaned = await clearLegacySearchNgramIndex()
    if (!cleaned.success) return cleaned
  }

  if (needsEnterpriseSearchMigration) {
    try {
      rebuildSearchTables()
    } catch (error) {
      persistMaintenanceState({
        stage: 'failed',
        canResume: true,
        lastError: error instanceof Error ? error.message : String(error),
        compactionRecommended: true,
      })
      return {
        success: false,
        message: '企业级搜索索引迁移失败，数据库记录未被删除。',
        beforeBytes: before.databaseBytes,
        afterBytes: getDatabaseStorageDiagnostics().databaseBytes,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  let externalized: DatabaseMaintenanceResult = {
    success: true,
    message: '页面大字段已经迁移完成。',
    beforeBytes: before.databaseBytes,
    afterBytes: before.databaseBytes,
    deletedRows: 0,
    updatedRows: 0,
  }
  if (needsPagePayloadMigration) {
    externalized = await externalizePagePayloadStorage()
    if (!externalized.success) return externalized
  }

  const after = getDatabaseStorageDiagnostics()
  persistMaintenanceState({
    stage: 'queue-lightweight-index',
    canResume: false,
    oldIndexRowsRemaining: after.searchIndex.ngramRows,
    legacyIndexPresent: after.maintenanceState.legacyIndexPresent,
    compactionRecommended: after.freelistBytes > 0,
  })

  const optimizedRows = Number(cleaned.deletedRows || 0) + Number(cleaned.updatedRows || 0)
  const externalizedRows = Number(externalized.updatedRows || 0)
  const didMaintenance = optimizedRows > 0 || needsEnterpriseSearchMigration || needsPagePayloadMigration
  return {
    success: true,
    message: didMaintenance
      ? `数据库瘦身已完成：${optimizedRows > 0 ? `已清理 ${optimizedRows.toLocaleString()} 行旧候选索引，` : ''}${needsEnterpriseSearchMigration ? '已迁移为更轻量的企业级全文索引结构，' : ''}${needsPagePayloadMigration ? `已迁移 ${externalizedRows.toLocaleString()} 行页面大字段，` : ''}后台会继续重建文献索引。完成后请在空闲时点击“压缩数据库”释放磁盘空间。当前可压缩空闲页约 ${formatStorageBytes(after.freelistBytes)}。`
      : `数据库检查完成：没有发现需要瘦身的旧搜索索引、企业级索引迁移项或页面大字段迁移项。如需释放磁盘空间，请在空闲时单独点击“压缩数据库”。当前可压缩空闲页约 ${formatStorageBytes(after.freelistBytes)}。`,
    beforeBytes: before.databaseBytes,
    afterBytes: after.databaseBytes,
    deletedRows: cleaned.deletedRows,
    updatedRows: Number(cleaned.updatedRows || 0) + externalizedRows,
  }
}
