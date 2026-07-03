const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-metadata-tag-guard-'))
const bundlePath = path.join(tempRoot, 'metadata-tag-guard.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'metadata-tag-guard.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const guard = require(bundlePath)
  assert.strictEqual(guard.normalizeMetadataTagName('  Foo   Bar  '), 'foo bar')
  assert.strictEqual(guard.normalizeMetadataTagComparableName('  Foo   Bar  '), 'foobar')
  assert.strictEqual(guard.shouldProtectManualTagRelation({ isManual: 1, tagSource: '_doc_type' }), true)

  const protectedManual = guard.decideMetadataTagRelationCleanup({
    tagName: 'Legacy Type',
    nextName: 'Book',
    isManual: 1,
    isMetadata: 1,
    relationSourceField: '_doc_type',
    isCandidateRelation: true,
  })
  assert.deepStrictEqual(protectedManual, {
    action: 'keep',
    reason: 'manual_relation_protected',
    protected_manual: true,
  })

  const staleAuto = guard.decideMetadataTagRelationCleanup({
    tagName: 'Legacy Type',
    nextName: 'Book',
    isManual: 0,
    isMetadata: 1,
    relationSourceField: '_doc_type',
    isCandidateRelation: true,
  })
  assert.strictEqual(staleAuto.action, 'delete')
  assert.strictEqual(staleAuto.protected_manual, false)

  const metadataTagsSource = fs.readFileSync(path.join(root, 'src', 'main', 'metadata-tags.ts'), 'utf8')
  const metadataRegressionSource = fs.readFileSync(path.join(root, 'scripts', 'metadata-tags-regression.js'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(typesSource.includes("from './metadata-tag-guard'"), 'shared types should re-export metadata tag guard contracts')
  assert.ok(metadataTagsSource.includes('normalizeMetadataTagName'), 'metadata tag normalization should use the shared guard helper')
  assert.ok(metadataTagsSource.includes('decideMetadataTagRelationCleanup'), 'stale metadata tag cleanup should use the shared guard helper')
  assert.ok(metadataTagsSource.includes("if (decision.action !== 'delete') continue"), 'manual guard should prevent deletion when cleanup says keep')
  assert.ok(metadataRegressionSource.includes('tag_manual_stale_type'), 'metadata tag regression should cover manual stale doc-type preservation')
  assert.ok(metadataRegressionSource.includes('tag_auto_stale_type'), 'metadata tag regression should cover automatic stale doc-type deletion')

  console.log('Metadata tag guard regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
