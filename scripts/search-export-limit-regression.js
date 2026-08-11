const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const contractPath = path.join(root, 'src', 'shared', 'search-export.ts')
assert.ok(fs.existsSync(contractPath), 'search export count contract must exist')
const contract = read('src', 'shared', 'search-export.ts')
const types = read('src', 'shared', 'types.ts')
const ipc = read('src', 'main', 'ipc', 'search.ts')
const preload = read('src', 'preload', 'index.ts')
const renderer = read('src', 'renderer', 'src', 'views', 'SearchView.tsx')
const database = read('src', 'main', 'database.ts')
const workerClientPath = path.join(root, 'src', 'main', 'search-export-query-worker-client.ts')
const workerPath = path.join(root, 'src', 'main', 'search-export-query-worker.ts')
const electronVite = read('electron.vite.config.ts')
const packageJson = JSON.parse(read('package.json'))

assert.ok(/DEFAULT_SEARCH_EXPORT_COUNT\s*=\s*10_000/.test(contract), 'large export default must be 10,000')
assert.ok(/SearchExportCount\s*=\s*number\s*\|\s*'all'/.test(contract), 'export count must support numeric values and all')
assert.ok(contract.includes('Number.MAX_SAFE_INTEGER'), 'numeric export counts must use safe-integer bounds')
assert.ok(/export type(?:\s+SearchExportCount\s*=|\s*\{\s*SearchExportCount\s*\})/.test(types), 'shared types must expose SearchExportCount')
assert.ok(/maxExportRecords\?:\s*SearchExportCount/.test(types), 'search options must accept SearchExportCount')
assert.ok(types.includes("'search-export'"), 'background task contract must include search-export')
assert.ok(ipc.includes("search:startExportTask"), 'main IPC must expose background export start')
assert.ok(ipc.includes("search:cancelExportTask"), 'main IPC must expose export cancellation')
assert.ok(preload.includes('startSearchExportTask'), 'preload must expose background export start')
assert.ok(renderer.includes('onBackgroundTaskStatusChanged'), 'search UI must subscribe to export progress events')
assert.ok(renderer.includes('全部'), 'search UI must expose an all export option')
assert.ok(fs.existsSync(workerClientPath), 'full-text export preparation must have a worker client')
assert.ok(fs.existsSync(workerPath), 'full-text export preparation must have a worker entry')
const workerClient = fs.existsSync(workerClientPath) ? fs.readFileSync(workerClientPath, 'utf8') : ''
const worker = fs.existsSync(workerPath) ? fs.readFileSync(workerPath, 'utf8') : ''
assert.ok(workerClient.includes('new Worker('), 'full-text export preparation must run outside the Electron main thread')
assert.ok(worker.includes('querySearchV2'), 'search export worker must perform the exhaustive full-text query')
assert.ok(worker.includes("type: 'progress'"), 'search export worker must report preparation stages before returning results')
assert.ok(workerClient.includes("message.type === 'progress'"), 'worker client must forward preparation progress')
assert.ok(database.includes('initReadOnlyWorkerDatabase'), 'search export worker must open the database through a read-only initializer')
assert.ok(ipc.includes('startSearchExportQueryWorkerTask'), 'background export must delegate full-text preparation to the worker')
assert.ok(ipc.includes('preparationHeartbeat'), 'long-running export preparation must keep status feedback alive')
assert.ok(ipc.includes('buildExportParagraphsInBatches'), 'full-text paragraph restoration must be split into cancellable batches')
assert.ok(ipc.includes('buildSearchExportCompletionMessage'), 'export completion must use one formatter for raw-hit and output counts')
assert.ok(ipc.includes('原始命中'), 'export progress must label the worker total as raw search hits')
assert.ok(ipc.includes('完整段落'), 'full-text export completion must label deduplicated output as complete paragraphs')
assert.ok(/setImmediate\(\(\)\s*=>\s*\{\s*void runSearchExportTask/.test(ipc), 'export work must start after the start IPC returns')
assert.ok(renderer.includes('正在后台准备，软件仍可继续使用'), 'unknown-size preparation must show an active waiting state')
assert.ok(renderer.includes('formatSearchExportProgressCounter'), 'search UI must format the raw-hit progress counter separately from the status message')
assert.ok(renderer.includes('快速统计'), 'search UI must explain that normal search totals may differ from exhaustive all-export totals')
assert.ok(
  renderer.includes("if (expanded && !exportPreview && !exportPreviewLoading)"),
  'expanding export preview must automatically request preview data',
)
assert.ok(renderer.includes('预览尚未生成'), 'the preview UI must distinguish not-generated state from an empty result')
assert.ok(
  renderer.includes('reuseCurrentGroups: true'),
  'preview must reuse current search results instead of starting an unbounded all-results query',
)
assert.ok(
  /exportMaxRecords === 'all'\s*\?\s*\([\s\S]{0,800}全部命中/.test(renderer),
  'all mode must replace the numeric input instead of leaving an empty input beside the selector',
)
assert.ok(electronVite.includes("'search-export-query-worker'"), 'electron build must emit the search export worker entry')
assert.ok(
  String(packageJson.scripts?.check || '').includes('check:search-export'),
  'the full quality gate must include search export regressions',
)

console.log('Search export limit regression checks passed.')
