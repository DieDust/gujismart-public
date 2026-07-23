import { ipcMain, dialog } from 'electron'
import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { nativeImage } from 'electron'
import { nanoid } from 'nanoid'
import { basename, dirname, extname, join } from 'path'
import { posix as posixPath } from 'path'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { getMetadataCandidates, runAiTask } from '../ai'
import { getActiveTranslationGlossary, getTranslationGlossaryVersionSignature } from '../glossary-service'
import { clearPageSearchIndexForDocuments, getDataDir, getDatabaseFilePath, isFtsAvailable, isSearchSegmentsFtsRebuildNeeded, isSearchTrigramFtsAvailable, queryAll, queryOne, resetRebuildableSearchTables, refreshTagUsageForTags, resolveManagedStoragePath, run, saveDatabase, scheduleDatabaseSave, transaction } from '../database'
import { normalizeChineseSearchText } from '../text-normalization'
import { clearDocumentTocAutogenAttempt, saveDocumentToc } from '../toc-service'
import { normalizePageResult, normalizeStoredGujiOcrResultForRead } from '../ocr'
import { emitBackgroundTaskStatus } from '../background-tasks'
import { isHealthReportWorkerAvailable, runHealthReportWorkerTask } from '../health-report-worker-client'
import { buildPdfCompressionMetadata, getPdfCompressionSettings } from '../pdf-compression'
import { getPdfInfo, getPdfPageCountFast } from '../pdf-info'
import {
  addPdfRepositoryPath,
  annotateDocumentFileFingerprint,
  annotatePdfMetadata,
  cleanupCompletedPdfAssetsAsync,
  cleanupPdfAssetsAsync,
  copyFileWithFingerprintAsync,
  getFileFingerprint,
  getPdfFingerprintAsync,
  getPdfRepositoryStatus,
  indexPdfRepositoriesAsync,
  removePdfRepositoryById,
  restorePdfAssetForDocumentAsync,
} from '../pdf-assets'
import { markSearchIndexStaleForDocuments, markSearchIndexStaleForPages, notifySearchContentChanged, queueAllDocumentsReindex } from '../semantic-search'
import { syncDocumentMetadataTags } from '../metadata-tags'
import { markLibraryStateCacheDirty } from '../library-state-cache'
import { applyManualLiteraturePageAnchor, recomputeLiteraturePageMap, resetLiteraturePageMap } from '../literature-page-map'
import { clearMachineTranslationUnits, ensurePageTranslationUnits, translatePageUnits } from '../translation-service'
import { resolveFolderAndDescendantIds } from '../folder-scope'
import { inspectManagedDeleteTarget, type ManagedDeleteKind } from '../managed-path-boundary'
import { FileCapabilityError, fileCapabilityService } from '../file-capabilities'
import { cancelLegacyImportQueueTasks, registerLegacyImportQueueState } from '../task-import-compat'
import { attachCanonicalPageContent } from '../canonical-content'
import { importSelectionService } from '../import-selections'
import { hydratePagePayloadRow, hydratePagePayloadRows, preparePagePayloadUpdate } from '../page-payload-store'
import { normalizeHistoryDocType } from '../../shared/history-citation'
import { getErrorMessage } from '../../shared/errors'
import {
  DEFAULT_TRANSLATION_MODEL,
  DEFAULT_TRANSLATION_STYLE,
  buildTranslationCacheKey,
  normalizeTranslationSourceText,
} from '../../shared/translation-cache'
import {
  buildParallelTranslationInputFromSegments,
  buildParallelTranslationInputBatches,
  isParallelTranslationAligned,
  isParallelTranslationDisplayReady,
  normalizeParallelTranslationLayout,
  projectParallelTranslationTextToSource,
} from '../../shared/parallel-translation'
import { shouldTranslatePageText } from '../../shared/translation-text'
import { getCanonicalPageTranslationSourceText } from '../../shared/translation-source'
import { deriveOcrTextFromIr, ensureOcrResultIr, getOcrPageIr } from '../../shared/ocr-ir'
import { allowFileAccessPath, allowManagedFileAccessPath, assertAllowedLocalFilePath } from '../file-access'
import { documentPipelineDiagnosticsFromImportProgress } from '../../shared/document-pipeline-diagnostics'
import { statusEnvelopeFromImportProgress } from '../../shared/status-envelope'
import type {
  AiTaskOptions,
  AiLayoutCacheItem,
  AiLayoutMode,
  BookTranslationOptions,
  BookTranslationProgressEvent,
  BookTranslationStartResult,
  CompletedPdfAssetCleanupResult,
  CapabilityResult,
  Document,
  DocumentAppendPagePayload,
  DocumentAppendPagesOptions,
  DocumentDetail,
  DocumentHealthIssue,
  DocumentHealthIssueType,
  DocumentHealthReport,
  DocumentHealthReportOptions,
  DocumentHealthRow,
  DocumentLightDetail,
  DocumentLightPage,
  DocumentListItem,
  DocumentListPage,
  DocumentPage,
  DocumentReadingWindow,
  DocumentUpdatePayload,
  EbookManifest,
  EbookTextSection,
  EbookTocItem,
  Folder,
  ImportDocumentResult,
  ImportDocumentOptions,
  ImportSelection,
  ImportSelectionBatch,
  ImportProgressEvent,
  InitializePdfPagesOptions,
  LibraryImportQueueState,
  LibraryDocumentSearchField,
  ListDocumentOptions,
  OcrEngine,
  OcrRecognizeLayoutBlock,
  OcrRecognizeResult,
  PageUpdatePayload,
  PageOcrVersion,
  PageTranslationCacheItem,
  PageTranslationCachePayload,
  PdfAssetCleanupResult,
  PdfAssetRestoreOptions,
  PdfAssetRestoreResult,
  PdfRepositoryIndexResult,
  PdfRepositoryStatus,
  ReadStatus,
  ReaderState,
  ReaderStateSavePayload,
  Tag,
  TocItemV2,
  TranslationStyle,
  TranslationMode,
} from '../../shared/types'

type JsonRecord = Record<string, unknown>
const LIBRARY_IMPORT_QUEUE_STATE_ID = 'default'
const IMPORT_FILE_LEASE_TTL_MS = 8 * 60 * 60 * 1000

interface ImportedOcrBlock extends JsonRecord {
  words: string
}

interface ImportedWordResult {
  words: string
}

interface NormalizedImportedOcrPayload {
  ocrResult: unknown
  text: string
}

type DeletePathTask = {
  docId: string
  path: string
  label: string
  kind: ManagedDeleteKind
}

interface DeleteDocumentsResult {
  deletedIds: string[]
  failedIds: string[]
  successCount: number
}

interface DeleteDocumentDataResult {
  recoveredSearchIndexIssue: boolean
}

interface DeleteStepOptions {
  recoverableSearchIndexMalformed?: boolean
}

interface PageOcrMetaRow {
  proofed_text?: string | null
  ocr_text?: string | null
  ocr_result?: unknown
  proofed_text_ref?: string | null
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
}

interface DocumentTagRelationRow {
  doc_id: string
  id: string
  name: string
  color: string | null
  source: string | null
}

interface DocumentFolderRelationRow {
  doc_id: string
  id: string
  name: string
}

interface DocumentHealthSourceRow extends Document {
  actual_page_count?: number | null
  text_page_count?: number | null
  ocr_completed_page_count?: number | null
  image_page_count?: number | null
  research_note_count?: number | null
  search_segment_count?: number | null
}

type DocumentSearchPageRow = Omit<DocumentPage, 'image_path'>

function rejectProtectedPathFields(payload: unknown, fields: readonly string[]): void {
  if (!payload || typeof payload !== 'object') return
  const protectedField = fields.find((field) => field in payload)
  if (protectedField) {
    throw new Error(`不允许通过通用更新接口修改受保护路径字段：${protectedField}`)
  }
}

type InternalImportDocumentResult = ImportDocumentResult & { sourcePath?: string }

interface BookTranslationPageRow {
  id: string
  doc_id: string
  page_num: number
  ocr_text: string | null
  proofed_text: string | null
  ocr_result?: string | null
  ocr_text_ref?: string | null
  proofed_text_ref?: string | null
  ocr_result_ref?: string | null
}

interface BookTranslationPageWorkItem extends BookTranslationPageRow {
  sourceIndex: number
  sourceText: string
  translationText: string
  sourceHash: string
  onlyNonChinese: boolean
}

interface BookTranslationCacheRow {
  id?: string
  page_id?: string
  source_hash: string
  source_text?: string | null
  translation_text: string | null
  source_text_ref?: string | null
  translation_text_ref?: string | null
  status: PageTranslationCacheItem['status']
  skipped?: number | null
  error_message?: string | null
}

export interface InterruptedDocumentDeleteRecoverySummary {
  queuedDocuments: number
  cleanupTasks: number
}

type DocumentExistsRow = Pick<Document, 'id'>
type DocumentFileRow = Pick<Document, 'id'>
type DocumentPdfSourceRow = Pick<Document, 'id' | 'file_path'>
type DocumentMetadataRow = Pick<Document, 'metadata'>
type TranslationCachePageRow = Pick<DocumentPage, 'id' | 'doc_id' | 'page_num'>
interface ExistingPdfImportRow {
  id: string
  title: string
  file_path: string | null
  metadata: string | null
}

interface PageOcrVersionDetailRow extends PageOcrVersion {
  ocr_text?: string | null
  ocr_result?: string | null
}

const DELETE_SQL_CHUNK_SIZE = 100
// Keep each DELETE small so the main process can service UI IPC between chunks.
const DELETE_ROW_CHUNK_SIZE = 80
// Never wipe dozens of documents in one uninterrupted SQL storm.
const DELETE_DOC_BATCH_SIZE = 4
const DELETE_SLOW_STEP_MS = 700
const DELETE_FILE_CLEANUP_CONCURRENCY = 2
const activeDocumentDeleteIds = new Set<string>()
const activeDocumentDeleteJobs = new Set<Promise<void>>()
const activeDocumentImportJobs = new Set<Promise<void>>()
let documentImportShuttingDown = false
const activeBookTranslationJobTasks = new Set<Promise<void>>()
let bookTranslationRuntimeShuttingDown = false

function uniqueDocumentIds(ids: string[]): string[] {
  return [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))]
}

function runForIdChunks(ids: string[], callback: (chunkIds: string[], placeholders: string) => void): void {
  for (let index = 0; index < ids.length; index += DELETE_SQL_CHUNK_SIZE) {
    const chunkIds = ids.slice(index, index + DELETE_SQL_CHUNK_SIZE)
    if (chunkIds.length === 0) continue
    callback(chunkIds, chunkIds.map(() => '?').join(', '))
  }
}

async function runForIdChunksAsync(ids: string[], callback: (chunkIds: string[], placeholders: string) => void | Promise<void>): Promise<void> {
  for (let index = 0; index < ids.length; index += DELETE_SQL_CHUNK_SIZE) {
    const chunkIds = ids.slice(index, index + DELETE_SQL_CHUNK_SIZE)
    if (chunkIds.length === 0) continue
    await callback(chunkIds, chunkIds.map(() => '?').join(', '))
    if (index + DELETE_SQL_CHUNK_SIZE < ids.length) {
      await yieldToEventLoop()
    }
  }
}

function isDatabaseMalformedError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {}
  const code = String(record.code || '')
  const message = String(record.message || error || '')
  return code === 'SQLITE_CORRUPT'
    || /database disk image is malformed|database malformed|malformed database/i.test(message)
}

function formatDocumentDeleteFailureMessage(error: unknown): string {
  const message = (error as Error)?.message || String(error || '删除失败')
  if (!isDatabaseMalformedError(error)) return message
  return `数据库访问异常，删除未完成。通常是搜索索引或数据库页在上一次后台任务中断后进入异常状态；请重启软件后重试删除，若仍失败请到设置里执行数据库诊断/压缩或从自动备份恢复。原始错误：${message}`
}

async function timeDeleteStepAsync(label: string, callback: () => Promise<void>, options?: DeleteStepOptions): Promise<boolean> {
  const startedAt = Date.now()
  try {
    await callback()
    const elapsed = Date.now() - startedAt
    if (elapsed >= DELETE_SLOW_STEP_MS) {
      console.warn(`[Documents] Slow delete step: ${label} took ${elapsed}ms`)
    }
    return true
  } catch (error) {
    if (options?.recoverableSearchIndexMalformed && isDatabaseMalformedError(error)) {
      console.warn(`[Documents] Ignoring malformed rebuildable search index during delete step: ${label}`, error)
      return false
    }
    throw error
  }
}

async function deleteRowsByDocIdsAsync(tableName: string, docIds: string[]): Promise<void> {
  await runForIdChunksAsync(docIds, async (chunkIds, placeholders) => {
    while (true) {
      const rows = queryAll<{ rowid: number }>(
        `SELECT rowid FROM ${tableName} WHERE doc_id IN (${placeholders}) LIMIT ?`,
        [...chunkIds, DELETE_ROW_CHUNK_SIZE],
      )
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      run(`DELETE FROM ${tableName} WHERE rowid IN (${rowPlaceholders})`, rows.map((row) => row.rowid))
      await yieldToEventLoop()
    }
  })
}

async function deleteFtsRowsByDocIdsAsync(docIds: string[]): Promise<void> {
  if (!isFtsAvailable()) return
  await runForIdChunksAsync(docIds, async (chunkIds, placeholders) => {
    while (true) {
      const rows = queryAll<{ rowid: number }>(
        `SELECT rowid FROM pages_fts WHERE doc_id IN (${placeholders}) LIMIT ?`,
        [...chunkIds, DELETE_ROW_CHUNK_SIZE],
      )
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      run(`DELETE FROM pages_fts WHERE rowid IN (${rowPlaceholders})`, rows.map((row) => row.rowid))
      await yieldToEventLoop()
    }

    // Segment FTS delete must stay batched. A single full-document INSERT…SELECT
    // on large libraries freezes the main process for seconds.
    if (!isSearchSegmentsFtsRebuildNeeded()) {
      while (true) {
        const segmentRows = queryAll<{ rowid: number; title: string | null; normalized_text: string | null; text: string | null }>(
          `SELECT rowid, title, normalized_text, text
           FROM search_index_segments
           WHERE doc_id IN (${placeholders})
             AND TRIM(COALESCE(normalized_text, text, '')) != ''
           LIMIT ?`,
          [...chunkIds, DELETE_ROW_CHUNK_SIZE],
        )
        if (segmentRows.length === 0) break
        transaction(() => {
          for (const row of segmentRows) {
            run(
              `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
               VALUES ('delete', ?, ?, ?)`,
              [row.rowid, String(row.title || ''), String(row.normalized_text || row.text || '')],
            )
            if (isSearchTrigramFtsAvailable()) {
              run(
                `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
                 VALUES ('delete', ?, ?)`,
                [row.rowid, String(row.normalized_text || row.text || '')],
              )
            }
          }
        })
        // Physically remove the segment rows we just unindexed so the LIMIT loop advances.
        const rowPlaceholders = segmentRows.map(() => '?').join(', ')
        run(
          `DELETE FROM search_index_segments WHERE rowid IN (${rowPlaceholders})`,
          segmentRows.map((row) => row.rowid),
        )
        await yieldToEventLoop()
      }
    }
  })
}

async function deleteAiChatTurnsByDocIdsAsync(docIds: string[]): Promise<void> {
  await runForIdChunksAsync(docIds, async (chunkIds, placeholders) => {
    while (true) {
      const rows = queryAll<{ rowid: number }>(
        `SELECT t.rowid
         FROM ai_chat_turns t
         JOIN ai_chat_sessions s ON s.id = t.session_id
         WHERE s.doc_id IN (${placeholders})
         LIMIT ?`,
        [...chunkIds, DELETE_ROW_CHUNK_SIZE],
      )
      if (rows.length === 0) break
      const rowPlaceholders = rows.map(() => '?').join(', ')
      run(`DELETE FROM ai_chat_turns WHERE rowid IN (${rowPlaceholders})`, rows.map((row) => row.rowid))
      await yieldToEventLoop()
    }
  })
}

function getDocumentsForDelete(docIds: string[]): DocumentFileRow[] {
  const rows: DocumentFileRow[] = []
  runForIdChunks(docIds, (chunkIds, placeholders) => {
    rows.push(...queryAll<DocumentFileRow>(
      `SELECT id FROM documents WHERE id IN (${placeholders})`,
      chunkIds,
    ))
  })
  return rows
}

function getAffectedTagIdsForDelete(docIds: string[]): string[] {
  const tagIds: string[] = []
  runForIdChunks(docIds, (chunkIds, placeholders) => {
    tagIds.push(...queryAll<{ tag_id: string }>(
      `SELECT DISTINCT tag_id FROM document_tags WHERE doc_id IN (${placeholders})`,
      chunkIds,
    ).map((row) => row.tag_id))
  })
  return [...new Set(tagIds.filter(Boolean))]
}

function getDeleteCleanupTasks(docs: DocumentFileRow[]): DeletePathTask[] {
  const cleanupTasks: DeletePathTask[] = []
  for (const doc of docs) {
    const storageDir = join(getDataDir(), 'storage', doc.id)
    const decision = inspectManagedDeleteTarget({
      dataDir: getDataDir(),
      docId: doc.id,
      targetPath: storageDir,
      kind: 'document-root',
    })
    if (decision.allowed) {
      cleanupTasks.push({
        docId: doc.id,
        path: storageDir,
        label: `storage directory for ${doc.id}`,
        kind: 'document-root',
      })
    } else if (decision.reason !== 'target-missing') {
      console.warn(`[Documents] Skipped unsafe cleanup task for ${doc.id}: ${decision.reason || 'unknown-reason'}`)
    }
  }
  return cleanupTasks
}

function markDocumentsDeleting(docIds: string[]): void {
  const now = new Date().toISOString()
  runForIdChunks(docIds, (chunkIds, placeholders) => {
    run(
      `UPDATE documents
       SET import_status = ?, error_message = NULL, updated_at = ?
       WHERE id IN (${placeholders})`,
      ['deleting', now, ...chunkIds],
    )
  })
  scheduleDatabaseSave()
}

function markDocumentsDeleteFailed(docIds: string[], error: unknown): void {
  const message = formatDocumentDeleteFailureMessage(error)
  const now = new Date().toISOString()
  runForIdChunks(docIds, (chunkIds, placeholders) => {
    run(
      `UPDATE documents
       SET import_status = ?, error_message = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      ['error', message.slice(0, 1000), now, ...chunkIds],
    )
  })
  scheduleDatabaseSave()
}

async function deleteDocumentData(docIds: string[]): Promise<DeleteDocumentDataResult> {
  let recoveredSearchIndexIssue = false
  let resetSearchIndexTables = false
  const runSearchIndexStep = async (label: string, callback: () => Promise<void>) => {
    let completed = await timeDeleteStepAsync(label, callback, { recoverableSearchIndexMalformed: true })
    if (!completed && !resetSearchIndexTables) {
      recoveredSearchIndexIssue = true
      resetRebuildableSearchTables()
      resetSearchIndexTables = true
      completed = await timeDeleteStepAsync(`${label}:after-search-index-reset`, callback, { recoverableSearchIndexMalformed: true })
    }
    recoveredSearchIndexIssue = recoveredSearchIndexIssue || !completed
  }

  await runSearchIndexStep('search_ngram_index', () => deleteRowsByDocIdsAsync('search_ngram_index', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('metadata_candidates', () => deleteRowsByDocIdsAsync('metadata_candidates', docIds))
  await timeDeleteStepAsync('page_ocr_versions', () => deleteRowsByDocIdsAsync('page_ocr_versions', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('page_ai_layout_cache', () => deleteRowsByDocIdsAsync('page_ai_layout_cache', docIds))
  await timeDeleteStepAsync('page_translation_cache', () => deleteRowsByDocIdsAsync('page_translation_cache', docIds))
  await timeDeleteStepAsync('page_translation_units', () => deleteRowsByDocIdsAsync('page_translation_units', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('document_toc_items', () => deleteRowsByDocIdsAsync('document_toc_items', docIds))
  await timeDeleteStepAsync('reader_state', () => deleteRowsByDocIdsAsync('reader_state', docIds))
  await timeDeleteStepAsync('ai_document_summaries', () => deleteRowsByDocIdsAsync('ai_document_summaries', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('research_notes', () => deleteRowsByDocIdsAsync('research_notes', docIds))
  await timeDeleteStepAsync('research_project_documents', () => deleteRowsByDocIdsAsync('research_project_documents', docIds))
  await timeDeleteStepAsync('ai_results', () => deleteRowsByDocIdsAsync('ai_results', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('ai_chat_turns', () => deleteAiChatTurnsByDocIdsAsync(docIds))
  await timeDeleteStepAsync('ai_chat_sessions', () => deleteRowsByDocIdsAsync('ai_chat_sessions', docIds))
  await timeDeleteStepAsync('batch_queue', () => deleteRowsByDocIdsAsync('batch_queue', docIds))
  await yieldToEventLoop()
  await runSearchIndexStep('fts', () => deleteFtsRowsByDocIdsAsync(docIds))
  // Segments may already be removed during FTS cleanup; this pass is a residual sweep.
  await runSearchIndexStep('search_index_segments', () => deleteRowsByDocIdsAsync('search_index_segments', docIds))
  await runSearchIndexStep('search_index_status', () => deleteRowsByDocIdsAsync('search_index_status', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('pages', () => deleteRowsByDocIdsAsync('pages', docIds))
  await yieldToEventLoop()
  await timeDeleteStepAsync('document_folders', () => deleteRowsByDocIdsAsync('document_folders', docIds))
  await timeDeleteStepAsync('document_tags', () => deleteRowsByDocIdsAsync('document_tags', docIds))
  await timeDeleteStepAsync('documents', async () => {
    await runForIdChunksAsync(docIds, (chunkIds, placeholders) => {
      run(`DELETE FROM documents WHERE id IN (${placeholders})`, chunkIds)
    })
  })
  return { recoveredSearchIndexIssue }
}

function refreshDeletedDocumentTags(tagIds: string[]): void {
  if (tagIds.length === 0) return
  try {
    refreshTagUsageForTags(tagIds)
  } catch (error) {
    console.error('[Documents] Failed to refresh tag usage after deleting documents:', error)
  }
}

async function cleanupDeletedDocumentFilesInBackground(tasks: DeletePathTask[]): Promise<void> {
  let nextTaskIndex = 0
  const workerCount = Math.min(DELETE_FILE_CLEANUP_CONCURRENCY, tasks.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < tasks.length) {
      const task = tasks[nextTaskIndex]
      nextTaskIndex += 1
      const decision = inspectManagedDeleteTarget({
        dataDir: getDataDir(),
        docId: task.docId,
        targetPath: task.path,
        kind: task.kind,
      })
      if (!decision.allowed || !decision.canonicalTarget) {
        if (decision.reason !== 'target-missing') {
          console.warn(`[Documents] Skipped unsafe cleanup for ${task.docId}: ${decision.reason || 'unknown-reason'}`)
        }
        continue
      }
      try {
        await rm(decision.canonicalTarget, { recursive: true, force: true })
      } catch (error) {
        console.error(`[Documents] Failed to delete ${task.label}:`, error)
      }
    }
  })
  await Promise.all(workers)
}

function scheduleDocumentDeleteJob(docIds: string[]): void {
  const job = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        const affectedTagIds = new Set<string>()
        let recoveredSearchIndexIssue = false
        try {
          // Process a few documents at a time so list/settings IPC can run between batches.
          for (let offset = 0; offset < docIds.length; offset += DELETE_DOC_BATCH_SIZE) {
            const batch = docIds.slice(offset, offset + DELETE_DOC_BATCH_SIZE)
            getAffectedTagIdsForDelete(batch).forEach((tagId) => affectedTagIds.add(tagId))
            const deleteResult = await deleteDocumentData(batch)
            if (deleteResult.recoveredSearchIndexIssue) recoveredSearchIndexIssue = true
            await yieldToEventLoop()
          }
          if (recoveredSearchIndexIssue) {
            queueAllDocumentsReindex()
          }
          notifySearchContentChanged()
          refreshDeletedDocumentTags([...affectedTagIds])
          const cleanupTasks = getDeleteCleanupTasks(docIds.map((id) => ({ id })))
          await cleanupDeletedDocumentFilesInBackground(cleanupTasks)
          // Long delay: avoid checkpoint fighting the next UI paint after bulk delete.
          scheduleDatabaseSave({ minDelayMs: 15_000 })
        } catch (error) {
          console.error('[Documents] Background document delete failed:', error)
          markDocumentsDeleteFailed(docIds, error)
        } finally {
          docIds.forEach((docId) => activeDocumentDeleteIds.delete(docId))
        }
      })().finally(resolve)
    })
  })
  activeDocumentDeleteJobs.add(job)
  void job.finally(() => {
    activeDocumentDeleteJobs.delete(job)
  })
}

function waitForDocumentDeleteShutdown(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function waitForDocumentImportShutdown(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function waitForBookTranslationShutdown(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function trackDocumentImportJob<T>(callback: () => Promise<T>): Promise<T> {
  const job = callback()
  const tracked = job.then(() => undefined, () => undefined)
  activeDocumentImportJobs.add(tracked)
  void tracked.finally(() => {
    activeDocumentImportJobs.delete(tracked)
  })
  return job
}

export function isDocumentImportShuttingDown(): boolean {
  return documentImportShuttingDown
}

export async function shutdownDocumentImportRuntime(timeoutMs = 30000): Promise<void> {
  documentImportShuttingDown = true
  const activeJobs = [...activeDocumentImportJobs]
  if (activeJobs.length === 0) return
  saveDatabase()
  await waitForDocumentImportShutdown(activeJobs, timeoutMs)
}

export async function shutdownDocumentDeleteRuntime(timeoutMs = 30000): Promise<void> {
  const activeJobs = [...activeDocumentDeleteJobs]
  if (activeJobs.length === 0) return
  saveDatabase()
  await waitForDocumentDeleteShutdown(activeJobs, timeoutMs)
}

class BookTranslationShutdownError extends Error {
  constructor() {
    super('Book translation interrupted by app shutdown')
    this.name = 'BookTranslationShutdownError'
  }
}

function throwIfBookTranslationShuttingDown(): void {
  if (bookTranslationRuntimeShuttingDown) throw new BookTranslationShutdownError()
}

function isBookTranslationShutdownError(error: unknown): boolean {
  return error instanceof BookTranslationShutdownError
    || (error as Error)?.name === 'BookTranslationShutdownError'
}

export async function shutdownBookTranslationRuntime(timeoutMs = 30000): Promise<void> {
  bookTranslationRuntimeShuttingDown = true
  const activeJobs = [...activeBookTranslationJobTasks]
  if (activeJobs.length === 0) return
  saveDatabase()
  await waitForBookTranslationShutdown(activeJobs, timeoutMs)
}

export function resumeInterruptedDocumentDeletes(): InterruptedDocumentDeleteRecoverySummary {
  const docIds = queryAll<{ id: string }>("SELECT id FROM documents WHERE import_status = 'deleting'")
    .map((doc) => doc.id)
    .filter(Boolean)
  if (docIds.length === 0) return { queuedDocuments: 0, cleanupTasks: 0 }

  const docs = getDocumentsForDelete(docIds)
  const existingIds = docs.map((doc) => doc.id).filter((docId) => !activeDocumentDeleteIds.has(docId))
  if (existingIds.length === 0) return { queuedDocuments: 0, cleanupTasks: 0 }

  existingIds.forEach((docId) => activeDocumentDeleteIds.add(docId))
  scheduleDocumentDeleteJob(existingIds)
  return { queuedDocuments: existingIds.length, cleanupTasks: existingIds.length }
}

function resolveImportOcrEngine(value: unknown): OcrEngine {
  return value === 'local_paddle' || value === 'vision_model' || value === 'hybrid' ? value : 'paddle'
}

const TEXT_IMPORT_EXTENSIONS = new Set(['.txt', '.md', '.markdown'])
const EPUB_IMPORT_EXTENSIONS = new Set(['.epub'])
const UNSUPPORTED_EBOOK_EXTENSIONS = new Set(['.mobi', '.azw', '.azw3'])
const IMAGE_IMPORT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp'])
const SUPPORTED_IMPORT_EXTENSIONS = new Set([
  '.pdf', ...IMAGE_IMPORT_EXTENSIONS, '.json',
  ...TEXT_IMPORT_EXTENSIONS,
  ...EPUB_IMPORT_EXTENSIONS,
  ...UNSUPPORTED_EBOOK_EXTENSIONS,
])
const TEXT_PAGE_CHAR_LIMIT = 1800
const EBOOK_SECTION_CHAR_LIMIT = 4200
const BOOK_TRANSLATION_CONCURRENCY = 2
const TRANSLATION_ALIGNMENT_ERROR_MESSAGE = '按句对齐失配，需重译'
const DOCUMENT_PAGE_WRITE_CHUNK_SIZE = 8
const DOCUMENT_DB_INSERT_CHUNK_SIZE = 50
const PDF_IMPORT_PAGE_RECORD_INIT_LIMIT = 1000
const DOCUMENT_SLOW_STEP_MS = 800
const activeBookTranslationJobs = new Set<string>()
const decoderLabels = ['utf-8', 'utf-16le', 'gb18030', 'big5'] as const
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  textNodeName: '#text',
})

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

async function insertMissingDocumentPageRecords(docId: string, pageCount: number, now = new Date().toISOString()): Promise<number> {
  const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
  if (safePageCount <= 0) return 0

  const existingPageNums = new Set(
    queryAll<{ page_num: number | null }>('SELECT page_num FROM pages WHERE doc_id = ? AND page_num BETWEEN 1 AND ?', [docId, safePageCount])
      .map((row) => Number(row.page_num || 0))
      .filter((pageNum) => Number.isFinite(pageNum) && pageNum > 0),
  )
  let inserted = 0
  for (let index = 0; index < safePageCount; index += DOCUMENT_DB_INSERT_CHUNK_SIZE) {
    const pageNums = Array.from(
      { length: Math.min(DOCUMENT_DB_INSERT_CHUNK_SIZE, safePageCount - index) },
      (_, offset) => index + offset + 1,
    ).filter((pageNum) => !existingPageNums.has(pageNum))
    if (pageNums.length > 0) {
      transaction(() => {
        pageNums.forEach((pageNum) => {
          run(
            'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nanoid(), docId, pageNum, null, null, null, null, 'pending', 'pending', now],
          )
          existingPageNums.add(pageNum)
          inserted += 1
        })
      })
    }
    if (index + DOCUMENT_DB_INSERT_CHUNK_SIZE < safePageCount) {
      await yieldToEventLoop()
    }
  }
  return inserted
}

function shouldDeferImportPdfPageRecordInit(pageCount: number): boolean {
  const safePageCount = Math.max(0, Math.floor(Number(pageCount || 0)))
  return safePageCount > PDF_IMPORT_PAGE_RECORD_INIT_LIMIT
}

function clearDeferredPdfPageRecordMarker(docId: string): string | null {
  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM documents WHERE id = ?', [docId])
  const metadata = parseDocumentMetadata(row?.metadata)
  if (metadata.pdf_page_records_deferred === undefined) return row?.metadata || null
  delete metadata.pdf_page_records_deferred
  const nextMetadata = JSON.stringify(metadata)
  run('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?', [nextMetadata, new Date().toISOString(), docId])
  return nextMetadata
}

async function ensureDeferredPdfPageRecordsReadyForRead(doc: Pick<Document, 'id' | 'file_path' | 'page_count' | 'metadata'>): Promise<void> {
  const metadata = parseDocumentMetadata(doc.metadata)
  if (metadata.pdf_page_records_deferred !== true) return
  const pageCount = Math.max(
    Number(doc.page_count || 0) || 0,
    Number(metadata.pdf_page_count || metadata.page_count || 0) || 0,
  )
  if (pageCount <= 0) return
  const total = Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', [doc.id])?.count || 0)
  if (total < pageCount) {
    const startedAt = Date.now()
    await insertMissingDocumentPageRecords(doc.id, pageCount)
    logSlowDocumentStep(`ensureDeferredPdfPageRecords:${doc.id}:${pageCount}`, startedAt)
    // Yield so open-document IPC does not immediately chain more main-thread work.
    await yieldToEventLoop()
  }
  const nextMetadata = clearDeferredPdfPageRecordMarker(doc.id)
  if (nextMetadata !== null) doc.metadata = nextMetadata
}

function logSlowDocumentStep(label: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt
  if (elapsed >= DOCUMENT_SLOW_STEP_MS) {
    console.warn(`[Documents] Slow step: ${label} took ${elapsed}ms`)
  }
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  return Buffer.from(String(dataUrl || '').replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

function assertValidPageImageBuffer(buffer: Buffer): void {
  if (!buffer.byteLength) {
    throw new Error('页面图片缓存为空，请重新生成页面预览')
  }
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) {
    throw new Error('页面图片缓存无效，请重新生成页面预览')
  }
}

interface ParsedEbook {
  manifest: EbookManifest
  sections: EbookTextSection[]
  title: string
  author: string | null
}

async function collectImportableFiles(dirPath: string): Promise<string[]> {
  const files: string[] = []
  const pendingDirs = [dirPath]
  let visitedEntries = 0

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.shift()
    if (!currentDir) continue
    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const itemPath = join(currentDir, entry.name)
      visitedEntries += 1

      if (entry.isDirectory()) {
        pendingDirs.push(itemPath)
      } else if (entry.isFile() && SUPPORTED_IMPORT_EXTENSIONS.has(extname(itemPath).toLowerCase())) {
        files.push(itemPath)
      }

      if (visitedEntries % 100 === 0) {
        await yieldToEventLoop()
      }
    }
  }

  return files
}

function parseMaybeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function getPathValue(source: unknown, path: readonly string[]): unknown {
  let current = source
  for (const key of path) {
    if (!isJsonRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (isJsonRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return isJsonRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeLibraryImportQueueState(value: unknown): LibraryImportQueueState | null {
  if (!isJsonRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.jobs)) return null
  const jobs = value.jobs
    .map((job) => {
      if (!isJsonRecord(job)) return null
      const filePaths = Array.isArray(job.filePaths)
        ? job.filePaths.map((filePath) => String(filePath || '').trim()).filter(Boolean)
        : []
      const sourceLabels = Array.isArray(job.sourceLabels)
        ? job.sourceLabels.map((label) => String(label || '').trim()).filter(Boolean)
        : filePaths.map((filePath) => basename(filePath))
      const pendingCount = Math.max(0, Math.floor(Number(job.pendingCount ?? filePaths.length) || 0))
      if (pendingCount === 0 && sourceLabels.length === 0) return null
      return {
        id: Number(job.id || 0) || Date.now(),
        selectionId: null,
        sourceLabels,
        pendingCount,
        folderId: typeof job.folderId === 'string' && job.folderId ? job.folderId : null,
        engine: resolveImportOcrEngine(job.engine),
        authorizationStatus: 'authorization-required' as const,
        hasUndiscoveredSources: value.version === 2 && job.hasUndiscoveredSources === true,
      }
    })
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
  if (jobs.length === 0) return null
  return {
    version: 2,
    savedAt: typeof value.savedAt === 'string' && value.savedAt ? value.savedAt : new Date().toISOString(),
    jobs,
  }
}

function capabilityFailure(error: unknown): CapabilityResult<never> {
  const code = error instanceof FileCapabilityError ? error.code : 'CAPABILITY_INVALID_REQUEST'
  return {
    ok: false,
    error: {
      code,
      message: code === 'CAPABILITY_EXPIRED'
        ? '文件授权已过期，请重新选择'
        : code === 'CAPABILITY_OWNER_MISMATCH'
          ? '文件授权不属于当前窗口'
          : '文件授权无效，请重新选择',
    },
  }
}

function readLibraryImportQueueState(): LibraryImportQueueState | null {
  const row = queryOne<{ state_json?: string | null }>(
    'SELECT state_json FROM library_import_queue_state WHERE id = ?',
    [LIBRARY_IMPORT_QUEUE_STATE_ID],
  )
  if (!row?.state_json) return null
  return normalizeLibraryImportQueueState(parseJsonRecord(row.state_json))
}

function saveLibraryImportQueueState(state: LibraryImportQueueState | null): LibraryImportQueueState | null {
  const normalized = normalizeLibraryImportQueueState(state)
  if (!normalized) {
    cancelLegacyImportQueueTasks()
    run('DELETE FROM library_import_queue_state WHERE id = ?', [LIBRARY_IMPORT_QUEUE_STATE_ID])
    scheduleDatabaseSave()
    return null
  }
  const now = new Date().toISOString()
  const payload: LibraryImportQueueState = {
    ...normalized,
    savedAt: now,
  }
  transaction(() => {
    run(
      `INSERT INTO library_import_queue_state (id, version, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      [LIBRARY_IMPORT_QUEUE_STATE_ID, payload.version, JSON.stringify(payload), now, now],
    )
  })
  registerLegacyImportQueueState(payload)
  scheduleDatabaseSave()
  return payload
}

function clearLibraryImportQueueState(): boolean {
  cancelLegacyImportQueueTasks()
  run('DELETE FROM library_import_queue_state WHERE id = ?', [LIBRARY_IMPORT_QUEUE_STATE_ID])
  scheduleDatabaseSave()
  return true
}

function sanitizeFileBaseName(value: unknown, fallback = 'document'): string {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return normalized || fallback
}

function getSettingValue(key: string, fallback = ''): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || fallback)
}

