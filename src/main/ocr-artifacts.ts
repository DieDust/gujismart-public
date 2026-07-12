import { nanoid } from 'nanoid'
import { createHash } from 'crypto'
import type { ErrorEnvelope, TaskStatus } from '../shared/types'
import { validateErrorEnvelope } from '../shared/error-envelope'
import { queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { hydratePagePayloadRow, preparePagePayloadUpdate } from './page-payload-store'

interface OcrRunRow {
  id: string
  task_job_id: string | null
  doc_id: string
  engine: string
  status: TaskStatus
  idempotency_key: string | null
  settings_snapshot_json: string
  manifest_json: string
  error_json: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface OcrAttemptRow {
  id: string
  run_id: string
  page_id: string
  attempt_no: number
  status: TaskStatus
  error_json: string | null
  started_at: number
  finished_at: number | null
}

interface OcrArtifactRow {
  id: string
  run_id: string
  attempt_id: string
  doc_id: string
  page_id: string
  page_num: number | null
  engine: string
  ocr_text: string | null
  ocr_text_ref: string | null
  ocr_result: string | null
  ocr_result_ref: string | null
  source_hash: string
  status: 'staged' | 'validated' | 'active' | 'superseded' | 'error'
  idempotency_key: string | null
  created_at: number
  activated_at: number | null
}

export interface OcrRunRecord {
  id: string
  taskJobId: string | null
  docId: string
  engine: string
  status: TaskStatus
  idempotencyKey: string | null
  settingsSnapshot: Record<string, unknown>
  manifest: Record<string, unknown>
  error: ErrorEnvelope | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface OcrPageAttemptRecord {
  id: string
  runId: string
  pageId: string
  attemptNo: number
  status: TaskStatus
  error: ErrorEnvelope | null
  startedAt: number
  finishedAt: number | null
}

export interface OcrArtifactRecord {
  id: string
  runId: string
  attemptId: string
  docId: string
  pageId: string
  pageNum: number | null
  engine: string
  text: string
  result: string | null
  sourceHash: string
  status: OcrArtifactRow['status']
  idempotencyKey: string | null
  createdAt: number
  activatedAt: number | null
}

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseError(value: string | null): ErrorEnvelope | null {
  if (!value) return null
  try {
    return validateErrorEnvelope(parseRecord(value))
  } catch {
    return null
  }
}

function nowValue(value?: number): number {
  const now = value === undefined ? Date.now() : Number(value)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('ocr_time_invalid')
  return now
}

function requiredText(value: unknown, code: string, max = 500): string {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw new Error(code)
  return text
}

function optionalText(value: unknown, code: string, max = 500): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, code, max)
}

function serializeRecord(value: Record<string, unknown> | undefined, code: string): string {
  try {
    const serialized = JSON.stringify(value || {})
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new Error(code)
    return serialized
  } catch {
    throw new Error(code)
  }
}

function toRun(row: OcrRunRow): OcrRunRecord {
  return {
    id: row.id,
    taskJobId: row.task_job_id,
    docId: row.doc_id,
    engine: row.engine,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    settingsSnapshot: parseRecord(row.settings_snapshot_json),
    manifest: parseRecord(row.manifest_json),
    error: parseError(row.error_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  }
}

function toAttempt(row: OcrAttemptRow): OcrPageAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    pageId: row.page_id,
    attemptNo: Number(row.attempt_no),
    status: row.status,
    error: parseError(row.error_json),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  }
}

function toArtifact(row: OcrArtifactRow): OcrArtifactRecord {
  const hydrated = hydratePagePayloadRow(row)
  return {
    id: hydrated.id,
    runId: hydrated.run_id,
    attemptId: hydrated.attempt_id,
    docId: hydrated.doc_id,
    pageId: hydrated.page_id,
    pageNum: hydrated.page_num === null ? null : Number(hydrated.page_num),
    engine: hydrated.engine,
    text: String(hydrated.ocr_text || ''),
    result: hydrated.ocr_result,
    sourceHash: hydrated.source_hash,
    status: hydrated.status,
    idempotencyKey: hydrated.idempotency_key,
    createdAt: Number(hydrated.created_at),
    activatedAt: hydrated.activated_at === null ? null : Number(hydrated.activated_at),
  }
}

