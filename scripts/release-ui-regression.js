// Run against a fresh build; each fixture owns its temporary data and Electron profile.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  throw new Error('Run npm run build before the release UI checks.')
}

const checks = [
  ['editor-workflow-ui-regression.js'],
  ['facsimile-editing-ui-regression.js'],
  ['knowledge-question-ui-regression.js'],
  ['corpus-research-ui-regression.js'],
  ['research-progress-ui-regression.js'],
  ['research-graph-ui-regression.js'],
  ['research-graph-ui-regression.js', '--large'],
  ['research-graph-ui-regression.js', '--topic'],
]
const env = { ...process.env }
env.GUJISMART_TEST_BACKGROUND = '1'
delete env.ELECTRON_RUN_AS_NODE
for (const [script, ...args] of checks) {
  console.log(`[release-ui] ${script} ${args.join(' ')}`.trim())
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log(`Release UI checks passed (${checks.length} isolated fixtures).`)
