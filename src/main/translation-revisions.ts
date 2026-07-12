import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import type {
  CursorPage,
  StableReaderLocator,
  TranslationAttempt,
  TranslationContextSnapshot,
  TranslationMode,
  TranslationRevisionCommitResult,
  TranslationUnitRevision,
} from '../shared/types'
import { validateStableReaderLocator } from '../shared/stable-reader-locator'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'

type UnitProjection = {
  unit_id: string
  doc_id: string
  page_id: string
  block_id: string
  source_hash: string
  translation_text: string
  manual_override: number
  quality_json: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function required(value: unknown, code: string): string {
  const text = String(value || '').trim()
  if (!text) throw new Error(code)
  return text
}

function getUnit(unitIdValue: string): UnitProjection {
  const unitId = required(unitIdValue, 'translation_unit_required')
  const unit = queryOne<UnitProjection>(
    `SELECT unit_id, doc_id, page_id, block_id, source_hash, translation_text, manual_override, quality_json
       FROM page_translation_units WHERE unit_id = ? AND target_language = 'zh-CN'`,
    [unitId],
  )
  if (!unit) throw new Error('translation_unit_not_found')
  return unit
}

function nextRevision(unitId: string): number {
  return Number(queryOne<{ revision: number }>('SELECT MAX(revision) AS revision FROM translation_unit_revisions WHERE unit_id = ?', [unitId])?.revision || 0) + 1
}

export function getActiveTranslationRevision(unitIdValue: string): TranslationUnitRevision | null {
  const unitId = required(unitIdValue, 'translation_unit_required')
  return queryOne<TranslationUnitRevision>(
    "SELECT * FROM translation_unit_revisions WHERE unit_id = ? AND status = 'active'",
    [unitId],
  )
}

export function ensureActiveTranslationRevision(unitIdValue: string): TranslationUnitRevision {
  const unit = getUnit(unitIdValue)
  const active = getActiveTranslationRevision(unit.unit_id)
  if (active && active.content_hash === sha256(unit.translation_text || '')) return active
  const id = `translation_revision_${nanoid(20)}`
  const now = Date.now()
  transaction(() => {
    if (active) run("UPDATE translation_unit_revisions SET status = 'superseded' WHERE id = ? AND status = 'active'", [active.id])
    run(
      `INSERT INTO translation_unit_revisions
       (id, unit_id, revision, parent_revision_id, context_snapshot_id, source_hash, translation_text, origin, status, content_hash, quality_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'active', ?, ?, ?)`,
      [id, unit.unit_id, active ? nextRevision(unit.unit_id) : 1, active?.id || null, unit.source_hash, unit.translation_text || '',
        unit.manual_override ? 'manual' : 'legacy', sha256(unit.translation_text || ''), unit.quality_json || '{}', now],
    )
  })
  scheduleDatabaseSave()
  return queryOne<TranslationUnitRevision>('SELECT * FROM translation_unit_revisions WHERE id = ?', [id])!
}

export function createTranslationContextSnapshot(input: {
  unitId: string
  contentVersion: string
  canonicalSourceHash: string
  sourceLocator: StableReaderLocator
  mode: TranslationMode
  style: string
  providerId: string
  model: string
  modelSignature: string
  parameters: Record<string, unknown>
  glossaryVersion: string
  promptVersion: string
  protectorVersion: string
  normalizerVersion: string
}): TranslationContextSnapshot {
  const unit = getUnit(input.unitId)
  const locator = validateStableReaderLocator(input.sourceLocator)
  if (locator.documentId !== unit.doc_id || locator.sourcePageId !== unit.page_id) throw new Error('translation_context_locator_mismatch')
  const contextCore = {
    unitId: unit.unit_id,
    docId: unit.doc_id,
    pageId: unit.page_id,
    unitSourceHash: unit.source_hash,
    canonicalSourceHash: required(input.canonicalSourceHash, 'translation_context_source_hash_required'),
    contentVersion: required(input.contentVersion, 'translation_context_content_version_required'),
    sourceLocator: locator,
    targetLanguage: 'zh-CN',
    mode: input.mode,
    style: required(input.style, 'translation_context_style_required'),
    providerId: required(input.providerId, 'translation_context_provider_required'),
    model: required(input.model, 'translation_context_model_required'),
    modelSignature: required(input.modelSignature, 'translation_context_model_signature_required'),
    parametersHash: sha256(stableJson(input.parameters || {})),
    glossaryVersion: required(input.glossaryVersion, 'translation_context_glossary_required'),
    promptVersion: required(input.promptVersion, 'translation_context_prompt_required'),
    protectorVersion: required(input.protectorVersion, 'translation_context_protector_required'),
    normalizerVersion: required(input.normalizerVersion, 'translation_context_normalizer_required'),
  }
  const contextHash = sha256(stableJson(contextCore))
  let snapshot = queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE context_hash = ?', [contextHash])
  if (snapshot) return snapshot
  const id = `translation_context_${nanoid(20)}`
  run(
    `INSERT INTO translation_context_snapshots
     (id, context_hash, unit_id, doc_id, page_id, unit_source_hash, canonical_source_hash, content_version, source_locator_json,
      target_language, mode, style, provider_id, model, model_signature, parameters_hash, glossary_version, prompt_version, protector_version, normalizer_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'zh-CN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, contextHash, unit.unit_id, unit.doc_id, unit.page_id, unit.source_hash, contextCore.canonicalSourceHash,
      contextCore.contentVersion, stableJson(locator), input.mode, contextCore.style, contextCore.providerId, contextCore.model,
      contextCore.modelSignature, contextCore.parametersHash, contextCore.glossaryVersion, contextCore.promptVersion, contextCore.protectorVersion,
      contextCore.normalizerVersion, Date.now()],
  )
  scheduleDatabaseSave()
  snapshot = queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE id = ?', [id])
  if (!snapshot) throw new Error('translation_context_create_failed')
  return snapshot
}

export function beginTranslationAttempt(input: { taskId: string; unitId: string; contextSnapshotId: string }): TranslationAttempt {
  const unit = getUnit(input.unitId)
  const snapshot = queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE id = ? AND unit_id = ?', [input.contextSnapshotId, unit.unit_id])
  if (!snapshot || snapshot.unit_source_hash !== unit.source_hash) throw new Error('translation_context_stale')
  const active = ensureActiveTranslationRevision(unit.unit_id)
  const id = `translation_attempt_${nanoid(20)}`
  run(
    `INSERT INTO translation_attempts
     (id, task_id, unit_id, context_snapshot_id, base_revision_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [id, required(input.taskId, 'translation_task_required'), unit.unit_id, snapshot.id, active.id, Date.now()],
  )
  scheduleDatabaseSave()
  return queryOne<TranslationAttempt>('SELECT * FROM translation_attempts WHERE id = ?', [id])!
}

export function commitManualTranslationRevision(input: {
  unitId: string
  translationText: string
  expectedRevisionId?: string | null
  manualOverride?: boolean
}): TranslationUnitRevision {
  const unit = getUnit(input.unitId)
  const active = ensureActiveTranslationRevision(unit.unit_id)
  if (input.expectedRevisionId && active.id !== input.expectedRevisionId) throw new Error('translation_revision_conflict')
  const translationText = required(input.translationText, 'translation_text_required')
  const id = `translation_revision_${nanoid(20)}`
  const revision = nextRevision(unit.unit_id)
  const now = Date.now()
  transaction(() => {
    run("UPDATE translation_unit_revisions SET status = 'superseded' WHERE id = ? AND status = 'active'", [active.id])
    run(
      `INSERT INTO translation_unit_revisions
       (id, unit_id, revision, parent_revision_id, context_snapshot_id, source_hash, translation_text, origin, status, content_hash, quality_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 'manual', 'active', ?, '{}', ?)`,
      [id, unit.unit_id, revision, active.id, unit.source_hash, translationText, sha256(translationText), now],
    )
    run(
      `UPDATE page_translation_units SET translation_text = ?, manual_override = 1, stale = 0, status = 'ready', updated_at = ?
       WHERE unit_id = ? AND target_language = 'zh-CN'`,
      [translationText, new Date(now).toISOString(), unit.unit_id],
    )
    if (input.manualOverride === false) {
      run("UPDATE page_translation_units SET manual_override = 0 WHERE unit_id = ? AND target_language = 'zh-CN'", [unit.unit_id])
    }
  })
  scheduleDatabaseSave()
  return queryOne<TranslationUnitRevision>('SELECT * FROM translation_unit_revisions WHERE id = ?', [id])!
}

export function commitMachineTranslationAttempt(input: {
  attemptId: string
  translationText: string
  quality: Record<string, unknown>
}): TranslationRevisionCommitResult {
  const attempt = queryOne<TranslationAttempt>('SELECT * FROM translation_attempts WHERE id = ?', [required(input.attemptId, 'translation_attempt_required')])
  if (!attempt || attempt.status !== 'running') throw new Error('translation_attempt_not_running')
  const snapshot = queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE id = ?', [attempt.context_snapshot_id])
  if (!snapshot) throw new Error('translation_context_not_found')
  const unit = getUnit(attempt.unit_id)
  const active = ensureActiveTranslationRevision(unit.unit_id)
  const translationText = required(input.translationText, 'translation_text_required')
  const committed = active.id === attempt.base_revision_id && unit.source_hash === snapshot.unit_source_hash && !unit.manual_override
  const id = `translation_revision_${nanoid(20)}`
  const revision = nextRevision(unit.unit_id)
  const now = Date.now()
  const qualityJson = stableJson(input.quality || {})
  transaction(() => {
    if (committed) run("UPDATE translation_unit_revisions SET status = 'superseded' WHERE id = ? AND status = 'active'", [active.id])
    run(
      `INSERT INTO translation_unit_revisions
       (id, unit_id, revision, parent_revision_id, context_snapshot_id, source_hash, translation_text, origin, status, content_hash, quality_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'machine', ?, ?, ?, ?)`,
      [id, unit.unit_id, revision, attempt.base_revision_id, snapshot.id, snapshot.unit_source_hash, translationText,
        committed ? 'active' : 'detached', sha256(translationText), qualityJson, now],
    )
    if (committed) {
      run(
        `UPDATE page_translation_units
         SET translation_text = ?, mode = ?, model_signature = ?, glossary_signature = ?, status = 'ready', stale = 0,
             quality_json = ?, updated_at = ?
         WHERE unit_id = ? AND target_language = 'zh-CN' AND source_hash = ? AND manual_override = 0`,
        [translationText, snapshot.mode, snapshot.model_signature, snapshot.glossary_version, qualityJson, new Date(now).toISOString(),
          unit.unit_id, snapshot.unit_source_hash],
      )
    }
    run(
      `UPDATE translation_attempts SET status = ?, candidate_revision_id = ?, completed_at = ? WHERE id = ? AND status = 'running'`,
      [committed ? 'committed' : 'conflict', id, now, attempt.id],
    )
  })
  scheduleDatabaseSave()
  const created = queryOne<TranslationUnitRevision>('SELECT * FROM translation_unit_revisions WHERE id = ?', [id])!
  return { outcome: committed ? 'committed' : 'conflict', revision: created, activeRevisionId: committed ? created.id : active.id }
}

export function failTranslationAttempt(attemptIdValue: string, errorCodeValue: string): void {
  const attemptId = required(attemptIdValue, 'translation_attempt_required')
  const errorCode = required(errorCodeValue, 'translation_attempt_error_required')
  const attempt = queryOne<TranslationAttempt>('SELECT * FROM translation_attempts WHERE id = ?', [attemptId])
  if (!attempt || attempt.status !== 'running') return
  const snapshot = queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE id = ?', [attempt.context_snapshot_id])
  transaction(() => {
    run(
      "UPDATE translation_attempts SET status = 'error', error_code = ?, completed_at = ? WHERE id = ? AND status = 'running'",
      [errorCode, Date.now(), attemptId],
    )
    if (snapshot) {
      run(
        `UPDATE page_translation_units SET status = 'error', stale = CASE WHEN TRIM(COALESCE(translation_text, '')) <> '' THEN 1 ELSE stale END
         WHERE unit_id = ? AND target_language = 'zh-CN' AND source_hash = ? AND manual_override = 0
           AND EXISTS (SELECT 1 FROM translation_unit_revisions WHERE id = ? AND status = 'active')`,
        [attempt.unit_id, snapshot.unit_source_hash, attempt.base_revision_id],
      )
    }
  })
  scheduleDatabaseSave()
}

export function listTranslationRevisions(
  unitIdValue: string,
  options?: { limit?: number; cursor?: string | null },
): CursorPage<TranslationUnitRevision> {
  const unitId = required(unitIdValue, 'translation_unit_required')
  const limit = options?.limit === undefined ? 50 : Number(options.limit)
  const cursor = options?.cursor ? Number(options.cursor) : Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('translation_revision_limit_invalid')
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('translation_revision_cursor_invalid')
  const rows = queryAll<TranslationUnitRevision>(
    'SELECT * FROM translation_unit_revisions WHERE unit_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?',
    [unitId, cursor, limit + 1],
  )
  const page = rows.slice(0, limit)
  return { items: page, nextCursor: rows.length > limit ? String(page[page.length - 1].revision) : null }
}

export function getTranslationContextSnapshot(idValue: string): TranslationContextSnapshot | null {
  const id = required(idValue, 'translation_context_required')
  return queryOne<TranslationContextSnapshot>('SELECT * FROM translation_context_snapshots WHERE id = ?', [id])
}
