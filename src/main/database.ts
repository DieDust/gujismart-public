import { app } from 'electron'
import { basename, dirname, join, normalize, resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import Database from 'better-sqlite3'
import {
  DEFAULT_HISTORY_CITATION_TEMPLATES,
  HISTORY_CITATION_SEED_VERSION,
  HISTORY_CITATION_STYLE,
} from '../shared/history-citation'
import { setPayloadDataDir } from './page-payload-files'

type NativeDatabase = Database.Database

let db: NativeDatabase | null = null
let dbFilePath = ''
let cachedDataDir = ''
let ftsAvailable = false
let searchTrigramFtsAvailable = false
let searchSegmentsFtsNeedsRebuild = false
const TOC_RULE_ENGINE_VERSION = '2026-06-05-ocr-structure-v7'
const DATABASE_CHECKPOINT_MIN_INTERVAL_MS = 2000
const DATABASE_CHECKPOINT_DEFER_MS = 800
const STARTUP_DATABASE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
const LARGE_LIBRARY_AUTOMATIC_MAINTENANCE_PAGE_LIMIT = 100_000
const LARGE_LIBRARY_AUTOMATIC_MAINTENANCE_SEGMENT_LIMIT = 500_000
let deferredDatabaseSaveTimer: ReturnType<typeof setTimeout> | null = null
let lastDatabaseCheckpointAt = 0
const DATABASE_BUSY_TIMEOUT_MS = 250
const DATABASE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200]

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function isDatabaseBusyError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {}
  const code = String(record.code || '')
  const message = String(record.message || error || '')
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(message)
}

function runWithBusyRetry(operation: () => void): void {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= DATABASE_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      operation()
      return
    } catch (error) {
      lastError = error
      if (!isDatabaseBusyError(error) || attempt >= DATABASE_BUSY_RETRY_DELAYS_MS.length) throw error
      sleepSync(DATABASE_BUSY_RETRY_DELAYS_MS[attempt])
    }
  }
  throw lastError
}

function checkpointDatabase(options?: { retryBusy?: boolean }): boolean {
  if (!db) return false
  try {
    if (options?.retryBusy) {
      runWithBusyRetry(() => db?.pragma('wal_checkpoint(PASSIVE)'))
    } else {
      db.pragma('wal_checkpoint(PASSIVE)')
    }
    lastDatabaseCheckpointAt = Date.now()
    return true
  } catch (error) {
    if (isDatabaseBusyError(error)) return false
    throw error
  }
}

function canWriteToDirectory(dir: string): boolean {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const probePath = join(dir, '.write-test')
    writeFileSync(probePath, 'ok')
    unlinkSync(probePath)
    return true
  } catch {
    return false
  }
}

function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

function hasUserDatabase(dir: string): boolean {
  return existsSync(join(dir, 'db', 'gujismart.db')) || existsSync(join(dir, 'db', 'gujismart.json'))
}

function hasUserStorage(dir: string): boolean {
  const storageDir = join(dir, 'storage')
  try {
    return existsSync(storageDir) && readdirSync(storageDir).length > 0
  } catch {
    return false
  }
}

function hasUserData(dir: string): boolean {
  return hasUserDatabase(dir) || hasUserStorage(dir)
}

function getDatabaseMtime(dir: string): number {
  const sqlitePath = join(dir, 'db', 'gujismart.db')
  const jsonPath = join(dir, 'db', 'gujismart.json')
  try {
    if (existsSync(sqlitePath)) return statSync(sqlitePath).mtimeMs
    if (existsSync(jsonPath)) return statSync(jsonPath).mtimeMs
  } catch {
    return 0
  }
  return 0
}

function getInstallDataRoot(): string {
  return join(dirname(app.getPath('exe')), 'data')
}

function getPortableDataRoot(): string | null {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()
  return portableDir ? join(portableDir, 'data') : null
}

function getStableAppRoot(): string {
  if (is.dev) return resolve(process.cwd(), 'data')
  return getPortableDataRoot() || getInstallDataRoot()
}

export function resolveProfileDir(): string {
  return join(getStableAppRoot(), 'profile')
}

function getLegacyDataDirs(targetDir: string): string[] {
  if (is.dev) return []

  const legacyNames = Array.from(new Set([
    app.getName(),
    'GujiSmart',
    '文献管理',
    'gujismart',
  ].filter(Boolean)))

  const candidates = [
    getInstallDataRoot(),
    getPortableDataRoot(),
    ...legacyNames.flatMap((name) => [
    join(app.getPath('appData'), name, 'data'),
    join(app.getPath('appData'), name, 'data', 'profile', 'data'),
    ]),
  ].filter((dir): dir is string => Boolean(dir))

  const target = resolve(targetDir).toLowerCase()
  return Array.from(new Set(candidates))
    .filter((dir) => resolve(dir).toLowerCase() !== target)
}

function migrateLegacyDataIfNeeded(targetDir: string): void {
  const sourceDir = getLegacyDataDirs(targetDir)
    .filter((dir) => existsSync(dir) && hasUserData(dir))
    .sort((left, right) => getDatabaseMtime(right) - getDatabaseMtime(left))[0]

  if (hasUserData(targetDir)) {
    if (hasUserDatabase(targetDir) && !hasUserStorage(targetDir) && sourceDir && hasUserStorage(sourceDir)) {
      try {
        copyDirRecursive(join(sourceDir, 'storage'), join(targetDir, 'storage'))
        writeFileSync(
          join(targetDir, '.migrated-storage-from-legacy-data'),
          `Migrated storage from ${sourceDir} at ${new Date().toISOString()}\n`,
          'utf-8',
        )
        console.log(`[Database] Migrated legacy storage from ${sourceDir}`)
      } catch (error) {
        console.error('[Database] Failed to migrate legacy storage', error)
      }
    }
    return
  }

  if (!sourceDir) return

  try {
    copyDirRecursive(sourceDir, targetDir)
    writeFileSync(
      join(targetDir, '.migrated-from-legacy-data'),
      `Migrated from ${sourceDir} at ${new Date().toISOString()}\n`,
      'utf-8',
    )
    console.log(`[Database] Migrated legacy data from ${sourceDir}`)
  } catch (error) {
    console.error('[Database] Failed to migrate legacy data', error)
  }
}

export function resolvePreferredDataDir(): string {
  if (process.env.GUJISMART_DATA_DIR) {
    return resolve(process.env.GUJISMART_DATA_DIR)
  }

  const preferredDir = is.dev
    ? resolve(process.cwd(), 'data')
    : getStableAppRoot()

  if (canWriteToDirectory(preferredDir)) {
    return preferredDir
  }

  const softwareDir = dirname(app.getPath('exe'))
  throw new Error(
    `当前软件目录不可写，无法创建或更新文献库数据。请把软件目录移动到可写位置，或调整目录权限后重试。\n软件目录：${softwareDir}`,
  )
}

export function getDataDir(): string {
  if (cachedDataDir) {
    setPayloadDataDir(cachedDataDir)
    return cachedDataDir
  }
  cachedDataDir = resolvePreferredDataDir()

  if (!existsSync(cachedDataDir)) {
    mkdirSync(cachedDataDir, { recursive: true })
  }
  migrateLegacyDataIfNeeded(cachedDataDir)
  setPayloadDataDir(cachedDataDir)

  return cachedDataDir
}

export function resolveManagedStoragePath(filePath: string | null | undefined, docId?: string | null): string {
  const rawPath = String(filePath || '').trim()
  if (!rawPath) return rawPath

  const pathParts = normalize(rawPath).split(/[\\/]+/).filter(Boolean)
  const lowerParts = pathParts.map((part) => part.toLowerCase())
  const storageIndex = lowerParts.lastIndexOf('storage')
  const safeDocId = String(docId || '').trim()
  const safeDocIdLower = safeDocId.toLowerCase()
  let relativeParts: string[] = []

  if (storageIndex >= 0 && storageIndex < pathParts.length - 1) {
    if (safeDocIdLower) {
      const docIndex = lowerParts.findIndex((part, index) => index > storageIndex && part === safeDocIdLower)
      if (docIndex >= 0) {
        relativeParts = pathParts.slice(docIndex)
      }
    }
    if (relativeParts.length === 0) {
      relativeParts = pathParts.slice(storageIndex + 1)
    }
  }

  if (relativeParts.length === 0 && safeDocId) {
    const fileName = basename(rawPath)
    if (fileName) relativeParts = [safeDocId, fileName]
  }

  if (relativeParts.length === 0) return rawPath
  const relocatedPath = join(getDataDir(), 'storage', ...relativeParts)
  return existsSync(relocatedPath) ? relocatedPath : rawPath
}

