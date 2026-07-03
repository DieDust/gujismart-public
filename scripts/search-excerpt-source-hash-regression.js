const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const rootDir = path.resolve(__dirname, '..')

function loadSharedHelper() {
  const helperPath = path.join(rootDir, 'src', 'shared', 'search-evidence.ts')
  const source = fs.readFileSync(helperPath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const fn = new Function('module', 'exports', transpiled)
  fn(module, module.exports)
  return module.exports
}

function assert(condition, message) {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}

const { buildSearchExcerptSourceHashInput } = loadSharedHelper()
assert(
  typeof buildSearchExcerptSourceHashInput === 'function',
  'buildSearchExcerptSourceHashInput must be exported from src/shared/search-evidence.ts',
)

const hashInput = buildSearchExcerptSourceHashInput({
  docId: 'doc-search',
  pageNum: 12,
  excerpt: 'search excerpt',
})
assert(hashInput === 'doc-search:12:search excerpt', `Unexpected search excerpt hash input: ${hashInput}`)

const expectedHash = crypto.createHash('sha1').update(hashInput).digest('hex').slice(0, 16)
assert(expectedHash === 'd37dbd0922efe7af', `Unexpected SHA-1 prefix for regression fixture: ${expectedHash}`)

const searchViewPath = path.join(rootDir, 'src', 'renderer', 'src', 'views', 'SearchView.tsx')
const searchViewSource = fs.readFileSync(searchViewPath, 'utf8')
assert(
  searchViewSource.includes('buildSearchExcerptSourceHashInput'),
  'SearchView must use the shared search excerpt hash input helper.',
)
assert(
  /\.slice\(0,\s*16\)/.test(searchViewSource),
  'Manual search excerpt source_hash must use the same 16-character SHA-1 prefix as bulk saves.',
)
assert(
  /source_hash:\s*sourceHash\s*\|\|\s*undefined/.test(searchViewSource),
  'Manual search excerpt saves must pass source_hash to createResearchNote.',
)
assert(
  /paragraphHash:\s*sourceHash\s*\|\|\s*null/.test(searchViewSource),
  'Manual search excerpt saves must include paragraphHash in source_id.',
)

const searchIpcPath = path.join(rootDir, 'src', 'main', 'ipc', 'search.ts')
const searchIpcSource = fs.readFileSync(searchIpcPath, 'utf8')
assert(
  searchIpcSource.includes('buildSearchExcerptSourceHashInput'),
  'Bulk search excerpt saving must use the shared search excerpt hash input helper.',
)

const researchIpcPath = path.join(rootDir, 'src', 'main', 'ipc', 'research.ts')
const researchIpcSource = fs.readFileSync(researchIpcPath, 'utf8')
assert(
  researchIpcSource.includes('buildSearchExcerptSourceHashInput'),
  'Research note creation must use the shared search excerpt hash input helper for search-note fallbacks.',
)
assert(
  researchIpcSource.includes('function stableHashPrefix'),
  'Research note search-note fallback must preserve the same 16-character SHA-1 prefix as bulk saves.',
)

console.log('Search excerpt source-hash regression checks passed.')
