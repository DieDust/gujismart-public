/**
 * Headless GujiSmart MCP launcher (stdio).
 *
 * Important (Windows): full Electron app mode closes stdin immediately, so Codex/Cursor
 * cannot complete the MCP handshake. We run the host under ELECTRON_RUN_AS_NODE instead.
 *
 * Examples:
 *   npm run mcp -- --data-dir "/absolute/path/to/gujismart-data" --mcp-token "<token>"
 *
 * See docs/MCP.md.
 */
const { spawn } = require('child_process')
const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const hostPath = join(root, 'out', 'mcp', 'mcp-host.cjs')

function ensureHostBuilt() {
  if (existsSync(hostPath)) return
  // Lazy-build for dev / first use.
  require('./build-mcp-host.js')
}

ensureHostBuilt()

const electronPath = require('electron')
const childArgs = [hostPath, ...process.argv.slice(2)]
const child = spawn(electronPath, childArgs, {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    GUJISMART_HEADLESS: '1',
    GUJISMART_APP_PATH: root,
    // Ensure native modules resolve from the app install, not the temp bundle path.
    NODE_PATH: [join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
  },
  windowsHide: true,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code == null ? 1 : code)
})

child.on('error', (error) => {
  console.error('[gujismart-mcp] failed to start MCP host', error)
  process.exit(1)
})
