import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Form, Input, Select, Card, Button, Typography, message, Switch, Slider, InputNumber, Alert, Space, Tag, Popconfirm, List, AutoComplete, Modal, Tooltip, Progress, Segmented } from 'antd'
import {
  BookOutlined,
  KeyOutlined,
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GithubOutlined,
  PlusOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  LinkOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { DEFAULT_SHORTCUTS, SHORTCUT_SETTING_KEYS, SHORTCUTS_CHANGED_EVENT, normalizeShortcutInput, shortcutFromKeyboardEvent, type ShortcutAction } from '../utils/shortcuts'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'
import { getErrorMessage } from '@shared/errors'
import { PRODUCT_FULL_NAME, PRODUCT_NAME, PRODUCT_SUBTITLE, type AppUpdateInfo, type BackupStatus, type BackgroundTaskProgressEvent, type DatabaseStorageDiagnostics, type EmbeddingIndexStats, type LlmProviderProfile, type LocalPaddleOcrDownloadProgress, type LocalPaddleOcrStatus, type McpSetupInfo, type OcrEngine, type PaddleOcrTokenPoolState, type PdfRepositoryStatus, type ResearchProject, type TranslationGlossaryScope, type TranslationGlossaryTerm } from '@shared/types'

const { Title, Text } = Typography

/** AI 客户端：国内默认 Trae，可在设置页切换。 */
type McpClientId = 'trae' | 'cursor' | 'claude' | 'codex' | 'other'

const MCP_CLIENT_OPTIONS: Array<{
  id: McpClientId
  label: string
  hint: string
  steps: string[]
  /** 主按钮：复制 JSON / Codex 一键写入 */
  mode: 'json' | 'codex'
}> = [
  {
    id: 'trae',
    label: 'Trae',
    hint: '国内常用 · 粘贴 JSON 到 MCP 设置',
    mode: 'json',
    steps: [
      '打开上面的「允许 AI 工具访问文献库」。',
      '点「复制 MCP 配置 JSON」。',
      '打开 Trae → 设置 → MCP，添加或编辑服务器，把 JSON 粘贴进去（名称 gujismart，类型 STDIO）。',
      '保存后重启 Trae（或按软件提示刷新 MCP），再在对话里问文献库问题。',
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    hint: '粘贴 JSON 到 MCP Servers',
    mode: 'json',
    steps: [
      '打开上面的「允许 AI 工具访问文献库」。',
      '点「复制 MCP 配置 JSON」。',
      '打开 Cursor → Settings → MCP → Add new MCP server / 编辑配置文件，粘贴 JSON。',
      '保存后重启 Cursor 或刷新 MCP，再在对话里使用。',
    ],
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'Claude 桌面版 · JSON',
    mode: 'json',
    steps: [
      '打开上面的「允许 AI 工具访问文献库」。',
      '点「复制 MCP 配置 JSON」。',
      '打开 Claude 桌面版的 MCP / 本地工具配置，粘贴 JSON（与 Cursor 同结构）。',
      '保存并重启 Claude 桌面版后再试。',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    hint: '一键写入配置或对照表单',
    mode: 'codex',
    steps: [
      '打开上面的「允许 AI 工具访问文献库」。',
      '点「一键写入 Codex 配置」（推荐），或按下方对照表手填。',
      '完全退出并重新打开 Codex。',
      '若只能用「连接至自定义 MCP」表单：类型选 STDIO，按对照表逐项粘贴。',
    ],
  },
  {
    id: 'other',
    label: '其他',
    hint: '通用 STDIO / JSON',
    mode: 'json',
    steps: [
      '打开上面的「允许 AI 工具访问文献库」。',
      '点「复制 MCP 配置 JSON」。',
      '在你的 AI 客户端里添加 STDIO 类型 MCP 服务器，粘贴 JSON；或按 command / args 手填。',
      '保存并重启客户端后再试。网页版、不支持 MCP 的 AI 无法使用。',
    ],
  },
]

const MCP_CLIENT_SEGMENTED_OPTIONS = MCP_CLIENT_OPTIONS.map((item) => ({
  label: item.label,
  value: item.id,
}))

type SettingsSectionKey =
  | 'automation'
  | 'shortcuts'
  | 'pdfRepository'
  | 'batch'
  | 'data'
  | 'ocr'
  | 'paddleOcr'
  | 'visionOcr'
  | 'ai'
  | 'aiTools'
  | 'embedding'
  | 'glossary'
  | 'about'

const SETTINGS_SECTIONS: Array<{ key: SettingsSectionKey; label: string; icon: ReactNode }> = [
  { key: 'automation', label: '自动化', icon: <ThunderboltOutlined /> },
  { key: 'shortcuts', label: '快捷键', icon: <KeyOutlined /> },
  { key: 'pdfRepository', label: 'PDF 原件仓库', icon: <FolderOpenOutlined /> },
  { key: 'batch', label: '批量处理', icon: <SettingOutlined /> },
  { key: 'data', label: '数据管理', icon: <DatabaseOutlined /> },
  { key: 'ocr', label: 'OCR', icon: <ApiOutlined /> },
  { key: 'ai', label: 'AI', icon: <ApiOutlined /> },
  { key: 'embedding', label: '向量索引', icon: <ThunderboltOutlined /> },
  { key: 'aiTools', label: 'AI 工具连接', icon: <LinkOutlined /> },
  { key: 'glossary', label: '翻译术语表', icon: <BookOutlined /> },
  { key: 'about', label: '关于与版权', icon: <GithubOutlined /> },
]

const PRESET_ENDPOINTS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4-flash', 'glm-4-plus'] },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus'] },
  { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-128k'] },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  { name: 'VolcEngine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-vision-pro', 'doubao-seed-1-6-vision', 'doubao-seed-1-6', 'doubao-seed-1-6-thinking', 'doubao-1-5-vision-pro', 'doubao-1-5-thinking-vision-pro'] },
  {
    name: 'Volc Coding Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite', 'deepseek-v3.2', 'glm-4.7', 'glm-4-7', 'kimi-k2.5', 'kimi-k2-5', 'gpt-oss-120b'],
  },
]

/** Embeddings 服务商预设：默认通义；不含 DeepSeek（无向量模型） */
const EMBEDDING_PROVIDER_PRESETS = [
  {
    name: '通义千问',
    // 百炼 OpenAI 兼容：https://dashscope.aliyuncs.com/compatible-mode/v1
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 官方模型与批次：v3/v4=10，v2/v1=25，qwen3.7=20（切换模型会自动限流）
    models: ['text-embedding-v4', 'text-embedding-v3', 'qwen3.7-text-embedding', 'text-embedding-v2', 'text-embedding-v1'],
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'netease-youdao/bce-embedding-base_v1'],
  },
  {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['embedding-3', 'embedding-2'],
  },
]
const DEFAULT_EMBEDDING_PROVIDER = EMBEDDING_PROVIDER_PRESETS[0]

const VISION_PRESET_ENDPOINTS = [
  {
    name: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260428',
      'doubao-seed-2-0-mini-260428',
      'doubao-seed-2-0-lite-260215',
      'doubao-seed-2-0-mini-260215',
    ],
  },
]

const AI_PROVIDER_PRESETS = PRESET_ENDPOINTS.filter((preset, index, presets) => {
  return presets.findIndex((item) => item.baseUrl === preset.baseUrl) === index
})

const VISION_PROVIDER_PRESETS = VISION_PRESET_ENDPOINTS
const DEFAULT_VISION_PROVIDER = VISION_PROVIDER_PRESETS[0]
const DEFAULT_VISION_MODEL = DEFAULT_VISION_PROVIDER.models[0]

function isVisionModelCandidate(model: string): boolean {
  const value = String(model || '').trim().toLowerCase()
  if (!value) return false
  if (value.startsWith('ep-')) return true
  if (/(embedding|audio|speech|tts|asr|code)/.test(value)) return false
  return /(?:vision|vl|multimodal|omni)/.test(value) || /doubao-seed-(?:[2-9]|\d{2,})-/.test(value)
}

function getVisionProviderSelectValue(provider: unknown): string {
  const value = String(provider || '').trim()
  return VISION_PROVIDER_PRESETS.some((item) => item.name === value) ? value : 'custom'
}

function normalizeVisionProviderName(provider: unknown): string {
  const value = String(provider || '').trim()
  if (!value || value === 'VolcEngine') return DEFAULT_VISION_PROVIDER.name
  return value
}

function normalizeVisionModel(baseUrl: unknown, model: unknown): string {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '')
  const value = String(model || '').trim()
  if (normalizedBaseUrl === DEFAULT_VISION_PROVIDER.baseUrl && (!value || /^doubao-(vision|1-5|seed-1-6)/.test(value))) {
    return DEFAULT_VISION_MODEL
  }
  return value
}

function hasFieldValidationErrors(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errorFields' in error
}

function isOcrEngine(value: unknown): value is OcrEngine {
  return value === 'local_paddle' || value === 'paddle' || value === 'vision_model' || value === 'hybrid'
}

function normalizeOcrEngine(value: unknown): OcrEngine {
  return isOcrEngine(value) ? value : 'paddle'
}

function normalizeVisibleOcrEngine(value: unknown): OcrEngine {
  const engine = normalizeOcrEngine(value)
  return engine === 'hybrid' || engine === 'local_paddle' ? 'paddle' : engine
}

function findSavedProfileId(profiles: LlmProviderProfile[] | undefined, provider: string, baseUrl: string, model: string): string {
  const normalizedProvider = provider.trim()
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  const normalizedModel = model.trim()
  return profiles?.find((profile) => (
    (profile.provider || profile.name) === normalizedProvider
    && profile.baseUrl === normalizedBaseUrl
    && profile.model === normalizedModel
  ))?.id || profiles?.[0]?.id || ''
}

const PADDLE_OCR_APPLY_URL = 'https://aistudio.baidu.com/paddleocr'
const PADDLE_OCR_OFFICIAL_URL = 'https://www.paddleocr.ai/'
const DEEPSEEK_APPLY_URL = 'https://platform.deepseek.com/'
const VOLCENGINE_ARK_QUICKSTART_URL = 'https://www.volcengine.com/docs/82379/1399008'
const VOLCENGINE_ARK_API_KEY_URL = 'https://www.volcengine.com/docs/82379/1263279'
const VOLCENGINE_ARK_ENDPOINT_URL = 'https://www.volcengine.com/docs/82379/1182403?lang=zh'
const PROJECT_GITHUB_URL = 'https://github.com/DieDust/gujismart-public/'
const LLM_PROFILE_SYNC_EVENT = 'gujismart:llm-profile-changed'
const DEFAULT_LOCAL_PADDLE_OCR_SIZE = 'small'
const LOCAL_PADDLE_OCR_SIZE_OPTIONS = [
  {
    value: 'tiny',
    label: '小',
    officialName: 'PP-OCRv6 tiny',
    sizeText: '约 6 MB',
    desc: '体积最小，下载最快，适合轻量离线识别',
    hardwareTitle: '入门电脑 / 低频使用',
    hardware: 'CPU：2 核以上，Intel i3 8 代或 Ryzen 3 3000 级别即可；内存：4 GB 可用，推荐 8 GB；显卡：不需要独显，核显即可。',
  },
  {
    value: 'small',
    label: '中',
    officialName: 'PP-OCRv6 small',
    sizeText: '约 31 MB',
    desc: '推荐默认，速度、体积和准确率比较均衡',
    hardwareTitle: '普通笔记本 / 日常批量',
    hardware: 'CPU：4 核以上，Intel i5 8 代或 Ryzen 5 3000 级别起；内存：8 GB 可用，推荐 16 GB；显卡：非必须，批量任务有 4 GB 显存以上 NVIDIA 独显更合适。',
  },
  {
    value: 'medium',
    label: '大',
    officialName: 'PP-OCRv6 medium',
    sizeText: '约 133 MB',
    desc: '准确率优先，体积更大，下载和识别更慢',
    hardwareTitle: '高配电脑 / 准确率优先',
    hardware: 'CPU：6 核以上，推荐 Intel i7 10 代或 Ryzen 7 4000 级别起；内存：16 GB 可用，批量建议 32 GB；显卡：建议 RTX 3060 / RTX 4060 或 6 GB 显存以上 NVIDIA 独显。',
  },
]

function createVisionOcrConnectionSignature(input: {
  selectedId: string
  useLlmConfig: boolean
  activeLlmProfileId: string
  baseUrl: string
  model: string
  apiKey: string
}): string {
  return JSON.stringify([
    input.useLlmConfig ? 'follow_ai' : 'vision_profile',
    input.useLlmConfig ? input.activeLlmProfileId : input.selectedId,
    String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    String(input.model || '').trim(),
    String(input.apiKey || ''),
  ])
}

const SHORTCUT_ITEMS: Array<{ action: ShortcutAction; label: string; hint: string }> = [
  { action: 'back', label: '返回 / 退出', hint: '阅读页返回文库；主界面触发退出确认' },
  { action: 'previousPage', label: '上一页', hint: '阅读器向前翻页；上下方向键用于滚动正文' },
  { action: 'nextPage', label: '下一页', hint: '阅读器向后翻页；上下方向键用于滚动正文' },
  { action: 'translate', label: '翻译', hint: '打开或收起当前页翻译' },
  { action: 'search', label: '检索', hint: '聚焦当前页面的检索框' },
  { action: 'selectAll', label: '文库全选', hint: '文库页进入批量模式并选中当前列表' },
  { action: 'invertSelection', label: '文库反选', hint: '文库页进入批量模式并反选当前列表' },
  { action: 'copyDirectQuote', label: '复制直接引用', hint: '一键复制选中文本（带引用格式）；默认 Ctrl+D' },
]

function formatDateTime(value?: string | null): string {
  if (!value) return '尚未备份'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function formatBytes(value?: number): string {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const MIN_NOTICEABLE_FREELIST_BYTES = 8 * 1024 * 1024
const LARGE_FREELIST_BYTES = 64 * 1024 * 1024
const FREELIST_RATIO_RECOMMEND_THRESHOLD = 0.1

function isDatabaseCompactionWorthwhile(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  const freelistBytes = Number(diagnostics?.freelistBytes || 0)
  const databaseBytes = Number(diagnostics?.databaseBytes || 0)
  if (!Number.isFinite(freelistBytes) || freelistBytes <= 0) return false
  if (freelistBytes >= LARGE_FREELIST_BYTES) return true
  return freelistBytes >= MIN_NOTICEABLE_FREELIST_BYTES
    && freelistBytes >= Math.max(1, databaseBytes) * FREELIST_RATIO_RECOMMEND_THRESHOLD
}

function formatCount(value?: number): string {
  return Math.max(0, Number(value || 0)).toLocaleString()
}

function formatDatabaseMaintenanceStage(value?: string | null): string {
  switch (value) {
    case 'idle':
      return '空闲'
    case 'diagnose':
      return '正在诊断'
    case 'cleanup-legacy-index':
      return '正在清理旧索引'
    case 'externalize-page-payloads':
      return '正在迁移大字段'
    case 'queue-lightweight-index':
      return '正在排队重建索引'
    case 'compact':
      return '正在压缩'
    case 'verify':
      return '校验完成'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return value ? String(value) : '空闲'
  }
}

function formatDatabaseStorageModel(value?: string | null): string {
  if (value === 'sqlite-metadata-external-assets-v1') return '元数据与外置资源 v1'
  return value ? String(value) : '-'
}

function formatDatabaseStorageLayerLabel(kind?: string, fallback?: string): string {
  switch (kind) {
    case 'metadata':
      return '元数据与关系'
    case 'document-text':
      return '页面文本与 OCR 结果'
    case 'external-payload':
      return '外置页面大字段'
    case 'search-index':
      return '检索候选索引'
    case 'cache':
      return '可重建缓存'
    case 'runtime':
      return '运行维护状态'
    default:
      return fallback || '其他数据'
  }
}

function hasLegacySearchIndexMaintenance(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  if (!diagnostics) return true
  return !!diagnostics.searchIndex.enterpriseSearchMigrationRecommended
    || hasLegacySearchIndexResidue(diagnostics)
    || hasInlinePagePayloadMaintenance(diagnostics)
}

function hasLegacySearchIndexResidue(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  if (!diagnostics) return true
  const reasons = diagnostics.requiredMaintenance?.reasons || []
  return reasons.some((reason) => (
    reason === 'legacy-ngram-index'
    || reason === 'legacy-single-char-ngram'
    || reason === 'legacy-ngram-positions'
  ))
    || diagnostics.searchIndex.ngramRows > 0
    || diagnostics.searchIndex.singleCharNgramRows > 0
    || diagnostics.searchIndex.ngramPositionsBytes > 0
}

function hasInlinePagePayloadMaintenance(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  if (!diagnostics) return true
  return diagnostics.requiredMaintenance?.reasons?.includes('inline-page-payloads') || false
}

function getSearchIndexMaintenancePrompt(diagnostics: DatabaseStorageDiagnostics | null): string {
  const hasLegacyResidue = hasLegacySearchIndexResidue(diagnostics)
  const needsEnterpriseMigration = !!diagnostics?.searchIndex.enterpriseSearchMigrationRecommended
  const needsPayloadMigration = hasInlinePagePayloadMaintenance(diagnostics)
  if (hasLegacyResidue || needsEnterpriseMigration || needsPayloadMigration) {
    return `会一次性完成数据库企业级升级：${hasLegacyResidue ? '清理旧检索候选索引，' : ''}${needsEnterpriseMigration ? '升级新版轻量全文索引结构，' : ''}${needsPayloadMigration ? '迁移页面 OCR 大字段，' : ''}并提交索引校准任务；不删除文献、OCR 文本、PDF 原文，也不会重新 OCR。完成后可在空闲时点击“压缩数据库”释放磁盘空间。`
  }
  return '搜索索引和页面大字段已经是新版结构，无需再次瘦身。'
}

function getSearchIndexMaintenanceLoadingText(diagnostics: DatabaseStorageDiagnostics | null): string {
  const hasLegacyResidue = hasLegacySearchIndexResidue(diagnostics)
  const needsEnterpriseMigration = !!diagnostics?.searchIndex.enterpriseSearchMigrationRecommended
  const needsPayloadMigration = hasInlinePagePayloadMaintenance(diagnostics)
  if (hasLegacyResidue || needsEnterpriseMigration || needsPayloadMigration) {
    return '正在执行数据库企业级升级：清理索引、升级全文索引并迁移页面大字段，请稍候...'
  }
  return '搜索索引和页面大字段已经是新版结构，无需再次瘦身。'
}

function normalizeAutoBackupIntervalDraft(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 24), 10)
  if (!Number.isFinite(parsed)) return 24
  return Math.max(1, Math.min(168, parsed))
}

function normalizeAutoBackupSlotCountDraft(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 3), 10)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(1, Math.min(3, parsed))
}

function ShortcutRecorder({
  value,
  onChange,
  placeholder,
}: {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
}) {
  const [recording, setRecording] = useState(false)
  const displayValue = normalizeShortcutInput(value || '') || placeholder || '未设置'

  return (
    <Button
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Backspace' || event.key === 'Delete') {
          onChange?.('')
          setRecording(false)
          return
        }
        const next = shortcutFromKeyboardEvent(event.nativeEvent)
        if (!next) return
        onChange?.(next)
        setRecording(false)
      }}
      style={{
        width: 170,
        justifyContent: 'flex-start',
        color: value ? 'var(--gs-text-primary)' : 'var(--gs-text-tertiary)',
        borderColor: recording ? '#d6a85f' : undefined,
      }}
    >
      {recording ? '按下快捷键...' : displayValue}
    </Button>
  )
}

export interface SettingsViewHandle {
  save: () => Promise<boolean>
}

interface SettingsViewProps {
  onDirtyChange?: (dirty: boolean) => void
}

