import { dialog, shell } from 'electron'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { ZipArchive } from 'archiver'
import extract from 'extract-zip'
import Database from 'better-sqlite3'
import { closeDatabase, getDataDir, queryAll, run, saveDatabase } from './database'
import type { BackupImportResult, BackupResult, BackupSlot, BackupStatus, CompactAutoBackupResult } from '../shared/types'

let autoBackupTimer: ReturnType<typeof setInterval> | null = null
let autoBackupRunning = false
const MIN_AUTO_BACKUP_SLOT_COUNT = 1
const AUTO_BACKUP_SLOT_COUNT = 3
const AUTO_BACKUP_CHECK_INTERVAL_MS = 10 * 60 * 1000
const BACKUP_ARCHIVE_EXTENSION = '.zip'

interface DocumentListCsvRow {
  title: string | null
  author: string | null
  dynasty: string | null
  source: string | null
  doc_type: string | null
  page_count: number | null
  ocr_status: string | null
  proof_status: string | null
  import_status: string | null
  created_at: string | null
  updated_at: string | null
}

function normalizeAutoBackupSlotCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? AUTO_BACKUP_SLOT_COUNT), 10)
  if (!Number.isFinite(parsed)) return AUTO_BACKUP_SLOT_COUNT
  return Math.max(MIN_AUTO_BACKUP_SLOT_COUNT, Math.min(AUTO_BACKUP_SLOT_COUNT, parsed))
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

function getDirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const targetPath = join(dir, entry.name)
    if (entry.isDirectory()) return sum + getDirSize(targetPath)
    return sum + statSync(targetPath).size
  }, 0)
}

function readSetting(key: string, fallback: string): string {
  const row = queryAll<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])[0]
  return row?.value ?? fallback
}

function writeSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}

function isPathInside(parentDir: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentDir), resolve(targetPath))
  return !!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

function isSameOrInside(parentDir: string, targetPath: string): boolean {
  return resolve(parentDir) === resolve(targetPath) || isPathInside(parentDir, targetPath)
}

function assertManagedDataChild(dataDir: string, targetPath: string): void {
  if (!isPathInside(dataDir, targetPath)) {
    throw new Error(`拒绝操作数据目录之外的路径：${targetPath}`)
  }
}

function ensureZipExtension(filePath: string): string {
  return extname(filePath).toLowerCase() === BACKUP_ARCHIVE_EXTENSION ? filePath : `${filePath}${BACKUP_ARCHIVE_EXTENSION}`
}

function createTempBackupDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

async function writeBackupZip(sourceDir: string, archivePath: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(archivePath)
    const archive = new ZipArchive({ zlib: { level: 6 } })

    output.on('close', () => resolvePromise())
    output.on('error', rejectPromise)
    archive.on('warning', (error: Error) => rejectPromise(error))
    archive.on('error', rejectPromise)

    archive.pipe(output)
    archive.directory(sourceDir, false)
    void archive.finalize()
  })
}

function assertSafeExtractEntry(entryPath: string): void {
  const normalized = normalize(entryPath)
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes(`..\\`) || normalized.includes('../')) {
    throw new Error('备份压缩包包含不安全路径，已拒绝导入')
  }
}

async function extractBackupZip(archivePath: string): Promise<string> {
  const targetDir = createTempBackupDir('gujismart-backup-import')
  try {
    await extract(archivePath, {
      dir: targetDir,
      onEntry: (entry) => assertSafeExtractEntry(entry.fileName),
    })
    return targetDir
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true })
    throw error
  }
}

function getBackupDbDir(backupDir: string): string {
  return join(backupDir, 'db')
}

function getBackupStorageDir(backupDir: string): string {
  return join(backupDir, 'storage')
}

function getStoragePagePayloadsDir(storageDir: string): string {
  return join(storageDir, 'page-payloads')
}

function hasBackupDatabase(backupDir: string): boolean {
  const dbDir = getBackupDbDir(backupDir)
  return existsSync(join(dbDir, 'gujismart.db')) || existsSync(join(dbDir, 'gujismart.json'))
}

