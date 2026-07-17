import { ipcMain, dialog, app } from 'electron'
import { basename, extname, join } from 'path'
import { net } from 'electron'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { exportDocument } from '../export'
import { checkLuaTeX, checkLuatexCn, generateTeX, compileTeX } from '../typeset'
import { readFileSync, existsSync } from 'fs'
import { open } from 'fs/promises'
import type {
  AppUpdateAsset,
  AppUpdateInfo,
  AppPathName,
  BackupImportResult,
  BackupResult,
  BackupStatus,
  CompactAutoBackupResult,
  DocumentExportBatchError,
  DocumentExportBatchResult,
  DocumentExportFormat,
  DocumentExportOptions,
  ListModelsPayload,
  LocalPaddleOcrDownloadOptions,
  LocalPaddleOcrSource,
  LocalPaddleOcrStatus,
  LlmProviderProfile,
  LlmProviderProfileState,
  LlmProviderProfilesResult,
  OcrEngine,
  PaddleOcrTokenPoolState,
  Setting,
  SettingSetResult,
  SettingsMap,
  TypesetAnnotationItem,
  TypesetCompileResult,
  TypesetEnvironmentStatus,
  TypesetMetadata,
  TypesetTemplate,
  VisionOcrConnectionTestPayload,
  VisionOcrConnectionTestResult,
} from '../../shared/types'
import {
  backupData,
  compactAutoBackups,
  configureAutoBackup,
  exportDocumentListCsv,
  getBackupStatus,
  importBackupData,
  importBackupFromPath,
  openAutoBackupDirectory,
  openDataDirectory,
  runAutoBackupNow,
} from '../backup'
import { assertAllowedLocalFilePath } from '../file-access'
import { getResponseErrorMessage, isAbortError } from '../../shared/errors'
import {
  validateLlmProfileConfig,
  validateTypesetEnvironmentConfig,
  validateVisionOcrProfileConfig,
} from '../../shared/config-validation'
import {
  ensureDisabledMetadataTagBindingsCleared,
  ensureEnabledMetadataTagBindingsRebuilt,
  METADATA_TAG_BINDING_SETTING_KEY,
  needsMetadataTagBindingRebuild,
  rebuildMetadataTagBindings,
} from '../metadata-tags'
import { isProtectedSettingKey } from '../protected-settings'
import {
  assertVisionOcrProfileVerified,
  clearVisionOcrConnectionVerification,
  getVisionOcrConnectionState,
  markVisionOcrConnectionVerified,
  testVisionOcrConnection,
} from '../vision-ocr-verification'
import {
  consumeCredentialDraft,
  getCredentialPublicState,
  getPublicSettingsMap as getRendererSettingsSnapshot,
  prepareCredentialDraft,
  readProtectedSetting,
  readPublicSetting,
  revokeCredentialDraftOwner,
  revokeProtectedSetting,
  writeProtectedSetting,
  writePublicSetting,
} from '../settings-security'
import { validateSettingValue } from '../../shared/setting-definitions'
import {
  acquirePaddleOcrToken,
  addPaddleOcrToken,
  getPaddleOcrTokenPoolState,
  removePaddleOcrToken,
  setPaddleOcrTokenEnabled,
} from '../paddle-ocr-token-pool'

const PROJECT_GITHUB_REPO = 'DieDust/gujismart-public'
const PROJECT_RELEASES_URL = `https://github.com/${PROJECT_GITHUB_REPO}/releases`
const PROJECT_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${PROJECT_GITHUB_REPO}/releases/latest`
const REMOTE_IMAGE_MAX_BYTES = 15 * 1024 * 1024
const registeredCredentialDraftOwners = new Set<number>()

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  webp: 'image/webp',
}

function assertAllowedRemoteImageUrl(value: string): URL {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'https:') {
    throw new Error('仅支持 HTTPS 图片地址')
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname !== 'pplines-online.bj.bcebos.com' && !hostname.endsWith('.bcebos.com')) {
    throw new Error(`不支持的远程图片域名: ${hostname}`)
  }
  return url
}

function getImageMimeFromPath(pathOrUrl: string, fallback = 'image/jpeg'): string {
  const ext = pathOrUrl.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || ''
  return IMAGE_MIME_BY_EXT[ext] || fallback
}

function getRemoteImageMime(url: URL, contentType: string | null): string {
  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (normalizedContentType.startsWith('image/')) return normalizedContentType
  const mime = getImageMimeFromPath(url.pathname, '')
  if (mime) return mime
  throw new Error(`远程资源不是可识别的图片: ${normalizedContentType || 'unknown'}`)
}

function logMetadataTagCleanup(context: string, cleanup: SettingSetResult['metadataTagCleanup']): void {
  if (!cleanup || (cleanup.removedRelations === 0 && cleanup.keptManualRelations === 0 && cleanup.removedTags === 0)) return
  console.log(
    `[Settings] ${context}: removed=${cleanup.removedRelations}, keptManual=${cleanup.keptManualRelations}, removedTags=${cleanup.removedTags}`,
  )
}

function logMetadataTagRebuild(context: string, rebuild: SettingSetResult['metadataTagRebuild']): void {
  if (!rebuild || (rebuild.processedDocuments === 0 && rebuild.createdOrUpdatedRelations === 0)) return
  console.log(
    `[Settings] ${context}: processed=${rebuild.processedDocuments}, synced=${rebuild.syncedDocuments}, skipped=${rebuild.skippedDocuments}, relations=${rebuild.createdOrUpdatedRelations}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseVersionParts(value: string): [number, number, number] | null {
  const match = String(value || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i)
  if (!match) return null
  return [
    Number.parseInt(match[1] || '0', 10),
    Number.parseInt(match[2] || '0', 10),
    Number.parseInt(match[3] || '0', 10),
  ]
}

function compareAppVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  if (!leftParts || !rightParts) return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true })
  for (let index = 0; index < 3; index += 1) {
    const diff = leftParts[index] - rightParts[index]
    if (diff !== 0) return diff
  }
  return 0
}

function parseReleaseAssets(value: unknown): AppUpdateAsset[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((asset) => ({
      name: getStringField(asset, 'name'),
      url: getStringField(asset, 'browser_download_url'),
      size: getNumberField(asset, 'size'),
      contentType: getStringField(asset, 'content_type') || undefined,
    }))
    .filter((asset) => asset.name && asset.url && /\.exe$/i.test(asset.name))
}

