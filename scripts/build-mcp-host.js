/**
 * Build a standalone MCP host bundle for ELECTRON_RUN_AS_NODE.
 * Output: out/mcp/mcp-host.cjs (also usable from packaged resources).
 */
const { buildSync } = require('esbuild')
const { mkdirSync, existsSync, writeFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const outDir = join(root, 'out', 'mcp')
const entryPath = join(outDir, 'mcp-host-entry.js')
const outfile = join(outDir, 'mcp-host.cjs')

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

writeFileSync(
  entryPath,
  `require(${JSON.stringify(join(root, 'src', 'main', 'mcp', 'cli.ts'))})\n`,
)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['better-sqlite3', '@napi-rs/canvas', 'playwright'],
  alias: {
    electron: join(root, 'scripts', 'stubs', 'electron-app-shim.js'),
    '@electron-toolkit/utils': join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

console.log(`MCP host built: ${outfile}`)
