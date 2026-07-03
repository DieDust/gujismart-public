const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const pureSharedModules = [
  ['src/shared/ai-response-envelope.ts', 'check:ai-response-envelope'],
  ['src/shared/backup-integrity.ts', 'check:backup-integrity'],
  ['src/shared/citation-field-resolver.ts', 'check:citation-field-resolver'],
  ['src/shared/config-validation.ts', 'check:config-validation'],
  ['src/shared/document-pipeline-diagnostics.ts', 'check:document-pipeline-diagnostics'],
  ['src/shared/metadata-tag-guard.ts', 'check:metadata-tag-guard'],
  ['src/shared/ocr-run-metadata.ts', 'check:ocr-run-metadata'],
  ['src/shared/research-integrity.ts', 'check:research-integrity'],
  ['src/shared/search-index-health.ts', 'check:search-index-health'],
  ['src/shared/status-envelope.ts', 'check:status-envelope'],
]

const forbiddenImportPatterns = [
  /\bfrom\s+['"]electron['"]/,
  /\bfrom\s+['"]better-sqlite3['"]/,
  /\bfrom\s+['"]fs(?:\/promises)?['"]/,
  /\bfrom\s+['"]path['"]/,
  /\bfrom\s+['"]\.\.\/main\//,
  /\bfrom\s+['"]\.\.\/\.\.\/main\//,
  /\bfrom\s+['"].*\/database['"]/,
  /\brequire\(['"]electron['"]\)/,
  /\brequire\(['"]better-sqlite3['"]\)/,
  /\brequire\(['"]fs(?:\/promises)?['"]\)/,
]

const packageJson = JSON.parse(read('package.json'))
const checkScript = String(packageJson.scripts.check || '')
const docs = read('docs/SCRIPTS.md')

for (const [relativePath, checkName] of pureSharedModules) {
  const source = read(relativePath)
  for (const pattern of forbiddenImportPatterns) {
    assert(!pattern.test(source), `${relativePath} should remain pure and must not match ${pattern}`)
  }
  assert(packageJson.scripts[checkName], `package.json is missing ${checkName}`)
  assert(checkScript.includes(checkName), `npm run check should include ${checkName}`)
  assert(docs.includes(checkName), `docs/SCRIPTS.md should mention ${checkName}`)
}

const mainModules = [
  ['src/main/ipc/ai.ts', 'buildAiResponseEnvelope'],
  ['src/main/ipc/citation.ts', 'buildCitationFieldResolutionReport'],
  ['src/main/ipc/documents.ts', 'documentPipelineDiagnosticsFromImportProgress'],
  ['src/main/ipc/ocr.ts', 'ocrRunMetadataFromProgress'],
  ['src/main/backup.ts', 'buildBackupIntegrityReport'],
  ['src/main/metadata-tags.ts', 'decideMetadataTagRelationCleanup'],
  ['src/main/semantic-search.ts', 'buildSearchIndexHealthDiagnostics'],
]

for (const [relativePath, helperName] of mainModules) {
  assert(read(relativePath).includes(helperName), `${relativePath} should use extracted helper ${helperName}`)
}

console.log('Module layering regression checks passed.')
