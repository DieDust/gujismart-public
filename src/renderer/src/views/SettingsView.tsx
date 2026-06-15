import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Form, Input, Select, Card, Button, Typography, message, Switch, Slider, InputNumber, Alert, Space, Tag, Popconfirm, List, AutoComplete, Modal, Tooltip, Progress } from 'antd'
import {
  BookOutlined,
  KeyOutlined,
  ApiOutlined,
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
import { PRODUCT_FULL_NAME, PRODUCT_NAME, PRODUCT_SUBTITLE, type AppUpdateInfo, type BackupStatus, type BackgroundTaskProgressEvent, type DatabaseStorageDiagnostics, type LlmProviderProfile, type PdfRepositoryStatus, type ResearchProject, type TranslationGlossaryScope, type TranslationGlossaryTerm } from '@shared/types'

const { Title, Text } = Typography

type SettingsSectionKey =
  | 'automation'
  | 'shortcuts'
  | 'pdfRepository'
  | 'batch'
  | 'data'
  | 'paddleOcr'
  | 'visionOcr'
  | 'ai'
  | 'glossary'
  | 'about'

const SETTINGS_SECTIONS: Array<{ key: SettingsSectionKey; label: string; icon: ReactNode }> = [
  { key: 'automation', label: '自动化', icon: <ThunderboltOutlined /> },
  { key: 'shortcuts', label: '快捷键', icon: <KeyOutlined /> },
  { key: 'pdfRepository', label: 'PDF 原件仓库', icon: <FolderOpenOutlined /> },
  { key: 'batch', label: '批量处理', icon: <SettingOutlined /> },
  { key: 'data', label: '数据管理', icon: <DatabaseOutlined /> },
  { key: 'paddleOcr', label: 'PaddleOCR 接口', icon: <ApiOutlined /> },
  { key: 'visionOcr', label: '视觉模型 OCR', icon: <ApiOutlined /> },
  { key: 'ai', label: 'AI 模型接口', icon: <ApiOutlined /> },
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

const PADDLE_OCR_APPLY_URL = 'https://aistudio.baidu.com/paddleocr'
const DEEPSEEK_APPLY_URL = 'https://platform.deepseek.com/'
const VOLCENGINE_ARK_QUICKSTART_URL = 'https://www.volcengine.com/docs/82379/1399008'
const VOLCENGINE_ARK_API_KEY_URL = 'https://www.volcengine.com/docs/82379/1263279'
const VOLCENGINE_ARK_ENDPOINT_URL = 'https://www.volcengine.com/docs/82379/1182403?lang=zh'
const PROJECT_GITHUB_URL = 'https://github.com/DieDust/gujismart-public/'
const LLM_PROFILE_SYNC_EVENT = 'gujismart:llm-profile-changed'

const SHORTCUT_ITEMS: Array<{ action: ShortcutAction; label: string; hint: string }> = [
  { action: 'back', label: '返回 / 退出', hint: '阅读页返回文库；主界面触发退出确认' },
  { action: 'previousPage', label: '上一页', hint: '阅读器向前翻页；上下方向键用于滚动正文' },
  { action: 'nextPage', label: '下一页', hint: '阅读器向后翻页；上下方向键用于滚动正文' },
  { action: 'translate', label: '翻译', hint: '打开或收起当前页翻译' },
  { action: 'search', label: '检索', hint: '聚焦当前页面的检索框' },
  { action: 'selectAll', label: '文库全选', hint: '文库页进入批量模式并选中当前列表' },
  { action: 'invertSelection', label: '文库反选', hint: '文库页进入批量模式并反选当前列表' },
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

function formatCount(value?: number): string {
  return Math.max(0, Number(value || 0)).toLocaleString()
}

function hasLegacySearchIndexMaintenance(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  if (!diagnostics) return true
  return Boolean(diagnostics.requiredMaintenance?.required)
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
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionKey>('automation')
  const [autoOcr, setAutoOcr] = useState(true)
  const [autoAi, setAutoAi] = useState(true)
  const [autoDeletePdfAssets, setAutoDeletePdfAssets] = useState(false)
  const [preferFacsimileProofLayout, setPreferFacsimileProofLayout] = useState(true)
  const [metadataTagBindingEnabled, setMetadataTagBindingEnabled] = useState(false)
  const metadataTagBindingEnabledRef = useRef(false)
  const [pdfRepositoryStatus, setPdfRepositoryStatus] = useState<PdfRepositoryStatus | null>(null)
  const [pdfRepositoryBusy, setPdfRepositoryBusy] = useState(false)
  const [batchSize, setBatchSize] = useState(5)
  const [retryCount, setRetryCount] = useState(3)
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
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
  const [llmProfileBusy, setLlmProfileBusy] = useState(false)
  const [visionOcrProfiles, setVisionOcrProfiles] = useState<LlmProviderProfile[]>([])
  const [activeVisionOcrProfileId, setActiveVisionOcrProfileId] = useState('')
  const [visionOcrProfileBusy, setVisionOcrProfileBusy] = useState(false)
  const [paddleOcrModelOptions, setPaddleOcrModelOptions] = useState<string[]>([])
  const [paddleOcrModelsLoading, setPaddleOcrModelsLoading] = useState(false)
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
        form.setFieldsValue({
          paddleocr_api_key: settings.paddleocr_api_key || '',
          ocr_async_model: settings.ocr_async_model === 'PaddleOCR-VL' ? 'PaddleOCR-VL-1.6' : settings.ocr_async_model || 'PaddleOCR-VL-1.6',
          ocr_upload_timeout_seconds: settings.ocr_upload_timeout_seconds || '3600',
          ocr_max_image_side: settings.ocr_max_image_side || '2200',
          ocr_jpeg_quality: settings.ocr_jpeg_quality || '82',
          pdf_compression_enabled: settings.pdf_compression_enabled === 'true',
          pdf_compression_min_size_mb: settings.pdf_compression_min_size_mb || '10',
          pdf_compression_quality: settings.pdf_compression_quality || settings.ocr_jpeg_quality || '80',
          llm_provider: settings.llm_provider || 'DeepSeek',
          llm_api_key: settings.llm_api_key || '',
          llm_base_url: settings.llm_base_url || 'https://api.deepseek.com/v1',
          llm_model: settings.llm_model || 'deepseek-v4-flash',
          vision_ocr_base_url: settings.vision_ocr_base_url || DEFAULT_VISION_PROVIDER.baseUrl,
          vision_ocr_provider: normalizeVisionProviderName(settings.vision_ocr_provider),
          vision_ocr_api_key: settings.vision_ocr_api_key || '',
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
        setAutoOcr(settings.auto_ocr_after_import !== 'false')
        setAutoAi(settings.auto_ai_after_ocr !== 'false')
        setAutoDeletePdfAssets(settings.auto_delete_pdf_assets_after_ocr === 'true')
        setPreferFacsimileProofLayout(settings.prefer_facsimile_proof_layout !== 'false')
        const nextMetadataTagBindingEnabled = settings.metadata_tag_binding_enabled === 'true'
        metadataTagBindingEnabledRef.current = nextMetadataTagBindingEnabled
        setMetadataTagBindingEnabled(nextMetadataTagBindingEnabled)
        setBatchSize(parseInt(settings.batch_size || '5', 10))
        setRetryCount(parseInt(settings.retry_count || '3', 10))
        const llmProfileState = await window.api.listLlmProviderProfiles()
        setLlmProfiles(llmProfileState.profiles || [])
        setActiveLlmProfileId(llmProfileState.activeId || '')
        const visionOcrProfileState = await window.api.listVisionOcrProviderProfiles()
        setVisionOcrProfiles(visionOcrProfileState.profiles || [])
        setActiveVisionOcrProfileId(visionOcrProfileState.activeId || '')
        const status = await window.api.getBackupStatus()
        setBackupStatus(status)
        syncAutoBackupDraft(status)
        setPdfRepositoryStatus(await window.api.listPdfRepositories())
        setAppVersion(await window.api.getVersion())
        setResearchProjects(await window.api.listResearchProjects())
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
      form.setFieldsValue({
        llm_provider: detail.current.provider || detail.current.name,
        llm_base_url: detail.current.baseUrl,
        llm_api_key: detail.current.apiKey,
        llm_model: detail.current.model,
      })
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: detail.current.provider || detail.current.name,
          vision_ocr_base_url: detail.current.baseUrl,
          vision_ocr_api_key: detail.current.apiKey,
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
        if (value !== undefined && value !== null) {
          await window.api.setSetting(key, String(value))
        }
      }
      await window.api.setSetting('auto_ocr_after_import', autoOcr ? 'true' : 'false')
      await window.api.setSetting('auto_ai_after_ocr', autoAi ? 'true' : 'false')
      await window.api.setSetting('auto_delete_pdf_assets_after_ocr', autoDeletePdfAssets ? 'true' : 'false')
      await window.api.setSetting('prefer_facsimile_proof_layout', preferFacsimileProofLayout ? 'true' : 'false')
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
        const upserted = await window.api.upsertLlmProviderProfile({
          id: '',
          name: providerName,
          provider: providerName,
          baseUrl: String(values.llm_base_url || '').trim(),
          apiKey: String(values.llm_api_key || ''),
          model: String(values.llm_model || '').trim(),
        })
        const profileId = upserted.profiles?.[0]?.id
        if (!profileId) throw new Error('AI 服务商配置保存失败')
        const state = await window.api.switchLlmProviderProfile(profileId)
        setLlmProfiles(state.profiles || [])
        setActiveLlmProfileId(state.activeId || '')
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
    preferFacsimileProofLayout,
    retryCount,
    setSettingsDirty,
    syncAutoBackupDraft,
  ])

  useImperativeHandle(ref, () => ({
    save: handleSave,
  }), [handleSave])

  const handleProviderChange = (provider: string) => {
    const preset = AI_PROVIDER_PRESETS.find((item) => item.name === provider)
    if (!preset) return
    form.setFieldsValue({
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
    if (!baseUrl || !apiKey) {
      if (fallbackPreset?.models?.length) setOptions(fallbackPreset.models)
      return
    }

    setLoading(true)
    try {
      const models = await window.api.listModels(baseUrl, apiKey)
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
  const refreshLlmProfiles = async () => {
    const state = await window.api.listLlmProviderProfiles()
    setLlmProfiles(state.profiles || [])
    setActiveLlmProfileId(state.activeId || '')
    return state
  }

  const handleSaveCurrentLlmProfile = async () => {
    setLlmProfileBusy(true)
    try {
      const values = form.getFieldsValue()
      const providerName = String(values.llm_provider || 'custom').trim()
      const upserted = await window.api.upsertLlmProviderProfile({
        id: '',
        name: providerName,
        provider: providerName,
        baseUrl: String(values.llm_base_url || '').trim(),
        apiKey: String(values.llm_api_key || ''),
        model: String(values.llm_model || '').trim(),
      })
      const profileId = upserted.profiles?.[0]?.id
      if (!profileId) throw new Error('AI 服务商配置保存失败')
      const result = await window.api.switchLlmProviderProfile(profileId)
      setLlmProfiles(result.profiles?.length ? result.profiles : upserted.profiles || [])
      setActiveLlmProfileId(result.activeId || '')
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: result.current?.provider || result.current?.name,
          vision_ocr_base_url: result.current?.baseUrl || '',
          vision_ocr_api_key: result.current?.apiKey || '',
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
      form.setFieldsValue({
        llm_provider: result.current.provider || result.current.name,
        llm_base_url: result.current.baseUrl,
        llm_api_key: result.current.apiKey,
        llm_model: result.current.model,
      })
      if (form.getFieldValue('vision_ocr_use_llm_config')) {
        form.setFieldsValue({
          vision_ocr_provider: result.current.provider || result.current.name,
          vision_ocr_base_url: result.current.baseUrl,
          vision_ocr_api_key: result.current.apiKey,
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
    return state
  }

  const handleSaveCurrentVisionOcrProfile = async () => {
    setVisionOcrProfileBusy(true)
    try {
      const values = form.getFieldsValue()
      const providerName = String(values.vision_ocr_provider || values.llm_provider || '视觉 OCR').trim()
      const upserted = await window.api.upsertVisionOcrProviderProfile({
        id: '',
        name: providerName,
        provider: providerName,
        baseUrl: String(values.vision_ocr_base_url || '').trim(),
        apiKey: String(values.vision_ocr_api_key || ''),
        model: String(values.vision_ocr_model || '').trim(),
      })
      const profileId = upserted.profiles?.[0]?.id
      if (!profileId) throw new Error('视觉 OCR 服务商配置保存失败')
      const result = await window.api.switchVisionOcrProviderProfile(profileId)
      setVisionOcrProfiles(result.profiles?.length ? result.profiles : upserted.profiles || [])
      setActiveVisionOcrProfileId(result.activeId || '')
      form.setFieldsValue({
        vision_ocr_provider: result.current.provider || result.current.name,
        vision_ocr_base_url: result.current.baseUrl,
        vision_ocr_api_key: result.current.apiKey,
        vision_ocr_model: result.current.model,
        vision_ocr_use_llm_config: false,
      })
      setVisionModelOptions(result.current.model ? [String(result.current.model)] : [])
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
      form.setFieldsValue({
        vision_ocr_provider: result.current.provider || result.current.name,
        vision_ocr_base_url: result.current.baseUrl,
        vision_ocr_api_key: result.current.apiKey,
        vision_ocr_model: result.current.model,
        vision_ocr_use_llm_config: false,
      })
      setVisionModelOptions(result.current.model ? [String(result.current.model)] : [])
      message.success(`已切换视觉 OCR 服务商：${result.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '切换视觉 OCR 服务商失败'))
    } finally {
      setVisionOcrProfileBusy(false)
    }
  }

  const handleDeleteVisionOcrProfile = async (profileId: string) => {
    setVisionOcrProfileBusy(true)
    try {
      const result = await window.api.deleteVisionOcrProviderProfile(profileId)
      setVisionOcrProfiles(result.profiles || [])
      setActiveVisionOcrProfileId(result.activeId || '')
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
        message.success(`已备份到 ${result.path}`)
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
      message.info({ content: '旧搜索索引已经清理完成，无需再次瘦身。', key: 'database-maintenance', duration: 4 })
      setDatabaseDiagnostics(await window.api.getDatabaseStorageDiagnostics())
      return
    }
    setDatabaseMaintenanceBusy(true)
    setDatabaseMaintenanceProgress(null)
    message.loading({ content: '正在清理旧搜索索引并提交轻量索引重建任务，窗口不会被完整压缩阻塞，请稍候...', key: 'database-maintenance', duration: 0 })
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

  const refreshPdfRepositoryStatus = async () => {
    setPdfRepositoryStatus(await window.api.listPdfRepositories())
  }

  const handleAddPdfRepository = async () => {
    setPdfRepositoryBusy(true)
    try {
      const selected = await window.api.selectPdfRepositoryFolder()
      if (selected) {
        await refreshPdfRepositoryStatus()
        message.success('已添加 PDF 原件仓库')
      }
    } finally {
      setPdfRepositoryBusy(false)
    }
  }

  const handleRemovePdfRepository = async (path: string) => {
    setPdfRepositoryBusy(true)
    try {
      const paths = (pdfRepositoryStatus?.paths || []).filter((item) => item !== path)
      setPdfRepositoryStatus(await window.api.setPdfRepositoryPaths(paths))
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
                <Text type="secondary" style={{ fontSize: 13 }}>只清理软件数据目录里的 PDF 副本和页图缓存；PDF 原件仓库中的文件只读不动。</Text>
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
              可写 Ctrl+F、Alt+A、Esc、ArrowLeft。阅读器里上下方向键固定用于滚动正文，输入框内保留系统默认编辑快捷键。
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
              message="PDF 原件仓库只会被读取和复制"
              description="可以添加 NAS、移动硬盘或资料库目录，软件会只读扫描并匹配已导入文献的 PDF 原件。"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>
                  已匹配 {pdfRepositoryStatus?.stats.fileCount || 0} 个文献库 PDF 原件
                </Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  总大小 {formatBytes(pdfRepositoryStatus?.stats.totalBytes)}；上次扫描 {formatDateTime(pdfRepositoryStatus?.lastIndexedAt)}
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
                  title="只会删除软件目录内的 PDF 副本和页图缓存，不会修改 PDF 原件仓库。确定清理已完成 OCR 的 PDF 原图吗？"
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
              {(pdfRepositoryStatus?.paths || []).length > 0 ? (pdfRepositoryStatus?.paths || []).map((path) => (
                <div
                  key={path}
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
                  <Text ellipsis title={path} style={{ color: 'var(--gs-text-secondary)' }}>{path}</Text>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void handleRemovePdfRepository(path)} />
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
                  <Text type="secondary" style={{ fontSize: 12 }}>可压缩空闲页</Text>
                  <br />
                  <Text strong>{formatBytes(databaseDiagnostics?.freelistBytes)}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>ngram 行数</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.ngramRows || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>旧单字索引</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.singleCharNgramRows || 0).toLocaleString()}</Text>
                </div>
                <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>trigram FTS</Text>
                  <br />
                  <Text strong>{(databaseDiagnostics?.searchIndex.searchSegmentsTrigramRows || 0).toLocaleString()}</Text>
                </div>
              </div>

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
                  title={hasLegacySearchIndexMaintenance(databaseDiagnostics)
                    ? '会分批清理体积很大的 ngram 候选索引，并提交轻量 trigram FTS 索引重建任务；不删除文献、OCR 文本、PDF 原文。搜索会回到真实文本核验，准确性不受影响。为避免长时间未响应，本步骤不会自动压缩数据库；索引重建完成后可在空闲时单独点击“压缩数据库”释放磁盘空间。'
                    : '旧搜索索引已经清理完成，无需再次瘦身。'}
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
                    title={hasLegacySearchIndexMaintenance(databaseDiagnostics) ? undefined : '旧搜索索引已经清理完成，无需再次瘦身'}
                  >
                    一键瘦身搜索索引
                  </Button>
                </Popconfirm>
                <Button icon={<ExportOutlined />} loading={databaseMaintenanceBusy} onClick={() => void handleExportDatabaseDiagnostics()}>
                  导出诊断报告
                </Button>
                <Popconfirm
                  title="压缩数据库可能需要较长时间和额外临时空间，过程中请不要强制退出软件。"
                  okText="压缩"
                  cancelText="取消"
                  onConfirm={() => void handleCompactDatabase()}
                >
                  <Button icon={<DatabaseOutlined />} loading={databaseMaintenanceBusy}>
                    压缩数据库
                  </Button>
                </Popconfirm>
              </Space>
            </Card>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 16, alignItems: 'start' }}>
              <div>
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
                <Button block icon={<DownloadOutlined />} loading={backupBusy} onClick={() => void handleCreateBackup()}>
                  导出完整备份
                </Button>
                <Popconfirm
                  title="导入备份会覆盖当前数据库和配置，软件会先创建安全副本。确定继续吗？"
                  okText="导入备份"
                  cancelText="取消"
                  onConfirm={() => void handleImportBackup()}
                >
                  <Button block danger icon={<ImportOutlined />} loading={backupBusy}>
                    导入备份
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

        <section className="settings-section" hidden={activeSettingsSection !== 'paddleOcr'}>
          <div className="settings-section-title">
            <ApiOutlined /> PaddleOCR 接口
          </div>
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
            <Form.Item label="API Token" name="paddleocr_api_key" extra="例如：abc123def456...">
              <Input.Password prefix={<KeyOutlined />} placeholder="请输入 PaddleOCR API Token" />
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
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'visionOcr'}>
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
            <Form.Item label="API Key" name="vision_ocr_api_key">
              <Input.Password prefix={<KeyOutlined />} placeholder="请输入视觉模型 API Key" />
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
                    <Button size="small" type="primary" loading={visionOcrProfileBusy} onClick={() => void handleSaveCurrentVisionOcrProfile()}>
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
                          <Button key="switch" size="small" type={active ? 'primary' : 'default'} disabled={active || visionOcrProfileBusy} onClick={() => void handleSwitchVisionOcrProfile(profile.id)}>
                            {active ? '使用中' : '切换'}
                          </Button>,
                          <Popconfirm key="delete" title="删除这个视觉 OCR 服务商配置？" disabled={active} onConfirm={() => void handleDeleteVisionOcrProfile(profile.id)}>
                            <Button size="small" danger disabled={active || visionOcrProfileBusy}>删除</Button>
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
        </section>

        <section className="settings-section" hidden={activeSettingsSection !== 'ai'}>
          <div className="settings-section-title">
            <ApiOutlined /> AI 模型接口
          </div>
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
            <Form.Item label="API Key" name="llm_api_key">
              <Input.Password prefix={<KeyOutlined />} placeholder="请输入 API Key" />
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
