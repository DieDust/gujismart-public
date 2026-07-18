import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { McpCodexFormFields, McpSetupInfo, McpWriteCodexResult } from '../../shared/types'
import { getDataDir, queryOne, run, saveDatabase } from '../database'

export const MCP_ENABLED_SETTING_KEY = 'mcp_agent_enabled'
export const MCP_TOKEN_SETTING_KEY = 'mcp_agent_token'
const MCP_SERVER_NAME = 'gujismart'

function readSetting(key: string): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || '').trim()
}

function writeSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}

export function isMcpAgentEnabled(): boolean {
  return readSetting(MCP_ENABLED_SETTING_KEY) === 'true'
}

export function setMcpAgentEnabled(enabled: boolean): void {
  writeSetting(MCP_ENABLED_SETTING_KEY, enabled ? 'true' : 'false')
  if (enabled) ensureMcpAgentToken()
  saveDatabase()
}

export function ensureMcpAgentToken(): string {
  const existing = readSetting(MCP_TOKEN_SETTING_KEY)
  if (existing && existing.length >= 16) return existing
  const token = randomBytes(24).toString('hex')
  writeSetting(MCP_TOKEN_SETTING_KEY, token)
  saveDatabase()
  return token
}

export function rotateMcpAgentToken(): string {
  const token = randomBytes(24).toString('hex')
  writeSetting(MCP_TOKEN_SETTING_KEY, token)
  saveDatabase()
  return token
}

export function getStoredMcpAgentToken(): string {
  return readSetting(MCP_TOKEN_SETTING_KEY)
}

export function assertMcpTokenAllowed(provided: string | null | undefined): void {
  if (!isMcpAgentEnabled()) {
    throw new Error('未在软件设置中开启「允许 AI 工具访问文献库」。请打开文献管理 → 设置 → AI 工具连接，打开开关后再试。')
  }
  const expected = getStoredMcpAgentToken()
  const got = String(provided || '').trim()
  if (process.env.GUJISMART_MCP_DEV === '1' && !app.isPackaged) return
  if (!expected || got !== expected) {
    throw new Error('AI 工具连接令牌无效。请在软件设置中重新复制配置到你的 AI 客户端。')
  }
}

/**
 * Resolve the MCP host script path.
 * Host runs under ELECTRON_RUN_AS_NODE so Windows clients keep a working stdin pipe.
 * (Full Electron app mode closes stdin immediately → Codex reconnects forever.)
 */
function resolveMcpHostScriptPath(packaged: boolean): string {
  if (packaged) {
    // electron-builder extraResources → process.resourcesPath/mcp/mcp-host.cjs
    return join(process.resourcesPath, 'mcp', 'mcp-host.cjs')
  }
  // Dev: prefer built host; settings write will still point at absolute path.
  return join(app.getAppPath(), 'out', 'mcp', 'mcp-host.cjs')
}

function ensureDevMcpHostBuilt(hostPath: string): void {
  if (existsSync(hostPath)) return
  try {
    // Lazy build when user clicks “write Codex config” before `npm run build`.
    const buildScript = join(app.getAppPath(), 'scripts', 'build-mcp-host.js')
    if (!existsSync(buildScript)) {
      throw new Error(`missing ${buildScript}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(buildScript)
  } catch (error) {
    process.stderr.write(
      `[gujismart-mcp] failed to build MCP host: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/** Build launch argv for AI clients (stdio MCP). */
export function getMcpLaunchSpec(token?: string): {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  dataDir: string
  execPath: string
  packaged: boolean
  hostScript: string
} {
  const dataDir = getDataDir()
  const mcpToken = token || ensureMcpAgentToken()
  const packaged = app.isPackaged
  const execPath = process.execPath
  const appPath = packaged ? '' : app.getAppPath()
  const hostScript = resolveMcpHostScriptPath(packaged)
  if (!packaged) ensureDevMcpHostBuilt(hostScript)

  // ELECTRON_RUN_AS_NODE: run host as Node under Electron binary (keeps better-sqlite3 ABI + stdin).
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    GUJISMART_HEADLESS: '1',
  }
  if (packaged) {
    env.GUJISMART_MCP_PACKAGED = '1'
  } else {
    env.GUJISMART_APP_PATH = appPath
    env.NODE_PATH = join(appPath, 'node_modules')
  }

  return {
    command: execPath,
    args: [hostScript, '--data-dir', dataDir, '--mcp-token', mcpToken],
    cwd: packaged ? undefined : appPath,
    env,
    dataDir,
    execPath,
    packaged,
    hostScript,
  }
}

function escapeTomlString(value: string): string {
  return JSON.stringify(String(value || ''))
}

function buildMcpServersJson(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): string {
  const server: Record<string, unknown> = {
    command,
    args,
  }
  if (cwd) server.cwd = cwd
  if (Object.keys(env).length > 0) server.env = env
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: server,
      },
    },
    null,
    2,
  )
}

