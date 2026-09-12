// Requires explicitly supplied old/new packages. Only the temporary fixture library is modified.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { performance } = require('node:perf_hooks')
const { _electron: electron } = require('playwright')
const oldExecutable = process.env.GUJISMART_OLD_EXECUTABLE
const newExecutable = process.env.GUJISMART_NEW_EXECUTABLE
assert(oldExecutable && fs.existsSync(oldExecutable), 'Set GUJISMART_OLD_EXECUTABLE to the old unpacked application')
assert(newExecutable && fs.existsSync(newExecutable), 'Set GUJISMART_NEW_EXECUTABLE to the new unpacked application')
const root = fs.mkdtempSync(join(tmpdir(), 'gujismart-upgrade-'))
const env = { ...process.env, GUJISMART_SMOKE: '1', GUJISMART_DATA_DIR: join(root, 'data'), GUJISMART_PROFILE_DIR: join(root, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
const expected = ['fullcoveragefirst', 'fullcoveragelast']
const files = expected.map((marker, i) => {
  const file = join(root, `source-${i}.txt`)
  fs.writeFileSync(file, `Complete fixture ${i}\n${Array.from({ length: 6000 }, (_, n) => `Line ${n}: preserved original content.`).join('\n')}\n${marker}\nsharedcoveragekeyword\n`)
  return file
})
async function launch(executable) {
  const start = performance.now()
  const app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(root, 'chromium')}`], env })
  const window = await app.firstWindow({ timeout: 30000 })
  await window.waitForFunction(() => !!window.api, null, { timeout: 30000 })
  const version = await app.evaluate(({ app }) => app.getVersion())
  const project = await window.evaluate(async () => {
    const projects = await window.api.listLibraryProjects()
    await window.api.setActiveLibraryProject(projects[0].id)
    return projects[0].id
  })
  return { app, window, version, project, startupToApiMs: Math.round(performance.now() - start) }
}
async function search(window, query, docIds) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await window.evaluate(({ query, docIds }) => window.api.querySearchV2(query, { docIds, limit: 100 }), { query, docIds })
    if (result.totalHits > 0) return result.totalHits
    await window.waitForTimeout(250)
  }
  assert.fail(`No result for fixture marker ${query}`)
}
async function run() {
  let old
  let next
  try {
    old = await launch(oldExecutable)
    await old.window.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'upgrade-import'
      input.type = 'file'
      input.multiple = true
      document.body.appendChild(input)
    })
    await old.window.locator('#upgrade-import').setInputFiles(files)
    const ids = await old.window.evaluate(async () => {
      const input = document.getElementById('upgrade-import')
      const granted = await window.api.grantDroppedImportSources(Array.from(input.files))
      if (!granted.ok) throw new Error(granted.error.message)
      try {
        const batch = await window.api.readImportSelectionBatch(granted.value.selectionId, null, 200)
        if (!batch.ok) throw new Error(batch.error.message)
        const results = await window.api.importDocuments(batch.value.items.map((item) => item.grantId))
        if (results.some((result) => !result.success)) throw new Error(JSON.stringify(results))
        return results.map((result) => result.id)
      } finally { await window.api.releaseImportSelection(granted.value.selectionId) }
    })
    assert.equal(ids.length, 2)
    const originalTexts = await old.window.evaluate(async (ids) => {
      const values = []
      for (const id of ids) {
        const pages = await window.api.getDocumentSearchPages(id)
        values.push(pages.map((page) => page.proofed_text || page.ocr_text || '').join('\n'))
      }
      return values
    }, ids)
    for (const [i, marker] of expected.entries()) {
      assert(originalTexts[i].includes(marker))
      await search(old.window, marker, [ids[i]])
    }
    const previousTotal = await search(old.window, 'sharedcoveragekeyword', ids)
    assert(previousTotal >= 2)
    await old.app.close()
    next = await launch(newExecutable)
    assert.equal(next.project, old.project)
    for (const [i, id] of ids.entries()) {
      const pages = await next.window.evaluate((id) => window.api.getDocumentSearchPages(id), id)
      assert.equal(pages.map((page) => page.proofed_text || page.ocr_text || '').join('\n'), originalTexts[i], 'upgrade preserves full original content')
      await search(next.window, expected[i], [id])
    }
    assert.equal(await search(next.window, 'sharedcoveragekeyword', ids), previousTotal, 'upgrade must preserve complete cross-document hit counts')
    console.log(JSON.stringify({ oldVersion: old.version, newVersion: next.version, oldStartupToApiMs: old.startupToApiMs, newStartupToApiMs: next.startupToApiMs, preservedDocuments: ids.length, preservedCrossDocumentHits: previousTotal, fixture: root }))
  } finally {
    if (next) await next.app.close().catch(() => undefined)
    if (old) await old.app.close().catch(() => undefined)
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
