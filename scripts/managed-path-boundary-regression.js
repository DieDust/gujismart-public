const assert = require('assert')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-managed-path-'))
const bundlePath = path.join(tempRoot, 'managed-path-boundary.cjs')

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function assertRejected(decision, reason) {
  assert.strictEqual(decision.allowed, false)
  assert.strictEqual(decision.reason, reason)
  assert.strictEqual(decision.canonicalTarget, undefined)
}

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'managed-path-boundary.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const { classifyPathContainment, inspectManagedDeleteTarget } = require(bundlePath)
  const dataDir = path.join(tempRoot, 'data')
  const storageRoot = path.join(dataDir, 'storage')
  const docRoot = path.join(storageRoot, 'doc-a')
  const nestedDir = path.join(docRoot, 'pages')
  const managedFile = path.join(nestedDir, 'page-1.jpg')
  const siblingRoot = path.join(storageRoot, 'doc-b')
  const similarPrefixRoot = path.join(storageRoot, 'doc-a-copy')
  const outsideRoot = path.join(tempRoot, 'repository')
  const outsideFile = path.join(outsideRoot, 'source.pdf')

  mkdirSync(nestedDir, { recursive: true })
  mkdirSync(siblingRoot, { recursive: true })
  mkdirSync(similarPrefixRoot, { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
  writeFileSync(managedFile, 'managed bytes')
  writeFileSync(outsideFile, 'external bytes')

  assert.strictEqual(classifyPathContainment(docRoot, docRoot), 'same')
  assert.strictEqual(classifyPathContainment(docRoot, managedFile), 'descendant')
  assert.strictEqual(classifyPathContainment(docRoot, path.join(nestedDir, '..', 'source.pdf')), 'descendant')
  assert.strictEqual(classifyPathContainment(docRoot, storageRoot), 'outside')
  assert.strictEqual(classifyPathContainment(docRoot, siblingRoot), 'outside')
  assert.strictEqual(classifyPathContainment(docRoot, similarPrefixRoot), 'outside')
  assert.strictEqual(classifyPathContainment(docRoot, path.join(docRoot, '..', '..', 'repository')), 'outside')
  if (process.platform === 'win32') {
    assert.strictEqual(classifyPathContainment('C:\\library\\storage', 'Z:\\library\\storage\\doc-a'), 'outside')
  }

  const documentRootDecision = inspectManagedDeleteTarget({
    dataDir,
    docId: 'doc-a',
    targetPath: docRoot,
    kind: 'document-root',
  })
  assert.strictEqual(documentRootDecision.allowed, true)
  assert.strictEqual(documentRootDecision.canonicalTarget, path.resolve(docRoot))

  const assetDecision = inspectManagedDeleteTarget({
    dataDir,
    docId: 'doc-a',
    targetPath: managedFile,
    kind: 'document-asset',
  })
  assert.strictEqual(assetDecision.allowed, true)
  assert.strictEqual(assetDecision.canonicalTarget, path.resolve(managedFile))

  for (const docId of ['', '.', '..', '../doc-a', 'doc/a', 'doc\\a', path.resolve(docRoot), `doc\0a`]) {
    assertRejected(inspectManagedDeleteTarget({ dataDir, docId, targetPath: docRoot, kind: 'document-root' }), 'invalid-document-id')
  }

  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: storageRoot, kind: 'document-root' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: siblingRoot, kind: 'document-root' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: similarPrefixRoot, kind: 'document-root' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: outsideFile, kind: 'document-asset' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: docRoot, kind: 'document-asset' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: nestedDir, kind: 'document-asset' }), 'target-kind-mismatch')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: managedFile, kind: 'unknown-kind' }), 'target-kind-mismatch')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: managedFile, kind: 'document-root' }), 'target-outside-document')
  assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: path.join(docRoot, 'missing.pdf'), kind: 'document-asset' }), 'target-missing')
  assertRejected(inspectManagedDeleteTarget({ dataDir: path.join(tempRoot, 'missing-data'), docId: 'doc-a', targetPath: docRoot, kind: 'document-root' }), 'storage-root-missing')

  const linkedAsset = path.join(docRoot, 'repository-link')
  let junctionCovered = false
  try {
    symlinkSync(outsideRoot, linkedAsset, process.platform === 'win32' ? 'junction' : 'dir')
    junctionCovered = true
    assertRejected(inspectManagedDeleteTarget({ dataDir, docId: 'doc-a', targetPath: linkedAsset, kind: 'document-asset' }), 'target-is-symlink')
    assert.strictEqual(readFileSync(outsideFile, 'utf8'), 'external bytes')
  } catch (error) {
    if (existsSync(linkedAsset)) throw error
    console.warn(`Managed path regression: junction/symlink case skipped (${error.code || error.message})`)
  }

  const replaceableDocumentId = 'managed_replaced_cleanup'
  const replaceableRoot = path.join(storageRoot, replaceableDocumentId)
  mkdirSync(replaceableRoot)
  assert.strictEqual(inspectManagedDeleteTarget({ dataDir, docId: replaceableDocumentId, targetPath: replaceableRoot, kind: 'document-root' }).allowed, true)
  rmSync(replaceableRoot, { recursive: true, force: true })
  if (junctionCovered) {
    symlinkSync(outsideRoot, replaceableRoot, process.platform === 'win32' ? 'junction' : 'dir')
    assertRejected(inspectManagedDeleteTarget({ dataDir, docId: replaceableDocumentId, targetPath: replaceableRoot, kind: 'document-root' }), 'target-is-symlink')
    assert.strictEqual(readFileSync(outsideFile, 'utf8'), 'external bytes')

    const linkedDocumentId = 'managed_linked_cleanup'
    const linkedDocumentRoot = path.join(storageRoot, linkedDocumentId)
    const nestedJunction = path.join(linkedDocumentRoot, 'external-link')
    mkdirSync(linkedDocumentRoot)
    symlinkSync(outsideRoot, nestedJunction, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedDocumentDecision = inspectManagedDeleteTarget({
      dataDir,
      docId: linkedDocumentId,
      targetPath: linkedDocumentRoot,
      kind: 'document-root',
    })
    assert.strictEqual(linkedDocumentDecision.allowed, true)
    rmSync(linkedDocumentDecision.canonicalTarget, { recursive: true, force: true })
    assert.strictEqual(readFileSync(outsideFile, 'utf8'), 'external bytes')
  }

  const documentsIpc = read('src/main/ipc/documents.ts')
  const cleanupStart = documentsIpc.indexOf('function getDeleteCleanupTasks')
  const cleanupEnd = documentsIpc.indexOf('function markDocumentsDeleting', cleanupStart)
  const cleanupBody = documentsIpc.slice(cleanupStart, cleanupEnd)
  assert(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'document cleanup task builder should exist')
  assert(!cleanupBody.includes('file_path'), 'document cleanup tasks must not use database file_path')
  assert(!cleanupBody.includes('thumb_path'), 'document cleanup tasks must not use database thumb_path')
  assert(cleanupBody.includes("join(getDataDir(), 'storage', doc.id)"), 'document cleanup tasks should derive the managed document root in main')
  assert(documentsIpc.includes('inspectManagedDeleteTarget'), 'document deletion should revalidate targets before rm')

  const pdfAssets = read('src/main/pdf-assets.ts')
  const pdfCleanupStart = pdfAssets.indexOf('export function cleanupPdfAssets')
  const pdfCleanupEnd = pdfAssets.indexOf('export function cleanupCompletedPdfAssets', pdfCleanupStart)
  const pdfCleanupBody = pdfAssets.slice(pdfCleanupStart, pdfCleanupEnd)
  assert(!pdfCleanupBody.includes('resolveManagedStoragePath'), 'PDF cleanup must authorize the original stored path without relocation')
  assert(!pdfCleanupBody.includes('isPathInsideDirectory'), 'PDF cleanup must not authorize deletion with string prefix containment')
  assert((pdfCleanupBody.match(/inspectManagedDeleteTarget/g) || []).length >= 4, 'PDF sync and async cleanup should validate candidates and revalidate before deletion')
  assert(pdfCleanupBody.includes("kind: 'document-asset'"), 'PDF asset cleanup should use the managed asset boundary')
  const startupRecovery = read('src/main/startup-recovery.ts')
  const orphanCleanupStart = startupRecovery.indexOf('async function removeOrphanStorageDirs')
  const orphanCleanupEnd = startupRecovery.indexOf('async function recoverInterruptedPdfCompressionSources', orphanCleanupStart)
  const orphanCleanupBody = startupRecovery.slice(orphanCleanupStart, orphanCleanupEnd)
  assert(orphanCleanupBody.includes("kind: 'document-root'"), 'startup orphan cleanup should use the managed document boundary')
  assert(!orphanCleanupBody.includes('await rm(join(storageRoot'), 'startup orphan cleanup must not directly delete an unchecked path')

  console.log(`Managed path boundary regression passed (junction=${junctionCovered ? 'covered' : 'skipped'})`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
