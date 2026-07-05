import { useEffect, useMemo, useState } from 'react'
import { Alert, AutoComplete, Button, Card, Checkbox, Input, Modal, Select, Space, Spin, Steps, Tag, Typography, message } from 'antd'
import { ApiOutlined, CheckCircleOutlined, DownloadOutlined, FileSearchOutlined, KeyOutlined, RobotOutlined } from '@ant-design/icons'
import type { SettingsMap } from '@shared/types'
import { PRODUCT_NAME } from '@shared/types'
import { useOnboardingStore } from '../stores/useOnboardingStore'

const { Text, Title } = Typography

type ProviderPreset = {
  name: string
  baseUrl: string
  models: string[]
}

const ONBOARDING_STEP_KEYS = ['welcome', 'paddle_ocr', 'ai_model', 'vision_ocr', 'finish'] as const
const LLM_PROFILE_SYNC_EVENT = 'gujismart:llm-profile-changed'
const SETTINGS_LOAD_TIMEOUT_MS = 3000
const PADDLE_OCR_APPLY_URL = 'https://aistudio.baidu.com/paddleocr'
const DEEPSEEK_APPLY_URL = 'https://platform.deepseek.com/'
const VOLCENGINE_ARK_API_KEY_URL = 'https://www.volcengine.com/docs/82379/1263279'

const AI_PROVIDER_PRESETS: ProviderPreset[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-plus'] },
  { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-128k'] },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  { name: '自定义', baseUrl: '', models: [] },
]

const VISION_PROVIDER_PRESETS: ProviderPreset[] = [
  { name: '火山方舟豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-2-0-pro-260215', 'doubao-vision-pro'] },
  { name: 'OpenAI Compatible', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  { name: '自定义', baseUrl: '', models: [] },
]

function hasText(value: unknown): boolean {
  return String(value || '').trim().length > 0
}

function isAiConfigured(settings: SettingsMap | null): boolean {
  if (!settings) return false
  return hasText(settings.llm_api_key) && hasText(settings.llm_base_url) && hasText(settings.llm_model)
}

function isPaddleConfigured(settings: SettingsMap | null): boolean {
  if (settings?.ocr_default_engine === 'local_paddle') return settings.local_paddle_ocr_status === 'installed'
  if (settings?.ocr_default_engine === 'vision_model') return isVisionConfigured(settings)
  return hasText(settings?.paddleocr_api_key)
}

function isVisionConfigured(settings: SettingsMap | null): boolean {
  if (!settings) return false
  if (settings.vision_ocr_use_llm_config !== 'false') return isAiConfigured(settings)
  return hasText(settings.vision_ocr_api_key) && hasText(settings.vision_ocr_base_url) && hasText(settings.vision_ocr_model)
}

function getPreset(name: string, presets: ProviderPreset[]): ProviderPreset {
  return presets.find((preset) => preset.name === name) || presets[0]
}

function normalizeProfileName(value: string, fallback: string): string {
  const trimmed = value.trim()
  return trimmed && trimmed !== '自定义' ? trimmed : fallback
}

async function completeOnboardingSteps(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await window.api.completeOnboardingStep(key)
  }
}

async function getAllSettingsForOnboarding(): Promise<SettingsMap> {
  let timedOut = false
  const fallback = new Promise<SettingsMap>((resolve) => {
    window.setTimeout(() => {
      timedOut = true
      resolve({})
    }, SETTINGS_LOAD_TIMEOUT_MS)
  })
  const settings = await Promise.race([window.api.getAllSettings(), fallback])
  if (timedOut) {
    message.warning('设置读取较慢，已先按未配置状态继续')
  }
  return settings
}