function makeLlmProfileId(provider: string, baseUrl: string, model: string): string {
  const safeProvider = String(provider || 'AI').trim() || 'AI'
  const safeModel = String(model || 'model').trim() || 'model'
  const base = `${safeProvider}_${safeModel}`
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'ai_model'
  const signature = `${safeProvider}|${String(baseUrl || '').trim().replace(/\/+$/, '')}|${safeModel}`.toLowerCase()
  let hash = 0
  for (let index = 0; index < signature.length; index += 1) {
    hash = ((hash << 5) - hash + signature.charCodeAt(index)) | 0
  }
  return `${base}_${Math.abs(hash).toString(36)}`
}

function getCurrentTranslationModelSignature(): string {
  const provider = getSettingValue('llm_provider', 'DeepSeek').trim() || 'DeepSeek'
  const baseUrl = getSettingValue('llm_base_url', 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '') || 'https://api.deepseek.com/v1'
  const model = getSettingValue('llm_model', 'deepseek-chat').trim() || 'deepseek-chat'
  const activeId = getSettingValue('llm_active_provider_id').trim() || makeLlmProfileId(provider, baseUrl, model)
  return [activeId, provider, baseUrl, model].map((part) => String(part || '').trim()).filter(Boolean).join('|') || DEFAULT_TRANSLATION_MODEL
}

function normalizeTranslationStyle(value: unknown): TranslationStyle {
  const style = String(value || '').trim()
  return (style || DEFAULT_TRANSLATION_STYLE) as TranslationStyle
}

function getTranslationGlossaryCacheSignature(projectId: string | null): string {
  const versionSignature = getTranslationGlossaryVersionSignature(projectId)
  return `${projectId || 'global'}:${versionSignature || 'none'}`
}

function normalizeBookTranslationText(value: string): string {
  const source = String(value || '').replace(/\r/g, '').trim()
  if (!source) return ''
  return source
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function getBookTranslationSourceText(page: BookTranslationPageRow): string {
  return getCanonicalPageTranslationSourceText(page)
}

function getBookTranslationFilePath(doc: Pick<Document, 'id' | 'title'>): string {
  const dir = join(getDataDir(), 'translations', String(doc.id || 'unknown'))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sanitizeFileBaseName(doc.title, 'translation')}.translated.md`)
}

function emitBookTranslationProgress(payload: BookTranslationProgressEvent) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('documents:bookTranslationProgress', payload)
  })
}

function sendImportProgress(sender: WebContents, payload: ImportProgressEvent): void {
  if (sender.isDestroyed()) return
  sender.send('documents:importProgress', {
    ...payload,
    statusEnvelope: statusEnvelopeFromImportProgress(payload),
    pipelineDiagnostics: documentPipelineDiagnosticsFromImportProgress(payload),
  } satisfies ImportProgressEvent)
}

function writeBookTranslationFile(doc: Pick<Document, 'id' | 'title'>, pages: BookTranslationPageWorkItem[], outputPath: string) {
  const lines = [
    `# ${String(doc.title || '未命名文献')} - 整书翻译`,
    '',
    `- 文献 ID：${doc.id}`,
    `- 更新时间：${new Date().toISOString()}`,
    '',
  ]
  for (const page of pages) {
    const translation = String(page.translationText || '').trim()
    if (!translation) continue
    lines.push(`## 第 ${page.page_num || '?'} 页`, '', normalizeBookTranslationText(translation), '')
  }
  writeFileSync(outputPath, lines.join('\n'), 'utf8')
}

function saveBookTranslationCache(
  docId: string,
  page: Pick<BookTranslationPageRow, 'id' | 'page_num'>,
  sourceHash: string,
  sourceText: string,
  translationText: string,
  status: BookTranslationCacheRow['status'] = 'ready',
  errorMessage: string | null = null,
  modelSignature = DEFAULT_TRANSLATION_MODEL,
  skipped = false,
) {
  const now = new Date().toISOString()
  const nextStatus = status === 'ready'
    && !skipped
    && !isParallelTranslationDisplayReady(sourceText, translationText)
    ? 'error'
    : status
  const nextErrorMessage = nextStatus === 'error' && status === 'ready'
    ? TRANSLATION_ALIGNMENT_ERROR_MESSAGE
    : errorMessage
  const preparedSourceText = preparePagePayloadUpdate(docId, page.id, 'source_text', sourceText)
  const preparedTranslationText = preparePagePayloadUpdate(docId, page.id, 'translation_text', translationText)
  run(
    `INSERT INTO page_translation_cache (
      id, doc_id, page_id, page_num, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message, model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id, source_hash) DO UPDATE SET
      source_text = excluded.source_text,
      source_text_ref = excluded.source_text_ref,
      translation_text = excluded.translation_text,
      translation_text_ref = excluded.translation_text_ref,
      skipped = excluded.skipped,
      status = excluded.status,
      error_message = excluded.error_message,
      model = excluded.model,
      updated_at = excluded.updated_at`,
    [
      nanoid(),
      docId,
      page.id,
      Number(page.page_num || 0),
      sourceHash,
      preparedSourceText.value,
      preparedSourceText.ref,
      preparedTranslationText.value,
      preparedTranslationText.ref,
      skipped ? 1 : 0,
      nextStatus,
      nextErrorMessage,
      modelSignature || DEFAULT_TRANSLATION_MODEL,
      now,
      now,
    ],
  )
  scheduleDatabaseSave()
}

function isInvalidReadyTranslationCache(row: Pick<PageTranslationCacheItem, 'status' | 'skipped' | 'source_text' | 'translation_text'>): boolean {
  if (row.status !== 'ready') return false
  if (row.skipped) return false
  const sourceText = String(row.source_text || '').trim()
  const translationText = String(row.translation_text || '').trim()
  return Boolean(sourceText && translationText && !isParallelTranslationDisplayReady(sourceText, translationText))
}

function markTranslationCacheRowsAsAlignmentError(rows: Array<Pick<PageTranslationCacheItem, 'id'>>): void {
  const ids = [...new Set(rows.map((row) => String(row.id || '').trim()).filter(Boolean))]
  if (ids.length === 0) return
  const now = new Date().toISOString()
  transaction(() => {
    ids.forEach((id) => {
      run(
        `UPDATE page_translation_cache
         SET status = 'error',
             error_message = ?,
             updated_at = ?
         WHERE id = ?`,
        [TRANSLATION_ALIGNMENT_ERROR_MESSAGE, now, id],
      )
    })
  })
  scheduleDatabaseSave()
}

function getBookTranslationCacheByHashes(pageId: string, hashes: string[], sourceText: string): BookTranslationCacheRow | null {
  const uniqueHashes = [...new Set(hashes.map((hash) => String(hash || '').trim()).filter(Boolean))]
  if (!pageId || uniqueHashes.length === 0) return null
  const placeholders = uniqueHashes.map(() => '?').join(', ')
  const rows = queryAll<BookTranslationCacheRow>(
    `SELECT id, page_id, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message
     FROM page_translation_cache
     WHERE page_id = ? AND source_hash IN (${placeholders})
     ORDER BY updated_at DESC`,
    [pageId, ...uniqueHashes],
  )
  const hydratedRows = hydratePagePayloadRows(rows)
  for (const hash of uniqueHashes) {
    const ready = hydratedRows.find((row) => (
      row.source_hash === hash
      && row.status === 'ready'
      && String(row.translation_text || '').trim()
    ))
    if (!ready) continue
    if (!isInvalidReadyTranslationCache(ready as PageTranslationCacheItem)) return ready
    if (ready.id) markTranslationCacheRowsAsAlignmentError([{ id: ready.id }])
  }
  const compatibleRows = hydratePagePayloadRows(queryAll<BookTranslationCacheRow>(
    `SELECT id, page_id, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message
     FROM page_translation_cache
     WHERE page_id = ?
       AND status = 'ready'
       AND translation_text IS NOT NULL
       AND TRIM(translation_text) <> ''
     ORDER BY updated_at DESC`,
    [pageId],
  ))
  const normalizedSourceText = normalizeTranslationSourceText(sourceText)
  for (const row of compatibleRows) {
    if (uniqueHashes.includes(String(row.source_hash || ''))) continue
    if (isInvalidReadyTranslationCache(row as PageTranslationCacheItem)) {
      if (row.id) markTranslationCacheRowsAsAlignmentError([{ id: row.id }])
      continue
    }
    const cachedSourceText = String(row.source_text || '').trim()
    const cachedTranslationText = String(row.translation_text || '').trim()
    if (!cachedSourceText || !cachedTranslationText) continue
    if (row.skipped) {
      if (normalizeTranslationSourceText(cachedSourceText) === normalizedSourceText) return row
      continue
    }
    if (
      normalizeTranslationSourceText(cachedSourceText) === normalizedSourceText
      && isParallelTranslationDisplayReady(sourceText, cachedTranslationText)
    ) {
      return row
    }
    const projectedText = projectParallelTranslationTextToSource(sourceText, cachedSourceText, cachedTranslationText)
    if (projectedText) return { ...row, translation_text: projectedText }
  }
  return null
}

