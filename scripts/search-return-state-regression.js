const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const searchView = fs.readFileSync(path.join(root, 'src/renderer/src/views/SearchView.tsx'), 'utf8')
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8')

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertMatches(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`${label}: missing ${pattern}`)
  }
}

assertIncludes(searchView, 'SEARCH_RETURN_STATE_STORAGE_KEY', 'search view should have a dedicated return-state snapshot key')
assertIncludes(searchView, 'window.sessionStorage.getItem(SEARCH_RETURN_STATE_STORAGE_KEY)', 'search view should restore return state from session storage')
assertIncludes(searchView, 'window.sessionStorage.setItem(SEARCH_RETURN_STATE_STORAGE_KEY', 'search view should persist return state to session storage')
assertIncludes(searchView, 'expandedHitDocId', 'search return state should preserve the expanded document')
assertIncludes(searchView, 'documentHitPages', 'search return state should preserve per-document hit page state')
assertIncludes(searchView, 'persistCurrentSearchReturnState()', 'search view should save state before opening a document')
assertIncludes(searchView, 'clearSearchReturnState()', 'new searches and restored searches should clear stale return state')
assertIncludes(searchView, 'const refreshViewerHitCountsInBackground = (', 'search view should refresh exact viewer hit counts outside the first-render path')
assertIncludes(searchView, 'viewerHitCountRefreshSignatureRef', 'background hit-count refreshes should ignore stale searches')
assertIncludes(searchView, 'totalHits: groups.reduce((sum, group) => sum + group.totalHits, 0)', 'viewer hit-count refresh should keep aggregate totals consistent')
assertIncludes(searchView, 'runFulltextQuery', 'search view should isolate fulltext query so snapshot failures can soft-recover')
assertIncludes(searchView, 'search_snapshot_', 'search view should detect snapshot failures for soft recovery')
assertIncludes(searchView, 'runFulltextQuery(undefined)', 'stale snapshot recovery must re-query without snapshotId')
assertMatches(searchView, /const readerCountedGrouped = activeSort === 'hitCount'\s+\? await applyViewerHitCounts/, 'hit-count sorting should still wait for exact viewer-visible counts')
assertMatches(searchView, /if \(activeSort !== 'hitCount'\) \{\s+refreshViewerHitCountsInBackground/, 'non-hit-count searches should show results before exact viewer counts finish')
assertIncludes(packageJson, 'check:search-return-state', 'package scripts should include the search return-state regression')

console.log('Search return-state regression checks passed.')