function getPackagedBuildCreatedAt(): number | null {
  if (!app.isPackaged) return null
  const sbomPath = join(process.resourcesPath, 'release-metadata', 'sbom.spdx.json')
  if (!existsSync(sbomPath)) return null
  try {
    const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as { creationInfo?: { created?: string } }
    const createdAt = Date.parse(String(sbom.creationInfo?.created || ''))
    return Number.isFinite(createdAt) ? createdAt : null
  } catch {
    return null
  }
}

function isReleaseNewerThanBuild(publishedAt: string, buildCreatedAt: number | null): boolean {
  if (buildCreatedAt === null) return true
  const releasePublishedAt = Date.parse(String(publishedAt || ''))
  return !Number.isFinite(releasePublishedAt) || releasePublishedAt > buildCreatedAt
}

async function checkLatestAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = app.getVersion()
  const checkedAt = new Date().toISOString()
  const fallback: AppUpdateInfo = {
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    releaseUrl: PROJECT_RELEASES_URL,
    assets: [],
    checkedAt,
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(PROJECT_LATEST_RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `GujiSmart/${currentVersion}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`GitHub Release 查询失败：HTTP ${response.status}`)
    }
    const payload: unknown = await response.json()
    if (!isRecord(payload)) {
      throw new Error('GitHub Release 返回内容无效')
    }
    const latestVersion = getStringField(payload, 'tag_name').replace(/^v/i, '') || currentVersion
    const publishedAt = getStringField(payload, 'published_at')
    return {
      currentVersion,
      latestVersion,
      hasUpdate: compareAppVersions(latestVersion, currentVersion) > 0
        && isReleaseNewerThanBuild(publishedAt, getPackagedBuildCreatedAt()),
      releaseUrl: getStringField(payload, 'html_url') || PROJECT_RELEASES_URL,
      releaseName: getStringField(payload, 'name') || undefined,
      publishedAt: publishedAt || undefined,
      body: getStringField(payload, 'body') || undefined,
      assets: parseReleaseAssets(payload.assets),
      checkedAt,
    }
  } catch (error) {
    return {
      ...fallback,
      error: getResponseErrorMessage(error, '检查更新失败'),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function sanitizeFileBaseName(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutExt = basename(raw, extname(raw)).trim()
  return withoutExt
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 160)
}

function getExportDefaultName(docId: string, extension: string): string {
  const doc = queryOne<{ title?: string | null; file_path?: string | null; metadata?: string | null }>(
    'SELECT title, file_path, metadata FROM documents WHERE id = ?',
    [docId],
  )
  const metadata = parseMetadata(doc?.metadata)
  const candidates = [
    metadata.original_file_name,
    metadata.source_file_name,
    doc?.file_path ? basename(doc.file_path) : '',
    doc?.title,
  ]
  const baseName = candidates.map(sanitizeFileBaseName).find(Boolean) || 'document'
  return `${baseName}.${extension}`
}

const DOCUMENT_EXPORT_EXTENSIONS: Record<string, string> = {
  markdown: 'md',
  'tei-xml': 'xml',
  'page-xml': 'xml',
  'paddle-json': 'json',
  txt: 'txt',
  'reading-pdf': 'pdf',
  'layout-pdf': 'pdf',
  'layout-searchable-pdf': 'pdf',
}

const LLM_PROFILE_SETTINGS_KEY = 'llm_provider_profiles'
const VISION_OCR_PROFILE_SETTINGS_KEY = 'vision_ocr_provider_profiles'
const PADDLE_OCR_MODEL_DOCS_URL = 'https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/serving/paddleocr_official_api/typescript.html'

function isPaddleOcrDocParsingModel(model: unknown): boolean {
  const value = String(model || '').trim()
  return /^PaddleOCR-VL(?:-|$)/i.test(value) || /^PP-Structure/i.test(value)
}

function normalizePaddleOcrDocParsingModelName(model: unknown): string {
  const value = String(model || '').trim()
  const compact = value.replace(/[.`"'\s]/g, '')
  const vlVersionMatch = compact.match(/^(?:Model)?PaddleOCRVL(\d+)$/)
  if (vlVersionMatch?.[1]) {
    const digits = vlVersionMatch[1]
    return digits.length === 1
      ? `PaddleOCR-VL-${digits}`
      : `PaddleOCR-VL-${digits.slice(0, -1)}.${digits.slice(-1)}`
  }
  const ppStructureMatch = compact.match(/^(?:Model)?PPStructureV(\d+)$/)
  if (ppStructureMatch?.[1]) {
    return `PP-StructureV${ppStructureMatch[1]}`
  }
  const aliases: Record<string, string> = {
    PaddleOCRVL: 'PaddleOCR-VL',
    ModelPaddleOCRVL: 'PaddleOCR-VL',
  }
  return aliases[compact] || value
}

function getPaddleOcrModelSortKey(model: string): { familyRank: number; versionParts: number[]; name: string } {
  const value = String(model || '').trim()
  const paddleMatch = value.match(/^PaddleOCR-VL(?:-(\d+(?:\.\d+)*))?$/i)
  if (paddleMatch) {
    return {
      familyRank: 0,
      versionParts: String(paddleMatch[1] || '0').split('.').map((part) => Number(part) || 0),
      name: value,
    }
  }
  const ppStructureMatch = value.match(/^PP-StructureV(\d+(?:\.\d+)*)$/i)
  if (ppStructureMatch) {
    return {
      familyRank: 1,
      versionParts: String(ppStructureMatch[1] || '0').split('.').map((part) => Number(part) || 0),
      name: value,
    }
  }
  return {
    familyRank: 2,
    versionParts: [0],
    name: value,
  }
}

function comparePaddleOcrModelsNewestFirst(left: string, right: string): number {
  const leftKey = getPaddleOcrModelSortKey(left)
  const rightKey = getPaddleOcrModelSortKey(right)
  if (leftKey.familyRank !== rightKey.familyRank) return leftKey.familyRank - rightKey.familyRank
  const length = Math.max(leftKey.versionParts.length, rightKey.versionParts.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (rightKey.versionParts[index] || 0) - (leftKey.versionParts[index] || 0)
    if (delta !== 0) return delta
  }
  return leftKey.name.localeCompare(rightKey.name)
}

interface OpenAiModelItem {
  id?: string
  object?: string
  owned_by?: string
  permission?: unknown
}

function getSettingValue(key: string): string {
  return isProtectedSettingKey(key) ? readProtectedSetting(key) : readPublicSetting(key)
}

function setSettingValue(key: string, value: string): void {
  if (isProtectedSettingKey(key)) {
    writeProtectedSetting(key, value)
    return
  }
  writePublicSetting(key, value)
}

function makeLlmProfileId(provider: string, baseUrl: string, model: string): string {
  const safeProvider = String(provider || 'AI').trim() || 'AI'
  const safeModel = String(model || 'model').trim() || 'model'
  const base = `${safeProvider}_${safeModel}`
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'ai_model'
  const signature = `${safeProvider}|${String(baseUrl || '').trim().replace(/\/+$/, '')}|${safeModel}`.toLowerCase()
  let hash = 0
  for (let index = 0; index < signature.length; index += 1) {
    hash = ((hash << 5) - hash + signature.charCodeAt(index)) | 0
  }
  return `${base}_${Math.abs(hash).toString(36)}`
}

function makeVisionOcrProfileId(provider: string, baseUrl: string, model: string): string {
  return makeLlmProfileId(`vision_${provider || 'OCR'}`, baseUrl, model)
}

async function fetchOpenAiCompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '')
  const token = String(apiKey || '').trim().replace(/^Bearer\s+/i, '')
  if (!normalizedBaseUrl) throw new Error('API Base URL 不能为空')
  if (!token) throw new Error('API Key 不能为空')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch(`${normalizedBaseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
    const text = await response.text()
    let data: Record<string, unknown> = {}
    try {
      const parsed: unknown = text ? JSON.parse(text) : {}
      data = isRecord(parsed) ? parsed : {}
    } catch {
      data = { error: { message: text || response.statusText } }
    }
    if (!response.ok || data.error) {
      throw new Error(getResponseErrorMessage(data, response.statusText || '模型列表请求失败'))
    }
    const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
    const modelIds: string[] = items
      .map((item: OpenAiModelItem | string) => typeof item === 'string' ? item : isRecord(item) ? item.id : '')
      .map((id: unknown) => String(id || '').trim())
      .filter((id: string) => id.length > 0)
    return [...new Set<string>(modelIds)]
      .sort((left, right) => left.localeCompare(right))
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new Error('模型列表请求超时，请检查 Base URL、Key 或网络')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchPaddleOcrModels(_apiKey: string): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(PADDLE_OCR_MODEL_DOCS_URL, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`官方模型文档请求失败，状态码 ${response.status}`)
    }
    const text = await response.text()
    const candidates = [
      ...text.matchAll(/PaddleOCR-VL(?:-\d+(?:\.\d+)*)?/gi),
      ...text.matchAll(/PP-StructureV\d+/gi),
      ...text.matchAll(/ModelPaddleOCRVL\d*/g),
      ...text.matchAll(/PaddleOCRVL\d*/g),
      ...text.matchAll(/ModelPPStructureV\d+/g),
      ...text.matchAll(/PPStructureV\d+/g),
    ]
      .map((match) => normalizePaddleOcrDocParsingModelName(match[0]))
      .filter(isPaddleOcrDocParsingModel)
    const models = [...new Set(candidates)].sort(comparePaddleOcrModelsNewestFirst)
    if (models.length === 0) {
      throw new Error('官方模型文档中没有解析到可用于文档解析的模型')
    }
    return models
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new Error('飞桨 OCR 官方模型列表请求超时，请检查网络')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function parseLlmProviderProfiles(value: unknown, kind: 'llm' | 'vision_ocr'): LlmProviderProfile[] {
  if (!value || typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => ({
        id: String(item?.id || item?.name || '').trim(),
        name: String(item?.name || item?.provider || '').trim(),
        provider: String(item?.provider || item?.name || '').trim(),
        baseUrl: String(item?.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(item?.model || '').trim(),
        updatedAt: item?.updatedAt ? String(item.updatedAt) : undefined,
        credential: getCredentialPublicState(`${kind}_profile:${String(item?.id || item?.name || '').trim()}`),
      }))
      .filter((item) => item.id && item.name && item.baseUrl && item.model)
  } catch {
    return []
  }
}

function getLlmProviderProfiles(): LlmProviderProfile[] {
  const stored = parseLlmProviderProfiles(getSettingValue(LLM_PROFILE_SETTINGS_KEY), 'llm')
  const current = getCurrentLlmProfile()
  if (!current.baseUrl || !current.model) return stored
  const byId = stored.find((item) => item.id === current.id)
  if (byId) {
    return stored.map((item) => item.id === current.id ? { ...item, ...current, updatedAt: item.updatedAt } : item)
  }
  return [current, ...stored]
}

function getCurrentVisionOcrProfile(): LlmProviderProfile {
  const provider = getSettingValue('vision_ocr_provider') || '豆包'
  const baseUrl = (getSettingValue('vision_ocr_base_url') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
  const model = getSettingValue('vision_ocr_model') || ''
  const id = getSettingValue('vision_ocr_active_provider_id') || makeVisionOcrProfileId(provider, baseUrl, model)
  const apiKey = readProtectedSetting('vision_ocr_api_key')
  return {
    id,
    name: provider,
    provider,
    baseUrl,
    model,
    updatedAt: new Date().toISOString(),
    credential: getCredentialPublicState('vision_ocr_api_key'),
    connectionTest: getVisionOcrConnectionState(id, baseUrl, model, apiKey),
  }
}

function getVisionOcrProviderProfiles(): LlmProviderProfile[] {
  const stored = parseLlmProviderProfiles(getSettingValue(VISION_OCR_PROFILE_SETTINGS_KEY), 'vision_ocr')
  const current = getCurrentVisionOcrProfile()
  const withConnectionState = (profile: LlmProviderProfile): LlmProviderProfile => ({
    ...profile,
    connectionTest: getVisionOcrConnectionState(
      profile.id,
      profile.baseUrl,
      profile.model,
      readProtectedSetting(`vision_ocr_profile:${profile.id}`) || (profile.id === current.id ? readProtectedSetting('vision_ocr_api_key') : ''),
    ),
  })
  if (!current.baseUrl || !current.model) return stored.map(withConnectionState)
  const byId = stored.find((item) => item.id === current.id)
  if (byId) {
    return stored.map((item) => withConnectionState(item.id === current.id ? { ...item, ...current, updatedAt: item.updatedAt } : item))
  }
  return [current, ...stored.map(withConnectionState)]
}

function saveVisionOcrProviderProfiles(profiles: LlmProviderProfile[]): void {
  const normalized = profiles
    .map((item) => {
      const id = String(item.id || item.name || '').trim()
      const apiKey = String(item.apiKey || '')
      if (id && apiKey) writeProtectedSetting(`vision_ocr_profile:${id}`, apiKey)
      return {
        id,
        name: String(item.name || item.provider || '').trim(),
        provider: String(item.provider || item.name || '').trim(),
        baseUrl: String(item.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(item.model || '').trim(),
        updatedAt: item.updatedAt || new Date().toISOString(),
      }
    })
    .filter((item) => item.id && item.name && item.baseUrl && item.model)
  setSettingValue(VISION_OCR_PROFILE_SETTINGS_KEY, JSON.stringify(normalized))
}

function saveLlmProviderProfiles(profiles: LlmProviderProfile[]): void {
  const normalized = profiles
    .map((item) => {
      const id = String(item.id || item.name || '').trim()
      const apiKey = String(item.apiKey || '')
      if (id && apiKey) writeProtectedSetting(`llm_profile:${id}`, apiKey)
      return {
        id,
        name: String(item.name || item.provider || '').trim(),
        provider: String(item.provider || item.name || '').trim(),
        baseUrl: String(item.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(item.model || '').trim(),
        updatedAt: item.updatedAt || new Date().toISOString(),
      }
    })
    .filter((item) => item.id && item.name && item.baseUrl && item.model)
  setSettingValue(LLM_PROFILE_SETTINGS_KEY, JSON.stringify(normalized))
}

function getCurrentLlmProfile(): LlmProviderProfile {
  const provider = getSettingValue('llm_provider') || 'DeepSeek'
  const baseUrl = (getSettingValue('llm_base_url') || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = getSettingValue('llm_model') || 'deepseek-chat'
  return {
    id: getSettingValue('llm_active_provider_id') || makeLlmProfileId(provider, baseUrl, model),
    name: provider,
    provider,
    baseUrl,
    model,
    updatedAt: new Date().toISOString(),
    credential: getCredentialPublicState('llm_api_key'),
  }
}

function getExportExtension(format: DocumentExportFormat): string {
  return DOCUMENT_EXPORT_EXTENSIONS[format] || format
}

function getLlmProfileValidation(profile: LlmProviderProfile) {
  return validateLlmProfileConfig({
    provider: profile.provider || profile.name,
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey || (profile.credential?.configured ? 'configured' : ''),
    model: profile.model,
  })
}

function getVisionOcrProfileValidation(profile: LlmProviderProfile) {
  return validateVisionOcrProfileConfig({
    provider: profile.provider || profile.name,
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey || (profile.credential?.configured ? 'configured' : ''),
    model: profile.model,
  })
}

function ensureUniqueExportPath(dirPath: string, fileName: string, usedPaths: Set<string>): string {
  const ext = extname(fileName)
  const base = ext ? fileName.slice(0, -ext.length) : fileName
  let candidate = join(dirPath, fileName)
  let index = 2
  while (usedPaths.has(candidate.toLowerCase()) || existsSync(candidate)) {
    candidate = join(dirPath, `${base}-${index}${ext}`)
    index += 1
  }
  usedPaths.add(candidate.toLowerCase())
  return candidate
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:credential:prepare', async (event, key: string, value: string) => {
    const ownerId = event.sender.id
    if (!registeredCredentialDraftOwners.has(ownerId)) {
      registeredCredentialDraftOwners.add(ownerId)
      event.sender.once('destroyed', () => {
        registeredCredentialDraftOwners.delete(ownerId)
        revokeCredentialDraftOwner(ownerId)
      })
    }
    return prepareCredentialDraft(ownerId, key, value)
  })

  ipcMain.handle('settings:credential:commit', async (event, key: string, draftRef: string) => {
    const value = consumeCredentialDraft(event.sender.id, key, draftRef)
    return writeProtectedSetting(key, value)
  })

  ipcMain.handle('settings:credential:revoke', async (_event, key: string) => {
    if (!isProtectedSettingKey(key)) throw new Error('credential_purpose_invalid')
    return revokeProtectedSetting(key)
  })

  ipcMain.handle('settings:get', async (_event, key: string): Promise<string | null> => {
    if (isProtectedSettingKey(key)) return null
    const value = readPublicSetting(key)
    return value || null
  })

  ipcMain.handle('settings:set', async (_event, key: string, value: string): Promise<SettingSetResult> => {
    if (isProtectedSettingKey(key)) throw new Error('protected_setting_requires_credential_api')
    const validated = validateSettingValue(key, value)
    const previousValue = validated.key === METADATA_TAG_BINDING_SETTING_KEY ? getSettingValue(validated.key) : ''
    setSettingValue(validated.key, validated.value)
    let metadataTagCleanup: SettingSetResult['metadataTagCleanup'] = null
    let metadataTagRebuild: SettingSetResult['metadataTagRebuild'] = null
    if (validated.key === METADATA_TAG_BINDING_SETTING_KEY) {
      const normalizedValue = validated.value.trim().toLowerCase()
      const wasEnabled = String(previousValue).trim().toLowerCase() === 'true'
      if (normalizedValue === 'false') {
        metadataTagCleanup = ensureDisabledMetadataTagBindingsCleared()
        logMetadataTagCleanup('Cleared metadata tag bindings', metadataTagCleanup)
      } else if (normalizedValue === 'true' && (!wasEnabled || needsMetadataTagBindingRebuild())) {
        metadataTagRebuild = await rebuildMetadataTagBindings()
        logMetadataTagRebuild('Rebuilt metadata tag bindings', metadataTagRebuild)
      }
    }
    saveDatabase()
    return { success: true, metadataTagCleanup, metadataTagRebuild }
  })

  ipcMain.handle('settings:getAll', async (): Promise<SettingsMap> => {
    return getRendererSettingsSnapshot()
  })

  ipcMain.handle('settings:listModels', async (_event, payload?: ListModelsPayload): Promise<string[]> => {
    const credentialKey = payload?.credentialKey === 'vision_ocr_api_key' ? 'vision_ocr_api_key' : 'llm_api_key'
    const draftSecret = payload?.credentialDraftRef
      ? consumeCredentialDraft(_event.sender.id, credentialKey, payload.credentialDraftRef)
      : ''
    return fetchOpenAiCompatibleModels(
      String(payload?.baseUrl || getSettingValue('llm_base_url') || ''),
      String(draftSecret || readProtectedSetting(credentialKey) || ''),
    )
  })

  ipcMain.handle('settings:listPaddleOcrModels', async (event, credentialDraftRef?: string): Promise<string[]> => {
    const draftSecret = credentialDraftRef
      ? consumeCredentialDraft(event.sender.id, 'paddleocr_api_key', credentialDraftRef)
      : ''
    const savedToken = draftSecret || (() => {
      try {
        return acquirePaddleOcrToken().token
      } catch {
        return readProtectedSetting('paddleocr_api_key') || ''
      }
    })()
    return fetchPaddleOcrModels(String(savedToken))
  })

  ipcMain.handle('settings:paddleOcrTokens:list', async (): Promise<PaddleOcrTokenPoolState> => {
    return getPaddleOcrTokenPoolState()
  })

  ipcMain.handle('settings:paddleOcrTokens:add', async (event, label: string, credentialDraftRef: string): Promise<PaddleOcrTokenPoolState> => {
    const token = consumeCredentialDraft(event.sender.id, 'paddleocr_api_key', credentialDraftRef)
    const state = addPaddleOcrToken(label, token)
    saveDatabase()
    return state
  })

  ipcMain.handle('settings:paddleOcrTokens:remove', async (_event, id: string): Promise<PaddleOcrTokenPoolState> => {
    const state = removePaddleOcrToken(String(id || ''))
    saveDatabase()
    return state
  })

  ipcMain.handle('settings:paddleOcrTokens:setEnabled', async (_event, id: string, enabled: boolean): Promise<PaddleOcrTokenPoolState> => {
    const state = setPaddleOcrTokenEnabled(String(id || ''), Boolean(enabled))
    saveDatabase()
    return state
  })

  ipcMain.handle('settings:getLocalPaddleOcrStatus', async (): Promise<LocalPaddleOcrStatus> => {
    return {
      installed: false,
      modelInstalled: false,
      state: 'not_installed',
      bundleVersion: '',
      installPath: '',
      runtime: {
        state: 'error',
        supported: false,
        runtimePath: '',
        requiredPaddleVersion: '',
        requiredPaddleOcrVersion: '',
        requiredPaddlexVersion: '',
        message: '本地 OCR 功能当前已停用',
      },
      message: '本地 OCR 功能当前已停用',
      sources: [],
    }
  })

  ipcMain.handle('settings:checkLocalPaddleOcrSources', async (): Promise<LocalPaddleOcrSource[]> => {
    return []
  })

  ipcMain.handle('settings:downloadLocalPaddleOcr', async (
    event,
    options?: LocalPaddleOcrDownloadOptions,
  ): Promise<LocalPaddleOcrStatus> => {
    void event
    void options
    throw new Error('本地 OCR 功能当前已停用')
  })

  ipcMain.handle('settings:installLocalPaddleOcrRuntime', async (
    event,
  ): Promise<LocalPaddleOcrStatus> => {
    void event
    throw new Error('本地 OCR 功能当前已停用')
  })

  ipcMain.handle('settings:importLocalPaddleOcrAddon', async (
    event,
    filePath?: string,
  ): Promise<LocalPaddleOcrStatus> => {
    void event
    void filePath
    throw new Error('本地 OCR 功能当前已停用')
  })

  ipcMain.handle('settings:setDefaultOcrEngine', async (
    _event,
    engine: OcrEngine,
    providerId?: string,
  ): Promise<SettingsMap> => {
    if (!['local_paddle', 'paddle', 'vision_model', 'hybrid'].includes(engine)) {
      throw new Error('不支持的 OCR 引擎')
    }
    const normalizedEngine: OcrEngine = engine === 'local_paddle' || engine === 'hybrid' ? 'paddle' : engine
    const normalizedProviderId = providerId === 'local_paddle' || providerId === 'hybrid' ? normalizedEngine : String(providerId || normalizedEngine)
    if (normalizedEngine === 'vision_model') {
      const profile = getVisionOcrProviderProfiles().find((item) => item.id === normalizedProviderId)
      if (!profile) throw new Error('未找到 AI OCR 配置，请先保存并测试连接。')
      const secret = readProtectedSetting(`vision_ocr_profile:${profile.id}`) || readProtectedSetting('vision_ocr_api_key')
      assertVisionOcrProfileVerified(profile.id, profile.baseUrl, profile.model, secret)
    }
    setSettingValue('ocr_default_engine', normalizedEngine)
    setSettingValue('ocr_active_provider_id', normalizedProviderId)
    saveDatabase()
    return getRendererSettingsSnapshot()
  })

  ipcMain.handle('settings:llmProfiles:list', async (): Promise<LlmProviderProfileState> => {
    const current = getCurrentLlmProfile()
    return {
      activeId: current.id,
      current,
      profiles: getLlmProviderProfiles(),
      configValidation: getLlmProfileValidation(current),
    }
  })

  ipcMain.handle('settings:llmProfiles:saveCurrent', async (_event, name?: string): Promise<LlmProviderProfileState> => {
    const current = getCurrentLlmProfile()
    const profileName = String(name || current.name || current.provider || 'AI 服务商').trim()
    const idBase = profileName || current.id
    const profile: LlmProviderProfile = {
      ...current,
      id: makeLlmProfileId(idBase, current.baseUrl, current.model),
      name: profileName,
      provider: profileName,
      updatedAt: new Date().toISOString(),
    }
    const profiles = getLlmProviderProfiles().filter((item) => item.id !== profile.id)
    const currentSecret = readProtectedSetting('llm_api_key')
    if (currentSecret) writeProtectedSetting(`llm_profile:${profile.id}`, currentSecret)
    saveLlmProviderProfiles([profile, ...profiles])
    setSettingValue('llm_active_provider_id', profile.id)
    setSettingValue('llm_provider', profile.provider)
    saveDatabase()
    return {
      activeId: profile.id,
      current: profile,
      profiles: getLlmProviderProfiles(),
      configValidation: getLlmProfileValidation(profile),
    }
  })

  ipcMain.handle('settings:llmProfiles:upsert', async (event, profile: LlmProviderProfile, credentialDraftRef?: string): Promise<LlmProviderProfilesResult> => {
    if (profile && 'apiKey' in profile) throw new Error('profile_secret_requires_credential_draft')
    const provider = String(profile?.provider || profile?.name || '').trim()
    const baseUrl = String(profile?.baseUrl || '').trim().replace(/\/+$/, '')
    const model = String(profile?.model || '').trim()
    const next: LlmProviderProfile = {
      id: String(profile?.id || '').trim() || makeLlmProfileId(provider, baseUrl, model),
      name: String(profile?.name || profile?.provider || '').trim(),
      provider,
      baseUrl,
      model,
      updatedAt: new Date().toISOString(),
    }
    const configValidation = getLlmProfileValidation(next)
    if (!next.id || configValidation.error_count > 0) {
      throw new Error('AI 服务商配置不完整')
    }
    if (credentialDraftRef) {
      writeProtectedSetting(`llm_profile:${next.id}`, consumeCredentialDraft(event.sender.id, 'llm_api_key', credentialDraftRef))
      next.credential = getCredentialPublicState(`llm_profile:${next.id}`)
    }
    const profiles = getLlmProviderProfiles().filter((item) => item.id !== next.id)
    saveLlmProviderProfiles([next, ...profiles])
    saveDatabase()
    return {
      activeId: getSettingValue('llm_active_provider_id') || getSettingValue('llm_provider') || next.id,
      profiles: getLlmProviderProfiles(),
      configValidation,
    }
  })

  ipcMain.handle('settings:llmProfiles:switch', async (_event, profileId: string): Promise<LlmProviderProfileState> => {
    const id = String(profileId || '').trim()
    const profiles = getLlmProviderProfiles()
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new Error('未找到 AI 服务商配置')
    setSettingValue('llm_active_provider_id', profile.id)
    setSettingValue('llm_provider', profile.provider || profile.name)
    setSettingValue('llm_base_url', profile.baseUrl)
    const profileSecret = readProtectedSetting(`llm_profile:${profile.id}`)
    if (profileSecret) writeProtectedSetting('llm_api_key', profileSecret)
    else revokeProtectedSetting('llm_api_key')
    setSettingValue('llm_model', profile.model)
    saveDatabase()
    const current = getCurrentLlmProfile()
    return { activeId: profile.id, current, profiles: getLlmProviderProfiles(), configValidation: getLlmProfileValidation(current) }
  })

  ipcMain.handle('settings:llmProfiles:delete', async (_event, profileId: string): Promise<LlmProviderProfilesResult> => {
    const id = String(profileId || '').trim()
    const activeId = getSettingValue('llm_active_provider_id') || getSettingValue('llm_provider')
    if (id && id === activeId) throw new Error('不能删除当前正在使用的 AI 服务商')
    if (id) revokeProtectedSetting(`llm_profile:${id}`)
    saveLlmProviderProfiles(getLlmProviderProfiles().filter((item) => item.id !== id))
    saveDatabase()
    return { activeId, profiles: getLlmProviderProfiles(), configValidation: getLlmProfileValidation(getCurrentLlmProfile()) }
  })

  ipcMain.handle('settings:visionOcrProfiles:list', async (): Promise<LlmProviderProfileState> => {
    const current = getCurrentVisionOcrProfile()
    return {
      activeId: current.id,
      current,
      profiles: getVisionOcrProviderProfiles(),
      configValidation: getVisionOcrProfileValidation(current),
    }
  })

  ipcMain.handle('settings:visionOcrProfiles:testConnection', async (
    event,
    payload: VisionOcrConnectionTestPayload,
    credentialDraftRef?: string,
  ): Promise<VisionOcrConnectionTestResult> => {
    const useLlmConfig = payload?.useLlmConfig === true
    const credentialKey = useLlmConfig ? 'llm_api_key' : 'vision_ocr_api_key'
    const draftSecret = credentialDraftRef
      ? consumeCredentialDraft(event.sender.id, credentialKey, credentialDraftRef)
      : ''
    const provider = String(payload?.provider || payload?.name || '').trim()
    const baseUrl = String(payload?.baseUrl || (useLlmConfig ? getSettingValue('llm_base_url') : '')).trim()
    const model = String(payload?.model || (useLlmConfig ? getSettingValue('llm_model') : '')).trim()
    const requestedId = String(payload?.id || '').trim()
    const profileId = useLlmConfig
      ? `vision_follow_ai:${makeLlmProfileId(provider, baseUrl, model)}`
      : requestedId && requestedId !== 'vision_draft'
        ? requestedId
        : makeVisionOcrProfileId(provider, baseUrl, model)
    const savedSecret = useLlmConfig
      ? readProtectedSetting('llm_api_key')
      : readProtectedSetting(`vision_ocr_profile:${profileId}`)
        || (profileId === getSettingValue('vision_ocr_active_provider_id') ? readProtectedSetting('vision_ocr_api_key') : '')
    const apiKey = String(draftSecret || savedSecret || '')
    await testVisionOcrConnection(baseUrl, model, apiKey)
    const connectionTest = markVisionOcrConnectionVerified(profileId, baseUrl, model, apiKey)
    return {
      ...connectionTest,
      profileId,
      message: '连接测试成功，当前配置已允许保存和使用。',
    }
  })

  ipcMain.handle('settings:visionOcrProfiles:upsert', async (event, profile: LlmProviderProfile, credentialDraftRef?: string): Promise<LlmProviderProfilesResult> => {
    if (profile && 'apiKey' in profile) throw new Error('profile_secret_requires_credential_draft')
    const provider = String(profile?.provider || profile?.name || '').trim()
    const baseUrl = String(profile?.baseUrl || '').trim().replace(/\/+$/, '')
    const model = String(profile?.model || '').trim()
    const next: LlmProviderProfile = {
      id: String(profile?.id || '').trim() || makeVisionOcrProfileId(provider, baseUrl, model),
      name: String(profile?.name || profile?.provider || '').trim(),
      provider,
      baseUrl,
      model,
      updatedAt: new Date().toISOString(),
    }
    const configValidation = getVisionOcrProfileValidation(next)
    if (!next.id || configValidation.error_count > 0) {
      throw new Error('视觉 OCR 服务商配置不完整')
    }
    const submittedSecret = credentialDraftRef
      ? consumeCredentialDraft(event.sender.id, 'vision_ocr_api_key', credentialDraftRef)
      : readProtectedSetting(`vision_ocr_profile:${next.id}`)
        || (next.id === getSettingValue('vision_ocr_active_provider_id') ? readProtectedSetting('vision_ocr_api_key') : '')
    assertVisionOcrProfileVerified(next.id, next.baseUrl, next.model, submittedSecret)
    if (credentialDraftRef) {
      writeProtectedSetting(`vision_ocr_profile:${next.id}`, submittedSecret)
      next.credential = getCredentialPublicState(`vision_ocr_profile:${next.id}`)
    }
    const profiles = getVisionOcrProviderProfiles().filter((item) => item.id !== next.id)
    saveVisionOcrProviderProfiles([next, ...profiles])
    saveDatabase()
    return {
      activeId: getSettingValue('vision_ocr_active_provider_id') || next.id,
      profiles: getVisionOcrProviderProfiles(),
      configValidation,
    }
  })

  ipcMain.handle('settings:visionOcrProfiles:switch', async (_event, profileId: string): Promise<LlmProviderProfileState> => {
    const id = String(profileId || '').trim()
    const profiles = getVisionOcrProviderProfiles()
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new Error('未找到视觉 OCR 服务商配置')
    const profileSecret = readProtectedSetting(`vision_ocr_profile:${profile.id}`) || readProtectedSetting('vision_ocr_api_key')
    assertVisionOcrProfileVerified(profile.id, profile.baseUrl, profile.model, profileSecret)
    setSettingValue('vision_ocr_active_provider_id', profile.id)
    setSettingValue('vision_ocr_provider', profile.provider || profile.name)
    setSettingValue('vision_ocr_use_llm_config', 'false')
    setSettingValue('vision_ocr_base_url', profile.baseUrl)
    if (profileSecret) writeProtectedSetting('vision_ocr_api_key', profileSecret)
    else revokeProtectedSetting('vision_ocr_api_key')
    setSettingValue('vision_ocr_model', profile.model)
    saveDatabase()
    const current = getCurrentVisionOcrProfile()
    return { activeId: profile.id, current, profiles: getVisionOcrProviderProfiles(), configValidation: getVisionOcrProfileValidation(current) }
  })

  ipcMain.handle('settings:visionOcrProfiles:delete', async (_event, profileId: string): Promise<LlmProviderProfilesResult> => {
    const id = String(profileId || '').trim()
    const activeId = getSettingValue('vision_ocr_active_provider_id') || getSettingValue('vision_ocr_provider')
    const remainingProfiles = getVisionOcrProviderProfiles().filter((item) => item.id !== id)
    if (id) revokeProtectedSetting(`vision_ocr_profile:${id}`)
    if (id) clearVisionOcrConnectionVerification(id)
    saveVisionOcrProviderProfiles(remainingProfiles)
    let nextActiveId = activeId
    if (id && id === activeId) {
      const fallbackProfile = remainingProfiles.find((profile) => profile.connectionTest?.verified)
      if (fallbackProfile) {
        nextActiveId = fallbackProfile.id
        setSettingValue('vision_ocr_active_provider_id', fallbackProfile.id)
        setSettingValue('vision_ocr_provider', fallbackProfile.provider || fallbackProfile.name)
        setSettingValue('vision_ocr_use_llm_config', 'false')
        setSettingValue('vision_ocr_base_url', fallbackProfile.baseUrl)
        setSettingValue('vision_ocr_model', fallbackProfile.model)
        const fallbackSecret = readProtectedSetting(`vision_ocr_profile:${fallbackProfile.id}`)
        if (fallbackSecret) writeProtectedSetting('vision_ocr_api_key', fallbackSecret)
        else revokeProtectedSetting('vision_ocr_api_key')
      } else {
        nextActiveId = ''
        setSettingValue('vision_ocr_active_provider_id', '')
        setSettingValue('vision_ocr_provider', '')
        setSettingValue('vision_ocr_base_url', '')
        setSettingValue('vision_ocr_model', '')
        revokeProtectedSetting('vision_ocr_api_key')
        setSettingValue('vision_ocr_use_llm_config', 'false')
        if (getSettingValue('ocr_default_engine') === 'vision_model') {
          setSettingValue('ocr_default_engine', 'paddle')
          setSettingValue('ocr_active_provider_id', 'paddle')
        }
      }
    }
    saveDatabase()
    return { activeId: nextActiveId, profiles: getVisionOcrProviderProfiles(), configValidation: getVisionOcrProfileValidation(getCurrentVisionOcrProfile()) }
  })
}

export function registerAppIpc(): void {
  ipcMain.handle('app:getVersion', async (): Promise<string> => {
    return app.getVersion()
  })

  ipcMain.handle('app:checkForUpdates', async (): Promise<AppUpdateInfo> => {
    return checkLatestAppUpdate()
  })

  ipcMain.handle('app:getPath', async (_event, name: AppPathName): Promise<string> => {
    return app.getPath(name)
  })

  ipcMain.handle('app:quit', async (): Promise<boolean> => {
    app.quit()
    return true
  })
}

export function registerExportIpc(): void {
  ipcMain.handle('documents:export', async (
    _event,
    docId: string,
    format: DocumentExportFormat,
    options?: DocumentExportOptions,
  ): Promise<boolean> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出文献',
      defaultPath: getExportDefaultName(docId, getExportExtension(format)),
      filters: [
        { name: format.toUpperCase(), extensions: [getExportExtension(format)] }
      ]
    })

    if (canceled || !filePath) return false

    try {
      await exportDocument(docId, format, filePath, options)
      return true
    } catch (error) {
      console.error('导出失败:', error)
      throw new Error((error as Error).message)
    }
  })

  ipcMain.handle('documents:exportBatch', async (_event, docIds: string[], format: DocumentExportFormat, options?: DocumentExportOptions): Promise<DocumentExportBatchResult> => {
    const uniqueDocIds = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (uniqueDocIds.length === 0) throw new Error('请先选择要导出的文献')

    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: `批量导出 ${uniqueDocIds.length} 篇文献`,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths?.[0]) {
      return { canceled: true, successCount: 0, failedCount: 0, directoryPath: null, errors: [] }
    }

    const directoryPath = filePaths[0]
    const extension = getExportExtension(format)
    const usedPaths = new Set<string>()
    const errors: DocumentExportBatchError[] = []
    let successCount = 0

    for (const docId of uniqueDocIds) {
      try {
        const fileName = getExportDefaultName(docId, extension)
        await exportDocument(docId, format, ensureUniqueExportPath(directoryPath, fileName, usedPaths), options)
        successCount += 1
      } catch (error) {
        console.error(`批量导出失败: ${docId}`, error)
        errors.push({ docId, message: (error as Error)?.message || '导出失败' })
      }
    }

    return {
      canceled: false,
      successCount,
      failedCount: errors.length,
      directoryPath,
      errors,
    }
  })
}

export function registerTypesetIpc(): void {
  ipcMain.handle('typeset:checkEnv', async (): Promise<TypesetEnvironmentStatus> => {
    const [luatex, luatexCn] = await Promise.all([checkLuaTeX(), checkLuatexCn()])
    return {
      luatex,
      luatexCn,
      configValidation: validateTypesetEnvironmentConfig({
        luatexAvailable: luatex.available,
        luatexPath: luatex.path,
        luatexCnInstalled: luatexCn.installed,
      }),
    }
  })

  ipcMain.handle('typeset:generateTeX', async (
    _event,
    annotations: TypesetAnnotationItem[],
    template: TypesetTemplate,
    metadata?: TypesetMetadata,
  ): Promise<string> => {
    return generateTeX(annotations, template, metadata)
  })

  ipcMain.handle('typeset:compile', async (_event, docId: string, texContent: string): Promise<TypesetCompileResult> => {
    return await compileTeX(texContent, docId)
  })

  ipcMain.handle('typeset:readPdf', async (_event, pdfPath: string): Promise<ArrayBuffer | null> => {
    const safePath = assertAllowedLocalFilePath(pdfPath)
    if (!existsSync(safePath)) return null
    const buffer = readFileSync(safePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })
}

export function registerFsIpc(): void {
  ipcMain.handle('fs:isReadableFile', async (_event, filePath: string): Promise<boolean> => {
    try {
      const safePath = assertAllowedLocalFilePath(filePath)
      const handle = await open(safePath, 'r')
      try {
        const fileStat = await handle.stat()
        return fileStat.isFile() && fileStat.size > 0
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:readFileBuffer', async (_event, filePath: string): Promise<ArrayBuffer> => {
    try {
      const safePath = assertAllowedLocalFilePath(filePath)
      const buffer = readFileSync(safePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (error) {
      console.error('读取文件失败:', error)
      throw new Error((error as Error).message)
    }
  })

  ipcMain.handle('fs:readImageAsDataURL', async (_event, filePath: string): Promise<string> => {
    try {
      const safePath = assertAllowedLocalFilePath(filePath)
      if (!existsSync(safePath)) {
        throw new Error(`文件不存在: ${safePath}`)
      }
      const buffer = readFileSync(safePath)
      const mime = getImageMimeFromPath(safePath)
      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (error) {
      console.error('[IPC] 读取图片失败:', error)
      throw new Error((error as Error).message)
    }
  })

  ipcMain.handle('fs:readRemoteImageAsDataURL', async (_event, imageUrl: string): Promise<string> => {
    try {
      const url = assertAllowedRemoteImageUrl(imageUrl)
      const response = await net.fetch(url.toString())
      if (!response.ok) {
        throw new Error(`远程图片读取失败: HTTP ${response.status}`)
      }
      const mime = getRemoteImageMime(url, response.headers.get('content-type'))
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (Number.isFinite(contentLength) && contentLength > REMOTE_IMAGE_MAX_BYTES) {
        throw new Error(`远程图片过大: ${Math.ceil(contentLength / 1024 / 1024)}MB`)
      }
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > REMOTE_IMAGE_MAX_BYTES) {
        throw new Error(`远程图片过大: ${Math.ceil(arrayBuffer.byteLength / 1024 / 1024)}MB`)
      }
      const buffer = Buffer.from(arrayBuffer)
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch (error) {
      console.error('[IPC] 读取远程图片失败:', error)
      throw new Error((error as Error).message)
    }
  })
}

export function registerBackupIpc(): void {
  const scheduleRestart = () => {
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 500)
  }

  const handleImportBackup = async (): Promise<BackupImportResult> => {
    try {
      const result = await importBackupData()
      if (result.success) {
        scheduleRestart()
      }
      return result
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  ipcMain.handle('backup:create', async (): Promise<BackupResult> => {
    try {
      const path = await backupData()
      return { success: !!path, path }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('backup:restore', handleImportBackup)

  ipcMain.handle('backup:import', handleImportBackup)

  ipcMain.handle('backup:importFromPath', async (_event, filePath: string): Promise<BackupImportResult> => {
    try {
      const result = await importBackupFromPath(filePath)
      if (result.success) {
        scheduleRestart()
      }
      return result
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('backup:getStatus', async (): Promise<BackupStatus> => {
    return getBackupStatus()
  })

  ipcMain.handle('backup:configureAuto', async (
    _event,
    enabled: boolean,
    intervalHours: number,
    includeStorage?: boolean,
    slotCount?: number,
  ): Promise<BackupStatus> => {
    return configureAutoBackup(enabled, intervalHours, includeStorage, slotCount)
  })

  ipcMain.handle('backup:compactAuto', async (): Promise<CompactAutoBackupResult> => {
    return compactAutoBackups()
  })

  ipcMain.handle('backup:runAutoNow', async (): Promise<BackupResult> => {
    return runAutoBackupNow()
  })

  ipcMain.handle('backup:openDataDirectory', async (): Promise<boolean> => {
    return openDataDirectory()
  })

  ipcMain.handle('backup:openAutoBackupDirectory', async (): Promise<boolean> => {
    return openAutoBackupDirectory()
  })

  ipcMain.handle('backup:exportDocumentList', async (): Promise<BackupResult> => {
    try {
      const path = await exportDocumentListCsv()
      return { success: !!path, path }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