function hasBookTranslationStaleCache(pageId: string, hashes: string[]): boolean {
  const uniqueHashes = [...new Set(hashes.map((hash) => String(hash || '').trim()).filter(Boolean))]
  if (!pageId) return false
  const hashClause = uniqueHashes.length ? `AND source_hash NOT IN (${uniqueHashes.map(() => '?').join(', ')})` : ''
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM page_translation_cache
     WHERE page_id = ? AND status IN ('ready', 'error') ${hashClause}`,
    [pageId, ...uniqueHashes],
  )
  return Number(row?.count || 0) > 0
}

function hasBookTranslationErrorCache(pageId: string, hashes: string[]): boolean {
  const uniqueHashes = [...new Set(hashes.map((hash) => String(hash || '').trim()).filter(Boolean))]
  if (!pageId) return false
  if (uniqueHashes.length > 0) {
    const placeholders = uniqueHashes.map(() => '?').join(', ')
    const row = queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM page_translation_cache
       WHERE page_id = ? AND source_hash IN (${placeholders}) AND status = 'error'`,
      [pageId, ...uniqueHashes],
    )
    if (Number(row?.count || 0) > 0) return true
  }
  const staleRow = queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM page_translation_cache
     WHERE page_id = ? AND status = 'error'`,
    [pageId],
  )
  return Number(staleRow?.count || 0) > 0
}

function getBookTranslationContext(pages: BookTranslationPageWorkItem[], sourceIndex: number, direction: -1 | 1): string {
  const page = pages.find((item) => item.sourceIndex === sourceIndex + direction)
  return page ? page.sourceText.slice(0, 360) : ''
}

async function runLegacyBookTranslationJob(docId: string, jobId: string, options: BookTranslationOptions = {}) {
  throwIfBookTranslationShuttingDown()
  const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
  if (!doc) throw new Error('文献不存在')
  const outputPath = getBookTranslationFilePath(doc)
  const projectId = String(options?.glossaryProjectId || '').trim() || null
  const style = normalizeTranslationStyle(options?.style)
  const modelSignature = getCurrentTranslationModelSignature()
  const glossaryCacheSignature = getTranslationGlossaryCacheSignature(projectId)

  if (options?.clearCache) {
    run('DELETE FROM page_translation_cache WHERE doc_id = ?', [docId])
    scheduleDatabaseSave()
    emitBookTranslationProgress({
      jobId,
      docId,
      status: 'completed',
      progress: 1,
      completedPages: 0,
      failedPages: 0,
      cachedPages: 0,
      stalePages: 0,
      translatedPages: 0,
      skippedPages: 0,
      totalPages: 0,
      outputPath,
      message: '已清除本书翻译缓存',
    })
    return
  }

  const rawPages = hydratePagePayloadRows(queryAll<BookTranslationPageRow>('SELECT id, doc_id, page_num, ocr_text, ocr_text_ref, proofed_text, proofed_text_ref, ocr_result, ocr_result_ref FROM pages WHERE doc_id = ? ORDER BY page_num', [docId]))
  const pages = rawPages
    .map((page, sourceIndex) => {
      const sourceText = getBookTranslationSourceText(page)
      return {
        ...page,
        sourceIndex,
        sourceText,
        translationText: '',
        onlyNonChinese: false,
        sourceHash: buildTranslationCacheKey({
          docId,
          pageId: page.id,
          sourceText,
          modelSignature,
          glossarySignature: glossaryCacheSignature,
          style,
        }),
      }
    })
    .filter((page) => page.sourceText)
  const totalPages = pages.length

  const startedPayload: BookTranslationProgressEvent = {
    jobId,
    docId,
    status: 'processing',
    progress: 0,
    completedPages: 0,
    totalPages,
    outputPath,
    message: totalPages ? '开始整书翻译' : '没有可翻译文本',
  }
  emitBookTranslationProgress(startedPayload)
  if (totalPages === 0) {
    writeBookTranslationFile(doc, pages, outputPath)
    emitBookTranslationProgress({ ...startedPayload, status: 'completed', progress: 1, message: '没有可翻译文本', outputPath })
    return
  }

  let cachedPages = 0
  let stalePages = 0
  let translatedPages = 0
  let skippedPages = 0
  let failedPages = 0
  const pendingPages: BookTranslationPageWorkItem[] = []
  const concurrency = Math.max(1, Math.min(4, Math.round(Number(options?.concurrency || BOOK_TRANSLATION_CONCURRENCY) || BOOK_TRANSLATION_CONCURRENCY)))
  const makeProgressPayload = (
    page: BookTranslationPageWorkItem | null,
    messageText: string,
    status: BookTranslationProgressEvent['status'] = 'processing',
    errorMessage?: string,
  ): BookTranslationProgressEvent => {
    const completedPages = cachedPages + translatedPages + skippedPages
    const finishedPages = completedPages + failedPages
    return {
      jobId,
      docId,
      status,
      progress: totalPages ? Math.min(1, finishedPages / totalPages) : 1,
      completedPages,
      failedPages,
      cachedPages,
      stalePages,
      translatedPages,
      skippedPages,
      totalPages,
      pageNum: page?.page_num,
      outputPath,
      message: messageText,
      errorMessage,
    }
  }

  for (const page of pages) {
    throwIfBookTranslationShuttingDown()
    const hashes = [page.sourceHash]
    const translationDecision = shouldTranslatePageText(page.sourceText)
    page.onlyNonChinese = translationDecision.mixedLanguage
    const cached = getBookTranslationCacheByHashes(page.id, hashes, page.sourceText)
    const hasStaleCache = !cached && hasBookTranslationStaleCache(page.id, hashes)
    const hasErrorCache = !cached && hasBookTranslationErrorCache(page.id, hashes)
    const canReuseCached = Boolean(cached?.translation_text && (
      (cached.skipped && !translationDecision.shouldTranslate)
      || (!cached.skipped && isParallelTranslationDisplayReady(page.sourceText, String(cached.translation_text || '')))
    ))

    if (canReuseCached && cached) {
      page.translationText = String(cached.translation_text || '')
      if (cached.skipped) skippedPages += 1
      else cachedPages += 1
      if (cached.source_hash !== page.sourceHash) {
        saveBookTranslationCache(
          docId,
          page,
          page.sourceHash,
          page.sourceText,
          page.translationText,
          'ready',
          null,
          modelSignature,
          Boolean(cached.skipped),
        )
      }
      continue
    }

    if (options?.retryFailedOnly && !hasBookTranslationErrorCache(page.id, hashes)) {
      skippedPages += 1
      continue
    }
    if (hasStaleCache || hasErrorCache || cached) stalePages += 1

    if (!translationDecision.shouldTranslate) {
      page.translationText = page.sourceText
      skippedPages += 1
      saveBookTranslationCache(
        docId,
        page,
        page.sourceHash,
        page.sourceText,
        page.sourceText,
        'ready',
        null,
        modelSignature,
        true,
      )
      continue
    }

    pendingPages.push(page)
  }

  writeBookTranslationFile(doc, pages, outputPath)
  if (cachedPages || skippedPages || stalePages) {
    const staleText = stalePages ? `，按句失配重译 ${stalePages} 页` : ''
    emitBookTranslationProgress(makeProgressPayload(null, options?.retryFailedOnly
      ? `已复用缓存 ${cachedPages} 页${staleText}，跳过非失败页 ${skippedPages} 页`
      : `已复用缓存 ${cachedPages} 页${staleText}，待翻译 ${pendingPages.length} 页`))
    await yieldToEventLoop()
  }

  if (pendingPages.length === 0) {
    emitBookTranslationProgress(makeProgressPayload(
      null,
      options?.retryFailedOnly ? '没有失败页需要重试' : '整书翻译完成，译文均来自缓存',
      'completed',
    ))
    return
  }

  let nextPageIndex = 0
  const translateOnePage = async (page: BookTranslationPageWorkItem) => {
    try {
      throwIfBookTranslationShuttingDown()
      emitBookTranslationProgress(makeProgressPayload(page, `正在翻译第 ${page.page_num} 页`))
      const translationBatches = buildParallelTranslationInputBatches(page.sourceText, { maxChars: 5200, maxSegments: 100 })
      if (translationBatches.length === 0) throw new Error('本页没有可翻译句子')
      const translatedBatches: string[] = []

      for (let batchIndex = 0; batchIndex < translationBatches.length; batchIndex += 1) {
        throwIfBookTranslationShuttingDown()
        const translationInput = translationBatches[batchIndex]
        const translationTaskOptions: AiTaskOptions = {
          pageId: page.id,
          pageNum: page.page_num,
          glossaryProjectId: projectId,
          translationStyle: style,
          documentTitle: doc.title || '',
          pageContextBefore: getBookTranslationContext(pages, page.sourceIndex, -1),
          pageContextAfter: getBookTranslationContext(pages, page.sourceIndex, 1),
          onlyNonChinese: page.onlyNonChinese,
          readerMode: true,
          bookTranslation: true,
          parallelSegments: true,
          segmentCount: translationInput.segmentCount,
          layoutVersion: 6,
        }
        const result = await runAiTask('translate', translationInput.input, translationTaskOptions)
        throwIfBookTranslationShuttingDown()
        let batchTranslationText = normalizeParallelTranslationLayout(result, translationInput.segmentCount)
        if (!isParallelTranslationAligned(translationInput.segments.join('\n'), batchTranslationText)) {
          emitBookTranslationProgress(makeProgressPayload(page, `正在修复第 ${page.page_num} 页第 ${batchIndex + 1} 批译文对齐`))
          const repairedResult = await runAiTask('translate', translationInput.input, {
            ...translationTaskOptions,
            parallelAlignmentRepair: true,
            previousTranslation: result,
          })
          throwIfBookTranslationShuttingDown()
          batchTranslationText = normalizeParallelTranslationLayout(repairedResult, translationInput.segmentCount)
        }
        if (!isParallelTranslationAligned(translationInput.segments.join('\n'), batchTranslationText)) {
          emitBookTranslationProgress(makeProgressPayload(page, `正在逐句翻译第 ${page.page_num} 页第 ${batchIndex + 1} 批`))
          const sentenceTranslations: string[] = []
          for (let segmentIndex = 0; segmentIndex < translationInput.segments.length; segmentIndex += 1) {
            const segment = translationInput.segments[segmentIndex]
            const singleInput = buildParallelTranslationInputFromSegments([segment], { maxSegments: 1, maxChars: 5200 })
            const singleTaskOptions: AiTaskOptions = {
              ...translationTaskOptions,
              segmentCount: 1,
              pageContextBefore: segmentIndex > 0 ? translationInput.segments[segmentIndex - 1] : translationTaskOptions.pageContextBefore,
              pageContextAfter: segmentIndex + 1 < translationInput.segments.length ? translationInput.segments[segmentIndex + 1] : translationTaskOptions.pageContextAfter,
            }
            const singleResult = await runAiTask('translate', singleInput.input, singleTaskOptions)
            throwIfBookTranslationShuttingDown()
            let singleTranslationText = normalizeParallelTranslationLayout(singleResult, 1)
            if (!isParallelTranslationAligned(segment, singleTranslationText)) {
              const repairedSingleResult = await runAiTask('translate', singleInput.input, {
                ...singleTaskOptions,
                parallelAlignmentRepair: true,
                previousTranslation: singleResult,
              })
              throwIfBookTranslationShuttingDown()
              singleTranslationText = normalizeParallelTranslationLayout(repairedSingleResult, 1)
            }
            if (!isParallelTranslationAligned(segment, singleTranslationText)) {
              throw new Error(`第 ${page.page_num} 页第 ${batchIndex + 1} 批第 ${segmentIndex + 1} 句译文未按句对齐`)
            }
            sentenceTranslations.push(singleTranslationText)
          }
          batchTranslationText = sentenceTranslations.join('\n').trim()
        }
        if (!isParallelTranslationAligned(translationInput.segments.join('\n'), batchTranslationText)) {
          throw new Error(`第 ${page.page_num} 页第 ${batchIndex + 1} 批译文未按句对齐`)
        }
        translatedBatches.push(batchTranslationText)
        if (translationBatches.length > 1) {
          emitBookTranslationProgress(makeProgressPayload(page, `正在翻译第 ${page.page_num} 页（${batchIndex + 1}/${translationBatches.length} 批）`))
        }
      }

      const translationText = translatedBatches.join('\n').trim()
      if (!isParallelTranslationAligned(page.sourceText, translationText)) {
        throw new Error(`第 ${page.page_num} 页译文未完整对齐`)
      }
      throwIfBookTranslationShuttingDown()
      page.translationText = translationText
      saveBookTranslationCache(docId, page, page.sourceHash, page.sourceText, translationText, 'ready', null, modelSignature)
      translatedPages += 1
      writeBookTranslationFile(doc, pages, outputPath)
      emitBookTranslationProgress(makeProgressPayload(page, `整书翻译中：${cachedPages + translatedPages + skippedPages}/${totalPages} 页`))
    } catch (error: unknown) {
      if (isBookTranslationShutdownError(error)) throw error
      const errorMessage = getErrorMessage(error)
      failedPages += 1
      saveBookTranslationCache(docId, page, page.sourceHash, page.sourceText, '', 'error', errorMessage, modelSignature)
      writeBookTranslationFile(doc, pages, outputPath)
      emitBookTranslationProgress(makeProgressPayload(
        page,
        `第 ${page.page_num} 页翻译失败，已继续后续页面`,
        'processing',
        errorMessage,
      ))
    }
    await yieldToEventLoop()
  }

  const workers = Array.from({ length: Math.min(concurrency, pendingPages.length) }, async () => {
    while (!bookTranslationRuntimeShuttingDown && nextPageIndex < pendingPages.length) {
      const page = pendingPages[nextPageIndex]
      nextPageIndex += 1
      if (page) await translateOnePage(page)
    }
  })
  const workerResults = await Promise.allSettled(workers)
  throwIfBookTranslationShuttingDown()
  const workerError = workerResults.find((result) => result.status === 'rejected')
  if (workerError?.status === 'rejected') throw workerError.reason

  writeBookTranslationFile(doc, pages, outputPath)
  const finalStatus: BookTranslationProgressEvent['status'] = failedPages ? 'partial' : 'completed'
  const totalCompletedPages = cachedPages + translatedPages + skippedPages
  const staleText = stalePages ? `，按句失配重译 ${stalePages} 页` : ''
  const finalMessage = failedPages
    ? `整书翻译部分完成：已缓存 ${cachedPages} 页，新翻译 ${translatedPages} 页${staleText}，失败 ${failedPages} 页`
    : `整书翻译完成：已缓存 ${cachedPages} 页，新翻译 ${translatedPages} 页${staleText}`
  emitBookTranslationProgress({
    jobId,
    docId,
    status: finalStatus,
    progress: 1,
    completedPages: totalCompletedPages,
    failedPages,
    cachedPages,
    stalePages,
    translatedPages,
    skippedPages,
    totalPages,
    outputPath,
    message: finalMessage,
    errorMessage: failedPages ? `仍有 ${failedPages} 页失败，可重试失败页` : undefined,
  })
}

function ensureWordsResult(layoutResult: ImportedOcrBlock[], fallbackText = ''): ImportedWordResult[] {
  if (Array.isArray(layoutResult) && layoutResult.length > 0) {
    const text = layoutResult.map((block) => String(block?.words || block?.block_content || '').trim()).filter(Boolean).join('\n')
    return (text || fallbackText)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ words: line }))
  }

  return String(fallbackText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ words: line }))
}

function normalizePaddleVlParsingBlocks(blocks: unknown[]): ImportedOcrBlock[] {
  return blocks.map((block, index): ImportedOcrBlock => {
    const record = isJsonRecord(block) ? block : {}
    const words = String(record.words || record.block_content || record.text || getStructuredOcrBlockText(record) || '').trim()
    return {
      ...record,
      words,
      label: record.label || record.block_label || record.type || 'text',
      location: record.location || record.block_bbox || record.bbox || record.points,
      reading_order: Number.isFinite(Number(record.reading_order))
        ? Number(record.reading_order)
        : Number.isFinite(Number(record.block_order))
          ? Number(record.block_order)
          : index,
      block_order: Number.isFinite(Number(record.block_order)) ? Number(record.block_order) : undefined,
    }
  }).filter((block) => Boolean(block.words))
}

function normalizeImportedOcrPayload(payload: unknown): NormalizedImportedOcrPayload {
  if (!isJsonRecord(payload)) {
    return { ocrResult: { words_result: [], layout_result: [] }, text: '' }
  }

  const prunedResult = isJsonRecord(payload.prunedResult) ? payload.prunedResult : {}
  const markdown = isJsonRecord(payload.markdown) ? payload.markdown : {}
  const vlParsingBlocks = Array.isArray(payload.parsing_res_list)
    ? payload.parsing_res_list
    : Array.isArray(prunedResult.parsing_res_list)
      ? prunedResult.parsing_res_list
      : []
  if (vlParsingBlocks.length > 0) {
    const layoutResult = normalizePaddleVlParsingBlocks(vlParsingBlocks)
    const text = String(
      payload.ocr_text
      || payload.proofed_text
      || payload.text
      || markdown.text
      || layoutResult.map((block) => block.words).filter(Boolean).join('\n'),
    ).trim()
    return {
      ocrResult: {
        ...payload,
        layout_result: layoutResult,
        words_result: ensureWordsResult(layoutResult, text),
      },
      text,
    }
  }

  if (Array.isArray(payload.layout_result) || Array.isArray(payload.words_result)) {
    const layoutResult = Array.isArray(payload.layout_result) ? normalizePaddleVlParsingBlocks(payload.layout_result) : []
    const wordResults = Array.isArray(payload.words_result) ? payload.words_result : []
    const text = String(
      payload.ocr_text
      || payload.proofed_text
      || payload.text
      || wordResults.map((item) => isJsonRecord(item) ? item.words : '').join('\n'),
    ).trim()

    return {
      ocrResult: {
        ...payload,
        layout_result: layoutResult,
        words_result: wordResults.length > 0 ? wordResults : ensureWordsResult(layoutResult, text),
      },
      text,
    }
  }

  const normalized = normalizePageResult(payload) as unknown
  const normalizedRecord = isJsonRecord(normalized) ? normalized : {}
  const wordResults = Array.isArray(normalizedRecord.words_result) ? normalizedRecord.words_result : []
  const text = wordResults.map((item) => isJsonRecord(item) ? item.words : '').join('\n') || ''
  return { ocrResult: normalized, text }
}

function extractImportedJsonPages(raw: unknown): JsonRecord[] {
  if (Array.isArray(raw)) return raw.filter(isJsonRecord)
  if (!isJsonRecord(raw)) return []
  if (Array.isArray(raw.pages)) return raw.pages.filter(isJsonRecord)
  if (Array.isArray(raw.results)) return raw.results.filter(isJsonRecord)
  if (Array.isArray(raw.data)) return raw.data.filter(isJsonRecord)
  const result = isJsonRecord(raw.result) ? raw.result : {}
  if (Array.isArray(result.pages)) return result.pages.filter(isJsonRecord)
  if (Array.isArray(result.results)) return result.results.filter(isJsonRecord)
  if (Array.isArray(raw.layoutParsingResults)) return raw.layoutParsingResults.filter(isJsonRecord)
  if (Array.isArray(result.layoutParsingResults)) return result.layoutParsingResults.filter(isJsonRecord)
  return [raw]
}

function inferImportedTitle(filePath: string, raw: JsonRecord, firstPage?: JsonRecord): string {
  const candidate = raw.title || raw.document_title || raw.doc_title || raw.name || raw.input_path || firstPage?.input_path || firstPage?.image_path
  if (candidate) {
    return basename(String(candidate)).replace(/\.[^.]+$/, '')
  }
  return basename(filePath, extname(filePath))
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const key = String(entity || '').toLowerCase()
    if (key[0] === '#') {
      const codePoint = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return match
        }
      }
    }
    return named[key] ?? match
  })
}

function cleanEpubHtmlForText(value: string): string {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[\s\S]*?<\/rp>/gi, '')
    .replace(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/gi, ' $2 ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi, '\n$1\n')
}

function stripHtmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[\s\S]*?<\/rp>/gi, '')
    .replace(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/gi, ' $2 ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<\/(?:p|div|section|article|chapter|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => decodeHtmlEntities(`&${entity};`))
}

type EbookHtmlBlock = NonNullable<EbookTextSection['html_blocks']>[number]

type EbookHtmlBlockWithAnchor = EbookHtmlBlock & { anchor_id?: string }

function parseHtmlTableRows(html: string): string[][] {
  const rows: string[][] = []
  const rowMatches = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []
  for (const rowHtml of rowMatches) {
    const cells = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []
    const row = cells.map((cell) => stripHtmlToText(cell).replace(/\s+/g, ' ').trim())
    if (row.some(Boolean)) rows.push(row)
  }
  return rows
}

function extractElementAnchorId(html: string): string {
  const match = String(html || '').match(/\s(?:id|name)=["']([^"']+)["']/i)
  return match ? decodeHtmlEntities(match[1]).trim() : ''
}

function parseEpubHtmlBlocks(raw: string): EbookHtmlBlockWithAnchor[] {
  const bodyMatch = String(raw || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const source = bodyMatch ? bodyMatch[1] : String(raw || '')
  const cleaned = cleanEpubHtmlForText(source)
  const pattern = /<h([1-6])[^>]*>[\s\S]*?<\/h\1>|<p[^>]*>[\s\S]*?<\/p>|<li[^>]*>[\s\S]*?<\/li>|<blockquote[^>]*>[\s\S]*?<\/blockquote>|<table[\s\S]*?<\/table>|<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi
  const blocks: EbookHtmlBlock[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(cleaned))) {
    const html = match[0]
    if (/^<table/i.test(html)) {
      const rows = parseHtmlTableRows(html)
      if (rows.length > 0) {
        blocks.push({ type: 'table', text: rows.map((row) => row.join('\t')).join('\n'), rows, anchor_id: extractElementAnchorId(html) })
      }
      continue
    }

    const heading = html.match(/^<h([1-6])/i)
    const text = stripHtmlToText(html).replace(/[ \t]+/g, ' ').trim()
    if (!text) continue
    blocks.push({
      type: heading ? 'heading' : 'paragraph',
      text,
      level: heading ? Number(heading[1]) : undefined,
      anchor_id: extractElementAnchorId(html),
    })
  }

  if (blocks.length > 0) return blocks
  const fallback = stripHtmlToText(cleaned)
  return fallback
    .split(/\n{2,}/)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ type: 'paragraph', text }))
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (Array.isArray(value)) return value.map(textValue).find(Boolean) || ''
  if (isJsonRecord(value)) return textValue(value['#text'] ?? value._text ?? value.value)
  return ''
}

function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function splitHrefFragment(href: string): { path: string; fragment: string } {
  const [path, ...rest] = String(href || '').split('#')
  return { path, fragment: rest.join('#') }
}

function resolveZipHref(baseDir: string, href: string): string {
  const { path, fragment } = splitHrefFragment(href)
  const resolved = normalizeZipPath(posixPath.normalize(posixPath.join(baseDir, path || '')))
  return fragment ? `${resolved}#${fragment}` : resolved
}

function stripHrefHash(href: string): string {
  return normalizeZipPath(String(href || '').split('#')[0])
}

function hrefFragment(href: string): string {
  return splitHrefFragment(href).fragment
}

function makeTocId(href: string, order: number): string {
  return `toc_${order}_${href.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}`
}

function makeEbookAnchorKey(href: string, sourcePageNum?: number | null, charIndex = 0): string {
  const pagePart = sourcePageNum && sourcePageNum > 0 ? `page:${sourcePageNum}` : `href:${stripHrefHash(href)}`
  const fragment = hrefFragment(href)
  return `${pagePart}${fragment ? `#${fragment}` : ''}:char:${Math.max(0, Math.round(charIndex))}`
}

function findNodesByKey(node: unknown, key: string, result: unknown[] = []): unknown[] {
  if (!isJsonRecord(node) && !Array.isArray(node)) return result
  if (Array.isArray(node)) {
    node.forEach((item) => findNodesByKey(item, key, result))
    return result
  }
  if (node[key] !== undefined) result.push(...toArray(node[key]))
  for (const value of Object.values(node)) {
    if (isJsonRecord(value) || Array.isArray(value)) {
      if (Array.isArray(value)) value.forEach((item) => findNodesByKey(item, key, result))
      else findNodesByKey(value, key, result)
    }
  }
  return result
}

function parseNavList(items: unknown[], baseDir: string, level: number, parentId: string | null, orderRef: { value: number }): EbookTocItem[] {
  const toc: EbookTocItem[] = []
  for (const itemValue of items) {
    const item = isJsonRecord(itemValue) ? itemValue : {}
    const link = toArray(getRecordValue(item, 'a')).find(isJsonRecord)
      || toArray(getRecordValue(item, 'span')).find(isJsonRecord)
      || null
    const href = link?.href ? resolveZipHref(baseDir, String(link.href)) : ''
    const title = textValue(link) || textValue(item).replace(/\s+/g, ' ').trim().slice(0, 80)
    const order = orderRef.value++
    const id = makeTocId(href || title, order)
    if (title) {
      toc.push({ id, title, href, level, order, parent_id: parentId })
    }
    const childOl = toArray(getRecordValue(item, 'ol'))
    childOl.forEach((ol) => {
      toc.push(...parseNavList(toArray(getRecordValue(ol, 'li')), baseDir, level + 1, title ? id : parentId, orderRef))
    })
  }
  return toc
}

function parseNavToc(raw: string, baseDir: string): EbookTocItem[] {
  try {
    const parsed = xmlParser.parse(raw)
    const navs = findNodesByKey(parsed, 'nav').filter(isJsonRecord)
    const tocNav = navs.find((nav) => String(nav.type || nav['epub:type'] || '').includes('toc')) || navs[0]
    const orderRef = { value: 0 }
    return toArray(getRecordValue(tocNav, 'ol')).flatMap((ol) => parseNavList(toArray(getRecordValue(ol, 'li')), baseDir, 1, null, orderRef))
  } catch {
    return []
  }
}

function parseNcxPoints(points: unknown[], baseDir: string, level: number, parentId: string | null, orderRef: { value: number }): EbookTocItem[] {
  const toc: EbookTocItem[] = []
  for (const pointValue of points) {
    const point = isJsonRecord(pointValue) ? pointValue : {}
    const href = getPathValue(point, ['content', 'src']) ? resolveZipHref(baseDir, String(getPathValue(point, ['content', 'src']))) : ''
    const title = textValue(getPathValue(point, ['navLabel', 'text'])) || textValue(point.navLabel)
    const order = orderRef.value++
    const id = makeTocId(href || title, order)
    if (title) {
      toc.push({ id, title, href, level, order, parent_id: parentId })
    }
    toc.push(...parseNcxPoints(toArray(point.navPoint), baseDir, level + 1, title ? id : parentId, orderRef))
  }
  return toc
}

function parseNcxToc(raw: string, baseDir: string): EbookTocItem[] {
  try {
    const parsed = xmlParser.parse(raw)
    const points = toArray(getPathValue(parsed, ['ncx', 'navMap', 'navPoint']))
    return parseNcxPoints(points, baseDir, 1, null, { value: 0 })
  } catch {
    return []
  }
}

function firstHeadingFromHtml(raw: string): string {
  const match = raw.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  return match ? stripHtmlToText(match[1]).replace(/\s+/g, ' ').trim().slice(0, 80) : ''
}

function chunkText(text: string, limit = EBOOK_SECTION_CHAR_LIMIT): string[] {
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized) return []
  const chunks: string[] = []
  let current = ''
  const blocks = normalized.split(/\n{2,}/)

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const candidate = current ? `${current}\n\n${trimmed}` : trimmed
    if (candidate.length <= limit) {
      current = candidate
      continue
    }
    if (current) chunks.push(current)
    if (trimmed.length <= limit) {
      current = trimmed
      continue
    }
    for (let start = 0; start < trimmed.length; start += limit) {
      chunks.push(trimmed.slice(start, start + limit))
    }
    current = ''
  }

  if (current) chunks.push(current)
  return chunks
}

function chunkEbookBlocks(blocks: EbookHtmlBlock[], limit = EBOOK_SECTION_CHAR_LIMIT): Array<{ text: string; html_blocks: EbookHtmlBlock[] }> {
  const chunks: Array<{ text: string; html_blocks: EbookHtmlBlock[] }> = []
  let currentBlocks: EbookHtmlBlock[] = []
  let currentLength = 0

  const flush = () => {
    if (currentBlocks.length === 0) return
    chunks.push({
      html_blocks: currentBlocks,
      text: currentBlocks.map((block) => block.text).filter(Boolean).join('\n\n'),
    })
    currentBlocks = []
    currentLength = 0
  }

  for (const block of blocks) {
    const text = String(block.text || '').trim()
    if (!text) continue
    const nextLength = currentLength + text.length + (currentBlocks.length ? 2 : 0)
    if (currentBlocks.length > 0 && nextLength > limit) flush()
    if (text.length <= limit) {
      currentBlocks.push(block)
      currentLength += text.length + (currentBlocks.length > 1 ? 2 : 0)
      continue
    }
    flush()
    chunkText(text, limit).forEach((chunk) => {
      chunks.push({
        text: chunk,
        html_blocks: [{ ...block, type: block.type === 'heading' ? 'heading' : 'paragraph', text: chunk, rows: undefined }],
      })
    })
  }

  flush()
  return chunks
}

function normalizeTocTitleForCompare(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[《》「」『』“”‘’"'.,，。；;：:、!！?？（）()\[\]【】\-—–·]/g, '')
    .toLowerCase()
}

function splitEbookBlocksByTocAnchors(
  href: string,
  fallbackTitle: string,
  fallbackLevel: number,
  blocks: EbookHtmlBlockWithAnchor[],
  tocItems: EbookTocItem[],
): Array<{ title: string; level: number; href: string; blocks: EbookHtmlBlockWithAnchor[] }> {
  const byFragment = new Map<string, EbookTocItem>()
  const pathOnly = stripHrefHash(href)
  tocItems
    .filter((item) => stripHrefHash(item.href) === pathOnly && hrefFragment(item.href))
    .forEach((item) => byFragment.set(hrefFragment(item.href), item))

  const segments: Array<{ title: string; level: number; href: string; blocks: EbookHtmlBlockWithAnchor[] }> = []
  let current = { title: fallbackTitle, level: fallbackLevel, href: pathOnly, blocks: [] as EbookHtmlBlockWithAnchor[] }
  const flush = () => {
    if (current.blocks.some((block) => String(block.text || '').trim())) {
      segments.push(current)
    }
  }

  const headingTitleByKey = new Map<string, EbookTocItem>()
  tocItems
    .filter((item) => stripHrefHash(item.href) === pathOnly)
    .forEach((item) => {
      const key = normalizeTocTitleForCompare(item.title)
      if (key && !headingTitleByKey.has(key)) headingTitleByKey.set(key, item)
    })

  blocks.forEach((block) => {
    const anchorItem = block.anchor_id ? byFragment.get(block.anchor_id) : undefined
    const headingItem = !anchorItem && block.type === 'heading'
      ? headingTitleByKey.get(normalizeTocTitleForCompare(block.text))
      : undefined
    const matchedItem = anchorItem || headingItem

    if (matchedItem && current.blocks.length > 0) {
      flush()
      current = {
        title: matchedItem.title || fallbackTitle,
        level: matchedItem.level || fallbackLevel,
        href: matchedItem.href || pathOnly,
        blocks: [],
      }
    } else if (matchedItem && current.blocks.length === 0) {
      current.title = matchedItem.title || current.title
      current.level = matchedItem.level || current.level
      current.href = matchedItem.href || current.href
    }
    current.blocks.push(block)
  })

  flush()
  return segments.length > 0 ? segments : [{ title: fallbackTitle, level: fallbackLevel, href: pathOnly, blocks }]
}

function paginateText(text: string, limit = TEXT_PAGE_CHAR_LIMIT): string[] {
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized) return []

  const pages: string[] = []
  let current = ''
  const blocks = normalized.split(/\n{2,}/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue

    if ((current + '\n\n' + trimmed).trim().length <= limit) {
      current = (current ? `${current}\n\n${trimmed}` : trimmed)
      continue
    }

    if (current) {
      pages.push(current)
      current = ''
    }

    if (trimmed.length <= limit) {
      current = trimmed
      continue
    }

    for (let index = 0; index < trimmed.length; index += limit) {
      pages.push(trimmed.slice(index, index + limit))
    }
  }

  if (current) pages.push(current)
  return pages
}

function decodeBufferWithLabel(buffer: Buffer | Uint8Array, label: string): string {
  const source = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
  if (label === 'utf-16le' || label === 'utf16le') return source.toString('utf16le')
  try {
    return new TextDecoder(label, { fatal: false }).decode(source)
  } catch {
    return source.toString('utf-8')
  }
}

function detectDeclaredEncoding(rawPreview: string): string | null {
  const xml = rawPreview.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)?.[1]
  if (xml) return xml
  const charset = rawPreview.match(/<meta[^>]+charset=["']?\s*([^"'\s/>]+)/i)?.[1]
  if (charset) return charset
  const contentType = rawPreview.match(/<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([^"'\s/>;]+)/i)?.[1]
  return contentType || null
}

function scoreDecodedText(text: string): number {
  if (!text) return Number.NEGATIVE_INFINITY
  const replacement = (text.match(/\uFFFD/g) || []).length
  const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length
  const markup = /<(html|body|package|ncx|nav|opf|container)\b/i.test(text) ? 40 : 0
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  return markup + Math.min(cjk, 200) / 10 - replacement * 25 - controls * 10
}

function hasCleanUtf8Text(text: string): boolean {
  if (!text.trim()) return false
  const replacement = (text.match(/\uFFFD/g) || []).length
  const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length
  return replacement === 0 && controls === 0
}

function detectTextEncoding(buffer: Buffer | Uint8Array, declared?: string | null): string {
  const source = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) return 'utf-8'
  if (source.length >= 2) {
    if (source[0] === 0xff && source[1] === 0xfe) return 'utf-16le'
    if (source[0] === 0xfe && source[1] === 0xff) return 'utf-16be'
  }
  if (declared) return declared

  const preview = source.subarray(0, Math.min(source.length, 4096)).toString('latin1')
  const declaredFromPreview = detectDeclaredEncoding(preview)
  if (declaredFromPreview) return declaredFromPreview

  const utf8Text = decodeBufferWithLabel(source, 'utf-8')
  if (hasCleanUtf8Text(utf8Text)) return 'utf-8'

  return decoderLabels
    .map((label) => ({ label, score: scoreDecodedText(decodeBufferWithLabel(source, label)) }))
    .sort((left, right) => right.score - left.score)[0]?.label || 'utf-8'
}

function decodeEpubEntry(buffer: Buffer | Uint8Array): string {
  const encoding = detectTextEncoding(buffer)
  return decodeBufferWithLabel(buffer, encoding).replace(/^\uFEFF/, '')
}

async function readPlainTextFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  return decodeBufferWithLabel(buffer, detectTextEncoding(buffer)).replace(/^\uFEFF/, '')
}

async function parseEpubFile(filePath: string): Promise<ParsedEbook> {
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('EPUB 缺少 META-INF/container.xml')

  const container = xmlParser.parse(decodeEpubEntry(await containerFile.async('uint8array')))
  const rootfilePath = textValue(container?.container?.rootfiles?.rootfile?.['full-path'])
    || String(container?.container?.rootfiles?.rootfile?.['full-path'] || '')
  const opfPath = normalizeZipPath(rootfilePath)
  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error('EPUB 缺少 OPF 包描述文件')

  const opfBaseDir = posixPath.dirname(opfPath) === '.' ? '' : posixPath.dirname(opfPath)
  const opf = xmlParser.parse(decodeEpubEntry(await opfFile.async('uint8array')))?.package
  const metadata = opf?.metadata || {}
  const manifestItems = toArray(opf?.manifest?.item)
  const manifestById = new Map<string, JsonRecord>()
  manifestItems.forEach((item) => {
    if (isJsonRecord(item) && item.id) manifestById.set(String(item.id), item)
  })

  const title = textValue(metadata.title) || basename(filePath, extname(filePath))
  const author = textValue(metadata.creator) || null
  const language = textValue(metadata.language)
  const identifier = textValue(metadata.identifier)
  const spineRefs = toArray(opf?.spine?.itemref)
  const spineItems = spineRefs
    .map((ref) => manifestById.get(String(ref?.idref || '')))
    .filter((item): item is JsonRecord => Boolean(item?.href && /\.(xhtml|html|htm)$/i.test(String(item.href))))

  if (spineItems.length === 0) throw new Error('EPUB 没有可阅读的正文 spine')

  const navItem = manifestItems.find((item) => String(item?.properties || '').split(/\s+/).includes('nav'))
  const ncxItem = manifestItems.find((item) => String(item?.['media-type'] || '') === 'application/x-dtbncx+xml')
    || manifestById.get(String(opf?.spine?.toc || ''))

  let toc: EbookTocItem[] = []
  if (navItem?.href) {
    const navPath = resolveZipHref(opfBaseDir, String(navItem.href))
    const navFile = zip.file(stripHrefHash(navPath))
    if (navFile) toc = parseNavToc(decodeEpubEntry(await navFile.async('uint8array')), posixPath.dirname(stripHrefHash(navPath)) === '.' ? '' : posixPath.dirname(stripHrefHash(navPath)))
  }
  if (toc.length === 0 && ncxItem?.href) {
    const ncxPath = resolveZipHref(opfBaseDir, String(ncxItem.href))
    const ncxFile = zip.file(stripHrefHash(ncxPath))
    if (ncxFile) toc = parseNcxToc(decodeEpubEntry(await ncxFile.async('uint8array')), posixPath.dirname(stripHrefHash(ncxPath)) === '.' ? '' : posixPath.dirname(stripHrefHash(ncxPath)))
  }

  const tocByHref = new Map<string, EbookTocItem>()
  toc.forEach((item) => {
    if (item.href && !tocByHref.has(stripHrefHash(item.href))) tocByHref.set(stripHrefHash(item.href), item)
  })

  const sections: EbookTextSection[] = []
  const spine = [] as Array<{ href: string; title?: string }>

  for (let spineIndex = 0; spineIndex < spineItems.length; spineIndex += 1) {
    const item = spineItems[spineIndex]
    const href = resolveZipHref(opfBaseDir, String(item.href))
    const file = zip.file(stripHrefHash(href))
    if (!file) continue
    const raw = decodeEpubEntry(await file.async('uint8array'))
    const htmlBlocks = parseEpubHtmlBlocks(raw)
    const text = htmlBlocks.map((block) => block.text).filter(Boolean).join('\n\n') || stripHtmlToText(raw)
    if (!text) continue
    const tocItem = tocByHref.get(stripHrefHash(href))
    const chapterTitle = tocItem?.title || firstHeadingFromHtml(raw) || `章节 ${spineIndex + 1}`
    spine.push({ href, title: chapterTitle })
    splitEbookBlocksByTocAnchors(
      href,
      chapterTitle,
      tocItem?.level || 1,
      htmlBlocks.length > 0 ? htmlBlocks : [{ type: 'paragraph', text }],
      toc,
    ).forEach((logicalSection, logicalIndex) => {
      chunkEbookBlocks(logicalSection.blocks).forEach((chunk, chunkIndex) => {
        const segmentIndex = sections.filter((section) => section.spine_index === spineIndex).length
        sections.push({
          id: `epub-${spineIndex}-${logicalIndex}-${chunkIndex}`,
          href: logicalSection.href || stripHrefHash(href),
          title: chunkIndex === 0 ? logicalSection.title : `${logicalSection.title} (${chunkIndex + 1})`,
          level: logicalSection.level || tocItem?.level || 1,
          spine_index: spineIndex,
          segment_index: segmentIndex,
          text: chunk.text,
          html_blocks: chunk.html_blocks,
        })
      })
    })
  }

  if (toc.length === 0) {
    toc = spine.map((item, index) => ({
      id: makeTocId(item.href, index),
      title: item.title || `章节 ${index + 1}`,
      href: item.href,
      level: 1,
      order: index,
      parent_id: null,
    }))
  }

  return {
    title,
    author,
    sections,
    manifest: {
      format: 'epub',
      title,
      author: author || undefined,
      language: language || undefined,
      identifier: identifier || undefined,
      source_file_name: basename(filePath),
      section_count: sections.length,
      spine,
      toc,
    },
  }
}

function inferTextHeading(line: string): { title: string; level: number } | null {
  const trimmed = line.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed.length > 80) return null
  const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/)
  if (markdown) return { title: markdown[2].trim(), level: markdown[1].length }
  if (/^(目录|序言|自序|前言|绪论|引言|结语|后记|附录|参考文献)$/.test(trimmed)) return { title: trimmed, level: 1 }
  if (/^第[一二三四五六七八九十百千万\d]+[章节卷篇部编回]/.test(trimmed)) {
    const level = /^第.+[卷部编]/.test(trimmed) ? 1 : 2
    return { title: trimmed, level }
  }
  if (/^[一二三四五六七八九十百千万\d]+[、.．]\s*.{2,60}$/.test(trimmed)) return { title: trimmed, level: 3 }
  return null
}