function collectBackupExternalPayloadRefs(backupDir: string): Set<string> {
  const dbPath = join(getBackupDbDir(backupDir), 'gujismart.db')
  const refs = new Set<string>()
  if (!existsSync(dbPath)) return refs
  let sqlite: Database.Database | null = null
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>
    const tableNames = new Set(tables.map((table) => String(table.name || '')))
    const checks: Array<{ table: string; columns: string[] }> = [
      { table: 'pages', columns: ['ocr_text_ref', 'ocr_result_ref', 'proofed_text_ref'] },
      { table: 'page_ocr_versions', columns: ['ocr_text_ref', 'ocr_result_ref'] },
      { table: 'page_ai_layout_cache', columns: ['result_text_ref'] },
      { table: 'page_translation_cache', columns: ['source_text_ref', 'translation_text_ref'] },
    ]
    for (const check of checks) {
      if (!tableNames.has(check.table)) continue
      const columns = sqlite.prepare(`PRAGMA table_info(${check.table})`).all() as Array<{ name?: string }>
      const columnNames = new Set(columns.map((column) => String(column.name || '')))
      const existingColumns = check.columns.filter((column) => columnNames.has(column))
      if (existingColumns.length === 0) continue
      const predicate = existingColumns.map((column) => `COALESCE(${column}, '') <> ''`).join(' OR ')
      const rows = sqlite.prepare(`SELECT ${existingColumns.join(', ')} FROM ${check.table} WHERE ${predicate}`).all() as Array<Record<string, unknown>>
      for (const row of rows) {
        for (const column of existingColumns) {
          const ref = typeof row[column] === 'string' ? String(row[column]) : ''
          if (ref.startsWith('page-payload:')) refs.add(ref)
        }
      }
    }
    return refs
  } finally {
    sqlite?.close()
  }
}

function backupSqliteHasExternalPayloadRefs(backupDir: string): boolean {
  return collectBackupExternalPayloadRefs(backupDir).size > 0
}

function resolveBackupPayloadRefPath(payloadRoot: string, ref: string): string | null {
  const relativePath = ref.replace(/^page-payload:v\d+:/, '')
  if (!relativePath || relativePath === ref || relativePath.includes('..')) return null
  const root = normalize(payloadRoot)
  const target = normalize(join(root, ...relativePath.split('/')))
  if (!target.toLowerCase().startsWith(root.toLowerCase())) return null
  return target
}

function validateBackupPayloadCompleteness(backupDir: string): void {
  const refs = collectBackupExternalPayloadRefs(backupDir)
  if (refs.size === 0) return
  const payloadRoot = getStoragePagePayloadsDir(getBackupStorageDir(backupDir))
  if (!existsSync(payloadRoot)) {
    throw new Error('备份不完整：数据库引用了外置 OCR 大字段，但备份目录缺少 storage/page-payloads。请导入完整备份，否则版式还原、OCR 结果、检索和导出可能缺失。')
  }
  let missing = 0
  for (const ref of refs) {
    const payloadPath = resolveBackupPayloadRefPath(payloadRoot, ref)
    if (!payloadPath || !existsSync(payloadPath)) missing += 1
  }
  if (missing > 0) {
    throw new Error(`备份不完整：数据库引用了 ${refs.size.toLocaleString()} 个外置 OCR 大字段，其中 ${missing.toLocaleString()} 个文件缺失。请导入完整备份，否则版式还原、OCR 结果、检索和导出可能缺失。`)
  }
}

function validateBackupDirectory(backupDir: string): void {
  if (!existsSync(backupDir)) {
    throw new Error('备份目录不存在')
  }
  const dataDir = getDataDir()
  if (resolve(backupDir) === resolve(dataDir)) {
    throw new Error('不能把当前数据目录作为备份导入')
  }
  if (isSameOrInside(join(dataDir, 'db'), backupDir) || isSameOrInside(join(dataDir, 'storage'), backupDir)) {
    throw new Error('不能从当前数据库或文献存储目录内导入备份')
  }
  if (!hasBackupDatabase(backupDir)) {
    throw new Error('这不是有效的备份目录：未找到 db/gujismart.db 或 db/gujismart.json')
  }
  validateBackupPayloadCompleteness(backupDir)
}

function replaceManagedDirectory(dataDir: string, directoryName: 'db' | 'storage', sourceDir: string): void {
  const targetDir = resolve(dataDir, directoryName)
  assertManagedDataChild(dataDir, targetDir)
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (existsSync(sourceDir)) {
    copyDirRecursive(sourceDir, targetDir)
  } else {
    mkdirSync(targetDir, { recursive: true })
  }
}

