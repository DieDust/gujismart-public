import { BrowserWindow } from 'electron'
import { reclassifyAndApplyDocument } from './ai'
import { queryAll, queryOne, run, saveDatabase } from './database'
import type { MetadataReclassificationProgressEvent } from '../shared/types'

const RECLASSIFY_VERSION = '0.6-history-doc-type-ai-reclassify-2026-05-19'
const LEGACY_DOC_TYPE_NAMES = ['论文', '期刊', '学术论文', '图书', '书籍', '古籍']
const DEFAULT_RECLASSIFY_CONCURRENCY = 3
const MAX_RECLASSIFY_CONCURRENCY = 6

type ReclassifyCandidate = {
  id: string
  title: string
  doc_type: string | null
  metadata_status: string | null
}

function emitReclassificationProgress(payload: MetadataReclassificationProgressEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('metadata:reclassificationProgress', payload)
    }
  }
}

function hasLlmConfig(): boolean {
  const row = queryOne<{ value: string | null }>("SELECT value FROM settings WHERE key = 'llm_api_key'")
  return !!row?.value
}

function hasCompletedReclassification(): boolean {
  const row = queryOne<{ value: string | null }>('SELECT value FROM settings WHERE key = ?', [RECLASSIFY_VERSION])
  return row?.value === 'completed'
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECLASSIFY_CONCURRENCY
  return Math.max(1, Math.min(MAX_RECLASSIFY_CONCURRENCY, Math.floor(value)))
}

function getReclassifyConcurrency(): number {
  const row = queryOne<{ value: string | null }>("SELECT value FROM settings WHERE key = 'metadata_reclassify_concurrency'")
  return clampConcurrency(Number(row?.value || DEFAULT_RECLASSIFY_CONCURRENCY))
}

function getReclassifyCandidates(): ReclassifyCandidate[] {
  const legacyPlaceholders = LEGACY_DOC_TYPE_NAMES.map(() => '?').join(', ')
  return queryAll<ReclassifyCandidate>(
    `SELECT DISTINCT d.id, d.title, d.doc_type, d.metadata_status
     FROM documents d
     LEFT JOIN document_tags dt ON dt.doc_id = d.id
     LEFT JOIN tags t ON t.id = dt.tag_id
     WHERE EXISTS (
         SELECT 1 FROM pages p
         WHERE p.doc_id = d.id
           AND TRIM(COALESCE(p.proofed_text, p.ocr_text, '')) != ''
       )
       AND (
         d.doc_type IS NULL
         OR d.doc_type = ''
         OR d.doc_type = 'unknown'
         OR d.doc_type = '其他'
         OR d.doc_type IN (${legacyPlaceholders})
         OR t.name IN (${legacyPlaceholders})
       )
     ORDER BY d.updated_at DESC, d.created_at DESC`,
    [...LEGACY_DOC_TYPE_NAMES, ...LEGACY_DOC_TYPE_NAMES],
  )
}

export function scheduleStartupMetadataReclassification(): void {
  if (hasCompletedReclassification()) return
  if (!hasLlmConfig()) {
    console.log('[MetadataReclassifier] LLM API key is not configured; startup reclassification is deferred.')
    return
  }

  const candidates = getReclassifyCandidates()
  if (candidates.length === 0) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [RECLASSIFY_VERSION, 'completed'])
    saveDatabase()
    return
  }

  console.log(`[MetadataReclassifier] Scheduling AI reclassification for ${candidates.length} legacy documents.`)
  setTimeout(() => {
    void runStartupMetadataReclassification(candidates)
  }, 2500)
}

async function runStartupMetadataReclassification(candidates: ReclassifyCandidate[]): Promise<void> {
  let successCount = 0
  let failedCount = 0
  const concurrency = Math.min(getReclassifyConcurrency(), candidates.length)
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [RECLASSIFY_VERSION, 'running'])
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`${RECLASSIFY_VERSION}:started_at`, new Date().toISOString()])
  saveDatabase()
  emitReclassificationProgress({
    status: 'started',
    totalCount: candidates.length,
    processedCount: 0,
    successCount,
    failedCount,
    concurrency,
  })

  let nextIndex = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex]
      nextIndex += 1

      try {
        await reclassifyAndApplyDocument(candidate.id)
        successCount += 1
        console.log(`[MetadataReclassifier] Reclassified ${successCount}/${candidates.length}: ${candidate.title || candidate.id}`)
      } catch (error) {
        failedCount += 1
        console.warn(`[MetadataReclassifier] Failed to reclassify ${candidate.title || candidate.id}`, error)
      }
      emitReclassificationProgress({
        status: 'progress',
        totalCount: candidates.length,
        processedCount: successCount + failedCount,
        successCount,
        failedCount,
        concurrency,
        currentDocId: candidate.id,
        currentTitle: candidate.title || candidate.id,
      })
    }
  })

  await Promise.all(workers)

  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [RECLASSIFY_VERSION, 'completed'])
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`${RECLASSIFY_VERSION}:completed_at`, new Date().toISOString()])
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`${RECLASSIFY_VERSION}:summary`, JSON.stringify({
    totalCount: candidates.length,
    successCount,
    failedCount,
  })])
  saveDatabase()
  console.log(`[MetadataReclassifier] Completed. success=${successCount}, failed=${failedCount}`)
  emitReclassificationProgress({
    status: 'completed',
    totalCount: candidates.length,
    processedCount: candidates.length,
    successCount,
    failedCount,
    concurrency,
  })
}