function buildCodexToml(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): string {
  const lines = [
    `# GujiSmart MCP — auto-generated. Do not hand-edit paths unless you moved the app.`,
    `# Uses ELECTRON_RUN_AS_NODE so Windows keeps stdin open for MCP framing.`,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${escapeTomlString(command)}`,
    `args = [${args.map((arg) => escapeTomlString(arg)).join(', ')}]`,
  ]
  if (cwd) lines.push(`cwd = ${escapeTomlString(cwd)}`)
  if (Object.keys(env).length > 0) {
    lines.push(`[mcp_servers.${MCP_SERVER_NAME}.env]`)
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${key} = ${escapeTomlString(value)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function buildCodexFormText(form: McpCodexFormFields): string {
  const envLines = (form.env || [])
    .filter((row) => row.key)
    .map((row) => `  ${row.key} ＝ ${row.value}`)
  return [
    '【Codex「连接至自定义 MCP」——哪一行填什么】',
    '',
    `名称　　　　＝ ${form.name}`,
    '类型　　　　＝ STDIO（不要选「流式 HTTP」）',
    `启动命令　　＝ ${form.command}`,
    form.cwd ? `工作目录　　＝ ${form.cwd}` : '工作目录　　＝ （留空）',
    envLines.length > 0
      ? ['环境变量　　＝ 需要添加：', ...envLines].join('\n')
      : '环境变量　　＝ （留空）',
    '环境变量传递＝ （留空）',
    '',
    '参数（有几行就「+ 添加参数」几次，每框只贴一行）：',
    ...form.args.map((arg, index) => `  参数 ${index + 1} ＝ ${arg}`),
    '',
    '更省事：在文献管理 → 设置 → AI 工具连接 → 选 Codex →「一键写入 Codex 配置」，然后重启 Codex。',
  ].join('\n')
}

function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

/**
 * Merge/replace [mcp_servers.gujismart] in ~/.codex/config.toml so Codex picks it up
 * without the user filling the complex form field-by-field.
 */
export function writeCodexMcpConfig(): McpWriteCodexResult {
  setMcpAgentEnabled(true)
  const launch = getMcpLaunchSpec()
  if (!existsSync(launch.hostScript)) {
    return {
      ok: false,
      path: launch.hostScript,
      message: `MCP 宿主文件不存在：${launch.hostScript}。请先执行 npm run build 或 npm run build:mcp-host 后再试。`,
    }
  }
  const fragment = buildCodexToml(launch.command, launch.args, launch.cwd, launch.env)
  const configPath = getCodexConfigPath()
  const dir = join(homedir(), '.codex')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let existing = ''
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, 'utf8')
  }

  const sectionHeader = `[mcp_servers.${MCP_SERVER_NAME}]`
  const envHeader = `[mcp_servers.${MCP_SERVER_NAME}.env]`
  // Remove previous gujismart MCP block (header/env through next [section] or EOF).
  const cleaned = existing
    .replace(
      new RegExp(
        `\\r?\\n*# GujiSmart MCP[\\s\\S]*?(?=\\r?\\n\\[|$)` +
        `|\\r?\\n*\\[mcp_servers\\.${MCP_SERVER_NAME}(?:\\.env)?\\][\\s\\S]*?(?=\\r?\\n\\[|$)`,
        'g',
      ),
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()

  // Also strip any leftover bare section without our comment
  let body = cleaned
  if (body.includes(sectionHeader) || body.includes(envHeader)) {
    body = body
      .replace(new RegExp(`\\r?\\n*\\[mcp_servers\\.${MCP_SERVER_NAME}(?:\\.env)?\\][\\s\\S]*?(?=\\r?\\n\\[|$)`, 'g'), '\n')
      .trimEnd()
  }

  const next = body
    ? `${body}\n\n${fragment}`
    : fragment

  writeFileSync(configPath, `${next.trimEnd()}\n`, 'utf8')
  return {
    ok: true,
    path: configPath,
    message: `已写入 Codex 配置：${configPath}。请完全退出并重新打开 Codex，然后在对话里直接问文献库问题（不必在左侧「插件」列表里找）。`,
  }
}

