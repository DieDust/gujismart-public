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
const semanticSearch = read('src/main/semantic-search.ts')

const repairBody = sliceBetween(
  semanticSearch,
  'function repairUsableLegacySearchIndexStatus',
  'function isUsableSearchIndexStatus',
  'legacy status repair body',
)
const usableBody = sliceBetween(
  semanticSearch,
  'function isUsableSearchIndexStatus',
  'export function isSearchIndexUsableForDocument',
  'usable status body',
)
const scheduleBody = sliceBetween(
  semanticSearch,
  'function scheduleBackgroundReindex',
  'function parseSegmentMeta',
  'schedule reindex body',
)
const checkScopeBody = sliceBetween(
  semanticSearch,
  'function checkSearchIndexForScope',
  'function matchesDocumentFilters',
  'check search index scope body',
)
const queryBody = sliceBetween(
  semanticSearch,
  'export function querySearchV2',
  'export function getDocumentSearchHits',
  'query search body',
)

assertIncludes(semanticSearch, 'type SearchIndexReindexReason =', 'search index reindex reasons should be typed')
assertIncludes(semanticSearch, 'function getSearchIndexReindexReasonLabel', 'background task message should explain why indexing starts')
assertIncludes(semanticSearch, 'function getSearchIndexReindexMessage', 'background task message should be built from the reason')
assertIncludes(scheduleBody, 'reason?: SearchIndexReindexReason', 'schedule function should accept a reason')
assertIncludes(scheduleBody, 'message: getSearchIndexReindexMessage(options.reason)', 'queued task should include reason-aware message')

assertIncludes(repairBody, "if (current?.status === 'ready') return false", 'legacy repair should allow missing status recovery')
assertIncludes(repairBody, 'isStoredSearchIndexCurrentForDocument(docId, stats)', 'legacy repair should verify current segments before restoring')
assertIncludes(repairBody, 'restoreSearchIndexStatusFromSegments(docId, stats)', 'legacy repair should restore ready status from valid segments')
assertIncludes(usableBody, 'if (!current) return repairUsableLegacySearchIndexStatus(docId, current)', 'missing status with valid segments should not force reindex')

assertIncludes(checkScopeBody, 'const scoped = uniqueDocIds.length > 0', 'scope checker should distinguish scoped and global scans')
assertIncludes(checkScopeBody, 'staleDocIds.length > 0 && scoped && options.autoReindex !== false', 'global stale scans should not auto queue reindex')
assertIncludes(checkScopeBody, "scheduleBackgroundReindex(staleDocIds, { reason: 'search-scope-stale' })", 'scoped stale scans should queue with a reason')

assertIncludes(queryBody, 'const autoReindex = options?.autoReindex !== false', 'query search should compute autoReindex before stale managed-text checks')
assertIncludes(queryBody, 'if (autoReindex && scopedDocIds && scopedDocIds.length > 0 && scopedDocIds.length <= 8)', 'small scoped managed-text repair should respect autoReindex')
assertNotIncludes(queryBody, 'if (scopedDocIds && scopedDocIds.length > 0 && scopedDocIds.length <= 8)', 'small scoped repair must not ignore autoReindex')
assertIncludes(queryBody, 'if (autoReindex && !!scopedDocIds)', 'warnings should only describe active background indexing for scoped searches')
assertIncludes(queryBody, '不会自动启动全库重建', 'global search should warn instead of silently starting full rebuild')
assertNotIncludes(queryBody, 'scheduleBackgroundReindex(staleDocIds)\\n      warnings.push', 'query search should not queue stale docs a second time')
assertIncludes(semanticSearch, "scheduleBackgroundReindex([docId], { reason: 'manual' })", 'manual single-document reindex should include reason')
assertIncludes(semanticSearch, "scheduleBackgroundReindex(docs.map((doc) => doc.id), { reason: 'manual' })", 'manual all-document reindex should include reason')
assertIncludes(semanticSearch, "scheduleBackgroundReindex([docId], { reason: 'search-hit-locator' })", 'hit locator repair should include reason')

if (packageJson.scripts['check:search-index-auto-rebuild'] !== 'node scripts/search-index-auto-rebuild-regression.js') {
  throw new Error('package.json is missing check:search-index-auto-rebuild')
}
if (!String(packageJson.scripts.check || '').includes('check:search-index-auto-rebuild')) {
  throw new Error('npm run check does not include check:search-index-auto-rebuild')
}

console.log('Search index auto-rebuild regression checks passed.')
