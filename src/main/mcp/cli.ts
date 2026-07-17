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
import { initializeSettingsSecurity } from '../settings-security'
import { assertMcpTokenAllowed, parseMcpCliArgs } from './connection'
import { runMcpStdioServer } from './stdio-server'

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

  const mcpArgs = parseMcpCliArgs(process.argv.slice(1))
  if (mcpArgs.dataDir) {
    process.env.GUJISMART_DATA_DIR = resolve(mcpArgs.dataDir)
  }

  // Disable GPU / single-instance noise for headless.
  app.disableHardwareAcceleration()

  await app.whenReady()

  try {
    initializeSettingsSecurity()
  } catch (error) {
    process.stderr.write(`[gujismart-mcp] settings security init skipped: ${error}\n`)
  }

  await initDatabase()
  // End-user configs always carry a token. Local npm debugging can set GUJISMART_MCP_DEV=1.
  if (mcpArgs.token || process.env.GUJISMART_MCP_DEV !== '1') {
    try {
      assertMcpTokenAllowed(mcpArgs.token)
    } catch (error) {
      // Dev convenience: allow open data-dir without settings when explicitly opted in.
      if (process.env.GUJISMART_MCP_DEV === '1') {
        process.stderr.write(`[gujismart-mcp] warning: ${error instanceof Error ? error.message : String(error)}\n`)
      } else {
        throw error
      }
    }
  }
  process.stderr.write(
    `[gujismart-mcp] database ready (dataDir=${process.env.GUJISMART_DATA_DIR || '(default)'})\n`,
  )

  const shutdown = () => {
    try {
      closeDatabase()
    } catch {
      // ignore
    }
    app.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await runMcpStdioServer()
}

main().catch((error) => {
  process.stderr.write(`[gujismart-mcp] fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  try {
    closeDatabase()
  } catch {
    // ignore
  }
  app.exit(1)
})
