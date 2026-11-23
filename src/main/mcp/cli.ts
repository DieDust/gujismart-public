/**
 * Headless MCP entry: open the library database without a BrowserWindow.
 *
 * Usage (via scripts/gujismart-mcp.js):
 *   set GUJISMART_DATA_DIR=D:\path\to\data
 *   npm run mcp
 *
 * Or:
 *   npx electron scripts/gujismart-mcp.js --data-dir D:\path\to\data
 */
import { app } from 'electron'
import { resolve } from 'path'
import { closeDatabase, initDatabase } from '../database'
import { assertMcpTokenAllowed, parseMcpCliArgs } from './connection'
import { runMcpStdioServer } from './stdio-server'
import { runMcpDatabaseSession } from './session'

function redirectConsoleToStderr(): void {
  // MCP uses stdout for JSON-RPC; never print app logs there.
  const toErr = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`)
  }
  console.log = toErr
  console.info = toErr
  console.warn = toErr
  console.error = toErr
  console.debug = toErr
}

async function main(): Promise<void> {
  redirectConsoleToStderr()

  // Host args: mcp-host.cjs --data-dir ... --mcp-token ...
  // Also accept electron main-style --mcp for compatibility.
  const mcpArgs = parseMcpCliArgs(process.argv.slice(1))
  if (mcpArgs.dataDir) {
    process.env.GUJISMART_DATA_DIR = resolve(mcpArgs.dataDir)
  }

  // Under ELECTRON_RUN_AS_NODE the shim provides app; under full Electron disable GPU noise.
  try {
    if (typeof app.disableHardwareAcceleration === 'function') {
      app.disableHardwareAcceleration()
    }
  } catch {
    // ignore
  }

  await app.whenReady()

  const devBypass = process.env.GUJISMART_MCP_DEV === '1' && !app.isPackaged
  await runMcpDatabaseSession({
    runTransport: runMcpStdioServer,
    checkCredentialsPresent: () => {
      if (!mcpArgs.token?.trim() && !devBypass) {
        throw new Error('AI 工具连接令牌无效。请在软件设置中重新复制配置到你的 AI 客户端。')
      }
    },
    openDatabase: initDatabase,
    authorize: () => {
      if (devBypass) return
      assertMcpTokenAllowed(mcpArgs.token)
    },
    prepareAuthorizedTools: () => {},
    closeDatabase: () => closeDatabase({ checkpoint: false }),
  })
}

main().then(
  () => app.exit(0),
  (error: unknown) => {
    process.stderr.write(`[gujismart-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  },
)
