const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-search-index-health-'))
const bundlePath = path.join(tempRoot, 'search-index-health.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'search-index-health.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const health = require(bundlePath)
  const ready = health.buildSearchIndexHealthDiagnostics({
    doc_id: 'doc_search',
    status: 'ready',
    source_hash: 'segments-v8:hash',
    segment_count: 8,
    error_message: null,
    indexed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })
  assert.strictEqual(ready.status, 'ready')
  assert.strictEqual(ready.is_usable, true)
  assert.strictEqual(ready.is_stale, false)
  assert.strictEqual(ready.issue_count, 0)

  const stale = health.buildSearchIndexHealthDiagnostics({
    doc_id: 'doc_search',
    status: 'queued',
    source_hash: 'segments-v8:old',
    segment_count: 4,
    error_message: null,
    indexed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  })
  assert.strictEqual(stale.status, 'stale')
  assert.strictEqual(stale.is_usable, false)
  assert.strictEqual(stale.is_stale, true)
  assert.ok(stale.issues.some((issue) => issue.code === 'search_index_refresh_pending'))

  const brokenReady = health.buildSearchIndexHealthDiagnostics({
    doc_id: 'doc_search',
    status: 'ready',
    source_hash: '',
    segment_count: 0,
    error_message: null,
    indexed_at: null,
    updated_at: null,
  })
  assert.strictEqual(brokenReady.status, 'error')
  assert.ok(brokenReady.issues.some((issue) => issue.code === 'search_index_ready_without_segments'))
  assert.ok(brokenReady.issues.some((issue) => issue.code === 'search_index_source_hash_missing'))

  const missing = health.buildSearchIndexHealthDiagnostics(null)
  assert.strictEqual(missing.status, 'unknown')
  assert.strictEqual(missing.is_usable, false)
  assert.ok(missing.issues.some((issue) => issue.code === 'search_index_status_missing'))

  const semanticSearchSource = fs.readFileSync(path.join(root, 'src', 'main', 'semantic-search.ts'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(typesSource.includes('healthDiagnostics?: SearchIndexHealthDiagnostics'), 'search index status should expose optional health diagnostics')
  assert.ok(typesSource.includes("from './search-index-health'"), 'shared types should re-export search index health contracts')
  assert.ok(semanticSearchSource.includes('statusEnvelope: statusEnvelopeFromSearchIndexStatus(row)'), 'search index status responses should include status envelopes')
  assert.ok(semanticSearchSource.includes('healthDiagnostics: buildSearchIndexHealthDiagnostics(row)'), 'search index status responses should include health diagnostics')

  console.log('Search index health regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
