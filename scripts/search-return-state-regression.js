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

assertIncludes(searchView, 'SEARCH_RETURN_STATE_STORAGE_KEY', 'search view should have a dedicated return-state snapshot key')
assertIncludes(searchView, 'window.sessionStorage.getItem(SEARCH_RETURN_STATE_STORAGE_KEY)', 'search view should restore return state from session storage')
assertIncludes(searchView, 'window.sessionStorage.setItem(SEARCH_RETURN_STATE_STORAGE_KEY', 'search view should persist return state to session storage')
assertIncludes(searchView, 'expandedHitDocId', 'search return state should preserve the expanded document')
assertIncludes(searchView, 'documentHitPages', 'search return state should preserve per-document hit page state')
assertIncludes(searchView, 'persistCurrentSearchReturnState()', 'search view should save state before opening a document')
assertIncludes(searchView, 'clearSearchReturnState()', 'new searches and restored searches should clear stale return state')
assertIncludes(packageJson, 'check:search-return-state', 'package scripts should include the search return-state regression')

console.log('Search return-state regression checks passed.')
