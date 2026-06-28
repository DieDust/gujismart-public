import { nanoid } from 'nanoid'
import { BrowserWindow } from 'electron'
import { runAiTask } from './ai'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { getActiveTranslationGlossary, getTranslationGlossaryVersionSignature } from './glossary-service'
import { hydratePagePayloadRow, hydratePagePayloadRows, preparePagePayloadUpdate } from './page-payload-store'
import { getErrorMessage } from '../shared/errors'
import { markSearchIndexStaleForPages, notifySearchContentChanged } from './semantic-search'
import { DEFAULT_TRANSLATION_STYLE, buildTranslationCacheKey } from '../shared/translation-cache'
import { projectParallelTranslationBySourceCoverage } from '../shared/parallel-translation'
import {
  buildTranslationUnitDrafts,
  formatTranslationUnitInput,
  fnv1aTranslationHash,
  joinTranslationUnits,
  normalizeTranslationMode,
  normalizeTranslationUnitStatus,
  parseTranslationUnitOutput,
  restoreTranslationText,
} from '../shared/translation-units'
import type {
  Document,
  DocumentPage,
  PageTranslationRequest,
  PageTranslationProgressEvent,
  PageTranslationResult,
  TranslationMode,
  TranslationStyle,
  TranslationUnitUpdatePayload,
  TranslationUnitV1,
} from '../shared/types'

type TranslationUnitRow = {
  id: string
  doc_id: string
  page_id: string
  page_num: number
  unit_id: string
  block_id: string
  block_index: number
  unit_order: number
  block_type: string
  source_text: string
  source_hash: string
  translation_text: string
  target_language: string
  mode: string
  model_signature: string
  glossary_signature: string
  status: string
  manual_override: number
  stale: number
  skipped: number
  quality_json: string
  source_rect_json: string
  source_index: number | null
  created_at: string | null
  updated_at: string | null
}

type LegacyTranslationCacheRow = {
  source_text: string
  source_text_ref?: string | null
  translation_text: string
  translation_text_ref?: string | null
  skipped: number
  status: string
}

const PAGE_TRANSLATION_MAX_CHARS = 9200
const PAGE_TRANSLATION_MAX_UNITS = 90
const TRANSLATION_RETRY_DELAYS_MS = [900, 2200]
const canceledTranslationTaskIds = new Set<string>()

function throwIfTranslationCanceled(taskId: string): void {
  if (!canceledTranslationTaskIds.has(taskId)) return
  throw new Error('翻译任务已取消')
}

function emitPageTranslationProgress(payload: PageTranslationProgressEvent): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('translation:pageProgress', payload)
  })
}

export function cancelTranslationTask(taskId: string): boolean {
  const normalized = String(taskId || '').trim()
  if (!normalized) return false
  canceledTranslationTaskIds.add(normalized)
  return true
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function getSettingValue(key: string, fallback = ''): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || fallback)
}

function makeModelSignature(): string {
  return [
    getSettingValue('llm_active_provider_id'),
    getSettingValue('llm_provider', 'AI'),
    getSettingValue('llm_base_url'),
    getSettingValue('llm_model'),
  ].map((part) => part.trim()).filter(Boolean).join('|') || 'default'
}