function parsePlainTextEbook(filePath: string, text: string, format: 'plain_text' | 'markdown'): ParsedEbook {
  const title = basename(filePath, extname(filePath))
  const sections: EbookTextSection[] = []
  const toc: EbookTocItem[] = []
  let currentTitle = title
  let currentLevel = 1
  let currentLines: string[] = []
  let spineIndex = 0

  const flush = () => {
    const content = currentLines.join('\n').trim()
    if (!content) return
    const href = `text-section-${spineIndex + 1}.xhtml`
    const tocOrder = toc.length
    toc.push({
      id: makeTocId(href, tocOrder),
      title: currentTitle,
      href,
      level: currentLevel,
      order: tocOrder,
      parent_id: null,
    })
    chunkText(content).forEach((chunk, segmentIndex) => {
      sections.push({
        id: `text-${spineIndex}-${segmentIndex}`,
        href,
        title: segmentIndex === 0 ? currentTitle : `${currentTitle} (${segmentIndex + 1})`,
        level: currentLevel,
        spine_index: spineIndex,
        segment_index: segmentIndex,
        text: chunk,
      })
    })
    spineIndex += 1
  }

  for (const line of text.replace(/\r/g, '').split('\n')) {
    const heading = inferTextHeading(line)
    if (heading && currentLines.join('').trim()) {
      flush()
      currentTitle = heading.title
      currentLevel = heading.level
      currentLines = [line.replace(/^#{1,6}\s+/, '')]
      continue
    }
    if (heading && !currentLines.join('').trim()) {
      currentTitle = heading.title
      currentLevel = heading.level
    }
    currentLines.push(line)
  }
  flush()

  if (sections.length === 0) {
    chunkText(text).forEach((chunk, index) => {
      const href = `text-section-${index + 1}.xhtml`
      sections.push({
        id: `text-0-${index}`,
        href,
        title: index === 0 ? title : `${title} (${index + 1})`,
        level: 1,
        spine_index: index,
        segment_index: 0,
        text: chunk,
      })
      toc.push({ id: makeTocId(href, index), title: index === 0 ? title : `${title} (${index + 1})`, href, level: 1, order: index, parent_id: null })
    })
  }

  return {
    title,
    author: null,
    sections,
    manifest: {
      format,
      title,
      source_file_name: basename(filePath),
      section_count: sections.length,
      spine: sections
        .filter((section) => section.segment_index === 0)
        .map((section) => ({ href: section.href, title: section.title })),
      toc,
    },
  }
}

function insertTextPages(docId: string, pages: string[], now: string): void {
  pages.forEach((text, index) => {
    const ocrResult = {
      words_result: text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({ words: line })),
      layout_result: [],
      source_type: 'ebook_text',
    }
    run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nanoid(), docId, index + 1, null, text, JSON.stringify(ocrResult), null, 'completed', 'pending', now],
    )
  })
}

async function insertEbookSections(docId: string, sections: EbookTextSection[], now: string): Promise<Map<string, { pageNum: number; charStart: number }>> {
  const anchors = new Map<string, { pageNum: number; charStart: number }>()
  for (let index = 0; index < sections.length; index += DOCUMENT_DB_INSERT_CHUNK_SIZE) {
    const chunk = sections.slice(index, index + DOCUMENT_DB_INSERT_CHUNK_SIZE)
    transaction(() => {
      chunk.forEach((section, chunkIndex) => {
        const pageIndex = index + chunkIndex
        if (!anchors.has(section.href)) anchors.set(section.href, { pageNum: pageIndex + 1, charStart: 0 })
        const sectionPath = stripHrefHash(section.href)
        if (sectionPath && !anchors.has(sectionPath)) anchors.set(sectionPath, { pageNum: pageIndex + 1, charStart: 0 })
        const layoutResult = (section.html_blocks || []).map((block, blockIndex) => ({
          words: block.text,
          label: block.type,
          type: block.type,
          level: block.level,
          rows: block.rows,
          reading_order: blockIndex,
        }))
        const ocrResult = {
          words_result: section.text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({ words: line })),
          layout_result: layoutResult,
          source_type: 'ebook_section',
          ebook: {
            href: section.href,
            title: section.title,
            level: section.level,
            spine_index: section.spine_index,
            segment_index: section.segment_index,
            html_blocks: section.html_blocks || [],
          },
        }
        run(
          'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [nanoid(), docId, pageIndex + 1, null, section.text, JSON.stringify(ocrResult), null, 'completed', 'pending', now],
        )
      })
    })
    if (index + DOCUMENT_DB_INSERT_CHUNK_SIZE < sections.length) {
      await yieldToEventLoop()
    }
  }
  return anchors
}

function saveImportedEbookToc(docId: string, toc: EbookTocItem[], anchors: Map<string, { pageNum: number; charStart: number }>): void {
  if (!toc.length) return
  const items: TocItemV2[] = toc.map((item) => {
    const href = item.href || ''
    const anchor = anchors.get(href) || anchors.get(stripHrefHash(href))
    const sourcePageNum = item.source_page_num || anchor?.pageNum || null
    return {
      ...item,
      href,
      anchor_text: item.anchor_text || item.title,
      anchor_key: item.anchor_key || makeEbookAnchorKey(href, sourcePageNum, anchor?.charStart || 0),
      source_page_num: sourcePageNum,
      source: 'imported' as const,
      confidence: 0.92,
      status: sourcePageNum ? 'active' as const : 'unresolved' as const,
    }
  })
  saveDocumentToc(docId, items, 'imported')
}

function syncDocumentProofStatus(docId: string): void {
  const stats = queryOne<{ total: number; completed: number }>(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN proof_status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM pages
    WHERE doc_id = ?`,
    [docId],
  )

  const total = Number(stats?.total || 0)
  const completed = Number(stats?.completed || 0)
  const nextStatus = total > 0 && completed === total ? 'completed' : 'pending'
  run('UPDATE documents SET proof_status = ?, updated_at = ? WHERE id = ?', [nextStatus, new Date().toISOString(), docId])
}

function markDocumentTocDirty(docId: string): void {
  run("DELETE FROM document_toc_items WHERE doc_id = ? AND source != 'manual'", [docId])
  clearDocumentTocAutogenAttempt(docId)
}

function migratePath(oldPath: string, storageDir: string): string {
  const relocatedPath = resolveManagedStoragePath(oldPath)
  if (!oldPath || existsSync(relocatedPath)) return relocatedPath
  const fileName = basename(oldPath)
  const docFolderName = basename(dirname(oldPath))
  const newPath = join(storageDir, docFolderName, fileName)
  return existsSync(newPath) ? newPath : oldPath
}

async function runBookTranslationJob(docId: string, jobId: string, options: BookTranslationOptions = {}) {
  throwIfBookTranslationShuttingDown()
  const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
  if (!doc) throw new Error('文献不存在')
  const outputPath = getBookTranslationFilePath(doc)
  const mode: TranslationMode = options.mode === 'fast' || options.mode === 'quality' ? options.mode : 'balanced'

  if (options.clearCache) {
    clearMachineTranslationUnits(docId)
    run('DELETE FROM page_translation_cache WHERE doc_id = ?', [docId])
    scheduleDatabaseSave()
    emitBookTranslationProgress({
      jobId,
      docId,
      status: 'completed',
      progress: 1,
      completedPages: 0,
      failedPages: 0,
      cachedPages: 0,
      stalePages: 0,
      translatedPages: 0,
      skippedPages: 0,
      totalPages: 0,
      outputPath,
      message: '已清除机器译文，人工修订译文已保留',
    })
    return
  }

  const rawPages = hydratePagePayloadRows(queryAll<BookTranslationPageRow>(
    `SELECT id, doc_id, page_num, ocr_text, ocr_text_ref, proofed_text, proofed_text_ref,
            ocr_result, ocr_result_ref
     FROM pages WHERE doc_id = ? ORDER BY page_num`,
    [docId],
  ))
  const pages: BookTranslationPageWorkItem[] = rawPages.map((page, sourceIndex) => {
    const sourceText = getBookTranslationSourceText(page)
    return {
      ...page,
      sourceIndex,
      sourceText,
      translationText: '',
      sourceHash: '',
      onlyNonChinese: false,
    }
  }).filter((page) => page.sourceText)
  const totalPages = pages.length
  emitBookTranslationProgress({
    jobId,
    docId,
    status: 'processing',
    progress: 0,
    completedPages: 0,
    failedPages: 0,
    cachedPages: 0,
    translatedPages: 0,
    skippedPages: 0,
    totalPages,
    outputPath,
    message: totalPages ? `开始整书翻译（${mode === 'fast' ? '快速' : mode === 'quality' ? '高质量' : '均衡'}模式）` : '没有可翻译文本',
  })
  if (totalPages === 0) {
    writeBookTranslationFile(doc, pages, outputPath)
    emitBookTranslationProgress({
      jobId,
      docId,
      status: 'completed',
      progress: 1,
      totalPages: 0,
      completedPages: 0,
      outputPath,
      message: '没有可翻译文本',
    })
    return
  }

  let cachedPages = 0
  let translatedPages = 0
  let skippedPages = 0
  let failedPages = 0
  let completedPages = 0
  let nextPageIndex = 0
  const defaultConcurrency = mode === 'fast' ? 4 : mode === 'quality' ? 1 : 2
  const concurrency = Math.max(1, Math.min(4, Math.round(Number(options.concurrency || defaultConcurrency))))

  const emitProgress = (page: BookTranslationPageWorkItem | null, messageText: string, errorMessage?: string) => {
    emitBookTranslationProgress({
      jobId,
      docId,
      status: 'processing',
      progress: totalPages ? Math.min(1, completedPages / totalPages) : 1,
      completedPages,
      failedPages,
      cachedPages,
      translatedPages,
      skippedPages,
      totalPages,
      pageNum: page?.page_num,
      outputPath,
      message: messageText,
      errorMessage,
    })
  }

  const translateOnePage = async (page: BookTranslationPageWorkItem) => {
    try {
      throwIfBookTranslationShuttingDown()
      const beforeUnits = ensurePageTranslationUnits(page.id)
      const failedUnitIds = beforeUnits.filter((unit) => unit.status === 'error').map((unit) => unit.id)
      if (options.retryFailedOnly && failedUnitIds.length === 0) {
        skippedPages += 1
        completedPages += 1
        emitProgress(page, `已跳过第 ${page.page_num} 页：没有失败块`)
        return
      }
      const wasReady = beforeUnits.length > 0 && beforeUnits.every((unit) => (
        unit.skipped || Boolean(unit.translationText.trim())
      ))
      const previousPage = pages[page.sourceIndex - 1]
      const nextPage = pages[page.sourceIndex + 1]
      emitProgress(page, `正在翻译第 ${page.page_num} 页`)
      const result = await translatePageUnits({
        docId,
        pageId: page.id,
        mode,
        glossaryProjectId: options.glossaryProjectId,
        style: options.style || DEFAULT_TRANSLATION_STYLE,
        force: Boolean(options.retryFailedOnly),
        unitIds: options.retryFailedOnly ? failedUnitIds : undefined,
        priority: 'book',
        documentTitle: doc.title || '',
        pageContextBefore: previousPage?.sourceText.slice(0, 500) || '',
        pageContextAfter: nextPage?.sourceText.slice(0, 500) || '',
      })
      page.translationText = result.translationText
      if (!result.complete || result.failedCount > 0) failedPages += 1
      else if (result.skippedCount === result.units.length) skippedPages += 1
      else if (wasReady && !options.retryFailedOnly) cachedPages += 1
      else translatedPages += 1
      completedPages += 1
      writeBookTranslationFile(doc, pages, outputPath)
      emitProgress(
        page,
        result.complete
          ? `整书翻译中：${completedPages}/${totalPages} 页`
          : `第 ${page.page_num} 页仍有 ${result.failedCount} 个翻译块失败，已继续后续页面`,
      )
    } catch (error) {
      if (isBookTranslationShutdownError(error)) throw error
      failedPages += 1
      completedPages += 1
      const errorMessage = getErrorMessage(error, '页面翻译失败')
      writeBookTranslationFile(doc, pages, outputPath)
      emitProgress(page, `第 ${page.page_num} 页翻译失败，已继续后续页面`, errorMessage)
    }
    await yieldToEventLoop()
  }

  const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (!bookTranslationRuntimeShuttingDown && nextPageIndex < pages.length) {
      const page = pages[nextPageIndex]
      nextPageIndex += 1
      if (page) await translateOnePage(page)
    }
  })
  const workerResults = await Promise.allSettled(workers)
  throwIfBookTranslationShuttingDown()
  const workerError = workerResults.find((result) => result.status === 'rejected')
  if (workerError?.status === 'rejected') throw workerError.reason

  writeBookTranslationFile(doc, pages, outputPath)
  emitBookTranslationProgress({
    jobId,
    docId,
    status: failedPages ? 'partial' : 'completed',
    progress: 1,
    completedPages: totalPages - failedPages,
    failedPages,
    cachedPages,
    translatedPages,
    skippedPages,
    totalPages,
    outputPath,
    message: failedPages
      ? `整书翻译部分完成：新翻译 ${translatedPages} 页，缓存 ${cachedPages} 页，失败 ${failedPages} 页`
      : `整书翻译完成：新翻译 ${translatedPages} 页，缓存 ${cachedPages} 页`,
    errorMessage: failedPages ? `仍有 ${failedPages} 页失败，可重试失败页` : undefined,
  })
}

function getLibrarySortDirection(options?: ListDocumentOptions): 'ASC' | 'DESC' {
  return options?.sortDirection === 'asc' ? 'ASC' : 'DESC'
}

function buildMissingLastOrder(expression: string, direction: 'ASC' | 'DESC'): string {
  return `CASE WHEN ${expression} IS NULL OR TRIM(CAST(${expression} AS TEXT)) = '' THEN 1 ELSE 0 END ASC, ${expression} ${direction}`
}

function buildDocumentMetadataValueExpression(key: string): string {
  return `CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.${key}') ELSE NULL END`
}

function buildDocumentMetadataTextExpression(key: string): string {
  return `CAST(${buildDocumentMetadataValueExpression(key)} AS TEXT)`
}

function buildMissingMetadataCondition(keys: string[]): string {
  return keys
    .map((key) => `TRIM(COALESCE(${buildDocumentMetadataTextExpression(key)}, '')) = ''`)
    .join('\n      AND ')
}

function buildDocumentTextPageCountExpression(alias = 'd'): string {
  return `(SELECT COUNT(*) FROM pages p_text_count WHERE p_text_count.doc_id = ${alias}.id AND ${buildPageContentAvailableCondition('p_text_count')})`
}

function buildDocumentCompletedPageCountExpression(alias = 'd'): string {
  return `(SELECT COUNT(*) FROM pages p_ocr_count WHERE p_ocr_count.doc_id = ${alias}.id AND p_ocr_count.ocr_status = 'completed' AND ${buildPageContentAvailableCondition('p_ocr_count')})`
}

function buildPageContentAvailableCondition(alias = 'p'): string {
  return `(
    TRIM(COALESCE(NULLIF(${alias}.proofed_text, ''), NULLIF(${alias}.ocr_text, ''), '')) <> ''
    OR TRIM(COALESCE(${alias}.proofed_text_ref, ${alias}.ocr_text_ref, '')) <> ''
    OR (
      COALESCE(${alias}.ocr_status, '') = 'completed'
      AND TRIM(COALESCE(${alias}.ocr_result_ref, '')) <> ''
    )
    OR (
      TRIM(COALESCE(${alias}.ocr_result, '')) <> ''
      AND TRIM(COALESCE(${alias}.ocr_result, '')) <> '{"externalized":true}'
      AND NOT (
        COALESCE(${alias}.ocr_result, '') LIKE '%"error"%'
        AND COALESCE(${alias}.ocr_result, '') LIKE '%"failed_at"%'
      )
    )
  )`
}

function buildDocumentOcrCompleteCondition(alias = 'd'): string {
  const pageCount = `COALESCE(${alias}.page_count, 0)`
  return `(
    ${pageCount} > 0
    AND (
      ${buildDocumentCompletedPageCountExpression(alias)} >= ${pageCount}
      OR ${buildDocumentTextPageCountExpression(alias)} >= ${pageCount}
    )
  )`
}

function buildDocumentListOrderBy(options?: ListDocumentOptions): string {
  const direction = getLibrarySortDirection(options)
  const titleExpression = "LOWER(COALESCE(NULLIF(TRIM(d.title), ''), NULLIF(TRIM(d.file_path), ''), d.id))"
  const publicationYearExpression = `CAST(COALESCE(
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publication_year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publish_year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('date')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('issue_date')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publication_time')}), '')
  ) AS INTEGER)`
  const stableFallback = `${titleExpression} ASC, d.id ASC`

  switch (options?.sortKey) {
    case 'title':
      return `${titleExpression} ${direction}, d.id ASC`
    case 'createdAt':
      return `${buildMissingLastOrder('d.created_at', direction)}, ${stableFallback}`
    case 'updatedAt':
      return `${buildMissingLastOrder('d.updated_at', direction)}, ${stableFallback}`
    case 'publicationYear':
      return `${buildMissingLastOrder(publicationYearExpression, direction)}, ${stableFallback}`
    case 'lastOpened':
      return `${buildMissingLastOrder('d.last_opened_at', direction)}, ${stableFallback}`
    case 'pageCount':
      return `${buildMissingLastOrder('d.page_count', direction)}, ${stableFallback}`
    case 'default':
    default:
      return 'd.is_favorite DESC, d.favorite_at DESC, d.updated_at DESC'
  }
}

const LIBRARY_SEARCH_FIELDS: LibraryDocumentSearchField[] = ['title', 'author', 'folder', 'tag']

function getLibrarySearchFields(options?: ListDocumentOptions): LibraryDocumentSearchField[] {
  const requestedFields = Array.isArray(options?.searchFields) ? options.searchFields : LIBRARY_SEARCH_FIELDS
  const allowed = new Set<LibraryDocumentSearchField>(LIBRARY_SEARCH_FIELDS)
  const fields = requestedFields.filter((field): field is LibraryDocumentSearchField => allowed.has(field as LibraryDocumentSearchField))
  return fields.length > 0 ? [...new Set(fields)] : LIBRARY_SEARCH_FIELDS
}

function buildDocumentListQuery(options?: ListDocumentOptions, forCount = false): { sql: string; params: unknown[] } {
  const requestedFolderIds = [
    ...(options?.folderId ? [options.folderId] : []),
    ...(Array.isArray(options?.folderIds) ? options.folderIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean)
  const scopedFolderIds = resolveFolderAndDescendantIds(requestedFolderIds)
  // Intentionally avoid full-table joins on pages/research_notes here.
  // Page stats are attached only for the limited result page (see attachPageStatsForDocuments).
  let sql = forCount
    ? 'SELECT COUNT(DISTINCT d.id) as total FROM documents d'
    : `SELECT
        d.*,
        0 as actual_page_count,
        0 as text_page_count,
        0 as ocr_completed_page_count,
        0 as image_page_count,
        0 as research_note_count,
        0 as search_segment_count
      FROM documents d`

  const params: unknown[] = []
  const conditions: string[] = []

  if (requestedFolderIds.length > 0 && scopedFolderIds.length === 0) {
    conditions.push('1 = 0')
  } else if (scopedFolderIds.length > 0) {
    sql += ' INNER JOIN document_folders df_scope ON d.id = df_scope.doc_id'
    conditions.push(`df_scope.folder_id IN (${scopedFolderIds.map(() => '?').join(', ')})`)
    params.push(...scopedFolderIds)
  }
  if (options?.unfiledOnly) {
    conditions.push('NOT EXISTS (SELECT 1 FROM document_folders df_unfiled WHERE df_unfiled.doc_id = d.id)')
  }

  if (options?.tagId) {
    sql += ' INNER JOIN document_tags dt_filter ON d.id = dt_filter.doc_id'
    conditions.push('dt_filter.tag_id = ?')
    params.push(options.tagId)
  }

  if (Array.isArray(options?.tagIds) && options.tagIds.length > 0) {
    sql += ' INNER JOIN document_tags dt_filter_multi ON d.id = dt_filter_multi.doc_id'
    conditions.push(`dt_filter_multi.tag_id IN (${options.tagIds.map(() => '?').join(', ')})`)
    params.push(...options.tagIds)
  }

  if (options?.docType) {
    conditions.push('d.doc_type = ?')
    params.push(options.docType)
  }
  if (options?.ocrIncomplete) {
    // Document-level status is maintained by OCR completion paths and is far cheaper
    // than correlated page-content scans across the whole library.
    conditions.push(`COALESCE(d.ocr_status, '') <> 'completed'`)
  } else if (options?.ocrStatus) {
    conditions.push('d.ocr_status = ?')
    params.push(options.ocrStatus)
  }
  if (options?.importStatus) {
    conditions.push('d.import_status = ?')
    params.push(options.importStatus)
  } else {
    conditions.push("COALESCE(d.import_status, '') <> 'deleting'")
  }
  if (options?.readStatus) {
    conditions.push('d.read_status = ?')
    params.push(options.readStatus)
  }
  if (options?.metadataStatus) {
    conditions.push('d.metadata_status = ?')
    params.push(options.metadataStatus)
  }
  if (options?.proofStatus) {
    if (options.proofStatus === 'completed') {
      conditions.push('d.proof_status = ?')
      params.push('completed')
    } else if (options.proofStatus === 'pending') {
      conditions.push("COALESCE(d.proof_status, 'pending') <> ?")
      params.push('completed')
    }
  }
  if (options?.metadataPending) {
    conditions.push("d.metadata_status IN ('pending', 'review')")
  }
  if (options?.favoritesOnly) {
    conditions.push('d.is_favorite = 1')
  }
  const embeddingFilter = options?.embeddingFilter
    || (options?.embeddingReady ? 'ready' as const : undefined)
  if (embeddingFilter === 'ready') {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM embedding_index_status eis
        WHERE eis.doc_id = d.id AND eis.status = 'ready'
      )`,
    )
  } else if (embeddingFilter === 'not_ready') {
    // No successful vector index (never embedded, pending, queued, processing, or error).
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM embedding_index_status eis
        WHERE eis.doc_id = d.id AND eis.status = 'ready'
      )`,
    )
  } else if (embeddingFilter === 'queued') {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM embedding_index_status eis
        WHERE eis.doc_id = d.id AND eis.status = 'queued'
      )`,
    )
  } else if (embeddingFilter === 'processing') {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM embedding_index_status eis
        WHERE eis.doc_id = d.id AND eis.status = 'processing'
      )`,
    )
  } else if (embeddingFilter === 'error') {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM embedding_index_status eis
        WHERE eis.doc_id = d.id AND eis.status = 'error'
      )`,
    )
  }
  if (options?.healthFilter) {
    const authorExpression = `(
      TRIM(COALESCE(d.author, '')) = ''
      AND ${buildMissingMetadataCondition(['author', 'authors', 'creator', 'editor', 'translator'])}
    )`
    const yearExpression = `(
      ${buildMissingMetadataCondition(['publication_year', 'year', 'publish_year', 'date', 'issue_date', 'publication_time'])}
    )`
    const identifierExpression = `(
      ${buildMissingMetadataCondition(['doi', 'DOI', 'isbn', 'ISBN', 'issn', 'identifier'])}
    )`
    const publisherExpression = `(
      ${buildMissingMetadataCondition(['publisher', 'press', 'publisher_name'])}
    )`
    const sourceExpression = `(
      TRIM(COALESCE(d.source, '')) = ''
      AND ${buildMissingMetadataCondition(['source', 'journal', 'newspaper', 'book_title', 'collection', 'series', 'container_title'])}
    )`
    const suspiciousTitleExpression = `(TRIM(COALESCE(d.title, '')) = '' OR LOWER(TRIM(d.title)) GLOB 'pdf合并*' OR LOWER(TRIM(d.title)) GLOB '扫描*' OR LOWER(TRIM(d.title)) GLOB '未命名*' OR LOWER(TRIM(d.title)) GLOB 'document*' OR LOWER(TRIM(d.title)) GLOB 'scan*' OR LOWER(TRIM(d.title)) GLOB 'image*' OR LOWER(TRIM(d.title)) GLOB 'new document*')`
    const unknownTypeExpression = `(TRIM(COALESCE(d.doc_type, '')) = '' OR d.doc_type IN ('unknown', '其他'))`

    if (options.healthFilter === 'healthMissingMetadata') {
      conditions.push(`(${authorExpression} OR ${yearExpression} OR ${identifierExpression} OR ${publisherExpression} OR ${sourceExpression})`)
    } else if (options.healthFilter === 'healthSuspiciousTitle') {
      conditions.push(suspiciousTitleExpression)
    } else if (options.healthFilter === 'healthUnknownType') {
      conditions.push(unknownTypeExpression)
    } else if (options.healthFilter === 'healthTitleCleanup') {
      conditions.push(`(${suspiciousTitleExpression} OR ${unknownTypeExpression})`)
    }
  }
  if (options?.author?.trim()) {
    conditions.push('COALESCE(d.author, \'\') LIKE ?')
    params.push(`%${options.author.trim()}%`)
  }
  if (options?.yearFrom) {
    conditions.push(`CAST(${buildDocumentMetadataValueExpression('publication_year')} AS INTEGER) >= ?`)
    params.push(options.yearFrom)
  }
  if (options?.yearTo) {
    conditions.push(`CAST(${buildDocumentMetadataValueExpression('publication_year')} AS INTEGER) <= ?`)
    params.push(options.yearTo)
  }
  if (options?.search?.trim()) {
    const search = options.search.trim()
    const normalizedSearch = normalizeChineseSearchText(search)
    const searchFields = new Set(getLibrarySearchFields(options))
    const searchClauses: string[] = []
    const searchParams: unknown[] = []

    if (searchFields.has('title')) {
      searchClauses.push("COALESCE(d.title, '') LIKE ?")
      searchParams.push(`%${search}%`)
      searchClauses.push("(TRIM(COALESCE(d.title, '')) <> '' AND ? LIKE '%' || COALESCE(d.title, '') || '%')")
      searchParams.push(normalizedSearch)
    }
    if (searchFields.has('author')) {
      searchClauses.push("COALESCE(d.author, '') LIKE ?")
      searchParams.push(`%${search}%`)
      searchClauses.push("(TRIM(COALESCE(d.author, '')) <> '' AND ? LIKE '%' || COALESCE(d.author, '') || '%')")
      searchParams.push(normalizedSearch)
    }
    if (searchFields.has('tag')) {
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM document_tags dt_search
        INNER JOIN tags t_search ON dt_search.tag_id = t_search.id
        WHERE dt_search.doc_id = d.id AND COALESCE(t_search.name, '') LIKE ?
      )`)
      searchParams.push(`%${search}%`)
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM document_tags dt_search_reverse
        INNER JOIN tags t_search_reverse ON dt_search_reverse.tag_id = t_search_reverse.id
        WHERE dt_search_reverse.doc_id = d.id
          AND TRIM(COALESCE(t_search_reverse.name, '')) <> ''
          AND ? LIKE '%' || COALESCE(t_search_reverse.name, '') || '%'
      )`)
      searchParams.push(normalizedSearch)
    }
    if (searchFields.has('folder')) {
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM document_folders df_search
        INNER JOIN folders f_search ON df_search.folder_id = f_search.id
        WHERE df_search.doc_id = d.id AND COALESCE(f_search.name, '') LIKE ?
      )`)
      searchParams.push(`%${search}%`)
      searchClauses.push(`EXISTS (
        SELECT 1
        FROM document_folders df_search_reverse
        INNER JOIN folders f_search_reverse ON df_search_reverse.folder_id = f_search_reverse.id
        WHERE df_search_reverse.doc_id = d.id
          AND TRIM(COALESCE(f_search_reverse.name, '')) <> ''
          AND ? LIKE '%' || COALESCE(f_search_reverse.name, '') || '%'
      )`)
      searchParams.push(normalizedSearch)
    }

    conditions.push(`(${searchClauses.join('\n      OR ')})`)
    params.push(...searchParams)
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
  }

  if (forCount) {
    return { sql, params }
  }

  // GROUP BY is only needed when joins can multiply rows (tags/folders).
  const needsGroupBy = Boolean(
    options?.tagId
    || (Array.isArray(options?.tagIds) && options.tagIds.length > 0)
    || (scopedFolderIds.length > 0),
  )
  if (needsGroupBy) {
    sql += ' GROUP BY d.id'
  }
  sql += ` ORDER BY ${buildDocumentListOrderBy(options)}`
  sql += ' LIMIT ? OFFSET ?'
  // Cap unbounded listDocuments callers (e.g. legacy dashboard) so large libraries
  // cannot pull tens of thousands of rows + page-stat joins on the main thread.
  const requestedLimit = Math.round(Number(options?.limit || 1000))
  const safeListLimit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 2000))
  const safeListOffset = Math.max(0, Math.round(Number(options?.offset || 0)) || 0)
  params.push(safeListLimit, safeListOffset)

  return { sql, params }
}