async function createSafetyBackupBeforeImport(dataDir: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safetyBackupRoot = join(dataDir, 'pre-import-backups')
  const safetyBackupPath = join(safetyBackupRoot, `before-import-${timestamp}.zip`)
  const tempBackupDir = createTempBackupDir('gujismart-pre-import-backup')
  assertManagedDataChild(dataDir, safetyBackupRoot)
  assertManagedDataChild(dataDir, safetyBackupPath)
  try {
    mkdirSync(safetyBackupRoot, { recursive: true })
    copyCurrentDataTo(tempBackupDir, 'manual')
    await writeBackupZip(tempBackupDir, safetyBackupPath)
    return safetyBackupPath
  } finally {
    rmSync(tempBackupDir, { recursive: true, force: true })
  }
}

function getAutoBackupRoot(): string {
  return join(getDataDir(), 'auto-backups')
}

function getSlotPath(slot: number): string {
  return join(getAutoBackupRoot(), `slot-${slot}`)
}

function getAutoBackupSlotCount(): number {
  const stored = readSetting('auto_backup_slot_count', String(AUTO_BACKUP_SLOT_COUNT))
  const slotCount = normalizeAutoBackupSlotCount(stored)
  if (String(slotCount) !== stored) {
    writeSetting('auto_backup_slot_count', String(slotCount))
  }
  return slotCount
}

function getAutoBackupIncludeStorage(): boolean {
  return readSetting('auto_backup_include_storage', 'true') !== 'false'
}

function getAutoBackupScheduleState(): { enabled: boolean; intervalHours: number; lastBackupAt: string | null } {
  return {
    enabled: readSetting('auto_backup_enabled', 'true') !== 'false',
    intervalHours: Number.parseInt(readSetting('auto_backup_interval_hours', '24'), 10) || 24,
    lastBackupAt: readSetting('auto_backup_last_at', '') || null,
  }
}

function copyStorageForBackup(dataDir: string, backupDir: string, includeFullStorage: boolean): void {
  const sourceStorageDir = join(dataDir, 'storage')
  if (!existsSync(sourceStorageDir)) return

  const targetStorageDir = join(backupDir, 'storage')
  if (includeFullStorage) {
    copyDirRecursive(sourceStorageDir, targetStorageDir)
    return
  }

  const sourcePayloadDir = getStoragePagePayloadsDir(sourceStorageDir)
  if (existsSync(sourcePayloadDir)) {
    copyDirRecursive(sourcePayloadDir, getStoragePagePayloadsDir(targetStorageDir))
  }
}

function cleanupExtraAutoBackupSlots(slotCount = AUTO_BACKUP_SLOT_COUNT): void {
  const root = resolve(getAutoBackupRoot())
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = entry.name.match(/^slot-(\d+)$/)
    if (!match) continue
    const slot = Number(match[1])
    if (!Number.isFinite(slot) || slot <= slotCount) continue
    const target = resolve(root, entry.name)
    if (target === root || !isPathInside(root, target)) continue
    rmSync(target, { recursive: true, force: true })
  }
}

function writeManifest(backupDir: string, type: 'manual' | 'auto', slot?: number, includesStorage = true): void {
  const manifest = {
    version: '1.0.0',
    app: '文献管理',
    type,
    slot: slot ?? null,
    includesStorage,
    includesPagePayloads: existsSync(getStoragePagePayloadsDir(getBackupStorageDir(backupDir))),
    timestamp: new Date().toISOString(),
  }
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

function copyCurrentDataTo(backupDir: string, type: 'manual' | 'auto', slot?: number, options?: { includeStorage?: boolean }): string {
  const dataDir = getDataDir()
  saveDatabase()
  const includeStorage = options?.includeStorage ?? true

  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true })
  }
  mkdirSync(backupDir, { recursive: true })

  const dbDir = join(dataDir, 'db')
  if (existsSync(dbDir)) {
    copyDirRecursive(dbDir, join(backupDir, 'db'))
  }

  copyStorageForBackup(dataDir, backupDir, includeStorage)

  writeManifest(backupDir, type, slot, includeStorage)
  return backupDir
}

