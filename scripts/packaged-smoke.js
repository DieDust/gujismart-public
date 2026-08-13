const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const unpacked = path.resolve(process.env.GUJISMART_UNPACKED_DIR || path.join(root, 'dist', 'win-unpacked'))
let capabilityInputSequence = 0

async function importFilesWithCapabilities(window, filePaths) {
  const inputId = `packaged-smoke-capability-input-${++capabilityInputSequence}`
  await window.evaluate((id) => {
    const input = document.createElement('input')
    input.id = id
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
  }, inputId)

  try {
    await window.locator(`#${inputId}`).setInputFiles(filePaths)
    return await window.evaluate(async (id) => {
      const input = document.getElementById(id)
      const selectionResult = await window.api.grantDroppedImportSources(Array.from(input?.files || []))
      if (!selectionResult.ok) throw new Error(selectionResult.error.message)
      const results = []
      let cursor = null
      try {
        while (true) {
          const batchResult = await window.api.readImportSelectionBatch(selectionResult.value.selectionId, cursor, 200)
          if (!batchResult.ok) throw new Error(batchResult.error.message)
          if (batchResult.value.items.length > 0) {
            const batch = await window.api.importDocuments(batchResult.value.items.map((item) => item.grantId))
            results.push(...batch)
          }
          if (batchResult.value.done) break
          cursor = batchResult.value.nextCursor
        }
      } finally {
        await window.api.releaseImportSelection(selectionResult.value.selectionId)
      }
      return results
    }, inputId)
  } finally {
    await window.evaluate((id) => document.getElementById(id)?.remove(), inputId)
  }
}

async function verifyPackagedSearchExcerptExport(window, smokeRoot) {
  const keyword = 'packaged-export-worker-keyword'
  const sourcePath = path.join(smokeRoot, 'packaged-export-worker.txt')
  fs.writeFileSync(sourcePath, `Packaged export regression. ${keyword} appears in this complete paragraph.\n`, 'utf8')
  const imported = await importFilesWithCapabilities(window, [sourcePath])
  if (!Array.isArray(imported) || !imported[0]?.success || !imported[0]?.id) {
    throw new Error(`Packaged export fixture import failed: ${JSON.stringify(imported)}`)
  }
  const docId = imported[0].id
  await window.evaluate(async ({ id, query }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await window.api.querySearchV2(query, { docIds: [id], limit: 20 })
      if (response?.totalHits > 0) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Packaged export fixture did not enter the search index')
  }, { id: docId, query: keyword })
  const preview = await window.evaluate(async ({ id, query }) => (
    window.api.previewSearchExportExcerpts(query, {
      docIds: [id],
      limit: 100,
      maxExportRecords: 100,
      searchEngine: 'fulltext',
      format: 'txt',
    })
  ), { id: docId, query: keyword })
  const previewContainsKeyword = Array.isArray(preview?.previewItems)
    && preview.previewItems.some((item) => String(item?.paragraph || '').includes(keyword))
  if (!previewContainsKeyword || preview.totalHits < 1 || preview.exportableParagraphs < 1) {
    throw new Error(`Packaged search excerpt export returned invalid content: ${JSON.stringify(preview)}`)
  }
  console.log('Packaged search excerpt export passed.')
}

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
    await verifyPackagedSearchExcerptExport(window, smokeRoot)
    console.log('Packaged smoke passed.')
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(smokeRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
