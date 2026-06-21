const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const evidenceQa = fs.readFileSync(path.join(root, 'src/main/evidence-qa.ts'), 'utf8')
const aiPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/AiPanel.tsx'), 'utf8')
const semanticSearch = fs.readFileSync(path.join(root, 'src/main/semantic-search.ts'), 'utf8')
const pagePayloadFiles = fs.readFileSync(path.join(root, 'src/main/page-payload-files.ts'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function fail(message) {
  throw new Error(message)
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) fail(`${label}: missing ${needle}`)
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) fail(`${label}: should not include ${needle}`)
}

assertIncludes(evidenceQa, 'const { plan, warnings: planWarnings } = await buildEvidencePlan(trimmed)', 'evidence QA should plan keywords before reading evidence')
assertIncludes(evidenceQa, 'const firstSearch = searchEvidence(trimmed, plan, docIds, options)', 'evidence QA should start with keyword search')
assertIncludes(evidenceQa, 'const pages = getPageWindow(docId, pageNum, radius)', 'evidence QA should read page windows around keyword hits')
assertIncludes(evidenceQa, 'getCachedDocumentBrief(docId)', 'query refinement may use cached metadata only')
assertIncludes(evidenceQa, 'autoReindex: false', 'AI evidence search should not trigger background reindex')
assertIncludes(evidenceQa, 'diversifyByDocument', 'evidence QA should diversify search hits across documents')
assertIncludes(evidenceQa, 'MAX_INITIAL_RESULTS_PER_DOCUMENT', 'evidence QA should prevent one document from taking all initial hits')
assertIncludes(evidenceQa, 'diversifyClustersByDocument', 'evidence QA should diversify evidence clusters across documents')
assertIncludes(evidenceQa, 'MAX_INITIAL_CLUSTERS_PER_DOCUMENT', 'evidence QA should prevent one document from taking all evidence groups')
assertIncludes(evidenceQa, 'shouldDiversifyAcrossDocuments(docIds)', 'single-document scopes should not be penalized by cross-document diversification')
assertIncludes(semanticSearch, 'options.autoReindex !== false', 'search should support disabling automatic background reindex')
assertNotIncludes(pagePayloadFiles, "from 'electron'", 'page payload storage must not statically import Electron because search workers load it')
assertNotIncludes(pagePayloadFiles, 'require("electron")', 'page payload storage must not require Electron because search workers load it')
assertNotIncludes(pagePayloadFiles, "import { is } from '@electron-toolkit/utils'", 'page payload storage should not use electron-toolkit is.dev in worker-loaded code')

assertNotIncludes(evidenceQa, 'getDocumentBrief(', 'evidence QA must not generate full-document briefs during chat')
assertNotIncludes(evidenceQa, 'getDocumentTextPages(', 'evidence QA must not read all pages from a document')
assertNotIncludes(evidenceQa, 'buildDocumentOverviewClusters(', 'evidence QA must not build full-document overview clusters')
assertNotIncludes(evidenceQa, 'resolveOverviewDocumentIds(', 'evidence QA must not select documents for overview reading')
assertNotIncludes(evidenceQa, 'selectOverviewPages(', 'evidence QA must not sample whole documents for overview')
assertNotIncludes(evidenceQa, 'isOverviewQuestion(', 'evidence QA must not branch into overview mode from broad questions')

assertIncludes(aiPanel, '不会通篇阅读', 'library quick prompt should forbid full reading')
assertIncludes(aiPanel, '关键词命中的原文页及前后文本', 'library quick prompt should describe keyword-hit page windows')

if (packageJson.scripts['check:ai-evidence-keyword-first'] !== 'node scripts/ai-evidence-keyword-first-regression.js') {
  fail('package.json is missing check:ai-evidence-keyword-first')
}
if (!String(packageJson.scripts.check || '').includes('check:ai-evidence-keyword-first')) {
  fail('npm run check does not include check:ai-evidence-keyword-first')
}

console.log('AI evidence keyword-first regression checks passed.')
