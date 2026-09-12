const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { buildSync } = require('esbuild')

const source = buildSync({
  entryPoints: [path.join(__dirname, '../src/main/directory-access.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text
const mod = { exports: {} }
new Function('require', 'module', 'exports', source)(require, mod, mod.exports)
const { assertDirectoryWritable, describeDirectoryAccessFailure, shouldShowDirectoryFailureDialog } = mod.exports

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-directory-probe-'))
  const legacyProbe = path.join(directory, '.write-test')
  fs.writeFileSync(legacyProbe, 'first process')
  fs.writeFileSync(legacyProbe, 'second process')
  fs.unlinkSync(legacyProbe)
  assert.throws(() => fs.unlinkSync(legacyProbe), { code: 'ENOENT' }, 'old shared probe reproduces a false permission failure')
  fs.writeFileSync(legacyProbe, 'existing sentinel')
  await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads')
      const mod = { exports: {} }
      new Function('require', 'module', 'exports', workerData.source)(require, mod, mod.exports)
      for (let i = 0; i < 40; i += 1) mod.exports.assertDirectoryWritable(workerData.directory)
    `, { eval: true, workerData: { source, directory } })
    worker.on('error', reject)
    worker.on('exit', (code) => code ? reject(new Error('probe worker failed')) : resolve())
  })))
  assert.equal(fs.readFileSync(legacyProbe, 'utf8'), 'existing sentinel', 'new probes must not touch existing files')
  assert.deepEqual(fs.readdirSync(directory), ['.write-test'])
  assert.throws(() => assertDirectoryWritable(legacyProbe), 'a file cannot be used as a directory')
  assert.match(describeDirectoryAccessFailure(directory, { code: 'ENOSPC' }), /ENOSPC/)
  assert.match(describeDirectoryAccessFailure(directory, { code: 'EACCES' }), /EACCES/)
  assert(!describeDirectoryAccessFailure(directory, { code: 'ENOENT' }).includes('权限'))
  assert.equal(shouldShowDirectoryFailureDialog(true, {}), false)
  assert.equal(shouldShowDirectoryFailureDialog(false, { GUJISMART_HEADLESS: '1' }), false)
  assert.equal(shouldShowDirectoryFailureDialog(false, { GUJISMART_SMOKE: '1' }), false)
  assert.equal(shouldShowDirectoryFailureDialog(false, {}), true)
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
  assert(main.includes('shouldShowDirectoryFailureDialog(mcpLaunch.isMcp, process.env)'))
  assert(!main.includes("join(profileRoot, '.write-test')"))
  console.log('Directory startup regression passed: reproduced old collision; 480 concurrent probes succeeded.')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
