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
assert.match(source, /validateManualPageImageCrop/, 'crop validation helper must be exported')
assert.match(source, /buildManualPageAssetPath/, 'managed asset path helper must be exported')
assert.match(source, /realpath/i, 'external source resolution must canonicalize real paths')
assert.match(source, /rename|renameSync/, 'asset replacement must be atomic')
assert.match(preloadSource, /cropManualPageImage:[\s\S]*pages:cropManualImage/, 'crop API must be exposed through preload')
assert.match(preloadSource, /selectManualBlockImage:[\s\S]*pages:selectManualImage/, 'replacement API must be exposed through preload')
assert.match(documentsSource, /assertDocumentInLibraryProject\(rawPage\.doc_id, getActiveLibraryProjectId\(\)\)/, 'page ownership must be checked against the active project')
assert.match(documentsSource, /findOwnedManualPageImageBlock/, 'crop must validate block ownership')
assert.match(documentsSource, /preparePagePayloadUpdate[\s\S]*runAsync[\s\S]*rmSync\(assetPath/, 'new crop must be persisted before failures can remove only the new asset')
assert.match(documentsSource, /resolveRepositoryImageSource\(selectedPath, getPdfRepositoryPaths\(\)\)/, 'replacement selection must remain inside configured repository roots')
assert.match(inspectorSource, /window\.api\.cropManualPageImage/, 'inspector must invoke the required crop API directly')
assert.match(inspectorSource, /window\.api\.selectManualBlockImage/, 'inspector must invoke the required replacement API directly')
assert.doesNotMatch(inspectorSource, /cropManualPageImage\?\.|selectManualBlockImage\?\./, 'manual image APIs must not be optional probes')
assert.match(inspectorSource, /setImageError[\s\S]*finally[\s\S]*setImageAction\(null\)/, 'failed image actions must stay retryable without clearing the block')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-manual-page-assets-'))
const bundlePath = path.join(tempRoot, 'manual-page-assets.cjs')
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
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('Manual page assets regression passed')
