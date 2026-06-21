const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(content, needle, label) {
  if (!content.includes(needle)) {
    throw new Error(`${label} is missing: ${needle}`)
  }
}

function assertPanelViewportGuards(relativePath, label) {
  const content = read(relativePath)
  assertIncludes(content, 'clampFloatingPanelState', `${label} panel clamp import/use`)
  assertIncludes(content, 'clampAiButtonPosition', `${label} button clamp import/use`)
  assertIncludes(content, 'getDefaultFloatingPanelState', `${label} default panel position`)
  assertIncludes(content, "window.addEventListener('resize', handleViewportResize)", `${label} resize listener`)
  assertIncludes(content, "window.removeEventListener('resize', handleViewportResize)", `${label} resize cleanup`)
  assertIncludes(content, 'applyPanelState(panelState.current)', `${label} panel resize clamp`)
  assertIncludes(content, 'applyButtonPosition(btnPosRef.current)', `${label} button resize clamp`)
}

const util = read('src/renderer/src/utils/floatingViewport.ts')
assertIncludes(util, 'export function clampFloatingPanelState', 'floating viewport utility')
assertIncludes(util, 'export function clampAiButtonPosition', 'floating viewport utility')
assertIncludes(util, 'export function getDefaultFloatingPanelState', 'floating viewport utility')

assertPanelViewportGuards('src/renderer/src/App.tsx', 'Library AI floating panel')
assertPanelViewportGuards('src/renderer/src/views/DocumentView.tsx', 'Document AI floating panel')

const packageJson = JSON.parse(read('package.json'))
if (packageJson.scripts['check:ai-floating-panel-viewport'] !== 'node scripts/ai-floating-panel-viewport-regression.js') {
  throw new Error('package.json is missing check:ai-floating-panel-viewport')
}
if (!String(packageJson.scripts.check || '').includes('check:ai-floating-panel-viewport')) {
  throw new Error('npm run check does not include check:ai-floating-panel-viewport')
}

console.log('AI floating panel viewport regression checks passed.')
