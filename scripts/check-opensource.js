const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

const ignoredDirectories = new Set([
  '.git',
  '.agents',
  '.codex',
  '.solomd',
  '.trae',
  '.trellis',
  'node_modules',
  'out',
  'dist',
  'dist-archive',
  'data',
  'output',
  'tmp',
  'coverage',
  '.cache',
  '.vite',
  '.nyc_output',
])

const ignoredDirectoryPrefixes = [
  '.tmp-',
  'electron-user-data',
]

const ignoredFiles = new Set([
  'package-lock.json',
])

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.nsh',
  '.ps1',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
])

const legacyCorpusTerms = ['real' + 'data', 'real' + 'doc']

const pathChecks = [
  {
    name: 'legacy manual-corpus filename marker',
    test: (relativePath) => legacyCorpusTerms.some((term) => relativePath.toLowerCase().includes(term)),
  },
  {
    name: 'private manual QA script',
    test: (relativePath) => {
      if (!relativePath.startsWith('scripts/')) return false
      return [
        'manual' + '-corpus',
        'reader-multidoc',
        'reader-pageflip',
        'reader-search-qa',
        'connect-source',
        'toc-anchor',
        'toc-active',
        'toc-archive',
        'toc-paper',
        'toc-rule-diagnostic',
        'toc-same-page',
        'footnote-paper-qa',
      ].some((term) => relativePath.includes(term))
    },
  },
  {
    name: 'local inspection script',
    test: (relativePath) => /^scripts\/inspect-[^/]+\.(?:cjs|mjs|js)$/.test(relativePath),
  },
]