export function createOcrRun(input: {
  id?: string
  taskJobId?: string | null
  docId: string
  engine: string
  idempotencyKey?: string | null
  settingsSnapshot?: Record<string, unknown>
  manifest?: Record<string, unknown>
  nowMs?: number
}): OcrRunRecord {
  const docId = requiredText(input.docId, 'ocr_doc_id_invalid')
  const engine = requiredText(input.engine, 'ocr_engine_invalid')
  const key = optionalText(input.idempotencyKey, 'ocr_idempotency_key_invalid')
  if (key) {
    const existing = queryOne<OcrRunRow>('SELECT * FROM ocr_runs WHERE doc_id = ? AND engine = ? AND idempotency_key = ?', [docId, engine, key])
    if (existing) return toRun(existing)
  }
  if (!queryOne('SELECT id FROM documents WHERE id = ?', [docId])) throw new Error('ocr_document_not_found')
  const now = nowValue(input.nowMs)
  const id = optionalText(input.id, 'ocr_run_id_invalid') || `ocr_run_${nanoid(20)}`
  run(
    `INSERT INTO ocr_runs (id, task_job_id, doc_id, engine, status, idempotency_key, settings_snapshot_json, manifest_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    [id, input.taskJobId || null, docId, engine, key, serializeRecord(input.settingsSnapshot, 'ocr_settings_invalid'), serializeRecord(input.manifest, 'ocr_manifest_invalid'), now, now],
  )
  scheduleDatabaseSave()
  const created = queryOne<OcrRunRow>('SELECT * FROM ocr_runs WHERE id = ?', [id])
  if (!created) throw new Error('ocr_run_not_found')
  return toRun(created)
}

export function startOcrPageAttempt(input: { runId: string; pageId: string; nowMs?: number }): OcrPageAttemptRecord {
  const runId = requiredText(input.runId, 'ocr_run_id_invalid')
  const pageId = requiredText(input.pageId, 'ocr_page_id_invalid')
  const runRow = queryOne<OcrRunRow>('SELECT * FROM ocr_runs WHERE id = ?', [runId])
  if (!runRow) throw new Error('ocr_run_not_found')
  if (runRow.status === 'completed' || runRow.status === 'canceled') throw new Error('ocr_run_terminal')
  const page = queryOne<{ doc_id: string }>('SELECT doc_id FROM pages WHERE id = ?', [pageId])
  if (!page || page.doc_id !== runRow.doc_id) throw new Error('ocr_page_run_mismatch')
  const now = nowValue(input.nowMs)
  const attemptNo = Number(queryOne<{ value: number }>('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS value FROM ocr_page_attempts WHERE run_id = ? AND page_id = ?', [runId, pageId])?.value || 1)
  const id = `ocr_attempt_${nanoid(20)}`
  transaction(() => {
    run(
      `INSERT INTO ocr_page_attempts (id, run_id, page_id, attempt_no, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [id, runId, pageId, attemptNo, now],
    )
    run("UPDATE ocr_runs SET status = 'running', updated_at = ? WHERE id = ?", [now, runId])
  })
  scheduleDatabaseSave()
  const created = queryOne<OcrAttemptRow>('SELECT * FROM ocr_page_attempts WHERE id = ?', [id])
  if (!created) throw new Error('ocr_attempt_not_found')
  return toAttempt(created)
}

