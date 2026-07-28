const assert = require('assert')
const { readFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const readSource = (...parts) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n')
const mainIndex = readSource('src', 'main', 'index.ts')
const backupSource = readSource('src', 'main', 'backup.ts')
const database = readSource('src', 'main', 'database.ts')
const documentsIpc = readSource('src', 'main', 'ipc', 'documents.ts')
const ocrIpc = readSource('src', 'main', 'ipc', 'ocr.ts')
const pdfAssets = readSource('src', 'main', 'pdf-assets.ts')
const batchProcessor = readSource('src', 'main', 'batch-processor.ts')
const libraryView = readSource('src', 'renderer', 'src', 'views', 'LibraryView.tsx')
const startupRecovery = readSource('src', 'main', 'startup-recovery.ts')
const startupTiming = readSource('src', 'main', 'startup-timing.ts')
const metadataReclassifier = readSource('src', 'main', 'metadata-reclassifier.ts')
const libraryProjectsIpc = readSource('src', 'main', 'ipc', 'library-projects.ts')
const libraryProjects = readSource('src', 'main', 'library-projects.ts')
const libraryStateCache = readSource('src', 'main', 'library-state-cache.ts')
const embeddingIndex = readSource('src', 'main', 'embedding-index.ts')
const embeddingIpc = readSource('src', 'main', 'ipc', 'embedding.ts')
const rendererMain = readSource('src', 'renderer', 'src', 'main.tsx')
const projectBootstrap = readSource('src', 'renderer', 'src', 'ProjectBootstrap.tsx')
const appShell = readSource('src', 'renderer', 'src', 'AppShell.tsx')
const electronViteConfig = readSource('electron.vite.config.ts')
const databaseMaintenance = readSource('src', 'main', 'database-maintenance.ts')
const databaseMaintenanceIpc = readSource('src', 'main', 'ipc', 'database-maintenance.ts')
const databaseDiagnosticsWorker = readSource('src', 'main', 'database-diagnostics-worker.ts')
const databaseDiagnosticsWorkerClient = readSource('src', 'main', 'database-diagnostics-worker-client.ts')
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert(start >= 0, `Missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(end > start, `Missing end marker: ${endMarker}`)
  return source.slice(start, end)
}
const initDatabaseStart = database.indexOf('export async function initDatabase(): Promise<void>')
const initDatabaseEnd = database.indexOf('export function runDeferredStartupDatabaseMaintenance', initDatabaseStart)
const initDatabaseBody = initDatabaseStart >= 0 && initDatabaseEnd > initDatabaseStart
  ? database.slice(initDatabaseStart, initDatabaseEnd)
  : ''
const existingDatabaseStartupPath = initDatabaseBody.replace(/if \(!existed\) \{[\s\S]*?\n  \}/, '')
const runStartupRecoveryStart = startupRecovery.indexOf('export async function runStartupRecovery')
const firstRecoveryCheckpoint = startupRecovery.indexOf('if (await startupRecoveryCheckpoint()) return finishCanceled()', runStartupRecoveryStart)
const recoverOcrJobs = startupRecovery.indexOf('ocr = recoverInterruptedOcrJobs()', runStartupRecoveryStart)
const resumeDeletes = startupRecovery.indexOf('deletingDocuments = resumeInterruptedDocumentDeletes()', runStartupRecoveryStart)
const resumeBatchQueue = startupRecovery.indexOf('batchProcessor.resumePendingQueueFromDatabase()', runStartupRecoveryStart)
const finalPreResumeCheckpoint = startupRecovery.lastIndexOf('if (await startupRecoveryCheckpoint()) return finishCanceled()', resumeDeletes)
const recoverableBatchOcrItemsBody = sliceBetween(
  ocrIpc,
  'function createRecoverableBatchOcrItems',
  'function updateRecoverableBatchOcrItem',
)
const autoBackupSchedulerBody = sliceBetween(
  backupSource,
  'export function startAutoBackupScheduler()',
  'export function stopAutoBackupScheduler()',
)
const orphanStorageCleanupBody = sliceBetween(
  startupRecovery,
  'async function removeOrphanStorageDirs()',
  'async function recoverInterruptedPdfCompressionSources',
)
const setActiveLibraryProjectHandler = sliceBetween(
  libraryProjectsIpc,
  "'libraryProjects:setActive'",
  "'libraryProjects:addDocuments'",
)
const projectBackgroundResumeBody = sliceBetween(
  libraryProjectsIpc,
  'function scheduleProjectBackgroundResume',
  'export function registerLibraryProjectIpc',
)
const resumeEmbeddingQueueForActiveProjectBody = sliceBetween(
  embeddingIndex,
  'export function resumeEmbeddingQueueForActiveProject()',
  '/** Startup: resume only',
)
const setActiveLibraryProjectBody = sliceBetween(
  libraryProjects,
  'export function setActiveLibraryProject(projectId: string)',
  'interface ProjectTagRow',
)
const createLibraryProjectBody = sliceBetween(
  libraryProjects,
  'export function createLibraryProject(payload: CreateLibraryProjectPayload)',
  'export function setActiveLibraryProject(projectId: string)',
)
const markLibraryStateCacheDirtyBody = sliceBetween(
  libraryStateCache,
  'export function markLibraryStateCacheDirty',
  'return getLibraryStateCache()',
)

assert(
  startupTiming.includes('export function beginStartupPhase')
    && startupTiming.includes('export async function withStartupPhase')
    && startupTiming.includes('export function logStartupTimingSummary')
    && startupTiming.includes('[StartupTiming]'),
  'Startup timing helper should expose begin/with/summary APIs and a stable log prefix for cold-start diagnosis.',
)
assert(
  mainIndex.includes("from './startup-timing'")
    && mainIndex.includes("withStartupPhase('initDatabase'")
    && mainIndex.includes("withStartupPhaseSync('createWindow'")
    && mainIndex.includes("logStartupTimingSummary('window-ready-to-show')")
    && mainIndex.includes("logStartupTimingSummary('after-createWindow')"),
  'Main open path should time initDatabase, createWindow, and window-ready checkpoints without blocking recovery.',
)
assert(
  rendererMain.includes("import ProjectBootstrap from './ProjectBootstrap'")
    && !rendererMain.includes("from './App'")
    && !rendererMain.includes("from 'antd'")
    && projectBootstrap.includes("const loadAppShell = () => import('./AppShell')")
    && projectBootstrap.includes('data-project-gate-ready="true"')
    && projectBootstrap.includes('data-library-project-choice="true"')
    && appShell.includes("import App from './App'"),
  'Project selection must stay in a lightweight renderer entry and load Ant Design/full workspace only after selection.',
)
assert(
  !mainIndex.includes('openStartupSplash()')
    && !mainIndex.includes('keepStartupSplashForDiagnostics'),
  'Normal product startup must not open or keep the temporary diagnostic splash window.',
)
const startupSplash = readSource('src', 'main', 'startup-splash.ts')
assert(
  startupSplash.includes('export function openStartupSplash')
    && startupSplash.includes('export function keepStartupSplashForDiagnostics')
    && startupSplash.includes('Intentionally disabled'),
  'Startup splash module should remain as no-op exports (diagnostic UI retired).',
)
assert(
  !startupRecovery.includes('keepStartupSplashForDiagnostics'),
  'Startup recovery must not depend on the retired diagnostic splash.',
)
assert(
  startupTiming.includes('export function setStartupTimingUiPublisher')
    && startupTiming.includes('export function getStartupTimingUiSnapshot')
    && startupTiming.includes('PHASE_LABELS')
    && startupTiming.includes('measuredLeafWorkMs')
    && startupTiming.includes('unaccountedGapMs')
    && startupTiming.includes('startedSinceBootMs')
    && startupTiming.includes('export function formatDurationZh'),
  'Startup timing UI should expose wall-clock, leaf work, gap, and timeline offsets so totals are reconcilable.',
)
assert(
  startupRecovery.includes("beginStartupPhase('startup-recovery-delay')"),
  'The fixed post-paint recovery delay must be a timed phase so wall clock is not unexplained idle.',
)
assert(
  database.includes("from './startup-timing'")
    && database.includes("withStartupPhaseSync('initDatabase.open-sqlite'")
    && database.includes("withStartupPhaseSync('initDatabase.schema-migrate'")
    && database.includes("withStartupPhaseSync('initDatabase.ensure-fts'"),
  'Database init should split open/schema/FTS into timed sub-phases for large-library diagnosis.',
)
assert(
  startupRecovery.includes("from './startup-timing'")
    && startupRecovery.includes("beginStartupPhase('startup-recovery')")
    && startupRecovery.includes("beginStartupPhase('startup-recovery.ocr-jobs')")
    && startupRecovery.includes("beginStartupPhase('startup-recovery.orphan-storage')")
    && startupRecovery.includes("logStartupTimingSummary('startup-recovery-complete'"),
  'Startup recovery should time major sub-phases and emit a completion summary.',
)
assert(
  mainIndex.includes("import { shutdownStartupRecovery } from './startup-recovery'")
    && libraryProjectsIpc.includes("import { scheduleStartupRecovery } from '../startup-recovery'"),
  'Startup recovery should be owned by the post-project-selection IPC path while shutdown remains coordinated by main.',
)
assert(
  !mainIndex.includes('await runStartupRecovery()'),
  'Startup recovery must not be awaited on the app startup path.',
)
assert(
  !/ready-to-show[\s\S]{0,240}scheduleStartupRecovery\(\)/.test(mainIndex),
  'Startup recovery must not begin while the project-selection gate is still interactive.',
)
assert(
  /ready-to-show[\s\S]{0,200}scheduleStartupMaintenance\(\)/.test(mainIndex),
  'Startup maintenance should be scheduled after the window is ready to show.',
)
assert(
  mainIndex.includes('function installConsolePipeGuards()')
    && mainIndex.includes("String((error as { code?: unknown }).code) === 'EPIPE'")
    && mainIndex.includes("process.stdout?.on('error', ignoreBrokenPipe)")
    && mainIndex.includes("process.stderr?.on('error', ignoreBrokenPipe)"),
  'Main-process logging should ignore broken stdout/stderr pipes so packaged apps do not show EPIPE error dialogs.',
)
assert(
  /if \(is\.dev \|\| process\.env\.GUJISMART_SMOKE === '1'\) \{[\s\S]{0,180}mainWindow\.webContents\.on\('console-message'/.test(mainIndex),
  'Renderer console forwarding should be limited to dev and smoke runs so packaged apps do not spam broken stdout pipes.',
)
assert(
  mainIndex.includes("const enableGpuOnWindows = process.env.GUJISMART_ENABLE_GPU === '1'")
    && mainIndex.includes("process.env.GUJISMART_DISABLE_GPU === '1'")
    && mainIndex.includes("process.platform === 'win32' && !enableGpuOnWindows")
    && !mainIndex.includes("process.platform === 'win32' || process.env.GUJISMART_SMOKE === '1'"),
  'Windows startup should keep the stable software-rendering default, with GUJISMART_ENABLE_GPU available for explicit GPU trials.',
)
assert(
  mainIndex.includes('listStoredLocalResourcePaths({ includePageImages: false })'),
  'Startup resource allow-list should not scan all page images.',
)
assert(
  backupSource.includes('function getAutoBackupScheduleState()')
    && autoBackupSchedulerBody.includes('const status = getAutoBackupScheduleState()')
    && autoBackupSchedulerBody.includes('const initialStatus = getAutoBackupScheduleState()')
    && autoBackupSchedulerBody.includes('autoBackupTimer = setInterval(tick, AUTO_BACKUP_CHECK_INTERVAL_MS)')
    && !autoBackupSchedulerBody.includes('getBackupStatus()'),
  'Auto-backup scheduler startup checks should not call getBackupStatus or immediately run due backups on large libraries.',
)
assert(
  backupSource.includes('const AUTO_BACKUP_CHECK_INTERVAL_MS = 10 * 60 * 1000')
    && !/\n\s*tick\(\)\s*\n\s*autoBackupTimer = setInterval/.test(autoBackupSchedulerBody),
  'Auto-backup scheduler should defer the first due-backup check instead of copying backup data during startup.',
)
assert(
  mainIndex.includes('const STARTUP_MAINTENANCE_DELAY_MS = 45_000')
    && /setTimeout\(\(\) => \{[\s\S]{0,1200}allowManagedFileAccessPaths\(listStoredLocalResourcePaths\(\{ includePageImages: false \}\)\)/.test(mainIndex)
    && !mainIndex.includes('resumePendingImportAutoOcrTasks(sender)')
    && !/did-finish-load[\s\S]{0,1600}batchProcessor\.resumePendingQueueFromDatabase\(\)/.test(mainIndex),
  'Startup resource allow-list preloading should be delayed, while project queues must not start before the user selects a project.',
)
assert(
  libraryProjectsIpc.includes('const PROJECT_SWITCH_BACKGROUND_RESUME_DELAY_MS = 30_000')
    && setActiveLibraryProjectHandler.includes('scheduleProjectBackgroundResume(event.sender)')
    && setActiveLibraryProjectHandler.includes('scheduleStartupRecovery()')
    && !setActiveLibraryProjectHandler.includes('markLibraryStateCacheDirty')
    && !setActiveLibraryProjectHandler.includes('resumeEmbeddingQueueForActiveProject()')
    && !setActiveLibraryProjectHandler.includes('resumePendingImportAutoOcrTasks(event.sender)')
    && projectBackgroundResumeBody.includes('resumeEmbeddingQueueForActiveProject()')
    && projectBackgroundResumeBody.includes('resumePendingImportAutoOcrTasks(sender)')
    && projectBackgroundResumeBody.includes('batchProcessor.resumePendingQueueFromDatabase()'),
  'Project selection must return before vector/OCR/batch queue recovery, then resume only the selected project after an interactive grace.',
)
assert(
  !mainIndex.includes('scheduleStartupRecovery()')
    && startupRecovery.includes('const STARTUP_RECOVERY_DELAY_MS = 15_000')
    && (startupRecovery.match(/if \(await startupRecoveryCheckpoint\(\)\) return finishCanceled\(\)/g) || []).length >= 6,
  'Startup recovery must wait for project selection, then yield between bounded phases after the selected workspace has rendered.',
)
assert(
  !embeddingIpc.includes('resumeEmbeddingQueueOnStartup')
    && !mainIndex.includes('IMPORT_AUTO_OCR_RESUME_DELAY_MS')
    && !mainIndex.includes('BATCH_OCR_RESUME_DELAY_MS'),
  'No vector or OCR queue may start while the project-selection gate is still open.',
)
assert(
  !resumeEmbeddingQueueForActiveProjectBody.includes('saveDatabase()')
    && resumeEmbeddingQueueForActiveProjectBody.includes('scheduleDatabaseSave({ minDelayMs:'),
  'Embedding queue recovery must not synchronously checkpoint a large WAL on the project-switch IPC path.',
)
assert(
  !setActiveLibraryProjectBody.includes('scheduleDatabaseSave()')
    && setActiveLibraryProjectBody.includes('active_library_project_id'),
  'Changing the active project is already durable in WAL and must not schedule an interactive-path checkpoint.',
)
assert(
  !setActiveLibraryProjectBody.includes('listLibraryProjects()')
    && !createLibraryProjectBody.includes('listLibraryProjects()')
    && libraryProjects.includes('function getLibraryProjectById(projectId: string)'),
  'Project selection and creation must not aggregate every project before returning to the selection gate.',
)
assert(
  markLibraryStateCacheDirtyBody.includes('isLargeLibraryForAutomaticMaintenance()')
    && markLibraryStateCacheDirtyBody.includes('Keeping dirty snapshot on large library')
    && markLibraryStateCacheDirtyBody.includes('scheduleLibraryStateCacheRefresh()'),
  'Dirty sidebar snapshots may refresh automatically for small libraries, but large libraries must not start a full count rebuild after project changes.',
)
assert(
  ocrIpc.includes('export function resumePendingImportAutoOcrTasks')
    && ocrIpc.includes('startAllResumableImportAutoOcrTasks')
    && ocrIpc.includes('auto-started')
    && ocrIpc.includes('runBoundedDocumentWorkers')
    && ocrIpc.includes('limit: concurrency')
    && !ocrIpc.includes('Math.min(200, Math.max(1, config.batchSize))')
    && /export function resumePendingImportAutoOcrTasks[\s\S]{0,1200}startAllResumableImportAutoOcrTasks/.test(ocrIpc),
  'Import-auto OCR should auto-start after interactive grace with bounded workers so large batches continue after restart.',
)
assert(
  startupRecovery.includes('const STARTUP_RECOVERY_DELAY_MS = 15_000')
    && startupRecovery.includes('deferred auto-resume after interactive grace')
    && !/setTimeout\(\(\) => \{[\s\S]{0,260}batchProcessor\.resumePendingQueueFromDatabase\(\)/.test(startupRecovery)
    && !/runStartupRecovery[\s\S]{0,4000}batchProcessor\.resumePendingQueueFromDatabase\(\)/.test(startupRecovery),
  'Batch OCR must not start inside open recovery; deferred main-process resume continues bulk OCR without freezing first paint.',
)
assert(
  database.includes('export function runDeferredStartupDatabaseMaintenance')
    && !/export async function initDatabase\(\): Promise<void> \{[\s\S]{0,900}ensureFtsSeeded\(db\)/.test(database)
    && !/export async function initDatabase\(\): Promise<void> \{[\s\S]{0,1200}cleanupOrphanRows\(db\)/.test(database)
    && !existingDatabaseStartupPath.includes('ensureIndexes(db)')
    && !/export async function initDatabase\(\): Promise<void> \{[\s\S]{0,900}stripLegacyTocMetadata\(db\)/.test(database)
    && !/function migrateExistingSchema\(sqlite[\s\S]{0,2600}updateTagUsageCounts\(sqlite\)/.test(database)
    && mainIndex.includes('runDeferredStartupDatabaseMaintenance()'),
  'Indexes, FTS seeding, orphan cleanup, and full-table data normalization should run as delayed maintenance instead of blocking database startup.',
)
assert(
  database.includes("legacy_toc_metadata_stripped")
    && /if \(stripped\?\.value === '1' && tocRuleVersionSynced\) return/.test(database),
  'Legacy TOC metadata cleanup should skip full-document metadata scans after it has completed once.',
)
assert(
  database.includes('tableHasMoreRowsThan')
    && database.includes('export function isLargeLibraryForAutomaticMaintenance')
    && database.includes('const LARGE_LIBRARY_AUTOMATIC_MAINTENANCE_DATABASE_BYTES = 256 * 1024 * 1024')
    && database.includes('statSync(dbFilePath).size')
    && database.includes("statSync(walPath).size")
    && !/function isLargeLibraryForAutomaticMaintenance\(sqlite[\s\S]{0,260}COUNT\(\*\)/.test(database)
    && database.includes('startup_database_maintenance_skipped_large_library_at'),
  'Large-library startup maintenance guard should include database bytes and bounded row probes before automatic maintenance.',
)
assert(
  electronViteConfig.includes("'database-diagnostics-worker': resolve(__dirname, 'src/main/database-diagnostics-worker.ts')")
    && databaseDiagnosticsWorker.includes("new Database(message.task.dbFilePath, { readonly: true, fileMustExist: true })")
    && databaseDiagnosticsWorker.includes('getPagePayloadStorageStatsForDatabase(sqlite)')
    && databaseDiagnosticsWorkerClient.includes("join(__dirname, 'database-diagnostics-worker.js')")
    && databaseMaintenance.includes('export async function getDatabaseStorageDiagnosticsAsync()')
    && databaseMaintenance.includes('runDatabaseDiagnosticsWorkerTask({')
    && databaseMaintenanceIpc.includes('return await getDatabaseStorageDiagnosticsAsync()'),
  'Automatic and settings database diagnostics should scan large payload tables in a read-only worker instead of blocking Electron main.',
)
assert(
  /function estimateStorageLayers\([\s\S]{0,220}payloadStats: PagePayloadStorageStats/.test(databaseMaintenance)
    && !/function estimateStorageLayers\([\s\S]{0,220}getPagePayloadStorageStats\(\)/.test(databaseMaintenance),
  'Database diagnostics should reuse one page-payload scan instead of repeating the full scan for storage layers.',
)
assert(
  mainIndex.includes('isLargeLibraryForAutomaticMaintenance')
    && /if \(isLargeLibraryForAutomaticMaintenance\(\)\) \{[\s\S]{0,260}Skipping automatic metadata tag reconciliation/.test(mainIndex),
  'Startup metadata tag reconciliation should be skipped for large libraries instead of doing full-library counts or rebuilds.',
)
assert(
  metadataReclassifier.includes('STARTUP_RECLASSIFY_CANDIDATE_LIMIT')
    && /ORDER BY d\.updated_at DESC, d\.created_at DESC\s+LIMIT \?/.test(metadataReclassifier)
    && metadataReclassifier.includes('STARTUP_RECLASSIFY_CANDIDATE_LIMIT + 1')
    && metadataReclassifier.includes('startup_skipped_large_library_at'),
  'Startup metadata reclassification should use a bounded candidate query and skip automatic AI work for large libraries.',
)
assert(
  /listStoredLocalResourcePaths\(options\?: \{ includePageImages\?: boolean \}\)/.test(database)
    && database.includes('options?.includePageImages !== false'),
  'Database resource path listing should support skipping page image paths.',
)
assert(
  /documents:get[\s\S]{0,1800}allowManagedFileAccessPath\(page\.image_path\)/.test(documentsIpc),
  'Full document reads should allow only managed page image paths on demand.',
)
assert(
  /documents:getLight[\s\S]{0,3200}allowManagedFileAccessPath\(page\.image_path\)/.test(documentsIpc),
  'Light document reads should allow only managed page image paths on demand.',
)
assert(
  /documents:getPagesRange[\s\S]{0,900}allowManagedFileAccessPath\(page\.image_path\)/.test(documentsIpc),
  'Paged document reads should allow only managed page image paths on demand.',
)
assert(
  /documents:getReadingWindow[\s\S]{0,1800}allowManagedFileAccessPath\(page\.image_path\)/.test(documentsIpc),
  'Reading window reads should allow only managed page image paths on demand.',
)
assert(
  libraryView.includes("event.kind === 'startup-recovery'")
    && libraryView.includes("loadDocuments(filter, { silent: true })"),
  'Library view should refresh after startup recovery completes.',
)
assert(
  documentsIpc.includes('beginDatabaseCheckpointDeferral')
    && /async function markDocumentsDeleting[\s\S]{0,900}await runAsync\([\s\S]{0,900}scheduleDatabaseSave\(\)/.test(documentsIpc)
    && /function scheduleDocumentDeleteJob[\s\S]{0,900}beginDatabaseCheckpointDeferral\(\)[\s\S]{0,1200}await markDocumentsDeleting\(docIds\)/.test(documentsIpc)
    && /function scheduleDocumentDeleteJob[\s\S]{0,5200}runDocumentDeleteWorkerTask\(\{[\s\S]{0,4200}releaseCheckpointDeferral\(\)/.test(documentsIpc)
    && !/export async function shutdownDocumentDeleteRuntime[\s\S]{0,220}saveDatabase\(\)/.test(documentsIpc),
  'Document delete markers should use WAL durability while the worker-backed delete job keeps automatic checkpoints deferred.',
)
assert(
  startupRecovery.includes('let startupRecoveryPromise: Promise<void> | null = null')
    && startupRecovery.includes('let startupRecoveryCancelRequested = false')
    && startupRecovery.includes('async function startupRecoveryCheckpoint()')
    && startupRecovery.includes('export async function shutdownStartupRecovery')
    && /export async function shutdownStartupRecovery\(\)[\s\S]{0,120}startupRecoveryCancelRequested = true[\s\S]{0,120}await startupRecoveryPromise/.test(startupRecovery)
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,500}await shutdownStartupRecovery\(\)[\s\S]{0,1200}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should ask scheduled startup recovery to stop at a safe checkpoint before closing the database.',
)
assert(
  startupRecovery.includes('function createEmptyOcrRecoverySummary')
    && runStartupRecoveryStart >= 0
    && firstRecoveryCheckpoint > runStartupRecoveryStart
    && recoverOcrJobs > firstRecoveryCheckpoint,
  'Startup recovery should honor a shutdown request before mutating OCR/database recovery state.',
)
assert(
  finalPreResumeCheckpoint > runStartupRecoveryStart
    && resumeDeletes > finalPreResumeCheckpoint
    && startupRecovery.includes('deferred auto-resume after interactive grace')
    && !startupRecovery.includes('batchProcessor.resumePendingQueueFromDatabase()'),
  'Startup recovery must not auto-start batch OCR on the open path; deferred main resume continues bulk OCR later.',
)
assert(
  startupRecovery.includes('function findRecoveredOcrDocumentsNeedingSearchIndex(candidateDocIds: string[])')
    && startupRecovery.includes('Never full-scan pages content')
    && !/function findRecoveredOcrDocumentsNeedingSearchIndex\(\): string\[]/.test(startupRecovery),
  'Search-index recovery discovery must stay ID-scoped, never full-library page content scans.',
)
assert(
  /export function scheduleStartupRecovery\(\)[\s\S]{0,160}startupRecoveryCancelRequested = false/.test(startupRecovery)
    && startupRecovery.includes('canceled?: boolean')
    && startupRecovery.includes('canceled: true')
    && startupRecovery.includes('startupRecoveryFinishedForSession')
    && startupRecovery.includes('startupRecoveryRunning || startupRecoveryFinishedForSession'),
  'A fresh scheduled startup recovery should clear stale cancel state and report canceled summaries explicitly.',
)
assert(
  mainIndex.includes('shutdownOcrRuntime')
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,900}await shutdownOcrRuntime\(\)[\s\S]{0,1800}closeDatabase\(\)/.test(mainIndex)
    && ocrIpc.includes('...activeImportAutoOcrRuns.values()'),
  'Runtime shutdown should cancel and wait for OCR work before closing the database.',
)
assert(
  mainIndex.includes('shutdownDocumentDeleteRuntime')
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,2200}await shutdownDocumentDeleteRuntime\(\)[\s\S]{0,1300}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should wait briefly for active document delete jobs before closing the database.',
)
assert(
  mainIndex.includes('shutdownDocumentImportRuntime')
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,900}await shutdownOcrRuntime\(\)[\s\S]{0,500}await shutdownDocumentImportRuntime\(\)[\s\S]{0,1700}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should wait briefly for active document imports before closing the database.',
)
assert(
  mainIndex.includes("import { batchProcessor } from './batch-processor'")
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,1000}await shutdownOcrRuntime\(\)[\s\S]{0,500}await batchProcessor\.shutdownRuntime\(\)[\s\S]{0,1700}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should abort and wait for active batch OCR work before closing the database.',
)
assert(
  mainIndex.includes('shutdownBookTranslationRuntime')
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,1300}await batchProcessor\.shutdownRuntime\(\)[\s\S]{0,500}await shutdownBookTranslationRuntime\(\)[\s\S]{0,500}await shutdownDocumentDeleteRuntime\(\)[\s\S]{0,1300}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should wait for active book translation work before delete cleanup and database close.',
)
assert(
  mainIndex.includes('shutdownPdfAssetRuntime')
    && /async function shutdownApplicationRuntime\(\)[\s\S]{0,2600}await shutdownPdfAssetRuntime\(\)[\s\S]{0,900}closeDatabase\(\)/.test(mainIndex),
  'Runtime shutdown should wait briefly for automatic PDF asset cleanup before closing the database.',
)
assert(
  /app\.on\('before-quit', \(event\) =>[\s\S]{0,500}event\.preventDefault\(\)[\s\S]{0,500}shutdownApplicationRuntime\(\)/.test(mainIndex),
  'before-quit should wait for runtime shutdown instead of closing the database immediately.',
)
assert(
  pdfAssets.includes('activeAutoCleanupPdfAssetJobs')
    && pdfAssets.includes('export async function shutdownPdfAssetRuntime')
    && /export function autoCleanupPdfAssetsIfEnabled[\s\S]{0,1200}activeAutoCleanupPdfAssetJobs\.add\(job\)/.test(pdfAssets)
    && /export function autoCleanupPdfAssetsIfEnabled[\s\S]{0,1200}activeAutoCleanupPdfAssetJobs\.delete\(job\)/.test(pdfAssets),
  'Automatic PDF asset cleanup jobs should be tracked so shutdown can wait before database close.',
)
assert(
  documentsIpc.includes('activeDocumentDeleteJobs')
    && documentsIpc.includes('export async function shutdownDocumentDeleteRuntime')
    && /function scheduleDocumentDeleteJob[\s\S]{0,5000}activeDocumentDeleteJobs\.add\(job\)[\s\S]{0,500}activeDocumentDeleteJobs\.delete\(job\)/.test(documentsIpc)
    && /export async function shutdownDocumentDeleteRuntime[\s\S]{0,500}shutdownDocumentDeleteWorkers\(\)/.test(documentsIpc),
  'Document delete jobs should be tracked so shutdown can wait for active delete cleanup.',
)
assert(
  documentsIpc.includes('activeDocumentImportJobs')
    && documentsIpc.includes('export async function shutdownDocumentImportRuntime')
    && /ipcMain\.handle\('documents:import', \([^)]*grantIds: string\[\], options\?: ImportDocumentOptions\) => trackDocumentImportJob\(\s*\(\) => withLibraryProjectContext\(/.test(documentsIpc),
  'Document import IPC jobs should be tracked so shutdown does not close the database while an import is writing.',
)
assert(
  documentsIpc.includes('export async function shutdownDocumentImportRuntime(timeoutMs = 30000)')
    && documentsIpc.includes('export async function shutdownDocumentDeleteRuntime(timeoutMs = 30000)')
    && /for \(const \[fileIndex, entry\] of lease\.entries\.entries\(\)\) \{[\s\S]{0,400}if \(documentImportShuttingDown\) break/.test(documentsIpc),
  'Document import/delete shutdown should wait long enough for database writes to settle and stop import at file boundaries.',
)
assert(
  documentsIpc.includes('activeBookTranslationJobTasks')
    && documentsIpc.includes('let bookTranslationRuntimeShuttingDown = false')
    && documentsIpc.includes('export async function shutdownBookTranslationRuntime(timeoutMs = 30000)')
    && documentsIpc.includes('await waitForBookTranslationShutdown(activeJobs, timeoutMs)')
    && documentsIpc.includes('throwIfBookTranslationShuttingDown()')
    && documentsIpc.includes('if (bookTranslationRuntimeShuttingDown) throw new Error')
    && /documents:translateBook[\s\S]{0,2400}activeBookTranslationJobTasks\.add\(task\)/.test(documentsIpc)
    && /activeBookTranslationJobTasks\.add\(task\)[\s\S]{0,500}activeBookTranslationJobTasks\.delete\(task\)/.test(documentsIpc)
    && /async function runBookTranslationJob[\s\S]{0,300}throwIfBookTranslationShuttingDown\(\)/.test(documentsIpc)
    && documentsIpc.includes('while (!bookTranslationRuntimeShuttingDown && nextPageIndex < pendingPages.length)')
    && documentsIpc.includes('if (isBookTranslationShutdownError(error)) return'),
  'Book translation jobs should be tracked, stopped, and waited during shutdown instead of writing after database close.',
)
assert(
  ocrIpc.includes('export async function shutdownOcrRuntime')
    && ocrIpc.includes('forceReleaseAllActiveOcrTasks()')
    && ocrIpc.includes('await waitForOcrShutdown(activeDoneTasks, timeoutMs)'),
  'OCR runtime shutdown should force-release active OCR tasks and wait briefly for their cleanup.',
)
assert(
  ocrIpc.includes('done: Promise<void>')
    && ocrIpc.includes('finish: () => void')
    && ocrIpc.includes('createActiveOcrTask')
    && ocrIpc.includes('activeOcrTasks.set(docId, activeTask)')
    && ocrIpc.includes('activeTask.finish()'),
  'Active OCR tasks should expose a completion promise and finish() for clean cancel/shutdown.',
)
assert(
  ocrIpc.includes('function shouldPersistBatchOcrForRecovery')
    && ocrIpc.includes('function shouldPersistBatchOcrForRecovery(_options?: BatchOcrOptions): boolean {\n  return true\n}')
    && ocrIpc.includes('function createRecoverableBatchOcrItems')
    && recoverableBatchOcrItemsBody.includes('createLegacyBatchTask(uniqueDocIds, batchSize')
    && !recoverableBatchOcrItemsBody.includes('INSERT INTO batch_queue')
    && !recoverableBatchOcrItemsBody.includes('saveDatabase()')
    && ocrIpc.includes('releaseAllLegacyBatchClaims()')
    && ocrIpc.includes('let recoverableQueueItemIdsByDocId = new Map<string, string>()')
    && ocrIpc.includes('createRecoverableBatchOcrItems(chunk, documentConcurrency)')
    && ocrIpc.includes('runBoundedDocumentWorkers')
    && ocrIpc.includes("updateRecoverableBatchOcrItem(recoverableQueueItemIdsByDocId, docId, 'processing')")
    && ocrIpc.includes('!ocrRuntimeShuttingDown')
    && ocrIpc.includes("result.success ? 'completed' : 'failed'"),
  'All batch OCR should persist for recovery, run a bounded worker pool, and release leases on shutdown so large uploads survive restarts.',
)
assert(
  batchProcessor.includes('async shutdownRuntime')
    && batchProcessor.includes('this.activeControllers.forEach((controller) => controller.abort())')
    && batchProcessor.includes('this.resetQueueItemForResume(job, docId)')
    && batchProcessor.includes('recognizePdfAsync(pdfPath, undefined, {')
    && batchProcessor.includes('signal: controller.signal')
    && batchProcessor.includes('releaseLegacyBatchItem(itemId)')
    && batchProcessor.includes('releaseAllLegacyBatchClaims()'),
  'Batch processor shutdown should cancel active OCR uploads and leave the active queue item resumable.',
)
assert(
  startupRecovery.includes('function markInterruptedImportForCleanup')
    && startupRecovery.includes("SET import_status = 'deleting'")
    && startupRecovery.includes('resumeInterruptedDocumentDeletes()'),
  'Startup recovery should turn unrecoverable half-written imports into resumable delete cleanup jobs.',
)
assert(
  startupRecovery.includes('RECOVERABLE_IMAGE_EXTENSIONS')
    && startupRecovery.includes('INSERT INTO pages')
    && startupRecovery.includes('thumb_path = COALESCE'),
  'Startup recovery should repair interrupted image imports by recreating their missing page row.',
)
assert(
  startupRecovery.includes('ORPHAN_STORAGE_CLEANUP_YIELD_INTERVAL')
    && orphanStorageCleanupBody.includes('await yieldToEventLoop()')
    && !orphanStorageCleanupBody.includes('Promise.all(entries.map'),
  'Startup recovery should clean orphan storage directories incrementally instead of deleting every leftover directory concurrently.',
)
assert(
  startupRecovery.includes('RESERVED_STORAGE_DIR_NAMES')
    && startupRecovery.includes("'page-payloads'")
    && orphanStorageCleanupBody.includes('RESERVED_STORAGE_DIR_NAMES.has(entry.name)')
    && orphanStorageCleanupBody.includes('await rm(decision.canonicalTarget'),
  'Startup recovery should preserve shared enterprise storage directories such as page-payloads.',
)
assert(
  documentsIpc.includes("pages.length, 'processing', 'pending', 'processing'")
    && documentsIpc.includes("parsedEbook.sections.length,\n              'processing'")
    && documentsIpc.includes("UPDATE documents SET ocr_status = ?, import_status = ?, error_message = NULL"),
  'JSON and ebook imports should remain processing until all page rows are written.',
)

console.log('Startup nonblocking regression passed')
