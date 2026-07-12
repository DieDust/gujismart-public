const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-reauthorization-'))
try {
  const outfile = path.join(tempRoot, 'reauthorization.cjs')
  buildSync({
    entryPoints: [path.join(root, 'src', 'renderer', 'src', 'utils', 'importQueueReauthorization.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
  const { matchReauthorizedItems, matchReauthorizedSources, transitionAuthorizationJobs } = require(outfile)

  const itemMatch = matchReauthorizedItems(
    ['a.pdf', 'a.pdf', 'b.txt'],
    [
      { grantId: 'g1', sourceId: 's1', displayName: 'a.pdf' },
      { grantId: 'g2', sourceId: 's1', displayName: 'other.pdf' },
      { grantId: 'g3', sourceId: 's2', displayName: 'a.pdf' },
    ],
  )
  assert.deepStrictEqual(itemMatch.matchedItems.map((item) => item.grantId), ['g1', 'g3'])
  assert.deepStrictEqual(itemMatch.remainingLabels, ['b.txt'])

  const sourceMatch = matchReauthorizedSources(
    ['第一批', '第二批'],
    [
      { sourceId: 's1', displayName: '第一批' },
      { sourceId: 's3', displayName: '额外目录' },
    ],
  )
  assert.deepStrictEqual([...sourceMatch.allowedSourceIds], ['s1'])
  assert.deepStrictEqual(sourceMatch.remainingLabels, ['第二批'])

  const oldJobs = [
    { id: 1, sourceLabels: ['a.pdf'], pendingCount: 1 },
    { id: 2, sourceLabels: ['b.pdf'], pendingCount: 1 },
  ]
  assert.deepStrictEqual(
    transitionAuthorizationJobs(oldJobs, 1, { replacementEstablished: false }),
    oldJobs,
    'cancel/error must preserve the old authorization job atomically',
  )
  assert.deepStrictEqual(
    transitionAuthorizationJobs(oldJobs, 1, { replacementEstablished: true }),
    [oldJobs[1]],
    'a fully installed replacement may remove only its old job',
  )
  const partial = { id: 1, sourceLabels: ['remaining.pdf'], pendingCount: 1 }
  assert.deepStrictEqual(
    transitionAuthorizationJobs(oldJobs, 1, { replacementEstablished: true, remainingJob: partial }),
    [partial, oldJobs[1]],
    'partial coverage must replace the same job only after replacement installation',
  )

  const library = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
  assert(library.includes('const promptImportQueueReauthorization ='), 'UI must expose an actionable reauthorization prompt')
  assert(library.includes("okText: '重新选择'"), 'reauthorization prompt must offer a reselect action')
  assert(library.includes('onCancel: () => undefined'), 'cancel must preserve the authorization-required job')
  assert(library.includes('remainingAuthorizationLabels'), 'partial coverage must remain explicit in the active queue job')
  assert(library.includes('className="import-reauthorization-banner"'), 'all pending jobs need a persistent retry entry')
  assert(library.includes('authorizationRequiredJobs.map((job)'), 'persistent UI must render every pending authorization job')
  assert(!library.includes('const importFilePaths = async'), 'legacy renderer path queue helper must be removed')
  console.log('Import queue reauthorization regression passed.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