function getStructuredOcrBlockText(block: unknown): string {
  if (!isJsonRecord(block)) return textValue(block)
  const direct = textValue(block.words)
    || textValue(block.word)
    || textValue(block.text)
    || textValue(block.block_content)
    || textValue(block.content)
    || textValue(block.markdown)
    || textValue(block.md)
  if (direct) return direct
  const rows = Array.isArray(block.rows) ? block.rows : Array.isArray(getPathValue(block, ['table', 'rows'])) ? getPathValue(block, ['table', 'rows']) : []
  if (Array.isArray(rows)) {
    const rowText = rows.map((row) => Array.isArray(row) ? row.map(textValue).filter(Boolean).join('\t') : textValue(row)).filter(Boolean).join('\n')
    if (rowText) return rowText
  }
  const cells = Array.isArray(block.cells) ? block.cells : Array.isArray(getPathValue(block, ['table', 'cells'])) ? getPathValue(block, ['table', 'cells']) : []
  if (Array.isArray(cells)) {
    return cells.map((cell) => isJsonRecord(cell) ? textValue(cell.text ?? cell.words ?? cell.value) : textValue(cell)).filter(Boolean).join('\n')
  }
  return ''
}

function hasStructuredOcrText(parsed: unknown): boolean {
  if (!isJsonRecord(parsed)) return false
  const direct = textValue(parsed.text) || textValue(parsed.ocr_text) || textValue(parsed.proofed_text)
  if (direct) return true
  const blockSources = [
    parsed.layout_result,
    parsed.layout_blocks,
    parsed.words_result,
    parsed.parsing_res_list,
    getPathValue(parsed, ['prunedResult', 'parsing_res_list']),
    getPathValue(parsed, ['res', 'prunedResult', 'parsing_res_list']),
    getPathValue(parsed, ['layout_det_res', 'boxes']),
    getPathValue(parsed, ['res', 'layout_det_res', 'boxes']),
  ]
  return blockSources.some((source) => Array.isArray(source) && source.some((block) => getStructuredOcrBlockText(block).trim().length > 0))
}

function parsePageOcrMeta(page: PageOcrMetaRow): { has_ocr_text: boolean; needs_layout_attention: boolean } {
  const hasInlineText = String(page.proofed_text || page.ocr_text || '').trim().length > 0
  if (!page.ocr_result) {
    return { has_ocr_text: hasInlineText, needs_layout_attention: false }
  }
  // Fast path: when plain text is already available, skip expensive full OCR JSON
  // quality inspection for reading windows. Layout attention is a soft UI hint only.
  if (hasInlineText) {
    return { has_ocr_text: true, needs_layout_attention: false }
  }

  try {
    const parsed = typeof page.ocr_result === 'string' ? JSON.parse(page.ocr_result) : page.ocr_result
    const blocks = isJsonRecord(parsed) && Array.isArray(parsed.layout_result) ? parsed.layout_result : []
    const ir = getOcrPageIr(parsed)
    const hasText = hasStructuredOcrText(parsed)
    return {
      has_ocr_text: hasText,
      needs_layout_attention: blocks.some((block) => isJsonRecord(block) && !!block.needs_enhancement)
        || Boolean(ir && (
          ir.page.quality.score < 0.65
          || ir.page.quality.issues.some((issue) => issue.severity === 'error' || issue.severity === 'warning')
        )),
    }
  } catch {
    return { has_ocr_text: hasInlineText, needs_layout_attention: false }
  }
}

function repairStoredGujiOcrPageForRead(page: DocumentPage): boolean {
  if (!page.image_path || !page.ocr_result) return false
  const parsed = parseJsonRecord(page.ocr_result)
  if (!parsed) return false
  const repaired = normalizeStoredGujiOcrResultForRead(parsed, page.image_path, Number(page.page_num || 0) || 1)
  if (!repaired) return false
  const before = JSON.stringify(parsed)
  const after = JSON.stringify(repaired)
  if (before === after) return false
  page.ocr_result = after
  const prepared = preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', after)
  run(
    'UPDATE pages SET ocr_result = ?, ocr_result_ref = ? WHERE id = ?',
    [prepared.value, prepared.ref, page.id],
  )
  run(
    `UPDATE page_ocr_versions
     SET ocr_result = ?, ocr_result_ref = ?, updated_at = ?
     WHERE page_id = ? AND is_active = 1`,
    [prepared.value, prepared.ref, new Date().toISOString(), page.id],
  )
  return true
}

// Avoid re-running coordinate repair + JSON rewrite on every reading-window scroll.
const repairedGujiOcrPageIds = new Set<string>()
const REPAIRED_GUJI_OCR_PAGE_IDS_MAX = 4000

function rememberRepairedGujiOcrPage(pageId: string): void {
  if (!pageId) return
  repairedGujiOcrPageIds.add(pageId)
  if (repairedGujiOcrPageIds.size <= REPAIRED_GUJI_OCR_PAGE_IDS_MAX) return
  const overflow = repairedGujiOcrPageIds.size - REPAIRED_GUJI_OCR_PAGE_IDS_MAX
  let removed = 0
  for (const id of repairedGujiOcrPageIds) {
    repairedGujiOcrPageIds.delete(id)
    removed += 1
    if (removed >= overflow) break
  }
}

function repairStoredGujiOcrPagesForRead(pages: DocumentPage[]): void {
  let repairedCount = 0
  for (const page of pages) {
    const pageId = String(page.id || '')
    if (pageId && repairedGujiOcrPageIds.has(pageId)) {
      Object.assign(page, parsePageOcrMeta(page))
      continue
    }
    if (repairStoredGujiOcrPageForRead(page)) {
      repairedCount += 1
      rememberRepairedGujiOcrPage(pageId)
    } else if (pageId) {
      // Even when no rewrite is needed, remember so we skip the stringify compare next time.
      rememberRepairedGujiOcrPage(pageId)
    }
    Object.assign(page, parsePageOcrMeta(page))
  }
  if (repairedCount > 0) {
    scheduleDatabaseSave()
  }
}

function parseDocumentMetadata(raw: unknown): JsonRecord {
  if (!raw) return {}
  if (isJsonRecord(raw)) return raw
  try {
    const parsed = JSON.parse(String(raw))
    return isJsonRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

type VerifiedPdfAssetState = 'available' | 'text_only' | 'unknown'
type VerifiedPdfAssetCacheEntry = {
  createdAt: number
  signature: string
  state: VerifiedPdfAssetState
  imagePageCount: number
  metadata: string
}

const VERIFIED_PDF_ASSET_CACHE_TTL_MS = 10_000
const VERIFIED_PDF_ASSET_CACHE_MAX_ENTRIES = 500
const verifiedPdfAssetInfoCache = new Map<string, VerifiedPdfAssetCacheEntry>()

function pruneVerifiedPdfAssetInfoCache(now = Date.now()): void {
  for (const [key, entry] of verifiedPdfAssetInfoCache.entries()) {
    if (now - entry.createdAt >= VERIFIED_PDF_ASSET_CACHE_TTL_MS) {
      verifiedPdfAssetInfoCache.delete(key)
    }
  }
  if (verifiedPdfAssetInfoCache.size <= VERIFIED_PDF_ASSET_CACHE_MAX_ENTRIES) return
  const overflow = verifiedPdfAssetInfoCache.size - VERIFIED_PDF_ASSET_CACHE_MAX_ENTRIES
  ;[...verifiedPdfAssetInfoCache.entries()]
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(0, overflow)
    .forEach(([key]) => verifiedPdfAssetInfoCache.delete(key))
}

function isReadableLocalAssetPath(filePath: unknown): boolean {
  const normalized = String(filePath || '').trim()
  if (!normalized || /^(?:https?|data):/i.test(normalized)) return false
  try {
    if (!existsSync(normalized)) return false
    const fileStat = statSync(normalized)
    return fileStat.isFile() && fileStat.size > 0
  } catch {
    return false
  }
}

function isReadableSourcePdf(doc: Pick<Document, 'id' | 'file_path'>): boolean {
  const filePath = resolveManagedStoragePath(String(doc.file_path || '').trim(), doc.id)
  return extname(filePath).toLowerCase() === '.pdf' && isReadableLocalAssetPath(filePath)
}

function hasReadablePageImageForDocument(docId: string, imagePageCount: number): boolean {
  if (imagePageCount <= 0) return false
  const rows = queryAll<{ image_path: string | null }>(
    `SELECT image_path
     FROM pages
     WHERE doc_id = ?
       AND image_path IS NOT NULL
       AND TRIM(image_path) <> ''
     ORDER BY page_num ASC
     LIMIT 24`,
    [docId],
  )
  return rows.some((row) => isReadableLocalAssetPath(resolveManagedStoragePath(row.image_path, docId)))
}

function getVerifiedPdfAssetInfo(
  doc: Pick<Document, 'id' | 'file_path'> & { metadata?: string | null; image_page_count?: number | null; ocr_status?: string | null },
  metadata = parseDocumentMetadata(doc.metadata),
): { state: VerifiedPdfAssetState; imagePageCount: number; metadata: string } {
  const rawImagePageCount = Number(doc.image_page_count || 0)
  const cacheKey = String(doc.id || '')
  const signature = JSON.stringify({
    filePath: resolveManagedStoragePath(String(doc.file_path || '').trim(), doc.id),
    imagePageCount: rawImagePageCount,
    metadata: doc.metadata || '',
  })
  const cached = cacheKey ? verifiedPdfAssetInfoCache.get(cacheKey) : null
  const now = Date.now()
  if (cached && cached.signature === signature && now - cached.createdAt < VERIFIED_PDF_ASSET_CACHE_TTL_MS) {
    return {
      state: cached.state,
      imagePageCount: cached.imagePageCount,
      metadata: cached.metadata,
    }
  }

  const hasReadableImage = hasReadablePageImageForDocument(String(doc.id), rawImagePageCount)
  const explicitState = String(metadata.pdf_asset_state || '').trim()
  const hasPdfFingerprint = !!(metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count || metadata.pdf_stored_size_bytes)
  let state: VerifiedPdfAssetState = 'unknown'

  if (isReadableSourcePdf(doc) || hasReadableImage) {
    state = 'available'
  } else if (explicitState === 'text_only' || explicitState === 'available' || hasPdfFingerprint || rawImagePageCount > 0) {
    state = 'text_only'
  }

  const verified = {
    state,
    imagePageCount: state === 'available' && hasReadableImage ? rawImagePageCount : 0,
    metadata: JSON.stringify({ ...metadata, pdf_asset_state: state }),
  }
  if (cacheKey) {
    verifiedPdfAssetInfoCache.set(cacheKey, {
      createdAt: now,
      signature,
      ...verified,
    })
    pruneVerifiedPdfAssetInfoCache(now)
  }
  return verified
}

function normalizeDocumentSourceAssetsForRead<T extends { image_path?: string | null }>(
  doc: Pick<Document, 'id' | 'file_path'> & { metadata?: string | null; ocr_status?: string | null },
  pages: T[],
): void {
  let readableImagePageCount = 0
  for (const page of pages) {
    if (!page.image_path) continue
    const relocatedImagePath = resolveManagedStoragePath(page.image_path, doc.id)
    if (isReadableLocalAssetPath(relocatedImagePath)) {
      page.image_path = relocatedImagePath
      readableImagePageCount += 1
    } else {
      page.image_path = null
    }
  }
  const metadata = parseDocumentMetadata(doc.metadata)
  const hasPdfFingerprint = !!(metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count || metadata.pdf_stored_size_bytes)
  const explicitState = String(metadata.pdf_asset_state || '').trim()
  const state: VerifiedPdfAssetState = isReadableSourcePdf(doc) || readableImagePageCount > 0
    ? 'available'
    : explicitState === 'available' || explicitState === 'text_only' || hasPdfFingerprint
      ? 'text_only'
      : 'unknown'
  doc.metadata = JSON.stringify({ ...metadata, pdf_asset_state: state })
}

interface DocumentListPageStatsRow {
  doc_id: string
  actual_page_count?: number | null
  text_page_count?: number | null
  ocr_completed_page_count?: number | null
  image_page_count?: number | null
  research_note_count?: number | null
}

function attachPageStatsForDocuments(documents: DocumentListItem[]): DocumentListItem[] {
  if (documents.length === 0) return documents
  const docIds = documents.map((doc) => doc.id).filter(Boolean)
  if (docIds.length === 0) return documents
  const placeholders = docIds.map(() => '?').join(', ')

  // List/first-paint must stay index/status-only.
  // Never TRIM/read proofed_text/ocr_text/ocr_result bodies here: on large libraries that
  // forces multi-ten-second (or multi-minute under AV) main-thread freezes right after open,
  // after startup recovery already finished quickly.
  const pageRows = queryAll<DocumentListPageStatsRow>(
    `SELECT
       p.doc_id,
       COUNT(*) as actual_page_count,
       SUM(
         CASE
           WHEN COALESCE(p.ocr_status, '') = 'completed' THEN 1
           WHEN COALESCE(p.proofed_text_ref, '') <> '' THEN 1
           WHEN COALESCE(p.ocr_text_ref, '') <> '' THEN 1
           WHEN COALESCE(p.ocr_result_ref, '') <> '' THEN 1
           ELSE 0
         END
       ) as text_page_count,
       SUM(CASE WHEN COALESCE(p.ocr_status, '') = 'completed' THEN 1 ELSE 0 END) as ocr_completed_page_count,
       SUM(CASE WHEN p.image_path IS NOT NULL AND p.image_path <> '' THEN 1 ELSE 0 END) as image_page_count
     FROM pages p
     WHERE p.doc_id IN (${placeholders})
     GROUP BY p.doc_id`,
    docIds,
  )
  const noteRows = queryAll<DocumentListPageStatsRow>(
    `SELECT rn.doc_id, COUNT(*) as research_note_count
     FROM research_notes rn
     WHERE rn.doc_id IN (${placeholders})
     GROUP BY rn.doc_id`,
    docIds,
  )
  const embeddingStatusRows = queryAll<{ doc_id: string; status?: string | null }>(
    `SELECT doc_id, status FROM embedding_index_status WHERE doc_id IN (${placeholders})`,
    docIds,
  )
  const embeddingChunkRows = queryAll<{ doc_id: string; c?: number | null }>(
    `SELECT doc_id, COUNT(*) as c FROM embedding_chunks WHERE doc_id IN (${placeholders}) GROUP BY doc_id`,
    docIds,
  )

  const pageStatsByDoc = new Map(pageRows.map((row) => [row.doc_id, row]))
  const noteStatsByDoc = new Map(noteRows.map((row) => [row.doc_id, Number(row.research_note_count || 0)]))
  const embeddingStatusByDoc = new Map(
    embeddingStatusRows.map((row) => [row.doc_id, String(row.status || '').trim() || 'none']),
  )
  const embeddingChunkByDoc = new Map(
    embeddingChunkRows.map((row) => [row.doc_id, Number(row.c || 0)]),
  )

  return documents.map((doc) => {
    const stats = pageStatsByDoc.get(doc.id)
    const embeddingStatus = embeddingStatusByDoc.get(doc.id) || 'none'
    const embeddingChunks = embeddingChunkByDoc.get(doc.id) || 0
    return {
      ...doc,
      actual_page_count: Number(stats?.actual_page_count || 0),
      text_page_count: Number(stats?.text_page_count || 0),
      ocr_completed_page_count: Number(stats?.ocr_completed_page_count || 0),
      image_page_count: Number(stats?.image_page_count || 0),
      research_note_count: noteStatsByDoc.get(doc.id) || 0,
      search_segment_count: 0,
      embedding_status: embeddingStatus,
      embedding_chunk_count: embeddingChunks,
    }
  })
}

function resolveListPdfAssetInfo(
  doc: Pick<Document, 'id' | 'file_path'> & {
    metadata?: string | null
    image_page_count?: number | null
    ocr_status?: string | null
  },
): { state: VerifiedPdfAssetState; imagePageCount: number; metadata: string } {
  const metadata = parseDocumentMetadata(doc.metadata)
  const imagePageCount = Math.max(0, Number(doc.image_page_count || 0))
  const explicitState = String(metadata.pdf_asset_state || '').trim()
  const hasPdfFingerprint = !!(metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count || metadata.pdf_stored_size_bytes)
  const filePath = resolveManagedStoragePath(String(doc.file_path || '').trim(), doc.id)
  const looksLikePdf = extname(filePath).toLowerCase() === '.pdf'

  // List views must stay cheap: trust document metadata + page image counts.
  // Filesystem probes are deferred to open/detail paths.
  let state: VerifiedPdfAssetState = 'unknown'
  if (looksLikePdf || imagePageCount > 0) {
    state = 'available'
  } else if (explicitState === 'text_only' || explicitState === 'available' || hasPdfFingerprint) {
    state = explicitState === 'available' ? 'available' : 'text_only'
  } else if (explicitState === 'unknown' || !explicitState) {
    state = 'unknown'
  } else {
    state = 'text_only'
  }

  return {
    state,
    imagePageCount: state === 'available' ? imagePageCount : 0,
    metadata: JSON.stringify({ ...metadata, pdf_asset_state: state }),
  }
}

function attachDocumentRelations(documents: DocumentListItem[]): DocumentListItem[] {
  if (documents.length === 0) return documents
  const documentsWithStats = attachPageStatsForDocuments(documents)
  const docIds = documentsWithStats.map((doc) => doc.id).filter(Boolean)
  const placeholders = docIds.map(() => '?').join(', ')

  const tagRows = queryAll<DocumentTagRelationRow>(
    `SELECT dt.doc_id, t.id, t.name, COALESCE(t.color, '') as color, COALESCE(t.source, '') as source
     FROM document_tags dt
     INNER JOIN tags t ON dt.tag_id = t.id
     WHERE dt.doc_id IN (${placeholders})
     ORDER BY t.usage_count DESC, t.name ASC`,
    docIds
  )
  const folderRows = queryAll<DocumentFolderRelationRow>(
    `SELECT df.doc_id, f.id, f.name
     FROM document_folders df
     INNER JOIN folders f ON df.folder_id = f.id
     WHERE df.doc_id IN (${placeholders})
     ORDER BY f.sort_order ASC, f.name ASC`,
    docIds
  )

  const tagsByDoc = new Map<string, DocumentTagRelationRow[]>()
  const foldersByDoc = new Map<string, DocumentFolderRelationRow[]>()
  tagRows.forEach((row) => {
    const rows = tagsByDoc.get(row.doc_id) || []
    rows.push(row)
    tagsByDoc.set(row.doc_id, rows)
  })
  folderRows.forEach((row) => {
    const rows = foldersByDoc.get(row.doc_id) || []
    rows.push(row)
    foldersByDoc.set(row.doc_id, rows)
  })

  const normalizedDocuments = normalizeCompletedOcrDocuments(documentsWithStats)

  return normalizedDocuments.map((doc) => {
    const tags = tagsByDoc.get(doc.id) || []
    const folders = foldersByDoc.get(doc.id) || []
    const actualPageCount = Number(doc.actual_page_count || 0)
    const storedPageCount = Number(doc.page_count || 0)
    const relocatedFilePath = doc.file_path ? resolveManagedStoragePath(doc.file_path, doc.id) : doc.file_path
    const relocatedThumbPath = doc.thumb_path ? resolveManagedStoragePath(doc.thumb_path, doc.id) : doc.thumb_path
    const pdfAssetInfo = resolveListPdfAssetInfo(doc)
    return {
      ...doc,
      file_path: relocatedFilePath,
      thumb_path: relocatedThumbPath,
      page_count: Math.max(storedPageCount, actualPageCount),
      actual_page_count: actualPageCount,
      image_page_count: pdfAssetInfo.imagePageCount,
      pdf_asset_state: pdfAssetInfo.state,
      metadata: pdfAssetInfo.metadata,
      tag_names: tags.map((tag) => tag.name).join('|'),
      tag_colors: tags.map((tag) => tag.color || '').join('|'),
      tag_ids: tags.map((tag) => tag.id).join('|'),
      tag_sources: tags.map((tag) => tag.source || '').join('|'),
      folder_ids: folders.map((folder) => folder.id).join('|'),
      folder_names: folders.map((folder) => folder.name).join('|'),
    }
  })
}

/** Shared by IPC and headless MCP/agent tools. */
export function listDocumentsPage(options?: ListDocumentOptions): DocumentListPage {
  return listDocumentPage(options)
}

function listDocumentPage(options?: ListDocumentOptions): DocumentListPage {
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 10))))
  const safeOffset = Math.max(0, Math.round(Number(options?.offset || 0)))
  const normalizedOptions = { ...options, limit: safeLimit, offset: safeOffset }
  const startedAt = Date.now()
  try {
    const { sql, params } = buildDocumentListQuery(normalizedOptions)
    const countQuery = buildDocumentListQuery(normalizedOptions, true)
    const rawItems = queryAll<DocumentListItem>(sql, params)
    const items = attachDocumentRelations(rawItems)
    const totalRow = queryOne<{ total: number }>(countQuery.sql, countQuery.params)
    return {
      items,
      total: Number(totalRow?.total || 0),
      limit: safeLimit,
      offset: safeOffset,
    }
  } catch (error) {
    console.error('[Documents] listPage failed', {
      options: normalizedOptions,
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error, String(error)),
    })
    throw error
  }
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasValue)
  if (typeof value === 'number') return Number.isFinite(value)
  return String(value ?? '').trim().length > 0
}

function firstMetadataValue(metadata: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (hasValue(metadata[key])) return metadata[key]
  }
  return null
}

function getPdfSizeBytes(doc: DocumentHealthSourceRow, metadata: JsonRecord): number {
  const metadataSize = Number(
    metadata.pdf_stored_size_bytes
      || metadata.file_size_bytes
      || metadata.pdf_compressed_size_bytes
      || metadata.pdf_size_bytes
      || 0,
  )
  if (Number.isFinite(metadataSize) && metadataSize > 0) return metadataSize

  const filePath = resolveManagedStoragePath(typeof doc.file_path === 'string' ? doc.file_path : '', doc.id)
  if (filePath && extname(filePath).toLowerCase() === '.pdf' && existsSync(filePath)) {
    try {
      return statSync(filePath).size
    } catch {
      return 0
    }
  }
  return 0
}

function getHealthPdfAssetState(doc: DocumentHealthSourceRow, metadata: JsonRecord): string {
  const imagePageCount = Number(doc.image_page_count || 0)
  if (isReadableSourcePdf(doc) || imagePageCount > 0) return 'available'
  const explicitState = String(metadata.pdf_asset_state || '').trim()
  if (explicitState === 'text_only' || explicitState === 'available') return 'text_only'
  if (metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count) return 'text_only'
  return 'unknown'
}

function addHealthIssue(
  issues: DocumentHealthIssue[],
  type: DocumentHealthIssueType,
  severity: DocumentHealthIssue['severity'],
  label: string,
  detail: string,
): void {
  issues.push({ type, severity, label, detail })
}

