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

/** Build launch argv for AI clients (stdio MCP). */
export function getMcpLaunchSpec(token?: string): {
  command: string
  args: string[]
  cwd?: string
  dataDir: string
  execPath: string
  packaged: boolean
} {
  const dataDir = getDataDir()
  const mcpToken = token || ensureMcpAgentToken()
  const packaged = app.isPackaged
  const execPath = process.execPath
  const common = ['--mcp', '--data-dir', dataDir, '--mcp-token', mcpToken]

  if (packaged) {
    return {
      command: execPath,
      args: common,
      dataDir,
      execPath,
      packaged,
    }
  }

  const appPath = app.getAppPath()
  return {
    command: execPath,
    args: ['.', ...common],
    cwd: appPath,
    dataDir,
    execPath,
    packaged,
  }
}

function escapeTomlString(value: string): string {
  return JSON.stringify(String(value || ''))
}

function buildMcpServersJson(command: string, args: string[], cwd?: string): string {
  const server: Record<string, unknown> = {
    command,
    args,
  }
  if (cwd) server.cwd = cwd
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

function buildCodexToml(command: string, args: string[], cwd?: string): string {
  const lines = [
    `# GujiSmart MCP — auto-generated. Do not hand-edit paths unless you moved the app.`,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${escapeTomlString(command)}`,
    `args = [${args.map((arg) => escapeTomlString(arg)).join(', ')}]`,
  ]
  if (cwd) lines.push(`cwd = ${escapeTomlString(cwd)}`)
  return `${lines.join('\n')}\n`
}

function buildCodexFormText(form: McpCodexFormFields): string {
  return [
    '【Codex「连接至自定义 MCP」——哪一行填什么】',
    '',
    `名称　　　　＝ ${form.name}`,
    '类型　　　　＝ STDIO（不要选「流式 HTTP」）',
    `启动命令　　＝ ${form.command}`,
    form.cwd ? `工作目录　　＝ ${form.cwd}` : '工作目录　　＝ （留空）',
    '环境变量　　＝ （留空，不要点添加）',
    '环境变量传递＝ （留空）',
    '',
    '参数（有几行就「+ 添加参数」几次，每框只贴一行）：',
    ...form.args.map((arg, index) => `  参数 ${index + 1} ＝ ${arg}`),
    '',
    '更省事：在文献管理 → 设置 → AI 工具连接 →「一键写入 Codex 配置」，然后重启 Codex。',
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
  const fragment = buildCodexToml(launch.command, launch.args, launch.cwd)
  const configPath = getCodexConfigPath()
  const dir = join(homedir(), '.codex')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let existing = ''
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, 'utf8')
  }

  const sectionHeader = `[mcp_servers.${MCP_SERVER_NAME}]`
  // Remove previous gujismart MCP block (header through next [section] or EOF).
  const cleaned = existing
    .replace(
      new RegExp(
        `\\r?\\n*# GujiSmart MCP[\\s\\S]*?(?=\\r?\\n\\[|$)` +
        `|\\r?\\n*\\[mcp_servers\\.${MCP_SERVER_NAME}\\][\\s\\S]*?(?=\\r?\\n\\[|$)`,
        'g',
      ),
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()

  // Also strip any leftover bare section without our comment
  let body = cleaned
  if (body.includes(sectionHeader)) {
    body = body
      .replace(new RegExp(`\\r?\\n*\\[mcp_servers\\.${MCP_SERVER_NAME}\\][\\s\\S]*?(?=\\r?\\n\\[|$)`, 'g'), '\n')
      .trimEnd()
  }

  const next = body
    ? `${body}\n\n${fragment}`
    : fragment

  writeFileSync(configPath, `${next.trimEnd()}\n`, 'utf8')
  return {
    ok: true,
    path: configPath,
    message: `已写入 Codex 配置：${configPath}。请完全退出并重新打开 Codex，即可在工具列表中看到 gujismart。`,
  }
}

export function getMcpSetupInfo(): McpSetupInfo {
  const enabled = isMcpAgentEnabled()
  const token = ensureMcpAgentToken()
  const launch = getMcpLaunchSpec(token)
  const codexForm: McpCodexFormFields = {
    name: MCP_SERVER_NAME,
    type: 'STDIO',
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd || '',
    env: [],
  }
  const cursorJson = buildMcpServersJson(launch.command, launch.args, launch.cwd)
  const codexToml = buildCodexToml(launch.command, launch.args, launch.cwd)
  const codexFormText = buildCodexFormText(codexForm)

  return {
    enabled,
    dataDir: launch.dataDir,
    execPath: launch.execPath,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
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
        '4. Codex：点「一键写入 Codex 配置」，或按表单对照填写（类型选 STDIO）。',
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
