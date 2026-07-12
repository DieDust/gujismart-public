const assert = require('assert')
const { mkdtempSync, readFileSync, rmSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-stable-locator-'))
const outfile = path.join(tempRoot, 'stable-locator.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src/shared/stable-reader-locator.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  })
  const locator = require(outfile)
  const semanticSearchSource = readFileSync(path.join(root, 'src/main/semantic-search.ts'), 'utf8')
  const searchViewSource = readFileSync(path.join(root, 'src/renderer/src/views/SearchView.tsx'), 'utf8')
  const workspaceSource = readFileSync(path.join(root, 'src/renderer/src/utils/appWorkspace.ts'), 'utf8')
  const researchSource = readFileSync(path.join(root, 'src/main/ipc/search.ts'), 'utf8')
  assert.match(semanticSearchSource, /stableLocatorFromLegacySearchLocator\(locator, getCanonicalLocatorContext\(locator\)\)/)
  assert.match(searchViewSource, /stableLocator: activeHit\?\.stableLocator/)
  assert.match(workspaceSource, /tryParseStableReaderLocator\(value\.stableLocator\)/)
  assert.match(researchSource, /JSON\.stringify\(record\.stableLocator \|\| record\.locator\)/)
  const exact = locator.validateStableReaderLocator({
    schemaVersion: 'stable-reader-locator/v2',
    precision: 'exact',
    documentId: 'doc-1',
    sourcePageId: 'page-1',
    pageNum: 1,
    contentVersion: 'artifact-1',
    sourceHash: 'a'.repeat(64),
    offsetUnit: 'utf16-code-unit',
    sourceRanges: [{ start: 6, end: 10 }],
    quote: 'beta',
    prefix: 'alpha ',
    suffix: ' gamma',
    occurrenceIndex: 0,
  })
  assert.strictEqual(exact.precision, 'exact')
  assert.throws(() => locator.validateStableReaderLocator({ ...exact, sourceRanges: [] }), /stable_locator_ranges_invalid/)
  assert.throws(() => locator.validateStableReaderLocator({ ...exact, quote: '' }), /stable_locator_quote_invalid/)
  assert.throws(() => locator.validateStableReaderLocator({ ...exact, sourceRanges: [{ start: 4, end: 4 }] }), /stable_locator_range_invalid/)

  const legacyZero = locator.stableLocatorFromLegacySearchLocator({
    docId: 'doc-1', segmentId: 'legacy', pageId: 'page-1', pageNum: 1,
    segmentOrdinal: 0, charStart: 0, charEnd: 0, matchText: 'beta', queryTerm: 'beta', occurrenceIndex: 0,
  })
  assert.strictEqual(legacyZero.precision, 'page')
  assert.strictEqual(legacyZero.verificationStatus, 'legacy-unverified')
  assert.strictEqual('sourceRanges' in legacyZero, false)
  assert.strictEqual(locator.projectStableLocatorToLegacy(legacyZero), null)

  const upgraded = locator.stableLocatorFromLegacySearchLocator({
    docId: 'doc-1', segmentId: 'segment-1', pageId: 'page-1', pageNum: 1,
    segmentOrdinal: 0, charStart: 6, charEnd: 10, matchText: 'beta', queryTerm: 'beta', occurrenceIndex: 0,
  }, {
    contentVersion: 'artifact-1', sourceHash: 'a'.repeat(64), prefix: 'alpha ', suffix: ' gamma',
  })
  assert.strictEqual(upgraded.precision, 'exact')
  assert.strictEqual(locator.projectStableLocatorToLegacy(upgraded).charStart, 6)

  const direct = locator.relocateStableReaderLocator(exact, {
    text: 'alpha beta gamma', contentVersion: 'artifact-1', sourceHash: 'a'.repeat(64),
  })
  assert.strictEqual(direct.resolution, 'exact')
  const moved = locator.relocateStableReaderLocator(exact, {
    text: 'new alpha beta gamma', contentVersion: 'artifact-2', sourceHash: 'b'.repeat(64),
  })
  assert.strictEqual(moved.resolution, 'relocated')
  assert.deepStrictEqual(moved.locator.sourceRanges, [{ start: 10, end: 14 }])
  const missing = locator.relocateStableReaderLocator(exact, {
    text: 'content removed', contentVersion: 'artifact-3', sourceHash: 'c'.repeat(64),
  })
  assert.strictEqual(missing.resolution, 'unresolved')

  console.log('Stable reader locator regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
