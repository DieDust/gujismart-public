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

const types = read('src/shared/types.ts')
const foldersIpc = read('src/main/ipc/folders.ts')
const libraryView = read('src/renderer/src/views/LibraryView.tsx')
const libraryCache = read('src/main/library-state-cache.ts')
const preload = read('src/preload/index.ts')
const documentsIpc = read('src/main/ipc/documents.ts')
const semanticSearch = read('src/main/semantic-search.ts')
const evidenceQa = read('src/main/evidence-qa.ts')
const aiResearchIpc = read('src/main/ipc/ai-research.ts')
const folderScope = read('src/main/folder-scope.ts')
const normalizedLibraryView = libraryView.replace(/\r\n?/g, '\n')

assertIncludes(types, 'document_count?: number', 'Folder type should expose document counts')
assertIncludes(types, 'export interface LibraryStateCache', 'shared types should expose persisted library state cache')
assertIncludes(folderScope, 'export function resolveFolderAndDescendantIds', 'folder scope helper should expand parent folders to descendants')
assertIncludes(folderScope, 'export function buildCumulativeFolderDocumentCounts', 'folder scope helper should provide cumulative subtree counts')
assertIncludes(folderScope, 'collect(childId, stack).forEach((docId) => docs.add(docId))', 'folder counts should include descendant document IDs')
assertIncludes(foldersIpc, 'buildCumulativeFolderDocumentCounts()', 'folders:list should use cumulative folder document counts')
assertIncludes(foldersIpc, 'document_count: counts[folder.id] || 0', 'folders:list should expose cumulative document counts')
assertIncludes(foldersIpc, "ipcMain.handle('folders:getDocuments'", 'folder document listing should exist')
assertIncludes(foldersIpc, 'resolveFolderAndDescendantIds([folderId])', 'folders:getDocuments should include descendants')
assertIncludes(foldersIpc, 'WHERE df.folder_id IN', 'folders:getDocuments should query all folder IDs in the subtree')
assertIncludes(documentsIpc, 'resolveFolderAndDescendantIds(requestedFolderIds)', 'document list folder filter should include descendants')
assertIncludes(documentsIpc, 'requestedFolderIds.length > 0 && scopedFolderIds.length === 0', 'document list should not return all documents for missing folders')
assertIncludes(semanticSearch, 'resolveSearchFolderScopeIds', 'semantic search should centralize descendant folder scope expansion')
assertIncludes(semanticSearch, 'resolveFolderAndDescendantIds(uniqueFolderIds)', 'semantic search should expand folder filters to descendants')
assertIncludes(semanticSearch, 'if (folderIds.length === 0) return []', 'AI/search folder scope should not fall back to all documents for missing folders')
assertIncludes(evidenceQa, 'resolveFolderAndDescendantIds(uniqueStrings(scope.folderIds || []))', 'evidence QA folder scope should include descendants')
assertIncludes(aiResearchIpc, 'resolveFolderAndDescendantIds(uniqueStrings(scope.folderIds || []))', 'AI research folder scope should include descendants')
assertIncludes(preload, 'getLibraryStateCache', 'preload should expose library state cache')
assertIncludes(preload, 'refreshLibraryStateCache', 'preload should expose library state cache refresh')
assertIncludes(preload, 'markLibraryStateCacheDirty', 'preload should expose library cache dirty marker')
assertIncludes(libraryCache, 'library_state_cache', 'main process should persist library sidebar counts')
assertIncludes(libraryCache, 'refreshLibraryStateCache', 'main process should rebuild library state cache')
assertIncludes(libraryCache, 'markLibraryStateCacheDirty', 'main process should mark cache dirty after mutations')
assertIncludes(libraryCache, "const CACHE_VERSION = 'library-sidebar-v3-cumulative-folder-counts'", 'library cache version should change when folder count semantics change')
assertIncludes(libraryCache, 'payloadVersion !== CACHE_VERSION', 'library cache should invalidate old count semantics')
assertIncludes(libraryCache, 'LIBRARY_STATE_CACHE_REFRESH_DELAY_MS', 'dirty library cache refresh should be debounced')
assertIncludes(libraryCache, 'scheduleLibraryStateCacheRefresh(LIBRARY_STATE_CACHE_REFRESH_DELAY_MS)', 'old or dirty library cache should be refreshed automatically')
assertIncludes(libraryCache, 'clearTimeout(refreshTimer)', 'sidebar cache refresh should re-arm the debounce timer under mutation storms')
assertIncludes(libraryCache, "COALESCE(d.ocr_status, '') <> 'completed'", 'sidebar OCR incomplete counts should stay document-level')
assertIncludes(libraryCache, 'buildCumulativeFolderDocumentCounts()', 'library state cache should persist cumulative folder counts')
assertIncludes(libraryCache, "source: 'snapshot'", 'dirty sidebar cache should return the last persisted snapshot instead of recalculating')
assertIncludes(libraryCache, 'LIBRARY_STATE_CACHE_COLD_START_DELAY_MS', 'missing sidebar cache should schedule a deferred rebuild instead of blocking the read path')
assertIncludes(libraryCache, 'scheduleLibraryStateCacheRefresh(LIBRARY_STATE_CACHE_COLD_START_DELAY_MS)', 'cold sidebar cache rebuild should wait for interactive open grace')
assertNotIncludes(libraryCache, 'if (row.dirty !== 0) return buildLightweightCache(true)', 'dirty sidebar cache should not recalculate counts during ordinary reads')
assertNotIncludes(libraryCache, 'if (!row?.cache_json) return refreshLibraryStateCache()', 'cache reads should not rebuild full sidebar statistics')
assertNotIncludes(libraryCache, 'return refreshLibraryStateCache()', 'cache reads should not rebuild full sidebar statistics')
assertIncludes(libraryView, 'window.api.getLibraryStateCache()', 'library view should read cached sidebar counts')
assertIncludes(libraryView, 'window.api.refreshLibraryStateCache()', 'library view should keep an explicit full refresh path')
assertNotIncludes(libraryView, 'window.api.markLibraryStateCacheDirty()', 'library view should not mark cached counts dirty during ordinary sidebar refresh')
assertIncludes(libraryView, 'if (!cache || cache.dirty) return folders', 'library view should not let dirty folder counts override live folder counts')
assertIncludes(libraryView, 'if (!cache || cache.dirty) return tags', 'library view should not let dirty tag counts override live tag counts')
assertNotIncludes(libraryView, 'void loadSmartViewCounts({ refresh: true })', 'library view should not run full sidebar refresh automatically after background events')
assertNotIncludes(normalizedLibraryView, 'void loadBaseData()\n    void loadSmartViewCounts()', 'library mount should not loop by loading and resetting sidebar counts twice')
assertIncludes(libraryView, 'unfiledDocumentTotal', 'folder sidebar should display unfiled document count')
assertIncludes(libraryView, 'Number(item.document_count || 0)', 'folder sidebar should display folder document count')
assertIncludes(libraryView, 'loadSmartViewCounts', 'smart sidebar counts should load independently')
assertIncludes(libraryView, '${smartViewCounts.all}', 'smart sidebar all-documents count should always render')
assertIncludes(libraryView, '${smartViewCounts.missingMetadata}', 'smart sidebar missing metadata count should always render')
assertIncludes(libraryView, '${smartViewCounts.unrecognized}', 'smart sidebar OCR incomplete count should always render')
assertIncludes(libraryView, "'missing_metadata', 'missing_author'", 'missing metadata count should include aggregate and detailed issue types')
assertIncludes(libraryView, 'healthMetricItems', 'health panel should share corrected health counts')
assertNotIncludes(libraryView, 'listDocumentsPage(buildSmartViewCountOptions', 'library view should not fan out listDocumentsPage calls for sidebar counts')
assertNotIncludes(libraryView, 'handleWindowFocus', 'library view should not refresh the document list on every window focus')

console.log('Library sidebar count regression checks passed')