export async function backupData(): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '备份数据',
    defaultPath: `文献管理_备份_${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'GujiSmart 备份压缩包', extensions: ['zip'] }]
  })

  if (canceled || !filePath) return null

  const archivePath = ensureZipExtension(filePath)
  const tempBackupDir = createTempBackupDir('gujismart-backup-export')
  try {
    copyCurrentDataTo(tempBackupDir, 'manual')
    await writeBackupZip(tempBackupDir, archivePath)
    return archivePath
  } catch (error) {
    console.error('[Backup] 备份失败:', error)
    throw new Error(`备份失败: ${(error as Error).message}`)
  } finally {
    rmSync(tempBackupDir, { recursive: true, force: true })
  }
}

export async function importBackupData(): Promise<BackupImportResult> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入备份并恢复',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'GujiSmart 备份压缩包或旧版备份目录', extensions: ['zip'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })

  if (canceled || filePaths.length === 0) {
    return { success: false, canceled: true, path: null }
  }

  return importBackupFromPath(filePaths[0])
}

export async function importBackupFromPath(inputPath: string): Promise<BackupImportResult> {
  const rawPath = String(inputPath || '').trim()
  if (!rawPath) {
    return { success: false, canceled: true, path: null }
  }

  let extractedBackupDir: string | null = null
  try {
    const selectedPath = resolve(rawPath)
    const isArchive = statSync(selectedPath).isFile() || extname(selectedPath).toLowerCase() === BACKUP_ARCHIVE_EXTENSION
    extractedBackupDir = isArchive ? await extractBackupZip(selectedPath) : null
    const backupDir = extractedBackupDir || selectedPath
    validateBackupDirectory(backupDir)

    const dataDir = getDataDir()
    const safetyBackupPath = await createSafetyBackupBeforeImport(dataDir)

    closeDatabase()
    replaceManagedDirectory(dataDir, 'db', getBackupDbDir(backupDir))
    replaceManagedDirectory(dataDir, 'storage', getBackupStorageDir(backupDir))

    return {
      success: true,
      path: selectedPath,
      importedBackupPath: selectedPath,
      safetyBackupPath,
      requiresRestart: true,
    }
  } catch (error) {
    console.error('[Backup] 导入备份失败:', error)
    throw new Error(`导入备份失败: ${(error as Error).message}`)
  } finally {
    if (extractedBackupDir) rmSync(extractedBackupDir, { recursive: true, force: true })
  }
}

export async function restoreData(): Promise<boolean> {
  const result = await importBackupData()
  return result.success
}

export async function runAutoBackupNow(): Promise<BackupResult> {
  if (autoBackupRunning) {
    return { success: false, error: '自动备份正在进行中' }
  }

  autoBackupRunning = true
  try {
    const slotCount = getAutoBackupSlotCount()
    cleanupExtraAutoBackupSlots(slotCount)
    const currentSlot = Math.max(1, Math.min(slotCount, Number.parseInt(readSetting('auto_backup_next_slot', '1'), 10) || 1))
    const backupDir = getSlotPath(currentSlot)
    copyCurrentDataTo(backupDir, 'auto', currentSlot, { includeStorage: getAutoBackupIncludeStorage() })

    const nextSlot = currentSlot >= slotCount ? 1 : currentSlot + 1
    const now = new Date().toISOString()
    writeSetting('auto_backup_next_slot', String(nextSlot))
    writeSetting('auto_backup_last_at', now)
    saveDatabase()

    return { success: true, path: backupDir }
  } catch (error) {
    console.error('[Backup] 自动备份失败:', error)
    return { success: false, error: (error as Error).message }
  } finally {
    autoBackupRunning = false
  }
}

export function getBackupStatus(): BackupStatus {
  const enabled = readSetting('auto_backup_enabled', 'true') !== 'false'
  const intervalHours = Number.parseInt(readSetting('auto_backup_interval_hours', '24'), 10) || 24
  const slotCount = getAutoBackupSlotCount()
  const includeStorage = getAutoBackupIncludeStorage()
  cleanupExtraAutoBackupSlots(slotCount)
  const nextSlot = Math.max(1, Math.min(slotCount, Number.parseInt(readSetting('auto_backup_next_slot', '1'), 10) || 1))
  const lastBackupAt = readSetting('auto_backup_last_at', '') || null
  const nextBackupAt = enabled && lastBackupAt
    ? new Date(new Date(lastBackupAt).getTime() + intervalHours * 60 * 60 * 1000).toISOString()
    : null
  const slots: BackupSlot[] = Array.from({ length: slotCount }, (_, index) => {
    const slot = index + 1
    const path = getSlotPath(slot)
    const manifestPath = join(path, 'manifest.json')
    let timestamp: string | undefined
    let includesStorage: boolean | undefined
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        timestamp = manifest.timestamp
        includesStorage = manifest.includesStorage !== false
      } catch {
        timestamp = undefined
      }
    }
    return {
      slot,
      path,
      exists: existsSync(path),
      timestamp,
      includesStorage: includesStorage ?? existsSync(getBackupStorageDir(path)),
      sizeBytes: existsSync(path) ? getDirSize(path) : 0,
    }
  })

  return {
    enabled,
    intervalHours,
    slotCount,
    nextSlot,
    includeStorage,
    lastBackupAt,
    nextBackupAt,
    autoBackupRoot: getAutoBackupRoot(),
    slots,
  }
}

export function configureAutoBackup(
  enabled: boolean,
  intervalHours: number,
  includeStorage = true,
  slotCount = getAutoBackupSlotCount(),
): BackupStatus {
  const normalizedSlotCount = normalizeAutoBackupSlotCount(slotCount)
  const nextSlot = Math.max(1, Math.min(normalizedSlotCount, Number.parseInt(readSetting('auto_backup_next_slot', '1'), 10) || 1))
  writeSetting('auto_backup_enabled', enabled ? 'true' : 'false')
  writeSetting('auto_backup_interval_hours', String(Math.max(1, intervalHours)))
  writeSetting('auto_backup_include_storage', includeStorage ? 'true' : 'false')
  writeSetting('auto_backup_slot_count', String(normalizedSlotCount))
  writeSetting('auto_backup_next_slot', String(nextSlot))
  cleanupExtraAutoBackupSlots(normalizedSlotCount)
  saveDatabase()
  startAutoBackupScheduler()
  return getBackupStatus()
}

export async function compactAutoBackups(): Promise<CompactAutoBackupResult> {
  if (autoBackupRunning) {
    return { success: false, beforeBytes: 0, afterBytes: 0, bytesFreed: 0, error: '自动备份正在运行中' }
  }

  const root = getAutoBackupRoot()
  const beforeBytes = getDirSize(root)
  try {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
    mkdirSync(root, { recursive: true })
    writeSetting('auto_backup_include_storage', 'true')
    writeSetting('auto_backup_next_slot', '1')
    saveDatabase()
    const backup = await runAutoBackupNow()
    const afterBytes = getDirSize(root)
    return {
      success: backup.success,
      beforeBytes,
      afterBytes,
      bytesFreed: Math.max(0, beforeBytes - afterBytes),
      backup,
      error: backup.error,
    }
  } catch (error) {
    const afterBytes = getDirSize(root)
    return {
      success: false,
      beforeBytes,
      afterBytes,
      bytesFreed: Math.max(0, beforeBytes - afterBytes),
      error: (error as Error).message,
    }
  }
}

export function startAutoBackupScheduler(): void {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer)
    autoBackupTimer = null
  }

  const initialStatus = getAutoBackupScheduleState()
  if (initialStatus.enabled && !initialStatus.lastBackupAt) {
    writeSetting('auto_backup_last_at', new Date().toISOString())
    saveDatabase()
  }

  const tick = () => {
    const status = getAutoBackupScheduleState()
    if (!status.enabled) return
    if (!status.lastBackupAt) {
      writeSetting('auto_backup_last_at', new Date().toISOString())
      saveDatabase()
      return
    }

    const dueAt = new Date(status.lastBackupAt).getTime() + status.intervalHours * 60 * 60 * 1000
    if (Date.now() >= dueAt) {
      void runAutoBackupNow()
    }
  }

  autoBackupTimer = setInterval(tick, AUTO_BACKUP_CHECK_INTERVAL_MS)
}

export function stopAutoBackupScheduler(): void {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer)
    autoBackupTimer = null
  }
}

export async function openDataDirectory(): Promise<boolean> {
  await shell.openPath(getDataDir())
  return true
}

export async function openAutoBackupDirectory(): Promise<boolean> {
  const root = getAutoBackupRoot()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  await shell.openPath(root)
  return true
}

export async function exportDocumentListCsv(): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出文献清单',
    defaultPath: `文献管理_文献清单_${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })

  if (canceled || !filePath) return null

  const rows = queryAll<DocumentListCsvRow>(
    `SELECT title, author, dynasty, source, doc_type, page_count, ocr_status, proof_status, import_status, created_at, updated_at
     FROM documents
     ORDER BY updated_at DESC`
  )
  const headers = ['标题', '作者', '朝代/年份', '来源', '类型', '页数', 'OCR状态', '校对状态', '入库状态', '创建时间', '更新时间']
  const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => [
      row.title,
      row.author,
      row.dynasty,
      row.source,
      row.doc_type,
      row.page_count,
      row.ocr_status,
      row.proof_status,
      row.import_status,
      row.created_at,
      row.updated_at,
    ].map(escapeCsv).join(','))
  ]
  writeFileSync(filePath, '\ufeff' + lines.join('\n'), 'utf-8')
  return filePath
}