export function getMcpSetupInfo(): McpSetupInfo {
  const enabled = isMcpAgentEnabled()
  const token = ensureMcpAgentToken()
  const launch = getMcpLaunchSpec(token)
  const envEntries = Object.entries(launch.env).map(([key, value]) => ({ key, value }))
  const codexForm: McpCodexFormFields = {
    name: MCP_SERVER_NAME,
    type: 'STDIO',
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd || '',
    env: envEntries,
  }
  const cursorJson = buildMcpServersJson(launch.command, launch.args, launch.cwd, launch.env)
  const codexToml = buildCodexToml(launch.command, launch.args, launch.cwd, launch.env)
  const codexFormText = buildCodexFormText(codexForm)

  return {
    enabled,
    dataDir: launch.dataDir,
    execPath: launch.execPath,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    token,
    tokenPreview: token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : '****',
    packaged: launch.packaged,
    codexForm,
    configs: {
      cursorJson,
      claudeJson: cursorJson,
      genericJson: cursorJson,
      codexFormText,
      codexToml,
      beginnerSteps: [
        '1. 打开「允许 AI 工具访问文献库」。',
        '2. 在设置页选择你的 AI 客户端（Trae / Cursor / Claude / Codex / 其他）。',
        '3. Trae、Cursor、Claude：复制 MCP 配置 JSON，粘贴到对应客户端的 MCP 设置。',
        '4. Codex：点「一键写入 Codex 配置」，或按表单对照填写（类型选 STDIO；环境变量需含 ELECTRON_RUN_AS_NODE=1）。',
        '5. 重启对应 AI 客户端后，直接问文献库问题；不必自己找盘符。',
      ],
    },
  }
}

export function parseMcpCliArgs(argv: string[]): {
  isMcp: boolean
  dataDir: string | null
  token: string | null
} {
  let isMcp = false
  let dataDir: string | null = null
  let token: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mcp' || arg === '--gujismart-mcp') isMcp = true
    if (arg === '--data-dir' || arg === '--dataDir') dataDir = argv[i + 1] || null
    if (arg.startsWith('--data-dir=')) dataDir = arg.slice('--data-dir='.length)
    if (arg === '--mcp-token' || arg === '--mcpToken') token = argv[i + 1] || null
    if (arg.startsWith('--mcp-token=')) token = arg.slice('--mcp-token='.length)
  }
  if (process.env.GUJISMART_MCP === '1') isMcp = true
  if (!dataDir && process.env.GUJISMART_DATA_DIR) dataDir = process.env.GUJISMART_DATA_DIR
  if (!token && process.env.GUJISMART_MCP_TOKEN) token = process.env.GUJISMART_MCP_TOKEN
  return { isMcp, dataDir, token }
}