function buildDocumentHealthRow(doc: DocumentHealthSourceRow): DocumentHealthRow {
  const metadata = parseDocumentMetadata(doc.metadata)
  const actualPageCount = Number(doc.actual_page_count || 0)
  const pageCount = Math.max(Number(doc.page_count || 0), actualPageCount)
  const textPageCount = Number(doc.text_page_count || 0)
  const completedPageCount = Number(doc.ocr_completed_page_count || 0)
  const pdfAssetInfo = getVerifiedPdfAssetInfo(doc, metadata)
  const imagePageCount = pdfAssetInfo.imagePageCount
  const researchNoteCount = Number(doc.research_note_count || 0)
  const searchSegmentCount = Number(doc.search_segment_count || 0)
  const pdfSizeBytes = getPdfSizeBytes(doc, metadata)
  const pdfAssetState = getHealthPdfAssetState({ ...doc, image_page_count: imagePageCount }, metadata)
  const ocrStatus = pageCount > 0 && (completedPageCount >= pageCount || textPageCount >= pageCount)
    ? 'completed'
    : String(doc.ocr_status || 'pending')
  const issues: DocumentHealthIssue[] = []

  if (!hasValue(doc.author) && !hasValue(firstMetadataValue(metadata, ['author', 'authors', 'creator', 'editor', 'translator']))) {
    addHealthIssue(issues, 'missing_author', 'medium', '缺作者', '引用导出和 AI 综述会缺少责任者字段。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['publication_year', 'year', 'publish_year', 'date', 'issue_date', 'publication_time']))) {
    addHealthIssue(issues, 'missing_year', 'medium', '缺年份', '按年代筛选、GB/T 7714 和 BibTeX 导出需要年份。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['doi', 'DOI', 'isbn', 'ISBN', 'issn', 'identifier']))) {
    addHealthIssue(issues, 'missing_identifier', 'low', '缺标识符', 'DOI/ISBN/ISSN 为空，后续去重和规范引用会更吃力。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['publisher', 'press', 'publisher_name']))) {
    addHealthIssue(issues, 'missing_publisher', 'low', '缺出版社', '图书、地方志或古籍类材料建议补出版社/出版机构。')
  }
  if (!hasValue(doc.source) && !hasValue(firstMetadataValue(metadata, ['source', 'journal', 'newspaper', 'book_title', 'collection', 'series', 'container_title']))) {
    addHealthIssue(issues, 'missing_source', 'medium', '缺来源', '期刊论文、章节和档案材料导出引用时会缺出处。')
  }

  const title = String(doc.title || '').trim()
  if (!title || /^(pdf合并|扫描|未命名|document|scan|image|new document)/i.test(title)) {
    addHealthIssue(issues, 'suspicious_title', 'medium', '题名疑似导入名', '建议从封面、目录或元数据推断真实题名。')
  }
  if (pageCount <= 0) {
    addHealthIssue(issues, 'zero_page', 'high', '零页', '文献页数为 0，通常是导入或 OCR 初始化失败留下的空记录。')
  }

  const docType = String(doc.doc_type || '').trim()
  if (!docType || docType === 'unknown' || docType === '其他') {
    addHealthIssue(issues, 'unknown_type', 'medium', '待分类', '文献类型会影响阅读器默认布局、引用模板和智能集合。')
  }

  const severityScore: Record<DocumentHealthIssue['severity'], number> = { high: 5, medium: 3, low: 1 }
  const riskScore = issues.reduce((sum, issue) => sum + severityScore[issue.severity], 0)

  return {
    id: String(doc.id),
    title: title || '未命名文献',
    author: doc.author || null,
    doc_type: docType || 'unknown',
    page_count: pageCount,
    file_path: doc.file_path || null,
    ocr_status: ocrStatus,
    proof_status: String(doc.proof_status || 'pending'),
    metadata_status: String(doc.metadata_status || 'pending'),
    read_status: String(doc.read_status || 'unread'),
    text_page_count: textPageCount,
    image_page_count: imagePageCount,
    research_note_count: researchNoteCount,
    search_segment_count: searchSegmentCount,
    pdf_size_bytes: pdfSizeBytes,
    pdf_asset_state: pdfAssetState,
    issues,
    risk_score: riskScore,
  }
}

function getDocumentHealthReport(): DocumentHealthReport {
  const docs = queryAll<DocumentHealthSourceRow>(
    `SELECT
      d.*,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id) as actual_page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND ${buildPageContentAvailableCondition('p')}) as text_page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND p.ocr_status = 'completed' AND ${buildPageContentAvailableCondition('p')}) as ocr_completed_page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND p.image_path IS NOT NULL AND TRIM(p.image_path) <> '') as image_page_count,
      (SELECT COUNT(*) FROM research_notes rn WHERE rn.doc_id = d.id) as research_note_count,
      (SELECT COUNT(*) FROM search_index_segments sis WHERE sis.doc_id = d.id) as search_segment_count
    FROM documents d`,
  )
  const rows = docs
    .map(buildDocumentHealthRow)
    .sort((left, right) => right.risk_score - left.risk_score || right.page_count - left.page_count || left.title.localeCompare(right.title, 'zh-Hans-CN'))
  const countIssue = (type: DocumentHealthIssueType) => rows.filter((row) => row.issues.some((issue) => issue.type === type)).length
  const pageStats = queryOne<{ total_pages: number; text_pages: number }>(
    `SELECT
      COUNT(*) as total_pages,
      SUM(CASE WHEN ${buildPageContentAvailableCondition('pages')} THEN 1 ELSE 0 END) as text_pages
    FROM pages`,
  )

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalDocuments: rows.length,
      totalPages: rows.reduce((sum, row) => sum + row.page_count, 0),
      pageRows: Number(pageStats?.total_pages || 0),
      textPages: Number(pageStats?.text_pages || 0),
      segments: Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM search_index_segments')?.count || 0),
      tags: Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM tags')?.count || 0),
      folders: Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM folders')?.count || 0),
      researchProjects: Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM research_projects')?.count || 0),
      researchNotes: Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM research_notes')?.count || 0),
      missingAuthor: countIssue('missing_author'),
      missingYear: countIssue('missing_year'),
      missingIdentifier: countIssue('missing_identifier'),
      missingPublisher: countIssue('missing_publisher'),
      missingSource: countIssue('missing_source'),
      suspiciousTitle: countIssue('suspicious_title'),
      unknownType: countIssue('unknown_type'),
      zeroPage: countIssue('zero_page'),
      incompleteOcr: rows.filter((row) => row.ocr_status !== 'completed' || row.page_count <= 0).length,
    },
    rows,
  }
}

function createEmptyDocumentHealthReport(): DocumentHealthReport {
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalDocuments: 0,
      totalPages: 0,
      pageRows: 0,
      textPages: 0,
      segments: 0,
      tags: 0,
      folders: 0,
      researchProjects: 0,
      researchNotes: 0,
      missingAuthor: 0,
      missingYear: 0,
      missingIdentifier: 0,
      missingPublisher: 0,
      missingSource: 0,
      suspiciousTitle: 0,
      unknownType: 0,
      zeroPage: 0,
      incompleteOcr: 0,
    },
    rows: [],
  }
}

let cachedDocumentHealthReport: DocumentHealthReport | null = null
let healthReportRefreshRunning = false
let healthReportRefreshPending = false

function emitHealthReportTaskStatus(payload: {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  errorMessage?: string
}): void {
  emitBackgroundTaskStatus({
    taskId: 'health-report',
    kind: 'health-report',
    ...payload,
  })
}

function isDocumentListOcrTextComplete(doc: Pick<DocumentListItem, 'page_count' | 'text_page_count' | 'ocr_completed_page_count'>): boolean {
  const pageCount = Number(doc.page_count || 0)
  if (pageCount <= 0) return false
  const completedPages = Number(doc.ocr_completed_page_count || 0)
  const textPages = Number(doc.text_page_count || 0)
  return completedPages >= pageCount || textPages >= pageCount
}

interface DocumentListOcrPageSummary {
  doc_id: string
  total: number
  completed: number
  failed: number
  pending: number
}

function getDocumentListOcrPageSummaries(docIds: string[]): Map<string, DocumentListOcrPageSummary> {
  const summaries = new Map<string, DocumentListOcrPageSummary>()
  runForIdChunks(uniqueDocumentIds(docIds), (chunkIds, placeholders) => {
    const rows = queryAll<DocumentListOcrPageSummary>(
      `SELECT
         doc_id,
         COUNT(*) as total,
         SUM(CASE WHEN ocr_status = 'completed' AND ${buildPageContentAvailableCondition('pages')} THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN ocr_status = 'error' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN ocr_status IS NULL OR ocr_status IN ('pending', 'queued', 'processing') OR (ocr_status = 'completed' AND NOT (${buildPageContentAvailableCondition('pages')})) THEN 1 ELSE 0 END) as pending
       FROM pages
       WHERE doc_id IN (${placeholders})
       GROUP BY doc_id`,
      chunkIds,
    )
    rows.forEach((row) => {
      summaries.set(row.doc_id, {
        doc_id: row.doc_id,
        total: Number(row.total || 0),
        completed: Number(row.completed || 0),
        failed: Number(row.failed || 0),
        pending: Number(row.pending || 0),
      })
    })
  })
  return summaries
}

function isDocumentListOcrSettledWithReviewPages(doc: DocumentListItem, summary?: DocumentListOcrPageSummary): boolean {
  if (!summary) return false
  const expectedPages = Math.max(Number(doc.page_count || 0), Number(doc.actual_page_count || 0), summary.total)
  return expectedPages > 0
    && summary.pending === 0
    && summary.failed > 0
    && summary.completed + summary.failed >= expectedPages
}