export function getDatabase(): NativeDatabase {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function getDatabaseFilePath(): string {
  if (!dbFilePath) throw new Error('Database not initialized')
  return dbFilePath
}

export function isFtsAvailable(): boolean {
  return ftsAvailable
}

export function isSearchTrigramFtsAvailable(): boolean {
  return searchTrigramFtsAvailable
}

export function isSearchSegmentsFtsRebuildNeeded(): boolean {
  return searchSegmentsFtsNeedsRebuild
}

function runOn(sqlite: NativeDatabase, sql: string, params?: unknown[]): void {
  runWithBusyRetry(() => {
    if (params) {
      sqlite.prepare(sql).run(...params)
      return
    }

    sqlite.exec(sql)
  })
}

const TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  dynasty TEXT,
  source TEXT,
  doc_type TEXT DEFAULT 'unknown',
  file_path TEXT,
  thumb_path TEXT,
  page_count INTEGER DEFAULT 0,
  ocr_status TEXT DEFAULT 'pending',
  proof_status TEXT DEFAULT 'pending',
  import_status TEXT DEFAULT 'unstored',
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TEXT,
  is_favorite INTEGER DEFAULT 0,
  favorite_at TEXT,
  read_status TEXT DEFAULT 'unread',
  rating INTEGER,
  last_opened_at TEXT,
  metadata_status TEXT DEFAULT 'pending',
  metadata TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_num INTEGER,
  image_path TEXT,
  ocr_text TEXT,
  ocr_result TEXT,
  proofed_text TEXT,
  ocr_text_ref TEXT,
  ocr_result_ref TEXT,
  proofed_text_ref TEXT,
  ocr_status TEXT DEFAULT 'pending',
  proof_status TEXT DEFAULT 'pending',
  created_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_ocr_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_num INTEGER,
  engine TEXT NOT NULL,
  label TEXT,
  ocr_text TEXT,
  ocr_result TEXT,
  ocr_text_ref TEXT,
  ocr_result_ref TEXT,
  status TEXT DEFAULT 'completed',
  is_active INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  external_path TEXT,
  icon TEXT DEFAULT 'folder',
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS document_folders (
  doc_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  PRIMARY KEY (doc_id, folder_id),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#1890ff',
  parent_id TEXT,
  source TEXT DEFAULT 'manual',
  confidence REAL,
  usage_count INTEGER DEFAULT 0,
  normalized_name TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS document_tags (
  doc_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  is_manual INTEGER DEFAULT 1,
  is_metadata INTEGER DEFAULT 0,
  source_field TEXT,
  confidence REAL,
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (doc_id, tag_id),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metadata_candidates (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  candidate_value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL DEFAULT 0,
  evidence_page INTEGER,
  evidence_text TEXT,
  accepted INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_results (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  task_type TEXT,
  prompt TEXT DEFAULT '',
  prompt_hash TEXT DEFAULT '',
  result TEXT,
  model TEXT DEFAULT 'default',
  created_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  doc_id TEXT,
  title TEXT NOT NULL,
  scope_json TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT NOT NULL,
  task_type TEXT DEFAULT 'qa',
  metadata_json TEXT DEFAULT '',
  created_at TEXT,
  FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batch_queue (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  batch_size INTEGER DEFAULT 5,
  progress REAL DEFAULT 0,
  error_message TEXT,
  created_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS citation_templates (
  id TEXT PRIMARY KEY,
  style_id TEXT,
  name TEXT NOT NULL,
  format_type TEXT NOT NULL,
  template_text TEXT NOT NULL,
  field_mappings TEXT DEFAULT '{}',
  is_default INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (style_id) REFERENCES citation_styles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS citation_styles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS translation_glossaries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  project_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS translation_glossary_terms (
  id TEXT PRIMARY KEY,
  glossary_id TEXT NOT NULL,
  source_term TEXT NOT NULL,
  target_term TEXT NOT NULL,
  note TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  case_sensitive INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (glossary_id) REFERENCES translation_glossaries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  step_key TEXT PRIMARY KEY,
  completed INTEGER DEFAULT 0,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS research_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS research_project_documents (
  project_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (project_id, doc_id),
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_outline_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES research_outline_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  doc_id TEXT NOT NULL,
  page_num INTEGER,
  excerpt TEXT NOT NULL,
  note TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  source_type TEXT DEFAULT 'manual',
  source_id TEXT,
  kind TEXT DEFAULT 'quote',
  outline_id TEXT,
  color TEXT DEFAULT '',
  locator_json TEXT DEFAULT '',
  citation_text TEXT DEFAULT '',
  source_hash TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (outline_id) REFERENCES research_outline_items(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS research_outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  output_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_dataset_id TEXT,
  created_at TEXT,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_research_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  kind TEXT DEFAULT 'mixed',
  scope_json TEXT DEFAULT '{}',
  field_schema_json TEXT DEFAULT '[]',
  suggested_queries_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  error_message TEXT DEFAULT '',
  dataset_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_research_task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT DEFAULT '',
  progress REAL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_research_datasets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  field_schema_json TEXT DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_research_records (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT,
  doc_id TEXT NOT NULL,
  page_num INTEGER,
  excerpt TEXT NOT NULL,
  locator_json TEXT DEFAULT '',
  source_hash TEXT DEFAULT '',
  values_json TEXT DEFAULT '{}',
  confidence REAL DEFAULT 0.6,
  status TEXT DEFAULT 'pending',
  note TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (dataset_id) REFERENCES ai_research_datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_research_retrieval_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT,
  plan_json TEXT NOT NULL,
  stats_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'running',
  message TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_research_retrieval_stats (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  stats_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES ai_research_retrieval_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_research_evidence_packs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  evidence_json TEXT NOT NULL,
  evidence_count INTEGER DEFAULT 0,
  truncated INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES ai_research_retrieval_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reader_state (
  doc_id TEXT PRIMARY KEY,
  location_key TEXT DEFAULT '',
  progress REAL DEFAULT 0,
  view_mode TEXT DEFAULT 'spread',
  font_size INTEGER DEFAULT 17,
  line_height REAL DEFAULT 1.8,
  theme TEXT DEFAULT 'paper',
  document_mode TEXT DEFAULT 'read',
  proof_location_key TEXT DEFAULT '',
  proof_progress REAL DEFAULT 0,
  proof_view_mode TEXT DEFAULT 'text',
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_ai_layout_cache (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_num INTEGER,
  mode TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  result_text TEXT DEFAULT '',
  result_text_ref TEXT,
  status TEXT DEFAULT 'ready',
  error_message TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(page_id, mode, source_hash),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_translation_cache (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_num INTEGER,
  source_hash TEXT NOT NULL,
  source_text TEXT DEFAULT '',
  translation_text TEXT DEFAULT '',
  source_text_ref TEXT,
  translation_text_ref TEXT,
  skipped INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ready',
  error_message TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(page_id, source_hash),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_translation_units (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_num INTEGER,
  unit_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  block_index INTEGER DEFAULT 0,
  unit_order INTEGER DEFAULT 0,
  block_type TEXT DEFAULT 'text',
  source_text TEXT DEFAULT '',
  source_hash TEXT DEFAULT '',
  translation_text TEXT DEFAULT '',
  target_language TEXT DEFAULT 'zh-CN',
  mode TEXT DEFAULT 'balanced',
  model_signature TEXT DEFAULT '',
  glossary_signature TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  manual_override INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  quality_json TEXT DEFAULT '{}',
  source_rect_json TEXT DEFAULT '',
  source_index INTEGER,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(page_id, unit_id, target_language),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_toc_items (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  href TEXT DEFAULT '',
  level INTEGER DEFAULT 1,
  order_index INTEGER DEFAULT 0,
  parent_id TEXT,
  anchor_text TEXT,
  anchor_context TEXT,
  anchor_key TEXT,
  source_page_num INTEGER,
  source TEXT DEFAULT 'rule',
  confidence REAL DEFAULT 0.5,
  status TEXT DEFAULT 'active',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_index_segments (
  segment_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  page_id TEXT,
  page_num INTEGER,
  source_kind TEXT DEFAULT 'page',
  href TEXT,
  title TEXT,
  ordinal INTEGER DEFAULT 0,
  source_start INTEGER DEFAULT 0,
  text TEXT DEFAULT '',
  normalized_text TEXT DEFAULT '',
  offset_map TEXT DEFAULT '',
  text_hash TEXT DEFAULT '',
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_ngram_index (
  gram TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  positions TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  PRIMARY KEY (gram, segment_id),
  FOREIGN KEY (segment_id) REFERENCES search_index_segments(segment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_index_segments_staging (
  job_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  page_id TEXT,
  page_num INTEGER,
  source_kind TEXT DEFAULT 'page',
  href TEXT,
  title TEXT,
  ordinal INTEGER DEFAULT 0,
  source_start INTEGER DEFAULT 0,
  text TEXT DEFAULT '',
  normalized_text TEXT DEFAULT '',
  offset_map TEXT DEFAULT '',
  text_hash TEXT DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (job_id, segment_id)
);

CREATE TABLE IF NOT EXISTS search_ngram_index_staging (
  job_id TEXT NOT NULL,
  gram TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  positions TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0,
  PRIMARY KEY (job_id, gram, segment_id)
);

CREATE TABLE IF NOT EXISTS search_index_status (
  doc_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  source_hash TEXT DEFAULT '',
  segment_count INTEGER DEFAULT 0,
  error_message TEXT,
  indexed_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_state_cache (
  cache_key TEXT PRIMARY KEY,
  cache_json TEXT NOT NULL,
  dirty INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_document_summaries (
  doc_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pdf_repository_index (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  mtime_ms REAL DEFAULT 0,
  indexed_at TEXT
);
`

const INDEX_SCHEMA_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_ocr_versions_page_engine ON page_ocr_versions(page_id, engine);
CREATE INDEX IF NOT EXISTS idx_page_ocr_versions_doc ON page_ocr_versions(doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_pages_doc_id ON pages(doc_id);
CREATE INDEX IF NOT EXISTS idx_pages_doc_page_num ON pages(doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_pages_doc_ocr_status ON pages(doc_id, ocr_status);
CREATE INDEX IF NOT EXISTS idx_document_folders_folder_id ON document_folders(folder_id);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag_id ON document_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_document_tags_metadata ON document_tags(doc_id, is_metadata);
CREATE INDEX IF NOT EXISTS idx_metadata_candidates_doc_id ON metadata_candidates(doc_id);
CREATE INDEX IF NOT EXISTS idx_saved_searches_updated_at ON saved_searches(updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_results_doc_id ON ai_results(doc_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_doc_id ON ai_chat_sessions(doc_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_mode_doc ON ai_chat_sessions(mode, doc_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_chat_turns_session ON ai_chat_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_batch_queue_batch_id ON batch_queue(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_queue_doc_id ON batch_queue(doc_id);
CREATE INDEX IF NOT EXISTS idx_citation_templates_style_id ON citation_templates(style_id);
CREATE INDEX IF NOT EXISTS idx_citation_templates_style_type ON citation_templates(style_id, format_type);
CREATE INDEX IF NOT EXISTS idx_documents_import_status ON documents(import_status);
CREATE INDEX IF NOT EXISTS idx_documents_ocr_status ON documents(ocr_status);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_is_favorite ON documents(is_favorite);
CREATE INDEX IF NOT EXISTS idx_documents_read_status ON documents(read_status);
CREATE INDEX IF NOT EXISTS idx_documents_metadata_status ON documents(metadata_status);
CREATE INDEX IF NOT EXISTS idx_tags_normalized_name ON tags(normalized_name);
CREATE INDEX IF NOT EXISTS idx_research_notes_project_id ON research_notes(project_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_doc_id ON research_notes(doc_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_outline_id ON research_notes(outline_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_source_hash ON research_notes(doc_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_research_project_documents_doc_id ON research_project_documents(doc_id);
CREATE INDEX IF NOT EXISTS idx_research_outline_project_order ON research_outline_items(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_research_outputs_project_id ON research_outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_research_tasks_project ON ai_research_tasks(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_research_steps_task ON ai_research_task_steps(task_id, step_key);
CREATE INDEX IF NOT EXISTS idx_ai_research_datasets_project ON ai_research_datasets(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_research_records_dataset ON ai_research_records(dataset_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_research_records_doc ON ai_research_records(doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_ai_research_retrieval_runs_task ON ai_research_retrieval_runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_research_retrieval_stats_task ON ai_research_retrieval_stats(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_research_evidence_packs_task ON ai_research_evidence_packs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reader_state_updated_at ON reader_state(updated_at);
CREATE INDEX IF NOT EXISTS idx_page_ai_layout_cache_doc ON page_ai_layout_cache(doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_page_ai_layout_cache_lookup ON page_ai_layout_cache(page_id, mode, source_hash);
CREATE INDEX IF NOT EXISTS idx_page_translation_cache_doc ON page_translation_cache(doc_id, page_num);
CREATE INDEX IF NOT EXISTS idx_page_translation_cache_lookup ON page_translation_cache(page_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_page_translation_units_doc ON page_translation_units(doc_id, page_num, unit_order);
CREATE INDEX IF NOT EXISTS idx_page_translation_units_page ON page_translation_units(page_id, unit_order);
CREATE INDEX IF NOT EXISTS idx_page_translation_units_status ON page_translation_units(doc_id, status);
CREATE INDEX IF NOT EXISTS idx_document_toc_doc_order ON document_toc_items(doc_id, order_index);
CREATE INDEX IF NOT EXISTS idx_document_toc_doc_page ON document_toc_items(doc_id, source_page_num);
CREATE INDEX IF NOT EXISTS idx_document_toc_doc_source ON document_toc_items(doc_id, source);
CREATE INDEX IF NOT EXISTS idx_search_segments_doc_id ON search_index_segments(doc_id);
CREATE INDEX IF NOT EXISTS idx_search_segments_page_num ON search_index_segments(doc_id, page_num, ordinal);
CREATE INDEX IF NOT EXISTS idx_search_ngram_doc_id ON search_ngram_index(doc_id);
CREATE INDEX IF NOT EXISTS idx_search_ngram_segment ON search_ngram_index(segment_id);
CREATE INDEX IF NOT EXISTS idx_search_ngram_hit_count ON search_ngram_index(gram, hit_count);
CREATE INDEX IF NOT EXISTS idx_search_segments_staging_doc ON search_index_segments_staging(job_id, doc_id);
CREATE INDEX IF NOT EXISTS idx_search_ngram_staging_doc ON search_ngram_index_staging(job_id, doc_id);
CREATE INDEX IF NOT EXISTS idx_search_index_status_updated_at ON search_index_status(updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_document_summaries_updated_at ON ai_document_summaries(updated_at);
CREATE INDEX IF NOT EXISTS idx_pdf_repository_index_sha256 ON pdf_repository_index(sha256);
CREATE INDEX IF NOT EXISTS idx_translation_glossaries_scope ON translation_glossaries(scope, project_id);
CREATE INDEX IF NOT EXISTS idx_translation_terms_glossary ON translation_glossary_terms(glossary_id, enabled);
CREATE INDEX IF NOT EXISTS idx_translation_terms_source ON translation_glossary_terms(source_term);
`

const DEFAULT_CITATION_TEMPLATES = [
  {
    id: 'cit_apa7',
    style_id: 'style_default_academic',
    name: 'APA (7th Edition)',
    format_type: 'APA',
    template_text: '{{author}} ({{year}}). {{title}}. {{journal}}, {{volume}}({{issue}}), {{pages}}. {{doi}}',
    field_mappings: '{}',
    is_default: 1
  },
  {
    id: 'cit_mla9',
    style_id: 'style_default_academic',
    name: 'MLA (9th Edition)',
    format_type: 'MLA',
    template_text: '{{author}}. "{{title}}." {{journal}}, vol. {{volume}}, no. {{issue}}, {{year}}, pp. {{pages}}.',
    field_mappings: '{}',
    is_default: 0
  },
  {
    id: 'cit_chicago17',
    style_id: 'style_default_academic',
    name: 'Chicago (17th Edition)',
    format_type: 'Chicago',
    template_text: '{{author}}. "{{title}}." {{journal}} {{volume}}, no. {{issue}} ({{year}}): {{pages}}. {{doi}}',
    field_mappings: '{}',
    is_default: 0
  },
  {
    id: 'cit_gbt7714',
    style_id: 'style_default_academic',
    name: 'GB/T 7714-2015',
    format_type: 'GB-T7714',
    template_text: '{{author}}. {{title}}[J]. {{journal}}, {{year}}, {{volume}}({{issue}}): {{pages}}.',
    field_mappings: '{}',
    is_default: 0
  },
  {
    id: 'cit_ieee',
    style_id: 'style_default_academic',
    name: 'IEEE',
    format_type: 'IEEE',
    template_text: '{{author}}, "{{title}}," {{journal}}, vol. {{volume}}, no. {{issue}}, pp. {{pages}}, {{year}}.',
    field_mappings: '{}',
    is_default: 0
  },
  {
    id: 'cit_bibtex',
    style_id: 'style_default_academic',
    name: 'BibTeX',
    format_type: 'BibTeX',
    template_text: '@article{{{key}},\n  author = {{{author}}},\n  title = {{{title}}},\n  journal = {{{journal}}},\n  year = {{{year}}},\n  volume = {{{volume}}},\n  pages = {{{pages}}}\n}',
    field_mappings: '{}',
    is_default: 0
  }
]

function hasTable(sqlite: NativeDatabase, tableName: string): boolean {
  return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
}

function hasColumn(sqlite: NativeDatabase, tableName: string, columnName: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === columnName)
}

function addColumnIfMissing(sqlite: NativeDatabase, tableName: string, columnSql: string, columnName: string): void {
  if (!hasColumn(sqlite, tableName, columnName)) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`)
  }
}

function getTableCreateSql(sqlite: NativeDatabase, tableName: string): string {
  try {
    const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql?: string } | undefined
    return String(row?.sql || '')
  } catch {
    return ''
  }
}

function dropFtsTableIfNotExternalContent(sqlite: NativeDatabase, tableName: string): boolean {
  const createSql = getTableCreateSql(sqlite, tableName).toLowerCase()
  if (!createSql) return false
  if (createSql.includes("content='search_index_segments'") || createSql.includes('content="search_index_segments"')) return false
  sqlite.exec(`DROP TABLE IF EXISTS ${tableName}`)
  return true
}

function ensureFts(sqlite: NativeDatabase): void {
  ftsAvailable = false
  searchTrigramFtsAvailable = false
  let recreatedSearchSegmentsFts = false
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        page_id UNINDEXED,
        doc_id UNINDEXED,
        page_num UNINDEXED,
        content
      );
    `)
    recreatedSearchSegmentsFts = dropFtsTableIfNotExternalContent(sqlite, 'search_segments_fts') || recreatedSearchSegmentsFts
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_fts USING fts5(
        title,
        normalized_text,
        content='search_index_segments',
        content_rowid='rowid'
      );
    `)
    ftsAvailable = true
  } catch (error) {
    ftsAvailable = false
    console.warn('[Database] FTS5 unavailable, search will use fallback indexing', error)
  }

  if (!ftsAvailable) return
  try {
    recreatedSearchSegmentsFts = dropFtsTableIfNotExternalContent(sqlite, 'search_segments_trigram') || recreatedSearchSegmentsFts
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_segments_trigram USING fts5(
        normalized_text,
        content='search_index_segments',
        content_rowid='rowid',
        tokenize='trigram'
      );
    `)
    searchTrigramFtsAvailable = true
  } catch (error) {
    searchTrigramFtsAvailable = false
    console.warn('[Database] FTS5 trigram unavailable, long CJK search will use verified scan fallback', error)
  }
  searchSegmentsFtsNeedsRebuild = searchSegmentsFtsNeedsRebuild || recreatedSearchSegmentsFts
}

function ensureIndexes(sqlite: NativeDatabase): void {
  sqlite.exec(INDEX_SCHEMA_SQL)
}

function rebuildFts(sqlite: NativeDatabase): void {
  if (!ftsAvailable) return

  sqlite.exec('DELETE FROM pages_fts')
  sqlite.exec(`
    INSERT INTO pages_fts (rowid, page_id, doc_id, page_num, content)
    SELECT rowid, id, doc_id, page_num, TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, ''))
    FROM pages
  `)

  sqlite.exec("INSERT INTO search_segments_fts(search_segments_fts) VALUES('delete-all')")
  sqlite.exec(`
    INSERT INTO search_segments_fts (rowid, title, normalized_text)
    SELECT rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
    FROM search_index_segments
    WHERE TRIM(COALESCE(normalized_text, text, '')) != ''
  `)

  if (searchTrigramFtsAvailable) {
    sqlite.exec("INSERT INTO search_segments_trigram(search_segments_trigram) VALUES('delete-all')")
    sqlite.exec(`
      INSERT INTO search_segments_trigram (rowid, normalized_text)
      SELECT rowid, COALESCE(normalized_text, text, '')
      FROM search_index_segments
      WHERE TRIM(COALESCE(normalized_text, text, '')) != ''
    `)
  }
}

function getFtsPageCount(sqlite: NativeDatabase): number {
  if (!ftsAvailable) return 0
  try {
    const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM pages_fts').get() as { cnt?: number } | undefined
    return Number(row?.cnt || 0)
  } catch {
    return 0
  }
}

function getSearchablePageCount(sqlite: NativeDatabase): number {
  try {
    const row = sqlite.prepare(`
      SELECT COUNT(*) as cnt
      FROM pages
      WHERE TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, '')) != ''
    `).get() as { cnt?: number } | undefined
    return Number(row?.cnt || 0)
  } catch {
    return 0
  }
}

function getSearchSegmentCount(sqlite: NativeDatabase): number {
  try {
    const row = sqlite.prepare(`
      SELECT COUNT(*) as cnt
      FROM search_index_segments
      WHERE TRIM(COALESCE(normalized_text, text, '')) != ''
    `).get() as { cnt?: number } | undefined
    return Number(row?.cnt || 0)
  } catch {
    return 0
  }
}

function getSearchSegmentsFtsCount(sqlite: NativeDatabase): number {
  if (!ftsAvailable) return 0
  try {
    const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM search_segments_fts').get() as { cnt?: number } | undefined
    return Number(row?.cnt || 0)
  } catch {
    return 0
  }
}

function getSearchSegmentsTrigramCount(sqlite: NativeDatabase): number {
  if (!searchTrigramFtsAvailable) return 0
  try {
    const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM search_segments_trigram').get() as { cnt?: number } | undefined
    return Number(row?.cnt || 0)
  } catch {
    return 0
  }
}

function ensureFtsSeeded(sqlite: NativeDatabase): void {
  if (!ftsAvailable) return
  const segmentCount = getSearchSegmentCount(sqlite)
  const segmentFtsCount = getSearchSegmentsFtsCount(sqlite)
  const trigramCount = getSearchSegmentsTrigramCount(sqlite)
  if (
    searchSegmentsFtsNeedsRebuild
    || (
      getFtsPageCount(sqlite) !== getSearchablePageCount(sqlite)
      || segmentFtsCount < segmentCount
      || (searchTrigramFtsAvailable && trigramCount < segmentCount)
    )
  ) {
    rebuildFts(sqlite)
    searchSegmentsFtsNeedsRebuild = false
  }
}

function tableHasMoreRowsThan(sqlite: NativeDatabase, tableName: string, limit: number): boolean {
  if (!hasTable(sqlite, tableName)) return false
  try {
    const row = sqlite.prepare(`SELECT 1 as exists_row FROM ${tableName} LIMIT 1 OFFSET ?`).get(limit) as { exists_row?: number } | undefined
    return row?.exists_row === 1
  } catch {
    return false
  }
}

export function isLargeLibraryForAutomaticMaintenance(sqlite: NativeDatabase = getDatabase()): boolean {
  return tableHasMoreRowsThan(sqlite, 'pages', LARGE_LIBRARY_AUTOMATIC_MAINTENANCE_PAGE_LIMIT)
    || tableHasMoreRowsThan(sqlite, 'search_index_segments', LARGE_LIBRARY_AUTOMATIC_MAINTENANCE_SEGMENT_LIMIT)
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}

function getLooseDuplicateTagKey(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, '')
    .replace(/[()（）【】[\]{}《》〈〉「」『』,，.。:：;；、_\-—–·•]/g, '')
    .replace(/國/g, '国')
    .replace(/[戰戦]/g, '战')
    .replace(/學/g, '学')
    .replace(/滿/g, '满')
    .replace(/會/g, '会')
    .replace(/協/g, '协')
    .replace(/語/g, '语')
    .replace(/東/g, '东')
    .replace(/亞/g, '亚')
}

function updateTagUsageCounts(sqlite: NativeDatabase): void {
  sqlite.exec('UPDATE tags SET usage_count = 0')
  sqlite.exec(`
    UPDATE tags
    SET usage_count = (
      SELECT COUNT(*)
      FROM document_tags dt
      WHERE dt.tag_id = tags.id
    )
  `)
}

export function mergeTagInto(sqlite: NativeDatabase, fromTagId: string, intoTagId: string): void {
  if (fromTagId === intoTagId) return
  const now = new Date().toISOString()
  sqlite.prepare(
    `INSERT OR IGNORE INTO document_tags (
      doc_id, tag_id, is_manual, is_metadata, source_field, confidence, created_at, updated_at
    )
    SELECT doc_id, ?, is_manual, is_metadata, source_field, confidence, created_at, updated_at
    FROM document_tags
    WHERE tag_id = ?`,
  ).run(intoTagId, fromTagId)
  sqlite.prepare(
    `UPDATE document_tags
     SET is_manual = MAX(is_manual, COALESCE((
         SELECT old.is_manual FROM document_tags old
         WHERE old.doc_id = document_tags.doc_id AND old.tag_id = ?
       ), 0)),
       is_metadata = MAX(is_metadata, COALESCE((
         SELECT old.is_metadata FROM document_tags old
         WHERE old.doc_id = document_tags.doc_id AND old.tag_id = ?
       ), 0)),
       source_field = COALESCE(source_field, (
         SELECT old.source_field FROM document_tags old
         WHERE old.doc_id = document_tags.doc_id AND old.tag_id = ?
       )),
       confidence = MAX(COALESCE(confidence, 0), COALESCE((
         SELECT old.confidence FROM document_tags old
         WHERE old.doc_id = document_tags.doc_id AND old.tag_id = ?
       ), 0)),
       updated_at = ?
     WHERE tag_id = ?`,
  ).run(fromTagId, fromTagId, fromTagId, fromTagId, now, intoTagId)
  sqlite.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(fromTagId)
  sqlite.prepare('UPDATE tags SET parent_id = ? WHERE parent_id = ?').run(intoTagId, fromTagId)
  sqlite.prepare('DELETE FROM tags WHERE id = ?').run(fromTagId)
}

function autoMergeDuplicateTags(sqlite: NativeDatabase): void {
  const tags = sqlite.prepare(`
    SELECT id, name, source, usage_count, COALESCE(created_at, id) as created_at
    FROM tags
    ORDER BY usage_count DESC, name ASC
  `).all() as Array<{ id: string; name: string; source?: string | null; usage_count?: number | null; created_at?: string | null }>
  const groups = new Map<string, typeof tags>()

  for (const tag of tags) {
    const key = getLooseDuplicateTagKey(tag.name || '')
    if (!key) continue
    groups.set(key, [...(groups.get(key) || []), tag])
  }

  for (const items of groups.values()) {
    if (items.length < 2) continue
    const sorted = [...items].sort((left, right) => {
      const leftManual = (left.source || 'manual') === 'manual' ? 1 : 0
      const rightManual = (right.source || 'manual') === 'manual' ? 1 : 0
      if (leftManual !== rightManual) return rightManual - leftManual
      const usageGap = Number(right.usage_count || 0) - Number(left.usage_count || 0)
      if (usageGap !== 0) return usageGap
      return String(left.created_at || '').localeCompare(String(right.created_at || ''))
    })
    const target = sorted[0]
    for (const duplicate of sorted.slice(1)) {
      mergeTagInto(sqlite, duplicate.id, target.id)
    }
  }
}

function pruneUnusedGeneratedTags(sqlite: NativeDatabase): void {
  sqlite.exec(`
    DELETE FROM tags
    WHERE COALESCE(usage_count, 0) = 0
      AND COALESCE(source, 'manual') != 'manual'
      AND NOT EXISTS (
        SELECT 1
        FROM tags child
        WHERE child.parent_id = tags.id
      )
  `)
}

function cleanupOrphanRows(sqlite: NativeDatabase): void {
  const statements: string[] = []
  if (hasTable(sqlite, 'search_ngram_postings') && hasTable(sqlite, 'search_index_segments')) {
    statements.push('DELETE FROM search_ngram_postings WHERE segment_id NOT IN (SELECT segment_id FROM search_index_segments)')
  }
  if (hasTable(sqlite, 'search_index_segments') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'pages')) {
    statements.push('DELETE FROM search_index_segments WHERE doc_id NOT IN (SELECT id FROM documents) OR page_id NOT IN (SELECT id FROM pages)')
  }
  if (hasTable(sqlite, 'document_tags') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'tags')) {
    statements.push('DELETE FROM document_tags WHERE doc_id NOT IN (SELECT id FROM documents) OR tag_id NOT IN (SELECT id FROM tags)')
  }
  if (hasTable(sqlite, 'folder_documents') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'folders')) {
    statements.push('DELETE FROM folder_documents WHERE doc_id NOT IN (SELECT id FROM documents) OR folder_id NOT IN (SELECT id FROM folders)')
  }
  if (hasTable(sqlite, 'metadata_candidates') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM metadata_candidates WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'reading_progress') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM reading_progress WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'notes') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM notes WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'research_outline_items') && hasTable(sqlite, 'research_projects')) {
    statements.push('DELETE FROM research_outline_items WHERE project_id NOT IN (SELECT id FROM research_projects)')
  }
  if (hasTable(sqlite, 'research_notes') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM research_notes WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'research_notes') && hasTable(sqlite, 'research_outline_items')) {
    statements.push('UPDATE research_notes SET outline_id = NULL WHERE outline_id IS NOT NULL AND outline_id NOT IN (SELECT id FROM research_outline_items)')
  }
  if (hasTable(sqlite, 'search_index_status') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM search_index_status WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'search_ngram_index_staging')) {
    statements.push('DELETE FROM search_ngram_index_staging')
  }
  if (hasTable(sqlite, 'search_index_segments_staging')) {
    statements.push('DELETE FROM search_index_segments_staging')
  }
  if (hasTable(sqlite, 'document_toc_items') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM document_toc_items WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  if (hasTable(sqlite, 'page_ai_layout_cache') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'pages')) {
    statements.push('DELETE FROM page_ai_layout_cache WHERE doc_id NOT IN (SELECT id FROM documents) OR page_id NOT IN (SELECT id FROM pages)')
  }
  if (hasTable(sqlite, 'page_translation_cache') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'pages')) {
    statements.push('DELETE FROM page_translation_cache WHERE doc_id NOT IN (SELECT id FROM documents) OR page_id NOT IN (SELECT id FROM pages)')
  }
  if (hasTable(sqlite, 'page_translation_units') && hasTable(sqlite, 'documents') && hasTable(sqlite, 'pages')) {
    statements.push('DELETE FROM page_translation_units WHERE doc_id NOT IN (SELECT id FROM documents) OR page_id NOT IN (SELECT id FROM pages)')
  }
  if (hasTable(sqlite, 'pages') && hasTable(sqlite, 'documents')) {
    statements.push('DELETE FROM pages WHERE doc_id NOT IN (SELECT id FROM documents)')
  }
  for (const statement of statements) {
    sqlite.prepare(statement).run()
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stripLegacyTocMetadata(sqlite: NativeDatabase): void {
  if (!hasTable(sqlite, 'documents')) return
  let tocRuleVersionSynced = true
  if (hasTable(sqlite, 'document_toc_items')) {
    sqlite.prepare("DELETE FROM document_toc_items WHERE COALESCE(source, '') = 'legacy'").run()
    const ruleVersion = sqlite.prepare("SELECT value FROM settings WHERE key = 'toc_rule_engine_version'").get() as { value?: string } | undefined
    if (ruleVersion?.value !== TOC_RULE_ENGINE_VERSION) {
      tocRuleVersionSynced = false
      sqlite.prepare("DELETE FROM document_toc_items WHERE COALESCE(source, 'rule') = 'rule'").run()
      sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('toc_rule_engine_version', TOC_RULE_ENGINE_VERSION)
    }
  }
  const stripped = sqlite.prepare("SELECT value FROM settings WHERE key = 'legacy_toc_metadata_stripped'").get() as { value?: string } | undefined
  if (stripped?.value === '1' && tocRuleVersionSynced) return
  const rows = sqlite.prepare('SELECT id, metadata FROM documents WHERE metadata IS NOT NULL AND metadata != ?').all('{}') as Array<{ id: string; metadata?: string | null }>
  const update = sqlite.prepare('UPDATE documents SET metadata = ?, updated_at = ? WHERE id = ?')
  const now = new Date().toISOString()
  const tx = sqlite.transaction(() => {
    for (const row of rows) {
      const metadata = parseJsonRecord(String(row.metadata || '{}'))
      if (!metadata) continue
      const manifest = metadata.ebook_manifest && isJsonRecord(metadata.ebook_manifest)
        ? { ...metadata.ebook_manifest }
        : metadata.ebook_manifest
      if (isJsonRecord(manifest) && Array.isArray(manifest.toc)) {
        delete manifest.toc
      }
      const nextMetadata: Record<string, unknown> = { ...metadata, ebook_manifest: manifest }
      let changed = false
      for (const key of ['reader_toc', 'manual_toc', 'ai_toc', 'vision_toc', 'toc_source', 'toc_updated_at']) {
        if (Object.prototype.hasOwnProperty.call(nextMetadata, key)) {
          delete nextMetadata[key]
          changed = true
        }
      }
      if (metadata.ebook_manifest !== manifest) changed = true
      if (changed) update.run(JSON.stringify(nextMetadata), now, row.id)
    }
    sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('legacy_toc_metadata_stripped', '1')
  })
  tx()
}

function migrateExistingSchema(sqlite: NativeDatabase): void {
  addColumnIfMissing(sqlite, 'pages', 'ocr_text_ref TEXT', 'ocr_text_ref')
  addColumnIfMissing(sqlite, 'pages', 'ocr_result_ref TEXT', 'ocr_result_ref')
  addColumnIfMissing(sqlite, 'pages', 'proofed_text_ref TEXT', 'proofed_text_ref')

  addColumnIfMissing(sqlite, 'documents', 'is_favorite INTEGER DEFAULT 0', 'is_favorite')
  addColumnIfMissing(sqlite, 'documents', 'favorite_at TEXT', 'favorite_at')
  addColumnIfMissing(sqlite, 'documents', "read_status TEXT DEFAULT 'unread'", 'read_status')
  addColumnIfMissing(sqlite, 'documents', 'rating INTEGER', 'rating')
  addColumnIfMissing(sqlite, 'documents', 'last_opened_at TEXT', 'last_opened_at')
  addColumnIfMissing(sqlite, 'documents', "metadata_status TEXT DEFAULT 'pending'", 'metadata_status')
  addColumnIfMissing(sqlite, 'documents', 'error_message TEXT', 'error_message')
  addColumnIfMissing(sqlite, 'documents', 'retry_count INTEGER DEFAULT 0', 'retry_count')
  addColumnIfMissing(sqlite, 'documents', 'last_retry_at TEXT', 'last_retry_at')

  addColumnIfMissing(sqlite, 'reader_state', "document_mode TEXT DEFAULT 'read'", 'document_mode')
  addColumnIfMissing(sqlite, 'reader_state', "proof_location_key TEXT DEFAULT ''", 'proof_location_key')
  addColumnIfMissing(sqlite, 'reader_state', 'proof_progress REAL DEFAULT 0', 'proof_progress')
  addColumnIfMissing(sqlite, 'reader_state', "proof_view_mode TEXT DEFAULT 'text'", 'proof_view_mode')

  addColumnIfMissing(sqlite, 'tags', "source TEXT DEFAULT 'manual'", 'source')
  addColumnIfMissing(sqlite, 'tags', 'confidence REAL', 'confidence')
  addColumnIfMissing(sqlite, 'tags', 'usage_count INTEGER DEFAULT 0', 'usage_count')
  addColumnIfMissing(sqlite, 'tags', 'normalized_name TEXT', 'normalized_name')
  addColumnIfMissing(sqlite, 'tags', 'created_at TEXT', 'created_at')
  addColumnIfMissing(sqlite, 'tags', 'updated_at TEXT', 'updated_at')

  addColumnIfMissing(sqlite, 'document_tags', 'is_manual INTEGER DEFAULT 1', 'is_manual')
  addColumnIfMissing(sqlite, 'document_tags', 'is_metadata INTEGER DEFAULT 0', 'is_metadata')
  addColumnIfMissing(sqlite, 'document_tags', 'source_field TEXT', 'source_field')
  addColumnIfMissing(sqlite, 'document_tags', 'confidence REAL', 'confidence')
  addColumnIfMissing(sqlite, 'document_tags', 'created_at TEXT', 'created_at')
  addColumnIfMissing(sqlite, 'document_tags', 'updated_at TEXT', 'updated_at')

  addColumnIfMissing(sqlite, 'ai_results', "prompt_hash TEXT DEFAULT ''", 'prompt_hash')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS translation_glossaries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      project_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS translation_glossary_terms (
      id TEXT PRIMARY KEY,
      glossary_id TEXT NOT NULL,
      source_term TEXT NOT NULL,
      target_term TEXT NOT NULL,
      note TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      case_sensitive INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (glossary_id) REFERENCES translation_glossaries(id) ON DELETE CASCADE
    );
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      doc_id TEXT,
      title TEXT NOT NULL,
      scope_json TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_chat_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      result TEXT NOT NULL,
      task_type TEXT DEFAULT 'qa',
      metadata_json TEXT DEFAULT '',
      created_at TEXT,
      FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
    );
  `)
  addColumnIfMissing(sqlite, 'ai_chat_sessions', "scope_json TEXT DEFAULT ''", 'scope_json')
  addColumnIfMissing(sqlite, 'ai_chat_turns', "metadata_json TEXT DEFAULT ''", 'metadata_json')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS citation_styles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `)
  addColumnIfMissing(sqlite, 'citation_templates', 'style_id TEXT', 'style_id')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS document_toc_items (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      title TEXT NOT NULL,
      href TEXT DEFAULT '',
      level INTEGER DEFAULT 1,
      order_index INTEGER DEFAULT 0,
      parent_id TEXT,
      anchor_text TEXT,
      anchor_context TEXT,
      anchor_key TEXT,
      source_page_num INTEGER,
      source TEXT DEFAULT 'rule',
      confidence REAL DEFAULT 0.5,
      status TEXT DEFAULT 'active',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `)
  addColumnIfMissing(sqlite, 'document_toc_items', "href TEXT DEFAULT ''", 'href')
  addColumnIfMissing(sqlite, 'document_toc_items', 'level INTEGER DEFAULT 1', 'level')
  addColumnIfMissing(sqlite, 'document_toc_items', 'order_index INTEGER DEFAULT 0', 'order_index')
  addColumnIfMissing(sqlite, 'document_toc_items', 'parent_id TEXT', 'parent_id')
  addColumnIfMissing(sqlite, 'document_toc_items', 'anchor_text TEXT', 'anchor_text')
  addColumnIfMissing(sqlite, 'document_toc_items', 'anchor_context TEXT', 'anchor_context')
  addColumnIfMissing(sqlite, 'document_toc_items', 'anchor_key TEXT', 'anchor_key')
  addColumnIfMissing(sqlite, 'document_toc_items', 'source_page_num INTEGER', 'source_page_num')
  addColumnIfMissing(sqlite, 'document_toc_items', "source TEXT DEFAULT 'rule'", 'source')
  addColumnIfMissing(sqlite, 'document_toc_items', 'confidence REAL DEFAULT 0.5', 'confidence')
  addColumnIfMissing(sqlite, 'document_toc_items', "status TEXT DEFAULT 'active'", 'status')
  addColumnIfMissing(sqlite, 'document_toc_items', 'created_at TEXT', 'created_at')
  addColumnIfMissing(sqlite, 'document_toc_items', 'updated_at TEXT', 'updated_at')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS research_outline_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES research_outline_items(id) ON DELETE CASCADE
    )
  `)
  addColumnIfMissing(sqlite, 'research_outline_items', 'parent_id TEXT', 'parent_id')
  addColumnIfMissing(sqlite, 'research_outline_items', "description TEXT DEFAULT ''", 'description')
  addColumnIfMissing(sqlite, 'research_outline_items', 'sort_order INTEGER DEFAULT 0', 'sort_order')
  addColumnIfMissing(sqlite, 'research_outline_items', 'created_at TEXT', 'created_at')
  addColumnIfMissing(sqlite, 'research_outline_items', 'updated_at TEXT', 'updated_at')

  addColumnIfMissing(sqlite, 'research_notes', "kind TEXT DEFAULT 'quote'", 'kind')
  addColumnIfMissing(sqlite, 'research_notes', 'outline_id TEXT', 'outline_id')
  addColumnIfMissing(sqlite, 'research_notes', "color TEXT DEFAULT ''", 'color')
  addColumnIfMissing(sqlite, 'research_notes', "locator_json TEXT DEFAULT ''", 'locator_json')
  addColumnIfMissing(sqlite, 'research_notes', "citation_text TEXT DEFAULT ''", 'citation_text')
  addColumnIfMissing(sqlite, 'research_notes', "source_hash TEXT DEFAULT ''", 'source_hash')
  addColumnIfMissing(sqlite, 'research_notes', 'sort_order INTEGER DEFAULT 0', 'sort_order')
  addColumnIfMissing(sqlite, 'research_outputs', 'source_dataset_id TEXT', 'source_dataset_id')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_research_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      kind TEXT DEFAULT 'mixed',
      scope_json TEXT DEFAULT '{}',
      field_schema_json TEXT DEFAULT '[]',
      suggested_queries_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'draft',
      error_message TEXT DEFAULT '',
      dataset_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_research_task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      message TEXT DEFAULT '',
      progress REAL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_research_datasets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      field_schema_json TEXT DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_research_records (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT,
      doc_id TEXT NOT NULL,
      page_num INTEGER,
      excerpt TEXT NOT NULL,
      locator_json TEXT DEFAULT '',
      source_hash TEXT DEFAULT '',
      values_json TEXT DEFAULT '{}',
      confidence REAL DEFAULT 0.6,
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (dataset_id) REFERENCES ai_research_datasets(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_research_retrieval_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      project_id TEXT,
      plan_json TEXT NOT NULL,
      stats_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'running',
      message TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ai_research_retrieval_stats (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      run_id TEXT,
      stats_json TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES ai_research_retrieval_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_research_evidence_packs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      run_id TEXT,
      evidence_json TEXT NOT NULL,
      evidence_count INTEGER DEFAULT 0,
      truncated INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (task_id) REFERENCES ai_research_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES ai_research_retrieval_runs(id) ON DELETE CASCADE
    );
  `)
  addColumnIfMissing(sqlite, 'ai_research_tasks', "kind TEXT DEFAULT 'mixed'", 'kind')
  addColumnIfMissing(sqlite, 'ai_research_tasks', 'dataset_id TEXT', 'dataset_id')
  addColumnIfMissing(sqlite, 'ai_research_tasks', "error_message TEXT DEFAULT ''", 'error_message')
  addColumnIfMissing(sqlite, 'ai_research_records', "note TEXT DEFAULT ''", 'note')
  addColumnIfMissing(sqlite, 'ai_research_records', "status TEXT DEFAULT 'pending'", 'status')

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS page_ocr_versions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_num INTEGER,
      engine TEXT NOT NULL,
      label TEXT,
      ocr_text TEXT,
      ocr_result TEXT,
      status TEXT DEFAULT 'completed',
      is_active INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `)
  addColumnIfMissing(sqlite, 'page_ocr_versions', 'page_num INTEGER', 'page_num')
  addColumnIfMissing(sqlite, 'page_ocr_versions', "label TEXT", 'label')
  addColumnIfMissing(sqlite, 'page_ocr_versions', 'ocr_text_ref TEXT', 'ocr_text_ref')
  addColumnIfMissing(sqlite, 'page_ocr_versions', 'ocr_result_ref TEXT', 'ocr_result_ref')
  addColumnIfMissing(sqlite, 'page_ocr_versions', "status TEXT DEFAULT 'completed'", 'status')
  addColumnIfMissing(sqlite, 'page_ocr_versions', 'is_active INTEGER DEFAULT 0', 'is_active')
  addColumnIfMissing(sqlite, 'page_ai_layout_cache', 'result_text_ref TEXT', 'result_text_ref')
  addColumnIfMissing(sqlite, 'page_translation_cache', 'source_text_ref TEXT', 'source_text_ref')
  addColumnIfMissing(sqlite, 'page_translation_cache', 'translation_text_ref TEXT', 'translation_text_ref')
  addColumnIfMissing(sqlite, 'search_index_segments', "offset_map TEXT DEFAULT ''", 'offset_map')
  addColumnIfMissing(sqlite, 'search_index_segments', 'source_start INTEGER DEFAULT 0', 'source_start')

  const now = new Date().toISOString()
  sqlite.prepare(
    `INSERT OR IGNORE INTO citation_styles (id, name, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('style_default_academic', '默认引用标准', '兼容旧引用模板的默认标准。', 1, now, now)
  sqlite.exec("UPDATE citation_templates SET style_id = 'style_default_academic' WHERE style_id IS NULL OR style_id = ''")

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pdf_repository_index (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      mtime_ms REAL DEFAULT 0,
      indexed_at TEXT
    )
  `)
}

function normalizeExistingData(sqlite: NativeDatabase): void {
  sqlite.exec("UPDATE documents SET read_status = 'unread' WHERE read_status IS NULL OR read_status = ''")
  sqlite.exec("UPDATE documents SET metadata_status = CASE WHEN metadata IS NOT NULL AND metadata != '{}' THEN 'auto' ELSE 'pending' END WHERE metadata_status IS NULL OR metadata_status = ''")
  sqlite.exec('UPDATE documents SET is_favorite = 0 WHERE is_favorite IS NULL')
  sqlite.exec('UPDATE documents SET retry_count = 0 WHERE retry_count IS NULL')
  sqlite.exec("UPDATE tags SET normalized_name = LOWER(TRIM(name)) WHERE normalized_name IS NULL OR normalized_name = ''")
  sqlite.exec("UPDATE tags SET source = 'manual' WHERE source IS NULL OR source = ''")
  sqlite.exec('UPDATE document_tags SET is_manual = 1 WHERE is_manual IS NULL')
  sqlite.exec('UPDATE document_tags SET is_metadata = 0 WHERE is_metadata IS NULL')
  sqlite.exec("UPDATE research_notes SET kind = 'quote' WHERE kind IS NULL OR kind = ''")
  sqlite.exec("UPDATE research_notes SET color = '' WHERE color IS NULL")
  sqlite.exec("UPDATE research_notes SET locator_json = COALESCE(source_id, '') WHERE (locator_json IS NULL OR locator_json = '') AND source_id IS NOT NULL")
  sqlite.exec("UPDATE research_notes SET citation_text = '' WHERE citation_text IS NULL")
  sqlite.exec("UPDATE research_notes SET source_hash = '' WHERE source_hash IS NULL")
  sqlite.exec('UPDATE research_notes SET sort_order = COALESCE(sort_order, 0)')
  updateTagUsageCounts(sqlite)
}

function migrateFromJson(jsonDbPath: string, sqlite: NativeDatabase): void {
  if (!existsSync(jsonDbPath)) return

  try {
    const raw = readFileSync(jsonDbPath, 'utf-8')
    const data = JSON.parse(raw)

    console.log('[Database] Found legacy JSON data, starting migration')
    sqlite.exec('BEGIN TRANSACTION')

    try {
      const now = new Date().toISOString()

      if (Array.isArray(data.documents)) {
        for (const doc of data.documents) {
          const metadata = typeof doc.metadata === 'string' ? doc.metadata : JSON.stringify(doc.metadata || {})
          const importStatus = doc.ocr_status === 'completed' ? 'processed' : 'unstored'
          const metadataStatus = metadata && metadata !== '{}' ? 'auto' : 'pending'
          runOn(sqlite,
            `INSERT OR IGNORE INTO documents (
              id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
              ocr_status, proof_status, import_status, is_favorite, favorite_at, read_status, rating,
              last_opened_at, metadata_status, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              doc.id,
              doc.title || '',
              doc.author || null,
              doc.dynasty || null,
              doc.source || null,
              doc.doc_type || 'unknown',
              doc.file_path || null,
              doc.thumb_path || null,
              doc.page_count || 0,
              doc.ocr_status || 'pending',
              doc.proof_status || 'pending',
              importStatus,
              Number(doc.is_favorite || 0),
              doc.favorite_at || null,
              doc.read_status || 'unread',
              doc.rating || null,
              doc.last_opened_at || null,
              metadataStatus,
              metadata,
              doc.created_at || now,
              doc.updated_at || now
            ]
          )
        }
      }

      if (Array.isArray(data.pages)) {
        for (const page of data.pages) {
          runOn(sqlite,
            'INSERT OR IGNORE INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              page.id,
              page.doc_id,
              page.page_num || 0,
              page.image_path || null,
              page.ocr_text || null,
              typeof page.ocr_result === 'string' ? page.ocr_result : JSON.stringify(page.ocr_result || null),
              page.proofed_text || null,
              page.ocr_status || 'pending',
              page.proof_status || 'pending',
              page.created_at || now
            ]
          )
        }
      }

      if (Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          runOn(sqlite,
            'INSERT OR IGNORE INTO tags (id, name, color, parent_id, source, confidence, usage_count, normalized_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              tag.id,
              tag.name,
              tag.color || '#1890ff',
              tag.parent_id || null,
              tag.source || 'manual',
              tag.confidence ?? null,
              tag.usage_count || 0,
              normalizeTagName(tag.name || '')
            ]
          )
        }
      }

      if (Array.isArray(data.document_tags)) {
        for (const item of data.document_tags) {
          runOn(sqlite, 'INSERT OR IGNORE INTO document_tags (doc_id, tag_id) VALUES (?, ?)', [item.doc_id, item.tag_id])
        }
      }

      if (Array.isArray(data.collections)) {
        for (const folder of data.collections) {
          runOn(sqlite,
            'INSERT OR IGNORE INTO folders (id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              folder.id,
              folder.name,
              folder.parent_id || null,
              folder.external_path || null,
              folder.icon || 'folder',
              folder.color || null,
              folder.sort_order || 0,
              folder.created_at || now,
              folder.updated_at || now
            ]
          )
        }
      }

      if (Array.isArray(data.document_collections)) {
        for (const item of data.document_collections) {
          runOn(sqlite,
            'INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)',
            [item.doc_id, item.collection_id || item.folder_id]
          )
        }
      }

      if (Array.isArray(data.ai_results)) {
        for (const item of data.ai_results) {
          runOn(sqlite,
            'INSERT OR IGNORE INTO ai_results (id, doc_id, task_type, prompt, prompt_hash, result, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              item.id,
              item.doc_id,
              item.task_type || '',
              item.prompt || '',
              item.prompt_hash || '',
              typeof item.result === 'string' ? item.result : JSON.stringify(item.result || ''),
              item.model || 'default',
              item.created_at || now
            ]
          )
        }
      }

      if (data.settings && typeof data.settings === 'object') {
        for (const [key, value] of Object.entries(data.settings)) {
          runOn(sqlite, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)])
        }
      }

      sqlite.exec('COMMIT')
      console.log('[Database] JSON migration completed')

      const backupPath = `${jsonDbPath}.backup`
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, raw, 'utf-8')
      }
    } catch (error) {
      sqlite.exec('ROLLBACK')
      console.error('[Database] JSON migration failed and was rolled back', error)
    }
  } catch (error) {
    console.error('[Database] Failed to read legacy JSON data', error)
  }
}

function seedDefaultData(sqlite: NativeDatabase): void {
  const now = new Date().toISOString()
  const seedVersion = sqlite.prepare("SELECT value FROM settings WHERE key = 'citation_history_seed_version'").get() as { value?: string } | undefined
  const shouldSetHistoryDefault = seedVersion?.value !== HISTORY_CITATION_SEED_VERSION

  if (shouldSetHistoryDefault) {
    sqlite.exec('UPDATE citation_styles SET is_default = 0')
  }
  sqlite.prepare(
    `INSERT OR IGNORE INTO citation_styles (id, name, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    HISTORY_CITATION_STYLE.id,
    HISTORY_CITATION_STYLE.name,
    HISTORY_CITATION_STYLE.description,
    shouldSetHistoryDefault ? HISTORY_CITATION_STYLE.is_default : 0,
    now,
    now,
  )
  if (shouldSetHistoryDefault) {
    sqlite.prepare(
      `UPDATE citation_styles
       SET name = ?, description = ?, is_default = 1, updated_at = ?
       WHERE id = ?`,
    ).run(HISTORY_CITATION_STYLE.name, HISTORY_CITATION_STYLE.description, now, HISTORY_CITATION_STYLE.id)
  } else {
    sqlite.prepare(
      `UPDATE citation_styles
       SET name = ?, description = ?, updated_at = ?
       WHERE id = ?`,
    ).run(HISTORY_CITATION_STYLE.name, HISTORY_CITATION_STYLE.description, now, HISTORY_CITATION_STYLE.id)
  }

  for (const template of DEFAULT_HISTORY_CITATION_TEMPLATES) {
    runOn(sqlite,
      'INSERT OR IGNORE INTO citation_templates (id, style_id, name, format_type, template_text, field_mappings, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        template.id,
        template.style_id,
        template.name,
        template.format_type,
        template.template_text,
        template.field_mappings,
        template.is_default,
        now,
        now
      ]
    )
  }

  runOn(sqlite, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['citation_history_seed_version', HISTORY_CITATION_SEED_VERSION])

  sqlite.prepare(
    `INSERT OR IGNORE INTO citation_styles (id, name, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('style_default_academic', '通用学术引用标准', '保留 APA、MLA、Chicago、GB/T 7714 等通用模板。', 0, now, now)

  const count = sqlite.prepare('SELECT COUNT(*) as cnt FROM citation_templates').get() as { cnt?: number } | undefined
  const hasLegacyAcademic = sqlite.prepare(
    "SELECT COUNT(*) as cnt FROM citation_templates WHERE style_id = 'style_default_academic'",
  ).get() as { cnt?: number } | undefined
  if (Number(count?.cnt || 0) > DEFAULT_HISTORY_CITATION_TEMPLATES.length && Number(hasLegacyAcademic?.cnt || 0) > 0) return

  for (const template of DEFAULT_CITATION_TEMPLATES) {
    runOn(sqlite,
      'INSERT OR IGNORE INTO citation_templates (id, style_id, name, format_type, template_text, field_mappings, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        template.id,
        template.style_id,
        template.name,
        template.format_type,
        template.template_text,
        template.field_mappings,
        template.is_default,
        now,
        now
      ]
    )
  }
}

export async function initDatabase(): Promise<void> {
  const dataDir = getDataDir()
  const dbDir = join(dataDir, 'db')

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  dbFilePath = join(dbDir, 'gujismart.db')
  const jsonDbPath = join(dbDir, 'gujismart.json')

  const existed = existsSync(dbFilePath)
  db = new Database(dbFilePath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`)
  console.log(existed ? '[Database] Loaded native SQLite database' : '[Database] Created native SQLite database')

  db.pragma('foreign_keys = ON')
  db.exec(TABLE_SCHEMA_SQL)
  migrateExistingSchema(db)

  if (!existed) {
    migrateFromJson(jsonDbPath, db)
    migrateExistingSchema(db)
    ensureIndexes(db)
  }

  ensureFts(db)

  seedDefaultData(db)
  saveDatabase()
  console.log('[Database] Initialization complete')
}

export function runDeferredStartupDatabaseMaintenance(): void {
  const database = getDatabase()
  const lastRun = queryOne<{ value?: string | null }>(
    "SELECT value FROM settings WHERE key = 'startup_database_maintenance_last_at'",
  )?.value
  const lastRunAt = lastRun ? Date.parse(lastRun) : 0
  if (Number.isFinite(lastRunAt) && Date.now() - lastRunAt < STARTUP_DATABASE_MAINTENANCE_INTERVAL_MS) return
  if (isLargeLibraryForAutomaticMaintenance(database)) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['startup_database_maintenance_skipped_large_library_at', new Date().toISOString()])
    scheduleDatabaseSave()
    return
  }

  normalizeExistingData(database)
  stripLegacyTocMetadata(database)
  ensureIndexes(database)
  if (ftsAvailable) {
    ensureFtsSeeded(database)
  }
  cleanupOrphanRows(database)
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['startup_database_maintenance_last_at', new Date().toISOString()])
  saveDatabase()
}

export function rebuildSearchTables(): void {
  const database = getDatabase()
  if (ftsAvailable) {
    rebuildFts(database)
    searchSegmentsFtsNeedsRebuild = false
    saveDatabase()
  }
}

export function refreshSearchSegmentsFtsForDocument(docId: string): void {
  if (!ftsAvailable || !docId) return
  const database = getDatabase()
  if (!searchSegmentsFtsNeedsRebuild) {
    runOn(database,
      `INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
       SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [docId]
    )
    if (searchTrigramFtsAvailable) {
      runOn(database,
        `INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)
         SELECT 'delete', rowid, COALESCE(normalized_text, text, '')
         FROM search_index_segments
         WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
        [docId]
      )
    }
  }
  runOn(database,
    `INSERT INTO search_segments_fts (rowid, title, normalized_text)
     SELECT rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
     FROM search_index_segments
     WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
    [docId]
  )
  if (searchTrigramFtsAvailable) {
    runOn(database,
      `INSERT INTO search_segments_trigram (rowid, normalized_text)
       SELECT rowid, COALESCE(normalized_text, text, '')
       FROM search_index_segments
       WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''`,
      [docId]
    )
  }
}

export function refreshSearchIndexForPages(pageIds: string[]): void {
  if (!ftsAvailable || pageIds.length === 0) return
  const database = getDatabase()
  const uniqueIds = [...new Set(pageIds.filter(Boolean))]
  if (uniqueIds.length === 0) return

  runWithBusyRetry(() => database.exec('BEGIN IMMEDIATE TRANSACTION'))
  try {
    for (const pageId of uniqueIds) {
      runOn(database, 'DELETE FROM pages_fts WHERE page_id = ?', [pageId])
      runOn(database,
        `INSERT INTO pages_fts (rowid, page_id, doc_id, page_num, content)
         SELECT rowid, id, doc_id, page_num, TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, ''))
         FROM pages
         WHERE id = ? AND TRIM(COALESCE(proofed_text, '') || ' ' || COALESCE(ocr_text, '')) != ''`,
        [pageId]
      )
    }
    runWithBusyRetry(() => database.exec('COMMIT'))
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      if (!isDatabaseBusyError(rollbackError)) throw rollbackError
    }
    throw error
  }
}

export function refreshSearchIndexForDocument(docId: string): void {
  if (!ftsAvailable || !docId) return
  runOn(getDatabase(), 'DELETE FROM pages_fts WHERE doc_id = ?', [docId])
  const pageIds = queryAll<{ id: string }>('SELECT id FROM pages WHERE doc_id = ?', [docId]).map((page) => page.id)
  refreshSearchIndexForPages(pageIds)
}

export function clearPageSearchIndexForDocuments(docIds: string[]): void {
  if (!ftsAvailable || docIds.length === 0) return
  const uniqueIds = [...new Set(docIds.map((docId) => String(docId || '').trim()).filter(Boolean))]
  if (uniqueIds.length === 0) return
  const database = getDatabase()
  const placeholders = uniqueIds.map(() => '?').join(', ')
  runOn(database, `DELETE FROM pages_fts WHERE doc_id IN (${placeholders})`, uniqueIds)
}

export function saveDatabase(): void {
  if (!db || !dbFilePath) return

  if (deferredDatabaseSaveTimer) {
    clearTimeout(deferredDatabaseSaveTimer)
    deferredDatabaseSaveTimer = null
  }

  try {
    checkpointDatabase({ retryBusy: true })
  } catch (error) {
    console.error('[Database] Save failed', error)
  }
}

export function scheduleDatabaseSave(): void {
  if (!db || !dbFilePath || deferredDatabaseSaveTimer) return

  const elapsed = Date.now() - lastDatabaseCheckpointAt
  const delay = Math.max(DATABASE_CHECKPOINT_DEFER_MS, DATABASE_CHECKPOINT_MIN_INTERVAL_MS - elapsed)
  deferredDatabaseSaveTimer = setTimeout(() => {
    deferredDatabaseSaveTimer = null
    if (!db || !dbFilePath) return

    try {
      if (!checkpointDatabase()) {
        scheduleDatabaseSave()
      }
    } catch (error) {
      console.error('[Database] Deferred save failed', error)
    }
  }, delay)
}

export function closeDatabase(): void {
  saveDatabase()

  if (db) {
    db.close()
    db = null
  }
}

export function listStoredLocalResourcePaths(options?: { includePageImages?: boolean }): string[] {
  const paths = new Set<string>()
  queryAll<{ file_path?: string | null; thumb_path?: string | null }>(
    "SELECT file_path, thumb_path FROM documents WHERE COALESCE(file_path, '') != '' OR COALESCE(thumb_path, '') != ''",
  ).forEach((row) => {
    if (row.file_path) paths.add(row.file_path)
    if (row.thumb_path) paths.add(row.thumb_path)
  })
  if (options?.includePageImages !== false) {
    queryAll<{ image_path?: string | null }>(
      "SELECT image_path FROM pages WHERE COALESCE(image_path, '') != ''",
    ).forEach((row) => {
      if (row.image_path) paths.add(row.image_path)
    })
  }
  return [...paths]
}

export function queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  const database = getDatabase()
  let rows: T[] = []
  runWithBusyRetry(() => {
    const stmt = database.prepare(sql)
    rows = params ? stmt.all(...params) as T[] : stmt.all() as T[]
  })
  return rows
}

export function queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
  const database = getDatabase()
  let row: T | undefined
  runWithBusyRetry(() => {
    const stmt = database.prepare(sql)
    row = params ? stmt.get(...params) as T | undefined : stmt.get() as T | undefined
  })
  return (row as T | undefined) || null
}

export function run(sql: string, params?: unknown[]): void {
  runOn(getDatabase(), sql, params)
}

export function transaction(fn: () => void): void {
  const database = getDatabase()
  runWithBusyRetry(() => database.exec('BEGIN IMMEDIATE TRANSACTION'))
  try {
    fn()
    runWithBusyRetry(() => database.exec('COMMIT'))
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      if (!isDatabaseBusyError(rollbackError)) throw rollbackError
    }
    throw error
  }
}

export function refreshTagUsage(): void {
  const database = getDatabase()
  updateTagUsageCounts(database)
  autoMergeDuplicateTags(database)
  updateTagUsageCounts(database)
  pruneUnusedGeneratedTags(database)
  saveDatabase()
}

export function refreshTagUsageForTags(tagIds: string[]): void {
  const uniqueIds = [...new Set((tagIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (uniqueIds.length === 0) return

  const placeholders = uniqueIds.map(() => '?').join(', ')
  transaction(() => {
    run(
      `UPDATE tags
       SET usage_count = (
         SELECT COUNT(*)
         FROM document_tags dt
         WHERE dt.tag_id = tags.id
       )
       WHERE id IN (${placeholders})`,
      uniqueIds,
    )
    run(
      `DELETE FROM tags
       WHERE id IN (${placeholders})
         AND COALESCE(usage_count, 0) = 0
         AND COALESCE(source, 'manual') != 'manual'
         AND NOT EXISTS (
           SELECT 1
           FROM tags child
           WHERE child.parent_id = tags.id
         )`,
      uniqueIds,
    )
  })
  saveDatabase()
}

