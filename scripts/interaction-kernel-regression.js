const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-interaction-kernel-'))
const bundlePath = path.join(tempRoot, 'interaction-kernel.cjs')

async function main() {
  await esbuild.build({ entryPoints: [path.join(root, 'src/renderer/src/utils/interactionKernel.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath, logLevel: 'silent' })
  const { CloseCoordinator, LatestRequestGate, DragTransaction, toggleSelectionId } = require(bundlePath)

  const close = new CloseCoordinator()
  close.register('clean', async () => ({ status: 'clean' }))
  close.register('dirty', async () => ({ status: 'needs-confirmation', reason: 'unsaved' }))
  const blocked = await close.prepareClose()
  assert.strictEqual(blocked.canClose, false)
  assert.strictEqual(blocked.results.length, 2)
  close.unregister('dirty')
  assert.strictEqual((await close.prepareClose()).canClose, true)

  const gate = new LatestRequestGate()
  const first = gate.begin('search')
  const second = gate.begin('search')
  assert.strictEqual(gate.isCurrent(first), false)
  assert.strictEqual(gate.isCurrent(second), true)
  gate.cancel('search')
  assert.strictEqual(gate.isCurrent(second), false)

  let commits = 0
  const drag = new DragTransaction({ tabs: ['a', 'b'] }, (preview) => { commits += 1; assert.deepStrictEqual(preview.tabs, ['b', 'a']) })
  drag.preview({ tabs: ['b', 'a'] })
  drag.cancel()
  assert.strictEqual(commits, 0)
  const committed = new DragTransaction({ tabs: ['a', 'b'] }, () => { commits += 1 })
  committed.preview({ tabs: ['b', 'a'] })
  assert.strictEqual(committed.commit(), true)
  assert.strictEqual(committed.commit(), false)
  assert.strictEqual(commits, 1)

  assert.deepStrictEqual(toggleSelectionId(['doc-a', 'doc-b', 'doc-c'], 'doc-b'), ['doc-a', 'doc-c'])
  assert.deepStrictEqual(toggleSelectionId(['doc-a', 'doc-c'], 'doc-b'), ['doc-a', 'doc-c', 'doc-b'])
  console.log('Interaction kernel regression passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
