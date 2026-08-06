const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const proofreaderSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'GujiFacsimileProofreader.tsx'), 'utf8')
const workspaceCss = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'ManualLayoutEditor.css'), 'utf8')
const inspectorCss = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'ManualBlockInspector.css'), 'utf8')

assert.match(proofreaderSource, /manual-block-inspector-floating/, 'inspector must be rendered in a floating overlay container')
assert.match(proofreaderSource, /manual-block-inspector-toggle/, 'floating inspector must expose a compact toggle')
assert.match(workspaceCss, /position:\s*relative/, 'workspace must anchor the floating inspector without adding a flex column')
assert.match(workspaceCss, /\.manual-block-inspector-floating\s*\{[\s\S]*position:\s*absolute/, 'inspector surface must be overlay positioned')
assert.match(workspaceCss, /\.manual-block-inspector-floating-surface\s*\{[\s\S]*pointer-events:\s*auto/, 'floating inspector surface must remain interactive')
assert.doesNotMatch(workspaceCss, /\.manual-layout-editor-workspace\.is-editing\s*\{[\s\S]*flex-direction:\s*column/, 'inspector must not force the editor into a stacked layout')

console.log('Manual block inspector viewport regression checks passed.')