const checks = [
  {
    name: 'legacy manual-corpus source marker',
    pattern: new RegExp(legacyCorpusTerms.join('|'), 'i'),
  },
  {
    name: 'manual QA corpus fallback to project data',
    pattern: /GUJISMART_QA_DATA_DIR\s*\|\|[\s\S]{0,160}(?:path\.join\(process\.cwd\(\), ['"]data['"]\)|join\(__dirname, ['"]\.\.['"], ['"]data['"]\)|path\.resolve\(__dirname, ['"]\.\.['"], ['"]data['"]\))/,
  },
  {
    name: 'inspection database fallback to project data',
    pattern: /(?:GUJISMART_INSPECT_DB|process\.argv\[2\])[\s\S]{0,180}path\.resolve\(__dirname, ['"]\.\.['"], ['"]data['"], ['"]db['"], ['"]gujismart\.db['"]\)/,
  },
  {
    name: 'manual QA corpus-specific env fallback',
    pattern: /process\.env\.GUJISMART_(?:QA|SMOKE)_[A-Z0-9_]*(?:DOC_ID|KEYWORD)[A-Z0-9_]*\s*\|\|\s*['"][^'"]+['"]/,
  },
  {
    name: 'manual QA corpus-specific document id literal',
    pattern: /\b(?:docId|targetDocId|DOC_ID)\b\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/,
  },
  {
    name: 'manual QA corpus-specific argv fallback',
    pattern: /process\.argv\[\d+\]\s*\|\|\s*['"][A-Za-z0-9_-]{12,}['"]/,
  },
  {
    name: 'hardcoded OCR API key',
    pattern: /\bpaddleocr_api_key\b\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/i,
  },
  {
    name: 'hardcoded bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  },
  {
    name: 'OpenAI-style secret key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'local GujiSmart database path',
    pattern: /[A-Za-z]:[\\/][^\r\n'"`<>|]*gujismart[\\/](?:data|auto-backups)[^\r\n'"`<>|]*/i,
  },
  {
    name: 'local Chinese workspace database path',
    pattern: /文献处理软件[\\/]gujismart[\\/](?:data|auto-backups)/,
  },
  {
    name: 'private manual corpus name',
    pattern: new RegExp(['刘', '春', '杰'].join('') + '|liu' + 'chunjie', 'i'),
  },
]

function shouldIgnoreDirectory(name) {
  return ignoredDirectories.has(name) || ignoredDirectoryPrefixes.some((prefix) => name.startsWith(prefix))
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(root, fullPath)
    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) continue
      walk(fullPath, files)
      continue
    }
    if (ignoredFiles.has(entry.name)) continue
    if (!textExtensions.has(path.extname(entry.name))) continue
    files.push(relativePath)
  }
  return files
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

const findings = []

function addFinding(file, check, line = 1) {
  findings.push({ file, line, check })
}

function readRequiredText(relativePath) {
  const fullPath = path.join(root, relativePath)
  if (!fs.existsSync(fullPath)) {
    addFinding(relativePath, 'required open-source metadata file is missing')
    return ''
  }
  return fs.readFileSync(fullPath, 'utf8')
}

function requireText(relativePath, source, pattern, check) {
  if (pattern.test(source)) return
  addFinding(relativePath, check)
}

function requirePackageField(pkg, fieldPath, expectedValue) {
  const value = fieldPath.split('.').reduce((current, key) => {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key]
    }
    return undefined
  }, pkg)
  if (value === expectedValue) return
  addFinding('package.json', `package metadata ${fieldPath} must be ${expectedValue}`)
}

function runMetadataChecks() {
  let pkg = {}
  try {
    pkg = JSON.parse(readRequiredText('package.json'))
  } catch (error) {
    addFinding('package.json', `package metadata must be valid JSON: ${error.message}`)
  }

  requirePackageField(pkg, 'license', 'Apache-2.0')
  requirePackageField(pkg, 'private', false)
  requirePackageField(pkg, 'repository.url', 'git+https://github.com/DieDust/gujismart-public.git')
  requirePackageField(pkg, 'bugs.url', 'https://github.com/DieDust/gujismart-public/issues')
  requirePackageField(pkg, 'homepage', 'https://github.com/DieDust/gujismart-public#readme')

  const license = readRequiredText('LICENSE')
  requireText('LICENSE', license, /Apache License\s+Version 2\.0/i, 'project LICENSE must contain Apache License 2.0 text')

  const notice = readRequiredText('NOTICE')
  requireText('NOTICE', notice, /Copyright 2026 DieDust/, 'NOTICE must include project copyright attribution')
  requireText('NOTICE', notice, /THIRD_PARTY_NOTICES\.md/, 'NOTICE must point to third-party notices')
  requireText('NOTICE', notice, /QPDF/i, 'NOTICE must retain bundled QPDF attribution')

  const readme = readRequiredText('README.md')
  requireText('README.md', readme, /\[Apache License 2\.0\]\(LICENSE\)/, 'README must link the main Apache-2.0 license')
  requireText('README.md', readme, /\[NOTICE\]\(NOTICE\)/, 'README must link NOTICE')
  requireText('README.md', readme, /\[THIRD_PARTY_NOTICES\.md\]\(THIRD_PARTY_NOTICES\.md\)/, 'README must link third-party notices')

  const contributing = readRequiredText('CONTRIBUTING.md')
  requireText('CONTRIBUTING.md', contributing, /Licensing and Attribution/, 'CONTRIBUTING must explain licensing and attribution expectations')
  requireText('CONTRIBUTING.md', contributing, /THIRD_PARTY_NOTICES\.md/, 'CONTRIBUTING must require third-party attribution updates')

  const thirdParty = readRequiredText('THIRD_PARTY_NOTICES.md')
  requireText('THIRD_PARTY_NOTICES.md', thirdParty, /resources\/vendor\/qpdf\//, 'third-party notices must document bundled QPDF')
  requireText('THIRD_PARTY_NOTICES.md', thirdParty, /Microsoft Visual C\+\+ Runtime Files/, 'third-party notices must document bundled Microsoft runtime files')
  requireText('THIRD_PARTY_NOTICES.md', thirdParty, /jszip[\s\S]+MIT OR GPL-3\.0-or-later/, 'third-party notices must document jszip dual license')
  requireText('THIRD_PARTY_NOTICES.md', thirdParty, /pdfjs-dist[\s\S]+Apache-2\.0/, 'third-party notices must document pdfjs-dist license')
  requireText('THIRD_PARTY_NOTICES.md', thirdParty, /playwright[\s\S]+Apache-2\.0/, 'third-party notices must document Playwright license')
}

runMetadataChecks()

for (const relativePath of walk(root)) {
  const normalizedPath = relativePath.split(path.sep).join('/').toLowerCase()
  for (const check of pathChecks) {
    if (!check.test(normalizedPath)) continue
    findings.push({
      file: relativePath,
      line: 1,
      check: check.name,
    })
  }

  const fullPath = path.join(root, relativePath)
  const source = fs.readFileSync(fullPath, 'utf8')
  for (const check of checks) {
    check.pattern.lastIndex = 0
    const match = check.pattern.exec(source)
    if (!match) continue
    findings.push({
      file: relativePath,
      line: lineNumber(source, match.index),
      check: check.name,
    })
  }
}

if (findings.length > 0) {
  console.error(`Found ${findings.length} open-source hygiene issue(s):`)
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.check}`)
  }
  process.exit(1)
}

console.log('No open-source hygiene issues found.')