function rowToUnit(row: TranslationUnitRow): TranslationUnitV1 {
  return {
    id: row.unit_id,
    docId: row.doc_id,
    pageId: row.page_id,
    pageNum: Number(row.page_num || 0),
    blockId: row.block_id,
    blockIndex: Number(row.block_index || 0),
    order: Number(row.unit_order || 0),
    blockType: row.block_type || 'text',
    sourceText: row.source_text || '',
    sourceHash: row.source_hash || '',
    translationText: row.translation_text || '',
    targetLanguage: 'zh-CN',
    mode: normalizeTranslationMode(row.mode),
    modelSignature: row.model_signature || '',
    glossarySignature: row.glossary_signature || '',
    status: normalizeTranslationUnitStatus(row.status),
    manualOverride: Boolean(row.manual_override),
    stale: Boolean(row.stale),
    skipped: Boolean(row.skipped),
    quality: parseJsonRecord(row.quality_json),
    sourceRect: Object.keys(parseJsonRecord(row.source_rect_json)).length
      ? parseJsonRecord(row.source_rect_json) as TranslationUnitV1['sourceRect']
      : null,
    sourceIndex: row.source_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getPage(pageId: string): DocumentPage {
  const raw = queryOne<DocumentPage>(
    `SELECT id, doc_id, page_num, image_path, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref,
            proofed_text, proofed_text_ref, ocr_status, proof_status, created_at
     FROM pages WHERE id = ?`,
    [pageId],
  )
  if (!raw) throw new Error('页面不存在')
  return hydratePagePayloadRow(raw)
}

function getStoredRows(pageId: string): TranslationUnitRow[] {
  return queryAll<TranslationUnitRow>(
    `SELECT * FROM page_translation_units
     WHERE page_id = ? AND target_language = 'zh-CN'
     ORDER BY unit_order, block_index`,
    [pageId],
  )
}

function importLegacyPageTranslation(page: DocumentPage, units: TranslationUnitV1[]): boolean {
  if (units.some((unit) => unit.manualOverride || (!unit.skipped && unit.status === 'ready' && !unit.stale && unit.translationText.trim()))) return false
  const legacyRows = hydratePagePayloadRows(queryAll<LegacyTranslationCacheRow>(
    `SELECT source_text, source_text_ref, translation_text, translation_text_ref, skipped, status
     FROM page_translation_cache
     WHERE page_id = ? AND status = 'ready'
       AND COALESCE(translation_text, '') <> ''
     ORDER BY updated_at DESC`,
    [page.id],
  ))
  const legacy = legacyRows[0]
  if (!legacy) return false
  const candidates = units.filter((unit) => !unit.skipped)
  const projection = projectParallelTranslationBySourceCoverage(
    candidates.map((unit) => unit.sourceText),
    legacy.source_text,
    legacy.translation_text,
  )
  if (!projection.covered.every(Boolean) || projection.translations.some((text) => !text.trim())) return false
  const now = new Date().toISOString()
  transaction(() => {
    candidates.forEach((unit, index) => {
      run(
        `UPDATE page_translation_units
         SET translation_text = ?, status = 'ready', stale = 0,
             quality_json = ?, updated_at = ?
         WHERE page_id = ? AND unit_id = ? AND target_language = 'zh-CN'`,
        [
          projection.translations[index],
          JSON.stringify({ importedFromLegacyCache: true }),
          now,
          page.id,
          unit.id,
        ],
      )
    })
  })
  scheduleDatabaseSave()
  markSearchIndexStaleForPages([page.id])
  notifySearchContentChanged()
  return true
}

export function ensurePageTranslationUnits(pageId: string): TranslationUnitV1[] {
  const page = getPage(pageId)
  const drafts = buildTranslationUnitDrafts(page)
  const existingRows = getStoredRows(pageId)
  const existingById = new Map(existingRows.map((row) => [row.unit_id, row]))
  const draftIds = drafts.map((draft) => draft.id)
  const now = new Date().toISOString()

  transaction(() => {
    drafts.forEach((draft) => {
      const existing = existingById.get(draft.id)
      const sourceChanged = Boolean(existing && existing.source_hash !== draft.sourceHash)
      const translationText = draft.skipped
        ? draft.sourceText
        : String(existing?.translation_text || '')
      const status = draft.skipped
        ? 'skipped'
        : sourceChanged
          ? 'stale'
          : existing?.status || 'pending'
      run(
        `INSERT INTO page_translation_units (
          id, doc_id, page_id, page_num, unit_id, block_id, block_index, unit_order,
          block_type, source_text, source_hash, translation_text, target_language,
          mode, model_signature, glossary_signature, status, manual_override, stale,
          skipped, quality_json, source_rect_json, source_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'zh-CN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_id, unit_id, target_language) DO UPDATE SET
          page_num = excluded.page_num,
          block_id = excluded.block_id,
          block_index = excluded.block_index,
          unit_order = excluded.unit_order,
          block_type = excluded.block_type,
          source_text = excluded.source_text,
          source_hash = excluded.source_hash,
          translation_text = excluded.translation_text,
          status = excluded.status,
          stale = excluded.stale,
          skipped = excluded.skipped,
          source_rect_json = excluded.source_rect_json,
          source_index = excluded.source_index,
          updated_at = excluded.updated_at`,
        [
          existing?.id || nanoid(),
          page.doc_id,
          page.id,
          Number(page.page_num || 0),
          draft.id,
          draft.blockId,
          draft.blockIndex,
          draft.order,
          draft.blockType,
          draft.sourceText,
          draft.sourceHash,
          translationText,
          existing?.mode || 'balanced',
          existing?.model_signature || '',
          existing?.glossary_signature || '',
          status,
          Number(existing?.manual_override || 0),
          sourceChanged ? 1 : Number(existing?.stale || 0),
          draft.skipped ? 1 : 0,
          existing?.quality_json || '{}',
          draft.sourceRect ? JSON.stringify(draft.sourceRect) : '',
          draft.sourceIndex ?? null,
          existing?.created_at || now,
          now,
        ],
      )
    })
    if (draftIds.length > 0) {
      run(
        `DELETE FROM page_translation_units
         WHERE page_id = ? AND target_language = 'zh-CN'
           AND manual_override = 0
           AND unit_id NOT IN (${draftIds.map(() => '?').join(',')})`,
        [page.id, ...draftIds],
      )
    } else {
      run(
        `DELETE FROM page_translation_units
         WHERE page_id = ? AND target_language = 'zh-CN'
           AND manual_override = 0`,
        [page.id],
      )
    }
  })
  scheduleDatabaseSave()

  let units = getStoredRows(pageId)
    .filter((row) => drafts.some((draft) => draft.id === row.unit_id))
    .map(rowToUnit)
  if (importLegacyPageTranslation(page, units)) {
    units = getStoredRows(pageId)
      .filter((row) => drafts.some((draft) => draft.id === row.unit_id))
      .map(rowToUnit)
  }
  return units
}

export function getPageTranslationUnits(pageId: string): TranslationUnitV1[] {
  return ensurePageTranslationUnits(pageId)
}

function chunkTranslationUnits(units: TranslationUnitV1[]): TranslationUnitV1[][] {
  const batches: TranslationUnitV1[][] = []
  let current: TranslationUnitV1[] = []
  let currentChars = 0
  for (const unit of units) {
    const nextChars = unit.sourceText.length + unit.id.length + 4
    if (current.length > 0 && (current.length >= PAGE_TRANSLATION_MAX_UNITS || currentChars + nextChars > PAGE_TRANSLATION_MAX_CHARS)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(unit)
    currentChars += nextChars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function isRetryableTranslationError(error: unknown): boolean {
  return /429|rate limit|too many requests|timeout|timed out|temporar|network|fetch failed|503|502/i.test(getErrorMessage(error))
}

async function runTranslationTaskWithBackoff(text: string, options: Parameters<typeof runAiTask>[2]): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TRANSLATION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await runAiTask('translate', text, options)
    } catch (error) {
      lastError = error
      if (!isRetryableTranslationError(error) || attempt >= TRANSLATION_RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, TRANSLATION_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

function normalizeDigitsForComparison(value: string): string {
  const digitMap: Record<string, string> = {
    '０': '0',
    '１': '1',
    '２': '2',
    '３': '3',
    '４': '4',
    '５': '5',
    '６': '6',
    '７': '7',
    '８': '8',
    '９': '9',
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
  }
  return String(value || '').replace(/[０-９⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (char) => digitMap[char] || char)
}

function hasPreservedNumbers(source: string, translation: string): boolean {
  const sourceNumbers = normalizeDigitsForComparison(source).match(/\d+/g) || []
  if (sourceNumbers.length === 0) return true
  const normalizedTranslation = normalizeDigitsForComparison(translation)
  return sourceNumbers.every((value) => normalizedTranslation.includes(value))
}

async function translateBatch(
  units: TranslationUnitV1[],
  request: PageTranslationRequest,
  mode: TranslationMode,
  documentTitle: string,
  modelSignature: string,
  glossarySignature: string,
  review = false,
): Promise<{ translations: Map<string, string>; invalidIds: string[] }> {
  const formatted = formatTranslationUnitInput(units)
  const draft = review
    ? units.map((unit) => `[${unit.id}] ${unit.translationText}`).join('\n')
    : ''
  const result = await runTranslationTaskWithBackoff(formatted.input, {
    pageId: request.pageId,
    glossaryProjectId: request.glossaryProjectId,
    translationStyle: request.style || DEFAULT_TRANSLATION_STYLE,
    translationMode: mode,
    translationUnits: true,
    translationReview: review,
    previousTranslation: draft,
    documentTitle,
    pageContextBefore: mode === 'fast' ? '' : request.pageContextBefore,
    pageContextAfter: mode === 'fast' ? '' : request.pageContextAfter,
    segmentCount: units.length,
  })
  const parsed = parseTranslationUnitOutput(result)
  const translations = new Map<string, string>()
  const invalidIds: string[] = []
  for (const unit of units) {
    const raw = parsed.get(unit.id) || ''
    const restored = restoreTranslationText(raw, formatted.protectedById[unit.id]?.placeholders || {})
    const qualityValid = mode === 'fast'
      ? restored.complete && Boolean(restored.text)
      : restored.complete
        && Boolean(restored.text)
        && hasPreservedNumbers(unit.sourceText, restored.text)
        && restored.text.length <= Math.max(80, unit.sourceText.length * 5)
    if (!qualityValid) {
      invalidIds.push(unit.id)
      continue
    }
    translations.set(unit.id, restored.text)
  }
  return { translations, invalidIds }
}

function saveTranslatedUnits(
  pageId: string,
  units: TranslationUnitV1[],
  translations: Map<string, string>,
  invalidIds: Set<string>,
  mode: TranslationMode,
  modelSignature: string,
  glossarySignature: string,
  quality: Record<string, unknown>,
): void {
  const now = new Date().toISOString()
  transaction(() => {
    for (const unit of units) {
      if (unit.manualOverride) continue
      const translation = translations.get(unit.id)
      run(
        `UPDATE page_translation_units
         SET translation_text = CASE WHEN ? <> '' THEN ? ELSE translation_text END,
             mode = ?, model_signature = ?, glossary_signature = ?,
             status = ?, stale = ?, quality_json = ?, updated_at = ?
         WHERE page_id = ? AND unit_id = ? AND target_language = 'zh-CN'`,
        [
          translation || '',
          translation || '',
          mode,
          modelSignature,
          glossarySignature,
          invalidIds.has(unit.id) ? 'error' : translation ? 'ready' : unit.status,
          invalidIds.has(unit.id) ? 1 : 0,
          JSON.stringify(quality),
          now,
          pageId,
          unit.id,
        ],
      )
    }
  })
  scheduleDatabaseSave()
  markSearchIndexStaleForPages([pageId])
  notifySearchContentChanged()
}

function saveLegacyPageCache(
  docId: string,
  pageId: string,
  pageNum: number,
  units: TranslationUnitV1[],
  modelSignature: string,
  glossarySignature: string,
  style: TranslationStyle,
): void {
  const sourceText = joinTranslationUnits(units, 'source')
  const translationText = joinTranslationUnits(units, 'translation')
  if (!sourceText || !translationText) return
  const sourceHash = buildTranslationCacheKey({
    docId,
    pageId,
    sourceText,
    modelSignature,
    glossarySignature,
    style,
  })
  const now = new Date().toISOString()
  const sourcePayload = preparePagePayloadUpdate(docId, pageId, 'source_text', sourceText)
  const translationPayload = preparePagePayloadUpdate(docId, pageId, 'translation_text', translationText)
  run(
    `INSERT INTO page_translation_cache (
      id, doc_id, page_id, page_num, source_hash, source_text, source_text_ref,
      translation_text, translation_text_ref, skipped, status, error_message,
      model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ready', NULL, ?, ?, ?)
    ON CONFLICT(page_id, source_hash) DO UPDATE SET
      source_text = excluded.source_text,
      source_text_ref = excluded.source_text_ref,
      translation_text = excluded.translation_text,
      translation_text_ref = excluded.translation_text_ref,
      status = excluded.status,
      error_message = NULL,
      model = excluded.model,
      updated_at = excluded.updated_at`,
    [
      nanoid(),
      docId,
      pageId,
      pageNum,
      sourceHash,
      sourcePayload.value,
      sourcePayload.ref,
      translationPayload.value,
      translationPayload.ref,
      modelSignature,
      now,
      now,
    ],
  )
  scheduleDatabaseSave()
}

function buildPageResult(taskId: string, request: PageTranslationRequest, mode: TranslationMode, units: TranslationUnitV1[]): PageTranslationResult {
  const translatedCount = units.filter((unit) => unit.status === 'ready' && !unit.manualOverride).length
  const cachedCount = units.filter((unit) => unit.status === 'ready' && unit.manualOverride).length
  const failedCount = units.filter((unit) => unit.status === 'error').length
  const skippedCount = units.filter((unit) => unit.skipped).length
  return {
    taskId,
    docId: request.docId,
    pageId: request.pageId,
    pageNum: units[0]?.pageNum || 0,
    mode,
    units,
    sourceText: joinTranslationUnits(units, 'source'),
    translationText: joinTranslationUnits(units, 'translation'),
    translatedCount,
    cachedCount,
    failedCount,
    skippedCount,
    complete: failedCount === 0 && units.every((unit) => unit.skipped || Boolean(unit.translationText)),
  }
}

export async function translatePageUnits(request: PageTranslationRequest): Promise<PageTranslationResult> {
  const taskId = String(request.taskId || '').trim() || nanoid()
  canceledTranslationTaskIds.delete(taskId)
  const mode = normalizeTranslationMode(request.mode)
  const page = getPage(request.pageId)
  if (page.doc_id !== request.docId) throw new Error('页面与文献不匹配')
  const doc = queryOne<Pick<Document, 'title'>>('SELECT title FROM documents WHERE id = ?', [request.docId])
  const modelSignature = makeModelSignature()
  const glossarySignature = getTranslationGlossaryVersionSignature(request.glossaryProjectId)
  const glossary = getActiveTranslationGlossary({
    projectId: request.glossaryProjectId,
    text: String(page.proofed_text || page.ocr_text || ''),
  })
  let units = ensurePageTranslationUnits(request.pageId)
  const requestedIds = new Set((request.unitIds || []).map(String))
  const targetUnits = units.filter((unit) => (
    !unit.skipped
    && !unit.manualOverride
    && (requestedIds.size === 0 || requestedIds.has(unit.id))
    && (request.force || unit.status !== 'ready' || unit.stale || !unit.translationText)
  ))
  if (targetUnits.length === 0) return buildPageResult(taskId, request, mode, units)

  const now = new Date().toISOString()
  transaction(() => {
    targetUnits.forEach((unit) => {
      run(
        `UPDATE page_translation_units
         SET status = 'processing', mode = ?, model_signature = ?,
             glossary_signature = ?, updated_at = ?
         WHERE page_id = ? AND unit_id = ? AND manual_override = 0`,
        [mode, modelSignature, glossarySignature, now, request.pageId, unit.id],
      )
    })
  })

  try {
    const batches = chunkTranslationUnits(targetUnits)
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      throwIfTranslationCanceled(taskId)
      const batch = batches[batchIndex]
      const firstPass = await translateBatch(
        batch,
        request,
        mode,
        doc?.title || request.documentTitle || '',
        modelSignature,
        glossary.signature || glossarySignature,
      )
      let translations = firstPass.translations
      let invalidIds = firstPass.invalidIds
      if (invalidIds.length > 0) {
        const retryUnits = batch.filter((unit) => invalidIds.includes(unit.id))
        const retry = await translateBatch(
          retryUnits,
          request,
          mode,
          doc?.title || request.documentTitle || '',
          modelSignature,
          glossary.signature || glossarySignature,
        )
        translations = new Map([...translations, ...retry.translations])
        invalidIds = retry.invalidIds
      }
      saveTranslatedUnits(
        request.pageId,
        batch,
        translations,
        new Set(invalidIds),
        mode,
        modelSignature,
        glossary.signature || glossarySignature,
        {
          batchIndex,
          batchCount: batches.length,
          targetedRetry: firstPass.invalidIds.length,
          glossaryTermCount: glossary.terms.length,
        },
      )
      throwIfTranslationCanceled(taskId)
      const progressUnits = ensurePageTranslationUnits(request.pageId)
      emitPageTranslationProgress({
        taskId,
        docId: request.docId,
        pageId: request.pageId,
        pageNum: Number(page.page_num || 0),
        mode,
        completedBatches: batchIndex + 1,
        totalBatches: batches.length,
        units: progressUnits,
        sourceText: joinTranslationUnits(progressUnits, 'source'),
        translationText: joinTranslationUnits(progressUnits, 'translation'),
      })
    }

    units = ensurePageTranslationUnits(request.pageId)
    if (mode === 'quality') {
      const reviewTargets = units.filter((unit) => !unit.skipped && !unit.manualOverride && unit.translationText && unit.status === 'ready')
      for (const batch of chunkTranslationUnits(reviewTargets)) {
        throwIfTranslationCanceled(taskId)
        const review = await translateBatch(
          batch,
          request,
          mode,
          doc?.title || request.documentTitle || '',
          modelSignature,
          glossary.signature || glossarySignature,
          true,
        )
        saveTranslatedUnits(
          request.pageId,
          batch,
          review.translations,
          new Set(review.invalidIds),
          mode,
          modelSignature,
          glossary.signature || glossarySignature,
          { reviewed: true },
        )
      }
      units = ensurePageTranslationUnits(request.pageId)
    }
  } catch (error) {
    const now = new Date().toISOString()
    const errorMessage = getErrorMessage(error, '页面翻译失败')
    transaction(() => {
      targetUnits.forEach((unit) => {
        run(
          `UPDATE page_translation_units
           SET status = 'error', stale = CASE WHEN TRIM(COALESCE(translation_text, '')) <> '' THEN 1 ELSE stale END,
               quality_json = ?, updated_at = ?
           WHERE page_id = ? AND unit_id = ? AND manual_override = 0`,
          [JSON.stringify({ error: errorMessage }), now, request.pageId, unit.id],
        )
      })
    })
    scheduleDatabaseSave()
    throw error
  } finally {
    canceledTranslationTaskIds.delete(taskId)
  }

  saveLegacyPageCache(
    request.docId,
    request.pageId,
    Number(page.page_num || 0),
    units,
    modelSignature,
    glossary.signature || glossarySignature,
    request.style || DEFAULT_TRANSLATION_STYLE,
  )
  return buildPageResult(taskId, request, mode, units)
}

export function updateTranslationUnit(unitId: string, payload: TranslationUnitUpdatePayload): TranslationUnitV1 | null {
  const row = queryOne<TranslationUnitRow>(
    `SELECT * FROM page_translation_units WHERE unit_id = ? AND target_language = 'zh-CN'`,
    [unitId],
  )
  if (!row) return null
  const translationText = String(payload.translationText || '').trim()
  run(
    `UPDATE page_translation_units
     SET translation_text = ?, manual_override = ?, stale = 0,
         status = ?, quality_json = ?, updated_at = ?
     WHERE unit_id = ? AND target_language = 'zh-CN'`,
    [
      translationText,
      payload.manualOverride === false ? 0 : 1,
      translationText ? 'ready' : 'pending',
      JSON.stringify({ manuallyEdited: payload.manualOverride !== false }),
      new Date().toISOString(),
      unitId,
    ],
  )
  scheduleDatabaseSave()
  markSearchIndexStaleForPages([row.page_id])
  notifySearchContentChanged()
  return rowToUnit(queryOne<TranslationUnitRow>(
    `SELECT * FROM page_translation_units WHERE unit_id = ? AND target_language = 'zh-CN'`,
    [unitId],
  ) as TranslationUnitRow)
}

export function clearMachineTranslationUnits(docId: string, pageId?: string): number {
  const rows = queryAll<{ unit_id: string }>(
    `SELECT unit_id FROM page_translation_units
     WHERE doc_id = ? AND manual_override = 0 ${pageId ? 'AND page_id = ?' : ''}`,
    pageId ? [docId, pageId] : [docId],
  )
  run(
    `UPDATE page_translation_units
     SET translation_text = CASE WHEN skipped = 1 THEN source_text ELSE '' END,
         status = CASE WHEN skipped = 1 THEN 'skipped' ELSE 'pending' END,
         stale = 0, quality_json = '{}', updated_at = ?
     WHERE doc_id = ? AND manual_override = 0 ${pageId ? 'AND page_id = ?' : ''}`,
    pageId ? [new Date().toISOString(), docId, pageId] : [new Date().toISOString(), docId],
  )
  scheduleDatabaseSave()
  if (pageId) markSearchIndexStaleForPages([pageId])
  notifySearchContentChanged()
  return rows.length
}

export function getTranslationPageText(pageId: string): { sourceText: string; translationText: string; sourceHash: string } {
  const units = ensurePageTranslationUnits(pageId)
  const sourceText = joinTranslationUnits(units, 'source')
  return {
    sourceText,
    translationText: joinTranslationUnits(units, 'translation'),
    sourceHash: fnv1aTranslationHash(sourceText),
  }
}
