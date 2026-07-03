const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-citation-field-resolver-'))
const bundlePath = path.join(tempRoot, 'citation-field-resolver.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'citation-field-resolver.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const resolver = require(bundlePath)
  assert.deepStrictEqual(
    resolver.parseCitationTemplatePlaceholders('{{title}}. {{author}}. {{title}} {{page_reference}}'),
    ['author', 'page_reference', 'title'],
  )

  const report = resolver.buildCitationFieldResolutionReport(
    {
      title: 'A title',
      author: '',
      page_reference: 'p. 12',
    },
    '{{title}} / {{author}} / {{source}} / {{page_reference}}',
  )
  assert.strictEqual(report.usable, true)
  assert.deepStrictEqual(report.resolved_fields, ['page_reference', 'title'])
  assert.deepStrictEqual(report.missing_fields, ['author', 'source'])
  assert.deepStrictEqual(report.core_missing_fields, ['author', 'source'])
  assert.strictEqual(report.warning_count, 2)
  assert.ok(report.issues.some((issue) => issue.code === 'missing_core_author'))
  assert.ok(report.issues.some((issue) => issue.action_hint === 'review_citation_metadata_priority'))
  assert.deepStrictEqual(resolver.CITATION_CORE_FIELD_PRIORITY.title, ['documents.title', 'metadata.title'])

  const citationSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'citation.ts'), 'utf8')
  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  assert.ok(citationSource.includes('buildCitationWithDiagnostics'), 'citation module should expose a diagnostic-preserving builder')
  assert.ok(citationSource.includes('buildCitationFieldResolutionReport(fields, result)'), 'citation generation should build a field resolution report before cleanup')
  assert.ok(citationSource.includes('return buildCitationWithDiagnostics(docId, templateId, options).citation'), 'legacy buildCitation should keep returning the same nullable string contract')
  assert.ok(typesSource.includes("from './citation-field-resolver'"), 'shared types should re-export citation field resolver contracts')

  console.log('Citation field resolver regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
