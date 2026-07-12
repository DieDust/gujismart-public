const assert = require('assert')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

async function main() {
  const root = path.resolve(__dirname, '..')
  const sourcePath = path.join(root, 'src', 'main', 'import-selections.ts')
  const capabilitySourcePath = path.join(root, 'src', 'main', 'file-capabilities.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  assert(!source.includes('await readdir('), 'directory pagination must not materialize an entire directory')
  assert(source.includes('opendir'), 'directory pagination must use a bounded streaming directory cursor')
  assert(source.includes('async release(ownerId: number'), 'explicit release must await open directory handle cleanup')

  const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
  assert(
    librarySource.includes('remainingBeforeRefill = job.filePaths.length')
      && librarySource.includes('if (remainingBeforeRefill > 0) break'),
    'multi-batch drain must continue after a successful refill and pause only for an unfinished batch',
  )

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gujismart-import-selection-'))
  const bundlePath = path.join(tempRoot, 'import-selections.cjs')
  const capabilityBundlePath = path.join(tempRoot, 'file-capabilities.cjs')
  try {
    buildSync({ entryPoints: [sourcePath], outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs' })
    buildSync({ entryPoints: [capabilitySourcePath], outfile: capabilityBundlePath, bundle: true, platform: 'node', format: 'cjs' })
    const { ImportSelectionService } = require(bundlePath)
    const { FileCapabilityService } = require(capabilityBundlePath)
    const directory = path.join(tempRoot, 'many')
    await fsp.mkdir(directory)
    await Promise.all(Array.from({ length: 405 }, (_, index) => (
      fsp.writeFile(path.join(directory, `item-${String(index).padStart(3, '0')}.pdf`), `pdf-${index}`)
    )))

    const service = new ImportSelectionService()
    const selection = await service.create(11, [directory])
    const counts = []
    let cursor = null
    let done = false
    while (!done) {
      const batch = await service.readBatch(11, selection.selectionId, cursor, 200)
      counts.push(batch.items.length)
      cursor = batch.nextCursor
      done = batch.done
    }
    assert.deepStrictEqual(counts, [200, 200, 5], '405 files must drain in three bounded batches')

    const overlapRoot = path.join(tempRoot, 'overlap')
    const overlapChild = path.join(overlapRoot, 'child')
    await fsp.mkdir(overlapChild, { recursive: true })
    const overlapRootFile = path.join(overlapRoot, 'root.pdf')
    const overlapChildFile = path.join(overlapChild, 'nested.pdf')
    await fsp.writeFile(overlapRootFile, 'root')
    await fsp.writeFile(overlapChildFile, 'nested')
    const overlapSelection = await service.create(11, [overlapChildFile, overlapRoot, overlapChild])
    const overlapPaths = []
    let overlapCursor = null
    let overlapDone = false
    while (!overlapDone) {
      const overlapBatch = await service.readBatch(11, overlapSelection.selectionId, overlapCursor, 1)
      overlapPaths.push(...overlapBatch.items.map((item) => item.relativeDisplayPath || item.displayName))
      overlapCursor = overlapBatch.nextCursor
      overlapDone = overlapBatch.done
    }
    assert.strictEqual(overlapPaths.length, 2, 'direct file, parent directory, and child directory must emit canonical files once')
    assert.strictEqual(overlapPaths.filter((item) => item.endsWith('nested.pdf')).length, 1)
    await service.release(11, overlapSelection.selectionId)

    const singleDirectory = path.join(tempRoot, 'single-directory')
    await fsp.mkdir(singleDirectory)
    await fsp.writeFile(path.join(singleDirectory, 'only.pdf'), 'single')
    const singleSelection = await service.create(11, [singleDirectory])
    const singleSourceId = singleSelection.sources[0].sourceId
    const singleBatch = await service.readBatch(11, singleSelection.selectionId, null, 10)
    assert.strictEqual(singleBatch.done, true)
    assert.strictEqual(singleBatch.items.length, 1)
    assert.strictEqual(
      await service.getDirectorySourcePath(11, singleSelection.selectionId, singleSourceId),
      await fsp.realpath(singleDirectory),
      'completed selection must retain owner-bound source metadata until explicit release',
    )
    await service.release(11, singleSelection.selectionId)
    await assert.rejects(
      service.getDirectorySourcePath(11, singleSelection.selectionId, singleSourceId),
      (error) => error && error.code === 'CAPABILITY_UNKNOWN',
    )

    const completedSelectionIds = []
    for (let index = 0; index < 70; index += 1) {
      const filePath = path.join(tempRoot, `sequential-${index}.txt`)
      await fsp.writeFile(filePath, String(index))
      const next = await service.create(11, [filePath])
      const batch = await service.readBatch(11, next.selectionId, null, 10)
      assert.strictEqual(batch.done, true)
      assert.strictEqual(batch.items.length, 1)
      completedSelectionIds.push(next.selectionId)
    }
    await Promise.all(completedSelectionIds.map((selectionId) => service.release(11, selectionId)))

    let failOnce = true
    const retryCapabilities = new FileCapabilityService()
    const retryService = new ImportSelectionService({
      issueFileGrants: async (options) => {
        if (failOnce) {
          failOnce = false
          throw new Error('injected grant failure')
        }
        return retryCapabilities.issueTrustedPaths(options)
      },
    })
    const retrySelection = await retryService.create(12, [directory])
    await assert.rejects(
      retryService.readBatch(12, retrySelection.selectionId, null, 200),
      /injected grant failure/,
    )
    const retried = await retryService.readBatch(12, retrySelection.selectionId, null, 200)
    assert.strictEqual(retried.items.length, 200, 'failed grant issuance must not advance or lose the page')

    const alwaysFailService = new ImportSelectionService({
      maxActiveSelections: 64,
      issueFileGrants: async () => {
        throw new Error('injected persistent grant failure')
      },
    })
    for (let index = 0; index < 70; index += 1) {
      const failedSelection = await alwaysFailService.create(13, [directory])
      await assert.rejects(
        alwaysFailService.readBatch(13, failedSelection.selectionId, null, 1),
        /injected persistent grant failure/,
      )
      await alwaysFailService.release(13, failedSelection.selectionId)
      if (index === 0) {
        const renamedDirectory = path.join(tempRoot, 'many-renamed')
        await fsp.rename(directory, renamedDirectory)
        await fsp.rename(renamedDirectory, directory)
      }
    }
    const afterFailures = await alwaysFailService.create(13, [directory])
    await alwaysFailService.release(13, afterFailures.selectionId)
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
  console.log('Import selection behavior regression passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
