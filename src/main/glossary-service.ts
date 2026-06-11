import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import { queryAll, queryOne, run, saveDatabase, transaction } from './database'
import type {
  ActiveTranslationGlossaryPayload,
  ActiveTranslationGlossaryResult,
  TranslationGlossaryListOptions,
  TranslationGlossaryScope,
  TranslationGlossaryTerm,
  TranslationGlossaryTermPayload,
} from '../shared/types'

export interface TranslationGlossary {
  id: string
  name: string
  scope: TranslationGlossaryScope
  project_id: string | null
  created_at: string
  updated_at: string
}

const GLOBAL_GLOSSARY_ID = 'glossary_global_default'
const GLOBAL_GLOSSARY_NAME = '全局术语表'

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeTerm(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeProjectId(value: unknown): string {
  return String(value || '').trim()
}

function hashParts(parts: string[]): string {
  const hash = createHash('sha256')
  parts.forEach((part) => {
    hash.update(part)
    hash.update('\u0000')
  })
  return hash.digest('hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(value)
}

function termMatchesText(term: TranslationGlossaryTerm, text: string): boolean {
  const source = normalizeTerm(term.source_term)
  if (!source || !text) return false
  if (hasCjk(source)) return text.includes(source)
  if (term.case_sensitive) {
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(source)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(text)
  }
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(source)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text)
}

function getProjectGlossaryId(projectId: string): string {
  return `glossary_project_${projectId}`
}

function requireQueryResult<T>(value: T | null, message: string): T {
  if (!value) throw new Error(message)
  return value
}

export function ensureGlobalGlossary(): TranslationGlossary {
  const existing = queryOne<TranslationGlossary>('SELECT * FROM translation_glossaries WHERE id = ?', [GLOBAL_GLOSSARY_ID])
  if (existing) return existing
  const now = nowIso()
  run(
    'INSERT OR IGNORE INTO translation_glossaries (id, name, scope, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [GLOBAL_GLOSSARY_ID, GLOBAL_GLOSSARY_NAME, 'global', null, now, now],
  )
  saveDatabase()
  return requireQueryResult(
    queryOne<TranslationGlossary>('SELECT * FROM translation_glossaries WHERE id = ?', [GLOBAL_GLOSSARY_ID]),
    'Failed to load global translation glossary after creation.',
  )
}

export function ensureProjectGlossary(projectId: string): TranslationGlossary {
  const safeProjectId = normalizeProjectId(projectId)
  if (!safeProjectId) throw new Error('缺少研究项目')
  const id = getProjectGlossaryId(safeProjectId)
  const existing = queryOne<TranslationGlossary>('SELECT * FROM translation_glossaries WHERE id = ?', [id])
  if (existing) return existing
  const project = queryOne<{ name: string }>('SELECT name FROM research_projects WHERE id = ?', [safeProjectId])
  if (!project) throw new Error('研究项目不存在')
  const now = nowIso()
  run(
    'INSERT OR IGNORE INTO translation_glossaries (id, name, scope, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, `${project.name || '研究项目'}术语表`, 'project', safeProjectId, now, now],
  )
  saveDatabase()
  return requireQueryResult(
    queryOne<TranslationGlossary>('SELECT * FROM translation_glossaries WHERE id = ?', [id]),
    'Failed to load project translation glossary after creation.',
  )
}

function getGlossaryForPayload(payload: TranslationGlossaryTermPayload): TranslationGlossary {
  if (payload.glossaryId) {
    const glossary = queryOne<TranslationGlossary>('SELECT * FROM translation_glossaries WHERE id = ?', [payload.glossaryId])
    if (!glossary) throw new Error('术语表不存在')
    return glossary
  }
  if (payload.scope === 'project' || payload.projectId) return ensureProjectGlossary(normalizeProjectId(payload.projectId))
  return ensureGlobalGlossary()
}

export function listTranslationGlossaryTerms(payload: TranslationGlossaryListOptions = {}): TranslationGlossaryTerm[] {
  ensureGlobalGlossary()
  const params: unknown[] = []
  const where: string[] = []
  if (!payload.includeDisabled) where.push('t.enabled = 1')
  if (payload.scope === 'global') {
    where.push("g.scope = 'global'")
  } else if (payload.scope === 'project') {
    where.push("g.scope = 'project'")
    const projectId = normalizeProjectId(payload.projectId)
    if (projectId) {
      where.push('g.project_id = ?')
      params.push(projectId)
    }
  }
  const search = normalizeTerm(payload.search)
  if (search) {
    where.push('(t.source_term LIKE ? OR t.target_term LIKE ? OR t.note LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  const sql = `
    SELECT t.*, g.scope, g.project_id, g.name as glossary_name
    FROM translation_glossary_terms t
    INNER JOIN translation_glossaries g ON g.id = t.glossary_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY g.scope ASC, t.updated_at DESC, t.source_term ASC
  `
  return queryAll<TranslationGlossaryTerm>(sql, params)
}

export function upsertTranslationGlossaryTerm(payload: TranslationGlossaryTermPayload): TranslationGlossaryTerm {
  const sourceTerm = normalizeTerm(payload.sourceTerm)
  const targetTerm = normalizeTerm(payload.targetTerm)
  if (!sourceTerm || !targetTerm) throw new Error('请填写原词和建议译名')

  const glossary = getGlossaryForPayload(payload)
  const now = nowIso()
  const enabled = payload.enabled === false ? 0 : 1
  const caseSensitive = payload.caseSensitive ? 1 : 0
  const note = String(payload.note || '').trim()
  const id = String(payload.id || '').trim() || nanoid()

  transaction(() => {
    const existing = payload.id
      ? queryOne<TranslationGlossaryTerm>('SELECT * FROM translation_glossary_terms WHERE id = ?', [payload.id])
      : null
    if (existing) {
      run(
        `UPDATE translation_glossary_terms
         SET glossary_id = ?, source_term = ?, target_term = ?, note = ?, enabled = ?, case_sensitive = ?, updated_at = ?
         WHERE id = ?`,
        [glossary.id, sourceTerm, targetTerm, note, enabled, caseSensitive, now, id],
      )
    } else {
      run(
        `INSERT INTO translation_glossary_terms (
          id, glossary_id, source_term, target_term, note, enabled, case_sensitive, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, glossary.id, sourceTerm, targetTerm, note, enabled, caseSensitive, now, now],
      )
    }
    run('UPDATE translation_glossaries SET updated_at = ? WHERE id = ?', [now, glossary.id])
  })
  saveDatabase()
  return requireQueryResult(
    queryOne<TranslationGlossaryTerm>(
      `SELECT t.*, g.scope, g.project_id, g.name as glossary_name
       FROM translation_glossary_terms t
       INNER JOIN translation_glossaries g ON g.id = t.glossary_id
       WHERE t.id = ?`,
      [id],
    ),
    'Failed to load translation glossary term after write.',
  )
}