const SettingsView = forwardRef<SettingsViewHandle, SettingsViewProps>(function SettingsView({ onDirtyChange }, ref) {
  const [form] = Form.useForm()
  const [glossaryForm] = Form.useForm()
  const loadingSettingsRef = useRef(true)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [credentialHints, setCredentialHints] = useState<Record<'llm_api_key' | 'paddleocr_api_key' | 'vision_ocr_api_key' | 'embedding_api_key', string>>({
    llm_api_key: '',
    paddleocr_api_key: '',
    vision_ocr_api_key: '',
    embedding_api_key: '',
  })
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionKey>('automation')
  const [autoOcr, setAutoOcr] = useState(true)
  const [autoAi, setAutoAi] = useState(false)
  const [autoDeletePdfAssets, setAutoDeletePdfAssets] = useState(false)
  const [pdfRestoreLinkOnly, setPdfRestoreLinkOnly] = useState(false)
  const [preferFacsimileProofLayout, setPreferFacsimileProofLayout] = useState(true)
  const [preferReadModeOnOpen, setPreferReadModeOnOpen] = useState(true)
  const [metadataTagBindingEnabled, setMetadataTagBindingEnabled] = useState(false)
  const metadataTagBindingEnabledRef = useRef(false)
  const [pdfRepositoryStatus, setPdfRepositoryStatus] = useState<PdfRepositoryStatus | null>(null)
  const [pdfRepositoryBusy, setPdfRepositoryBusy] = useState(false)
  const [batchSize, setBatchSize] = useState(5)
  const [retryCount, setRetryCount] = useState(3)
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupDropActive, setBackupDropActive] = useState(false)
  const [databaseDiagnostics, setDatabaseDiagnostics] = useState<DatabaseStorageDiagnostics | null>(null)
  const [databaseMaintenanceBusy, setDatabaseMaintenanceBusy] = useState(false)
  const [databaseMaintenanceProgress, setDatabaseMaintenanceProgress] = useState<BackgroundTaskProgressEvent | null>(null)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true)
  const [autoBackupInterval, setAutoBackupInterval] = useState(24)
  const [autoBackupIncludeStorage, setAutoBackupIncludeStorage] = useState(false)
  const [autoBackupSlotCount, setAutoBackupSlotCount] = useState(3)
  const autoBackupEnabledRef = useRef(true)
  const autoBackupIntervalRef = useRef(24)
  const autoBackupIncludeStorageRef = useRef(false)
  const autoBackupSlotCountRef = useRef(3)
  const [llmProfiles, setLlmProfiles] = useState<LlmProviderProfile[]>([])
  const [activeLlmProfileId, setActiveLlmProfileId] = useState('')
  const [selectedAiProviderId, setSelectedAiProviderId] = useState('')
  const [llmProfileBusy, setLlmProfileBusy] = useState(false)
  const [visionOcrProfiles, setVisionOcrProfiles] = useState<LlmProviderProfile[]>([])
  const [activeVisionOcrProfileId, setActiveVisionOcrProfileId] = useState('')
  const [visionOcrProfileBusy, setVisionOcrProfileBusy] = useState(false)
  const [visionOcrConnectionTesting, setVisionOcrConnectionTesting] = useState(false)
  const [visionOcrConnectionTest, setVisionOcrConnectionTest] = useState<{ signature: string; profileId: string; testedAt?: string } | null>(null)
  const [defaultOcrEngine, setDefaultOcrEngine] = useState<OcrEngine>('paddle')
  const [activeOcrProviderId, setActiveOcrProviderId] = useState('paddle')
  const [selectedOcrProviderId, setSelectedOcrProviderId] = useState('paddle')
  const [localPaddleStatus, setLocalPaddleStatus] = useState<LocalPaddleOcrStatus | null>(null)
  const [localPaddleBusy, setLocalPaddleBusy] = useState(false)
  const [localPaddleDownloadProgress, setLocalPaddleDownloadProgress] = useState<LocalPaddleOcrDownloadProgress | null>(null)
  const [paddleOcrModelOptions, setPaddleOcrModelOptions] = useState<string[]>([])
  const [paddleOcrModelsLoading, setPaddleOcrModelsLoading] = useState(false)
  const [paddleOcrTokenPool, setPaddleOcrTokenPool] = useState<PaddleOcrTokenPoolState>({ entries: [], activeTokenId: null, configuredCount: 0, enabledCount: 0 })
  const [paddleOcrTokenBusy, setPaddleOcrTokenBusy] = useState(false)
  const [mcpSetup, setMcpSetup] = useState<McpSetupInfo | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  /** 默认 Trae（国内较常用），可切换 Cursor / Claude / Codex 等 */
  const [mcpClientId, setMcpClientId] = useState<McpClientId>('trae')
  const [embeddingStats, setEmbeddingStats] = useState<EmbeddingIndexStats | null>(null)
  const [embeddingBusy, setEmbeddingBusy] = useState(false)
  const [embeddingApiKeyDraft, setEmbeddingApiKeyDraft] = useState('')
  const [embeddingBaseUrlDraft, setEmbeddingBaseUrlDraft] = useState(DEFAULT_EMBEDDING_PROVIDER.baseUrl)
  const [embeddingModelDraft, setEmbeddingModelDraft] = useState(DEFAULT_EMBEDDING_PROVIDER.models[0])
  const [embeddingProviderName, setEmbeddingProviderName] = useState(DEFAULT_EMBEDDING_PROVIDER.name)
  const [embeddingModelOptions, setEmbeddingModelOptions] = useState<string[]>([...DEFAULT_EMBEDDING_PROVIDER.models])
  const [embeddingModelsLoading, setEmbeddingModelsLoading] = useState(false)
  const [embeddingTestQuery, setEmbeddingTestQuery] = useState('')
  const [embeddingTestResult, setEmbeddingTestResult] = useState('')
  const [embeddingBatchSizeDraft, setEmbeddingBatchSizeDraft] = useState(10)
  /** 0 = model default dimensions */
  const [embeddingDimensionsDraft, setEmbeddingDimensionsDraft] = useState(0)
  const [llmModelOptions, setLlmModelOptions] = useState<string[]>([])
  const [visionModelOptions, setVisionModelOptions] = useState<string[]>([])
  const [llmModelsLoading, setLlmModelsLoading] = useState(false)
  const [visionModelsLoading, setVisionModelsLoading] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [researchProjects, setResearchProjects] = useState<ResearchProject[]>([])
  const [glossaryScope, setGlossaryScope] = useState<TranslationGlossaryScope>('global')
  const [glossaryProjectId, setGlossaryProjectId] = useState('')
  const [glossarySearch, setGlossarySearch] = useState('')
  const [glossaryTerms, setGlossaryTerms] = useState<TranslationGlossaryTerm[]>([])
  const [glossaryLoading, setGlossaryLoading] = useState(false)
  const [glossaryModalOpen, setGlossaryModalOpen] = useState(false)
  const [editingGlossaryTerm, setEditingGlossaryTerm] = useState<TranslationGlossaryTerm | null>(null)
  const watchedLlmProvider = Form.useWatch('llm_provider', form)
  const watchedLlmBaseUrl = Form.useWatch('llm_base_url', form)
  const watchedLlmApiKey = Form.useWatch('llm_api_key', form)
  const watchedLlmModel = Form.useWatch('llm_model', form)
  const watchedVisionOcrProvider = Form.useWatch('vision_ocr_provider', form)
  const watchedVisionOcrBaseUrl = Form.useWatch('vision_ocr_base_url', form)
  const watchedVisionOcrApiKey = Form.useWatch('vision_ocr_api_key', form)
  const watchedVisionOcrModel = Form.useWatch('vision_ocr_model', form)
  const watchedVisionOcrUseLlmConfig = Form.useWatch('vision_ocr_use_llm_config', form)
  const databaseCompactionWorthwhile = isDatabaseCompactionWorthwhile(databaseDiagnostics)

  const setSettingsDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [onDirtyChange])

  const markSettingsDirty = useCallback(() => {
    if (loadingSettingsRef.current) return
    setSettingsDirty(true)
  }, [setSettingsDirty])

  const syncAutoBackupDraft = useCallback((status: Pick<BackupStatus, 'enabled' | 'intervalHours' | 'includeStorage' | 'slotCount'>) => {
    const enabled = !!status.enabled
    const interval = normalizeAutoBackupIntervalDraft(status.intervalHours)
    const includeStorage = !!status.includeStorage
    const slotCount = normalizeAutoBackupSlotCountDraft(status.slotCount)

    autoBackupEnabledRef.current = enabled
    autoBackupIntervalRef.current = interval
    autoBackupIncludeStorageRef.current = includeStorage
    autoBackupSlotCountRef.current = slotCount

    setAutoBackupEnabled(enabled)
    setAutoBackupInterval(interval)
    setAutoBackupIncludeStorage(includeStorage)
    setAutoBackupSlotCount(slotCount)
  }, [])

  const updateAutoBackupEnabled = useCallback((value: boolean) => {
    autoBackupEnabledRef.current = value
    setAutoBackupEnabled(value)
    markSettingsDirty()
  }, [markSettingsDirty])

  const updateAutoBackupInterval = useCallback((value: unknown) => {
    const interval = normalizeAutoBackupIntervalDraft(value)
    autoBackupIntervalRef.current = interval
    setAutoBackupInterval(interval)
    markSettingsDirty()
  }, [markSettingsDirty])

  const updateAutoBackupIncludeStorage = useCallback((value: boolean) => {
    autoBackupIncludeStorageRef.current = value
    setAutoBackupIncludeStorage(value)
    markSettingsDirty()
  }, [markSettingsDirty])

  const updateAutoBackupSlotCount = useCallback((value: unknown) => {
    const slotCount = normalizeAutoBackupSlotCountDraft(value)
    autoBackupSlotCountRef.current = slotCount
    setAutoBackupSlotCount(slotCount)
    markSettingsDirty()
  }, [markSettingsDirty])

  const resetShortcutToDefault = useCallback((action: ShortcutAction) => {
    const key = SHORTCUT_SETTING_KEYS[action]
    form.setFieldValue(key, DEFAULT_SHORTCUTS[action])
    markSettingsDirty()
  }, [form, markSettingsDirty])

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.api.getAllSettings()
        setCredentialHints({
          llm_api_key: settings.llm_api_key_configured === 'true'
            ? `已安全保存（末四位 ${settings.llm_api_key_last4 || '****'}）`
            : '',
          paddleocr_api_key: settings.paddleocr_api_key_configured === 'true'
            ? `已安全保存（末四位 ${settings.paddleocr_api_key_last4 || '****'}）`
            : '',
          vision_ocr_api_key: settings.vision_ocr_api_key_configured === 'true'
            ? `已安全保存（末四位 ${settings.vision_ocr_api_key_last4 || '****'}）`
            : '',
          embedding_api_key: settings.embedding_api_key_configured === 'true'
            ? `已安全保存（末四位 ${settings.embedding_api_key_last4 || '****'}）`
            : '',
        })
        try {
          const emb = await window.api.getEmbeddingIndexStats()
          setEmbeddingStats(emb)
          const base = (emb.baseUrl || DEFAULT_EMBEDDING_PROVIDER.baseUrl).replace(/\/+$/, '')
          const model = emb.model || DEFAULT_EMBEDDING_PROVIDER.models[0]
          setEmbeddingBaseUrlDraft(base)
          setEmbeddingModelDraft(model)
          const matched = EMBEDDING_PROVIDER_PRESETS.find((item) => item.baseUrl.replace(/\/+$/, '') === base)
          setEmbeddingProviderName(matched?.name || '自定义')
          setEmbeddingModelOptions([
            ...new Set([...(matched?.models || DEFAULT_EMBEDDING_PROVIDER.models), model].filter(Boolean)),
          ])
        } catch (error) {
          console.warn('[SettingsView] load embedding stats failed', error)
        }
        form.setFieldsValue({
          paddleocr_api_key: '',
          ocr_async_model: settings.ocr_async_model === 'PaddleOCR-VL' ? 'PaddleOCR-VL-1.6' : settings.ocr_async_model || 'PaddleOCR-VL-1.6',
          ocr_upload_timeout_seconds: settings.ocr_upload_timeout_seconds || '3600',
          ocr_document_timeout_minutes: settings.ocr_document_timeout_minutes || '45',
          ocr_max_image_side: settings.ocr_max_image_side || '2200',
          ocr_jpeg_quality: settings.ocr_jpeg_quality || '82',
          local_paddle_ocr_size: settings.local_paddle_ocr_size || DEFAULT_LOCAL_PADDLE_OCR_SIZE,
          pdf_compression_enabled: settings.pdf_compression_enabled === 'true',
          pdf_compression_min_size_mb: settings.pdf_compression_min_size_mb || '10',
          pdf_compression_quality: settings.pdf_compression_quality || settings.ocr_jpeg_quality || '80',
          llm_provider: settings.llm_provider || 'DeepSeek',
          llm_api_key: '',
          llm_base_url: settings.llm_base_url || 'https://api.deepseek.com/v1',
          llm_model: settings.llm_model || 'deepseek-v4-flash',
          vision_ocr_base_url: settings.vision_ocr_base_url || DEFAULT_VISION_PROVIDER.baseUrl,
          vision_ocr_provider: normalizeVisionProviderName(settings.vision_ocr_provider),
          vision_ocr_api_key: '',
          vision_ocr_model: normalizeVisionModel(settings.vision_ocr_base_url || DEFAULT_VISION_PROVIDER.baseUrl, settings.vision_ocr_model),
          vision_ocr_use_llm_config: settings.vision_ocr_use_llm_config !== 'false',
          vision_ocr_concurrency: settings.vision_ocr_concurrency || '1',
          vision_ocr_timeout_seconds: settings.vision_ocr_timeout_seconds || '600',
          vision_ocr_max_image_side: settings.vision_ocr_max_image_side || '2200',
          vision_ocr_jpeg_quality: settings.vision_ocr_jpeg_quality || '82',
          ...SHORTCUT_ITEMS.reduce((fields, item) => {
            fields[SHORTCUT_SETTING_KEYS[item.action]] = normalizeShortcutInput(settings[SHORTCUT_SETTING_KEYS[item.action]] || DEFAULT_SHORTCUTS[item.action])
            return fields
          }, {} as Record<string, string>),
        })
        const currentLlmPreset = AI_PROVIDER_PRESETS.find((item) => item.name === (settings.llm_provider || 'DeepSeek'))
        const effectiveVisionBaseUrl = settings.vision_ocr_base_url || DEFAULT_VISION_PROVIDER.baseUrl
        const currentVisionPreset = VISION_PROVIDER_PRESETS.find((item) => item.baseUrl === effectiveVisionBaseUrl.replace(/\/+$/, ''))
        if (currentLlmPreset) setLlmModelOptions(currentLlmPreset.models)
        if (currentVisionPreset) setVisionModelOptions(currentVisionPreset.models)
        const savedOcrEngine = normalizeVisibleOcrEngine(settings.ocr_default_engine)
        const rawOcrProviderId = settings.ocr_active_provider_id || savedOcrEngine
        const shouldMigrateRetiredOcr = settings.ocr_default_engine === 'hybrid'
          || settings.ocr_default_engine === 'local_paddle'
          || rawOcrProviderId === 'hybrid'
          || rawOcrProviderId === 'local_paddle'
        const savedOcrProviderId = shouldMigrateRetiredOcr ? savedOcrEngine : rawOcrProviderId
        setDefaultOcrEngine(savedOcrEngine)
        setActiveOcrProviderId(savedOcrProviderId)
        setSelectedOcrProviderId(savedOcrProviderId)
        if (shouldMigrateRetiredOcr) {
          void window.api.setDefaultOcrEngine('paddle', 'paddle').catch((error) => console.warn('[SettingsView] 迁移旧混合 OCR 默认项失败', error))
        }
        setAutoOcr(settings.auto_ocr_after_import !== 'false')
        setAutoAi(settings.auto_ai_after_ocr === 'true')
        setAutoDeletePdfAssets(settings.auto_delete_pdf_assets_after_ocr === 'true')
        setPdfRestoreLinkOnly(settings.pdf_restore_link_only === 'true')
        setPreferFacsimileProofLayout(settings.prefer_facsimile_proof_layout !== 'false')
        setPreferReadModeOnOpen(settings.prefer_read_mode_on_open !== 'false')
        const nextMetadataTagBindingEnabled = settings.metadata_tag_binding_enabled === 'true'
        metadataTagBindingEnabledRef.current = nextMetadataTagBindingEnabled
        setMetadataTagBindingEnabled(nextMetadataTagBindingEnabled)
        setBatchSize(parseInt(settings.batch_size || '5', 10))
        setRetryCount(parseInt(settings.retry_count || '3', 10))
        const [
          llmProfileState,
          visionOcrProfileState,
          localOcrStatus,
          backupStatus,
          nextPdfRepositoryStatus,
          nextAppVersion,
          nextResearchProjects,
          nextPaddleOcrTokenPool,
          nextMcpSetup,
        ] = await Promise.all([
          window.api.listLlmProviderProfiles(),
          window.api.listVisionOcrProviderProfiles(),
          window.api.getLocalPaddleOcrStatus(),
          window.api.getBackupStatus(),
          window.api.listPdfRepositories(),
          window.api.getVersion(),
          window.api.listResearchProjects(),
          window.api.getPaddleOcrTokenPool(),
          window.api.getMcpSetupInfo(),
        ])
        setLlmProfiles(llmProfileState.profiles || [])
        setActiveLlmProfileId(llmProfileState.activeId || '')
        setSelectedAiProviderId(llmProfileState.activeId || (currentLlmPreset ? `preset:${currentLlmPreset.name}` : 'custom'))
        setVisionOcrProfiles(visionOcrProfileState.profiles || [])
        setActiveVisionOcrProfileId(visionOcrProfileState.activeId || '')
        const initiallySelectedVisionProfile = settings.vision_ocr_use_llm_config === 'false'
          ? (visionOcrProfileState.profiles || []).find((profile) => profile.id === savedOcrProviderId)
          : undefined
        if (initiallySelectedVisionProfile?.connectionTest?.verified) {
          setVisionOcrConnectionTest({
            signature: createVisionOcrConnectionSignature({
              selectedId: initiallySelectedVisionProfile.id,
              useLlmConfig: false,
              activeLlmProfileId: llmProfileState.activeId || '',
              baseUrl: initiallySelectedVisionProfile.baseUrl,
              model: initiallySelectedVisionProfile.model,
              apiKey: '',
            }),
            profileId: initiallySelectedVisionProfile.id,
            testedAt: initiallySelectedVisionProfile.connectionTest.testedAt,
          })
        }
        setLocalPaddleStatus(localOcrStatus)
        setBackupStatus(backupStatus)
        syncAutoBackupDraft(backupStatus)
        setPdfRepositoryStatus(nextPdfRepositoryStatus)
        setAppVersion(nextAppVersion)
        setResearchProjects(nextResearchProjects)
        setPaddleOcrTokenPool(nextPaddleOcrTokenPool)
        setMcpSetup(nextMcpSetup)
        setCredentialHints((current) => ({
          ...current,
          paddleocr_api_key: nextPaddleOcrTokenPool.configuredCount > 0
            ? `已安全保存 ${nextPaddleOcrTokenPool.configuredCount} 个 Token`
            : '',
        }))
      } catch (error) {
        console.error('加载设置失败:', error)
      } finally {
        loadingSettingsRef.current = false
        setSettingsDirty(false)
      }
    }

    void loadSettings()
  }, [form, setSettingsDirty, syncAutoBackupDraft])

  useEffect(() => {
    const unsubscribe = window.api.onLocalPaddleOcrDownloadProgress((progress) => {
      setLocalPaddleDownloadProgress(progress)
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onBackgroundTaskStatusChanged((event) => {
      if (event.kind !== 'database-maintenance') return
      setDatabaseMaintenanceProgress(event)
      if (event.status === 'queued' || event.status === 'processing') {
        setDatabaseMaintenanceBusy(true)
        return
      }
      setDatabaseMaintenanceBusy(false)
      if (event.status === 'completed') {
        void window.api.getDatabaseStorageDiagnostics()
          .then((diagnostics) => setDatabaseDiagnostics(diagnostics))
          .catch((error) => console.warn('刷新数据库诊断失败:', error))
      }
    })
    return () => {
      unsubscribe()
    }
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      const info = await window.api.checkForUpdates()
      setUpdateInfo(info)
      if (info.error) {
        message.warning(info.error)
      } else if (info.hasUpdate) {
        message.success(`发现新版本 ${info.latestVersion}`)
      } else {
        message.success('当前已是最新版本')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '检查更新失败'))
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const handleMcpEnabledChange = useCallback(async (enabled: boolean) => {
    setMcpBusy(true)
    try {
      const next = await window.api.setMcpAgentEnabled(enabled)
      setMcpSetup(next)
      message.success(enabled ? '已允许 AI 工具访问文献库（只读）' : '已关闭 AI 工具访问')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更新 AI 工具连接失败'))
    } finally {
      setMcpBusy(false)
    }
  }, [])

  /** Apply saved stats into editable form fields (only on enter section / after save). */
  const suggestedEmbeddingModelsForBaseUrl = useCallback((baseUrl: string): string[] => {
    const base = baseUrl.replace(/\/+$/, '')
    const preset = EMBEDDING_PROVIDER_PRESETS.find((item) => item.baseUrl.replace(/\/+$/, '') === base)
    if (preset) return [...preset.models]
    if (/dashscope|aliyuncs|maas\.aliyuncs/i.test(base)) {
      return ['text-embedding-v4', 'text-embedding-v3', 'qwen3.7-text-embedding', 'text-embedding-v2', 'text-embedding-v1']
    }
    if (/openai\.com/i.test(base)) return ['text-embedding-3-small', 'text-embedding-3-large']
    if (/siliconflow/i.test(base)) return ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5']
    if (/bigmodel\.cn/i.test(base)) return ['embedding-3', 'embedding-2']
    if (/volces\.com|volcengine/i.test(base)) return ['doubao-embedding', 'doubao-embedding-large']
    return [...DEFAULT_EMBEDDING_PROVIDER.models]
  }, [])

  const hydrateEmbeddingFormFromStats = useCallback((stats: EmbeddingIndexStats) => {
    const base = (stats.baseUrl || DEFAULT_EMBEDDING_PROVIDER.baseUrl).replace(/\/+$/, '')
    const model = stats.model || DEFAULT_EMBEDDING_PROVIDER.models[0]
    setEmbeddingBaseUrlDraft(base)
    setEmbeddingModelDraft(model)
    setEmbeddingBatchSizeDraft(Math.max(1, Number(stats.batchSize) || 10))
    setEmbeddingDimensionsDraft(Math.max(0, Number(stats.dimensions) || 0))
    const linked = (stats.linkedProfiles || []).find((item) => item.id === stats.sourceProfileId)
    setEmbeddingProviderName(linked?.id || stats.sourceProfileId || '')
    const suggested = suggestedEmbeddingModelsForBaseUrl(base)
    setEmbeddingModelOptions([...new Set([...suggested, model].filter(Boolean))])
  }, [suggestedEmbeddingModelsForBaseUrl])

  /** Progress-only refresh — must NOT overwrite Base URL / model drafts while editing. */
  const refreshEmbeddingStats = useCallback(async () => {
    const stats = await window.api.getEmbeddingIndexStats()
    setEmbeddingStats(stats)
    return stats
  }, [])

  const handleSelectEmbeddingSourceProfile = useCallback(async (profileId: string) => {
    setEmbeddingBusy(true)
    try {
      const stats = await window.api.updateEmbeddingSettings({ sourceProfileId: profileId })
      setEmbeddingStats(stats)
      hydrateEmbeddingFormFromStats(stats)
      const suggested = suggestedEmbeddingModelsForBaseUrl(stats.baseUrl)
      if (!suggested.includes(stats.model) && suggested[0]) {
        setEmbeddingModelDraft(suggested[0])
        setEmbeddingModelOptions(suggested)
      }
      const autoNote = stats.batchSizeAutoAdjusted
        ? `；已自动把批次调为 ${stats.batchSize}（该服务商上限 ${stats.batchSizeCap}）`
        : ''
      message.success(`已选用「${stats.sourceProfileName || profileId}」${autoNote || '，请确认向量模型后保存'}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '选用服务商失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [hydrateEmbeddingFormFromStats, suggestedEmbeddingModelsForBaseUrl])

  const fetchEmbeddingModelOptions = useCallback(async () => {
    const baseUrl = embeddingBaseUrlDraft.trim().replace(/\/+$/, '')
    const fallbackModels = suggestedEmbeddingModelsForBaseUrl(baseUrl)
    if (!embeddingStats?.sourceProfileId && !baseUrl) {
      setEmbeddingModelOptions(fallbackModels)
      message.warning('请先在左侧选择已在 AI 配置中心保存的服务商')
      return
    }
    setEmbeddingModelsLoading(true)
    try {
      // Uses linked AI profile baseUrl + Key on main process.
      const models = await window.api.listEmbeddingModels()
      const merged = [...new Set([...fallbackModels, ...models, embeddingModelDraft].filter(Boolean))]
      setEmbeddingModelOptions(merged)
      if (models.length === 0) {
        message.warning('该接口没有返回可用模型列表，可继续手动输入向量模型 ID')
      } else {
        message.success(`已拉取 ${models.length} 个模型（优先展示向量相关）`)
      }
    } catch (error: unknown) {
      setEmbeddingModelOptions(fallbackModels)
      message.warning(getErrorMessage(error, '拉取向量模型列表失败，可继续手动输入模型 ID'))
    } finally {
      setEmbeddingModelsLoading(false)
    }
  }, [embeddingBaseUrlDraft, embeddingModelDraft, embeddingStats?.sourceProfileId, suggestedEmbeddingModelsForBaseUrl])

  const handleEmbeddingAutoChange = useCallback(async (enabled: boolean) => {
    setEmbeddingBusy(true)
    try {
      const stats = await window.api.updateEmbeddingSettings({ autoOnIngest: enabled })
      setEmbeddingStats(stats)
      message.success(enabled ? '已开启：入库/正文就绪后自动向量化' : '已关闭自动向量化（默认手动批量）')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更新向量设置失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  const handleSaveEmbeddingSettings = useCallback(async () => {
    setEmbeddingBusy(true)
    try {
      const stats = await window.api.updateEmbeddingSettings({
        sourceProfileId: embeddingProviderName || embeddingStats?.sourceProfileId || null,
        model: embeddingModelDraft.trim() || DEFAULT_EMBEDDING_PROVIDER.models[0],
        batchSize: embeddingBatchSizeDraft,
        dimensions: embeddingDimensionsDraft > 0 ? embeddingDimensionsDraft : 0,
      })
      setEmbeddingStats(stats)
      hydrateEmbeddingFormFromStats(stats)
      const dimNote = stats.dimensions > 0
        ? `，维度 ${stats.dimensions}`
        : (stats.dimensionsDefault ? `，维度默认 ${stats.dimensionsDefault}` : '')
      if (stats.batchSizeAutoAdjusted) {
        message.success(`已保存；批次已按模型上限自动调整为 ${stats.batchSize}（上限 ${stats.batchSizeCap}）${dimNote}`)
      } else {
        message.success(`向量设置已保存（批次 ${stats.batchSize}/${stats.batchSizeCap}${dimNote}）`)
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '保存向量设置失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [
    embeddingBatchSizeDraft,
    embeddingDimensionsDraft,
    embeddingModelDraft,
    embeddingProviderName,
    embeddingStats?.sourceProfileId,
    hydrateEmbeddingFormFromStats,
  ])

  const handleResetEmbeddingBatchSize = useCallback(async () => {
    setEmbeddingBusy(true)
    try {
      const stats = await window.api.updateEmbeddingSettings({ resetBatchSizeToProviderDefault: true })
      setEmbeddingStats(stats)
      setEmbeddingBatchSizeDraft(stats.batchSize)
      message.success(`已按服务商默认恢复批次为 ${stats.batchSize}（上限 ${stats.batchSizeCap}）`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '恢复默认批次失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  const handleRequeueFailedEmbeddings = useCallback(async () => {
    setEmbeddingBusy(true)
    try {
      const result = await window.api.requeueFailedEmbeddings()
      setEmbeddingStats(result.stats)
      if (result.queued > 0) {
        message.success(`已重新入队失败文献 ${result.queued} 篇，可在处理队列查看进度`)
      } else {
        message.info(result.skipped > 0 ? `没有可重试项（跳过 ${result.skipped}）` : '当前没有失败的向量化任务')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '重试失败向量化失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  const handleReindexStaleEmbeddings = useCallback(async () => {
    setEmbeddingBusy(true)
    try {
      const result = await window.api.reindexStaleEmbeddings()
      setEmbeddingStats(result.stats)
      if (result.queued > 0) {
        message.success(
          `已入队重建 ${result.queued} 篇（落后于当前模型 ${result.stale} 篇），清除旧段 ${result.clearedChunks}`,
        )
      } else {
        message.info('没有落后于当前模型的文献（全部就绪或尚未向量化）')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '重建过期向量失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  const handleReindexAllReadyEmbeddings = useCallback(async () => {
    const ready = Number(embeddingStats?.docsReady || 0)
    if (ready <= 0) {
      message.info('当前没有已向量化完成的文献')
      return
    }
    Modal.confirm({
      title: '按当前模型重新向量化全部已索引文献？',
      content: `将对 ${ready} 篇「已就绪」文献清除旧向量，并用当前模型（${embeddingStats?.model || 'embeddings'}）全部重建。耗时与 API 费用可能较高，请在空闲时执行。`,
      okText: '全部重建',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setEmbeddingBusy(true)
        try {
          const result = await window.api.reindexAllReadyEmbeddings()
          setEmbeddingStats(result.stats)
          if (result.queued > 0) {
            message.success(`已入队全部重建 ${result.queued} 篇，清除旧段 ${result.clearedChunks}。进度见处理队列。`)
          } else {
            message.info('没有可重建的文献')
          }
        } catch (error: unknown) {
          message.error(getErrorMessage(error, '全部重新向量化失败'))
        } finally {
          setEmbeddingBusy(false)
        }
      },
    })
  }, [embeddingStats?.docsReady, embeddingStats?.model])

  const handleEmbeddingQueuePause = useCallback(async (paused: boolean) => {
    setEmbeddingBusy(true)
    try {
      const stats = await window.api.setEmbeddingQueuePaused(paused)
      setEmbeddingStats(stats)
      message.success(paused ? '已暂停向量化队列' : '已继续向量化队列')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更新队列状态失败'))
    } finally {
      setEmbeddingBusy(false)
    }
  }, [])

  useEffect(() => {
    if (activeSettingsSection !== 'embedding') return
    // Hydrate form once when entering this section; interval only updates progress.
    void refreshEmbeddingStats()
      .then((stats) => hydrateEmbeddingFormFromStats(stats))
      .catch(() => undefined)
    const timer = window.setInterval(() => {
      void refreshEmbeddingStats().catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [activeSettingsSection, hydrateEmbeddingFormFromStats, refreshEmbeddingStats])

  const ensureMcpSetupEnabled = useCallback(async (): Promise<McpSetupInfo> => {
    let setup = mcpSetup
    if (!setup?.enabled) {
      setup = await window.api.setMcpAgentEnabled(true)
      setMcpSetup(setup)
      return setup
    }
    if (!setup.configs?.cursorJson || !setup.configs?.codexFormText) {
      setup = await window.api.getMcpSetupInfo()
      setMcpSetup(setup)
    }
    return setup
  }, [mcpSetup])

  const handleCopyMcpConfig = useCallback(async (clientLabel?: string) => {
    try {
      const setup = await ensureMcpSetupEnabled()
      await navigator.clipboard.writeText(setup.configs.cursorJson)
      const name = clientLabel || '当前客户端'
      message.success(`JSON 配置已复制，可粘贴到 ${name} 的 MCP 设置。`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '复制失败，请手动全选下方文本复制'))
    }
  }, [ensureMcpSetupEnabled])

  const handleCopyCodexForm = useCallback(async () => {
    try {
      const setup = await ensureMcpSetupEnabled()
      await navigator.clipboard.writeText(setup.configs.codexFormText)
      message.success('Codex 表单填写说明已复制：名称、启动命令、参数逐行照贴。')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '复制失败'))
    }
  }, [ensureMcpSetupEnabled])

  const handleWriteCodexConfig = useCallback(async () => {
    setMcpBusy(true)
    try {
      const result = await window.api.writeCodexMcpConfig()
      const setup = await window.api.getMcpSetupInfo()
      setMcpSetup(setup)
      if (result.ok) {
        message.success(result.message)
      } else {
        message.error(result.message || '写入 Codex 配置失败')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '写入 Codex 配置失败'))
    } finally {
      setMcpBusy(false)
    }
  }, [])

  const handleRotateMcpToken = useCallback(async () => {
    setMcpBusy(true)
    try {
      const next = await window.api.rotateMcpAgentToken()
      setMcpSetup(next)
      message.success('已换新连接令牌。请在下方重新复制配置或写入客户端。')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更换令牌失败'))
    } finally {
      setMcpBusy(false)
    }
  }, [])

  const copyMcpField = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      message.success(`已复制「${label}」`)
    } catch {
      message.error('复制失败，请手动选中文本复制')
    }
  }, [])

  const loadGlossaryTerms = useCallback(async () => {
    if (glossaryScope === 'project' && !glossaryProjectId) {
      setGlossaryTerms([])
      return
    }
    setGlossaryLoading(true)
    try {
      const terms = await window.api.listTranslationGlossaryTerms({
        scope: glossaryScope,
        projectId: glossaryScope === 'project' ? glossaryProjectId : null,
        search: glossarySearch.trim(),
        includeDisabled: true,
      })
      setGlossaryTerms(Array.isArray(terms) ? terms : [])
    } catch (error: unknown) {
      console.error(error)
      message.error(getErrorMessage(error, '加载术语表失败'))
    } finally {
      setGlossaryLoading(false)
    }
  }, [glossaryProjectId, glossaryScope, glossarySearch])

  useEffect(() => {
    void loadGlossaryTerms()
  }, [loadGlossaryTerms])

  const openCreateGlossaryTerm = () => {
    if (glossaryScope === 'project' && !glossaryProjectId) {
      message.warning('请先选择研究项目')
      return
    }
    setEditingGlossaryTerm(null)
    glossaryForm.setFieldsValue({
      sourceTerm: '',
      targetTerm: '',
      note: '',
      enabled: true,
      caseSensitive: false,
    })
    setGlossaryModalOpen(true)
  }

  const openEditGlossaryTerm = (term: TranslationGlossaryTerm) => {
    setEditingGlossaryTerm(term)
    glossaryForm.setFieldsValue({
      sourceTerm: term.source_term,
      targetTerm: term.target_term,
      note: term.note || '',
      enabled: term.enabled !== 0,
      caseSensitive: term.case_sensitive === 1,
    })
    setGlossaryModalOpen(true)
  }

  const saveGlossaryTerm = async () => {
    try {
      const values = await glossaryForm.validateFields()
      if (glossaryScope === 'project' && !glossaryProjectId) {
        message.warning('请先选择研究项目')
        return
      }
      await window.api.upsertTranslationGlossaryTerm({
        id: editingGlossaryTerm?.id,
        scope: glossaryScope,
        projectId: glossaryScope === 'project' ? glossaryProjectId : null,
        sourceTerm: values.sourceTerm,
        targetTerm: values.targetTerm,
        note: values.note || '',
        enabled: values.enabled !== false,
        caseSensitive: values.caseSensitive === true,
      })
      message.success(editingGlossaryTerm ? '术语已更新' : '术语已添加')
      setGlossaryModalOpen(false)
      setEditingGlossaryTerm(null)
      glossaryForm.resetFields()
      await loadGlossaryTerms()
    } catch (error: unknown) {
      if (hasFieldValidationErrors(error)) return
      console.error(error)
      message.error(getErrorMessage(error, '保存术语失败'))
    }
  }

  const toggleGlossaryTerm = async (term: TranslationGlossaryTerm) => {
    try {
      await window.api.upsertTranslationGlossaryTerm({
        id: term.id,
        scope: term.scope || glossaryScope,
        projectId: term.project_id || (glossaryScope === 'project' ? glossaryProjectId : null),
        sourceTerm: term.source_term,
        targetTerm: term.target_term,
        note: term.note || '',
        enabled: term.enabled === 0,
        caseSensitive: term.case_sensitive === 1,
      })
      await loadGlossaryTerms()
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更新术语状态失败'))
    }
  }

  const deleteGlossaryTerm = async (id: string) => {
    try {
      await window.api.deleteTranslationGlossaryTerm(id)
      message.success('术语已删除')
      await loadGlossaryTerms()
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '删除术语失败'))
    }
  }

  useEffect(() => {
    const handleProfileSync = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail?.current) return
      setLlmProfiles(detail.profiles || [])
      setActiveLlmProfileId(detail.activeId || '')
      setSelectedAiProviderId(detail.activeId || '')
      form.setFieldsValue({
        llm_provider: detail.current.provider || detail.current.name,
        llm_base_url: detail.current.baseUrl,
        llm_api_key: '',
        llm_model: detail.current.model,
      })
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: detail.current.provider || detail.current.name,
          vision_ocr_base_url: detail.current.baseUrl,
          vision_ocr_api_key: '',
          vision_ocr_model: detail.current.model,
        })
        setVisionModelOptions(detail.current.model ? [String(detail.current.model)] : [])
      }
    }
    window.addEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
    return () => window.removeEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
  }, [form])

  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    try {
      const values = form.getFieldsValue()
      for (const [key, value] of Object.entries(values)) {
        if (key === 'llm_api_key' || key === 'paddleocr_api_key' || key === 'vision_ocr_api_key') continue
        if (value !== undefined && value !== null) {
          await window.api.setSetting(key, String(value))
        }
      }
      for (const key of ['llm_api_key', 'vision_ocr_api_key'] as const) {
        const draft = String(values[key] || '')
        if (draft) {
          await window.api.saveCredential(key, draft)
          setCredentialHints((current) => ({ ...current, [key]: `已安全保存（末四位 ${draft.slice(-4)}）` }))
        }
      }
      const paddleTokenDraft = String(values.paddleocr_api_key || '').trim()
      if (paddleTokenDraft) {
        const state = await window.api.addPaddleOcrToken(`Token ${paddleOcrTokenPool.configuredCount + 1}`, paddleTokenDraft)
        setPaddleOcrTokenPool(state)
        setCredentialHints((current) => ({ ...current, paddleocr_api_key: `已安全保存 ${state.configuredCount} 个 Token` }))
        form.setFieldValue('paddleocr_api_key', '')
      }
      await window.api.setSetting('auto_ocr_after_import', autoOcr ? 'true' : 'false')
      await window.api.setSetting('auto_ai_after_ocr', autoAi ? 'true' : 'false')
      await window.api.setSetting('auto_delete_pdf_assets_after_ocr', autoDeletePdfAssets ? 'true' : 'false')
      await window.api.setSetting('pdf_restore_link_only', pdfRestoreLinkOnly ? 'true' : 'false')
      await window.api.setSetting('prefer_facsimile_proof_layout', preferFacsimileProofLayout ? 'true' : 'false')
      await window.api.setSetting('prefer_read_mode_on_open', preferReadModeOnOpen ? 'true' : 'false')
      const nextMetadataTagBindingEnabled = metadataTagBindingEnabledRef.current
      const metadataTagSetting = await window.api.setSetting('metadata_tag_binding_enabled', nextMetadataTagBindingEnabled ? 'true' : 'false')
      const metadataTagCleanup = nextMetadataTagBindingEnabled ? null : metadataTagSetting.metadataTagCleanup ?? null
      const metadataTagRebuild = nextMetadataTagBindingEnabled ? metadataTagSetting.metadataTagRebuild ?? null : null
      await window.api.setSetting('batch_size', String(batchSize))
      await window.api.setSetting('retry_count', String(retryCount))
      const backupState = await window.api.configureAutoBackup(
        autoBackupEnabledRef.current,
        autoBackupIntervalRef.current,
        autoBackupIncludeStorageRef.current,
        autoBackupSlotCountRef.current,
      )
      setBackupStatus(backupState)
      syncAutoBackupDraft(backupState)
      for (const item of SHORTCUT_ITEMS) {
        const key = SHORTCUT_SETTING_KEYS[item.action]
        const nextShortcut = normalizeShortcutInput(String(values[key] || '')) || DEFAULT_SHORTCUTS[item.action]
        await window.api.setSetting(key, nextShortcut)
        form.setFieldValue(key, nextShortcut)
      }
      if (values.llm_provider && values.llm_base_url && values.llm_model) {
        const providerName = String(values.llm_provider || 'custom').trim()
        // Prefer updating the profile currently selected for edit; never always create a new id.
        const editingId = String(selectedAiProviderId || '').startsWith('preset:')
          || selectedAiProviderId === 'custom'
          ? ''
          : String(selectedAiProviderId || '').trim()
        const upserted = await window.api.upsertLlmProviderProfile({
          id: editingId,
          name: providerName,
          provider: providerName,
          baseUrl: String(values.llm_base_url || '').trim(),
          apiKey: String(values.llm_api_key || ''),
          model: String(values.llm_model || '').trim(),
        })
        const profileId = editingId
          || findSavedProfileId(
            upserted.profiles,
            providerName,
            String(values.llm_base_url || ''),
            String(values.llm_model || ''),
          )
        if (!profileId) throw new Error('AI 服务商配置保存失败')
        const state = await window.api.switchLlmProviderProfile(profileId)
        setLlmProfiles(state.profiles || [])
        setActiveLlmProfileId(state.activeId || '')
        setSelectedAiProviderId(state.activeId || profileId)
        window.dispatchEvent(new CustomEvent(LLM_PROFILE_SYNC_EVENT, { detail: state }))
      }
      window.dispatchEvent(new Event(SHORTCUTS_CHANGED_EVENT))
      if (metadataTagCleanup || metadataTagRebuild) {
        window.dispatchEvent(new Event(LIBRARY_RELATIONS_CHANGED_EVENT))
      }
      setSettingsDirty(false)
      if (metadataTagRebuild && (metadataTagRebuild.syncedDocuments > 0 || metadataTagRebuild.createdOrUpdatedRelations > 0)) {
        message.success(
          `设置已保存，已重新生成 ${metadataTagRebuild.syncedDocuments} 篇文献的元数据标签`
          + (metadataTagRebuild.createdOrUpdatedRelations > 0 ? `，恢复 ${metadataTagRebuild.createdOrUpdatedRelations} 个标签绑定` : ''),
        )
      } else if (metadataTagCleanup && (metadataTagCleanup.removedRelations > 0 || metadataTagCleanup.keptManualRelations > 0 || metadataTagCleanup.removedTags > 0)) {
        message.success(
          `设置已保存，已解除 ${metadataTagCleanup.removedRelations} 个自动元数据标签绑定`
          + (metadataTagCleanup.keptManualRelations > 0 ? `，保留 ${metadataTagCleanup.keptManualRelations} 个手动标签` : '')
          + (metadataTagCleanup.removedTags > 0 ? `，清理 ${metadataTagCleanup.removedTags} 个空标签` : ''),
        )
      } else {
        message.success('设置已保存')
      }
      return true
    } catch (error) {
      console.error(error)
      message.error('保存设置失败')
      return false
    } finally {
      setSaving(false)
    }
  }, [
    autoAi,
    autoDeletePdfAssets,
    autoOcr,
    batchSize,
    form,
    paddleOcrTokenPool.configuredCount,
    pdfRestoreLinkOnly,
    preferFacsimileProofLayout,
    preferReadModeOnOpen,
    retryCount,
    selectedAiProviderId,
    setSettingsDirty,
    syncAutoBackupDraft,
  ])

  useImperativeHandle(ref, () => ({
    save: handleSave,
  }), [handleSave])

  const handleProviderChange = (provider: string) => {
    if (provider === 'custom') {
      setSelectedAiProviderId('custom')
      form.setFieldValue('llm_provider', '自定义')
      markSettingsDirty()
      return
    }
    const preset = AI_PROVIDER_PRESETS.find((item) => item.name === provider)
    if (!preset) return
    setSelectedAiProviderId(`preset:${preset.name}`)
    form.setFieldsValue({
      llm_provider: preset.name,
      llm_base_url: preset.baseUrl,
      llm_model: preset.models[0],
    })
    setLlmModelOptions(preset.models)
    if (form.getFieldValue('vision_ocr_use_llm_config')) {
      form.setFieldsValue({
        vision_ocr_provider: '自定义',
        vision_ocr_base_url: preset.baseUrl,
        vision_ocr_model: preset.models[0],
      })
      setVisionModelOptions(preset.models[0] ? [preset.models[0]] : [])
    }
    markSettingsDirty()
  }

  const handleSelectLlmProfileForEdit = (profile: LlmProviderProfile) => {
    setSelectedAiProviderId(profile.id)
    form.setFieldsValue({
      llm_provider: profile.provider || profile.name,
      llm_base_url: profile.baseUrl,
      llm_api_key: '',
      llm_model: profile.model,
    })
    setLlmModelOptions(profile.model ? [String(profile.model)] : [])
    // Do not reuse global key hint text as if it belonged to every profile.
  }

  const handleAddLlmProviderDraft = () => {
    setSelectedAiProviderId('custom')
    form.setFieldsValue({
      llm_provider: '自定义',
      llm_base_url: '',
      llm_api_key: '',
      llm_model: '',
    })
    setLlmModelOptions([])
  }

  const handleSelectVisionOcrProfileForEdit = (profile: LlmProviderProfile) => {
    setSelectedOcrProviderId(profile.id)
    form.setFieldsValue({
      vision_ocr_provider: profile.provider || profile.name,
      vision_ocr_base_url: profile.baseUrl,
      vision_ocr_api_key: '',
      vision_ocr_model: profile.model,
      vision_ocr_use_llm_config: false,
    })
    setVisionModelOptions(profile.model ? [String(profile.model)] : [])
    setVisionOcrConnectionTest(profile.connectionTest?.verified ? {
      signature: createVisionOcrConnectionSignature({
        selectedId: profile.id,
        useLlmConfig: false,
        activeLlmProfileId,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: '',
      }),
      profileId: profile.id,
      testedAt: profile.connectionTest.testedAt,
    } : null)
  }

  const handleAddVisionOcrProviderDraft = () => {
    setSelectedOcrProviderId('vision_draft')
    form.setFieldsValue({
      vision_ocr_provider: DEFAULT_VISION_PROVIDER.name,
      vision_ocr_base_url: DEFAULT_VISION_PROVIDER.baseUrl,
      vision_ocr_api_key: '',
      vision_ocr_model: DEFAULT_VISION_MODEL,
      vision_ocr_use_llm_config: false,
    })
    setVisionModelOptions(DEFAULT_VISION_PROVIDER.models)
    setVisionOcrConnectionTest(null)
  }

  const handleVisionProviderChange = (provider: string) => {
    if (provider === 'custom') {
      form.setFieldsValue({
        vision_ocr_provider: '自定义',
        vision_ocr_use_llm_config: false,
      })
      markSettingsDirty()
      return
    }
    const preset = VISION_PROVIDER_PRESETS.find((item) => item.name === provider)
    if (!preset) return
    form.setFieldsValue({
      vision_ocr_provider: preset.name,
      vision_ocr_base_url: preset.baseUrl,
      vision_ocr_model: preset.models[0],
      vision_ocr_use_llm_config: false,
    })
    setVisionModelOptions(preset.models)
    markSettingsDirty()
  }

  const applyLlmConfigToVisionOcr = () => {
    const values = form.getFieldsValue(['llm_base_url', 'llm_api_key', 'llm_model'])
      form.setFieldsValue({
        vision_ocr_provider: '自定义',
        vision_ocr_base_url: values.llm_base_url || '',
        vision_ocr_api_key: values.llm_api_key || '',
        vision_ocr_model: values.llm_model || '',
      vision_ocr_use_llm_config: true,
    })
    setVisionModelOptions(values.llm_model ? [String(values.llm_model)] : [])
    markSettingsDirty()
  }

  const fetchModelOptions = async (kind: 'llm' | 'vision') => {
    const baseUrlField = kind === 'llm' ? 'llm_base_url' : 'vision_ocr_base_url'
    const apiKeyField = kind === 'llm' ? 'llm_api_key' : 'vision_ocr_api_key'
    const setLoading = kind === 'llm' ? setLlmModelsLoading : setVisionModelsLoading
    const setOptions = kind === 'llm' ? setLlmModelOptions : setVisionModelOptions
    const values = form.getFieldsValue([baseUrlField, apiKeyField])
    const baseUrl = String(values[baseUrlField] || '').trim()
    const apiKey = String(values[apiKeyField] || '').trim()
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
    const fallbackPreset = kind === 'vision'
      ? VISION_PROVIDER_PRESETS.find((item) => item.baseUrl === normalizedBaseUrl)
      : AI_PROVIDER_PRESETS.find((item) => item.baseUrl === normalizedBaseUrl)
    if (!baseUrl) {
      if (fallbackPreset?.models?.length) setOptions(fallbackPreset.models)
      return
    }

    setLoading(true)
    try {
      const models = await window.api.listModels(baseUrl, apiKey, kind === 'vision' ? 'vision_ocr_api_key' : 'llm_api_key')
      const usableModels = kind === 'vision' ? models.filter(isVisionModelCandidate) : models
      const mergedModels = [...new Set([...(fallbackPreset?.models || []), ...usableModels])]
      setOptions(mergedModels)
      if (models.length === 0) {
        message.warning('该接口没有返回可用模型列表，可继续手动输入模型 ID')
      }
    } catch (error: unknown) {
      if (fallbackPreset?.models?.length) setOptions(fallbackPreset.models)
      message.warning(getErrorMessage(error, '拉取模型列表失败，可继续手动输入模型 ID'))
    } finally {
      setLoading(false)
    }
  }

  const fetchPaddleOcrModelOptions = async () => {
    setPaddleOcrModelsLoading(true)
    try {
      const apiKey = String(form.getFieldValue('paddleocr_api_key') || '').trim()
      const models = await window.api.listPaddleOcrModels(apiKey)
      setPaddleOcrModelOptions(models)
      message.success(`已从官方加载 ${models.length} 个飞桨 OCR 文档解析模型`)
    } catch (error: unknown) {
      message.warning(getErrorMessage(error, '拉取飞桨 OCR 官方模型列表失败，可继续手动输入模型 ID'))
    } finally {
      setPaddleOcrModelsLoading(false)
    }
  }

  const handleAddPaddleOcrToken = async () => {
    const token = String(form.getFieldValue('paddleocr_api_key') || '').trim()
    if (!token) {
      message.warning('请先填写要添加的 PaddleOCR API Token')
      return
    }
    setPaddleOcrTokenBusy(true)
    try {
      const state = await window.api.addPaddleOcrToken(`Token ${paddleOcrTokenPool.configuredCount + 1}`, token)
      setPaddleOcrTokenPool(state)
      setCredentialHints((current) => ({ ...current, paddleocr_api_key: `已安全保存 ${state.configuredCount} 个 Token` }))
      form.setFieldValue('paddleocr_api_key', '')
      message.success(`Token 已加入轮询池，当前共 ${state.configuredCount} 个`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '添加 PaddleOCR Token 失败'))
    } finally {
      setPaddleOcrTokenBusy(false)
    }
  }

  const handleRemovePaddleOcrToken = async (id: string) => {
    setPaddleOcrTokenBusy(true)
    try {
      const state = await window.api.removePaddleOcrToken(id)
      setPaddleOcrTokenPool(state)
      setCredentialHints((current) => ({
        ...current,
        paddleocr_api_key: state.configuredCount > 0 ? `已安全保存 ${state.configuredCount} 个 Token` : '',
      }))
      message.success('Token 已删除')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '删除 PaddleOCR Token 失败'))
    } finally {
      setPaddleOcrTokenBusy(false)
    }
  }

  const handleSetPaddleOcrTokenEnabled = async (id: string, enabled: boolean) => {
    setPaddleOcrTokenBusy(true)
    try {
      setPaddleOcrTokenPool(await window.api.setPaddleOcrTokenEnabled(id, enabled))
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '更新 PaddleOCR Token 状态失败'))
    } finally {
      setPaddleOcrTokenBusy(false)
    }
  }

  const refreshLocalPaddleStatus = async () => {
    const status = await window.api.getLocalPaddleOcrStatus()
    setLocalPaddleStatus(status)
    return status
  }

  const handleChangeLocalPaddleSize = async (value: string) => {
    try {
      await window.api.setSetting('local_paddle_ocr_size', value)
      await refreshLocalPaddleStatus()
      setLocalPaddleDownloadProgress(null)
    } catch (error: unknown) {
      message.warning(getErrorMessage(error, '切换本地 OCR 模型档位失败'))
    }
  }

  const handleSetDefaultOcrProvider = async (engine: OcrEngine, providerId: string) => {
    try {
      await window.api.setDefaultOcrEngine(engine, providerId)
      setDefaultOcrEngine(engine)
      setActiveOcrProviderId(providerId)
      setSelectedOcrProviderId(providerId)
      message.success(`已设为默认 OCR：${engine === 'local_paddle' ? '本地 OCR' : engine === 'vision_model' ? 'AI OCR' : '飞桨云端 OCR'}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '切换默认 OCR 失败'))
    }
  }

  const handleDownloadLocalPaddle = async () => {
    setLocalPaddleBusy(true)
    setLocalPaddleDownloadProgress({ state: 'checking', sourceId: 'auto', progress: 0, message: '正在准备本地 OCR 下载' })
    try {
      const selectedSize = String(form.getFieldValue('local_paddle_ocr_size') || DEFAULT_LOCAL_PADDLE_OCR_SIZE)
      await window.api.setSetting('local_paddle_ocr_size', selectedSize)
      const status = await window.api.downloadLocalPaddleOcr({ source: 'auto' })
      setLocalPaddleStatus(status)
      if (status.installed) {
        await handleSetDefaultOcrProvider('local_paddle', 'local_paddle')
      } else if (status.modelInstalled) {
        message.info(status.runtime?.message || '本地 OCR 模型已安装，请继续安装/升级运行环境。')
      } else {
        message.warning(status.message || '本地 OCR 文件尚未完整安装，请稍后重试，或打开官方页面查看下载说明。')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '下载本地 OCR 失败'))
    } finally {
      setLocalPaddleBusy(false)
    }
  }

  const handleInstallLocalPaddleRuntime = async () => {
    setLocalPaddleBusy(true)
    setLocalPaddleDownloadProgress({ state: 'installing', progress: 0, message: '正在准备本地 OCR 运行环境' })
    try {
      const status = await window.api.installLocalPaddleOcrRuntime()
      setLocalPaddleStatus(status)
      if (status.installed) {
        await handleSetDefaultOcrProvider('local_paddle', 'local_paddle')
      } else {
        message.success(status.runtime?.message || '本地 OCR 运行环境已安装，请继续下载模型。')
      }
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '安装本地 OCR 运行环境失败'))
    } finally {
      setLocalPaddleBusy(false)
    }
  }

  const refreshLlmProfiles = async () => {
    const state = await window.api.listLlmProviderProfiles()
    setLlmProfiles(state.profiles || [])
    setActiveLlmProfileId(state.activeId || '')
    if (!selectedAiProviderId) setSelectedAiProviderId(state.activeId || '')
    return state
  }

  const handleSaveCurrentLlmProfile = async () => {
    setLlmProfileBusy(true)
    try {
      const values = form.getFieldsValue()
      const providerName = String(values.llm_provider || 'custom').trim()
      // Editing an existing saved row must update in place; presets/custom drafts create or merge by endpoint.
      const editingId = selectedAiSavedProfile?.id
        || (
          String(selectedAiProviderId || '').startsWith('preset:')
          || selectedAiProviderId === 'custom'
            ? ''
            : String(selectedAiProviderId || '').trim()
        )
      const upserted = await window.api.upsertLlmProviderProfile({
        id: editingId || '',
        name: providerName,
        provider: providerName,
        baseUrl: String(values.llm_base_url || '').trim(),
        apiKey: String(values.llm_api_key || ''),
        model: String(values.llm_model || '').trim(),
      })
      const profileId = editingId
        || findSavedProfileId(
          upserted.profiles,
          providerName,
          String(values.llm_base_url || ''),
          String(values.llm_model || ''),
        )
      if (!profileId) throw new Error('AI 服务商配置保存失败')
      const result = await window.api.switchLlmProviderProfile(profileId)
      setLlmProfiles(result.profiles?.length ? result.profiles : upserted.profiles || [])
      setActiveLlmProfileId(result.activeId || '')
      setSelectedAiProviderId(result.activeId || profileId)
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: result.current?.provider || result.current?.name,
          vision_ocr_base_url: result.current?.baseUrl || '',
          vision_ocr_api_key: '',
          vision_ocr_model: result.current?.model || '',
        })
        setVisionModelOptions(result.current?.model ? [String(result.current.model)] : [])
      }
      window.dispatchEvent(new CustomEvent(LLM_PROFILE_SYNC_EVENT, { detail: result }))
      message.success(`已保存并切换到：${result.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '保存 AI 服务商配置失败'))
    } finally {
      setLlmProfileBusy(false)
    }
  }

  const handleSwitchLlmProfile = async (profileId: string) => {
    setLlmProfileBusy(true)
    try {
      const result = await window.api.switchLlmProviderProfile(profileId)
      setLlmProfiles(result.profiles || [])
      setActiveLlmProfileId(result.activeId || '')
      setSelectedAiProviderId(result.activeId || profileId)
      form.setFieldsValue({
        llm_provider: result.current.provider || result.current.name,
        llm_base_url: result.current.baseUrl,
        llm_api_key: '',
        llm_model: result.current.model,
      })
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: result.current.provider || result.current.name,
          vision_ocr_base_url: result.current.baseUrl,
          vision_ocr_api_key: '',
          vision_ocr_model: result.current.model,
        })
        setVisionModelOptions(result.current.model ? [String(result.current.model)] : [])
      }
      window.dispatchEvent(new CustomEvent(LLM_PROFILE_SYNC_EVENT, { detail: result }))
      message.success(`已切换 AI 服务商：${result.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '切换 AI 服务商失败'))
    } finally {
      setLlmProfileBusy(false)
    }
  }

  const handleDeleteLlmProfile = async (profileId: string) => {
    setLlmProfileBusy(true)
    try {
      const result = await window.api.deleteLlmProviderProfile(profileId)
      setLlmProfiles(result.profiles || [])
      setActiveLlmProfileId(result.activeId || '')
      if (selectedAiProviderId === profileId) setSelectedAiProviderId(result.activeId || '')
      message.success('已删除 AI 服务商配置')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '删除 AI 服务商配置失败'))
    } finally {
      setLlmProfileBusy(false)
    }
  }

  const refreshVisionOcrProfiles = async () => {
    const state = await window.api.listVisionOcrProviderProfiles()
    setVisionOcrProfiles(state.profiles || [])
    setActiveVisionOcrProfileId(state.activeId || '')
    if (!selectedOcrProviderId || selectedOcrProviderId === 'vision_draft') setSelectedOcrProviderId(state.activeId || 'paddle')
    return state
  }

  const handleTestVisionOcrConnection = async () => {
    const values = form.getFieldsValue()
    const useLlmConfig = values.vision_ocr_use_llm_config === true
    const provider = String(useLlmConfig ? values.llm_provider : values.vision_ocr_provider || '视觉 OCR').trim()
    const baseUrl = String(useLlmConfig ? values.llm_base_url : values.vision_ocr_base_url || '').trim()
    const model = String(useLlmConfig ? values.llm_model : values.vision_ocr_model || '').trim()
    const apiKey = String(useLlmConfig ? values.llm_api_key : values.vision_ocr_api_key || '')
    const selectedId = selectedVisionOcrProfile?.id || ''
    const signature = createVisionOcrConnectionSignature({
      selectedId: useLlmConfig ? activeLlmProfileId : selectedOcrProviderId,
      useLlmConfig,
      activeLlmProfileId,
      baseUrl,
      model,
      apiKey,
    })
    setVisionOcrConnectionTesting(true)
    setVisionOcrConnectionTest(null)
    try {
      const result = await window.api.testVisionOcrProviderConnection({
        id: selectedId,
        name: provider,
        provider,
        baseUrl,
        model,
        apiKey,
        useLlmConfig,
      })
      setVisionOcrConnectionTest({ signature, profileId: result.profileId, testedAt: result.testedAt })
      if (!useLlmConfig && selectedId) {
        setVisionOcrProfiles((profiles) => profiles.map((profile) => profile.id === selectedId
          ? { ...profile, connectionTest: { verified: true, testedAt: result.testedAt } }
          : profile))
      }
      message.success(result.message)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, 'AI OCR 连接测试失败'))
    } finally {
      setVisionOcrConnectionTesting(false)
    }
  }

  const handleSaveCurrentVisionOcrProfile = async () => {
    setVisionOcrProfileBusy(true)
    try {
      const values = form.getFieldsValue()
      if (!visionOcrConnectionVerified) throw new Error('请先测试 AI OCR 连接')
      const providerName = String(values.vision_ocr_provider || values.llm_provider || '视觉 OCR').trim()
      const upserted = await window.api.upsertVisionOcrProviderProfile({
        id: selectedVisionOcrProfile?.id || visionOcrConnectionTest?.profileId || '',
        name: providerName,
        provider: providerName,
        baseUrl: String(values.vision_ocr_base_url || '').trim(),
        apiKey: String(values.vision_ocr_api_key || ''),
        model: String(values.vision_ocr_model || '').trim(),
      })
      const profileId = findSavedProfileId(
        upserted.profiles,
        providerName,
        String(values.vision_ocr_base_url || ''),
        String(values.vision_ocr_model || ''),
      )
      if (!profileId) throw new Error('视觉 OCR 服务商配置保存失败')
      const result = await window.api.switchVisionOcrProviderProfile(profileId)
      setVisionOcrProfiles(result.profiles?.length ? result.profiles : upserted.profiles || [])
      setActiveVisionOcrProfileId(result.activeId || '')
      setSelectedOcrProviderId(result.activeId || profileId)
      form.setFieldsValue({
        vision_ocr_provider: result.current.provider || result.current.name,
        vision_ocr_base_url: result.current.baseUrl,
        vision_ocr_api_key: '',
        vision_ocr_model: result.current.model,
        vision_ocr_use_llm_config: false,
      })
      setVisionModelOptions(result.current.model ? [String(result.current.model)] : [])
      setVisionOcrConnectionTest(result.current.connectionTest?.verified ? {
        signature: createVisionOcrConnectionSignature({
          selectedId: result.current.id,
          useLlmConfig: false,
          activeLlmProfileId,
          baseUrl: result.current.baseUrl,
          model: result.current.model,
          apiKey: '',
        }),
        profileId: result.current.id,
        testedAt: result.current.connectionTest.testedAt,
      } : null)
      message.success(`已保存并切换视觉 OCR 服务商：${result.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '保存视觉 OCR 服务商配置失败'))
    } finally {
      setVisionOcrProfileBusy(false)
    }
  }

  const handleSwitchVisionOcrProfile = async (profileId: string) => {
    setVisionOcrProfileBusy(true)
    try {
      const result = await window.api.switchVisionOcrProviderProfile(profileId)
      setVisionOcrProfiles(result.profiles || [])
      setActiveVisionOcrProfileId(result.activeId || '')
      setSelectedOcrProviderId(result.activeId || profileId)
      form.setFieldsValue({
        vision_ocr_provider: result.current.provider || result.current.name,
        vision_ocr_base_url: result.current.baseUrl,
        vision_ocr_api_key: '',
        vision_ocr_model: result.current.model,
        vision_ocr_use_llm_config: false,
      })
      setVisionModelOptions(result.current.model ? [String(result.current.model)] : [])
      setVisionOcrConnectionTest(result.current.connectionTest?.verified ? {
        signature: createVisionOcrConnectionSignature({
          selectedId: result.current.id,
          useLlmConfig: false,
          activeLlmProfileId,
          baseUrl: result.current.baseUrl,
          model: result.current.model,
          apiKey: '',
        }),
        profileId: result.current.id,
        testedAt: result.current.connectionTest.testedAt,
      } : null)
      message.success(`已切换视觉 OCR 服务商：${result.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '切换视觉 OCR 服务商失败'))
    } finally {
      setVisionOcrProfileBusy(false)
    }
  }

  const handleSetSelectedVisionOcrAsDefault = async () => {
    const providerId = selectedVisionOcrProfile?.id || activeVisionOcrProfileId || 'vision_model'
    if (selectedVisionOcrProfile && selectedVisionOcrProfile.id !== activeVisionOcrProfileId) {
      await handleSwitchVisionOcrProfile(selectedVisionOcrProfile.id)
    }
    await handleSetDefaultOcrProvider('vision_model', providerId)
  }

  const handleDeleteVisionOcrProfile = async (profileId: string) => {
    setVisionOcrProfileBusy(true)
    try {
      const result = await window.api.deleteVisionOcrProviderProfile(profileId)
      setVisionOcrProfiles(result.profiles || [])
      setActiveVisionOcrProfileId(result.activeId || '')
      if (selectedOcrProviderId === profileId) setSelectedOcrProviderId(result.activeId || 'paddle')
      setVisionOcrConnectionTest(null)
      message.success('已删除视觉 OCR 服务商配置')
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '删除视觉 OCR 服务商配置失败'))
    } finally {
      setVisionOcrProfileBusy(false)
    }
  }

  const refreshBackupStatus = async () => {
    const status = await window.api.getBackupStatus()
    setBackupStatus(status)
    syncAutoBackupDraft(status)
  }

  const handleCreateBackup = async () => {
    setBackupBusy(true)
    try {
      const result = await window.api.createBackup()
      if (result?.success) {
        message.success(`已导出完整备份包：${result.path}`)
      } else if (result?.error) {
        message.error(result.error)
      }
      await refreshBackupStatus()
    } finally {
      setBackupBusy(false)
    }
  }

  const handleImportBackup = async () => {
    setBackupBusy(true)
    try {
      const result = await window.api.importBackup()
      if (result?.success) {
        message.success(result.safetyBackupPath
          ? `导入完成，软件将自动重启；当前数据安全副本：${result.safetyBackupPath}`
          : '导入完成，软件将自动重启')
        return
      } else if (!result?.canceled && result?.error) {
        message.error(result.error)
      }
    } finally {
      setBackupBusy(false)
    }
  }

  const handleSetSelectedLlmAsCurrent = async () => {
    if (!selectedAiSavedProfile) return
    await handleSwitchLlmProfile(selectedAiSavedProfile.id)
  }

  const handleImportDroppedBackup = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      message.info('请拖入 GujiSmart 备份压缩包（.zip）')
      return
    }
    Modal.confirm({
      title: '导入拖入的备份包？',
      content: '导入会覆盖当前数据库和配置；软件会先自动写入一份当前数据安全备份包，方便之后还原。',
      okText: '导入备份包',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setBackupBusy(true)
        try {
          const result = await window.api.importDroppedBackup(file)
          if (result?.success) {
            message.success(result.safetyBackupPath
              ? `导入完成，软件将自动重启；当前数据安全备份包：${result.safetyBackupPath}`
              : '导入完成，软件将自动重启')
          } else if (!result?.canceled && result?.error) {
            message.error(result.error)
          }
        } finally {
          setBackupBusy(false)
        }
      },
    })
  }

  const handleRunAutoBackupNow = async () => {
    setBackupBusy(true)
    try {
      const result = await window.api.runAutoBackupNow()
      if (result?.success) {
        message.success(`已写入自动备份槽位：${result.path}`)
      } else {
        message.error(result?.error || '自动备份失败')
      }
      await refreshBackupStatus()
    } finally {
      setBackupBusy(false)
    }
  }

  const handleCompactAutoBackups = async () => {
    setBackupBusy(true)
    try {
      const result = await window.api.compactAutoBackups()
      if (result?.success) {
        message.success(`自动备份已瘦身，释放 ${formatBytes(result.bytesFreed)}`)
      } else {
        message.error(result?.error || '自动备份瘦身失败')
      }
      await refreshBackupStatus()
    } finally {
      setBackupBusy(false)
    }
  }

  const handleExportDocumentList = async () => {
    const result = await window.api.exportDocumentList()
    if (result?.success) {
      message.success(`文献清单已导出：${result.path}`)
    } else if (result?.error) {
      message.error(result.error)
    }
  }

  const refreshDatabaseDiagnostics = async () => {
    setDatabaseMaintenanceBusy(true)
    try {
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
    } catch (error) {
      message.error(getErrorMessage(error, '读取数据库诊断失败'))
    } finally {
      setDatabaseMaintenanceBusy(false)
    }
  }

  useEffect(() => {
    if (activeSettingsSection !== 'data' || databaseMaintenanceBusy) return
    void refreshDatabaseDiagnostics()
  }, [activeSettingsSection])

  const handleExportDatabaseDiagnostics = async () => {
    setDatabaseMaintenanceBusy(true)
    try {
      const result = await window.api.exportDatabaseStorageDiagnostics()
      if (result.success) {
        message.success(result.path ? `诊断报告已导出：${result.path}` : result.message)
      } else if (result.error) {
        message.error(result.error)
      }
    } finally {
      setDatabaseMaintenanceBusy(false)
    }
  }

  const handleCompactDatabase = async () => {
    setDatabaseMaintenanceBusy(true)
    setDatabaseMaintenanceProgress(null)
    message.loading({ content: '正在压缩数据库，大库可能需要较长时间，请不要关闭软件...', key: 'database-maintenance', duration: 0 })
    try {
      const result = await window.api.compactDatabase()
      if (result.success) {
        const freedBytes = Math.max(0, Number(result.beforeBytes || 0) - Number(result.afterBytes || 0))
        message.success({ content: `${result.message}，释放 ${formatBytes(freedBytes)}`, key: 'database-maintenance', duration: 8 })
      } else {
        message.error({ content: result.error || result.message, key: 'database-maintenance', duration: 8 })
      }
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
    } finally {
      setDatabaseMaintenanceBusy(false)
    }
  }

  const handleOptimizeLegacyDatabase = async () => {
    if (!hasLegacySearchIndexMaintenance(databaseDiagnostics)) {
      message.info({ content: '搜索索引已经是新版结构，无需再次瘦身。', key: 'database-maintenance', duration: 4 })
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
      return
    }
    setDatabaseMaintenanceBusy(true)
    setDatabaseMaintenanceProgress(null)
    message.loading({ content: getSearchIndexMaintenanceLoadingText(databaseDiagnostics), key: 'database-maintenance', duration: 0 })
    try {
      const result = await window.api.rebuildLightweightSearchIndex()
      if (result.success) {
        message.success({ content: result.message, key: 'database-maintenance', duration: 10 })
      } else {
        message.error({ content: result.error || result.message, key: 'database-maintenance', duration: 8 })
      }
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
    } finally {
      setDatabaseMaintenanceBusy(false)
    }
  }

  const handleCleanupExternalPayloads = async () => {
    setDatabaseMaintenanceBusy(true)
    setDatabaseMaintenanceProgress(null)
    message.loading({ content: '正在清理未被数据库引用的外置大字段文件...', key: 'database-maintenance', duration: 0 })
    try {
      const result = await window.api.cleanupExternalPayloads()
      if (result.success) {
        message.success({ content: result.message, key: 'database-maintenance', duration: 10 })
      } else {
        message.error({ content: result.error || result.message, key: 'database-maintenance', duration: 8 })
      }
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
    } finally {
      setDatabaseMaintenanceBusy(false)
    }
  }

  const refreshPdfRepositoryStatus = async () => {
    setPdfRepositoryStatus(await window.api.listPdfRepositories())
  }

  const handleAddPdfRepository = async () => {
    setPdfRepositoryBusy(true)
    try {
      setPdfRepositoryStatus(await window.api.selectAndAddPdfRepository())
      message.success('已添加 PDF 原件仓库')
    } finally {
      setPdfRepositoryBusy(false)
    }
  }

  const handleRemovePdfRepository = async (repositoryId: string) => {
    setPdfRepositoryBusy(true)
    try {
      setPdfRepositoryStatus(await window.api.removePdfRepository(repositoryId))
      message.success('已移除仓库目录')
    } finally {
      setPdfRepositoryBusy(false)
    }
  }

  const handleIndexPdfRepositories = async () => {
    setPdfRepositoryBusy(true)
    try {
      const result = await window.api.indexPdfRepositories()
      await refreshPdfRepositoryStatus()
      message.success(`已找到 ${result.fileCount} 个文献库原件，匹配 ${result.matchedCount} 篇文献`)
    } catch (error) {
      message.error((error as Error)?.message || 'PDF 原件仓库索引失败')
    } finally {
      setPdfRepositoryBusy(false)
    }
  }

  const handleCleanupCompletedPdfAssets = async () => {
    setPdfRepositoryBusy(true)
    try {
      const result = await window.api.cleanupCompletedPdfAssets()
      message.success(`已清理 ${result.cleanedCount} 篇文献，释放 ${formatBytes(result.bytesFreed)}`)
    } catch (error) {
      message.error((error as Error)?.message || '清理 PDF 原图失败')
    } finally {
      setPdfRepositoryBusy(false)
    }
  }

  const selectedAiSavedProfile = llmProfiles.find((profile) => profile.id === selectedAiProviderId)
  const savedAiProviderKeys = new Set(llmProfiles.map((profile) => {
    const provider = String(profile.provider || profile.name || '').trim().toLowerCase()
    const baseUrl = String(profile.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase()
    return `${provider}|${baseUrl}`
  }))
  const visibleAiProviderPresets = AI_PROVIDER_PRESETS.filter((preset) => {
    const key = `${preset.name.trim().toLowerCase()}|${preset.baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`
    return !savedAiProviderKeys.has(key)
  })
  const currentAiProviderLabel = String(watchedLlmProvider || form.getFieldValue('llm_provider') || 'DeepSeek')
  const currentAiBaseUrl = String(watchedLlmBaseUrl || form.getFieldValue('llm_base_url') || '')
  const currentAiModel = String(watchedLlmModel || form.getFieldValue('llm_model') || '')
  const selectedVisionOcrProfile = visionOcrProfiles.find((profile) => profile.id === selectedOcrProviderId)
  const selectedOcrIsVision = selectedOcrProviderId === 'vision_draft' || !!selectedVisionOcrProfile
  const currentVisionOcrProviderLabel = String(watchedVisionOcrProvider || form.getFieldValue('vision_ocr_provider') || DEFAULT_VISION_PROVIDER.name)
  const currentVisionOcrBaseUrl = String(watchedVisionOcrBaseUrl || form.getFieldValue('vision_ocr_base_url') || DEFAULT_VISION_PROVIDER.baseUrl)
  const currentVisionOcrModel = String(watchedVisionOcrModel || form.getFieldValue('vision_ocr_model') || DEFAULT_VISION_MODEL)
  const currentVisionOcrConnectionSignature = createVisionOcrConnectionSignature({
    selectedId: watchedVisionOcrUseLlmConfig ? activeLlmProfileId : selectedOcrProviderId,
    useLlmConfig: watchedVisionOcrUseLlmConfig === true,
    activeLlmProfileId,
    baseUrl: watchedVisionOcrUseLlmConfig ? String(watchedLlmBaseUrl || '') : currentVisionOcrBaseUrl,
    model: watchedVisionOcrUseLlmConfig ? String(watchedLlmModel || '') : currentVisionOcrModel,
    apiKey: watchedVisionOcrUseLlmConfig ? String(watchedLlmApiKey || '') : String(watchedVisionOcrApiKey || ''),
  })
  const visionOcrConnectionVerified = visionOcrConnectionTest?.signature === currentVisionOcrConnectionSignature
  const isLocalPaddleDefault = defaultOcrEngine === 'local_paddle'
  const isPaddleCloudDefault = defaultOcrEngine === 'paddle'
  const currentDefaultOcrLabel = defaultOcrEngine === 'local_paddle'
    ? '本地 OCR'
    : defaultOcrEngine === 'vision_model'
    ? 'AI OCR'
    : '飞桨云端 OCR'

  const renderLocalPaddleEditor = () => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="settings-provider-header">
        <div>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}>本地 PaddleOCR</Text>
          <br />
          <Text type="secondary">{localPaddleStatus?.message || '正在读取本地 OCR 状态'}</Text>
          {localPaddleStatus?.installPath ? (
            <>
              <br />
              <Text type="secondary" className="settings-path-text">{localPaddleStatus.installPath}</Text>
            </>
          ) : null}
        </div>
        <Space wrap>
          <Button loading={localPaddleBusy} onClick={() => void refreshLocalPaddleStatus()}>刷新状态</Button>
          <Button
            type={isLocalPaddleDefault ? 'default' : 'primary'}
            disabled={!localPaddleStatus?.installed || isLocalPaddleDefault}
            onClick={() => void handleSetDefaultOcrProvider('local_paddle', 'local_paddle')}
          >
            {isLocalPaddleDefault ? '已设为默认' : '设为默认'}
          </Button>
        </Space>
      </div>
      <div className="settings-editor-block">
        <Text strong style={{ color: 'var(--gs-text-primary)' }}>运行环境</Text>
        <Text type="secondary">{localPaddleStatus?.runtime?.message || '正在检测本地 OCR 运行环境'}</Text>
        <div className="settings-runtime-grid">
          <Tag color={localPaddleStatus?.runtime?.supported ? 'success' : localPaddleStatus?.runtime?.state === 'outdated' ? 'warning' : 'default'}>
            {localPaddleStatus?.runtime?.supported ? '已支持 PP-OCRv6' : localPaddleStatus?.runtime?.state === 'outdated' ? '需要升级' : '未就绪'}
          </Tag>
          <Text type="secondary">Python：{localPaddleStatus?.runtime?.pythonPath || '未检测到'}</Text>
          <Text type="secondary">PaddleOCR：{localPaddleStatus?.runtime?.paddleocrVersion || `需要 ${localPaddleStatus?.runtime?.requiredPaddleOcrVersion || '3.7.0'}+`}</Text>
          <Text type="secondary">PaddleX：{localPaddleStatus?.runtime?.paddlexVersion || `需要 ${localPaddleStatus?.runtime?.requiredPaddlexVersion || '3.7.0'}+`}</Text>
          <Text type="secondary">PaddlePaddle：{localPaddleStatus?.runtime?.paddleVersion || `需要 ${localPaddleStatus?.runtime?.requiredPaddleVersion || '3.2.1'}+`}</Text>
        </div>
        <div className="settings-action-grid">
          <Button icon={<DownloadOutlined />} loading={localPaddleBusy} onClick={() => void handleInstallLocalPaddleRuntime()}>
            {localPaddleStatus?.runtime?.supported ? '重新安装/升级运行环境' : '安装/升级运行环境'}
          </Button>
          <Button href={PADDLE_OCR_OFFICIAL_URL} target="_blank" rel="noreferrer">PaddleOCR 官方页面</Button>
        </div>
      </div>
      <div className="settings-editor-block">
        <Text strong style={{ color: 'var(--gs-text-primary)' }}>模型下载</Text>
        <Text type="secondary">点击下载即可，程序会直接从 Paddle 官方模型源获取 PP-OCRv6 检测与识别模型；模型不会进入主安装包。</Text>
        <div className="settings-action-grid">
          <Button type="primary" icon={<DownloadOutlined />} loading={localPaddleBusy} onClick={() => void handleDownloadLocalPaddle()}>下载/修复本地 OCR</Button>
          <Button href={PADDLE_OCR_OFFICIAL_URL} target="_blank" rel="noreferrer">PaddleOCR 官方页面</Button>
        </div>
      </div>
      <div className="settings-editor-block">
        <Text strong style={{ color: 'var(--gs-text-primary)' }}>模型大小</Text>
        <Text type="secondary">这里选择的是 PP-OCRv6 本地模型大小，不是 PaddleOCR-VL 或 PP-Structure 大模型。</Text>
        <Form.Item
          label="PP-OCRv6 档位"
          name="local_paddle_ocr_size"
          extra="默认推荐中（官方 small）；切换档位后点击下载/修复会安装对应检测与识别模型。"
          style={{ marginBottom: 0 }}
        >
          <Select
            onChange={(value) => void handleChangeLocalPaddleSize(String(value))}
            options={LOCAL_PADDLE_OCR_SIZE_OPTIONS.map((option) => ({
              value: option.value,
              label: `${option.label}（${option.officialName}，${option.sizeText}）· ${option.desc}`,
            }))}
          />
        </Form.Item>
        <div className="settings-local-model-list">
          {LOCAL_PADDLE_OCR_SIZE_OPTIONS.map((option) => (
            <div className="settings-local-model-row" key={option.value}>
              <Text strong style={{ color: 'var(--gs-text-primary)' }}>{option.label}：{option.officialName} · {option.sizeText}</Text>
              <Text type="secondary">{option.desc}</Text>
              <div className="settings-local-model-specs">
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>{option.hardwareTitle}</Text>
                <Text type="secondary">{option.hardware}</Text>
              </div>
            </div>
          ))}
        </div>
      </div>
      {localPaddleDownloadProgress?.state === 'error' ? (
        <Alert
          type="warning"
          showIcon
          message="自动下载没有完成"
          description={(
            <Space direction="vertical" size={4}>
              <Text type="secondary">{localPaddleDownloadProgress.error || localPaddleDownloadProgress.message || '请稍后重试，或打开官方页面查看下载说明。'}</Text>
              <a href={PADDLE_OCR_OFFICIAL_URL} target="_blank" rel="noreferrer"><LinkOutlined /> 打开 PaddleOCR 官方页面</a>
            </Space>
          )}
        />
      ) : null}
      {localPaddleDownloadProgress ? (
        <Progress
          percent={Math.round((localPaddleDownloadProgress.progress || 0) * 100)}
          status={localPaddleDownloadProgress.state === 'error' ? 'exception' : localPaddleDownloadProgress.state === 'completed' ? 'success' : 'active'}
          size="small"
          format={() => localPaddleDownloadProgress.message || localPaddleDownloadProgress.state}
        />
      ) : null}
    </Space>
  )

  const renderPaddleCloudEditor = () => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="settings-provider-header">
        <div>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}>飞桨云端 OCR</Text>
          <br />
          <Text type="secondary">当前默认 OCR：{currentDefaultOcrLabel}</Text>
        </div>
        <Space wrap>
          <Button
            type={isPaddleCloudDefault ? 'default' : 'primary'}
            disabled={isPaddleCloudDefault}
            onClick={() => void handleSetDefaultOcrProvider('paddle', 'paddle')}
          >
            {isPaddleCloudDefault ? '已设为默认' : '设为默认'}
          </Button>
        </Space>
      </div>
      <Alert
        type="info"
        showIcon
        message="用于 OCR 文字识别，支持多 Token 自动接力"
        description={(
          <Space direction="vertical" size={4}>
            <Text type="secondary">飞桨 PaddleOCR API Token 可在飞桨 AI Studio 的 PaddleOCR 服务页申请。</Text>
            <Text type="secondary">软件会连续使用当前 Token。若接口返回「请求频率过高」(429 限流)，只短暂冷却约 90 秒，并不是当日额度用完；真正额度用尽才会标记「今日额度已用完」并当天改用后面的 Token。Token 无效会一直跳过，直到你重新启用或替换。长 PDF 最多按 100 页分段，成功分段立即保存，只重试失败分段。</Text>
            <a href={PADDLE_OCR_APPLY_URL} target="_blank" rel="noreferrer">
              <LinkOutlined /> 前往申请飞桨 PaddleOCR API
            </a>
          </Space>
        )}
      />
      <Form.Item label="添加 API Token" name="paddleocr_api_key" extra={credentialHints.paddleocr_api_key || 'Token 只会加密保存在本机；重复 Token 不会再次添加。'}>
        <Input.Password
          prefix={<KeyOutlined />}
          placeholder="粘贴一个新的 PaddleOCR API Token"
          onPressEnter={() => void handleAddPaddleOcrToken()}
          suffix={<Button type="link" size="small" loading={paddleOcrTokenBusy} onClick={() => void handleAddPaddleOcrToken()}>添加</Button>}
        />
      </Form.Item>
      <List
        size="small"
        bordered
        loading={paddleOcrTokenBusy}
        locale={{ emptyText: '尚未添加 PaddleOCR API Token' }}
        dataSource={paddleOcrTokenPool.entries}
        renderItem={(entry) => {
          const statusLabel = entry.status === 'active'
            ? '当前使用'
            : entry.status === 'quota_exhausted'
              ? '今日额度已用完'
              : entry.status === 'rate_limited'
                ? '限流冷却中'
                : entry.status === 'invalid'
                  ? 'Token 无效'
                  : '待命'
          const statusColor = entry.status === 'active'
            ? 'green'
            : entry.status === 'quota_exhausted'
              ? 'orange'
              : entry.status === 'rate_limited'
                ? 'gold'
                : entry.status === 'invalid'
                  ? 'red'
                  : 'default'
          return (
            <List.Item
              actions={[
                <Switch
                  key="enabled"
                  size="small"
                  checked={entry.enabled}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  onChange={(enabled) => void handleSetPaddleOcrTokenEnabled(entry.id, enabled)}
                />,
                <Popconfirm key="delete" title="删除这个 Token？删除后无法恢复。" onConfirm={() => void handleRemovePaddleOcrToken(entry.id)}>
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={`删除 ${entry.label}`} />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={<Space size={8}><Text>{entry.label}</Text><Tag color={statusColor}>{statusLabel}</Tag></Space>}
                description={entry.lastError
                  ? `末四位 ${entry.last4} · ${entry.lastError}`
                  : `末四位 ${entry.last4}${entry.primary ? ' · 兼容原有配置' : ''}`}
              />
            </List.Item>
          )
        }}
      />
      <div className="settings-form-grid">
        <Form.Item label="PDF 异步 OCR 模型" name="ocr_async_model" extra="默认使用 PaddleOCR-VL-1.6；可拉取官方模型，也可手动输入模型 ID。">
          <AutoComplete options={paddleOcrModelOptions.map((model) => ({ value: model, label: model }))}>
            <Input suffix={<Button type="text" size="small" loading={paddleOcrModelsLoading} onClick={() => void fetchPaddleOcrModelOptions()}>拉取</Button>} />
          </AutoComplete>
        </Form.Item>
        <Form.Item label="上传超时（秒）" name="ocr_upload_timeout_seconds" extra="填 0 表示不限制客户端上传时长。">
          <InputNumber min={0} max={86400} step={60} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="单本 OCR 超时（分钟）" name="ocr_document_timeout_minutes" extra="单本超时则跳过并继续其他书；0=不限制。默认 45。">
          <InputNumber min={0} max={720} step={5} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="图片上传最长边" name="ocr_max_image_side" extra="越大越清晰，但上传更慢。">
          <InputNumber min={800} max={4096} step={100} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="图片 JPEG 质量" name="ocr_jpeg_quality" extra="建议 75-88。">
          <InputNumber min={50} max={95} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="导入前压缩 PDF" name="pdf_compression_enabled" valuePropName="checked" extra="导入 PDF 后先压缩为库内原文。">
          <Switch />
        </Form.Item>
        <Form.Item label="PDF 压缩阈值（MB）" name="pdf_compression_min_size_mb" extra="大于该体积才压缩；默认 10 MB。">
          <InputNumber min={1} max={1024} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="PDF 压缩质量" name="pdf_compression_quality" extra="建议 75-88；默认 80。">
          <InputNumber min={50} max={95} style={{ width: '100%' }} />
        </Form.Item>
      </div>
    </Space>
  )

  const renderVisionOcrEditor = () => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="settings-provider-header">
        <div>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}>{currentVisionOcrProviderLabel || 'AI OCR'}</Text>
          <br />
          <Text type="secondary">{currentVisionOcrModel || '未设置模型'} · {currentVisionOcrBaseUrl || '未设置接口地址'}</Text>
        </div>
        <Space wrap className="settings-provider-actions">
          <Button loading={visionOcrProfileBusy} onClick={() => void refreshVisionOcrProfiles()}>刷新</Button>
          <Button icon={<LinkOutlined />} loading={visionOcrConnectionTesting} onClick={() => void handleTestVisionOcrConnection()}>测试连接</Button>
          <Button type="primary" loading={visionOcrProfileBusy} disabled={!visionOcrConnectionVerified || watchedVisionOcrUseLlmConfig === true} onClick={() => void handleSaveCurrentVisionOcrProfile()}>保存配置</Button>
          <Button
            disabled={visionOcrProfileBusy || !selectedVisionOcrProfile?.connectionTest?.verified || !visionOcrConnectionVerified || (defaultOcrEngine === 'vision_model' && activeOcrProviderId === selectedVisionOcrProfile.id)}
            onClick={() => void handleSetSelectedVisionOcrAsDefault()}
          >
            设为默认 OCR
          </Button>
          <Popconfirm
            title={selectedVisionOcrProfile?.id === activeVisionOcrProfileId ? '删除当前视觉 OCR 配置后，将自动切换到其他配置或飞桨云端 OCR。' : '删除这个视觉 OCR 服务商配置？'}
            disabled={!selectedVisionOcrProfile || visionOcrProfileBusy}
            onConfirm={() => selectedVisionOcrProfile ? void handleDeleteVisionOcrProfile(selectedVisionOcrProfile.id) : undefined}
          >
            <Button danger disabled={!selectedVisionOcrProfile || visionOcrProfileBusy}>删除</Button>
          </Popconfirm>
        </Space>
      </div>
      <Alert
        type="info"
        showIcon
        message="用于古籍、报纸和复杂版面的视觉理解 OCR"
        description={(
          <Space direction="vertical" size={4}>
            <Text type="secondary">填写 OpenAI-compatible 视觉模型接口即可接入豆包、火山方舟或其他兼容模型。</Text>
            <Space wrap>
              <a href={VOLCENGINE_ARK_QUICKSTART_URL} target="_blank" rel="noreferrer"><LinkOutlined /> 官方快速开始</a>
              <a href={VOLCENGINE_ARK_API_KEY_URL} target="_blank" rel="noreferrer"><LinkOutlined /> API Key 管理</a>
              <a href={VOLCENGINE_ARK_ENDPOINT_URL} target="_blank" rel="noreferrer"><LinkOutlined /> 接入点说明</a>
            </Space>
          </Space>
        )}
      />
      <Alert
        type={visionOcrConnectionVerified ? 'success' : 'warning'}
        showIcon
        message={visionOcrConnectionVerified ? '连接测试已通过，可以保存和使用此 AI OCR 配置' : '连接尚未测试，或配置已在测试后发生变化'}
        description={visionOcrConnectionVerified && visionOcrConnectionTest?.testedAt
          ? `测试时间：${new Date(visionOcrConnectionTest.testedAt).toLocaleString()}`
          : '请先完成一次真实图片请求测试；修改 Base URL、模型、API Key 或跟随方式后需要重新测试。'}
      />
      <div className="settings-form-grid">
        <Form.Item label="服务商名称" name="vision_ocr_provider">
          <Input placeholder="例如：豆包" />
        </Form.Item>
        <Form.Item label="视觉服务商预设">
          <Space.Compact style={{ width: '100%' }}>
            <Select
              value={getVisionProviderSelectValue(watchedVisionOcrProvider)}
              placeholder="选择视觉服务商"
              onChange={handleVisionProviderChange}
              options={[
                ...VISION_PROVIDER_PRESETS.map((item) => ({ value: item.name, label: item.name })),
                { value: 'custom', label: '自定义' },
              ]}
            />
            <Button onClick={applyLlmConfigToVisionOcr}>套用 AI 配置</Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item label="API Base URL" name="vision_ocr_base_url" extra="例如：https://ark.cn-beijing.volces.com/api/v3">
          <Input prefix={<ApiOutlined />} placeholder="https://ark.cn-beijing.volces.com/api/v3" />
        </Form.Item>
        <Form.Item label="API Key" name="vision_ocr_api_key" extra={credentialHints.vision_ocr_api_key || undefined}>
          <Input.Password prefix={<KeyOutlined />} placeholder={credentialHints.vision_ocr_api_key ? '留空将保留已保存 Key' : '请输入视觉模型 API Key'} />
        </Form.Item>
        <Form.Item label="视觉模型 ID" name="vision_ocr_model" extra="填写服务商控制台中的模型 ID；专属接入点才填写 endpoint ID。">
          <AutoComplete
            showSearch
            allowClear
            placeholder="doubao-seed-2-0-pro-260215"
            onDropdownVisibleChange={(open) => {
              if (open && visionModelOptions.length === 0) void fetchModelOptions('vision')
            }}
            onFocus={() => {
              if (visionModelOptions.length === 0) void fetchModelOptions('vision')
            }}
            options={visionModelOptions.map((model) => ({ value: model, label: model }))}
          >
            <Input suffix={<Button type="text" size="small" loading={visionModelsLoading} onClick={() => void fetchModelOptions('vision')}>拉取</Button>} />
          </AutoComplete>
        </Form.Item>
        <Form.Item label="跟随 AI 配置" name="vision_ocr_use_llm_config" valuePropName="checked" extra="实际 OCR 调用时使用当前 AI 配置。">
          <Switch />
        </Form.Item>
        <Form.Item label="并发页数" name="vision_ocr_concurrency" extra="上限 20。">
          <InputNumber min={1} max={20} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="单页超时（秒）" name="vision_ocr_timeout_seconds" extra="超过该时间会中断本页。">
          <InputNumber min={30} max={900} step={30} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="上传最长边" name="vision_ocr_max_image_side" extra="越大越清晰，但越慢。">
          <InputNumber min={800} max={4096} step={100} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="JPEG 质量" name="vision_ocr_jpeg_quality" extra="建议 75-88。">
          <InputNumber min={50} max={95} style={{ width: '100%' }} />
        </Form.Item>
      </div>
    </Space>
  )

  const renderOcrEditor = () => {
    if (selectedOcrProviderId === 'paddle') return renderPaddleCloudEditor()
    if (selectedOcrIsVision) return renderVisionOcrEditor()
    return renderPaddleCloudEditor()
  }

  const selectedAiKeyExtra = (() => {
    if (selectedAiSavedProfile) {
      if (selectedAiSavedProfile.credential?.configured) {
        const last4 = selectedAiSavedProfile.credential.last4 || '****'
        return `该服务商已单独保存 Key（末四位 ${last4}）。留空则保留，填写新 Key 后点「保存配置」可更新。`
      }
      if (selectedAiSavedProfile.id === activeLlmProfileId && credentialHints.llm_api_key) {
        return `该服务商还没有独立 Key；右侧显示的「当前全局 Key」来自正在使用的 AI，不是每个服务商都有。请填写该服务商自己的 Key 并保存。`
      }
      return '该服务商尚未保存 API Key，请填写后点「保存配置」。'
    }
    if (String(selectedAiProviderId || '').startsWith('preset:')) {
      return '这是预设模板，尚未加入你的服务商列表。填写 Key 后点「保存配置」才会真正保存。'
    }
    if (selectedAiProviderId === 'custom') {
      return '自定义服务商：填写完整信息与 Key 后点「保存配置」。'
    }
    return credentialHints.llm_api_key
      ? `${credentialHints.llm_api_key}（这是当前全局 Key；切换左侧服务商后以各服务商状态为准）`
      : '请输入 API Key'
  })()

  const selectedAiKeyPlaceholder = selectedAiSavedProfile?.credential?.configured
    || (selectedAiSavedProfile?.id === activeLlmProfileId && credentialHints.llm_api_key)
    ? '留空将保留已保存 Key'
    : '请输入该服务商的 API Key'

  const renderAiEditor = () => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="settings-provider-header">
        <div>
          <Text strong style={{ color: 'var(--gs-text-primary)' }}>{currentAiProviderLabel || 'AI 服务商'}</Text>
          <br />
          <Text type="secondary">{currentAiModel || '未设置模型'} · {currentAiBaseUrl || '未设置接口地址'}</Text>
        </div>
        <Space wrap className="settings-provider-actions">
          <Button loading={llmProfileBusy} onClick={() => void refreshLlmProfiles()}>刷新</Button>
          <Button type="primary" loading={llmProfileBusy} onClick={() => void handleSaveCurrentLlmProfile()}>保存配置</Button>
          <Button disabled={!selectedAiSavedProfile || selectedAiSavedProfile.id === activeLlmProfileId || llmProfileBusy} onClick={() => void handleSetSelectedLlmAsCurrent()}>设为当前</Button>
          <Popconfirm
            title={selectedAiSavedProfile?.id === activeLlmProfileId ? '当前 AI 服务商正在使用中，不能删除。' : '删除这个 AI 服务商配置？'}
            disabled={!selectedAiSavedProfile || selectedAiSavedProfile.id === activeLlmProfileId || llmProfileBusy}
            onConfirm={() => selectedAiSavedProfile ? void handleDeleteLlmProfile(selectedAiSavedProfile.id) : undefined}
          >
            <Button danger disabled={!selectedAiSavedProfile || selectedAiSavedProfile.id === activeLlmProfileId || llmProfileBusy}>删除</Button>
          </Popconfirm>
        </Space>
      </div>
      <Alert
        type="info"
        showIcon
        message="用于智能问答、翻译、摘要和元数据提取"
        description={(
          <Space direction="vertical" size={4}>
            <Text type="secondary">
              左侧灰色「预设」只是模板；绿色「已保存 Key」才表示该服务商有独立密钥。点「保存配置」后才会写入左侧已保存列表。
            </Text>
            <a href={DEEPSEEK_APPLY_URL} target="_blank" rel="noreferrer">
              <LinkOutlined /> 前往申请 DeepSeek API
            </a>
          </Space>
        )}
      />
      <div className="settings-form-grid">
        <Form.Item label="供应商名称" name="llm_provider">
          <Input placeholder="例如：DeepSeek" />
        </Form.Item>
        <Form.Item label="API Base URL" name="llm_base_url">
          <Input prefix={<ApiOutlined />} placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item label="API Key" name="llm_api_key" extra={selectedAiKeyExtra}>
          <Input.Password prefix={<KeyOutlined />} placeholder={selectedAiKeyPlaceholder} />
        </Form.Item>
        <Form.Item label="默认模型" name="llm_model">
          <AutoComplete
            showSearch
            allowClear
            placeholder="deepseek-chat"
            onDropdownVisibleChange={(open) => {
              if (open && llmModelOptions.length === 0) void fetchModelOptions('llm')
            }}
            onFocus={() => {
              if (llmModelOptions.length === 0) void fetchModelOptions('llm')
            }}
            options={llmModelOptions.map((model) => ({ value: model, label: model }))}
          >
            <Input suffix={<Button type="text" size="small" loading={llmModelsLoading} onClick={() => void fetchModelOptions('llm')}>拉取</Button>} />
          </AutoComplete>
        </Form.Item>
      </div>
    </Space>
  )

  return (
    <div className="settings-view">
      <Title level={3} style={{ color: 'var(--gs-gold)', fontFamily: "'Noto Serif SC', serif" }}>
        设置
      </Title>

      <Form form={form} layout="vertical" onFinish={() => void handleSave()} onFieldsChange={markSettingsDirty}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.key}
                type="button"
                className={`settings-nav-item${activeSettingsSection === section.key ? ' active' : ''}`}
                aria-current={activeSettingsSection === section.key ? 'page' : undefined}
                onClick={() => setActiveSettingsSection(section.key)}
              >
                {section.icon}
                <span>{section.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
        <section className="settings-section" hidden={activeSettingsSection !== 'automation'}>
          <div className="settings-section-title">
            <ThunderboltOutlined /> 自动化
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>导入后自动 OCR</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>导入文献后，自动调用 PaddleOCR 进行文字识别。</Text>
              </div>
              <Switch checked={autoOcr} onChange={(checked) => { setAutoOcr(checked); markSettingsDirty() }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>OCR 后自动 AI 分析</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>识别完成后，自动分类并写入元数据；标签生成由下方绑定开关控制。</Text>
              </div>
              <Switch checked={autoAi} onChange={(checked) => { setAutoAi(checked); markSettingsDirty() }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>OCR 完成后自动删除 PDF 原图</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  只删除软件数据目录（storage）内的 PDF 副本和页图；绝不删除 PDF 原件仓库、NAS 或「仅登记路径」指向的外部源文件。
                </Text>
              </div>
              <Switch checked={autoDeletePdfAssets} onChange={(checked) => { setAutoDeletePdfAssets(checked); markSettingsDirty() }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>校对默认使用版式还原</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>开启后校对页优先展示原貌版式，适合古籍、报纸和扫描影印文献。</Text>
              </div>
              <Switch checked={preferFacsimileProofLayout} onChange={(checked) => { setPreferFacsimileProofLayout(checked); markSettingsDirty() }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>默认使用阅读模式</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  开启后，普通文献首次打开默认进入阅读模式；关闭则默认校对模式。你在该篇里手动切换过阅读/校对后，以后打开仍以你最后一次手动选择为准。
                </Text>
              </div>
              <Switch checked={preferReadModeOnOpen} onChange={(checked) => { setPreferReadModeOnOpen(checked); markSettingsDirty() }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>元数据绑定标签</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>开启后，作者、年代、类型、关键词等元数据会自动同步为标签；关闭后只保存元数据。</Text>
              </div>
              <Switch
                checked={metadataTagBindingEnabled}
                onChange={(checked) => {
                  metadataTagBindingEnabledRef.current = checked
                  setMetadataTagBindingEnabled(checked)
                  markSettingsDirty()
                }}
              />
            </div>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'shortcuts'}>
          <div className="settings-section-title">
            <KeyOutlined /> 快捷键
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="shortcut-grid">
              {SHORTCUT_ITEMS.map((item) => (
                <div className="shortcut-row" key={item.action}>
                  <div className="shortcut-copy">
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>{item.label}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{item.hint}</Text>
                  </div>
                  <div className="shortcut-controls">
                    <Form.Item
                      name={SHORTCUT_SETTING_KEYS[item.action]}
                      style={{ margin: 0 }}
                      normalize={(value) => normalizeShortcutInput(String(value || ''))}
                    >
                      <ShortcutRecorder placeholder={DEFAULT_SHORTCUTS[item.action]} />
                    </Form.Item>
                    <Tooltip title={`还原默认：${DEFAULT_SHORTCUTS[item.action]}` }>
                      <Button
                        aria-label={`还原${item.label}默认快捷键`}
                        icon={<ReloadOutlined />}
                        onClick={() => resetShortcutToDefault(item.action)}
                        style={{ width: 32, minWidth: 32, padding: 0 }}
                      />
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
            <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
              可写 Ctrl+F、Ctrl+D、Alt+A、Esc、ArrowLeft。阅读器里上下方向键固定用于滚动正文，输入框内保留系统默认编辑快捷键。「复制直接引用」需先选中正文。
            </Text>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'pdfRepository'}>
          <div className="settings-section-title">
            <FolderOpenOutlined /> PDF 原件仓库
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="PDF 原件仓库只会被读取；补回时默认复制进软件目录"
              description="可以添加 NAS、移动硬盘、网盘同步目录等，软件会只读扫描并匹配已导入文献的 PDF。一键补回前会自动重扫仓库（刚上传的云文件也能对上）；也可点「立即扫描」提前建好索引。开启下方「仅登记路径」后，补回不再复制大文件，速度更快，但依赖外盘/NAS 保持可访问。"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ minWidth: 0, paddingRight: 12 }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>补回原文时仅登记路径（不复制）</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  开启后：从仓库或手动选择 PDF 补回时，只把外部路径登记到文献，不再整本拷贝进软件目录。大书可秒开；外盘拔掉或文件移动后需重新补回。关闭则为稳妥复制模式。
                </Text>
              </div>
              <Switch
                checked={pdfRestoreLinkOnly}
                onChange={(checked) => {
                  setPdfRestoreLinkOnly(checked)
                  markSettingsDirty()
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>
                  已匹配 {pdfRepositoryStatus?.stats.fileCount || 0} 个文献库 PDF 原件
                </Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  总大小 {formatBytes(pdfRepositoryStatus?.stats.totalBytes)}；上次扫描 {formatDateTime(pdfRepositoryStatus?.lastIndexedAt)}
                  。向仓库新增 PDF 后无需每次手点扫描——补回时会自动刷新索引；批量补回会合并为一次扫描。
                </Text>
              </div>
              <Space wrap>
                <Button icon={<FolderOpenOutlined />} loading={pdfRepositoryBusy} onClick={() => void handleAddPdfRepository()}>
                  添加目录
                </Button>
                <Button icon={<ReloadOutlined />} loading={pdfRepositoryBusy} onClick={() => void handleIndexPdfRepositories()}>
                  立即扫描
                </Button>
                <Popconfirm
                  title="只会删除软件数据目录内的 PDF 副本和页图缓存。绝不删除 PDF 原件仓库、NAS 或链接的外部源文件。确定清理已完成 OCR 的 PDF 原图吗？"
                  okText="清理"
                  cancelText="取消"
                  onConfirm={() => void handleCleanupCompletedPdfAssets()}
                >
                  <Button danger icon={<DeleteOutlined />} loading={pdfRepositoryBusy}>
                    清理 OCR 原图
                  </Button>
                </Popconfirm>
              </Space>
            </div>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {(pdfRepositoryStatus?.repositories || []).length > 0 ? (pdfRepositoryStatus?.repositories || []).map((repository) => (
                <div
                  key={repository.repositoryId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: 8,
                    alignItems: 'center',
                    padding: '8px 10px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Text ellipsis title={repository.displayPath} style={{ color: 'var(--gs-text-secondary)' }}>{repository.displayPath}</Text>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void handleRemovePdfRepository(repository.repositoryId)} />
                </div>
              )) : (
                <Text type="secondary">尚未添加 PDF 原件仓库目录。</Text>
              )}
            </Space>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'batch'}>
          <div className="settings-section-title">
            <SettingOutlined /> 批量处理
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>批大小</Text>
                <InputNumber min={1} max={20} value={batchSize} onChange={(value) => { setBatchSize(value || 5); markSettingsDirty() }} style={{ width: 80 }} />
              </div>
              <Slider min={1} max={20} value={batchSize} onChange={(value) => { setBatchSize(value); markSettingsDirty() }} />
              <Text type="secondary" style={{ fontSize: 12 }}>建议 3 到 10；数值越大同时提交的文献越多，若服务端返回请求过多，可适当调低。</Text>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>失败重试次数</Text>
                <InputNumber min={0} max={5} value={retryCount} onChange={(value) => { setRetryCount(value ?? 3); markSettingsDirty() }} style={{ width: 80 }} />
              </div>
              <Slider min={0} max={5} value={retryCount} onChange={(value) => { setRetryCount(value); markSettingsDirty() }} />
              <Text type="secondary" style={{ fontSize: 12 }}>处理失败后会自动重试，适合网络不稳定时使用。</Text>
            </div>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'data'}>
          <div className="settings-section-title">
            <DatabaseOutlined /> 数据管理
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="备份会保留数据库、OCR 文本、标签和配置"
              description="自动备份默认不包含原文 PDF/EPUB，完整迁移请使用导出完整备份。"
            />

            <Card size="small" style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>数据库空间管理</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    诊断报告只包含表行数、文件大小和索引统计，不会导出正文、标题、文件路径或密钥。
                  </Text>
                </div>
                <Button size="small" icon={<ReloadOutlined />} loading={databaseMaintenanceBusy} onClick={() => void refreshDatabaseDiagnostics()}>
                  刷新
                </Button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 12 }}>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>数据库</Text>
                  <br />
                  <Text strong>{formatBytes(databaseDiagnostics?.databaseBytes)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {databaseCompactionWorthwhile ? '可压缩空闲页' : '少量空闲页（正常）'}
                  </Text>
                  <br />
                  <Text strong>{formatBytes(databaseDiagnostics?.freelistBytes)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>旧检索索引行数</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.ngramRows || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>旧单字索引</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.singleCharNgramRows || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>新版全文索引</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.searchSegmentsTrigramRows || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>维护阶段</Text>
                  <br />
                  <Text strong>{formatDatabaseMaintenanceStage(databaseDiagnostics?.maintenanceState.stage)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>存储模型</Text>
                  <br />
                  <Text strong>{formatDatabaseStorageModel(databaseDiagnostics?.storageModelVersion)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>外置大字段（压缩后）</Text>
                  <br />
                  <Text strong>{formatBytes(databaseDiagnostics?.externalPayloads.bytes || 0)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>未引用大字段</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.externalPayloads.orphanedFileCount || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>缺失大字段</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.externalPayloads.missingReferencedFileCount || 0).toLocaleString()}</Text>
                </div>
              </div>

              <Text type="secondary" style={{ fontSize: 12 }}>
                外置大字段按 gzip 压缩并按内容去重保存，显示的是实际磁盘占用；迁移前占用通常会明显更大。
              </Text>
              {databaseDiagnostics?.storageLayers?.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
                  {databaseDiagnostics.storageLayers.map((layer) => (
                    <div key={layer.kind} style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{formatDatabaseStorageLayerLabel(layer.kind, layer.label)}</Text>
                      <br />
                      <Text strong>{formatCount(layer.rowCount)} 行</Text>
                    </div>
                  ))}
                </div>
              ) : null}

              {databaseDiagnostics?.warnings.length ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={databaseDiagnostics.warnings.join('；')}
                />
              ) : null}

              {databaseMaintenanceProgress ? (
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(214,168,95,0.08)', border: '1px solid rgba(214,168,95,0.24)', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>
                      {databaseMaintenanceProgress.status === 'completed' ? '数据库优化完成' : '数据库优化进行中'}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatCount(databaseMaintenanceProgress.completedCount)} / {formatCount(databaseMaintenanceProgress.totalCount)}
                    </Text>
                  </div>
                  <Progress
                    percent={Math.max(0, Math.min(100, Math.round(Number(databaseMaintenanceProgress.progress || 0) * 100)))}
                    size="small"
                    status={databaseMaintenanceProgress.status === 'error' ? 'exception' : databaseMaintenanceProgress.status === 'completed' ? 'success' : 'active'}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {databaseMaintenanceProgress.errorMessage
                      ? `优化失败：${databaseMaintenanceProgress.errorMessage}`
                      : databaseMaintenanceProgress.message || '正在分批处理搜索索引'}
                  </Text>
                </div>
              ) : null}

              <Space wrap>
                <Popconfirm
                  title={getSearchIndexMaintenancePrompt(databaseDiagnostics)}
                  okText="开始优化"
                  cancelText="取消"
                  disabled={!hasLegacySearchIndexMaintenance(databaseDiagnostics) || databaseMaintenanceBusy}
                  onConfirm={() => void handleOptimizeLegacyDatabase()}
                >
                  <Button
                    type="primary"
                    icon={<DatabaseOutlined />}
                    loading={databaseMaintenanceBusy}
                    disabled={!hasLegacySearchIndexMaintenance(databaseDiagnostics)}
                    title={hasLegacySearchIndexMaintenance(databaseDiagnostics) ? undefined : '搜索索引和页面大字段已经是新版结构，无需再次瘦身'}
                  >
                    一键企业级升级与瘦身
                  </Button>
                </Popconfirm>
                <Button icon={<ExportOutlined />} loading={databaseMaintenanceBusy} onClick={() => void handleExportDatabaseDiagnostics()}>
                  导出诊断报告
                </Button>
                <Popconfirm
                  title="只删除外置大字段目录中已经没有任何数据库记录引用的文件；不会删除文献、PDF、OCR 文本或数据库记录。"
                  okText="清理"
                  cancelText="取消"
                  onConfirm={() => void handleCleanupExternalPayloads()}
                >
                  <Button
                    icon={<DatabaseOutlined />}
                    loading={databaseMaintenanceBusy}
                    disabled={!databaseDiagnostics?.externalPayloads.orphanedFileCount}
                  >
                    清理未引用大字段
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={databaseCompactionWorthwhile
                    ? '压缩数据库可能需要较长时间和额外临时空间，过程中请不要强制退出软件。'
                    : '当前只有少量 SQLite 空闲页，属于正常写入碎片，暂时不需要压缩。'}
                  okText="压缩"
                  cancelText="取消"
                  disabled={!databaseCompactionWorthwhile || databaseMaintenanceBusy}
                  onConfirm={() => void handleCompactDatabase()}
                >
                  <Button
                    icon={<DatabaseOutlined />}
                    loading={databaseMaintenanceBusy}
                    disabled={!databaseCompactionWorthwhile}
                    title={databaseCompactionWorthwhile ? undefined : '少量空闲页会被数据库自动复用，无需压缩'}
                  >
                    压缩数据库
                  </Button>
                </Popconfirm>
              </Space>
            </Card>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 16, alignItems: 'start' }}>
              <div>
                {(backupStatus?.legacyCredentialRiskCount || 0) > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={`发现 ${backupStatus?.legacyCredentialRiskCount || 0} 个旧格式自动备份`}
                    description="这些备份生成时尚未记录凭据排除证明。软件不会自动删除它们；请先生成新版备份并确认可恢复，再自行处理旧备份。"
                  />
                ) : null}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>定时自动备份</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      当前保留 {autoBackupSlotCount} 个槽位，下次写入槽位 {Math.max(1, Math.min(autoBackupSlotCount, backupStatus?.nextSlot || 1))}。
                    </Text>
                  </div>
                    <Switch
                      checked={autoBackupEnabled}
                      onChange={updateAutoBackupEnabled}
                      loading={backupBusy}
                    />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>备份间隔（小时）</Text>
                    <InputNumber
                      min={1}
                      max={168}
                      value={autoBackupInterval}
                      onChange={updateAutoBackupInterval}
                      style={{ width: 96 }}
                    />
                  </div>
                  <Slider
                    min={1}
                    max={168}
                    value={autoBackupInterval}
                    onChange={updateAutoBackupInterval}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    上次备份：{formatDateTime(backupStatus?.lastBackupAt)}；下次预计：{formatDateTime(backupStatus?.nextBackupAt)}
                  </Text>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>自动备份槽位数量</Text>
                    <InputNumber
                      min={1}
                      max={3}
                      value={autoBackupSlotCount}
                      onChange={updateAutoBackupSlotCount}
                      style={{ width: 96 }}
                    />
                  </div>
                  <Slider
                    min={1}
                    max={3}
                    marks={{ 1: '1', 2: '2', 3: '3' }}
                    value={autoBackupSlotCount}
                    onChange={updateAutoBackupSlotCount}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    数量越少越省空间；调小后会自动删除超出数量的旧槽位。
                  </Text>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16, padding: '10px 12px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <div>
                    <Text strong style={{ color: 'var(--gs-text-primary)' }}>自动备份包含原文文件</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      关闭后自动备份会很小，不影响当前阅读和检索；需要迁移到新电脑时请使用“导出完整备份”。
                    </Text>
                  </div>
                  <Switch
                    checked={autoBackupIncludeStorage}
                    onChange={updateAutoBackupIncludeStorage}
                    loading={backupBusy}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, autoBackupSlotCount || 3))}, minmax(0, 1fr))`, gap: 8, marginBottom: 16 }}>
                  {(backupStatus?.slots || []).slice(0, Math.max(1, Math.min(3, autoBackupSlotCount || 3))).map((slot) => (
                    <div
                      key={slot.slot}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 6,
                        padding: 8,
                        background: slot.exists ? 'rgba(82,196,26,0.08)' : 'rgba(255,255,255,0.03)',
                        minHeight: 74,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Text strong style={{ color: 'var(--gs-text-primary)', fontSize: 13 }}>槽位 {slot.slot}</Text>
                        <Tag color={slot.exists ? 'green' : 'default'} style={{ margin: 0 }}>{slot.exists ? '已有' : '空'}</Tag>
                      </div>
                      <Text type="secondary" style={{ fontSize: 11 }}>{formatDateTime(slot.timestamp)}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 11 }}>{formatBytes(slot.sizeBytes)}</Text>
                      <br />
                      <Tag color={slot.includesStorage ? 'gold' : 'blue'} style={{ marginTop: 4, marginInlineEnd: 0 }}>
                        {slot.includesStorage ? '含原文' : '轻量'}
                      </Tag>
                    </div>
                  ))}
                </div>
              </div>

              <Space direction="vertical" style={{ width: '100%' }}>
                <div
                  className={`settings-backup-dropzone ${backupDropActive ? 'is-active' : ''}`}
                  onDragEnter={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setBackupDropActive(true)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    event.dataTransfer.dropEffect = 'copy'
                    setBackupDropActive(true)
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setBackupDropActive(false)
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setBackupDropActive(false)
                    const file = Array.from(event.dataTransfer.files)
                      .find((item) => item.name.toLowerCase().endsWith('.zip'))
                    if (!file) {
                      message.info('请拖入 GujiSmart 备份压缩包（.zip）')
                      return
                    }
                    void handleImportDroppedBackup(file)
                  }}
                >
                  <ImportOutlined />
                  <span>拖入 .zip 备份包导入</span>
                  <small>导入前会自动保存当前数据安全备份包</small>
                </div>
                <Button block icon={<DownloadOutlined />} loading={backupBusy} onClick={() => void handleCreateBackup()}>
                  导出完整备份包
                </Button>
                <Popconfirm
                  title="导入备份包或旧版备份目录会覆盖当前数据库和配置，软件会先创建安全副本。确定继续吗？"
                  okText="导入备份"
                  cancelText="取消"
                  onConfirm={() => void handleImportBackup()}
                >
                  <Button block danger icon={<ImportOutlined />} loading={backupBusy}>
                    导入备份包
                  </Button>
                </Popconfirm>
                <Button block icon={<ReloadOutlined />} loading={backupBusy} onClick={() => void handleRunAutoBackupNow()}>
                  立即写入轮换槽位
                </Button>
                <Popconfirm
                  title="只会压缩轮换槽位中的旧备份，不会删除当前数据库、OCR 文本或 PDF 原件。确定瘦身吗？"
                  okText="瘦身"
                  cancelText="取消"
                  onConfirm={() => void handleCompactAutoBackups()}
                >
                  <Button block icon={<DeleteOutlined />} loading={backupBusy}>
                    瘦身自动备份
                  </Button>
                </Popconfirm>
                <Button block icon={<ExportOutlined />} onClick={() => void handleExportDocumentList()}>
                  导出文献清单 CSV
                </Button>
                <Button block icon={<FolderOpenOutlined />} onClick={() => void window.api.openDataDirectory()}>
                  打开数据目录
                </Button>
                <Button block icon={<FolderOpenOutlined />} onClick={() => void window.api.openAutoBackupDirectory()}>
                  打开自动备份目录
                </Button>
              </Space>
            </div>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'ocr'}>
          <div className="settings-section-title">
            <ApiOutlined /> OCR 配置中心
          </div>
          <div className="settings-provider-shell">
            <div className="settings-provider-list" aria-label="OCR 引擎">
              <button type="button" className="settings-provider-add" onClick={handleAddVisionOcrProviderDraft}>
                <PlusOutlined /> 添加 AI OCR
              </button>
              {[
                { id: 'paddle', label: '飞桨云端 OCR', desc: 'PaddleOCR 文档解析', engine: 'paddle' as OcrEngine },
                ...(selectedOcrProviderId === 'vision_draft'
                  ? [{ id: 'vision_draft', label: '新建 AI OCR', desc: '未保存', engine: 'vision_model' as OcrEngine }]
                  : []),
                ...visionOcrProfiles.map((profile) => ({
                  id: profile.id,
                  label: profile.name,
                  desc: `${profile.model || 'AI OCR'} · ${profile.connectionTest?.verified ? '已测试' : '未测试'}`,
                  engine: 'vision_model' as OcrEngine,
                  profile,
                })),
              ].map((provider) => {
                const fixedProviderId = provider.id === 'paddle'
                const isDefaultProvider = activeOcrProviderId === provider.id || (fixedProviderId && defaultOcrEngine === provider.engine)
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={`settings-provider-item${selectedOcrProviderId === provider.id ? ' active' : ''}`}
                    onClick={() => {
                      if ('profile' in provider && provider.profile) {
                        handleSelectVisionOcrProfileForEdit(provider.profile)
                        return
                      }
                      setSelectedOcrProviderId(provider.id)
                    }}
                  >
                    <span className="settings-provider-dot" />
                    <span>
                      <strong>{provider.label}</strong>
                      <small>{provider.desc}</small>
                    </span>
                    {isDefaultProvider ? <Tag color="gold">默认</Tag> : null}
                  </button>
                )
              })}
            </div>
            <div className="settings-provider-panel">
              {renderOcrEditor()}
            </div>
          </div>
          {false ? (
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="用于 OCR 文字识别"
              description={(
                <Space direction="vertical" size={4}>
                  <Text type="secondary">
                    飞桨 PaddleOCR API Token 可在飞桨 AI Studio 的 PaddleOCR 服务页申请，填入后才能进行 OCR 识别。
                  </Text>
                  <a href={PADDLE_OCR_APPLY_URL} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 前往申请飞桨 PaddleOCR API
                  </a>
                </Space>
              )}
            />
            <Form.Item label="API Token" name="paddleocr_api_key" extra={credentialHints.paddleocr_api_key || '例如：abc123def456...'}>
              <Input.Password prefix={<KeyOutlined />} placeholder={credentialHints.paddleocr_api_key ? '留空将保留已保存 Token' : '请输入 PaddleOCR API Token'} />
            </Form.Item>
            <Form.Item label="PDF 异步 OCR 模型" name="ocr_async_model" extra="默认使用 PaddleOCR-VL-1.6；点击拉取会从官方文档解析当前可用模型，也可手动输入官方模型 ID。">
              <AutoComplete
                options={paddleOcrModelOptions.map((model) => ({ value: model, label: model }))}
              >
                <Input suffix={<Button type="text" size="small" loading={paddleOcrModelsLoading} onClick={() => void fetchPaddleOcrModelOptions()}>拉取</Button>} />
              </AutoComplete>
            </Form.Item>
            <Form.Item label="上传超时（秒）" name="ocr_upload_timeout_seconds" extra="用于飞桨 OCR 图片和 PDF 分片上传；填 0 表示不限制客户端上传时长，适合批量大文件。">
              <InputNumber min={0} max={86400} step={60} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              label="单本 OCR 超时（分钟）"
              name="ocr_document_timeout_minutes"
              extra="单本书超过该时间仍未完成时会跳过并继续下一批，避免一本卡死堵住队列。默认 45 分钟；填 0 表示不限制；超过 300 页会自动略微加时，最长 12 小时。"
            >
              <InputNumber min={0} max={720} step={5} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="图片上传最长边" name="ocr_max_image_side" extra="飞桨 OCR 单页图片上传前会按最长边压缩；越大越清晰，但上传更慢。">
              <InputNumber min={800} max={4096} step={100} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="图片 JPEG 质量" name="ocr_jpeg_quality" extra="建议 75-88；调低可明显减少图片上传体积。">
              <InputNumber min={50} max={95} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              label="导入前压缩 PDF"
              name="pdf_compression_enabled"
              valuePropName="checked"
              extra="导入 PDF 后先压缩为库内原文，再进行页图生成和 API 分片上传。"
            >
              <Switch />
            </Form.Item>
            <Form.Item label="PDF 压缩阈值（MB）" name="pdf_compression_min_size_mb" extra="大于该体积才压缩；默认 10 MB。">
              <InputNumber min={1} max={1024} step={1} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="PDF 压缩质量" name="pdf_compression_quality" extra="建议 75-88；默认 80，越高越清晰也越大。">
              <InputNumber min={50} max={95} style={{ width: 140 }} />
            </Form.Item>
          </Card>
          ) : null}
        </section>

        {false ? (
        <section className="settings-section" hidden={activeSettingsSection !== 'ocr'}>
          <div className="settings-section-title">
            <ApiOutlined /> 视觉模型 OCR
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="用于古籍、报纸和复杂版面的视觉理解 OCR"
              description="填写 OpenAI-compatible 视觉模型接口即可接入豆包/火山方舟或其他兼容模型。它会按页写入 OCR 正文、结构块和目录候选。"
            />
            <Card size="small" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 16 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>火山引擎豆包 API 申请教程</Text>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  1. 登录火山方舟控制台并完成实名认证。2. 在 API Key 管理中新建密钥，复制到本页 API Key。3. 开通需要的豆包视觉模型，优先把模型 ID 填到“视觉模型 ID”，通常不需要单独创建推理接入点。4. API Base URL 保持 https://ark.cn-beijing.volces.com/api/v3，保存后可点击“拉取”校验模型列表。只有需要专属路由、配额隔离，或控制台只提供 ep- 开头 ID 时，才使用推理接入点 ID。
                </Text>
                <Space wrap>
                  <a href={VOLCENGINE_ARK_QUICKSTART_URL} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 官方快速开始
                  </a>
                  <a href={VOLCENGINE_ARK_API_KEY_URL} target="_blank" rel="noreferrer">
                    <LinkOutlined /> API Key 管理
                  </a>
                  <a href={VOLCENGINE_ARK_ENDPOINT_URL} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 推理接入点说明（可选）
                  </a>
                </Space>
              </Space>
            </Card>
            <Form.Item label="API Base URL" name="vision_ocr_base_url" extra="例如：https://ark.cn-beijing.volces.com/api/v3">
              <Input prefix={<ApiOutlined />} placeholder="https://ark.cn-beijing.volces.com/api/v3" />
            </Form.Item>
            <Form.Item
              label="跟随 AI 配置"
              name="vision_ocr_use_llm_config"
              valuePropName="checked"
              extra="仅影响实际 OCR 调用时使用哪组 API 配置，不会改动视觉模型 OCR 本身的独立配置。"
            >
              <Switch />
            </Form.Item>
            <Form.Item label="视觉服务商预设">
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  value={getVisionProviderSelectValue(form.getFieldValue('vision_ocr_provider'))}
                  placeholder="选择视觉服务商"
                  onChange={handleVisionProviderChange}
                  options={[
                    ...VISION_PROVIDER_PRESETS.map((item) => ({ value: item.name, label: item.name })),
                    { value: 'custom', label: '自定义' },
                  ]}
                />
                <Button onClick={applyLlmConfigToVisionOcr}>
                  套用 AI 配置
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="vision_ocr_provider" hidden>
              <Input />
            </Form.Item>
            <Form.Item label="API Key" name="vision_ocr_api_key" extra={credentialHints.vision_ocr_api_key || undefined}>
              <Input.Password prefix={<KeyOutlined />} placeholder={credentialHints.vision_ocr_api_key ? '留空将保留已保存 Key' : '请输入视觉模型 API Key'} />
            </Form.Item>
            <Form.Item label="视觉模型 ID" name="vision_ocr_model" extra="填写服务商控制台中的模型 ID；只有专属接入点才填写 endpoint ID。">
              <AutoComplete
                showSearch
                allowClear
                placeholder="doubao-seed-2-0-pro-260215"
                onDropdownVisibleChange={(open) => {
                  if (open && visionModelOptions.length === 0) void fetchModelOptions('vision')
                }}
                onFocus={() => {
                  if (visionModelOptions.length === 0) void fetchModelOptions('vision')
                }}
                options={visionModelOptions.map((model) => ({ value: model, label: model }))}
              >
                <Input suffix={<Button type="text" size="small" loading={visionModelsLoading} onClick={() => void fetchModelOptions('vision')}>拉取</Button>} />
              </AutoComplete>
            </Form.Item>
            <Form.Item label="并发页数" name="vision_ocr_concurrency" extra="上限 20；单页速度主要取决于图片大小和模型视觉解析时间，并发主要影响多页吞吐。">
              <InputNumber min={1} max={20} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="单页超时（秒）" name="vision_ocr_timeout_seconds" extra="超过该时间会中断本页，避免任务一直卡住。">
              <InputNumber min={30} max={900} step={30} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="上传最长边" name="vision_ocr_max_image_side" extra="报纸原图太大时会先压缩再上传；越大越清晰，但越慢。">
              <InputNumber min={800} max={4096} step={100} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="JPEG 质量" name="vision_ocr_jpeg_quality" extra="建议 75-88；越高越清晰，也越慢。">
              <InputNumber min={50} max={95} style={{ width: 140 }} />
            </Form.Item>
            <Card size="small" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', marginTop: 10 }}>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>视觉 OCR 服务商快捷切换</Text>
                  <Space>
                    <Button size="small" loading={visionOcrProfileBusy} onClick={() => void refreshVisionOcrProfiles()}>
                      刷新
                    </Button>
                    <Button size="small" icon={<LinkOutlined />} loading={visionOcrConnectionTesting} onClick={() => void handleTestVisionOcrConnection()}>
                      测试连接
                    </Button>
                    <Button size="small" type="primary" loading={visionOcrProfileBusy} disabled={!visionOcrConnectionVerified || watchedVisionOcrUseLlmConfig === true} onClick={() => void handleSaveCurrentVisionOcrProfile()}>
                      保存当前为视觉服务商
                    </Button>
                  </Space>
                </Space>
                <List
                  size="small"
                  dataSource={visionOcrProfiles}
                  locale={{ emptyText: '暂无已保存的视觉 OCR 服务商配置' }}
                  renderItem={(profile) => {
                    const active = profile.id === activeVisionOcrProfileId
                    return (
                      <List.Item
                        actions={[
                          <Button key="switch" size="small" type={active ? 'primary' : 'default'} disabled={active || visionOcrProfileBusy || !profile.connectionTest?.verified} onClick={() => void handleSwitchVisionOcrProfile(profile.id)}>
                            {active ? '使用中' : '切换'}
                          </Button>,
                          <Popconfirm key="delete" title={active ? '删除当前视觉 OCR 配置后，将自动切换到其他配置或飞桨云端 OCR。' : '删除这个视觉 OCR 服务商配置？'} onConfirm={() => void handleDeleteVisionOcrProfile(profile.id)}>
                            <Button size="small" danger disabled={visionOcrProfileBusy}>删除</Button>
                          </Popconfirm>,
                        ]}
                      >
                        <List.Item.Meta
                          title={(
                            <Space wrap>
                              <Text style={{ color: 'var(--gs-text-primary)' }}>{profile.name}</Text>
                              {active ? <Tag color="gold">当前</Tag> : null}
                              <Tag color={profile.connectionTest?.verified ? 'green' : 'default'}>{profile.connectionTest?.verified ? '已测试' : '未测试'}</Tag>
                            </Space>
                          )}
                          description={(
                            <Text type="secondary">
                              {profile.model} · {profile.baseUrl}
                            </Text>
                          )}
                        />
                      </List.Item>
                    )
                  }}
                />
              </Space>
            </Card>
          </Card>
        </section>
        ) : null}

        <section className="settings-section" hidden={activeSettingsSection !== 'ai'}>
          <div className="settings-section-title">
            <ApiOutlined /> AI 配置中心
          </div>
          <div className="settings-provider-shell">
            <div className="settings-provider-list" aria-label="AI 服务商">
              <button type="button" className="settings-provider-add" onClick={handleAddLlmProviderDraft}>
                <PlusOutlined /> 添加服务商
              </button>
              {llmProfiles.length > 0 ? (
                <div style={{ padding: '6px 10px 2px', fontSize: 11, color: 'var(--gs-text-tertiary)' }}>已保存</div>
              ) : null}
              {llmProfiles.map((profile) => {
                const isCurrent = profile.id === activeLlmProfileId
                const isSelected = profile.id === selectedAiProviderId
                const hasOwnKey = Boolean(profile.credential?.configured)
                const host = (() => {
                  try {
                    return new URL(profile.baseUrl).host
                  } catch {
                    return profile.baseUrl
                  }
                })()
                return (
                  <button
                    key={profile.id}
                    type="button"
                    className={`settings-provider-item${isSelected ? ' active' : ''}`}
                    onClick={() => handleSelectLlmProfileForEdit(profile)}
                  >
                    <span className="settings-provider-dot" />
                    <span>
                      <strong>{profile.name}</strong>
                      <small>
                        {profile.model || '未设模型'}
                        {host ? ` · ${host}` : ''}
                      </small>
                      <span style={{ display: 'block', marginTop: 4 }}>
                        {isCurrent ? <Tag color="gold" style={{ marginInlineEnd: 4 }}>当前</Tag> : null}
                        {hasOwnKey ? (
                          <Tag color="green" style={{ marginInlineEnd: 4 }}>
                            已保存 Key
                            {profile.credential?.last4 ? ` ·${profile.credential.last4}` : ''}
                          </Tag>
                        ) : isCurrent && credentialHints.llm_api_key ? (
                          <Tag color="gold" style={{ marginInlineEnd: 4 }}>当前全局 Key</Tag>
                        ) : (
                          <Tag style={{ marginInlineEnd: 4 }}>未保存 Key</Tag>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
              {visibleAiProviderPresets.length > 0 ? (
                <div style={{ padding: '10px 10px 2px', fontSize: 11, color: 'var(--gs-text-tertiary)' }}>预设模板（未保存）</div>
              ) : null}
              {visibleAiProviderPresets.map((preset) => {
                const presetId = `preset:${preset.name}`
                const isSelected = selectedAiProviderId === presetId || (
                  !selectedAiSavedProfile
                  && String(form.getFieldValue('llm_provider') || '') === preset.name
                  && String(form.getFieldValue('llm_base_url') || '').replace(/\/+$/, '') === preset.baseUrl.replace(/\/+$/, '')
                )
                return (
                  <button
                    key={presetId}
                    type="button"
                    className={`settings-provider-item${isSelected ? ' active' : ''}`}
                    onClick={() => {
                      setSelectedAiProviderId(presetId)
                      handleProviderChange(preset.name)
                    }}
                  >
                    <span className="settings-provider-dot" />
                    <span>
                      <strong>{preset.name}</strong>
                      <small>{preset.baseUrl}</small>
                      <span style={{ display: 'block', marginTop: 4 }}>
                        <Tag style={{ marginInlineEnd: 4 }}>预设</Tag>
                        <Tag>未保存</Tag>
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="settings-provider-panel">
              {renderAiEditor()}
            </div>
          </div>
          {false ? (
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="用于智能问答、翻译、摘要和元数据提取"
              description={(
                <Space direction="vertical" size={4}>
                  <Text type="secondary">
                    推荐先使用 DeepSeek：在开放平台创建 API Key，然后选择 DeepSeek 预设，粘贴 Key 后保存即可。
                  </Text>
                  <a href={DEEPSEEK_APPLY_URL} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 前往申请 DeepSeek API
                  </a>
                </Space>
              )}
            />
            <Form.Item label="模型提供方" name="llm_provider">
              <Select onChange={handleProviderChange}>
                {AI_PROVIDER_PRESETS.map((item) => (
                  <Select.Option key={item.name} value={item.name}>{item.name}</Select.Option>
                ))}
                <Select.Option value="custom">自定义</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item label="API Base URL" name="llm_base_url">
              <Input prefix={<ApiOutlined />} placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item label="API Key" name="llm_api_key" extra={credentialHints.llm_api_key || undefined}>
              <Input.Password prefix={<KeyOutlined />} placeholder={credentialHints.llm_api_key ? '留空将保留已保存 Key' : '请输入 API Key'} />
            </Form.Item>
            <Form.Item label="默认模型" name="llm_model">
              <AutoComplete
                showSearch
                allowClear
                placeholder="deepseek-chat"
                onDropdownVisibleChange={(open) => {
                  if (open && llmModelOptions.length === 0) void fetchModelOptions('llm')
                }}
                onFocus={() => {
                  if (llmModelOptions.length === 0) void fetchModelOptions('llm')
                }}
                options={llmModelOptions.map((model) => ({ value: model, label: model }))}
              >
                <Input suffix={<Button type="text" size="small" loading={llmModelsLoading} onClick={() => void fetchModelOptions('llm')}>拉取</Button>} />
              </AutoComplete>
            </Form.Item>
            <Card size="small" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', marginTop: 10 }}>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>AI 服务商快捷切换</Text>
                  <Space>
                    <Button size="small" loading={llmProfileBusy} onClick={() => void refreshLlmProfiles()}>
                      刷新
                    </Button>
                    <Button size="small" type="primary" loading={llmProfileBusy} onClick={() => void handleSaveCurrentLlmProfile()}>
                      保存当前为服务商
                    </Button>
                  </Space>
                </Space>
                <List
                  size="small"
                  dataSource={llmProfiles}
                  locale={{ emptyText: '暂无已保存的 AI 服务商配置' }}
                  renderItem={(profile) => {
                    const active = profile.id === activeLlmProfileId
                    return (
                      <List.Item
                        actions={[
                          <Button key="switch" size="small" type={active ? 'primary' : 'default'} disabled={active || llmProfileBusy} onClick={() => void handleSwitchLlmProfile(profile.id)}>
                            {active ? '使用中' : '切换'}
                          </Button>,
                          <Popconfirm key="delete" title="删除这个 AI 服务商配置？" disabled={active} onConfirm={() => void handleDeleteLlmProfile(profile.id)}>
                            <Button size="small" danger disabled={active || llmProfileBusy}>删除</Button>
                          </Popconfirm>,
                        ]}
                      >
                        <List.Item.Meta
                          title={(
                            <Space wrap>
                              <Text style={{ color: 'var(--gs-text-primary)' }}>{profile.name}</Text>
                              {active ? <Tag color="gold">当前</Tag> : null}
                            </Space>
                          )}
                          description={(
                            <Text type="secondary">
                              {profile.model} · {profile.baseUrl}
                            </Text>
                          )}
                        />
                      </List.Item>
                    )
                  }}
                />
              </Space>
            </Card>
          </Card>
          ) : null}
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'glossary'}>
          <div className="settings-section-title">
            <BookOutlined /> 翻译术语表
          </div>
          <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message="术语表会作为翻译优先建议注入"
                description="翻译时会优先参考这里的术语建议；项目术语只作用于选中的研究项目。"
              />
              <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                <Space wrap>
                  <Select
                    value={glossaryScope}
                    onChange={(value) => setGlossaryScope(value)}
                    style={{ width: 140 }}
                    options={[
                      { value: 'global', label: '全局术语' },
                      { value: 'project', label: '项目术语' },
                    ]}
                  />
                  {glossaryScope === 'project' ? (
                    <Select
                      value={glossaryProjectId || undefined}
                      onChange={(value) => setGlossaryProjectId(value)}
                      placeholder="选择研究项目"
                      style={{ width: 220 }}
                      showSearch
                      optionFilterProp="label"
                      options={researchProjects.map((project) => ({ value: project.id, label: project.name }))}
                    />
                  ) : null}
                  <Input.Search
                    allowClear
                    value={glossarySearch}
                    onChange={(event) => setGlossarySearch(event.target.value)}
                    onSearch={() => void loadGlossaryTerms()}
                    placeholder="搜索原词、译名或备注"
                    style={{ width: 240 }}
                  />
                </Space>
                <Space>
                  <Button icon={<ReloadOutlined />} loading={glossaryLoading} onClick={() => void loadGlossaryTerms()}>
                    刷新
                  </Button>
                  <Button type="primary" icon={<PlusOutlined />} disabled={glossaryScope === 'project' && !glossaryProjectId} onClick={openCreateGlossaryTerm}>
                    新增术语
                  </Button>
                </Space>
              </Space>
              <List
                size="small"
                loading={glossaryLoading}
                dataSource={glossaryTerms}
                locale={{ emptyText: glossaryScope === 'project' && !glossaryProjectId ? '请选择研究项目后管理项目术语' : '暂无术语' }}
                renderItem={(term) => (
                  <List.Item
                    actions={[
                      <Button key="toggle" size="small" onClick={() => void toggleGlossaryTerm(term)}>
                        {term.enabled === 0 ? '启用' : '停用'}
                      </Button>,
                      <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => openEditGlossaryTerm(term)}>
                        编辑
                      </Button>,
                      <Popconfirm key="delete" title="删除这个术语？" okText="删除" cancelText="取消" onConfirm={() => void deleteGlossaryTerm(term.id)}>
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={(
                        <Space wrap>
                          <Text strong style={{ color: 'var(--gs-text-primary)' }}>{term.source_term}</Text>
                          <Text type="secondary">=&gt;</Text>
                          <Text style={{ color: 'var(--gs-gold)' }}>{term.target_term}</Text>
                          <Tag color={term.scope === 'project' ? 'blue' : 'gold'}>{term.scope === 'project' ? '项目' : '全局'}</Tag>
                          {term.enabled === 0 ? <Tag>已停用</Tag> : null}
                          {term.case_sensitive ? <Tag color="purple">区分大小写</Tag> : null}
                        </Space>
                      )}
                      description={term.note ? <Text type="secondary">{term.note}</Text> : <Text type="secondary">无备注</Text>}
                    />
                  </List.Item>
                )}
              />
            </Space>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'embedding'}>
          <div className="settings-section-title">
            <ThunderboltOutlined /> 向量索引
          </div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="与 AI 配置中心共用服务商与 API Key"
            description="左侧选择你在「AI 配置中心」已保存的服务商（通义、火山等），自动复用其 Base URL 与 Key；这里只需再选向量模型。DeepSeek 等无向量能力的接口请勿用于向量化。默认手动批量向量化正文；可选入库后自动。"
          />
          <div className="settings-provider-shell">
            <div className="settings-provider-list" aria-label="向量所用服务商">
              <div style={{ padding: '8px 10px 4px', color: 'var(--gs-text-secondary)', fontSize: 12 }}>
                来自 AI 配置中心
              </div>
              {(embeddingStats?.linkedProfiles || []).length === 0 ? (
                <div style={{ padding: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    暂无已保存服务商。请先到「AI」页添加并保存通义 / 火山等，再回到这里选用。
                  </Text>
                  <Button
                    type="link"
                    size="small"
                    style={{ paddingLeft: 0 }}
                    onClick={() => setActiveSettingsSection('ai')}
                  >
                    前往 AI 配置中心
                  </Button>
                </div>
              ) : (
                (embeddingStats?.linkedProfiles || []).map((profile) => {
                  const active = profile.id === (embeddingStats?.sourceProfileId || embeddingProviderName)
                  const noEmbedHint = /deepseek/i.test(profile.baseUrl) || /deepseek/i.test(profile.provider)
                  const host = (() => {
                    try {
                      return new URL(profile.baseUrl).host
                    } catch {
                      return profile.baseUrl
                    }
                  })()
                  const linkedLast4 = profile.keySource !== 'none' ? String(profile['apiKeyLast4'] || '') : ''
                  const keySuffix = linkedLast4 ? ` ·${linkedLast4}` : ''
                  const keyLabel =
                    profile.keySource === 'profile'
                      ? `已保存 Key${keySuffix}`
                      : profile.keySource === 'active-global'
                        ? `当前全局 Key${keySuffix}`
                        : '未保存 Key'
                  const keyColor =
                    profile.keySource === 'profile' ? 'green' : profile.keySource === 'active-global' ? 'gold' : 'default'
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      className={`settings-provider-item${active ? ' active' : ''}`}
                      onClick={() => {
                        if (profile.keySource === 'none') {
                          message.warning(
                            `「${profile.name}」还没有独立保存的 API Key。请打开「AI 配置中心」→ 选中该服务商 → 重新粘贴 Key → 点「保存配置」（不要只点「设为当前」）。`,
                          )
                        }
                        void handleSelectEmbeddingSourceProfile(profile.id)
                      }}
                    >
                      <span className="settings-provider-dot" />
                      <span>
                        <strong>
                          {profile.name}
                          {active ? ' · 向量当前' : ''}
                        </strong>
                        <small>
                          {profile.chatModel ? `${profile.chatModel} · ` : ''}
                          {host}
                        </small>
                        <span style={{ display: 'block', marginTop: 4 }}>
                          <Tag color={keyColor} style={{ marginInlineEnd: 4 }}>{keyLabel}</Tag>
                          {noEmbedHint ? <Tag color="orange">可能无向量</Tag> : null}
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>
            <div className="settings-provider-detail">
              <Card size="small" loading={embeddingBusy && !embeddingStats} styles={{ body: { paddingTop: 12 } }}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                    <div>
                      <Text strong style={{ fontSize: 16 }}>
                        {embeddingStats?.sourceProfileName || '未选择服务商'}
                      </Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {embeddingBaseUrlDraft || '请从左侧选择 AI 配置中心已保存的服务商'}
                      </Text>
                    </div>
                    <Space wrap>
                      <Button size="small" loading={embeddingBusy} icon={<ReloadOutlined />} onClick={() => void refreshEmbeddingStats()}>
                        刷新
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        loading={embeddingBusy}
                        icon={<SaveOutlined />}
                        disabled={!embeddingStats?.sourceProfileId && !embeddingProviderName}
                        onClick={() => void handleSaveEmbeddingSettings()}
                      >
                        保存配置
                      </Button>
                    </Space>
                  </Space>

                  <Alert
                    type="info"
                    showIcon
                    message="接口与 API Key 来自左侧所选服务商"
                    description="无需在此重复填写 Key。请确认该服务商支持 Embeddings（推荐通义 dashscope、硅基、OpenAI 等）。DeepSeek 对话端点通常不能做向量。"
                  />

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <Text strong>入库后自动向量化</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        默认关。打开后，新入库且正文分段就绪的文献自动入队（消耗 API）。
                      </Text>
                    </div>
                    <Switch
                      checked={Boolean(embeddingStats?.autoOnIngest)}
                      loading={embeddingBusy}
                      checkedChildren="开"
                      unCheckedChildren="关"
                      onChange={(checked) => void handleEmbeddingAutoChange(checked)}
                    />
                  </div>

                  <div>
                    <Text type="secondary">API Base URL（只读，随服务商）</Text>
                    <Input value={embeddingBaseUrlDraft} readOnly style={{ marginTop: 4 }} />
                  </div>

                  <div>
                    <Text type="secondary">API Key 状态：</Text>
                    {(() => {
                      const selected = (embeddingStats?.linkedProfiles || []).find(
                        (item) => item.id === (embeddingStats?.sourceProfileId || embeddingProviderName),
                      )
                      if (!selected) {
                        return <Tag style={{ marginLeft: 6 }}>未选择服务商</Tag>
                      }
                      if (selected.keySource === 'profile') {
                        return (
                          <Tag color="green" style={{ marginLeft: 6 }}>
                            已绑定该服务商独立 Key
                            {selected.apiKeyLast4 ? ` · 末四位 ${selected.apiKeyLast4}` : ''}
                          </Tag>
                        )
                      }
                      if (selected.keySource === 'active-global') {
                        return (
                          <Tag color="gold" style={{ marginLeft: 6 }}>
                            仅当前 AI 全局 Key（建议在 AI 页对该服务商点「保存当前为服务商」写入独立 Key）
                            {selected.apiKeyLast4 ? ` · 末四位 ${selected.apiKeyLast4}` : ''}
                          </Tag>
                        )
                      }
                      return (
                        <Tag color="red" style={{ marginLeft: 6 }}>
                          未保存 Key — 请到 AI 配置中心填写并保存该服务商
                        </Tag>
                      )
                    })()}
                  </div>

                  <div>
                    <Text type="secondary">向量模型 ID（通义兼容 OpenAI embeddings.create）</Text>
                    <AutoComplete
                      style={{ width: '100%', marginTop: 4 }}
                      value={embeddingModelDraft}
                      options={embeddingModelOptions.map((model) => ({ value: model, label: model }))}
                      onChange={(value) => setEmbeddingModelDraft(String(value || ''))}
                      onSelect={(value) => {
                        const next = String(value || '')
                        setEmbeddingModelDraft(next)
                        // Selecting a known model immediately applies official batch/dimension limits.
                        void window.api.updateEmbeddingSettings({ model: next }).then((stats) => {
                          setEmbeddingStats(stats)
                          setEmbeddingBatchSizeDraft(stats.batchSize)
                          setEmbeddingDimensionsDraft(stats.dimensions)
                          if (stats.batchSizeAutoAdjusted) {
                            message.info(`已按「${next}」官方规格调整批次为 ${stats.batchSize}（上限 ${stats.batchSizeCap}）`)
                          }
                        }).catch(() => undefined)
                      }}
                      onDropdownVisibleChange={(open) => {
                        if (open && embeddingModelOptions.length <= 1) void fetchEmbeddingModelOptions()
                      }}
                    >
                      <Input
                        placeholder="text-embedding-v4"
                        suffix={(
                          <Button
                            type="text"
                            size="small"
                            loading={embeddingModelsLoading}
                            onClick={() => void fetchEmbeddingModelOptions()}
                          >
                            拉取
                          </Button>
                        )}
                      />
                    </AutoComplete>
                    {embeddingStats?.modelSpecNote ? (
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                        {embeddingStats.modelSpecNote}
                      </Text>
                    ) : null}
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <Text type="secondary">输出维度 dimensions（可选）</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          对应官方可选维度；选「模型默认」则不传 dimensions（v3/v4 默认 1024）。
                        </Text>
                      </div>
                      <Select
                        style={{ minWidth: 160 }}
                        value={embeddingDimensionsDraft > 0 ? embeddingDimensionsDraft : 0}
                        onChange={(value) => setEmbeddingDimensionsDraft(Number(value) || 0)}
                        options={[
                          {
                            value: 0,
                            label: embeddingStats?.dimensionsDefault
                              ? `模型默认（${embeddingStats.dimensionsDefault}）`
                              : '模型默认',
                          },
                          ...(embeddingStats?.dimensionsOptions || []).map((dim) => ({
                            value: dim,
                            label: String(dim),
                          })),
                        ]}
                      />
                    </div>
                    {(embeddingStats?.dimensionsOptions || []).length === 0 ? (
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                        当前模型未登记可选维度（或固定维度），将使用接口返回值。
                      </Text>
                    ) : null}
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <Text type="secondary">单次请求批次 batch size（条文本）</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {embeddingStats?.batchSizeHint
                            || '按模型官方规格：v3/v4=10，v2/v1=25，qwen3.7=20。切换模型会自动调整。'}
                        </Text>
                      </div>
                      <Space wrap>
                        <InputNumber
                          min={1}
                          max={Math.max(1, Number(embeddingStats?.batchSizeCap) || 64)}
                          value={embeddingBatchSizeDraft}
                          onChange={(value) => setEmbeddingBatchSizeDraft(Math.max(1, Number(value) || 1))}
                          style={{ width: 100 }}
                        />
                        <Button size="small" loading={embeddingBusy} onClick={() => void handleResetEmbeddingBatchSize()}>
                          按模型默认
                        </Button>
                      </Space>
                    </div>
                    {embeddingStats ? (
                      <div style={{ marginTop: 6 }}>
                        <Tag color={embeddingBatchSizeDraft > (embeddingStats.batchSizeCap || 10) ? 'orange' : 'blue'}>
                          生效 {embeddingStats.batchSize}
                          {' · '}
                          上限 {embeddingStats.batchSizeCap}
                        </Tag>
                        {embeddingBatchSizeDraft > (embeddingStats.batchSizeCap || 10) ? (
                          <Text type="warning" style={{ fontSize: 12, marginLeft: 8 }}>
                            超过官方上限，保存时会自动改为 {embeddingStats.batchSizeCap}
                          </Text>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <Space wrap>
                    <Button loading={embeddingModelsLoading} onClick={() => void fetchEmbeddingModelOptions()}>
                      拉取向量模型列表
                    </Button>
                    <Button loading={embeddingBusy} onClick={() => void handleEmbeddingQueuePause(!(embeddingStats?.queuePaused))}>
                      {embeddingStats?.queuePaused ? '继续队列' : '暂停队列'}
                    </Button>
                    <Button
                      loading={embeddingBusy}
                      disabled={!embeddingStats || embeddingStats.docsError <= 0}
                      onClick={() => void handleRequeueFailedEmbeddings()}
                    >
                      重试失败{embeddingStats && embeddingStats.docsError > 0 ? `（${embeddingStats.docsError}）` : ''}
                    </Button>
                    <Button
                      loading={embeddingBusy}
                      disabled={!embeddingStats || Number(embeddingStats.docsStale || 0) <= 0}
                      onClick={() => void handleReindexStaleEmbeddings()}
                    >
                      重建过期{embeddingStats && Number(embeddingStats.docsStale || 0) > 0 ? `（${embeddingStats.docsStale}）` : ''}
                    </Button>
                    <Button
                      loading={embeddingBusy}
                      disabled={!embeddingStats || embeddingStats.docsReady <= 0}
                      onClick={() => void handleReindexAllReadyEmbeddings()}
                    >
                      全部重新向量化{embeddingStats && embeddingStats.docsReady > 0 ? `（${embeddingStats.docsReady}）` : ''}
                    </Button>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    更换更强的向量模型后：可先「重建过期」（仅缺当前模型向量的书），或「全部重新向量化」整库按新模型重做。文献库多选也可用「重新向量化所选」。
                  </Text>

                  {embeddingStats ? (
                    <Card size="small" type="inner" title="索引进度">
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        <Text>
                          向量模型：
                          <Text code>{embeddingStats.modelId || embeddingStats.model}</Text>
                          {embeddingStats.dim ? ` · ${embeddingStats.dim} 维` : ''}
                        </Text>
                        <Text>
                          段向量：{embeddingStats.chunks}
                          {' · '}就绪 {embeddingStats.docsReady}
                          {' · '}排队 {embeddingStats.docsQueued}
                          {' · '}处理中 {embeddingStats.docsProcessing}
                          {' · '}失败 {embeddingStats.docsError}
                          {Number(embeddingStats.docsStale || 0) > 0 ? (
                            <>
                              {' · '}
                              <Text type="warning">过期 {embeddingStats.docsStale}</Text>
                            </>
                          ) : null}
                        </Text>
                        {embeddingStats.message ? <Text type="secondary">{embeddingStats.message}</Text> : null}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          手动：文献库 → 批量处理 →「向量化所选文献」。进度会出现在文献卡片与「处理队列」。MCP：vector_search / vector_index_stats。
                        </Text>
                        <div style={{ marginTop: 4 }}>
                          <Text strong>试搜（语义）</Text>
                          <Space.Compact style={{ width: '100%', marginTop: 6 }}>
                            <Input
                              value={embeddingTestQuery}
                              placeholder="输入主题描述，如：战犯改造与中日关系"
                              onChange={(e) => setEmbeddingTestQuery(e.target.value)}
                              onPressEnter={() => {
                                const btn = document.getElementById('embedding-test-search-btn')
                                btn?.click()
                              }}
                            />
                            <Button
                              id="embedding-test-search-btn"
                              type="primary"
                              loading={embeddingBusy}
                              onClick={() => {
                                void (async () => {
                                  setEmbeddingBusy(true)
                                  try {
                                    const res = await window.api.vectorSearch(embeddingTestQuery.trim(), { limit: 8 })
                                    if (!res.ok) {
                                      setEmbeddingTestResult(res.message)
                                      return
                                    }
                                    setEmbeddingTestResult(
                                      res.hits.map((h, i) => `${i + 1}. [${h.score}] p${h.pageNum ?? '?'} ${h.title || h.documentId}\n   ${h.excerpt}`).join('\n\n')
                                      || '无命中',
                                    )
                                  } catch (error: unknown) {
                                    setEmbeddingTestResult(getErrorMessage(error, '语义试搜失败'))
                                  } finally {
                                    setEmbeddingBusy(false)
                                  }
                                })()
                              }}
                            >
                              试搜
                            </Button>
                          </Space.Compact>
                          {embeddingTestResult ? (
                            <Input.TextArea
                              value={embeddingTestResult}
                              readOnly
                              autoSize={{ minRows: 4, maxRows: 12 }}
                              style={{ marginTop: 8, fontSize: 12 }}
                            />
                          ) : null}
                        </div>
                      </Space>
                    </Card>
                  ) : (
                    <Text type="secondary">正在读取向量索引状态…</Text>
                  )}
                </Space>
              </Card>
            </div>
          </div>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'aiTools'}>
          <div className="settings-section-title">
            <LinkOutlined /> AI 工具连接
          </div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="给不会敲命令的人用"
            description="先打开下方开关，再选择你用的 AI 客户端（Trae / Cursor / Claude / Codex 等），按该客户端的说明复制配置即可。AI 只能只读检索文献库，不能删除、改设置或读密钥。"
          />
          <Card size="small" title="允许 AI 访问本机文献库" loading={mcpBusy && !mcpSetup}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <Text strong>允许 AI 工具访问文献库</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    关闭后，任何 AI 客户端即使带着旧配置也无法连接。
                  </Text>
                </div>
                <Switch
                  checked={Boolean(mcpSetup?.enabled)}
                  loading={mcpBusy}
                  checkedChildren="已开"
                  unCheckedChildren="关闭"
                  onChange={(checked) => void handleMcpEnabledChange(checked)}
                />
              </div>

              <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>你用的是哪家 AI 客户端？</Text>
                <Segmented
                  block
                  value={mcpClientId}
                  options={MCP_CLIENT_SEGMENTED_OPTIONS}
                  onChange={(value) => setMcpClientId(value as McpClientId)}
                />
                <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                  {MCP_CLIENT_OPTIONS.find((item) => item.id === mcpClientId)?.hint || ''}
                  {' · '}国内常用可先选 Trae；换客户端时在此切换即可。
                </Text>
              </div>

              {(() => {
                const client = MCP_CLIENT_OPTIONS.find((item) => item.id === mcpClientId) || MCP_CLIENT_OPTIONS[0]
                const isCodex = client.mode === 'codex'
                return (
                  <>
                    <Space wrap>
                      {isCodex ? (
                        <>
                          <Button type="primary" loading={mcpBusy} onClick={() => void handleWriteCodexConfig()}>
                            一键写入 Codex 配置（推荐）
                          </Button>
                          <Button icon={<CopyOutlined />} loading={mcpBusy} onClick={() => void handleCopyCodexForm()}>
                            复制 Codex 表单填写说明
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="primary"
                          icon={<CopyOutlined />}
                          loading={mcpBusy}
                          onClick={() => void handleCopyMcpConfig(client.label)}
                        >
                          复制 MCP 配置 JSON（{client.label}）
                        </Button>
                      )}
                      <Button loading={mcpBusy} onClick={() => void handleRotateMcpToken()}>
                        更换连接令牌
                      </Button>
                    </Space>

                    {mcpSetup ? (
                      <>
                        <Alert
                          type="success"
                          showIcon
                          message={`连接 ${client.label}（按步骤做）`}
                          description={(
                            <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                              {client.steps.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ol>
                          )}
                        />

                        {isCodex ? (
                          <Card
                            size="small"
                            type="inner"
                            title="Codex 手动表单对照（哪一行填什么）"
                            extra={(
                              <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => void handleCopyCodexForm()}>
                                复制整表说明
                              </Button>
                            )}
                          >
                            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                              打开 Codex → 连接至自定义 MCP。下面每一行对应表单里的一项；点右侧「复制」可只复制该值。类型请选 <Text strong>STDIO</Text>。
                            </Text>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              {([
                                { label: '名称', value: mcpSetup.codexForm?.name || 'gujismart', hint: '固定填这个即可' },
                                { label: '类型', value: 'STDIO', hint: '点选 STDIO，不要选「流式 HTTP」' },
                                { label: '启动命令', value: mcpSetup.command, hint: '整段粘贴到「启动命令」输入框' },
                                {
                                  label: '工作目录',
                                  value: mcpSetup.cwd || mcpSetup.codexForm?.cwd || '（留空）',
                                  hint: mcpSetup.cwd ? '有值就整段粘贴' : '没有就留空，不要乱填',
                                },
                                {
                                  label: '环境变量',
                                  value: (() => {
                                    const fromMap = mcpSetup.env || {}
                                    const fromForm = (mcpSetup.codexForm?.env || []).reduce((acc, row) => {
                                      if (row.key) acc[row.key] = row.value
                                      return acc
                                    }, {} as Record<string, string>)
                                    const merged = { ...fromForm, ...fromMap }
                                    const text = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n')
                                    return text || 'ELECTRON_RUN_AS_NODE=1'
                                  })(),
                                  hint: 'Windows 必须带 ELECTRON_RUN_AS_NODE=1，否则 MCP 会一直重连',
                                },
                                { label: '环境变量传递', value: '（留空）', hint: '一般不用填' },
                              ] as Array<{ label: string; value: string; hint: string }>).map((row) => (
                                <div
                                  key={row.label}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '110px 1fr auto',
                                    gap: 8,
                                    alignItems: 'start',
                                    padding: '8px 10px',
                                    borderRadius: 8,
                                    background: 'var(--gs-bg-elevated, rgba(0,0,0,0.04))',
                                  }}
                                >
                                  <div>
                                    <Text strong>{row.label}</Text>
                                    <br />
                                    <Text type="secondary" style={{ fontSize: 11 }}>{row.hint}</Text>
                                  </div>
                                  <Text code style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{row.value}</Text>
                                  <Button
                                    size="small"
                                    icon={<CopyOutlined />}
                                    disabled={row.value.startsWith('（')}
                                    onClick={() => void copyMcpField(row.label, row.value)}
                                  >
                                    复制
                                  </Button>
                                </div>
                              ))}
                            </div>

                            <div style={{ marginTop: 14 }}>
                              <Text strong>参数（对应表单里「参数」+「添加参数」）</Text>
                              <br />
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                有几行就点几次「+ 添加参数」，每行框里只贴下面的一项（不要把多行粘成一坨）。
                              </Text>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                                {(mcpSetup.args || []).map((arg, index) => (
                                  <div
                                    key={`${index}-${arg}`}
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: '110px 1fr auto',
                                      gap: 8,
                                      alignItems: 'start',
                                      padding: '8px 10px',
                                      borderRadius: 8,
                                      background: 'var(--gs-bg-elevated, rgba(0,0,0,0.04))',
                                    }}
                                  >
                                    <Text strong>参数 {index + 1}</Text>
                                    <Text code style={{ wordBreak: 'break-all' }}>{arg}</Text>
                                    <Button size="small" icon={<CopyOutlined />} onClick={() => void copyMcpField(`参数 ${index + 1}`, arg)}>
                                      复制
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div style={{ marginTop: 12 }}>
                              <Text type="secondary">整表说明文本（与上面相同，方便一次复制）</Text>
                              <Input.TextArea
                                value={mcpSetup.configs.codexFormText}
                                readOnly
                                autoSize={{ minRows: 6, maxRows: 12 }}
                                style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, marginTop: 6 }}
                              />
                            </div>
                          </Card>
                        ) : (
                          <Card
                            size="small"
                            type="inner"
                            title={`${client.label} · MCP 配置 JSON`}
                            extra={(
                              <Button
                                size="small"
                                type="link"
                                icon={<CopyOutlined />}
                                onClick={() => void handleCopyMcpConfig(client.label)}
                              >
                                复制 JSON
                              </Button>
                            )}
                          >
                            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                              粘贴到 {client.label} 的 MCP 设置。类型为 <Text strong>STDIO</Text>；路径与令牌已写在 JSON 里，不必自己找盘符。
                            </Text>
                            <Input.TextArea
                              value={mcpSetup.configs.cursorJson}
                              readOnly
                              autoSize={{ minRows: 8, maxRows: 14 }}
                              style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}
                            />
                          </Card>
                        )}

                        <div>
                          <Text type="secondary">连接令牌摘要（已含在配置里，一般不用单独填）</Text>
                          <br />
                          <Text code>{mcpSetup.tokenPreview}</Text>
                        </div>
                        <div>
                          <Text type="secondary">数据目录（已含在配置里）</Text>
                          <br />
                          <Text code style={{ wordBreak: 'break-all' }}>{mcpSetup.dataDir}</Text>
                        </div>
                      </>
                    ) : (
                      <Text type="secondary">正在读取连接信息…</Text>
                    )}
                  </>
                )
              })()}
            </Space>
          </Card>
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'about'}>
          <div className="settings-section-title">
            <GithubOutlined /> 关于与版权
          </div>
          <Card size="small" className="settings-about-card">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)', fontSize: 16 }}>{PRODUCT_FULL_NAME}</Text>
                <br />
                <Text type="secondary">{PRODUCT_SUBTITLE}</Text>
              </div>
              <div className="settings-about-grid">
                <div>
                  <Text type="secondary">应用名称</Text>
                  <br />
                  <Text style={{ color: 'var(--gs-text-primary)' }}>{PRODUCT_NAME}</Text>
                </div>
                <div>
                  <Text type="secondary">版本</Text>
                  <br />
                  <Text style={{ color: 'var(--gs-text-primary)' }}>{appVersion || '0.8.0'}</Text>
                </div>
                <div>
                  <Text type="secondary">作者</Text>
                  <br />
                  <Text style={{ color: 'var(--gs-text-primary)' }}>彭泓浩</Text>
                </div>
                <div>
                  <Text type="secondary">许可证</Text>
                  <br />
                  <Text style={{ color: 'var(--gs-text-primary)' }}>Apache-2.0</Text>
                </div>
              </div>
              {updateInfo ? (
                <Alert
                  type={updateInfo.error ? 'warning' : updateInfo.hasUpdate ? 'success' : 'info'}
                  showIcon
                  message={updateInfo.error ? '暂时无法检查更新' : updateInfo.hasUpdate ? `发现新版本 ${updateInfo.latestVersion}` : '当前已是最新版本'}
                  description={
                    updateInfo.error
                      ? updateInfo.error
                      : updateInfo.hasUpdate
                        ? `当前版本 ${updateInfo.currentVersion}，最新版本 ${updateInfo.latestVersion}。可以前往 GitHub Release 下载新版安装包或便携版。`
                        : `当前版本 ${updateInfo.currentVersion}，GitHub Release 最新版本 ${updateInfo.latestVersion}。`
                  }
                  action={updateInfo.hasUpdate ? (
                    <Button size="small" icon={<DownloadOutlined />} href={updateInfo.releaseUrl} target="_blank" rel="noreferrer">
                      查看下载
                    </Button>
                  ) : undefined}
                />
              ) : null}
              <Space wrap>
                <Button
                  icon={<ReloadOutlined />}
                  loading={checkingUpdate}
                  onClick={() => void handleCheckForUpdates()}
                >
                  检查更新
                </Button>
                <Button
                  icon={<GithubOutlined />}
                  href={PROJECT_GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub 项目主页
                </Button>
                <a href={PROJECT_GITHUB_URL} target="_blank" rel="noreferrer">
                  {PROJECT_GITHUB_URL}
                </a>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Copyright © DieDust。本软件以 Apache-2.0 许可证发布。
              </Text>
            </Space>
          </Card>
        </section>

        <Form.Item>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} size="large" block onClick={() => void handleSave()}>
            保存设置
          </Button>
        </Form.Item>
          </div>
        </div>
      </Form>
      <Modal
        title={editingGlossaryTerm ? '编辑术语' : '新增术语'}
        open={glossaryModalOpen}
        onCancel={() => setGlossaryModalOpen(false)}
        onOk={() => void saveGlossaryTerm()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={glossaryForm} layout="vertical" preserve={false}>
          <Form.Item
            label="原词"
            name="sourceTerm"
            rules={[{ required: true, whitespace: true, message: '请输入原词' }]}
          >
            <Input placeholder="例如: sovereignty" maxLength={160} />
          </Form.Item>
          <Form.Item
            label="建议译名"
            name="targetTerm"
            rules={[{ required: true, whitespace: true, message: '请输入建议译名' }]}
          >
            <Input placeholder="例如: 主权" maxLength={160} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input.TextArea rows={3} placeholder="可写入学科语境、例外说明或参考来源" maxLength={600} />
          </Form.Item>
          <Space size={24}>
            <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
            <Form.Item name="caseSensitive" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch checkedChildren="区分大小写" unCheckedChildren="忽略大小写" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
})

export default SettingsView
