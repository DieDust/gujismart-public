const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-claim-manifest-'))
const bundlePath = path.join(tempRoot, 'research-claim-manifest.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src/main/research-claim-manifest.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const { buildResearchClaimManifest, enumerateResearchClaims } = require(bundlePath)
  const repeated = enumerateResearchClaims('甲支持乙。甲支持乙。😀𠀀也在此。')
  assert.strictEqual(repeated.length, 3)
  assert.strictEqual(repeated[0].text, '甲支持乙。')
  assert.strictEqual(repeated[1].text, '甲支持乙。')
  assert.notStrictEqual(repeated[0].start, repeated[1].start)
  assert.strictEqual(repeated[0].occurrenceIndex, 0)
  assert.strictEqual(repeated[1].occurrenceIndex, 1)
  assert.strictEqual('甲支持乙。甲支持乙。😀𠀀也在此。'.slice(repeated[2].start, repeated[2].end), repeated[2].text)
  assert.strictEqual(enumerateResearchClaims('甲。\r\n乙。')[0].claimHash, enumerateResearchClaims('甲。\n乙。')[0].claimHash)
  const crlfManifest = buildResearchClaimManifest({ outputVersionId: 'same', content: '甲。\r\n乙。', status: 'draft', bindings: [], allowedEvidenceIds: [], allowedAggregateIds: [] })
  const lfManifest = buildResearchClaimManifest({ outputVersionId: 'same', content: '甲。\n乙。', status: 'draft', bindings: [], allowedEvidenceIds: [], allowedAggregateIds: [] })
  assert.strictEqual(crlfManifest.contentHash, lfManifest.contentHash)
  assert.strictEqual(enumerateResearchClaims('共2项。')[0].kind, 'numeric')
  assert.throws(() => enumerateResearchClaims('   \r\n'), /research_claim_content_required/)

  const draft = buildResearchClaimManifest({
    outputVersionId: 'output-v1',
    content: '甲。乙。',
    status: 'draft',
    bindings: [{ start: 0, end: 2, evidenceIds: ['e1'] }],
    allowedEvidenceIds: ['e1'],
    allowedAggregateIds: [],
  })
  assert.strictEqual(draft.coverage.total, 2)
  assert.strictEqual(draft.coverage.supported, 1)
  assert.strictEqual(draft.coverage.unsupported, 1)
  assert.strictEqual(draft.entries[1].supportStatus, 'unsupported')

  assert.throws(() => buildResearchClaimManifest({
    outputVersionId: 'output-v2', content: '甲。乙。', status: 'formal', bindings: [{ start: 0, end: 2, evidenceIds: ['e1'] }],
    allowedEvidenceIds: ['e1'], allowedAggregateIds: [],
  }), /research_claim_coverage_incomplete/)
  assert.throws(() => buildResearchClaimManifest({
    outputVersionId: 'output-v2', content: '甲。', status: 'draft', bindings: [{ start: 0, end: 2, evidenceIds: ['unknown'] }],
    allowedEvidenceIds: ['e1'], allowedAggregateIds: [],
  }), /research_claim_provenance_invalid/)
  assert.throws(() => buildResearchClaimManifest({
    outputVersionId: 'output-v2', content: '甲。', status: 'draft', bindings: [{ start: 1, end: 2, evidenceIds: ['e1'] }],
    allowedEvidenceIds: ['e1'], allowedAggregateIds: [],
  }), /research_claim_range_invalid/)
  assert.throws(() => buildResearchClaimManifest({
    outputVersionId: '', content: '甲。', status: 'draft', bindings: [], allowedEvidenceIds: [], allowedAggregateIds: [],
  }), /research_claim_output_required/)
  console.log('Research claim manifest regression passed.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
