const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { createCanvas } = require('@napi-rs/canvas')

const root = path.resolve(__dirname, '..')
const sourcePath = path.join(root, 'src', 'main', 'manual-page-assets.ts')
assert.ok(fs.existsSync(sourcePath), 'manual page asset core must exist')

const source = fs.readFileSync(sourcePath, 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8')
const documentsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
const inspectorSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'ManualBlockInspector.tsx'), 'utf8')
const rendererHelperPath = path.join(root, 'src', 'renderer', 'src', 'utils', 'manualImageAssetEditing.ts')
assert.match(source, /validateManualPageImageCrop/, 'crop validation helper must be exported')
assert.match(source, /buildManualPageAssetPath/, 'managed asset path helper must be exported')
assert.match(source, /realpath/i, 'external source resolution must canonicalize real paths')
assert.match(source, /rename|renameSync/, 'asset replacement must be atomic')
assert.match(source, /assertManualPageAssetOwnership/, 'page ownership must have an executable dependency-injected guard')
assert.match(source, /isStableManualLayoutBlockId/, 'asset service must reject non-manual block IDs')
assert.match(source, /selectManualPageAssetOnly/, 'dialog cancellation must have an executable asset-only transition')
assert.match(source, /cleanupUnreferencedManualPageAssets/, 'managed assets must expose a conservative reference-aware GC')
assert.match(source, /atomicWriteManualPageAssetAsync/, 'managed assets must provide an async atomic writer')
assert.match(preloadSource, /cropManualPageImage:[\s\S]*pages:cropManualImage/, 'crop API must be exposed through preload')
assert.match(preloadSource, /selectManualBlockImage:[\s\S]*pages:selectManualImage/, 'replacement API must be exposed through preload')
assert.match(documentsSource, /assertManualPageAssetOwnership\([\s\S]*getActiveLibraryProjectId\(\)/, 'page ownership must be checked against the active project')
assert.doesNotMatch(documentsSource, /findOwnedManualPageImageBlock/, 'asset-only IPC must not inspect persisted layout blocks')
const cropHandlerStart = documentsSource.indexOf('async function cropManualPageImageAsset')
const cropHandlerEnd = documentsSource.indexOf('async function selectManualPageImageAsset', cropHandlerStart)
assert.ok(cropHandlerStart >= 0 && cropHandlerEnd > cropHandlerStart, 'crop asset-only handler must exist')
const cropHandlerSource = documentsSource.slice(cropHandlerStart, cropHandlerEnd)
assert.doesNotMatch(cropHandlerSource, /ocr_result|layout_result|preparePagePayloadUpdate|runAsync|UPDATE pages/, 'crop IPC must never rewrite the page OCR payload')
assert.match(documentsSource, /resolveRepositoryImageSource\(selectedPath, getPdfRepositoryPaths\(\)\)/, 'replacement selection must remain inside configured repository roots')
assert.match(documentsSource, /createManualPageAssetRevision\(\)/, 'asset revisions must be unique rather than Date.now-only')
assert.match(inspectorSource, /window\.api\.cropManualPageImage/, 'inspector must invoke the required crop API directly')
assert.match(inspectorSource, /window\.api\.selectManualBlockImage/, 'inspector must invoke the required replacement API directly')
assert.doesNotMatch(inspectorSource, /cropManualPageImage\?\.|selectManualBlockImage\?\./, 'manual image APIs must not be optional probes')
assert.match(inspectorSource, /setImageError[\s\S]*finally[\s\S]*setImageAction\(null\)/, 'failed image actions must stay retryable without clearing the block')
assert.ok(fs.existsSync(rendererHelperPath), 'renderer asset metadata transition helper must exist')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-manual-page-assets-'))
const bundlePath = path.join(tempRoot, 'manual-page-assets.cjs')
async function run() {
try {
  buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['@napi-rs/canvas', 'pdfjs-dist/*'],
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const api = require(bundlePath)
  assert.doesNotThrow(() => api.assertManualPageAssetOwnership({
    pageId: 'page-1',
    docId: 'doc-1',
    activeProjectId: 'project-a',
    ownsDocument: (_docId, projectId) => projectId === 'project-a',
  }))
  assert.throws(() => api.assertManualPageAssetOwnership({
    pageId: 'page-1',
    docId: 'doc-1',
    activeProjectId: 'project-b',
    ownsDocument: (_docId, projectId) => projectId === 'project-a',
  }))
  const unsavedBlockId = 'manual-page-1-550e8400-e29b-41d4-a716-446655440000'
  assert.strictEqual(api.isStableManualLayoutBlockId('page-1', unsavedBlockId), true, 'new unsaved manual blocks must be accepted')
  for (const rejectedId of ['page-1:ir:block-1', 'page-1:draft:0', 'legacy-image', '../manual-page-1-bad']) {
    assert.strictEqual(api.isStableManualLayoutBlockId('page-1', rejectedId), false, `${rejectedId} must be rejected`)
  }
  assert.throws(() => api.assertDecodedManualPageImage({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }) }))
  assert.throws(() => api.assertDecodedManualPageImage({ isEmpty: () => false, getSize: () => ({ width: 0, height: 1 }) }))
  assert.deepStrictEqual(
    api.assertDecodedManualPageImage({ isEmpty: () => false, getSize: () => ({ width: 100, height: 80 }) }),
    { width: 100, height: 80 },
  )
  const valid = api.validateManualPageImageCrop(
    { left: 10, top: 12, width: 40, height: 30 },
    { width: 100, height: 80 },
  )
  assert.deepStrictEqual(valid, { left: 10, top: 12, width: 40, height: 30 })

  const sourceCanvas = createCanvas(100, 80)
  const sourceContext = sourceCanvas.getContext('2d')
  sourceContext.fillStyle = '#ff0000'
  sourceContext.fillRect(0, 0, 50, 80)
  sourceContext.fillStyle = '#0000ff'
  sourceContext.fillRect(50, 0, 50, 80)
  const syntheticPng = sourceCanvas.toBuffer('image/png')
  assert.ok(syntheticPng.length > 8, 'synthetic PNG must be generated')
  const pixelCrop = api.toManualPagePixelCrop(
    { left: 50, top: 10, width: 50, height: 60 },
    { width: 100, height: 80 },
    { width: 100, height: 80 },
  )
  assert.deepStrictEqual(pixelCrop, { x: 50, y: 10, width: 50, height: 60 })
  const croppedCanvas = createCanvas(pixelCrop.width, pixelCrop.height)
  const croppedContext = croppedCanvas.getContext('2d')
  croppedContext.drawImage(
    sourceCanvas,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  )
  const croppedPixel = croppedContext.getImageData(0, 0, 1, 1).data
  assert.deepStrictEqual([...croppedPixel.slice(0, 3)], [0, 0, 255], 'cropped PNG edge must start in the selected blue half')
  assert.deepStrictEqual([croppedCanvas.width, croppedCanvas.height], [50, 60], 'cropped PNG dimensions must match the selected rectangle')
  for (const crop of [
    { left: -1, top: 0, width: 10, height: 10 },
    { left: 0, top: 0, width: 0, height: 10 },
    { left: 0, top: 0, width: 101, height: 10 },
    { left: 0, top: 0, width: 10, height: 81 },
    { left: Number.NaN, top: 0, width: 10, height: 10 },
  ]) {
    assert.throws(() => api.validateManualPageImageCrop(crop, { width: 100, height: 80 }))
  }

  const dataDir = path.join(tempRoot, 'data')
  const revisions = new Set(Array.from({ length: 128 }, () => api.createManualPageAssetRevision()))
  assert.strictEqual(revisions.size, 128, 'concurrent asset revisions must be unique')
  const assetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-1', 3)
  assert.ok(assetPath.startsWith(path.join(dataDir, 'storage', 'doc-1', 'page-assets')))
  assert.ok(assetPath.endsWith(path.join('page-1', 'block-1', '3.png')))
  for (const value of ['../doc', 'doc/evil', 'page\\evil', '']) {
    assert.throws(() => api.buildManualPageAssetPath(dataDir, value, 'page-1', 'block-1', 1))
  }

  const managedRoot = path.join(dataDir, 'storage', 'doc-1')
  const externalRoot = path.join(tempRoot, 'repository')
  fs.mkdirSync(managedRoot, { recursive: true })
  fs.mkdirSync(externalRoot, { recursive: true })
  const managedSource = path.join(managedRoot, 'page.png')
  const externalSource = path.join(externalRoot, 'page.png')
  fs.writeFileSync(managedSource, 'managed')
  fs.writeFileSync(externalSource, 'external')
  assert.strictEqual(api.assertContainedPath(managedSource, managedRoot), true)
  assert.strictEqual(api.assertContainedPath(externalSource, managedRoot), false)
  assert.strictEqual(api.resolveRepositoryImageSource(externalSource, [externalRoot]), fs.realpathSync(externalSource))
  assert.strictEqual(api.resolveRepositoryImageSource(managedSource, [externalRoot]), null)

  const linkedDocRoot = path.join(dataDir, 'storage', 'doc-linked')
  const escapedAssetRoot = path.join(tempRoot, 'escaped-assets')
  fs.mkdirSync(linkedDocRoot, { recursive: true })
  fs.mkdirSync(escapedAssetRoot, { recursive: true })
  try {
    fs.symlinkSync(escapedAssetRoot, path.join(linkedDocRoot, 'page-assets'), process.platform === 'win32' ? 'junction' : 'dir')
    const escapedTarget = api.buildManualPageAssetPath(dataDir, 'doc-linked', 'page-1', 'block-1', 1)
    assert.throws(() => api.atomicWriteManualPageAsset(escapedTarget, syntheticPng, linkedDocRoot))
    assert.deepStrictEqual(fs.readdirSync(escapedAssetRoot), [], 'managed writes must not follow page-assets links outside the document root')
  } catch (error) {
    if (fs.existsSync(path.join(linkedDocRoot, 'page-assets'))) throw error
    console.warn(`Manual page asset symlink case skipped (${error.code || error.message})`)
  }

  const oldAssetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-1', 4)
  fs.mkdirSync(path.dirname(oldAssetPath), { recursive: true })
  fs.writeFileSync(oldAssetPath, Buffer.from('old-asset'))
  assert.throws(() => api.atomicWriteManualPageAsset(oldAssetPath, new Uint8Array(), managedRoot))
  assert.strictEqual(fs.readFileSync(oldAssetPath, 'utf8'), 'old-asset', 'failed writes must preserve the previous committed asset')
  const selectedAssetPath = api.buildManualPageSelectedAssetPath(dataDir, 'doc-1', 'page-1', 5)
  api.atomicWriteManualPageAsset(selectedAssetPath, syntheticPng, managedRoot)
  assert.deepStrictEqual(fs.readFileSync(selectedAssetPath), syntheticPng, 'selected repository image bytes must be copied into managed storage')
  const asyncAssetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-async', api.createManualPageAssetRevision())
  await api.atomicWriteManualPageAssetAsync(asyncAssetPath, syntheticPng, managedRoot)
  assert.deepStrictEqual(fs.readFileSync(asyncAssetPath), syntheticPng, 'async asset writes must commit the same bytes atomically')
  assert.throws(() => api.assertManualPageImageByteBudget(new Uint8Array(api.MAX_MANUAL_PAGE_ASSET_BYTES + 1)), 'oversized PNG bytes must be rejected before write')

  const referencedAssetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-kept', api.createManualPageAssetRevision())
  const orphanAssetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-orphan', api.createManualPageAssetRevision())
  const recentAssetPath = api.buildManualPageAssetPath(dataDir, 'doc-1', 'page-1', 'block-recent', api.createManualPageAssetRevision())
  for (const filePath of [referencedAssetPath, orphanAssetPath, recentAssetPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, syntheticPng)
  }
  const gcNow = Date.now()
  fs.utimesSync(referencedAssetPath, new Date(gcNow - 3 * 24 * 60 * 60 * 1000), new Date(gcNow - 3 * 24 * 60 * 60 * 1000))
  fs.utimesSync(orphanAssetPath, new Date(gcNow - 3 * 24 * 60 * 60 * 1000), new Date(gcNow - 3 * 24 * 60 * 60 * 1000))
  const referenced = api.collectManualPageAssetReferences([
    { layout_result: [{ image_asset_path: referencedAssetPath }] },
  ], dataDir)
  assert.strictEqual(referenced.has(fs.realpathSync(referencedAssetPath)), true, 'reference scanner must retain layout image assets')
  const gcResult = await api.cleanupUnreferencedManualPageAssets(dataDir, referenced, {
    nowMs: gcNow,
    graceMs: 60 * 60 * 1000,
    budgetMs: 5_000,
    maxFiles: 50,
  })
  assert.ok(gcResult.deletedFiles >= 1, 'GC must remove an old unreferenced asset')
  assert.strictEqual(fs.existsSync(referencedAssetPath), true, 'GC must retain referenced assets')
  assert.strictEqual(fs.existsSync(orphanAssetPath), false, 'GC must remove old orphan assets')
  assert.strictEqual(fs.existsSync(recentAssetPath), true, 'GC grace period must retain recent assets')

  const commitState = { tempExists: false, target: 'old-target', cleanupCalls: 0 }
  assert.throws(() => api.commitManualPageAssetFile({
    tempPath: 'asset.tmp',
    targetPath: 'asset.png',
    pngBytes: syntheticPng,
    operations: {
      writeTemp: () => { commitState.tempExists = true },
      getTempSize: () => syntheticPng.length,
      renameTemp: () => { throw new Error('simulated rename failure') },
      removeTemp: () => { commitState.tempExists = false; commitState.cleanupCalls += 1 },
    },
  }))
  assert.strictEqual(commitState.tempExists, false, 'failed commit must clean the temporary file')
  assert.strictEqual(commitState.target, 'old-target', 'failed commit must not alter the previous target')
  assert.strictEqual(commitState.cleanupCalls, 1)

  let copiedSelection = false
  const cancelledSelection = await api.selectManualPageAssetOnly({
    selectSource: async () => null,
    copySource: async () => { copiedSelection = true; return { assetPath: 'unexpected', width: 1, height: 1 } },
  })
  assert.strictEqual(cancelledSelection, null)
  assert.strictEqual(copiedSelection, false, 'dialog cancellation must not create a managed asset')

  const rendererSource = fs.readFileSync(rendererHelperPath, 'utf8')
  const rendererTranspiled = require('typescript').transpileModule(rendererSource, {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 },
  }).outputText
  const rendererModule = { exports: {} }
  new Function('exports', 'module', 'require', rendererTranspiled)(rendererModule.exports, rendererModule, require)
  assert.deepStrictEqual(
    rendererModule.exports.scaleManualImageCropToNaturalPixels(
      { left: 10, top: 8, width: 40, height: 32 },
      { width: 100, height: 80 },
      { width: 200, height: 160 },
    ),
    { left: 20, top: 16, width: 80, height: 64 },
    'layout coordinates must scale to natural image pixels before the asset-only IPC call',
  )
  assert.deepStrictEqual(
    rendererModule.exports.scaleManualImageCropToNaturalPixels(
      { left: 20, top: 16, width: 80, height: 64 },
      { width: 200, height: 160 },
      { width: 100, height: 80 },
    ),
    { left: 10, top: 8, width: 40, height: 32 },
    'coordinate scaling must also support a smaller natural source',
  )
  assert.throws(() => rendererModule.exports.scaleManualImageCropToNaturalPixels(
    { left: 0, top: 0, width: 10, height: 10 },
    null,
    { width: 100, height: 80 },
  ))
  const previousMetadata = {
    image_asset_path: 'old.png',
    image_asset_width: 10,
    image_asset_height: 12,
    image_crop: { source_page_id: 'page-1', left: 1, top: 2, width: 3, height: 4 },
  }
  assert.strictEqual(rendererModule.exports.createManualImageAssetUpdate({ status: 'cancelled', previous: previousMetadata }), null)
  assert.strictEqual(rendererModule.exports.createManualImageAssetUpdate({ status: 'failed', previous: previousMetadata }), null)
  const successUpdate = rendererModule.exports.createManualImageAssetUpdate({
    status: 'success',
    previous: previousMetadata,
    pageId: 'page-1',
    blockId: unsavedBlockId,
    asset: { assetPath: 'new.png', width: 50, height: 60 },
    crop: { left: 5, top: 6, width: 7, height: 8 },
  })
  assert.deepStrictEqual(successUpdate, {
    manual_block_id: unsavedBlockId,
    segmentation_source: 'manual',
    image_asset_path: 'new.png',
    asset_path: 'new.png',
    image_path: 'new.png',
    image_asset_width: 50,
    image_asset_height: 60,
    image_crop: { source_page_id: 'page-1', left: 5, top: 6, width: 7, height: 8 },
  })
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
}

run().then(() => {
  console.log('Manual page assets regression passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