export function commitOcrArtifact(input: {
  runId: string
  attemptId: string
  pageId: string
  text: string
  result: unknown
  sourceHash: string
  idempotencyKey?: string | null
  nowMs?: number
}): OcrArtifactRecord {
  const runId = requiredText(input.runId, 'ocr_run_id_invalid')
  const attemptId = requiredText(input.attemptId, 'ocr_attempt_id_invalid')
  const pageId = requiredText(input.pageId, 'ocr_page_id_invalid')
  const key = optionalText(input.idempotencyKey, 'ocr_idempotency_key_invalid')
  const sourceHash = requiredText(input.sourceHash, 'ocr_source_hash_invalid', 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('ocr_source_hash_invalid')
  if (key) {
    const existing = queryOne<OcrArtifactRow>('SELECT * FROM ocr_artifact_versions WHERE run_id = ? AND idempotency_key = ?', [runId, key])
    if (existing) {
      if (existing.source_hash !== sourceHash || existing.page_id !== pageId) throw new Error('ocr_artifact_immutable')
      return toArtifact(existing)
    }
  }
  const runRow = queryOne<OcrRunRow>('SELECT * FROM ocr_runs WHERE id = ?', [runId])
  const attempt = queryOne<OcrAttemptRow>('SELECT * FROM ocr_page_attempts WHERE id = ?', [attemptId])
  const page = queryOne<{
    id: string
    doc_id: string
    page_num: number | null
    proofed_text: string | null
    proof_status: string
    active_ocr_artifact_id: string | null
    proof_base_artifact_id: string | null
  }>('SELECT id, doc_id, page_num, proofed_text, proof_status, active_ocr_artifact_id, proof_base_artifact_id FROM pages WHERE id = ?', [pageId])
  if (!runRow) throw new Error('ocr_run_not_found')
  if (!attempt || attempt.run_id !== runId || attempt.page_id !== pageId) throw new Error('ocr_attempt_run_mismatch')
  if (attempt.status !== 'running') throw new Error('ocr_attempt_not_running')
  if (!page || page.doc_id !== runRow.doc_id) throw new Error('ocr_page_run_mismatch')
  const now = nowValue(input.nowMs)
  const artifactId = `ocr_artifact_${nanoid(20)}`
  const resultJson = input.result === undefined || input.result === null
    ? null
    : typeof input.result === 'string' ? input.result : JSON.stringify(input.result)
  const preparedText = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_text', String(input.text || ''))
  const preparedResult = preparePagePayloadUpdate(page.doc_id, pageId, 'ocr_result', resultJson)
  const hasProof = String(page.proofed_text || '').trim().length > 0
  const proofStale = hasProof && page.active_ocr_artifact_id !== artifactId
  transaction(() => {
    run(
      `INSERT INTO ocr_artifact_versions
       (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref,
        source_hash, status, idempotency_key, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [artifactId, runId, attemptId, page.doc_id, pageId, page.page_num, runRow.engine, preparedText.value, preparedText.ref, preparedResult.value, preparedResult.ref, sourceHash, key, now, now],
    )
    run("UPDATE ocr_artifact_versions SET status = 'superseded' WHERE page_id = ? AND id <> ? AND status = 'active'", [pageId, artifactId])
    run(
      `INSERT INTO ocr_page_active_artifacts (page_id, artifact_id, activated_at) VALUES (?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET artifact_id = excluded.artifact_id, activated_at = excluded.activated_at`,
      [pageId, artifactId, now],
    )
    run(
      `UPDATE pages SET ocr_text = ?, ocr_text_ref = ?, ocr_result = ?, ocr_result_ref = ?,
       active_ocr_artifact_id = ?, proof_base_stale = ?, ocr_status = 'completed' WHERE id = ?`,
      [preparedText.value, preparedText.ref, preparedResult.value, preparedResult.ref, artifactId, proofStale ? 1 : 0, pageId],
    )
    run("UPDATE ocr_page_attempts SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'", [now, attemptId])
    run("UPDATE ocr_runs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, runId])
  })
  scheduleDatabaseSave()
  const created = queryOne<OcrArtifactRow>('SELECT * FROM ocr_artifact_versions WHERE id = ?', [artifactId])
  if (!created) throw new Error('ocr_artifact_not_found')
  return toArtifact(created)
}

export function failOcrPageAttempt(input: { attemptId: string; error: ErrorEnvelope; nowMs?: number }): OcrPageAttemptRecord {
  const attemptId = requiredText(input.attemptId, 'ocr_attempt_id_invalid')
  const attempt = queryOne<OcrAttemptRow>('SELECT * FROM ocr_page_attempts WHERE id = ?', [attemptId])
  if (!attempt) throw new Error('ocr_attempt_not_found')
  if (attempt.status !== 'running') throw new Error('ocr_attempt_not_running')
  const now = nowValue(input.nowMs)
  const error = JSON.stringify(validateErrorEnvelope(input.error))
  transaction(() => {
    run("UPDATE ocr_page_attempts SET status = 'error', error_json = ?, finished_at = ? WHERE id = ?", [error, now, attemptId])
    run("UPDATE ocr_runs SET status = 'error', error_json = ?, completed_at = ?, updated_at = ? WHERE id = ?", [error, now, now, attempt.run_id])
  })
  scheduleDatabaseSave()
  const failed = queryOne<OcrAttemptRow>('SELECT * FROM ocr_page_attempts WHERE id = ?', [attemptId])
  if (!failed) throw new Error('ocr_attempt_not_found')
  return toAttempt(failed)
}

export function recordCompatibilityOcrArtifacts(
  items: Array<{ pageId: string; engine: string; text: string; result: unknown }>,
  options?: { nowMs?: number },
): OcrArtifactRecord[] {
  if (items.length === 0) return []
  if (items.length > 200) throw new Error('ocr_artifact_batch_too_large')
  const now = nowValue(options?.nowMs)
  const seen = new Set<string>()
  const prepared = items.flatMap((item) => {
    const page = queryOne<{
      id: string
      doc_id: string
      page_num: number | null
      proofed_text: string | null
      active_ocr_artifact_id: string | null
    }>('SELECT id, doc_id, page_num, proofed_text, active_ocr_artifact_id FROM pages WHERE id = ?', [item.pageId])
    if (!page) return []
    const engine = requiredText(item.engine, 'ocr_engine_invalid')
    const resultJson = item.result === undefined || item.result === null
      ? null
      : typeof item.result === 'string' ? item.result : JSON.stringify(item.result)
    const text = String(item.text || '')
    const sourceHash = createHash('sha256').update(text, 'utf8').update('\0').update(resultJson || '', 'utf8').digest('hex')
    const batchKey = `${page.id}\0${engine}\0${sourceHash}`
    if (seen.has(batchKey)) return []
    seen.add(batchKey)
    const existing = queryOne<OcrArtifactRow>(
      `SELECT * FROM ocr_artifact_versions
       WHERE page_id = ? AND engine = ? AND source_hash = ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [page.id, engine, sourceHash],
    )
    return [{
      page,
      engine,
      text,
      resultJson,
      sourceHash,
      existing,
      preparedText: preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_text', text),
      preparedResult: preparePagePayloadUpdate(page.doc_id, page.id, 'ocr_result', resultJson),
    }]
  })
  if (prepared.length === 0) return []
  const artifactIds: string[] = []
  transaction(() => {
    prepared.forEach((item) => {
      if (item.existing) {
        const artifactId = item.existing.id
        if (item.existing.status !== 'active' || item.page.active_ocr_artifact_id !== artifactId) {
          run("UPDATE ocr_artifact_versions SET status = 'superseded' WHERE page_id = ? AND id <> ? AND status = 'active'", [item.page.id, artifactId])
          run("UPDATE ocr_artifact_versions SET status = 'active', activated_at = ? WHERE id = ?", [now, artifactId])
          run(
            `INSERT INTO ocr_page_active_artifacts (page_id, artifact_id, activated_at) VALUES (?, ?, ?)
             ON CONFLICT(page_id) DO UPDATE SET artifact_id = excluded.artifact_id, activated_at = excluded.activated_at`,
            [item.page.id, artifactId, now],
          )
          run(
            `UPDATE pages SET ocr_text = ?, ocr_text_ref = ?, ocr_result = ?, ocr_result_ref = ?,
             active_ocr_artifact_id = ?, ocr_status = 'completed',
             proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
             WHERE id = ?`,
            [
              item.existing.ocr_text,
              item.existing.ocr_text_ref,
              item.existing.ocr_result,
              item.existing.ocr_result_ref,
              artifactId,
              item.page.id,
            ],
          )
        }
        artifactIds.push(artifactId)
        return
      }
      const runId = `ocr_run_${nanoid(20)}`
      const attemptId = `ocr_attempt_${nanoid(20)}`
      const artifactId = `ocr_artifact_${nanoid(20)}`
      const runKey = `compat:${item.page.id}:${item.sourceHash}`
      run(
        `INSERT INTO ocr_runs
         (id, doc_id, engine, status, idempotency_key, settings_snapshot_json, manifest_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'completed', ?, '{}', ?, ?, ?, ?)`,
        [runId, item.page.doc_id, item.engine, runKey, JSON.stringify({ compatibilityProjection: true }), now, now, now],
      )
      run(
        `INSERT INTO ocr_page_attempts (id, run_id, page_id, attempt_no, status, started_at, finished_at)
         VALUES (?, ?, ?, 1, 'completed', ?, ?)`,
        [attemptId, runId, item.page.id, now, now],
      )
      run(
        `INSERT INTO ocr_artifact_versions
         (id, run_id, attempt_id, doc_id, page_id, page_num, engine, ocr_text, ocr_text_ref, ocr_result, ocr_result_ref,
          source_hash, status, idempotency_key, created_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          artifactId,
          runId,
          attemptId,
          item.page.doc_id,
          item.page.id,
          item.page.page_num,
          item.engine,
          item.preparedText.value,
          item.preparedText.ref,
          item.preparedResult.value,
          item.preparedResult.ref,
          item.sourceHash,
          `compat:${item.sourceHash}`,
          now,
          now,
        ],
      )
      run("UPDATE ocr_artifact_versions SET status = 'superseded' WHERE page_id = ? AND id <> ? AND status = 'active'", [item.page.id, artifactId])
      run(
        `INSERT INTO ocr_page_active_artifacts (page_id, artifact_id, activated_at) VALUES (?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET artifact_id = excluded.artifact_id, activated_at = excluded.activated_at`,
        [item.page.id, artifactId, now],
      )
      run(
        `UPDATE pages SET active_ocr_artifact_id = ?,
         proof_base_stale = CASE WHEN TRIM(COALESCE(proofed_text, '')) <> '' THEN 1 ELSE proof_base_stale END
         WHERE id = ?`,
        [artifactId, item.page.id],
      )
      artifactIds.push(artifactId)
    })
  })
  scheduleDatabaseSave()
  return artifactIds.map((id) => {
    const artifact = queryOne<OcrArtifactRow>('SELECT * FROM ocr_artifact_versions WHERE id = ?', [id])
    if (!artifact) throw new Error('ocr_artifact_not_found')
    return toArtifact(artifact)
  })
}
