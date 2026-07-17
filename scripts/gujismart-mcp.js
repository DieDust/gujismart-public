/**
 * Headless GujiSmart MCP launcher (no UI window).
 *
 * Examples (use YOUR machine paths, not a fixed drive letter):
 *   npm run mcp -- --data-dir "/absolute/path/to/gujismart-data"
 *   GUJISMART_DATA_DIR=/absolute/path/to/data npm run mcp
 *
 * Wire this into Cursor / Claude Desktop / Trae as an MCP server command.
 * See docs/MCP.md.
 */
const { spawn } = require('child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { buildSync } = require('esbuild')
const electronPath = require('electron')

const root = join(__dirname, '..')
const tempRoot = mkdtempSync(join(tmpdir(), 'gujismart-mcp-'))
const entryPath = join(tempRoot, 'mcp-entry.js')
const bundlePath = join(tempRoot, 'mcp-bundle.cjs')

writeFileSync(
  entryPath,
  `require(${JSON.stringify(join(root, 'src', 'main', 'mcp', 'cli.ts'))})\n`,
)

try {
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['electron', 'better-sqlite3', '@napi-rs/canvas', 'playwright'],
    alias: {
      '@electron-toolkit/utils': join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
    },
    logLevel: 'silent',
  })
} catch (error) {
  console.error('[gujismart-mcp] bundle failed', error)
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(1)
}

const childArgs = [bundlePath, ...process.argv.slice(2)]
const child = spawn(electronPath, childArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    GUJISMART_HEADLESS: '1',
  },
  windowsHide: true,
})

const cleanup = () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

child.on('exit', (code, signal) => {
  cleanup()
  if (signal) process.kill(process.pid, signal)
  process.exit(code == null ? 1 : code)
})

child.on('error', (error) => {
  console.error('[gujismart-mcp] failed to start electron', error)
  cleanup()
  process.exit(1)
})
