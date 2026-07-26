const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const unpacked = path.resolve(process.env.GUJISMART_UNPACKED_DIR || path.join(root, 'dist', 'win-unpacked'))

function verifyPackagedRuntime(executable) {
  const probe = path.join(root, 'scripts', 'packaged-runtime-probe.js')
  const result = spawnSync(executable, [probe], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GUJISMART_PACKAGED_RESOURCES: path.join(unpacked, 'resources'),
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Packaged runtime dependency probe failed:\n${result.stderr || result.stdout}`)
  }
  if (result.stdout.trim()) console.log(result.stdout.trim())
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Packaged smoke currently requires Windows')
  const executable = fs.readdirSync(unpacked).filter((name) => name.toLowerCase().endsWith('.exe')).map((name) => path.join(unpacked, name)).find((filePath) => fs.statSync(filePath).isFile())
  if (!executable) throw new Error(`No packaged executable found in ${unpacked}`)
  for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'sbom.spdx.json', 'vendor-manifest.json']) {
    const candidates = [path.join(unpacked, 'resources', 'licenses', required), path.join(unpacked, 'resources', 'release-metadata', required)]
    if (!candidates.some((candidate) => fs.existsSync(candidate))) throw new Error(`Packaged metadata missing: ${required}`)
  }
  verifyPackagedRuntime(executable)
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-packaged-smoke-'))
  const userDataDir = path.join(smokeRoot, 'chromium')
  const dataDir = path.join(smokeRoot, 'data')
  const profileDir = path.join(smokeRoot, 'profile')
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      GUJISMART_SMOKE: '1',
      GUJISMART_DATA_DIR: dataDir,
      GUJISMART_PROFILE_DIR: profileDir,
      GUJISMART_AUTO_REINDEX: '0'
    }
  })
  try {
    const window = await app.firstWindow({ timeout: 30000 })
    await window.waitForLoadState('domcontentloaded')
    if (!(await window.locator('body').innerText()).trim()) throw new Error('Packaged renderer is blank')
    console.log('Packaged smoke passed.')
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(smokeRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
