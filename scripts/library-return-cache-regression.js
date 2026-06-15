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

const libraryView = read('src/renderer/src/views/LibraryView.tsx')

assertIncludes(libraryView, 'interface LibraryWarmCache', 'library view should keep warm state across unmounts')
assertIncludes(libraryView, 'let libraryWarmCache: LibraryWarmCache | null = null', 'library warm cache should live outside component lifecycle')
assertIncludes(libraryView, 'buildLibraryListScopeKey', 'library warm cache should be scoped to current filter/search/sort/page size')
assertIncludes(libraryView, 'hasHydratedWarmCacheRef', 'library view should hydrate cached state only once per mount')
assertIncludes(libraryView, 'setDocuments(libraryWarmCache.documents)', 'library view should immediately restore cached documents on return')
assertIncludes(libraryView, 'setLoading(false)', 'library view should clear full-page loading after cache hydration')
assertIncludes(libraryView, 'withLibraryRequestTimeout', 'library list loads should fail visibly instead of spinning forever when IPC stalls')
assertIncludes(libraryView, '文献列表加载超时', 'library list timeout should explain how to recover')
assertIncludes(libraryView, 'const canWarmRefresh = libraryWarmCache?.scopeKey === scopeKey && libraryWarmCache.documents.length > 0', 'library reload should detect warm return state')
assertIncludes(libraryView, 'loadDocuments(filter, { reset: shouldResetList, silent: canWarmRefresh })', 'return-to-library refresh should be silent when cache is warm')
assertIncludes(libraryView, 'patchLibraryWarmCache', 'successful list/base/count loads should update warm cache')

console.log('Library return cache regression checks passed')
