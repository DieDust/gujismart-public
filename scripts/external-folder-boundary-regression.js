const assert = require('assert')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

async function main() {
  const root = path.resolve(__dirname, '..')
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gujismart-external-folder-'))
  try {
    const bundlePath = path.join(tempRoot, 'boundary.cjs')
    buildSync({
      entryPoints: [path.join(root, 'src', 'main', 'external-folder-boundary.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    })
    const { scanCanonicalExternalFolder } = require(bundlePath)
    const sourceRoot = path.join(tempRoot, 'source')
    const outsideRoot = path.join(tempRoot, 'source-evil')
    await fsp.mkdir(path.join(sourceRoot, 'nested'), { recursive: true })
    await fsp.mkdir(outsideRoot)
    await fsp.writeFile(path.join(sourceRoot, 'inside.pdf'), 'inside')
    await fsp.writeFile(path.join(sourceRoot, 'nested', 'inside.txt'), 'nested')
    await fsp.writeFile(path.join(outsideRoot, 'outside.pdf'), 'outside')

    let junctionSupported = true
    const nestedJunction = path.join(sourceRoot, 'outside-link')
    try {
      await fsp.symlink(outsideRoot, nestedJunction, 'junction')
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) junctionSupported = false
      else throw error
    }

    const files = await scanCanonicalExternalFolder(sourceRoot, new Set(['.pdf', '.txt']))
    assert.deepStrictEqual(files.map((item) => item.name).sort(), ['inside.pdf', 'inside.txt'])
    assert(files.every((item) => item.path.startsWith(sourceRoot)), 'scan must not escape to a similar-prefix directory')

    if (junctionSupported) {
      const rootJunction = path.join(tempRoot, 'root-link')
      await fsp.symlink(sourceRoot, rootJunction, 'junction')
      await assert.rejects(
        scanCanonicalExternalFolder(rootJunction, new Set(['.pdf'])),
        (error) => error && error.code === 'EXTERNAL_FOLDER_LINK_REJECTED',
      )
      assert(!files.some((item) => item.name === 'outside.pdf'), 'nested junction contents must be skipped')
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
  console.log('External folder boundary regression passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