/** Compact page list for short review notices: 3、7-9、12 */
function formatDocumentListFailedPageNumberList(pageNums: Array<number | null | undefined>): string {
  const nums = [...new Set(
    pageNums
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value)),
  )].sort((left, right) => left - right)
  if (nums.length === 0) return ''
  const parts: string[] = []
  let rangeStart = nums[0]
  let rangeEnd = nums[0]
  for (let index = 1; index <= nums.length; index += 1) {
    const current = nums[index]
    if (current === rangeEnd + 1) {
      rangeEnd = current
      continue
    }
    parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`)
    rangeStart = current
    rangeEnd = current
  }
  return parts.join('、')
}

function listDocumentListOcrFailedPageNums(docId: string): number[] {
  const rows = queryAll<{ page_num: number | null }>(
    `SELECT page_num
     FROM pages
     WHERE doc_id = ? AND ocr_status = 'error'
     ORDER BY page_num`,
    [docId],
  )
  return rows
    .map((row) => Math.floor(Number(row.page_num || 0)))
    .filter((value) => Number.isFinite(value) && value > 0)
}

function getDocumentListOcrReviewMessage(doc: DocumentListItem): string {
  const existingMessage = String(doc.error_message || '').trim()
  // Keep already-short notices written by OCR completion path.
  if (/^OCR完成[，,]/.test(existingMessage) && /OCR 未成功/.test(existingMessage)) {
    return existingMessage
  }
  const pageList = formatDocumentListFailedPageNumberList(listDocumentListOcrFailedPageNums(doc.id))
  if (pageList) return `OCR完成，第 ${pageList} 页 OCR 未成功`
  return existingMessage
    ? `OCR完成，部分页面 OCR 未成功`
    : 'OCR完成，部分页面 OCR 未成功'
}

function normalizeCompletedOcrDocuments(documents: DocumentListItem[]): DocumentListItem[] {
  const changedDocIds: string[] = []
  const reviewCandidateDocs = documents.filter((doc) => {
    if (isDocumentListOcrTextComplete(doc)) return false
    if (doc.ocr_status === 'completed' && doc.import_status === 'processed') return false
    return doc.ocr_status === 'error' || doc.import_status === 'error'
  })
  const reviewSummaries = getDocumentListOcrPageSummaries(reviewCandidateDocs.map((doc) => doc.id))
  const reviewMessagesByDocId = new Map<string, string>()
  const normalized = documents.map((doc) => {
    if (isDocumentListOcrTextComplete(doc)) {
      if (doc.ocr_status === 'completed' && doc.import_status === 'processed' && !doc.error_message) return doc
      changedDocIds.push(doc.id)
      return {
        ...doc,
        ocr_status: 'completed',
        import_status: 'processed',
        error_message: null,
      }
    }

    if (isDocumentListOcrSettledWithReviewPages(doc, reviewSummaries.get(doc.id))) {
      const reviewMessage = getDocumentListOcrReviewMessage(doc)
      reviewMessagesByDocId.set(doc.id, reviewMessage)
      return {
        ...doc,
        ocr_status: 'completed',
        import_status: 'processed',
        error_message: reviewMessage,
      }
    }

    return doc
  })

  if (changedDocIds.length > 0 || reviewMessagesByDocId.size > 0) {
    const now = new Date().toISOString()
    try {
      runForIdChunks(changedDocIds, (chunkIds, placeholders) => {
        run(
          `UPDATE documents
           SET ocr_status = ?, import_status = ?, error_message = NULL, updated_at = ?
           WHERE id IN (${placeholders})`,
          ['completed', 'processed', now, ...chunkIds],
        )
      })
      transaction(() => {
        reviewMessagesByDocId.forEach((reviewMessage, docId) => {
          run(
            'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
            ['completed', 'processed', reviewMessage.slice(0, 1000), now, docId],
          )
        })
      })
      markLibraryStateCacheDirty()
      scheduleDatabaseSave()
    } catch (error) {
      console.warn('[Documents] Failed to persist normalized OCR status; using page-derived status for this list response', error)
    }
  }

  return normalized
}

function scheduleDocumentHealthReportRefresh(): void {
  if (healthReportRefreshRunning) {
    healthReportRefreshPending = true
    emitHealthReportTaskStatus({
      status: 'queued',
      progress: 0,
      message: '正在后台刷新健康统计，不影响阅读和浏览',
    })
    return
  }
  healthReportRefreshRunning = true
  emitHealthReportTaskStatus({
    status: 'queued',
    progress: 0,
    message: '正在后台刷新健康统计，不影响阅读和浏览',
  })

  const runRefresh = async (): Promise<void> => {
    try {
      emitHealthReportTaskStatus({
        status: 'processing',
        progress: 0.1,
        message: '正在后台刷新健康统计，不影响阅读和浏览',
      })
      cachedDocumentHealthReport = isHealthReportWorkerAvailable()
        ? await runHealthReportWorkerTask({ dbFilePath: getDatabaseFilePath() })
        : getDocumentHealthReport()
      emitHealthReportTaskStatus({
        status: 'completed',
        progress: 1,
        message: '健康统计更新完成',
      })
    } catch (error: unknown) {
      emitHealthReportTaskStatus({
        status: 'error',
        progress: 1,
        message: '健康统计更新失败，可稍后重试',
        errorMessage: getErrorMessage(error),
      })
    } finally {
      healthReportRefreshRunning = false
      if (healthReportRefreshPending) {
        healthReportRefreshPending = false
        scheduleDocumentHealthReportRefresh()
      }
    }
  }

  setImmediate(() => {
    void runRefresh()
  })
}

async function getCachedDocumentHealthReport(options?: DocumentHealthReportOptions): Promise<DocumentHealthReport> {
  if (!cachedDocumentHealthReport) {
    cachedDocumentHealthReport = isHealthReportWorkerAvailable()
      ? await runHealthReportWorkerTask({ dbFilePath: getDatabaseFilePath() })
      : getDocumentHealthReport()
    if (options?.refresh === true) {
      scheduleDocumentHealthReportRefresh()
    }
    return cachedDocumentHealthReport
  }

  if (options?.refresh !== false) {
    scheduleDocumentHealthReportRefresh()
  }
  return cachedDocumentHealthReport
}

export function registerDocumentIpc(): void {
  ipcMain.handle('documents:selectImportSources', async (event): Promise<CapabilityResult<ImportSelection>> => {
    const result = await dialog.showOpenDialog({
      title: '导入文献',
      filters: [
        { name: '支持的文件', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'json', 'txt', 'md', 'markdown', 'epub', 'mobi', 'azw', 'azw3'] },
        { name: 'PDF 文档', extensions: ['pdf'] },
        { name: '电子书与文本', extensions: ['epub', 'txt', 'md', 'markdown', 'mobi', 'azw', 'azw3'] },
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp'] },
        { name: 'Paddle OCR JSON', extensions: ['json'] },
      ],
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: { code: 'CAPABILITY_INVALID_REQUEST', message: '未选择文件' } }
    }
    try {
      return { ok: true, value: await importSelectionService.create(event.sender.id, result.filePaths) }
    } catch (error) {
      return capabilityFailure(error)
    }
  })

  ipcMain.handle('documents:grantDroppedImportSources', async (event, trustedPaths: string[]): Promise<CapabilityResult<ImportSelection>> => {
    try {
      return { ok: true, value: await importSelectionService.create(event.sender.id, trustedPaths) }
    } catch (error) {
      return capabilityFailure(error)
    }
  })

  ipcMain.handle('documents:readImportSelectionBatch', async (
    event,
    selectionId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<CapabilityResult<ImportSelectionBatch>> => {
    try {
      return { ok: true, value: await importSelectionService.readBatch(event.sender.id, selectionId, cursor, limit) }
    } catch (error) {
      return capabilityFailure(error)
    }
  })

  ipcMain.handle('documents:releaseImportSelection', async (event, selectionId: string): Promise<boolean> => {
    return importSelectionService.release(event.sender.id, selectionId)
  })

  ipcMain.handle('documents:getImportQueueState', async (): Promise<LibraryImportQueueState | null> => {
    return readLibraryImportQueueState()
  })

  ipcMain.handle('documents:saveImportQueueState', async (_event, state: LibraryImportQueueState | null): Promise<LibraryImportQueueState | null> => {
    return saveLibraryImportQueueState(state)
  })

  ipcMain.handle('documents:clearImportQueueState', async (): Promise<boolean> => {
    return clearLibraryImportQueueState()
  })

  ipcMain.handle('documents:getPdfInfo', async (_event, filePath: string) => {
    const safePath = assertAllowedLocalFilePath(filePath)
    return getPdfInfo(safePath)
  })

  ipcMain.handle('documents:import', (event, grantIds: string[], options?: ImportDocumentOptions) => trackDocumentImportJob(async () => {
    const lease = await fileCapabilityService.beginFileBatch(
      event.sender.id,
      grantIds,
      'document-import',
      IMPORT_FILE_LEASE_TTL_MS,
    )
    const filePaths = lease.entries.map((entry) => entry.path)
    let leaseSettled = false
    try {
    const importOcrEngine = resolveImportOcrEngine(options?.ocrEngine)
    const storageDir = join(getDataDir(), 'storage')
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true })
    }

    const now = new Date().toISOString()
    const results: InternalImportDocumentResult[] = []
    let importFileIndex = 0

    for (const [fileIndex, entry] of lease.entries.entries()) {
      const filePath = entry.path
      const sourceGrantId = entry.grantId
      const resultStartIndex = results.length
      importFileIndex = fileIndex + 1
      fileCapabilityService.renewFileBatch(lease.leaseId, IMPORT_FILE_LEASE_TTL_MS)
      if (documentImportShuttingDown) break
      try {
        const id = nanoid()
        const ext = extname(filePath).toLowerCase()
        const title = basename(filePath, ext)
        const isPdfFile = ext === '.pdf'
        const isImageFile = IMAGE_IMPORT_EXTENSIONS.has(ext)
        const destDir = join(storageDir, id)
        const destPath = join(destDir, basename(filePath))
        let copiedPdf = null
        let pdfFingerprint = null
        let pdfDuplicateChecked = false

        if (isPdfFile) {
          const sourceStats = await stat(filePath)
          const possibleDuplicate = queryOne<{ id: string }>(
            `SELECT id
             FROM documents
             WHERE COALESCE(import_status, '') <> 'deleting'
               AND (
                 json_extract(metadata, '$.pdf_size_bytes') = ?
                 OR json_extract(metadata, '$.pdf_original_size_bytes') = ?
               )
             LIMIT 1`,
            [sourceStats.size, sourceStats.size],
          )
          if (possibleDuplicate?.id) {
            pdfFingerprint = await getPdfFingerprintAsync(filePath, ({ bytesDone, totalBytes }) => {
              fileCapabilityService.renewFileBatch(lease.leaseId, IMPORT_FILE_LEASE_TTL_MS)
              sendImportProgress(event.sender, {
                phase: 'hashing',
                filePath: sourceGrantId,
                fileName: basename(filePath),
                fileIndex,
                totalFiles: filePaths.length,
                bytesDone,
                totalBytes,
                progress: totalBytes > 0 ? bytesDone / totalBytes : undefined,
              })
            })
          }
        }

        if (pdfFingerprint) {
          pdfDuplicateChecked = true
          const existing = queryOne<ExistingPdfImportRow>(
            `SELECT id, title, file_path, metadata
             FROM documents
             WHERE json_extract(metadata, '$.pdf_sha256') = ?
               AND COALESCE(import_status, '') <> 'deleting'
             ORDER BY updated_at DESC
             LIMIT 1`,
            [pdfFingerprint.sha256],
          )
          if (existing?.id) {
            const existingPdfPath = resolveManagedStoragePath(existing.file_path, existing.id)
            const alreadyHasPdf = Boolean(existingPdfPath && existsSync(existingPdfPath))
            const restored = await restorePdfAssetForDocumentAsync(existing.id, filePath, pdfFingerprint)
            await rm(destDir, { recursive: true, force: true }).catch(() => undefined)
            if (!restored.restored) {
              throw new Error(restored.error || 'PDF 补回失败')
            }
            results.push({
              id: existing.id,
              title: existing.title,
              success: true,
              sourcePath: filePath,
              storedPath: restored.path,
              sourceType: alreadyHasPdf ? 'duplicate-pdf' : 'restored-pdf',
              ocrReady: true,
              restoredDocId: existing.id,
              restoredAsset: !alreadyHasPdf,
              duplicateOfDocId: existing.id,
              pdfCompression: restored.pdfCompression,
            })
            continue
          }
        }

        if (ext === '.json') {
          const raw = parseMaybeJson<unknown>(await readFile(filePath, 'utf-8'), null)
          if (!raw) {
            throw new Error('JSON 文件格式无效')
          }

          const rawRecord = isJsonRecord(raw) ? raw : {}
          const pages = extractImportedJsonPages(raw)
          if (pages.length === 0) {
            throw new Error('JSON 中没有可导入的页面数据')
          }

          const docTitle = inferImportedTitle(filePath, rawRecord, pages[0])
          const metadataPayload = typeof rawRecord.metadata === 'string'
            ? rawRecord.metadata
            : JSON.stringify(rawRecord.metadata || {})
          const metadata = {
            import_source_type: 'paddle_json',
            original_json_path: filePath,
            imported_at: now,
            ...parseMaybeJson<JsonRecord>(metadataPayload, {}),
          }

          run(
            `INSERT INTO documents (
              id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
              ocr_status, proof_status, import_status, is_favorite, favorite_at, read_status,
              rating, last_opened_at, metadata_status, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, docTitle, rawRecord.author || null, rawRecord.dynasty || null, rawRecord.source || 'Paddle OCR JSON', rawRecord.doc_type || 'unknown', null, null, pages.length, 'processing', 'pending', 'processing', 0, null, 'unread', null, null, 'pending', JSON.stringify(metadata), now, now]
          )

          for (let index = 0; index < pages.length; index += DOCUMENT_DB_INSERT_CHUNK_SIZE) {
            if (documentImportShuttingDown) throw new Error('Document import interrupted by app shutdown')
            const chunk = pages.slice(index, index + DOCUMENT_DB_INSERT_CHUNK_SIZE)
            transaction(() => {
              chunk.forEach((page, chunkIndex) => {
                const pageIndex = index + chunkIndex
                const normalized = normalizeImportedOcrPayload(page.ocr_result || page.result || page)
                const pageNum = Number(page.page_num || page.page_index || page.pageIndex || pageIndex + 1)
                run(
                  'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  [
                    nanoid(),
                    id,
                    Number.isFinite(pageNum) && pageNum > 0 ? pageNum : pageIndex + 1,
                    typeof page.image_path === 'string' && existsSync(page.image_path) ? page.image_path : null,
                    normalized.text,
                    JSON.stringify(normalized.ocrResult),
                    page.proofed_text || null,
                    'completed',
                    page.proof_status === 'completed' ? 'completed' : 'pending',
                    now,
                  ]
                )
              })
            })
            if (index + DOCUMENT_DB_INSERT_CHUNK_SIZE < pages.length) {
              await yieldToEventLoop()
            }
          }

          syncDocumentProofStatus(id)
          run(
            'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = NULL, updated_at = ? WHERE id = ?',
            ['completed', 'processed', new Date().toISOString(), id],
          )
          results.push({ id, title: docTitle, success: true, sourcePath: filePath, sourceType: 'paddle-json', ocrReady: true })
          continue
        }

        if (UNSUPPORTED_EBOOK_EXTENSIONS.has(ext)) {
          throw new Error('MOBI/AZW/AZW3 暂未内置解析器，请先转换为 EPUB 或 TXT 后导入。')
        }

        if (TEXT_IMPORT_EXTENSIONS.has(ext) || EPUB_IMPORT_EXTENSIONS.has(ext)) {
          const destDir = join(storageDir, id)
          const destPath = join(destDir, basename(filePath))
          mkdirSync(destDir, { recursive: true })
          await copyFile(filePath, destPath)

          const parsedEbook = EPUB_IMPORT_EXTENSIONS.has(ext)
            ? await parseEpubFile(filePath)
            : parsePlainTextEbook(
              filePath,
              await readPlainTextFile(filePath),
              ext === '.md' || ext === '.markdown' ? 'markdown' : 'plain_text',
            )
          if (parsedEbook.sections.length === 0) {
            throw new Error('没有读取到可导入的文本内容')
          }
          const ebookFingerprint = getFileFingerprint(destPath)
          allowFileAccessPath(destPath)

          const metadata = {
            import_source_type: parsedEbook.manifest.format,
            original_file_name: basename(filePath),
            imported_at: now,
            ebook_manifest: parsedEbook.manifest,
            file_sha256: ebookFingerprint.sha256,
            file_size_bytes: ebookFingerprint.sizeBytes,
            file_mtime_ms: ebookFingerprint.mtimeMs,
            file_ext: ebookFingerprint.ext,
            file_kind: ebookFingerprint.kind,
          }

          run(
            `INSERT INTO documents (
              id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
              ocr_status, proof_status, import_status, is_favorite, favorite_at, read_status,
              rating, last_opened_at, metadata_status, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              parsedEbook.title || title,
              parsedEbook.author,
              null,
              null,
              ext === '.epub' ? '电子书' : '文本',
              destPath,
              null,
              parsedEbook.sections.length,
              'processing',
              'pending',
              'processing',
              0,
              null,
              'unread',
              null,
              null,
              'pending',
              JSON.stringify(metadata),
              now,
              now,
            ],
          )
          const ebookAnchors = await insertEbookSections(id, parsedEbook.sections, now)
          if (documentImportShuttingDown) throw new Error('Document import interrupted by app shutdown')
          if (parsedEbook.manifest.format === 'epub') {
            saveImportedEbookToc(id, parsedEbook.manifest.toc || [], ebookAnchors)
          }
          run(
            'UPDATE documents SET ocr_status = ?, import_status = ?, error_message = NULL, updated_at = ? WHERE id = ?',
            ['completed', 'processed', new Date().toISOString(), id],
          )
          results.push({ id, title: parsedEbook.title || title, success: true, sourcePath: filePath, sourceType: 'ebook-text', ocrReady: true })
          continue
        }

        if (isPdfFile && !copiedPdf) {
          copiedPdf = await copyFileWithFingerprintAsync(filePath, destPath, pdfFingerprint || undefined, ({ bytesDone, totalBytes }) => {
            fileCapabilityService.renewFileBatch(lease.leaseId, IMPORT_FILE_LEASE_TTL_MS)
            sendImportProgress(event.sender, {
              phase: 'copying',
              filePath: sourceGrantId,
              fileName: basename(filePath),
              fileIndex,
              totalFiles: filePaths.length,
              bytesDone,
              totalBytes,
              progress: totalBytes > 0 ? bytesDone / totalBytes : undefined,
            })
          })
          if (!pdfFingerprint) {
            pdfFingerprint = {
              sha256: copiedPdf.sourceFingerprint.sha256,
              sizeBytes: copiedPdf.sourceFingerprint.sizeBytes,
              mtimeMs: copiedPdf.sourceFingerprint.mtimeMs,
            }
          }
          if (!pdfDuplicateChecked) {
            pdfDuplicateChecked = true
            const existing = queryOne<ExistingPdfImportRow>(
              `SELECT id, title, file_path, metadata
               FROM documents
               WHERE json_extract(metadata, '$.pdf_sha256') = ?
                 AND COALESCE(import_status, '') <> 'deleting'
               ORDER BY updated_at DESC
               LIMIT 1`,
              [pdfFingerprint.sha256],
            )
            if (existing?.id) {
              const existingPdfPath = resolveManagedStoragePath(existing.file_path, existing.id)
              const alreadyHasPdf = Boolean(existingPdfPath && existsSync(existingPdfPath))
              const restored = await restorePdfAssetForDocumentAsync(existing.id, filePath, pdfFingerprint)
              await rm(destDir, { recursive: true, force: true }).catch(() => undefined)
              if (!restored.restored) {
                throw new Error(restored.error || 'PDF 补回失败')
              }
              results.push({
                id: existing.id,
                title: existing.title,
                success: true,
                sourcePath: filePath,
                storedPath: restored.path,
                sourceType: alreadyHasPdf ? 'duplicate-pdf' : 'restored-pdf',
                ocrReady: true,
                restoredDocId: existing.id,
                restoredAsset: !alreadyHasPdf,
                duplicateOfDocId: existing.id,
                pdfCompression: restored.pdfCompression,
              })
              continue
            }
          }
        }

        if (!copiedPdf) {
          mkdirSync(destDir, { recursive: true })
          await copyFile(filePath, destPath)
        }
        allowFileAccessPath(destPath)
        const storedPdfFingerprint = copiedPdf
          ? {
            sha256: copiedPdf.storedFingerprint.sha256,
            sizeBytes: copiedPdf.storedFingerprint.sizeBytes,
            mtimeMs: copiedPdf.storedFingerprint.mtimeMs,
          }
          : null
        const pdfPageCount = copiedPdf ? Math.max(0, Math.round(Number(await getPdfPageCountFast(destPath) || 0))) : 0
        const deferPdfPageRecords = isPdfFile && shouldDeferImportPdfPageRecordInit(pdfPageCount)
        const pdfCompressionSettings = pdfFingerprint ? getPdfCompressionSettings() : null
        const importPdfCompression = pdfFingerprint && pdfCompressionSettings
          ? {
            attempted: false,
            compressed: false,
            skipped: true,
            reason: pdfCompressionSettings.enabled ? 'manual_only_before_ocr' : 'disabled',
            originalBytes: pdfFingerprint.sizeBytes,
            storedBytes: storedPdfFingerprint?.sizeBytes || pdfFingerprint.sizeBytes,
            savedBytes: 0,
            ratio: pdfFingerprint.sizeBytes > 0 ? (storedPdfFingerprint?.sizeBytes || pdfFingerprint.sizeBytes) / pdfFingerprint.sizeBytes : 1,
            quality: pdfCompressionSettings.quality,
            thresholdBytes: pdfCompressionSettings.minSizeBytes,
            maxImageSide: pdfCompressionSettings.maxImageSide,
            tool: 'qpdf',
          }
          : null

        const metadata = pdfFingerprint
          ? {
            ocr_engine: importOcrEngine,
            file_sha256: storedPdfFingerprint?.sha256 || pdfFingerprint.sha256,
            file_size_bytes: storedPdfFingerprint?.sizeBytes || pdfFingerprint.sizeBytes,
            file_mtime_ms: storedPdfFingerprint?.mtimeMs || pdfFingerprint.mtimeMs,
            file_ext: '.pdf',
            file_kind: 'pdf',
            ...(pdfPageCount > 0 ? { pdf_page_count: pdfPageCount } : {}),
            ...(deferPdfPageRecords ? { pdf_page_records_deferred: true } : {}),
            ...buildPdfCompressionMetadata(
              basename(filePath),
              pdfFingerprint,
              storedPdfFingerprint || pdfFingerprint,
              importPdfCompression!,
            ),
            pdf_asset_state: 'available',
            imported_at: now,
          }
          : {
            ocr_engine: importOcrEngine,
            original_file_name: basename(filePath),
            imported_at: now,
            file_ext: ext,
            file_kind: isImageFile ? 'image' : 'file',
          }

        run(
          `INSERT INTO documents (
            id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
            ocr_status, proof_status, import_status, is_favorite, favorite_at, read_status,
            rating, last_opened_at, metadata_status, metadata, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            title,
            null,
            null,
            null,
            'unknown',
            destPath,
            isImageFile ? destPath : null,
            isImageFile ? 1 : pdfPageCount,
            'pending',
            'pending',
            'stored',
            0,
            null,
            'unread',
            null,
            null,
            'pending',
            JSON.stringify(metadata),
            now,
            now,
          ]
        )

        if (isImageFile) {
          run(
            'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nanoid(), id, 1, destPath, null, null, null, 'pending', 'pending', now],
          )
        } else if (pdfPageCount > 0 && !deferPdfPageRecords) {
          await insertMissingDocumentPageRecords(id, pdfPageCount, now)
        }

        results.push({
          id,
          title,
          success: true,
          sourcePath: filePath,
          storedPath: destPath,
          sourceType: isImageFile ? 'image-file' : 'file',
          ocrReady: isImageFile,
          pageCount: pdfPageCount > 0 ? pdfPageCount : undefined,
          pdfCompression: importPdfCompression || undefined,
        })
      } catch (error) {
        results.push({
          id: '',
          title: basename(filePath),
          success: false,
          sourcePath: filePath,
          error: (error as Error).message
        })
        if (documentImportShuttingDown) break
      } finally {
        for (let resultIndex = resultStartIndex; resultIndex < results.length; resultIndex += 1) {
          results[resultIndex].sourceGrantId = sourceGrantId
          results[resultIndex].displayName = basename(filePath)
        }
        fileCapabilityService.renewFileBatch(lease.leaseId, IMPORT_FILE_LEASE_TTL_MS)
        await yieldToEventLoop()
      }
    }

    const changedDocIds = results
      .filter((result) => result.success && (result.sourceType === 'paddle-json' || result.sourceType === 'ebook-text'))
      .map((result) => result.id)
    if (changedDocIds.length > 0) {
      markSearchIndexStaleForDocuments(changedDocIds)
      notifySearchContentChanged()
    }
    const successfulResults = results.filter((result) => result.success)
    if (!documentImportShuttingDown && successfulResults.length > 0 && filePaths.length > 0) {
      const lastSuccessful = successfulResults[successfulResults.length - 1]
      const fileIndex = Math.max(0, Math.min(filePaths.length - 1, importFileIndex - 1))
      sendImportProgress(event.sender, {
        phase: 'stored',
        filePath: lastSuccessful.sourceGrantId || lease.entries[fileIndex]?.grantId || '',
        fileName: filePaths.length === 1
          ? basename(lastSuccessful.sourcePath || filePaths[fileIndex] || lastSuccessful.title || '文件')
          : `已写入 ${successfulResults.length}/${filePaths.length} 个文件`,
        fileIndex,
        totalFiles: filePaths.length,
        progress: Math.max(0, Math.min(1, successfulResults.length / filePaths.length)),
      })
    }
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    const settledGrantIds = [...new Set(results
      .map((result) => result.sourceGrantId)
      .filter((grantId): grantId is string => Boolean(grantId)))]
    fileCapabilityService.settleFileBatch(lease.leaseId, settledGrantIds)
    leaseSettled = true
    return results.map(({ sourcePath, ...result }) => ({
      ...result,
      displayName: result.displayName || basename(sourcePath || result.title),
    }))
    } finally {
      if (!leaseSettled) {
        try {
          fileCapabilityService.abortFileBatch(lease.leaseId)
        } catch {
          // The lease may already be expired while the import is unwinding.
        }
      }
    }
  }))

  ipcMain.handle('documents:list', async (_event, options?: ListDocumentOptions): Promise<DocumentListItem[]> => {
    const { sql, params } = buildDocumentListQuery(options)
    return attachDocumentRelations(queryAll<DocumentListItem>(sql, params))
  })

  ipcMain.handle('documents:listPage', async (_event, options?: ListDocumentOptions): Promise<DocumentListPage> => {
    return listDocumentPage(options)
  })

  ipcMain.handle('documents:getHealthReport', async (_event, options?: DocumentHealthReportOptions): Promise<DocumentHealthReport> => {
    return getCachedDocumentHealthReport(options)
  })

  ipcMain.handle('documents:get', async (_event, id: string): Promise<DocumentDetail | null> => {
    const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [id])
    if (!doc) return null

    run('UPDATE documents SET last_opened_at = ?, updated_at = updated_at WHERE id = ?', [new Date().toISOString(), id])
    await ensureDeferredPdfPageRecordsReadyForRead(doc)

    const pages = hydratePagePayloadRows(queryAll<DocumentPage>('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num', [id]))
    const tags = queryAll<Tag>('SELECT t.* FROM tags t INNER JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.doc_id = ? ORDER BY t.usage_count DESC, t.name ASC', [id])
    const folders = queryAll<Folder>('SELECT f.* FROM folders f INNER JOIN document_folders df ON f.id = df.folder_id WHERE df.doc_id = ? ORDER BY f.sort_order ASC, f.name ASC', [id])

    const storageDir = join(getDataDir(), 'storage')
    if (doc.file_path) doc.file_path = migratePath(doc.file_path, storageDir)
    if (doc.thumb_path) doc.thumb_path = migratePath(doc.thumb_path, storageDir)
    if (doc.file_path) allowManagedFileAccessPath(doc.file_path)
    if (doc.thumb_path) allowManagedFileAccessPath(doc.thumb_path)
    for (const page of pages) {
      if (page.image_path) {
        page.image_path = migratePath(page.image_path, storageDir)
        allowManagedFileAccessPath(page.image_path)
      }
    }
    repairStoredGujiOcrPagesForRead(pages)
    normalizeDocumentSourceAssetsForRead(doc, pages)
    const canonicalPages = attachCanonicalPageContent(pages)

    return {
      ...doc,
      pages: canonicalPages,
      tags,
      folders,
      // Full get is rarely used by the reader; candidates stay available via metadata APIs.
      metadata_candidates: getMetadataCandidates(id),
    }
  })

  ipcMain.handle('documents:getLight', async (_event, id: string): Promise<DocumentLightDetail | null> => {
    const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [id])
    if (!doc) return null

    run('UPDATE documents SET last_opened_at = ?, updated_at = updated_at WHERE id = ?', [new Date().toISOString(), id])
    await ensureDeferredPdfPageRecordsReadyForRead(doc)

    const pages = queryAll<DocumentLightPage>(`
      SELECT
        id,
        doc_id,
        page_num,
        image_path,
        ocr_status,
        proof_status,
        created_at,
        literature_page_num,
        literature_page_source,
        ocr_page_label,
        CASE WHEN TRIM(COALESCE(NULLIF(proofed_text, ''), NULLIF(ocr_text, ''), '')) <> ''
               OR COALESCE(proofed_text_ref, ocr_text_ref, '') <> '' THEN 1 ELSE 0 END as has_text,
        CASE WHEN (ocr_result IS NOT NULL AND TRIM(ocr_result) <> '')
               OR COALESCE(ocr_result_ref, '') <> '' THEN 1 ELSE 0 END as has_ocr_result
      FROM pages
      WHERE doc_id = ?
      ORDER BY page_num
    `, [id])
    const tags = queryAll<Tag>('SELECT t.* FROM tags t INNER JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.doc_id = ? ORDER BY t.usage_count DESC, t.name ASC', [id])
    const folders = queryAll<Folder>('SELECT f.* FROM folders f INNER JOIN document_folders df ON f.id = df.folder_id WHERE df.doc_id = ? ORDER BY f.sort_order ASC, f.name ASC', [id])

    const storageDir = join(getDataDir(), 'storage')
    if (doc.file_path) doc.file_path = migratePath(doc.file_path, storageDir)
    if (doc.thumb_path) doc.thumb_path = migratePath(doc.thumb_path, storageDir)
    if (doc.file_path) allowManagedFileAccessPath(doc.file_path)
    if (doc.thumb_path) allowManagedFileAccessPath(doc.thumb_path)
    for (const page of pages) {
      if (page.image_path) {
        page.image_path = migratePath(page.image_path, storageDir)
        allowManagedFileAccessPath(page.image_path)
      }
      page.__light = true
    }
    normalizeDocumentSourceAssetsForRead(doc, pages)

    // Opening a document never needed live metadata candidates for reading/proof.
    // Keep the field for contract stability; candidates load via dedicated metadata APIs.
    return {
      ...doc,
      pages,
      tags,
      folders,
      metadata_candidates: [],
    }
  })

  ipcMain.handle('documents:translateBook', async (_event, docId: string, options?: BookTranslationOptions): Promise<BookTranslationStartResult> => {
    const safeDocId = String(docId || '').trim()
    if (!safeDocId) throw new Error('缺少文献 ID')
    if (bookTranslationRuntimeShuttingDown) throw new Error('应用正在退出，已停止启动新的整书翻译任务')

    if (activeBookTranslationJobs.has(safeDocId)) {
      return { jobId: `book-translation-${safeDocId}`, status: 'running' }
    }

    const doc = queryOne<DocumentExistsRow>('SELECT id FROM documents WHERE id = ?', [safeDocId])
    if (!doc) throw new Error('文献不存在')

    const jobId = `book-translation-${safeDocId}-${Date.now()}`
    activeBookTranslationJobs.add(safeDocId)
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        void runBookTranslationJob(safeDocId, jobId, options)
        .catch((error: unknown) => {
          if (isBookTranslationShutdownError(error)) return
          const errorMessage = getErrorMessage(error, '整书翻译失败')
          console.error(`[Documents] Book translation failed for ${safeDocId}:`, error)
          emitBookTranslationProgress({
            jobId,
            docId: safeDocId,
            status: 'error',
            progress: 0,
            errorMessage,
            message: errorMessage,
          })
        })
        .finally(() => {
          activeBookTranslationJobs.delete(safeDocId)
          resolve()
        })
      })
    })
    activeBookTranslationJobTasks.add(task)
    void task.finally(() => {
      activeBookTranslationJobTasks.delete(task)
    })

    return { jobId, status: 'started' }
  })

  ipcMain.handle('documents:getPagesRange', async (_event, docId: string, startPageNum: number, endPageNum: number): Promise<DocumentPage[]> => {
    const safeStart = Math.max(1, Number(startPageNum) || 1)
    const safeEnd = Math.max(safeStart, Number(endPageNum) || safeStart)
    const pages = hydratePagePayloadRows(queryAll<DocumentPage>(
      'SELECT * FROM pages WHERE doc_id = ? AND page_num BETWEEN ? AND ? ORDER BY page_num',
      [docId, safeStart, safeEnd],
    ))
    const storageDir = join(getDataDir(), 'storage')
    for (const page of pages) {
      if (page.image_path) {
        page.image_path = migratePath(page.image_path, storageDir)
        allowManagedFileAccessPath(page.image_path)
      }
      page.__full = true
    }
    repairStoredGujiOcrPagesForRead(pages)
    return attachCanonicalPageContent(pages)
  })

  ipcMain.handle('documents:getSearchPages', async (_event, docId: string): Promise<DocumentPage[]> => {
    // Proof/reader search needs page text and layout boxes, not canonical artifacts.
    // Skipping attachCanonicalPageContent avoids extra artifact-table scans per open search.
    // Completeness: every page with text/OCR is still returned; no page is filtered out.
    const pages = hydratePagePayloadRows(queryAll<DocumentSearchPageRow>(
      `SELECT
        id,
        doc_id,
        page_num,
        ocr_result,
        ocr_result_ref,
        ocr_text,
        ocr_text_ref,
        proofed_text,
        proofed_text_ref,
        active_ocr_artifact_id,
        proof_base_artifact_id,
        proof_base_stale,
        ocr_status,
        proof_status,
        created_at
      FROM pages
      WHERE doc_id = ?
      ORDER BY page_num`,
      [docId],
    ))
    return pages.map((page) => {
      const hasInlineText = String(page.proofed_text || page.ocr_text || '').trim().length > 0
      return {
        ...page,
        has_ocr_text: hasInlineText || Boolean(page.ocr_result),
        needs_layout_attention: false,
        image_path: null,
        has_text: hasInlineText,
        __search_text_only: true,
      }
    })
  })

  ipcMain.handle('documents:recomputeLiteraturePages', async (_event, docId: string) => {
    const id = String(docId || '').trim()
    if (!id) throw new Error('docId is required')
    return recomputeLiteraturePageMap(id)
  })

  ipcMain.handle(
    'documents:applyLiteraturePageAnchor',
    async (
      _event,
      docId: string,
      physicalPageNum: number,
      literaturePageNum: number,
    ) => {
      const id = String(docId || '').trim()
      if (!id) throw new Error('docId is required')
      const physical = Math.floor(Number(physicalPageNum) || 0)
      const literature = Math.floor(Number(literaturePageNum) || 0)
      if (physical < 1 || literature < 1) throw new Error('页码必须是大于 0 的整数')
      return applyManualLiteraturePageAnchor(id, physical, literature)
    },
  )

  ipcMain.handle('documents:resetLiteraturePages', async (_event, docId: string) => {
    const id = String(docId || '').trim()
    if (!id) throw new Error('docId is required')
    return resetLiteraturePageMap(id)
  })

  ipcMain.handle('documents:getReadingWindow', async (_event, docId: string, pageIndex?: number, radius?: number): Promise<DocumentReadingWindow | null> => {
    const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [docId])
    if (!doc) return null
    run('UPDATE documents SET last_opened_at = ?, updated_at = updated_at WHERE id = ?', [new Date().toISOString(), docId])
    const pageCount = Number(doc.page_count || 0)
    const safeIndex = Math.max(0, Math.min(Math.max(0, pageCount - 1), Math.round(Number(pageIndex || 0))))
    const safeRadius = Math.max(0, Math.min(20, Math.round(Number(radius ?? 2))))
    const startPageNum = Math.max(1, safeIndex + 1 - safeRadius)
    const endPageNum = Math.max(startPageNum, Math.min(Math.max(1, pageCount), safeIndex + 1 + safeRadius))
    const pages = hydratePagePayloadRows(queryAll<DocumentPage>(
      'SELECT * FROM pages WHERE doc_id = ? AND page_num BETWEEN ? AND ? ORDER BY page_num',
      [docId, startPageNum, endPageNum],
    ))
    const storageDir = join(getDataDir(), 'storage')
    if (doc.file_path) doc.file_path = migratePath(doc.file_path, storageDir)
    if (doc.thumb_path) doc.thumb_path = migratePath(doc.thumb_path, storageDir)
    if (doc.file_path) allowManagedFileAccessPath(doc.file_path)
    if (doc.thumb_path) allowManagedFileAccessPath(doc.thumb_path)
    for (const page of pages) {
      if (page.image_path) {
        page.image_path = migratePath(page.image_path, storageDir)
        allowManagedFileAccessPath(page.image_path)
      }
      page.__full = true
    }
    repairStoredGujiOcrPagesForRead(pages)
    const canonicalPages = attachCanonicalPageContent(pages)
    return {
      document: doc,
      pages: canonicalPages,
      pageIndex: safeIndex,
      pageCount,
      startPageNum,
      endPageNum,
      radius: safeRadius,
    }
  })

  ipcMain.handle('documents:update', async (_event, id: string, data: DocumentUpdatePayload) => {
    rejectProtectedPathFields(data, ['file_path', 'thumb_path'])
    const doc = queryOne<Document>('SELECT * FROM documents WHERE id = ?', [id])
    if (!doc) return false

    const allowedFields: Array<keyof DocumentUpdatePayload> = [
      'title',
      'author',
      'dynasty',
      'source',
      'doc_type',
      'page_count',
      'ocr_status',
      'proof_status',
      'import_status',
      'error_message',
      'retry_count',
      'last_retry_at',
      'is_favorite',
      'favorite_at',
      'read_status',
      'rating',
      'last_opened_at',
      'metadata_status',
      'metadata'
    ]

    const sets: string[] = []
    const params: unknown[] = []

    for (const field of allowedFields) {
      if (!(field in data)) continue
      sets.push(`${field} = ?`)
      let value = data[field]
      if (field === 'metadata' && typeof value !== 'string') {
        value = JSON.stringify(value)
      }
      if (field === 'doc_type') {
        value = normalizeHistoryDocType(String(value || '其他'))
      }
      params.push(value)
    }

    if (sets.length === 0) return false

    sets.push('updated_at = ?')
    params.push(new Date().toISOString(), id)
    run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params)
    if (
      'metadata' in data
      || 'doc_type' in data
      || 'author' in data
      || 'dynasty' in data
      || 'source' in data
    ) {
      const nextMetadata = 'metadata' in data ? parseDocumentMetadata(data.metadata) : parseDocumentMetadata(doc.metadata)
      const nextDocType = normalizeHistoryDocType(String(('doc_type' in data ? data.doc_type : doc.doc_type) || '其他'))
      syncDocumentMetadataTags(id, nextMetadata, nextDocType, {
        author: String(('author' in data ? data.author : doc.author) || ''),
        dynasty: String(('dynasty' in data ? data.dynasty : doc.dynasty) || ''),
        source: String(('source' in data ? data.source : doc.source) || ''),
      })
    }
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('documents:toggleFavorite', async (_event, id: string, nextValue?: boolean) => {
    const doc = queryOne<{ is_favorite: number }>('SELECT is_favorite FROM documents WHERE id = ?', [id])
    if (!doc) return false
    const isFavorite = typeof nextValue === 'boolean' ? nextValue : doc.is_favorite !== 1
    run(
      'UPDATE documents SET is_favorite = ?, favorite_at = ?, updated_at = ? WHERE id = ?',
      [isFavorite ? 1 : 0, isFavorite ? new Date().toISOString() : null, new Date().toISOString(), id]
    )
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('documents:setReadStatus', async (_event, id: string, readStatus: ReadStatus): Promise<boolean> => {
    run('UPDATE documents SET read_status = ?, updated_at = ? WHERE id = ?', [readStatus, new Date().toISOString(), id])
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('documents:setRating', async (_event, id: string, rating: number | null) => {
    run('UPDATE documents SET rating = ?, updated_at = ? WHERE id = ?', [rating, new Date().toISOString(), id])
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('reader:getState', async (_event, docId: string): Promise<ReaderState | null> => {
    if (!docId) return null
    return queryOne<ReaderState>('SELECT * FROM reader_state WHERE doc_id = ?', [docId])
  })

  ipcMain.handle('reader:saveState', async (_event, docId: string, state: ReaderStateSavePayload): Promise<boolean> => {
    if (!docId) return false
    const now = new Date().toISOString()
    const existing = queryOne<ReaderState>('SELECT * FROM reader_state WHERE doc_id = ?', [docId])
    const merged: Partial<ReaderState> = { ...(existing || {}) }
    for (const [key, value] of Object.entries(state || {})) {
      if (value !== undefined) {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    const locationKey = String(merged.location_key || '')
    const progress = Math.max(0, Math.min(1, Number(merged.progress || 0)))
    const viewMode = merged.view_mode === 'single' ? 'single' : 'spread'
    const fontSize = Math.max(12, Math.min(30, Math.round(Number(merged.font_size || 17))))
    const lineHeight = Math.max(1.2, Math.min(2.6, Number(merged.line_height || 1.8)))
    const theme = merged.theme === 'dark' || merged.theme === 'sepia' ? merged.theme : 'paper'
    const documentMode = merged.document_mode === 'proof' ? 'proof' : 'read'
    const proofLocationKey = String(merged.proof_location_key || '')
    const proofProgress = Math.max(0, Math.min(1, Number(merged.proof_progress || 0)))
    const proofViewMode = merged.proof_view_mode === 'facsimile' ? 'facsimile' : 'text'

    run(
      `INSERT INTO reader_state (
        doc_id, location_key, progress, view_mode, font_size, line_height, theme,
        document_mode, proof_location_key, proof_progress, proof_view_mode, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        location_key = excluded.location_key,
        progress = excluded.progress,
        view_mode = excluded.view_mode,
        font_size = excluded.font_size,
        line_height = excluded.line_height,
        theme = excluded.theme,
        document_mode = excluded.document_mode,
        proof_location_key = excluded.proof_location_key,
        proof_progress = excluded.proof_progress,
        proof_view_mode = excluded.proof_view_mode,
        updated_at = excluded.updated_at`,
      [
        docId,
        locationKey,
        progress,
        viewMode,
        fontSize,
        lineHeight,
        theme,
        documentMode,
        proofLocationKey,
        proofProgress,
        proofViewMode,
        now,
      ],
    )
    run('UPDATE documents SET last_opened_at = ?, read_status = CASE WHEN read_status = ? THEN ? ELSE read_status END WHERE id = ?', [
      now,
      'unread',
      'reading',
      docId,
    ])
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('reader:getAiLayoutCache', async (_event, docId: string, pageIds: string[] = [], mode: AiLayoutMode = 'reading_layout'): Promise<AiLayoutCacheItem[]> => {
    const uniquePageIds = [...new Set((pageIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (!docId || uniquePageIds.length === 0) return []
    const placeholders = uniquePageIds.map(() => '?').join(', ')
    return hydratePagePayloadRows(queryAll<AiLayoutCacheItem>(
      `SELECT id, doc_id, page_id, page_num, mode, source_hash, result_text, result_text_ref, status, error_message, model, created_at, updated_at
       FROM page_ai_layout_cache
       WHERE doc_id = ?
         AND mode = ?
         AND page_id IN (${placeholders})
       ORDER BY page_num ASC, updated_at DESC`,
      [docId, mode, ...uniquePageIds],
    ))
  })

  const AI_LAYOUT_INPUT_LIMIT = 1600

  const looksLikeLocalHeading = (line: string): boolean => {
    const text = line.trim()
    if (!text || text.length > 44) return false
    return /^(序|跋|目录|凡例|提要|摘要|关键词|参考文献)$/.test(text)
      || /^第[一二三四五六七八九十百千万\d]+[章节卷篇部编回]/.test(text)
      || /^[一二三四五六七八九十百千万\d]+[、.．]\s*.{1,36}$/.test(text)
      || /^[(（][一二三四五六七八九十百千万\d]+[)）]\s*.{1,36}$/.test(text)
  }

  const shouldEndLocalParagraph = (line: string): boolean => /[。！？!?；;：:]$/.test(line.trim()) || looksLikeLocalHeading(line)

  const normalizeLocalReadingLayout = (value: string): string => {
    const raw = String(value || '')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!raw) return ''

    return raw
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
        if (lines.length <= 1) return lines[0] || ''
        const paragraphs: string[] = []
        let current = ''
        const flush = () => {
          if (current.trim()) paragraphs.push(current.trim())
          current = ''
        }
        for (const line of lines) {
          if (looksLikeLocalHeading(line)) {
            flush()
            paragraphs.push(line)
            continue
          }
          current = current ? `${current}${/[\u4e00-\u9fff]$/.test(current) && /^[\u4e00-\u9fff]/.test(line) ? '' : ' '}${line}` : line
          if (shouldEndLocalParagraph(line)) flush()
        }
        flush()
        return paragraphs.join('\n\n')
      })
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  const shouldBypassAiLayout = (value: string): boolean => {
    const text = normalizeLocalReadingLayout(value)
    if (!text) return true
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (text.length <= 220) return true
    const punctuationCount = (text.match(/[。！？；;.!?，、]/g) || []).length
    const headingCount = lines.filter(looksLikeLocalHeading).length
    if (lines.length >= 2 && text.length <= 2200 && punctuationCount >= Math.max(4, Math.floor(text.length / 120))) return true
    if (headingCount >= 1 && punctuationCount >= Math.max(3, Math.floor(text.length / 150))) return true
    if (text.length > 1800 && punctuationCount >= Math.max(8, Math.floor(text.length / 130))) return true
    return text.length <= 420 && punctuationCount >= 2
  }

  const getAiLayoutTextProfile = (value: string): { punctuationDensity: number; likelyClassical: boolean } => {
    const text = normalizeLocalReadingLayout(value)
    const chineseChars = (text.match(/[\u3400-\u9fff]/g) || []).length
    const punctuationCount = (text.match(/[。！？；;.!?，、：:]/g) || []).length
    const classicalSignals = (text.match(/[曰云謂谓乃遂其之者也矣焉乎哉於于與与爲为]/g) || []).length
    return {
      punctuationDensity: chineseChars > 0 ? punctuationCount / chineseChars : 0,
      likelyClassical: chineseChars >= 80 && punctuationCount / Math.max(1, chineseChars) < 0.018 && classicalSignals >= Math.max(8, Math.floor(chineseChars / 55)),
    }
  }

  const getAiLayoutInput = (value: string): { input: string; remainder: string } => {
    const text = normalizeLocalReadingLayout(value)
    if (text.length <= AI_LAYOUT_INPUT_LIMIT) return { input: text, remainder: '' }
    const slice = text.slice(0, AI_LAYOUT_INPUT_LIMIT)
    const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'), slice.lastIndexOf('？'))
    const end = breakAt > AI_LAYOUT_INPUT_LIMIT * 0.62 ? breakAt + 1 : AI_LAYOUT_INPUT_LIMIT
    return {
      input: text.slice(0, end).trim(),
      remainder: text.slice(end).trim(),
    }
  }

  ipcMain.handle('reader:runAiLayoutPage', async (_event, docId: string, pageId: string, mode: AiLayoutMode = 'reading_layout', text = '', sourceHash = ''): Promise<AiLayoutCacheItem | null> => {
    const page = queryOne<{ id: string; doc_id: string; page_num: number }>('SELECT id, doc_id, page_num FROM pages WHERE id = ? AND doc_id = ?', [pageId, docId])
    if (!page) throw new Error('页面不存在')
    const normalizedText = String(text || '').trim()
    const normalizedHash = String(sourceHash || '').trim()
    if (!normalizedText || !normalizedHash) throw new Error('缺少可排版文本')
    const cachedRaw = queryOne<AiLayoutCacheItem>(
      `SELECT id, doc_id, page_id, page_num, mode, source_hash, result_text, result_text_ref, status, error_message, model, created_at, updated_at
       FROM page_ai_layout_cache
       WHERE page_id = ? AND mode = ? AND source_hash = ? AND status = 'ready'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [pageId, mode, normalizedHash],
    )
    const cached = cachedRaw ? hydratePagePayloadRow(cachedRaw) : null
    if (cached?.result_text) return cached

    const now = new Date().toISOString()
    const id = nanoid()
    try {
      const resultText = shouldBypassAiLayout(normalizedText)
        ? normalizeLocalReadingLayout(normalizedText)
        : await (async () => {
            const { input, remainder } = getAiLayoutInput(normalizedText)
            const profile = getAiLayoutTextProfile(input)
            const aiText = await runAiTask('layout_reading_page', input, { mode, pageNum: page.page_num, ...profile })
            return [aiText.trim(), remainder].filter(Boolean).join('\n\n')
          })()
      const preparedResultText = preparePagePayloadUpdate(docId, pageId, 'result_text', resultText)
      run(
        `INSERT INTO page_ai_layout_cache (
          id, doc_id, page_id, page_num, mode, source_hash, result_text, result_text_ref, status, error_message, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_id, mode, source_hash) DO UPDATE SET
          result_text = excluded.result_text,
          result_text_ref = excluded.result_text_ref,
          status = excluded.status,
          error_message = excluded.error_message,
          model = excluded.model,
          updated_at = excluded.updated_at`,
        [id, docId, pageId, Number(page.page_num || 0), mode, normalizedHash, preparedResultText.value, preparedResultText.ref, 'ready', null, 'default', now, now],
      )
      scheduleDatabaseSave()
      const saved = queryOne<AiLayoutCacheItem>(
        `SELECT id, doc_id, page_id, page_num, mode, source_hash, result_text, result_text_ref, status, error_message, model, created_at, updated_at
         FROM page_ai_layout_cache
         WHERE page_id = ? AND mode = ? AND source_hash = ?`,
        [pageId, mode, normalizedHash],
      )
      return saved ? hydratePagePayloadRow(saved) : null
    } catch (error: unknown) {
      run(
        `INSERT INTO page_ai_layout_cache (
          id, doc_id, page_id, page_num, mode, source_hash, result_text, status, error_message, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_id, mode, source_hash) DO UPDATE SET
          status = excluded.status,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
        [id, docId, pageId, Number(page.page_num || 0), mode, normalizedHash, '', 'error', getErrorMessage(error), 'default', now, now],
      )
      scheduleDatabaseSave()
      throw error
    }
  })

  ipcMain.handle('reader:getTranslationCache', async (_event, docId: string, pageIds: string[] = []): Promise<PageTranslationCacheItem[]> => {
    const uniquePageIds = [...new Set((pageIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (!docId || uniquePageIds.length === 0) return []
    const placeholders = uniquePageIds.map(() => '?').join(', ')
    const rows = queryAll<PageTranslationCacheItem>(
      `SELECT id, doc_id, page_id, page_num, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message, model, created_at, updated_at
       FROM page_translation_cache
       WHERE doc_id = ?
         AND page_id IN (${placeholders})
       ORDER BY page_num ASC, updated_at DESC`,
      [docId, ...uniquePageIds],
    )
    const hydratedRows = hydratePagePayloadRows(rows)
    const invalidReadyRows = hydratedRows.filter(isInvalidReadyTranslationCache)
    if (invalidReadyRows.length > 0) {
      markTranslationCacheRowsAsAlignmentError(invalidReadyRows)
      return hydratedRows.map((row) => invalidReadyRows.some((invalidRow) => invalidRow.id === row.id)
        ? { ...row, status: 'error', error_message: TRANSLATION_ALIGNMENT_ERROR_MESSAGE }
        : row)
    }
    return hydratedRows
  })

  ipcMain.handle('reader:saveTranslationCache', async (_event, docId: string, pageId: string, payload: PageTranslationCachePayload = {}): Promise<PageTranslationCacheItem | null> => {
    const page = queryOne<TranslationCachePageRow>('SELECT id, doc_id, page_num FROM pages WHERE id = ? AND doc_id = ?', [pageId, docId])
    if (!page) throw new Error('页面不存在')
    const sourceHash = String(payload?.sourceHash || payload?.source_hash || '').trim()
    const translationText = String(payload?.translationText || payload?.translation_text || '')
    const sourceText = String(payload?.sourceText || payload?.source_text || '')
    if (!sourceHash) throw new Error('缺少翻译缓存来源标识')

    const now = new Date().toISOString()
    const id = nanoid()
    const requestedStatus = payload?.status || 'ready'
    const nextStatus = requestedStatus === 'ready'
      && !payload?.skipped
      && !isParallelTranslationDisplayReady(sourceText, translationText)
      ? 'error'
      : requestedStatus
    const nextErrorMessage = nextStatus === 'error' && requestedStatus === 'ready'
      ? TRANSLATION_ALIGNMENT_ERROR_MESSAGE
      : payload?.errorMessage || payload?.error_message || null
    const preparedSourceText = preparePagePayloadUpdate(docId, pageId, 'source_text', sourceText)
    const preparedTranslationText = preparePagePayloadUpdate(docId, pageId, 'translation_text', translationText)
    run(
      `INSERT INTO page_translation_cache (
        id, doc_id, page_id, page_num, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id, source_hash) DO UPDATE SET
        source_text = excluded.source_text,
        source_text_ref = excluded.source_text_ref,
        translation_text = excluded.translation_text,
        translation_text_ref = excluded.translation_text_ref,
        skipped = excluded.skipped,
        status = excluded.status,
        error_message = excluded.error_message,
        model = excluded.model,
        updated_at = excluded.updated_at`,
      [
        id,
        docId,
        pageId,
        Number(page.page_num || 0),
        sourceHash,
        preparedSourceText.value,
        preparedSourceText.ref,
        preparedTranslationText.value,
        preparedTranslationText.ref,
        payload?.skipped ? 1 : 0,
        nextStatus,
        nextErrorMessage,
        payload?.model || 'default',
        now,
        now,
      ],
    )
    scheduleDatabaseSave()
    if (nextStatus === 'ready') {
      try {
        ensurePageTranslationUnits(pageId)
      } catch (error) {
        console.warn('[Translation] Failed to migrate saved legacy cache into units', error)
        markSearchIndexStaleForPages([pageId])
        notifySearchContentChanged()
      }
    } else {
      markSearchIndexStaleForPages([pageId])
      notifySearchContentChanged()
    }
    const saved = queryOne<PageTranslationCacheItem>(
      `SELECT id, doc_id, page_id, page_num, source_hash, source_text, source_text_ref, translation_text, translation_text_ref, skipped, status, error_message, model, created_at, updated_at
       FROM page_translation_cache
       WHERE page_id = ? AND source_hash = ?`,
      [pageId, sourceHash],
    )
    return saved ? hydratePagePayloadRow(saved) : null
  })

  ipcMain.handle('documents:delete', async (_event, id: string) => {
    const result = await deleteDocumentsByIds([id])
    return result.failedIds.length === 0
  })

  ipcMain.handle('documents:deleteBatch', async (_event, ids: string[]): Promise<DeleteDocumentsResult> => {
    return deleteDocumentsByIds(ids)
  })

  ipcMain.handle('documents:deleteZeroPage', async (): Promise<DeleteDocumentsResult> => {
    const rows = queryAll<{ id: string }>(
      `SELECT id FROM documents
       WHERE COALESCE(page_count, 0) <= 0
         AND COALESCE(import_status, '') <> 'deleting'`,
    )
    return deleteDocumentsByIds(rows.map((row) => row.id))
  })

  async function deleteDocumentsByIds(ids: string[]): Promise<DeleteDocumentsResult> {
    const docIds = uniqueDocumentIds(ids)
    if (docIds.length === 0) {
      return { deletedIds: [], failedIds: [], successCount: 0 }
    }

    const docs = getDocumentsForDelete(docIds)
    const existingIds = new Set(docs.map((doc) => doc.id))
    const submittedIds = docs
      .map((doc) => doc.id)
      .filter((docId) => !activeDocumentDeleteIds.has(docId))

    if (submittedIds.length > 0) {
      submittedIds.forEach((docId) => activeDocumentDeleteIds.add(docId))
      markDocumentsDeleting(submittedIds)
      markLibraryStateCacheDirty()
      scheduleDocumentDeleteJob(submittedIds)
    }

    const deletedIds = docIds.filter((docId) => existingIds.has(docId))
    return {
      deletedIds,
      failedIds: [],
      successCount: deletedIds.length,
    }
  }

  ipcMain.handle('documents:savePages', async (_event, docId: string, base64Images: string[]) => {
    const doc = queryOne('SELECT * FROM documents WHERE id = ?', [docId])
    if (!doc) {
      throw new Error('文献不存在')
    }

    const storageDir = join(getDataDir(), 'storage', docId)
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true })
    }

    clearPageSearchIndexForDocuments([docId])
    markLibraryStateCacheDirty()
    run('DELETE FROM pages WHERE doc_id = ?', [docId])

    const now = new Date().toISOString()
    for (let index = 0; index < base64Images.length; index += DOCUMENT_PAGE_WRITE_CHUNK_SIZE) {
      const rows: Array<{ pageId: string; pageNum: number; destPath: string }> = []
      const chunk = base64Images.slice(index, index + DOCUMENT_PAGE_WRITE_CHUNK_SIZE)
      for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex += 1) {
        const pageNum = index + chunkIndex + 1
        const pageId = nanoid()
        const destPath = join(storageDir, `page_${pageNum}.jpg`)
        await writeFile(destPath, dataUrlToBuffer(chunk[chunkIndex]))
        allowFileAccessPath(destPath)
        rows.push({ pageId, pageNum, destPath })
      }

      transaction(() => {
        rows.forEach((row) => {
          run(
            'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.pageId, docId, row.pageNum, row.destPath, null, null, null, 'pending', 'pending', now],
          )
        })
      })
      if (index + DOCUMENT_PAGE_WRITE_CHUNK_SIZE < base64Images.length) {
        await yieldToEventLoop()
      }
    }

    const thumbPath = join(storageDir, 'page_1.jpg')
    run(
      'UPDATE documents SET page_count = ?, thumb_path = ?, metadata_status = ?, updated_at = ? WHERE id = ?',
      [base64Images.length, existsSync(thumbPath) ? thumbPath : null, 'pending', new Date().toISOString(), docId]
    )
    syncDocumentProofStatus(docId)

    markSearchIndexStaleForDocuments([docId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('documents:appendPages', async (_event, docId: string, pages: DocumentAppendPagePayload[], options?: DocumentAppendPagesOptions) => {
    const doc = queryOne('SELECT * FROM documents WHERE id = ?', [docId])
    if (!doc) {
      throw new Error('文献不存在')
    }

    const storageDir = join(getDataDir(), 'storage', docId)
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true })
    }

    if (options?.reset) {
      clearPageSearchIndexForDocuments([docId])
      run('DELETE FROM pages WHERE doc_id = ?', [docId])
    }

    const now = new Date().toISOString()
    const touchedPageIds: string[] = []
    for (let index = 0; index < pages.length; index += DOCUMENT_PAGE_WRITE_CHUNK_SIZE) {
      const rows: Array<{ pageId: string; existingId: string | null; pageNum: number; destPath: string }> = []
      const chunk = pages.slice(index, index + DOCUMENT_PAGE_WRITE_CHUNK_SIZE)
      for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex += 1) {
        const page = chunk[chunkIndex]
        const pageNum = Number(page.pageNum || index + chunkIndex + 1)
        if (!Number.isFinite(pageNum) || pageNum <= 0 || !page.dataUrl) continue
        const pageId = nanoid()
        const destPath = join(storageDir, `page_${pageNum}.jpg`)
        await writeFile(destPath, dataUrlToBuffer(page.dataUrl))
        allowFileAccessPath(destPath)
        const existing = queryOne<{ id: string }>('SELECT id FROM pages WHERE doc_id = ? AND page_num = ? ORDER BY created_at LIMIT 1', [docId, pageNum])
        rows.push({ pageId, existingId: existing?.id || null, pageNum, destPath })
      }

      transaction(() => {
        rows.forEach((row) => {
          if (row.existingId) {
            run('UPDATE pages SET image_path = ? WHERE id = ?', [row.destPath, row.existingId])
            touchedPageIds.push(row.existingId)
          } else {
            run(
              'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [row.pageId, docId, row.pageNum, row.destPath, null, null, null, 'pending', 'pending', now],
            )
            touchedPageIds.push(row.pageId)
          }
        })
      })
      if (index + DOCUMENT_PAGE_WRITE_CHUNK_SIZE < pages.length) {
        await yieldToEventLoop()
      }
    }

    const countRow = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', [docId])
    const pageCount = Math.max(Number(options?.totalPages || 0), Number(countRow?.count || 0))
    const thumbPath = join(storageDir, 'page_1.jpg')
    run(
      'UPDATE documents SET page_count = ?, thumb_path = ?, metadata_status = ?, updated_at = ? WHERE id = ?',
      [pageCount, existsSync(thumbPath) ? thumbPath : null, 'pending', new Date().toISOString(), docId]
    )
    syncDocumentProofStatus(docId)
    markSearchIndexStaleForDocuments([docId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('documents:initializePdfPages', async (_event, docId: string, pageCount: number, options?: InitializePdfPagesOptions) => {
    rejectProtectedPathFields(options, ['thumbPath'])
    const doc = queryOne<DocumentPdfSourceRow>('SELECT id, file_path FROM documents WHERE id = ?', [docId])
    if (!doc) {
      throw new Error('文献不存在')
    }

    const safePageCount = Math.max(0, Math.round(Number(pageCount || 0)))
    if (safePageCount <= 0) {
      throw new Error('PDF 页数无效')
    }

    const now = new Date().toISOString()
    await insertMissingDocumentPageRecords(docId, safePageCount, now)
    clearDeferredPdfPageRecordMarker(docId)

    const updates = ['page_count = ?', 'metadata_status = ?', 'updated_at = ?']
    const params: unknown[] = [safePageCount, 'pending', now]
    if (options?.title && String(options.title).trim() && String(options.title).trim() !== '未命名文档') {
      updates.push('title = ?')
      params.push(String(options.title).trim())
    }
    params.push(docId)
    run(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`, params)

    const docFilePath = resolveManagedStoragePath(doc.file_path, docId)
    if (docFilePath && existsSync(docFilePath)) {
      if (extname(docFilePath).toLowerCase() === '.pdf') {
        annotatePdfMetadata(docId, docFilePath, safePageCount)
      } else {
        annotateDocumentFileFingerprint(docId, docFilePath, safePageCount)
      }
    }

    syncDocumentProofStatus(docId)
    markSearchIndexStaleForDocuments([docId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('documents:cachePageImage', async (_event, docId: string, pageNum: number, dataUrl: string) => {
    const doc = queryOne('SELECT * FROM documents WHERE id = ?', [docId])
    if (!doc) {
      throw new Error('文献不存在')
    }

    const safePageNum = Math.round(Number(pageNum || 0))
    if (!Number.isFinite(safePageNum) || safePageNum <= 0 || !dataUrl) {
      throw new Error('页面图像参数无效')
    }

    const storageDir = join(getDataDir(), 'storage', docId)
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true })
    }

    const imageBuffer = dataUrlToBuffer(dataUrl)
    assertValidPageImageBuffer(imageBuffer)

    const destPath = join(storageDir, `page_${safePageNum}.jpg`)
    await writeFile(destPath, imageBuffer)
    const writtenStat = await stat(destPath)
    if (!writtenStat.isFile() || writtenStat.size <= 0) {
      throw new Error('页面图片缓存写入失败，请重试')
    }
    allowFileAccessPath(destPath)

    const existing = queryOne<{ id: string }>('SELECT id FROM pages WHERE doc_id = ? AND page_num = ? ORDER BY created_at LIMIT 1', [docId, safePageNum])
    if (existing?.id) {
      run('UPDATE pages SET image_path = ? WHERE id = ?', [destPath, existing.id])
    } else {
      run(
        'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nanoid(), docId, safePageNum, destPath, null, null, null, 'pending', 'pending', new Date().toISOString()]
      )
    }

    if (safePageNum === 1) {
      run('UPDATE documents SET thumb_path = ?, updated_at = ? WHERE id = ?', [destPath, new Date().toISOString(), docId])
    }

    if (!existing?.id) {
      markSearchIndexStaleForDocuments([docId])
      notifySearchContentChanged()
    }
    scheduleDatabaseSave()
    return destPath
  })

  ipcMain.handle('documents:cleanupPdfAssets', async (_event, docId: string): Promise<PdfAssetCleanupResult> => {
    return cleanupPdfAssetsAsync(docId)
  })

  ipcMain.handle('documents:cleanupCompletedPdfAssets', async (): Promise<CompletedPdfAssetCleanupResult> => {
    return cleanupCompletedPdfAssetsAsync()
  })

  ipcMain.handle('pdfRepository:selectFolder', async (event) => {
    const result = await dialog.showOpenDialog({
      title: '选择 PDF 原件仓库',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return getPdfRepositoryStatus()
    const grants = await fileCapabilityService.issueTrustedPaths({
      ownerId: event.sender.id,
      purpose: 'pdf-repository',
      paths: [result.filePaths[0]],
      kind: 'directory',
      consumeMode: 'once',
    })
    const repositoryPath = await fileCapabilityService.useDirectory(event.sender.id, grants[0].grantId, 'pdf-repository')
    return addPdfRepositoryPath(repositoryPath)
  })

  ipcMain.handle('pdfRepository:list', async (): Promise<PdfRepositoryStatus> => {
    return getPdfRepositoryStatus()
  })

  ipcMain.handle('pdfRepository:remove', async (_event, repositoryId: string): Promise<PdfRepositoryStatus> => {
    return removePdfRepositoryById(String(repositoryId || ''))
  })

  ipcMain.handle('pdfRepository:index', async (): Promise<PdfRepositoryIndexResult> => {
    return indexPdfRepositoriesAsync()
  })

  ipcMain.handle(
    'pdfRepository:restoreForDocument',
    async (_event, docId: string, options?: PdfAssetRestoreOptions): Promise<PdfAssetRestoreResult> => {
      return restorePdfAssetForDocumentAsync(docId, undefined, undefined, options)
    },
  )

  ipcMain.handle(
    'pdfRepository:selectAndRestoreForDocument',
    async (event, docId: string, options?: PdfAssetRestoreOptions): Promise<PdfAssetRestoreResult> => {
      const result = await dialog.showOpenDialog({
        title: '选择要补回的 PDF 原件',
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return { restored: false, error: '未选择 PDF 文件' }
      const grants = await fileCapabilityService.issueTrustedPaths({
        ownerId: event.sender.id,
        purpose: 'pdf-restore',
        paths: [result.filePaths[0]],
        kind: 'file',
        consumeMode: 'once',
      })
      const manualPath = await fileCapabilityService.consumeFile(event.sender.id, grants[0].grantId, 'pdf-restore')
      return restorePdfAssetForDocumentAsync(docId, manualPath, undefined, options)
    },
  )

  ipcMain.handle('pages:update', async (_event, pageId: string, data: PageUpdatePayload) => {
    rejectProtectedPathFields(data, ['image_path'])
    const page = queryOne<{ doc_id: string; page_num: number | null; image_path: string | null; proof_status: string; active_ocr_artifact_id: string | null }>(
      'SELECT doc_id, page_num, image_path, proof_status, active_ocr_artifact_id FROM pages WHERE id = ?',
      [pageId],
    )
    if (!page) return false
    const normalizedData: PageUpdatePayload = { ...data }
    if ('ocr_result' in normalizedData && normalizedData.ocr_result) {
      let imageSize: { width: number; height: number } | null = null
      const imagePath = String(page.image_path || '').trim()
      if (imagePath) {
        try {
          const image = nativeImage.createFromPath(imagePath)
          if (!image.isEmpty()) imageSize = image.getSize()
        } catch {
          imageSize = null
        }
      }
      const pageIndex = Number(page.page_num || 0) || 1
      const repairedResult = normalizeStoredGujiOcrResultForRead(normalizedData.ocr_result, imagePath, pageIndex)
        || normalizedData.ocr_result
      const normalizedResult = ensureOcrResultIr(repairedResult, {
        pageIndex,
        pageWidth: imageSize?.width,
        pageHeight: imageSize?.height,
        forceRebuild: true,
      })
      normalizedData.ocr_result = normalizedResult
      if (!('ocr_text' in normalizedData) && normalizedResult.gujismart_ir) {
        normalizedData.ocr_text = deriveOcrTextFromIr(normalizedResult.gujismart_ir)
      }
    }

    const allowedFields: Array<keyof PageUpdatePayload> = ['ocr_text', 'ocr_result', 'proofed_text', 'ocr_status', 'proof_status']
    const sets: string[] = []
    const params: unknown[] = []

    for (const field of allowedFields) {
      if (!(field in normalizedData)) continue
      const value = normalizedData[field]
      if (field === 'ocr_text' || field === 'ocr_result' || field === 'proofed_text') {
        const prepared = preparePagePayloadUpdate(page.doc_id, pageId, field, value)
        sets.push(`${field} = ?`, `${field}_ref = ?`)
        params.push(prepared.value, prepared.ref)
        continue
      }
      sets.push(`${field} = ?`)
      params.push(value)
    }

    const effectiveProofStatus = normalizedData.proof_status === undefined ? page.proof_status : normalizedData.proof_status
    if ('proofed_text' in normalizedData && effectiveProofStatus === 'completed') {
      sets.push('proof_base_artifact_id = active_ocr_artifact_id', 'proof_base_stale = 0')
    }

    if (sets.length === 0) return false

    params.push(pageId)
    run(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, params)
    syncDocumentProofStatus(page.doc_id)
    if ('ocr_text' in normalizedData || 'proofed_text' in normalizedData || 'ocr_result' in normalizedData) {
      markDocumentTocDirty(page.doc_id)
    }
    markSearchIndexStaleForPages([pageId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('pages:resetOcr', async (_event, pageId: string) => {
    const rawPage = queryOne<DocumentPage>('SELECT * FROM pages WHERE id = ?', [pageId])
    const page = rawPage ? hydratePagePayloadRow(rawPage) : null
    if (!page) return false

    let ocrResult: (OcrRecognizeResult & JsonRecord) | null = parseJsonRecord(page.ocr_result) as (OcrRecognizeResult & JsonRecord) | null

    if (Array.isArray(ocrResult?.layout_result)) {
      ocrResult = {
        ...ocrResult,
        layout_result: ocrResult.layout_result
          .filter(isJsonRecord)
          .map((box): OcrRecognizeLayoutBlock => ({ ...box, words: textValue(box.words) }))
      }
    }

    const pageIndex = Number(page.page_num || 0) || 1
    const repairedOcrResult = ocrResult
      ? normalizeStoredGujiOcrResultForRead(ocrResult, page.image_path, pageIndex) || ocrResult
      : null
    const normalizedOcrResult = repairedOcrResult
      ? ensureOcrResultIr(repairedOcrResult, {
          pageIndex,
          generatedAt: getOcrPageIr(page.ocr_result)?.generatedAt,
          forceRebuild: true,
        })
      : null
    const ocrText = normalizedOcrResult?.gujismart_ir
      ? deriveOcrTextFromIr(normalizedOcrResult.gujismart_ir)
      : String(page.ocr_text || '')

    const nextOcrResult = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_result', normalizedOcrResult)
    const nextOcrText = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_text', ocrText)
    run(`UPDATE pages SET ocr_result = ?, ocr_result_ref = ?, ocr_text = ?, ocr_text_ref = ?,
      proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END WHERE id = ?`, [
      nextOcrResult.value,
      nextOcrResult.ref,
      nextOcrText.value,
      nextOcrText.ref,
      pageId,
    ])
    syncDocumentProofStatus(page.doc_id)
    markDocumentTocDirty(page.doc_id)
    markSearchIndexStaleForPages([pageId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

  ipcMain.handle('pages:listOcrVersions', async (_event, pageId: string): Promise<PageOcrVersion[]> => {
    return queryAll<PageOcrVersion>(
      `SELECT id, doc_id, page_id, page_num, engine, label, status, is_active, created_at, updated_at
       FROM page_ocr_versions
       WHERE page_id = ?
       ORDER BY is_active DESC, updated_at DESC`,
      [pageId],
    )
  })

  ipcMain.handle('pages:switchOcrVersion', async (_event, pageId: string, engine: string) => {
    const rawPage = queryOne<DocumentPage>('SELECT * FROM pages WHERE id = ?', [pageId])
    const page = rawPage ? hydratePagePayloadRow(rawPage) : null
    if (!page) throw new Error('页面不存在')
    const version = queryOne<PageOcrVersionDetailRow>(
      'SELECT * FROM page_ocr_versions WHERE page_id = ? AND engine = ? AND status = ?',
      [pageId, engine, 'completed'],
    )
    if (!version) throw new Error('该 OCR 模式还没有可切换的结果')

    run('UPDATE page_ocr_versions SET is_active = 0 WHERE page_id = ?', [pageId])
    run('UPDATE page_ocr_versions SET is_active = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), version.id])
    const hydratedVersion = hydratePagePayloadRow(version)
    const nextOcrText = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_text', hydratedVersion.ocr_text || '')
    const pageIndex = Number(page.page_num || 0) || 1
    const normalizedVersionResult = hydratedVersion.ocr_result
      ? normalizeStoredGujiOcrResultForRead(hydratedVersion.ocr_result, page.image_path, pageIndex) || hydratedVersion.ocr_result
      : null
    const nextOcrResult = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_result', normalizedVersionResult)
    run(
      `UPDATE pages SET ocr_text = ?, ocr_text_ref = ?, ocr_result = ?, ocr_result_ref = ?, ocr_status = ?,
       proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
       WHERE id = ?`,
      [nextOcrText.value, nextOcrText.ref, nextOcrResult.value, nextOcrResult.ref, 'completed', pageId],
    )
    const doc = queryOne<DocumentMetadataRow>('SELECT metadata FROM documents WHERE id = ?', [page.doc_id])
    const metadata = (() => {
      try { return JSON.parse(doc?.metadata || '{}') } catch { return {} }
    })()
    run('UPDATE documents SET metadata = ?, metadata_status = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ ...metadata, ocr_engine: engine }),
      'pending',
      new Date().toISOString(),
      page.doc_id,
    ])
    syncDocumentProofStatus(page.doc_id)
    markDocumentTocDirty(page.doc_id)
    markSearchIndexStaleForPages([pageId])
    notifySearchContentChanged()
    scheduleDatabaseSave()
    return true
  })

}
