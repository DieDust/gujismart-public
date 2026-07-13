const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  if (start < 0) throw new Error(`${label}: missing start ${startNeedle}`)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`${label}: missing end ${endNeedle}`)
  return source.slice(start, end)
}

const packageJson = JSON.parse(read('package.json'))
const documentsIpc = read('src/main/ipc/documents.ts')
const database = read('src/main/database.ts')

const deleteFtsBody = sliceBetween(
  documentsIpc,
  'async function deleteFtsRowsByDocIdsAsync',
  'async function deleteAiChatTurnsByDocIdsAsync',
  'document delete FTS cleanup body',
)
const deleteDataBody = sliceBetween(
  documentsIpc,
  'async function deleteDocumentData',
  'function refreshDeletedDocumentTags',
  'document delete data body',
)
const deleteJobBody = sliceBetween(
  documentsIpc,
  'function scheduleDocumentDeleteJob',
  'function waitForDocumentDeleteShutdown',
  'document delete job body',
)
const markDeletingBody = sliceBetween(
  documentsIpc,
  'function markDocumentsDeleting',
  'function markDocumentsDeleteFailed',
  'document delete marker body',
)
const deleteByIdsBody = sliceBetween(
  documentsIpc,
  'async function deleteDocumentsByIds',
  "ipcMain.handle('documents:savePages'",
  'document delete submission body',
)
const fileCleanupBody = sliceBetween(
  documentsIpc,
  'async function cleanupDeletedDocumentFilesInBackground',
  'function scheduleDocumentDeleteJob',
  'document file cleanup body',
)
const resetSearchTablesBody = sliceBetween(
  database,
  'export function resetRebuildableSearchTables',
  'export function refreshSearchSegmentsFtsForDocument',
  'database rebuildable search reset body',
)

assertIncludes(documentsIpc, 'function isDatabaseMalformedError', 'document deletion should detect SQLite malformed errors')
assertIncludes(documentsIpc, 'formatDocumentDeleteFailureMessage', 'document deletion should explain unrecovered database failures in user-facing text')
assertIncludes(documentsIpc, 'recoverableSearchIndexMalformed', 'delete steps should distinguish recoverable search index corruption from core table failures')
assertIncludes(documentsIpc, 'resetRebuildableSearchTables', 'document deletion should reset rebuildable search tables after a malformed search-index failure')
assertIncludes(documentsIpc, 'queueAllDocumentsReindex', 'document deletion should requeue search indexing after resetting rebuildable indexes')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_ngram_index'", 'legacy ngram cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('fts'", 'FTS cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_index_segments'", 'segment index cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "runSearchIndexStep('search_index_status'", 'search status cleanup should be treated as rebuildable during delete')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('pages'", 'page rows should remain a core delete step')
assertIncludes(deleteDataBody, "timeDeleteStepAsync('documents'", 'document rows should remain a core delete step')
assertNotIncludes(deleteDataBody, "runSearchIndexStep('pages'", 'page table corruption must not be ignored as a rebuildable index issue')
assertNotIncludes(deleteDataBody, "runSearchIndexStep('documents'", 'document table corruption must not be ignored as a rebuildable index issue')
assertIncludes(deleteFtsBody, "INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)", 'external-content FTS cleanup should use the FTS5 delete command')
assertIncludes(deleteFtsBody, "SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')", 'segment FTS delete should provide the old indexed column values')
assertIncludes(deleteFtsBody, "INSERT INTO search_segments_trigram(search_segments_trigram, rowid, normalized_text)", 'trigram FTS cleanup should use the FTS5 delete command')
assertNotIncludes(deleteFtsBody, 'DELETE FROM search_segments_fts WHERE rowid IN', 'external-content segment FTS should not be cleaned with raw DELETE')
assertNotIncludes(deleteFtsBody, 'DELETE FROM search_segments_trigram WHERE rowid IN', 'external-content trigram FTS should not be cleaned with raw DELETE')
assertIncludes(deleteJobBody, 'if (deleteResult.recoveredSearchIndexIssue)', 'delete job should branch after recovering a rebuildable search-index issue')
assertIncludes(deleteJobBody, 'queueAllDocumentsReindex()', 'delete job should rebuild search indexes for remaining documents after reset')
assertIncludes(markDeletingBody, 'scheduleDatabaseSave()', 'delete marker should defer WAL checkpoint work off the IPC response path')
assertNotIncludes(markDeletingBody, 'saveDatabase()', 'delete marker should not synchronously checkpoint the database')
assertNotIncludes(deleteByIdsBody, 'getDeleteCleanupTasks(', 'delete submission should not inspect every document directory synchronously')
assertNotIncludes(deleteByIdsBody, 'getAffectedTagIdsForDelete(', 'delete submission should not scan tag relations synchronously')
assertIncludes(deleteJobBody, 'getDeleteCleanupTasks', 'background delete job should prepare safe cleanup targets')
assertIncludes(deleteJobBody, 'const tagIds = getAffectedTagIdsForDelete(docIds)', 'background delete job should capture affected tags before deleting relations')
assertNotIncludes(documentsIpc, 'scheduleDocumentDeleteJob(existingIds, tagIds)', 'interrupted delete recovery should use the same nonblocking scheduler contract')
assertIncludes(fileCleanupBody, 'DELETE_FILE_CLEANUP_CONCURRENCY', 'document file cleanup should use bounded concurrency')
assertIncludes(fileCleanupBody, 'await Promise.all(workers)', 'document file cleanup should wait for its bounded workers')

assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_segments_trigram', 'reset should drop trigram FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_segments_fts', 'reset should drop segment FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS pages_fts', 'reset should drop page FTS')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_ngram_index', 'reset should drop legacy ngram index')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_index_segments', 'reset should drop segment index')
assertIncludes(resetSearchTablesBody, 'DROP TABLE IF EXISTS search_index_status', 'reset should drop index status')
assertIncludes(resetSearchTablesBody, 'CREATE TABLE IF NOT EXISTS search_index_segments', 'reset should recreate segment index schema')
assertIncludes(resetSearchTablesBody, 'CREATE TABLE IF NOT EXISTS search_index_status', 'reset should recreate status schema')
assertIncludes(resetSearchTablesBody, 'ensureIndexes(database)', 'reset should recreate normal indexes')
assertIncludes(resetSearchTablesBody, 'ensureFts(database)', 'reset should recreate FTS tables')
assertIncludes(resetSearchTablesBody, 'rebuildFts(database)', 'reset should repopulate page FTS before background segment rebuild catches up')

if (packageJson.scripts['check:document-delete-resilience'] !== 'node scripts/document-delete-search-index-resilience-regression.js') {
  throw new Error('package.json is missing check:document-delete-resilience')
}
if (!String(packageJson.scripts.check || '').includes('check:document-delete-resilience')) {
  throw new Error('npm run check does not include check:document-delete-resilience')
}

console.log('Document delete search-index resilience regression checks passed')
