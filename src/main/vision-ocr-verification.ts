import { createHash } from 'crypto'
import { queryOne, run, saveDatabase } from './database'
import { readProtectedSetting } from './settings-security'
import type { VisionOcrConnectionTestState } from '../shared/types'

interface VerificationRecord {
  fingerprint: string
  testedAt: string
}

type VerificationMap = Record<string, VerificationRecord>

const VERIFICATION_SETTING_KEY = 'vision_ocr_connection_verifications_v1'
const TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1AAAAAASUVORK5CYII='

function readSetting(key: string): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || '')
}

function normalizeBaseUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

function hashSecret(value: string): string {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function createFingerprint(baseUrl: string, model: string, apiKey: string): string {
  return createHash('sha256')
    .update(`${normalizeBaseUrl(baseUrl)}\n${String(model || '').trim()}\n${hashSecret(apiKey)}`)
    .digest('hex')
}

function readVerificationMap(): VerificationMap {
  try {
    const parsed = JSON.parse(readSetting(VERIFICATION_SETTING_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as VerificationMap : {}
  } catch {
    return {}
  }
}

function writeVerificationMap(value: VerificationMap): void {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [VERIFICATION_SETTING_KEY, JSON.stringify(value)],
  )
  saveDatabase()
}

export function getVisionOcrConnectionState(profileId: string, baseUrl: string, model: string, apiKey: string): VisionOcrConnectionTestState {
  const record = readVerificationMap()[String(profileId || '').trim()]
  const verified = Boolean(record && apiKey && record.fingerprint === createFingerprint(baseUrl, model, apiKey))
  return { verified, testedAt: verified ? record.testedAt : undefined }
}

export function markVisionOcrConnectionVerified(profileId: string, baseUrl: string, model: string, apiKey: string): VisionOcrConnectionTestState {
  const testedAt = new Date().toISOString()
  const records = readVerificationMap()
  records[String(profileId || '').trim()] = {
    fingerprint: createFingerprint(baseUrl, model, apiKey),
    testedAt,
  }
  writeVerificationMap(records)
  return { verified: true, testedAt }
}

export function clearVisionOcrConnectionVerification(profileId: string): void {
  const id = String(profileId || '').trim()
  const records = readVerificationMap()
  if (!id || !records[id]) return
  delete records[id]
  writeVerificationMap(records)
}

export function assertVisionOcrProfileVerified(profileId: string, baseUrl: string, model: string, apiKey: string): void {
  if (getVisionOcrConnectionState(profileId, baseUrl, model, apiKey).verified) return
  throw new Error('请先测试 AI OCR 连接，测试成功后才能保存或使用此配置。')
}

export function getFollowAiVisionProfileId(): string {
  const activeId = readSetting('llm_active_provider_id') || readSetting('llm_provider') || 'default'
  return `vision_follow_ai:${activeId}`
}

export function isCurrentVisionOcrConnectionVerified(): boolean {
  const useLlmConfig = readSetting('vision_ocr_use_llm_config') !== 'false'
  if (useLlmConfig) {
    return getVisionOcrConnectionState(
      getFollowAiVisionProfileId(),
      readSetting('llm_base_url'),
      readSetting('llm_model'),
      readProtectedSetting('llm_api_key'),
    ).verified
  }
  const profileId = readSetting('vision_ocr_active_provider_id') || readSetting('vision_ocr_provider')
  return getVisionOcrConnectionState(
    profileId,
    readSetting('vision_ocr_base_url'),
    readSetting('vision_ocr_model'),
    readProtectedSetting('vision_ocr_api_key'),
  ).verified
}

export async function testVisionOcrConnection(baseUrl: string, model: string, apiKey: string): Promise<void> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedModel = String(model || '').trim()
  const normalizedKey = String(apiKey || '').trim().replace(/^Bearer\s+/i, '')
  if (!normalizedBaseUrl) throw new Error('API Base URL 不能为空')
  if (!normalizedModel) throw new Error('视觉模型 ID 不能为空')
  if (!normalizedKey) throw new Error('API Key 不能为空')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${normalizedKey}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'This is a connection test. Briefly describe the image.' },
            { type: 'image_url', image_url: { url: TEST_IMAGE_DATA_URL } },
          ],
        }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || detail
      } catch {
        // Keep response preview.
      }
      throw new Error(`连接测试失败（HTTP ${response.status}）：${detail || response.statusText}`)
    }
    let parsed: { choices?: unknown[] }
    try {
      parsed = JSON.parse(text) as { choices?: unknown[] }
    } catch {
      throw new Error('连接测试失败：服务返回的不是有效 JSON')
    }
    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
      throw new Error('连接测试失败：视觉模型没有返回有效结果')
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new Error('连接测试超时（45 秒）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
