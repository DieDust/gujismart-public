const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-file-access-'))
const dataDir = path.join(tempRoot, 'data')
const repositoryDir = path.join(tempRoot, 'repository')
const outsideDir = path.join(tempRoot, 'outside')
const managedFile = path.join(dataDir, 'storage', 'doc-1', 'managed.pdf')
const dataFile = path.join(dataDir, 'library.db')
const repositoryFile = path.join(repositoryDir, 'repository.pdf')
const outsideFile = path.join(outsideDir, 'legacy.pdf')
const similarPrefixFile = path.join(tempRoot, 'data-similar', 'storage', 'doc-2', 'outside.pdf')
const bundlePath = path.join(tempRoot, 'file-access.cjs')

function expectThrow(operation, pattern) {
  assert.throws(operation, pattern)
}

function toLocalResourceUrl(filePath) {
  return `local-resource://file/${encodeURIComponent(filePath)}`
}

async function buildFileAccessBundle(outputPath, configuredDataDir, repositoryPaths) {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'file-access.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outputPath,
    logLevel: 'silent',
    plugins: [{
      name: 'file-access-dependencies',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'test-dependency' }))
        buildContext.onResolve({ filter: /^\.\/pdf-assets$/ }, () => ({ path: 'pdf-assets', namespace: 'test-dependency' }))
        buildContext.onLoad({ filter: /.*/, namespace: 'test-dependency' }, (args) => ({
          loader: 'js',
          contents: args.path === 'database'
            ? `export const getDataDir = () => ${JSON.stringify(configuredDataDir)}`
            : `export const getPdfRepositoryPaths = () => ${JSON.stringify(repositoryPaths)}`,
        }))
      },
    }],
  })
}

async function main() {
try {
  for (const filePath of [managedFile, dataFile, repositoryFile, outsideFile, similarPrefixFile]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, path.basename(filePath))
  }

  await buildFileAccessBundle(bundlePath, dataDir, [repositoryDir])

  const {
    allowFileAccessPath,
    allowManagedFileAccessPaths,
    assertAllowedLocalFilePath,
    assertAllowedLocalResourceUrl,
  } = require(bundlePath)

  assert.strictEqual(assertAllowedLocalFilePath(managedFile), fs.realpathSync(managedFile))
  assert.strictEqual(assertAllowedLocalResourceUrl(toLocalResourceUrl(managedFile)), fs.realpathSync(managedFile))
  expectThrow(() => assertAllowedLocalFilePath(dataFile), /授权访问范围/)
  expectThrow(() => assertAllowedLocalResourceUrl(toLocalResourceUrl(dataFile)), /授权访问范围/)
  expectThrow(() => assertAllowedLocalFilePath(outsideFile), /授权访问范围/)
  expectThrow(() => assertAllowedLocalFilePath(similarPrefixFile), /授权访问范围/)

  assert.strictEqual(assertAllowedLocalFilePath(repositoryFile), fs.realpathSync(repositoryFile))
  expectThrow(() => assertAllowedLocalResourceUrl(toLocalResourceUrl(repositoryFile)), /授权访问范围/)

  allowManagedFileAccessPaths([outsideFile])
  expectThrow(() => assertAllowedLocalFilePath(outsideFile), /授权访问范围/)
  allowFileAccessPath(outsideFile)
  assert.strictEqual(assertAllowedLocalFilePath(outsideFile), fs.realpathSync(outsideFile))
  assert.strictEqual(assertAllowedLocalResourceUrl(toLocalResourceUrl(outsideFile)), fs.realpathSync(outsideFile))

  const unsafeDataDir = path.join(tempRoot, 'unsafe-data')
  const unsafeStorageTarget = path.join(tempRoot, 'unsafe-storage-target')
  const unsafeStorageRoot = path.join(unsafeDataDir, 'storage')
  const unsafeExternalFile = path.join(unsafeStorageTarget, 'external.pdf')
  const unsafeBundlePath = path.join(tempRoot, 'unsafe-file-access.cjs')
  fs.mkdirSync(unsafeDataDir, { recursive: true })
  fs.mkdirSync(unsafeStorageTarget, { recursive: true })
  fs.writeFileSync(unsafeExternalFile, 'must remain outside managed storage')
  let storageLinkCovered = false
  try {
    fs.symlinkSync(unsafeStorageTarget, unsafeStorageRoot, 'dir')
    storageLinkCovered = true
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && !String(error.message).includes('privilege')) throw error
    try {
      fs.symlinkSync(unsafeStorageTarget, unsafeStorageRoot, 'junction')
      storageLinkCovered = true
    } catch (junctionError) {
      if (junctionError.code !== 'EPERM'
        && junctionError.code !== 'EACCES'
        && !String(junctionError.message).includes('privilege')) throw junctionError
      console.warn(`File access boundary regression: storage symlink/junction skipped (${junctionError.code || junctionError.message})`)
    }
  }
  if (storageLinkCovered) {
    await buildFileAccessBundle(unsafeBundlePath, unsafeDataDir, [])
    const unsafeAccess = require(unsafeBundlePath)
    const unsafePathThroughStorage = path.join(unsafeStorageRoot, 'external.pdf')
    unsafeAccess.allowManagedFileAccessPath(unsafePathThroughStorage)
    expectThrow(() => unsafeAccess.assertAllowedLocalFilePath(unsafePathThroughStorage), /授权访问范围/)
    expectThrow(
      () => unsafeAccess.assertAllowedLocalResourceUrl(toLocalResourceUrl(unsafePathThroughStorage)),
      /授权访问范围/,
    )
  }

  const indexSource = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')
  const documentsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
  const foldersSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'folders.ts'), 'utf8')
  assert(indexSource.includes('allowManagedFileAccessPaths(listStoredLocalResourcePaths({ includePageImages: false }))'))
  assert(!indexSource.includes('allowFileAccessPaths(listStoredLocalResourcePaths({ includePageImages: false }))'))
  assert(indexSource.includes("webContents.once('destroyed'"))
  assert(indexSource.includes('fileCapabilityService.revokeOwner(capabilityOwnerId)'))
  assert(indexSource.includes('fileCapabilityService.revokeAll()'))
  assert(indexSource.includes('fileCapabilitySweepTimer'))
  assert(documentsSource.includes('allowManagedFileAccessPath(doc.file_path)'))
  assert(documentsSource.includes('allowManagedFileAccessPath(page.image_path)'))
  assert(foldersSource.includes('allowManagedFileAccessPaths(documents.flatMap'))

  console.log(`File access boundary regression passed (storage-link=${storageLinkCovered ? 'covered' : 'skipped'})`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
