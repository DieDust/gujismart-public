const assert = require('assert')
const { readFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

const tools = read('src', 'main', 'mcp', 'library-tools.ts')
const server = read('src', 'main', 'mcp', 'stdio-server.ts')
const cli = read('src', 'main', 'mcp', 'cli.ts')
const connection = read('src', 'main', 'mcp', 'connection.ts')
const mainIndex = read('src', 'main', 'index.ts')
const settingsIpc = read('src', 'main', 'ipc', 'settings.ts')
const preload = read('src', 'preload', 'index.ts')
const settingsView = read('src', 'renderer', 'src', 'views', 'SettingsView.tsx')
const launcher = read('scripts', 'gujismart-mcp.js')
const docs = read('docs', 'MCP.md')
const packageJson = JSON.parse(read('package.json'))

const requiredTools = [
  'library_search',
  'list_documents',
  'get_document',
  'get_page_text',
  'resolve_evidence',
  'list_folders',
  'list_tags',
  'library_stats',
]

for (const name of requiredTools) {
  assert.ok(tools.includes(`name: '${name}'`), `MCP tool definition missing: ${name}`)
  assert.ok(tools.includes(`case '${name}':`), `MCP tool handler missing: ${name}`)
}

assert.ok(tools.includes('querySearchV2'), 'library_search must use querySearchV2 (same engine as UI)')
assert.ok(tools.includes('listDocumentsPage'), 'list_documents must use listDocumentsPage')
assert.ok(tools.includes('resolveSearchEvidence'), 'resolve_evidence must use resolveSearchEvidence')
assert.ok(tools.includes('resolveCanonicalPageContent'), 'get_page_text must use canonical content')
assert.ok(tools.includes('has_local_file'), 'responses should not dump absolute file paths as content')
assert.ok(!tools.includes('readProtectedSetting'), 'MCP tools must never read credential vault')
assert.ok(!tools.includes('writeProtectedSetting'), 'MCP tools must never write credentials')

assert.ok(server.includes('tools/list') && server.includes('tools/call'), 'stdio server must implement MCP tools methods')
assert.ok(server.includes('Content-Length'), 'stdio server should support Content-Length framing')
assert.ok(cli.includes('initDatabase') && cli.includes('runMcpStdioServer'), 'CLI must open DB then serve MCP')
assert.ok(cli.includes('redirectConsoleToStderr') || cli.includes('stderr'), 'logs must not go to stdout')
assert.ok(launcher.includes('esbuild') && launcher.includes('electron'), 'launcher should bundle and run under Electron')

assert.ok(docs.includes('一键复制') || docs.includes('小白'), 'user docs should describe beginner one-click flow')
assert.ok(docs.includes('library_search'), 'docs should list tools')
assert.strictEqual(packageJson.scripts.mcp, 'node scripts/gujismart-mcp.js', 'package.json mcp script')
assert.ok(String(packageJson.scripts['check:mcp'] || '').includes('mcp-tools-regression'), 'check:mcp script')

assert.ok(connection.includes('getMcpSetupInfo') && connection.includes('mcpServers'), 'connection helper builds pasteable MCP JSON')
assert.ok(connection.includes('assertMcpTokenAllowed'), 'MCP mode must validate token when enabled')
assert.ok(mainIndex.includes('mcpLaunch.isMcp') && mainIndex.includes('runMcpStdioServer'), 'main process must support --mcp headless mode')
assert.ok(settingsIpc.includes("settings:mcp:getSetup") && settingsIpc.includes("settings:mcp:setEnabled"), 'settings IPC for MCP')
assert.ok(preload.includes('getMcpSetupInfo') && preload.includes('setMcpAgentEnabled'), 'preload MCP APIs')
assert.ok(settingsView.includes('AI 工具连接') && settingsView.includes('一键写入 Codex'), 'settings UI for beginners + Codex')
assert.ok(settingsView.includes('handleCopyMcpConfig') && settingsView.includes('handleWriteCodexConfig'), 'settings UI can copy/write config')
assert.ok(connection.includes('writeCodexMcpConfig') && connection.includes('.codex'), 'can write ~/.codex/config.toml')
assert.ok(settingsIpc.includes('settings:mcp:writeCodexConfig'), 'settings IPC writeCodexConfig')
assert.ok(preload.includes('writeCodexMcpConfig'), 'preload writeCodexMcpConfig')

console.log('MCP tools regression checks passed.')