export function deleteTranslationGlossaryTerm(id: string): boolean {
  const term = queryOne<TranslationGlossaryTerm>('SELECT * FROM translation_glossary_terms WHERE id = ?', [id])
  if (!term) return false
  transaction(() => {
    run('DELETE FROM translation_glossary_terms WHERE id = ?', [id])
    run('UPDATE translation_glossaries SET updated_at = ? WHERE id = ?', [nowIso(), term.glossary_id])
  })
  saveDatabase()
  return true
}

function getCandidateTerms(projectId?: string | null): TranslationGlossaryTerm[] {
  ensureGlobalGlossary()
  const safeProjectId = normalizeProjectId(projectId)
  if (safeProjectId) {
    ensureProjectGlossary(safeProjectId)
    return queryAll<TranslationGlossaryTerm>(
      `SELECT t.*, g.scope, g.project_id, g.name as glossary_name
       FROM translation_glossary_terms t
       INNER JOIN translation_glossaries g ON g.id = t.glossary_id
       WHERE t.enabled = 1 AND (g.scope = 'global' OR g.project_id = ?)
       ORDER BY CASE WHEN g.scope = 'project' THEN 0 ELSE 1 END, LENGTH(t.source_term) DESC`,
      [safeProjectId],
    )
  }
  return queryAll<TranslationGlossaryTerm>(
    `SELECT t.*, g.scope, g.project_id, g.name as glossary_name
     FROM translation_glossary_terms t
     INNER JOIN translation_glossaries g ON g.id = t.glossary_id
     WHERE t.enabled = 1 AND g.scope = 'global'
     ORDER BY LENGTH(t.source_term) DESC`,
  )
}

export function getActiveTranslationGlossary(payload: ActiveTranslationGlossaryPayload = {}): ActiveTranslationGlossaryResult {
  const text = String(payload.text || '')
  const seen = new Set<string>()
  const matched: TranslationGlossaryTerm[] = []
  for (const term of getCandidateTerms(payload.projectId)) {
    const key = term.case_sensitive ? term.source_term : term.source_term.toLowerCase()
    if (seen.has(key)) continue
    if (!termMatchesText(term, text)) continue
    seen.add(key)
    matched.push(term)
    if (matched.length >= 80) break
  }
  const signature = hashParts([
    normalizeProjectId(payload.projectId) || 'global-only',
    ...matched.map((term) => [
      term.scope || '',
      term.project_id || '',
      term.source_term,
      term.target_term,
      term.note || '',
      String(term.case_sensitive || 0),
      term.updated_at || '',
    ].join('|')),
  ])
  const promptBlock = matched.length
    ? [
        '术语表优先译名（如语境明显不合适，可谨慎调整；同一原词在本次翻译中应保持一致）：',
        ...matched.map((term) => {
          const note = String(term.note || '').trim()
          return `${term.source_term} => ${term.target_term}${note ? `；${note}` : ''}`
        }),
      ].join('\n')
    : ''
  return { terms: matched, signature, promptBlock }
}

export function getTranslationGlossaryVersionSignature(projectId?: string | null): string {
  const terms = getCandidateTerms(projectId)
  return hashParts([
    normalizeProjectId(projectId) || 'global-only',
    ...terms.map((term) => [
      term.scope || '',
      term.project_id || '',
      term.source_term,
      term.target_term,
      term.note || '',
      String(term.enabled || 0),
      String(term.case_sensitive || 0),
      term.updated_at || '',
    ].join('|')),
  ])
}
