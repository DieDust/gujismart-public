const assert = require('assert')
const { existsSync, readFileSync } = require('fs')
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
  'vector_search',
  'vector_index_stats',
]

for (const name of requiredTools) {
  assert.ok(tools.includes(`name: '${name}'`), `MCP tool definition missing: ${name}`)
  assert.ok(tools.includes(`case '${name}':`), `MCP tool handler missing: ${name}`)
}

assert.ok(tools.includes('querySearchV2'), 'library_search must use querySearchV2 (same engine as UI)')
assert.ok(tools.includes('listDocumentsPage'), 'list_documents must use listDocumentsPage')
assert.ok(tools.includes('resolveSearchEvidence'), 'resolve_evidence must use resolveSearchEvidence')
assert.ok(tools.includes('resolveCanonicalPageContent'), 'get_page_text must use canonical content')
assert.ok(tools.includes('vectorSearch') || tools.includes('vector_search'), 'vector_search tool must exist')
assert.ok(tools.includes('getEmbeddingIndexStats') || tools.includes('vector_index_stats'), 'vector_index_stats tool must exist')
assert.ok(tools.includes('hasLocalFile') || tools.includes('has_local_file'), 'responses should not dump absolute file paths as content')
assert.ok(tools.includes("detail: 'full'") || tools.includes('isFullDetail') || tools.includes("detail:\"full\""), 'MCP tools support compact/full detail modes')
assert.ok(tools.includes('compactHitRef') || tools.includes('ref:'), 'search hits should expose compact ref for follow-up reads')
assert.ok(!tools.includes('readProtectedSetting'), 'MCP tools must never read credential vault')
assert.ok(!tools.includes('writeProtectedSetting'), 'MCP tools must never write credentials')

assert.ok(server.includes('tools/list') && server.includes('tools/call'), 'stdio server must implement MCP tools methods')
assert.ok(server.includes('Content-Length'), 'stdio server should support Content-Length framing')
assert.ok(server.includes('JSON.stringify(result)'), 'tool results should use compact JSON text (no pretty-print)')
assert.ok(cli.includes('initDatabase') && cli.includes('runMcpStdioServer'), 'CLI must open DB then serve MCP')
assert.ok(cli.includes('redirectConsoleToStderr') || cli.includes('stderr'), 'logs must not go to stdout')
assert.ok(launcher.includes('build-mcp-host') || launcher.includes('mcp-host.cjs'), 'launcher should use MCP host bundle')
assert.ok(launcher.includes('electron') || launcher.includes('ELECTRON_RUN_AS_NODE'), 'launcher should run under Electron/Node host')

assert.ok(docs.includes('小白') || docs.includes('AI 客户端'), 'user docs should describe beginner multi-client flow')
assert.ok(docs.includes('Trae') && docs.includes('library_search'), 'docs should cover Trae and list tools')
assert.strictEqual(packageJson.scripts.mcp, 'node scripts/gujismart-mcp.js', 'package.json mcp script')
assert.ok(String(packageJson.scripts['check:mcp'] || '').includes('mcp-tools-regression'), 'check:mcp script')

assert.ok(connection.includes('getMcpSetupInfo') && connection.includes('mcpServers'), 'connection helper builds pasteable MCP JSON')
assert.ok(connection.includes('assertMcpTokenAllowed'), 'MCP mode must validate token when enabled')
assert.ok(mainIndex.includes('mcpLaunch.isMcp') && mainIndex.includes('runMcpStdioServer'), 'main process must support --mcp headless mode')
assert.ok(settingsIpc.includes("settings:mcp:getSetup") && settingsIpc.includes("settings:mcp:setEnabled"), 'settings IPC for MCP')
assert.ok(preload.includes('getMcpSetupInfo') && preload.includes('setMcpAgentEnabled'), 'preload MCP APIs')
assert.ok(settingsView.includes('AI 工具连接') && settingsView.includes('mcpClientId'), 'settings UI for multi-client MCP setup')
assert.ok(settingsView.includes("id: 'trae'") && settingsView.includes("id: 'codex'"), 'settings UI lists Trae and Codex among clients')
assert.ok(settingsView.includes('Segmented') && settingsView.includes('handleCopyMcpConfig'), 'settings UI can switch clients and copy JSON')
assert.ok(settingsView.includes('handleWriteCodexConfig') && settingsView.includes('一键写入 Codex'), 'Codex one-click write remains available')
assert.ok(connection.includes('writeCodexMcpConfig') && connection.includes('.codex'), 'can write ~/.codex/config.toml')
assert.ok(connection.includes('ELECTRON_RUN_AS_NODE'), 'launch spec must set ELECTRON_RUN_AS_NODE for Windows stdin')
assert.ok(connection.includes('mcp-host.cjs') || connection.includes('mcp-host'), 'launch spec must use MCP host script')
assert.ok(settingsIpc.includes('settings:mcp:writeCodexConfig'), 'settings IPC writeCodexConfig')
assert.ok(preload.includes('writeCodexMcpConfig'), 'preload writeCodexMcpConfig')
assert.ok(launcher.includes('ELECTRON_RUN_AS_NODE'), 'npm mcp launcher must use ELECTRON_RUN_AS_NODE')
assert.ok(existsSync(join(root, 'scripts', 'build-mcp-host.js')), 'build-mcp-host script present')
assert.ok(existsSync(join(root, 'scripts', 'stubs', 'electron-app-shim.js')), 'electron app shim for MCP host')

console.log('MCP tools regression checks passed.')
