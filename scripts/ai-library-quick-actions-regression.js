const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const aiPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/AiPanel.tsx'), 'utf8')
const semanticSearch = fs.readFileSync(path.join(root, 'src/main/semantic-search.ts'), 'utf8')
const appCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/app.css'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

assertIncludes(aiPanel, 'const ANALYSIS_TEMPLATES = [', 'AI panel should keep one explicit analysis template list')
assertIncludes(aiPanel, "label: '研究脉络'", 'AI panel should offer research context as an analysis template')
assertIncludes(aiPanel, "label: '比较观点'", 'AI panel should offer comparison as an analysis template')
assertIncludes(aiPanel, "label: '阶段梳理'", 'AI panel should offer stage summary as an analysis template')
if (aiPanel.includes('LIBRARY_QUICK_PROMPTS')) {
  throw new Error('AI panel should not keep duplicate library quick prompt buttons above analysis templates')
}
if (aiPanel.includes('applyLibraryQuickPrompt')) {
  throw new Error('AI panel analysis templates should not jump back to the question tab')
}
assertIncludes(aiPanel, '查看文献', 'AI panel should hide scope documents behind a hover detail control')
assertIncludes(aiPanel, 'ai-scope-popover-list', 'AI panel should show scope documents in a scrollable popover list')
assertIncludes(aiPanel, '展开完整列表', 'AI scope popover should offer a real way to expand long document ranges')
if ((aiPanel.match(/展开完整列表/g) || []).length !== 1) {
  throw new Error('AI scope popover should render exactly one expand entry')
}
assertIncludes(aiPanel, 'ai-scope-modal-list', 'AI scope expanded document list should render in a dedicated modal')
assertIncludes(aiPanel, 'setScopeListDocuments(await loadScopeListDocuments())', 'AI scope expanded list should load full documents for the current scope')
assertIncludes(aiPanel, 'onWheel={(event) => event.stopPropagation()}', 'AI scope popover should keep wheel scrolling inside the document list')
assertIncludes(aiPanel, 'ai-panel-tabs-sticky', 'AI panel tabs should stay visible while scrolling answers')
assertIncludes(appCss, '.ai-panel-tabs-sticky', 'AI panel should style tabs as sticky')
assertIncludes(appCss, '.ai-scope-modal-list', 'AI scope modal list should have its own scroll container')
assertIncludes(appCss, 'overscroll-behavior: contain', 'AI scope popover list should not leak wheel events to the panel')
assertIncludes(appCss, 'max-height: min(360px, calc(100vh - 260px))', 'AI scope popover list should have an explicit scroll height')
assertIncludes(semanticSearch, 'LIMIT 500', 'AI scope preview should expose enough documents for a useful expanded list')

const labels = [...aiPanel.matchAll(/label: '([^']+)'/g)]
  .map((match) => match[1])
  .filter((label) => ['研究脉络', '比较观点', '阶段梳理'].includes(label))
const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index)
if (duplicates.length > 0) {
  throw new Error(`AI library quick action labels must be unique: ${duplicates.join(', ')}`)
}

if (packageJson.scripts['check:ai-library-quick-actions'] !== 'node scripts/ai-library-quick-actions-regression.js') {
  throw new Error('package.json is missing check:ai-library-quick-actions')
}
if (!String(packageJson.scripts.check || '').includes('check:ai-library-quick-actions')) {
  throw new Error('npm run check does not include check:ai-library-quick-actions')
}

console.log('AI library quick action regression checks passed.')
