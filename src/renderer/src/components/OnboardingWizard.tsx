import { useState, useEffect } from 'react'
import { Modal, Steps, Button, Space, Typography, Input, Select, Alert, Card, message } from 'antd'
import { KeyOutlined, ApiOutlined, FormatPainterOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { useOnboardingStore } from '../stores/useOnboardingStore'
import { PRODUCT_NAME } from '@shared/types'

const { Title, Text, Paragraph } = Typography

const PRESET_ENDPOINTS: Record<string, { baseUrl: string; models: string[] }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
  Qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus'] },
  GLM: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash'] },
  '通义千问': { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max'] },
  Moonshot: { baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-128k'] },
  OpenAI: { baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  VolcEngine: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6', 'doubao-vision-pro'] },
  'Volc Coding Plan': {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite', 'deepseek-v3.2', 'glm-4.7', 'glm-4-7', 'kimi-k2.5', 'kimi-k2-5', 'gpt-oss-120b'],
  },
}

export default function OnboardingWizard() {
  const { currentStep, steps, nextStep, prevStep, completeStep, setVisible } = useOnboardingStore()
  const [apiKey, setApiKey] = useState('')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmProvider, setLlmProvider] = useState('DeepSeek')
  const [citationFormat, setCitationFormat] = useState('HistoryResearch')

  useEffect(() => {
    const loadSettings = async () => {
      const settings = await window.api.getAllSettings()
      setApiKey(settings.paddleocr_api_key || '')
      setLlmApiKey(settings.llm_api_key || '')
      setLlmProvider(settings.llm_provider || 'DeepSeek')
    }

    void loadSettings()
  }, [])

  const handleSaveApiKey = async () => {
    try {
      await window.api.setSetting('paddleocr_api_key', apiKey)
      const preset = PRESET_ENDPOINTS[llmProvider]
      await window.api.setSetting('llm_api_key', llmApiKey)
      await window.api.setSetting('llm_provider', llmProvider)
      await window.api.setSetting('llm_base_url', preset?.baseUrl || '')
      await window.api.setSetting('llm_model', preset?.models[0] || '')
      message.success('API Key 已保存')
      completeStep('api_key')
    } catch (error) {
      console.error(error)
      message.error('保存失败')
    }
  }

  const handleComplete = async () => {
    completeStep('citation_format')
    await window.api.completeOnboardingStep('api_key')
    await window.api.completeOnboardingStep('api_guide')
    await window.api.completeOnboardingStep('citation_format')
    setVisible(false)
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return (
          <div style={{ padding: '24px 0' }}>
            <Alert
              message="配置 API Key"
              description="OCR 识别和 AI 分析都依赖外部接口。先把这两组密钥填好，后面功能才能顺利跑起来。"
              type="info"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <Card title="PaddleOCR API Token" size="small" style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)' }}>
              <Input.Password
                placeholder="请输入 PaddleOCR API Token"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                addonBefore={<KeyOutlined />}
              />
              <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
                可前往 <a href="https://aistudio.baidu.com/" target="_blank" rel="noreferrer">百度飞桨 AI Studio</a> 获取。
              </Text>
            </Card>

            <Card title="AI 模型 API Key" size="small" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select value={llmProvider} onChange={setLlmProvider} style={{ width: '100%' }}>
                  {Object.keys(PRESET_ENDPOINTS).map((name) => (
                    <Select.Option key={name} value={name}>{name}</Select.Option>
                  ))}
                </Select>
                <Input.Password
                  placeholder="请输入 AI 模型 API Key"
                  value={llmApiKey}
                  onChange={(event) => setLlmApiKey(event.target.value)}
                  addonBefore={<KeyOutlined />}
                />
              </Space>
            </Card>

            <Button type="primary" onClick={() => void handleSaveApiKey()} style={{ marginTop: 16 }}>
              保存 API Key
            </Button>
          </div>
        )

      case 1:
        return (
          <div style={{ padding: '24px 0' }}>
            <Alert
              message="如何获取 API Key"
              description="这里给你一条最短路径，按平台各自的后台去拿密钥即可。"
              type="info"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <Card title="PaddleOCR（百度飞桨）" size="small" style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)' }}>
              <Paragraph style={{ color: 'var(--gs-text-secondary)' }}>
                1. 访问 <a href="https://aistudio.baidu.com/" target="_blank" rel="noreferrer">百度飞桨 AI Studio</a>
                <br />
                2. 登录百度账号
                <br />
                3. 创建或进入项目
                <br />
                4. 在项目设置中获取 API Token
                <br />
                5. 复制回上一步配置页
              </Paragraph>
            </Card>

            <Card title="DeepSeek" size="small" style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)' }}>
              <Paragraph style={{ color: 'var(--gs-text-secondary)' }}>
                1. 访问 <a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">DeepSeek 开放平台</a>
                <br />
                2. 登录账号
                <br />
                3. 进入 API Keys 页面
                <br />
                4. 新建 API Key
                <br />
                5. 复制回配置页
              </Paragraph>
            </Card>

            <Card title="通义千问（阿里云）" size="small" style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)' }}>
              <Paragraph style={{ color: 'var(--gs-text-secondary)' }}>
                1. 访问 <a href="https://dashscope.console.aliyun.com/" target="_blank" rel="noreferrer">阿里云 DashScope</a>
                <br />
                2. 开通 DashScope 服务
                <br />
                3. 在 API-KEY 管理中创建密钥
                <br />
                4. 复制回配置页
              </Paragraph>
            </Card>

            <Button type="primary" onClick={() => completeStep('api_guide')}>
              我知道怎么获取了
            </Button>
          </div>
        )

      case 2:
        return (
          <div style={{ padding: '24px 0' }}>
            <Alert
              message="选择默认引用格式"
              description="先选一个你最常用的格式，后面仍然可以在引用模板里继续新增或修改。"
              type="info"
              showIcon
              style={{ marginBottom: 24 }}
            />

            <Card size="small" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <Select value={citationFormat} onChange={setCitationFormat} style={{ width: '100%' }} size="large">
                <Select.Option value="HistoryResearch">《历史研究》注释体例</Select.Option>
                <Select.Option value="APA">APA (7th Edition)</Select.Option>
                <Select.Option value="MLA">MLA (9th Edition)</Select.Option>
                <Select.Option value="Chicago">Chicago (17th Edition)</Select.Option>
                <Select.Option value="GB-T7714">GB/T 7714-2015</Select.Option>
              </Select>

              <div style={{ marginTop: 16, padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>格式预览：</Text>
                <div style={{ marginTop: 8, color: 'var(--gs-text-primary)' }}>
                  {citationFormat === 'HistoryResearch' && '赵景深：《文坛忆旧》，上海：北新书局，1948 年，第 43 页。'}
                  {citationFormat === 'APA' && '张三 (2024). 论文标题. 期刊名称, 12(3), 45-67.'}
                  {citationFormat === 'MLA' && '张三. “论文标题.” 期刊名称, vol. 12, no. 3, 2024, pp. 45-67.'}
                  {citationFormat === 'Chicago' && '张三. “论文标题.” 期刊名称 12, no. 3 (2024): 45-67.'}
                  {citationFormat === 'GB-T7714' && '张三. 论文标题[J]. 期刊名称, 2024, 12(3): 45-67.'}
                </div>
              </div>
            </Card>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Modal
      open
      footer={null}
      closable
      onCancel={() => setVisible(false)}
      width={680}
      centered
      title={null}
    >
      <div style={{ padding: '16px 0' }}>
        <Title level={3} style={{ textAlign: 'center', color: 'var(--gs-gold)', marginBottom: 32 }}>
          欢迎使用{PRODUCT_NAME}
        </Title>

        <Steps
          current={currentStep}
          items={[
            { title: '配置 API Key', icon: <KeyOutlined /> },
            { title: '获取指引', icon: <ApiOutlined /> },
            { title: '引用格式', icon: <FormatPainterOutlined /> },
          ]}
          style={{ marginBottom: 32 }}
        />

        {renderStepContent()}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          <Button onClick={currentStep === 0 ? () => setVisible(false) : prevStep}>
            {currentStep === 0 ? '跳过引导' : '上一步'}
          </Button>
          <Space>
            {currentStep < steps.length - 1 ? (
              <Button type="primary" onClick={nextStep}>
                下一步
              </Button>
            ) : (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => void handleComplete()}>
                完成设置
              </Button>
            )}
          </Space>
        </div>
      </div>
    </Modal>
  )
}
