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
const normalizedLibraryView = libraryView.replace(/\r\n?/g, '\n')

assertIncludes(types, 'document_count?: number', 'Folder type should expose document counts')
assertIncludes(types, 'export interface LibraryStateCache', 'shared types should expose persisted library state cache')
assertIncludes(foldersIpc, 'COUNT(DISTINCT df.doc_id) AS document_count', 'folders:list should count direct folder documents')
assertIncludes(foldersIpc, 'LEFT JOIN document_folders df ON df.folder_id = f.id', 'folders:list should preserve empty folders')
assertIncludes(preload, 'getLibraryStateCache', 'preload should expose library state cache')
assertIncludes(preload, 'refreshLibraryStateCache', 'preload should expose library state cache refresh')
assertIncludes(preload, 'markLibraryStateCacheDirty', 'preload should expose library cache dirty marker')
assertIncludes(libraryCache, 'library_state_cache', 'main process should persist library sidebar counts')
assertIncludes(libraryCache, 'refreshLibraryStateCache', 'main process should rebuild library state cache')
assertIncludes(libraryCache, 'markLibraryStateCacheDirty', 'main process should mark cache dirty after mutations')
assertIncludes(libraryCache, 'buildLightweightCache(true)', 'missing or dirty sidebar cache should use lightweight counts instead of full page scans')
assertIncludes(libraryCache, 'if (row.dirty !== 0) return buildLightweightCache(true)', 'dirty sidebar cache should not display stale cached counts')
assertNotIncludes(libraryCache, 'if (!row?.cache_json) return refreshLibraryStateCache()', 'cache reads should not rebuild full sidebar statistics')
assertNotIncludes(libraryCache, 'return refreshLibraryStateCache()', 'cache reads should not rebuild full sidebar statistics')
assertIncludes(libraryView, 'window.api.getLibraryStateCache()', 'library view should read cached sidebar counts')
assertIncludes(libraryView, 'window.api.refreshLibraryStateCache()', 'library view should keep an explicit full refresh path')
assertNotIncludes(libraryView, 'window.api.markLibraryStateCacheDirty()', 'library view should not mark cached counts dirty during ordinary sidebar refresh')
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
