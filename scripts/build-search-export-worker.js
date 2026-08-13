const fs = require('fs')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')

function buildSearchExportWorker(options = {}) {
  const outfile = path.resolve(options.outfile || path.join(root, 'out', 'main', 'search-export-query-worker.js'))
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'search-export-query-worker.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['@napi-rs/canvas', 'better-sqlite3', 'flexsearch'],
    alias: {
      electron: path.join(__dirname, 'stubs', 'electron-worker.js'),
    },
    logLevel: options.logLevel || 'info',
  })

  const source = fs.readFileSync(outfile, 'utf8')
  if (/require\(["']electron["']\)/.test(source)) {
    throw new Error('Search export worker build still contains a runtime Electron dependency')
  }
  return outfile
}

if (require.main === module) {
  const outfile = buildSearchExportWorker()
  console.log(`Search export worker built: ${outfile}`)
}

module.exports = { buildSearchExportWorker }