export default function OnboardingWizard() {
  const { currentStep, steps, setCurrentStep, nextStep, prevStep, completeStep, completeSteps, setVisible } = useOnboardingStore()
  const [settings, setSettings] = useState<SettingsMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [paddleApiKey, setPaddleApiKey] = useState('')
  const [paddleModel, setPaddleModel] = useState('PaddleOCR-VL-1.6')
  const [paddleModels, setPaddleModels] = useState<string[]>(['PaddleOCR-VL-1.6'])
  const [paddleModelsLoading, setPaddleModelsLoading] = useState(false)
  const [aiProvider, setAiProvider] = useState('DeepSeek')
  const [aiBaseUrl, setAiBaseUrl] = useState('https://api.deepseek.com/v1')
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiModel, setAiModel] = useState('deepseek-chat')
  const [aiModels, setAiModels] = useState<string[]>(['deepseek-chat', 'deepseek-reasoner'])
  const [aiModelsLoading, setAiModelsLoading] = useState(false)
  const [visionFollowAi, setVisionFollowAi] = useState(true)
  const [visionProvider, setVisionProvider] = useState('火山方舟豆包')
  const [visionBaseUrl, setVisionBaseUrl] = useState('https://ark.cn-beijing.volces.com/api/v3')
  const [visionApiKey, setVisionApiKey] = useState('')
  const [visionModel, setVisionModel] = useState('doubao-seed-2-0-pro-260215')
  const [visionModels, setVisionModels] = useState<string[]>(['doubao-seed-2-0-pro-260215', 'doubao-vision-pro'])
  const [visionModelsLoading, setVisionModelsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const nextSettings = await getAllSettingsForOnboarding()
        if (cancelled) return
        setSettings(nextSettings)
        setPaddleApiKey(nextSettings.paddleocr_api_key || '')
        setPaddleModel(nextSettings.ocr_async_model === 'PaddleOCR-VL' ? 'PaddleOCR-VL-1.6' : nextSettings.ocr_async_model || 'PaddleOCR-VL-1.6')
        const currentAiPreset = AI_PROVIDER_PRESETS.find((preset) => preset.name === nextSettings.llm_provider) || AI_PROVIDER_PRESETS[0]
        setAiProvider(nextSettings.llm_provider || currentAiPreset.name)
        setAiBaseUrl(nextSettings.llm_base_url || currentAiPreset.baseUrl)
        setAiApiKey(nextSettings.llm_api_key || '')
        setAiModel(nextSettings.llm_model || currentAiPreset.models[0] || '')
        setAiModels(currentAiPreset.models.length ? currentAiPreset.models : nextSettings.llm_model ? [nextSettings.llm_model] : [])
        const currentVisionPreset = VISION_PROVIDER_PRESETS.find((preset) => preset.baseUrl === String(nextSettings.vision_ocr_base_url || '').replace(/\/+$/, '')) || VISION_PROVIDER_PRESETS[0]
        setVisionFollowAi(nextSettings.vision_ocr_use_llm_config !== 'false')
        setVisionProvider(nextSettings.vision_ocr_provider || currentVisionPreset.name)
        setVisionBaseUrl(nextSettings.vision_ocr_base_url || currentVisionPreset.baseUrl)
        setVisionApiKey(nextSettings.vision_ocr_api_key || '')
        setVisionModel(nextSettings.vision_ocr_model || currentVisionPreset.models[0] || '')
        setVisionModels(currentVisionPreset.models.length ? currentVisionPreset.models : nextSettings.vision_ocr_model ? [nextSettings.vision_ocr_model] : [])
      } catch (error) {
        console.error(error)
        message.error('加载引导配置失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const statusItems = useMemo(() => [
    { key: 'paddle', title: 'PaddleOCR', description: '用于批量 OCR 和 PDF 文档解析', ready: isPaddleConfigured(settings), icon: <FileSearchOutlined /> },
    { key: 'ai', title: 'AI 模型', description: '用于问答、摘要、翻译和元数据提取', ready: isAiConfigured(settings), icon: <RobotOutlined /> },
    { key: 'vision', title: '视觉 OCR', description: '用于古籍、报纸和复杂版面识别', ready: isVisionConfigured(settings), icon: <ApiOutlined /> },
  ], [settings])

  const refreshSettings = async () => {
    const nextSettings = await getAllSettingsForOnboarding()
    setSettings(nextSettings)
    return nextSettings
  }

  const markStepComplete = async (key: string) => {
    completeStep(key)
    await window.api.completeOnboardingStep(key)
  }

  const handleSkipStep = async () => {
    setSaving(true)
    try {
      await markStepComplete(steps[currentStep]?.key || ONBOARDING_STEP_KEYS[currentStep])
      nextStep()
    } finally {
      setSaving(false)
    }
  }

  const handleSelectOcrMode = async (mode: 'local' | 'cloud' | 'ai') => {
    setSaving(true)
    try {
      if (mode === 'local') {
        const status = await window.api.downloadLocalPaddleOcr({ source: 'auto' })
        if (status.installed) {
          await window.api.setDefaultOcrEngine('local_paddle', 'local_paddle')
          await markStepComplete('paddle_ocr')
          message.success('本地 OCR 已设为默认')
          nextStep()
        } else {
          message.warning(status.message || '本地 OCR 尚未完整安装，可稍后在设置页手动导入 addon。')
        }
        return
      }
      if (mode === 'cloud') {
        await window.api.setDefaultOcrEngine('paddle', 'paddle')
        message.success('已选择飞桨云端 OCR，请继续填写 Token 或稍后补充。')
        return
      }
      await window.api.setDefaultOcrEngine('vision_model', 'vision_model')
      await markStepComplete('paddle_ocr')
      message.success('已选择 AI OCR，请继续配置 AI 模型。')
      nextStep()
    } catch (error) {
      console.error(error)
      message.error('选择 OCR 模式失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSavePaddle = async () => {
    setSaving(true)
    try {
      const token = paddleApiKey.trim()
      if (token) await window.api.setSetting('paddleocr_api_key', token)
      await window.api.setSetting('ocr_async_model', paddleModel.trim() || 'PaddleOCR-VL-1.6')
      await window.api.setDefaultOcrEngine('paddle', 'paddle')
      await refreshSettings()
      await markStepComplete('paddle_ocr')
      message.success(token ? 'PaddleOCR 已保存' : '已跳过 PaddleOCR Token')
      nextStep()
    } catch (error) {
      console.error(error)
      message.error('保存 PaddleOCR 配置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAi = async () => {
    const provider = normalizeProfileName(aiProvider, 'AI 服务商')
    const baseUrl = aiBaseUrl.trim()
    const model = aiModel.trim()
    if (!baseUrl || !model) {
      message.warning('请填写 API Base URL 和默认模型，或选择跳过')
      return
    }
    setSaving(true)
    try {
      await window.api.setSetting('llm_provider', provider)
      await window.api.setSetting('llm_base_url', baseUrl)
      await window.api.setSetting('llm_api_key', aiApiKey)
      await window.api.setSetting('llm_model', model)
      const upserted = await window.api.upsertLlmProviderProfile({
        id: '',
        name: provider,
        provider,
        baseUrl,
        apiKey: aiApiKey,
        model,
      })
      const profileId = upserted.profiles?.find((profile) => profile.provider === provider && profile.baseUrl === baseUrl && profile.model === model)?.id || upserted.profiles?.[0]?.id
      if (profileId) {
        const state = await window.api.switchLlmProviderProfile(profileId)
        window.dispatchEvent(new CustomEvent(LLM_PROFILE_SYNC_EVENT, { detail: state }))
      }
      await refreshSettings()
      await markStepComplete('ai_model')
      message.success(aiApiKey.trim() ? 'AI 模型已保存' : 'AI 模型已保存，稍后补 API Key 后即可使用')
      nextStep()
    } catch (error) {
      console.error(error)
      message.error('保存 AI 模型配置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveVision = async () => {
    setSaving(true)
    try {
      if (visionFollowAi) {
        await window.api.setSetting('vision_ocr_use_llm_config', 'true')
      } else {
        const provider = normalizeProfileName(visionProvider, '视觉 OCR')
        const baseUrl = visionBaseUrl.trim()
        const model = visionModel.trim()
        if (!baseUrl || !model) {
          message.warning('请填写视觉 OCR Base URL 和模型 ID，或选择跟随 AI 配置/跳过')
          return
        }
        await window.api.setSetting('vision_ocr_provider', provider)
        await window.api.setSetting('vision_ocr_base_url', baseUrl)
        await window.api.setSetting('vision_ocr_api_key', visionApiKey)
        await window.api.setSetting('vision_ocr_model', model)
        await window.api.setSetting('vision_ocr_use_llm_config', 'false')
        const upserted = await window.api.upsertVisionOcrProviderProfile({
          id: '',
          name: provider,
          provider,
          baseUrl,
          apiKey: visionApiKey,
          model,
        })
        const profileId = upserted.profiles?.find((profile) => profile.provider === provider && profile.baseUrl === baseUrl && profile.model === model)?.id || upserted.profiles?.[0]?.id
        if (profileId) await window.api.switchVisionOcrProviderProfile(profileId)
      }
      await window.api.setDefaultOcrEngine('vision_model', 'vision_model')
      await refreshSettings()
      await markStepComplete('vision_ocr')
      message.success(visionFollowAi ? '视觉 OCR 将跟随 AI 配置' : '视觉 OCR 配置已保存')
      nextStep()
    } catch (error) {
      console.error(error)
      message.error('保存视觉 OCR 配置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleFetchModels = async (kind: 'paddle' | 'ai' | 'vision') => {
    if (kind === 'paddle') {
      setPaddleModelsLoading(true)
      try {
        const apiKey = paddleApiKey.trim() || String(settings?.paddleocr_api_key || '').trim()
        const models = await window.api.listPaddleOcrModels(apiKey || undefined)
        setPaddleModels(models.length ? models : paddleModels)
        if (models[0]) setPaddleModel(models[0])
        message.success(`已加载 ${models.length} 个 PaddleOCR 模型`)
      } catch (error) {
        console.error(error)
        message.warning('拉取 PaddleOCR 模型失败，可继续使用默认模型')
      } finally {
        setPaddleModelsLoading(false)
      }
      return
    }

    const baseUrl = kind === 'ai' ? aiBaseUrl : visionBaseUrl
    const apiKey = kind === 'ai' ? aiApiKey : visionApiKey
    const setLoadingState = kind === 'ai' ? setAiModelsLoading : setVisionModelsLoading
    const setOptions = kind === 'ai' ? setAiModels : setVisionModels
    const setModel = kind === 'ai' ? setAiModel : setVisionModel
    const presets = kind === 'ai' ? AI_PROVIDER_PRESETS : VISION_PROVIDER_PRESETS
    const fallbackPreset = presets.find((item) => item.baseUrl === baseUrl.trim().replace(/\/+$/, ''))
    if (!baseUrl.trim() || !apiKey.trim()) {
      if (fallbackPreset?.models?.length) setOptions(fallbackPreset.models)
      return
    }
    setLoadingState(true)
    try {
      const models = await window.api.listModels(baseUrl.trim(), apiKey.trim())
      setOptions([...new Set([...(fallbackPreset?.models || []), ...models])])
      if (models[0]) setModel(models[0])
      message.success(`已加载 ${models.length} 个模型`)
    } catch (error) {
      console.error(error)
      message.warning('拉取模型列表失败，可继续手动填写模型 ID')
    } finally {
      setLoadingState(false)
    }
  }

  const handleAiProviderChange = (providerName: string) => {
    const preset = getPreset(providerName, AI_PROVIDER_PRESETS)
    setAiProvider(providerName)
    if (preset.baseUrl) setAiBaseUrl(preset.baseUrl)
    if (preset.models[0]) setAiModel(preset.models[0])
    setAiModels(preset.models)
  }

  const handleVisionProviderChange = (providerName: string) => {
    const preset = getPreset(providerName, VISION_PROVIDER_PRESETS)
    setVisionProvider(providerName)
    if (preset.baseUrl) setVisionBaseUrl(preset.baseUrl)
    if (preset.models[0]) setVisionModel(preset.models[0])
    setVisionModels(preset.models)
  }

  const handleComplete = async (target?: 'library' | 'settings') => {
    setSaving(true)
    try {
      completeSteps([...ONBOARDING_STEP_KEYS])
      await completeOnboardingSteps(ONBOARDING_STEP_KEYS)
      await refreshSettings()
      setVisible(false)
      if (target === 'library') window.dispatchEvent(new CustomEvent('gujismart:onboarding-action', { detail: { action: 'open-library-import' } }))
      if (target === 'settings') window.dispatchEvent(new CustomEvent('gujismart:onboarding-action', { detail: { action: 'open-settings' } }))
    } finally {
      setSaving(false)
    }
  }

  const renderStatusCard = (item: typeof statusItems[number]) => (
    <Card key={item.key} size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <Space align="start">
        <span style={{ color: item.ready ? 'var(--gs-gold)' : 'var(--gs-text-secondary)', fontSize: 18 }}>{item.icon}</span>
        <Space direction="vertical" size={2}>
          <Space>
            <Text strong style={{ color: 'var(--gs-text-primary)' }}>{item.title}</Text>
            <Tag color={item.ready ? 'success' : 'default'}>{item.ready ? '已配置' : '可稍后配置'}</Tag>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>{item.description}</Text>
        </Space>
      </Space>
    </Card>
  )

  const renderStepContent = () => {
    if (loading) return <div style={{ minHeight: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>

    switch (steps[currentStep]?.key) {
      case 'welcome':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="先把关键接口接好，后面导入、OCR、问答会顺很多"
              description="这些配置都可以跳过，也可以之后在设置页重新修改。引导不会阻止你进入软件。"
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              {statusItems.map(renderStatusCard)}
            </div>
          </Space>
        )
      case 'paddle_ocr':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="PaddleOCR 用于普通 OCR 和 PDF 文档解析"
              description={<span>没有 Token 也可以先跳过。需要 OCR 时，可前往 <a href={PADDLE_OCR_APPLY_URL} target="_blank" rel="noreferrer">飞桨 PaddleOCR 服务页</a> 申请。</span>}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <Button block icon={<DownloadOutlined />} loading={saving} onClick={() => void handleSelectOcrMode('local')}>
                下载本地 OCR
              </Button>
              <Button block icon={<ApiOutlined />} loading={saving} onClick={() => void handleSelectOcrMode('cloud')}>
                填写云端 OCR
              </Button>
              <Button block icon={<RobotOutlined />} loading={saving} onClick={() => void handleSelectOcrMode('ai')}>
                使用 AI OCR
              </Button>
            </div>
            <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>API Token</Text>
                <Input.Password prefix={<KeyOutlined />} placeholder="粘贴 PaddleOCR API Token" value={paddleApiKey} onChange={(event) => setPaddleApiKey(event.target.value)} />
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>PDF 异步 OCR 模型</Text>
                <AutoComplete options={paddleModels.map((model) => ({ value: model }))} value={paddleModel} onChange={setPaddleModel}>
                  <Input suffix={<Button type="text" size="small" loading={paddleModelsLoading} onClick={() => void handleFetchModels('paddle')}>拉取</Button>} />
                </AutoComplete>
              </Space>
            </Card>
          </Space>
        )
      case 'ai_model':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="AI 模型用于问答、摘要、翻译和元数据提取"
              description={<span>推荐先用 DeepSeek 预设，申请地址：<a href={DEEPSEEK_APPLY_URL} target="_blank" rel="noreferrer">DeepSeek 开放平台</a>。API Key 可稍后再补。</span>}
            />
            <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>模型提供方</Text>
                <Select value={aiProvider} onChange={handleAiProviderChange} options={AI_PROVIDER_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))} />
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>API Base URL</Text>
                <Input prefix={<ApiOutlined />} value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" />
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>API Key</Text>
                <Input.Password prefix={<KeyOutlined />} value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="粘贴 AI API Key" />
                <Text strong style={{ color: 'var(--gs-text-primary)' }}>默认模型</Text>
                <AutoComplete options={aiModels.map((model) => ({ value: model }))} value={aiModel} onChange={setAiModel}>
                  <Input suffix={<Button type="text" size="small" loading={aiModelsLoading} onClick={() => void handleFetchModels('ai')}>拉取</Button>} />
                </AutoComplete>
              </Space>
            </Card>
          </Space>
        )
      case 'vision_ocr':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="视觉 OCR 适合古籍、报纸和复杂版面"
              description={<span>默认跟随 AI 配置，不需要重复填写。若你使用火山方舟等视觉模型，可在这里单独配置。<a href={VOLCENGINE_ARK_API_KEY_URL} target="_blank" rel="noreferrer">查看 API Key 说明</a></span>}
            />
            <Checkbox checked={visionFollowAi} onChange={(event) => setVisionFollowAi(event.target.checked)}>
              跟随 AI 模型接口配置
            </Checkbox>
            {!visionFollowAi ? (
              <Card size="small" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>视觉服务商</Text>
                  <Select value={visionProvider} onChange={handleVisionProviderChange} options={VISION_PROVIDER_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))} />
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>API Base URL</Text>
                  <Input prefix={<ApiOutlined />} value={visionBaseUrl} onChange={(event) => setVisionBaseUrl(event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/v3" />
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>API Key</Text>
                  <Input.Password prefix={<KeyOutlined />} value={visionApiKey} onChange={(event) => setVisionApiKey(event.target.value)} placeholder="粘贴视觉模型 API Key" />
                  <Text strong style={{ color: 'var(--gs-text-primary)' }}>视觉模型 ID</Text>
                  <AutoComplete options={visionModels.map((model) => ({ value: model }))} value={visionModel} onChange={setVisionModel}>
                    <Input suffix={<Button type="text" size="small" loading={visionModelsLoading} onClick={() => void handleFetchModels('vision')}>拉取</Button>} />
                  </AutoComplete>
                </Space>
              </Card>
            ) : null}
          </Space>
        )
      case 'finish':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="success"
              showIcon
              message="引导完成"
              description="你现在可以开始导入文献。未配置的能力不会阻止使用，之后可以随时到设置页补齐。"
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              {statusItems.map(renderStatusCard)}
            </div>
          </Space>
        )
      default:
        return null
    }
  }

  const currentKey = steps[currentStep]?.key || 'welcome'
  const isLastStep = currentKey === 'finish'

  return (
    <Modal
      open
      footer={null}
      closable
      onCancel={() => setVisible(false)}
      width={760}
      centered
      title={null}
      destroyOnClose
    >
      <div style={{ padding: '12px 0 4px' }}>
        <Title level={3} style={{ textAlign: 'center', color: 'var(--gs-gold)', marginBottom: 24 }}>
          欢迎使用 {PRODUCT_NAME}
        </Title>
        <Steps
          current={currentStep}
          size="small"
          items={steps.map((step) => ({ title: step.title, description: step.completed ? '已处理' : undefined }))}
          onChange={(step) => setCurrentStep(step)}
          style={{ marginBottom: 24 }}
        />
        <div style={{ minHeight: 320 }}>{renderStepContent()}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 24 }}>
          <Button disabled={currentStep === 0 || saving} onClick={prevStep}>
            上一步
          </Button>
          <Space wrap>
            {!isLastStep ? (
              <Button disabled={saving || loading} onClick={() => void handleSkipStep()}>
                跳过本步
              </Button>
            ) : null}
            {currentKey === 'welcome' ? (
              <Button type="primary" loading={saving} onClick={nextStep}>开始配置</Button>
            ) : currentKey === 'paddle_ocr' ? (
              <Button type="primary" loading={saving} onClick={() => void handleSavePaddle()}>保存并继续</Button>
            ) : currentKey === 'ai_model' ? (
              <Button type="primary" loading={saving} onClick={() => void handleSaveAi()}>保存并继续</Button>
            ) : currentKey === 'vision_ocr' ? (
              <Button type="primary" loading={saving} onClick={() => void handleSaveVision()}>保存并继续</Button>
            ) : (
              <>
                <Button loading={saving} onClick={() => void handleComplete('settings')}>进入设置页</Button>
                <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} onClick={() => void handleComplete('library')}>去导入文献</Button>
              </>
            )}
          </Space>
        </div>
      </div>
    </Modal>
  )
}
