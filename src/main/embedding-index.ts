/**
 * Local embedding index for semantic retrieval (software UI + MCP).
 * Uses OpenAI-compatible /v1/embeddings; stores float32 vectors in SQLite.
 * Default: manual enqueue only; optional auto-on-ingest setting.
 *
 * Embedding input is PLAIN LITERATURE TEXT only (same idea as export TXT/MD page body):
 * proofed/OCR full text after import+OCR, already stored on search segments.
 * Never embed: PDF bytes, locator/hash/offset_map, coordinates, code, file paths, or MCP JSON envelopes.
 * segment_id / page_num are only stored as pointers for later get_page_text — not sent to the model.
 */
import { BrowserWindow } from 'electron'
import { queryAll, queryOne, run, saveDatabase, scheduleDatabaseSave, transaction } from './database'
import { markLibraryStateCacheDirty } from './library-state-cache'
import { emitBackgroundTaskStatus } from './background-tasks'
import { getCredentialPublicState, readProtectedSetting, writeProtectedSetting } from './settings-security'
import { resolveFolderAndDescendantIds } from './folder-scope'
import type { EmbeddingProgressEvent, EmbeddingProgressStatus } from '../shared/types'

export const EMBEDDING_AUTO_ON_INGEST_KEY = 'embedding_auto_on_ingest'
export const EMBEDDING_BASE_URL_KEY = 'embedding_base_url'
export const EMBEDDING_MODEL_KEY = 'embedding_model'
export const EMBEDDING_BATCH_SIZE_KEY = 'embedding_batch_size'
export const EMBEDDING_DIMENSIONS_KEY = 'embedding_dimensions'
export const EMBEDDING_USE_LLM_CREDENTIALS_KEY = 'embedding_use_llm_credentials'
/** Link to a saved AI-center LLM provider profile (reuses baseUrl + API key). */
export const EMBEDDING_SOURCE_PROFILE_ID_KEY = 'embedding_source_profile_id'

const TASK_ID = 'embedding-index'
/** 默认通义兼容端（DeepSeek 等对话模型无 embeddings） */
export const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v3'
const LLM_PROFILE_SETTINGS_KEY = 'llm_provider_profiles'
/** Safe default batch for Tongyi text-embedding-v3/v4 (official batch size = 10). */
const DEFAULT_BATCH = 10
const MAX_BATCH = 64
/**
 * Official DashScope / 百炼 text embedding limits (Beijing, compatible-mode).
 * Sources: 阿里云模型列表 — 批次大小 / 可选维度 / 单批次 Token。
 */
interface EmbeddingModelSpec {
  id: string
  /** Max strings per /embeddings request. */
  batchSize: number
  /** Supported output dimensions; empty = fixed / not configurable. */
  dimensions: number[]
  /** Default dimension when API supports dimensions param. */
  defaultDimensions?: number
  /** Approx max chars per input string (token limit is higher; char clamp is safety). */
  maxChars: number
  note?: string
}

const DASHSCOPE_EMBEDDING_SPECS: EmbeddingModelSpec[] = [
  {
    id: 'qwen3.7-text-embedding',
    batchSize: 20,
    dimensions: [2560, 2048, 1536, 1024, 768, 512, 256],
    defaultDimensions: 1024,
    maxChars: 24_000,
    note: '单批次最大约 128k Token，批次 20',
  },
  {
    id: 'text-embedding-v4',
    batchSize: 10,
    dimensions: [2048, 1536, 1024, 768, 512, 256, 128, 64],
    defaultDimensions: 1024,
    maxChars: 8_000,
    note: '官方批次 10，默认维度 1024',
  },
  {
    id: 'text-embedding-v3',
    batchSize: 10,
    dimensions: [1024, 768, 512, 256, 128, 64],
    defaultDimensions: 1024,
    maxChars: 6_000,
    note: '官方批次 10，默认维度 1024',
  },
  {
    id: 'text-embedding-v2',
    batchSize: 25,
    dimensions: [1536],
    defaultDimensions: 1536,
    maxChars: 2_000,
    note: '官方批次 25，固定 1536 维',
  },
  {
    id: 'text-embedding-v1',
    batchSize: 25,
    dimensions: [1536],
    defaultDimensions: 1536,
    maxChars: 2_000,
    note: '官方批次 25，固定 1536 维',
  },
]

/** Fallback provider caps when model is custom / unknown. */
const PROVIDER_BATCH_CAPS: Array<{ match: RegExp; max: number }> = [
  { match: /dashscope\.aliyuncs\.com|aliyun|maas\.aliyuncs/i, max: 10 },
  { match: /bigmodel\.cn/i, max: 16 },
  { match: /siliconflow\.cn/i, max: 32 },
]
const MAX_SEARCH_LIMIT = 50
const DEFAULT_MAX_EMBED_CHARS = 6000
const SCAN_CHUNK_ROWS = 400
/** How many segment rows to load from SQLite at a time (avoid OOM on huge OCR books). */
const SEGMENT_LOAD_WINDOW = 120
/** Yield to the event loop between API batches so the UI stays responsive. */
const BATCH_YIELD_MS = 30
/** Pause briefly between documents to reduce main-process pressure. */
const DOC_YIELD_MS = 50
/** Abort hung embeddings HTTP calls (ms). */
const EMBEDDINGS_FETCH_TIMEOUT_MS = 90_000

export type EmbeddingDocStatus = 'pending' | 'queued' | 'processing' | 'ready' | 'error' | 'skipped'

export interface EmbeddingLinkedProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  chatModel: string
  apiKeyConfigured: boolean
  apiKeyLast4?: string
  keySource: 'profile' | 'active-global' | 'none'
}

export interface EmbeddingIndexStats {
  modelId: string
  dim: number | null
  autoOnIngest: boolean
  useLlmCredentials: boolean
  /** When set, baseUrl + API key come from this AI-center profile. */
  sourceProfileId: string
  sourceProfileName: string
  baseUrl: string
  model: string
  batchSize: number
  batchSizeCap: number
  batchSizeRequested: number
  batchSizeAutoAdjusted: boolean
  batchSizeHint?: string
  /** Requested output dimensions (0 = use model/API default). */
  dimensions: number
  /** Allowed dimensions for the current model (empty = not configurable). */
  dimensionsOptions: number[]
  dimensionsDefault: number | null
  modelSpecNote?: string
  apiKeyConfigured: boolean
  docsReady: number
  docsQueued: number
  docsProcessing: number
  docsError: number
  docsPending: number
  docsStale: number
  chunks: number
  queuePaused: boolean
  message?: string
  /** Saved AI providers available for sharing credentials. */
  linkedProfiles: EmbeddingLinkedProfile[]
}

export interface VectorSearchHit {
  documentId: string
  title: string | null
  author: string | null
  pageNum: number | null
  excerpt: string
  score: number
  ref: { docId: string; pageNum: number | null; segmentId: string }
}

export interface VectorSearchResult {
  ok: true
  query: string
  modelId: string
  totalHits: number
  hits: VectorSearchHit[]
  hint?: string
}

export interface VectorSearchError {
  ok: false
  code: string
  message: string
}

let queueRunning = false
let queuePaused = false
let queueTimer: ReturnType<typeof setTimeout> | null = null
/** Counts for the latest manual/auto enqueue burst — drives 处理队列 + toast progress. */
let sessionTotal = 0
let sessionCompleted = 0
let sessionFailed = 0

function nowIso(): string {
  return new Date().toISOString()
}

function countEmbeddingStatus(status: string): number {
  return Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embedding_index_status WHERE status = ?', [status])?.c || 0,
  )
}

function getQueueSnapshot(): Pick<
  EmbeddingProgressEvent,
  'queueQueued' | 'queueProcessing' | 'queueReady' | 'queueError' | 'sessionTotal' | 'sessionCompleted' | 'sessionFailed' | 'queuePaused'
> {
  return {
    queueQueued: countEmbeddingStatus('queued'),
    queueProcessing: countEmbeddingStatus('processing'),
    queueReady: countEmbeddingStatus('ready'),
    queueError: countEmbeddingStatus('error'),
    sessionTotal,
    sessionCompleted,
    sessionFailed,
    queuePaused,
  }
}

function sendEmbeddingProgress(partial: {
  docId?: string
  status: EmbeddingProgressStatus
  progress?: number
  message?: string
  embeddedCount?: number
  segmentCount?: number
  errorMessage?: string
}): void {
  const payload: EmbeddingProgressEvent = {
    docId: partial.docId,
    status: partial.status,
    progress: Math.max(0, Math.min(100, Math.round(Number(partial.progress) || 0))),
    message: partial.message,
    embeddedCount: partial.embeddedCount,
    segmentCount: partial.segmentCount,
    errorMessage: partial.errorMessage,
    ...getQueueSnapshot(),
    updatedAt: nowIso(),
  }
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('embedding:progress', payload)
    }
  }
}

function emitQueueBackgroundProgress(status: 'queued' | 'processing' | 'completed' | 'error', message?: string, docId?: string): void {
  const snap = getQueueSnapshot()
  const active = snap.queueQueued + snap.queueProcessing
  const sessionDone = snap.sessionCompleted + snap.sessionFailed
  const sessionDenom = Math.max(1, snap.sessionTotal || active + sessionDone)
  const progress = status === 'completed'
    ? 100
    : Math.round((sessionDone / sessionDenom) * 100)
  emitProgress({
    status,
    docId,
    message: message || (
      status === 'queued'
        ? `已入队向量化 ${snap.sessionTotal || active} 篇`
        : status === 'processing'
          ? `向量化中 ${sessionDone}/${sessionDenom} 篇`
          : status === 'completed'
            ? `向量化完成：成功 ${snap.sessionCompleted} 篇${snap.sessionFailed > 0 ? `，失败 ${snap.sessionFailed} 篇` : ''}`
            : message
    ),
    totalCount: snap.sessionTotal || active + sessionDone,
    completedCount: sessionDone,
    progress,
  })
}

function getSetting(key: string, fallback = ''): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value || fallback).trim()
}

function setSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
}

function getMeta(key: string): string {
  return String(queryOne<{ value?: string | null }>('SELECT value FROM embedding_index_meta WHERE key = ?', [key])?.value || '').trim()
}

function setMeta(key: string, value: string): void {
  run('INSERT OR REPLACE INTO embedding_index_meta (key, value) VALUES (?, ?)', [key, value])
}

export function isEmbeddingAutoOnIngest(): boolean {
  return getSetting(EMBEDDING_AUTO_ON_INGEST_KEY, 'false') === 'true'
}

export function setEmbeddingAutoOnIngest(enabled: boolean): void {
  setSetting(EMBEDDING_AUTO_ON_INGEST_KEY, enabled ? 'true' : 'false')
  saveDatabase()
}

function resolveEmbeddingModelSpec(model?: string): EmbeddingModelSpec | null {
  const id = String(model || getEmbeddingModel() || '').trim()
  if (!id) return null
  const exact = DASHSCOPE_EMBEDDING_SPECS.find((item) => item.id === id)
  if (exact) return exact
  // Partial match for versioned / namespaced ids.
  return DASHSCOPE_EMBEDDING_SPECS.find((item) => id.includes(item.id)) || null
}

function getProviderBatchCap(baseUrl?: string, model?: string): number {
  const spec = resolveEmbeddingModelSpec(model)
  if (spec) return spec.batchSize
  const url = String(baseUrl || getEmbeddingBaseUrl() || '')
  for (const rule of PROVIDER_BATCH_CAPS) {
    if (rule.match.test(url)) return rule.max
  }
  return MAX_BATCH
}

function getProviderBatchHint(baseUrl?: string, model?: string): string {
  const spec = resolveEmbeddingModelSpec(model)
  if (spec) {
    const dimText = spec.dimensions.length > 1
      ? `可选维度 ${spec.dimensions.join('/')}（默认 ${spec.defaultDimensions || spec.dimensions[0]}）`
      : `维度 ${spec.dimensions[0] || '由接口返回'}`
    return `模型 ${spec.id}：官方批次上限 ${spec.batchSize}；${dimText}。${spec.note || ''} 保存/切换时会自动压到上限内。`
  }
  const url = String(baseUrl || getEmbeddingBaseUrl() || '')
  if (/dashscope\.aliyuncs\.com|aliyun|maas\.aliyuncs/i.test(url)) {
    return '通义兼容接口：未知模型时默认按批次 10 限制；建议选用 text-embedding-v3/v4。'
  }
  if (/bigmodel\.cn/i.test(url)) return '智谱 embedding 建议单次不超过 16 条。'
  if (/siliconflow/i.test(url)) return '硅基流动建议单次不超过 32 条。'
  if (/openai\.com/i.test(url)) return 'OpenAI 兼容接口一般可到 64 条，仍建议按文档限制设置。'
  return `当前服务商单次上限 ${getProviderBatchCap(url, model)} 条；保存时会自动限制在上限内。`
}

function getRequestedBatchSize(): number {
  const n = Math.round(Number(getSetting(EMBEDDING_BATCH_SIZE_KEY, String(DEFAULT_BATCH))))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH
  return Math.min(MAX_BATCH, n)
}

function getMaxEmbedChars(model?: string): number {
  const spec = resolveEmbeddingModelSpec(model)
  return spec?.maxChars || DEFAULT_MAX_EMBED_CHARS
}

/**
 * Clamp stored batch size to the current model/provider cap.
 * Returns true when the stored value was reduced.
 */
function ensureBatchSizeFitsProvider(baseUrl?: string, preferred?: number, model?: string): boolean {
  const cap = getProviderBatchCap(baseUrl, model)
  const requested = typeof preferred === 'number' && Number.isFinite(preferred)
    ? Math.max(1, Math.round(preferred))
    : getRequestedBatchSize()
  const next = Math.min(cap, MAX_BATCH, Math.max(1, requested))
  const prevRaw = getSetting(EMBEDDING_BATCH_SIZE_KEY)
  if (String(next) !== prevRaw) {
    setSetting(EMBEDDING_BATCH_SIZE_KEY, String(next))
    return next < requested || Boolean(prevRaw && Number(prevRaw) > cap)
  }
  return false
}

export function getEmbeddingBatchSize(): number {
  const cap = getProviderBatchCap()
  const requested = getRequestedBatchSize()
  return Math.min(cap, MAX_BATCH, Math.max(1, requested))
}

/** 0 means “use model default / omit dimensions param”. */
export function getEmbeddingDimensions(): number {
  const raw = Math.round(Number(getSetting(EMBEDDING_DIMENSIONS_KEY, '0')))
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const spec = resolveEmbeddingModelSpec()
  if (spec?.dimensions?.length) {
    if (spec.dimensions.includes(raw)) return raw
    return 0
  }
  return raw
}

function ensureDimensionsFitModel(model?: string, preferred?: number): boolean {
  const spec = resolveEmbeddingModelSpec(model)
  if (!spec || spec.dimensions.length <= 1) {
    // Fixed-dim models: clear custom dimensions so we don't send invalid params.
    if (getSetting(EMBEDDING_DIMENSIONS_KEY)) {
      setSetting(EMBEDDING_DIMENSIONS_KEY, '0')
      return true
    }
    return false
  }
  const requested = typeof preferred === 'number' && Number.isFinite(preferred) ? Math.round(preferred) : getEmbeddingDimensions()
  if (!requested) {
    // Keep 0 = default
    if (getSetting(EMBEDDING_DIMENSIONS_KEY) !== '0' && getSetting(EMBEDDING_DIMENSIONS_KEY) !== '') {
      // invalid previous value
      if (!spec.dimensions.includes(Number(getSetting(EMBEDDING_DIMENSIONS_KEY)))) {
        setSetting(EMBEDDING_DIMENSIONS_KEY, '0')
        return true
      }
    }
    return false
  }
  if (!spec.dimensions.includes(requested)) {
    setSetting(EMBEDDING_DIMENSIONS_KEY, String(spec.defaultDimensions || 0))
    return true
  }
  const prev = getSetting(EMBEDDING_DIMENSIONS_KEY)
  if (String(requested) !== prev) {
    setSetting(EMBEDDING_DIMENSIONS_KEY, String(requested))
    return true
  }
  return false
}

export function usesLlmCredentialsForEmbedding(): boolean {
  // Legacy flag: if a source profile is set, credentials always come from that profile.
  const raw = getSetting(EMBEDDING_USE_LLM_CREDENTIALS_KEY, 'false')
  return raw === 'true'
}

interface StoredLlmProfileRow {
  id?: string
  name?: string
  provider?: string
  baseUrl?: string
  model?: string
}

function listStoredLlmProfiles(): Array<{ id: string; name: string; provider: string; baseUrl: string; chatModel: string }> {
  const raw = getSetting(LLM_PROFILE_SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const row = (item || {}) as StoredLlmProfileRow
        return {
          id: String(row.id || row.name || '').trim(),
          name: String(row.name || row.provider || '').trim(),
          provider: String(row.provider || row.name || '').trim(),
          baseUrl: String(row.baseUrl || '').trim().replace(/\/+$/, ''),
          chatModel: String(row.model || '').trim(),
        }
      })
      .filter((item) => item.id && item.name && item.baseUrl)
  } catch {
    return []
  }
}

function getSourceProfileId(): string {
  return getSetting(EMBEDDING_SOURCE_PROFILE_ID_KEY)
}

function resolveLinkedProfile(profileId?: string): {
  id: string
  name: string
  provider: string
  baseUrl: string
  chatModel: string
} | null {
  const id = String(profileId || getSourceProfileId() || '').trim()
  if (!id) return null
  const profiles = listStoredLlmProfiles()
  return profiles.find((item) => item.id === id) || null
}

function normalizeEndpoint(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Seal the working global llm_api_key into a profile vault when the profile slot is empty
 * and we are confident the global key belongs to that profile (active id or same Base URL).
 * Vector UI only counts llm_profile:{id} as “已保存 Key”; older flows often wrote only the global slot.
 */
function ensureLlmProfileKeySealed(profileId: string, profileBaseUrl?: string): boolean {
  const id = String(profileId || '').trim()
  if (!id) return false
  const profileKey = `llm_profile:${id}`
  if (readProtectedSetting(profileKey).trim()) return true
  const global = readProtectedSetting('llm_api_key').trim()
  if (!global) return false
  const activeLlmId = getSetting('llm_active_provider_id')
  const globalBase = normalizeEndpoint(getSetting('llm_base_url'))
  const profileBase = normalizeEndpoint(profileBaseUrl || '')
  const sameActive = Boolean(activeLlmId && activeLlmId === id)
  const sameEndpoint = Boolean(profileBase && globalBase && profileBase === globalBase)
  if (!sameActive && !sameEndpoint) return false
  writeProtectedSetting(profileKey, global)
  return true
}

function ensureActiveLlmProfileKeySealed(): void {
  const activeLlmId = getSetting('llm_active_provider_id')
  if (!activeLlmId) return
  const linked = listStoredLlmProfiles().find((item) => item.id === activeLlmId)
  ensureLlmProfileKeySealed(activeLlmId, linked?.baseUrl)
  // Also seal into the embedding source profile when it shares the working Base URL.
  const sourceId = getSourceProfileId()
  if (sourceId && sourceId !== activeLlmId) {
    const source = listStoredLlmProfiles().find((item) => item.id === sourceId)
    ensureLlmProfileKeySealed(sourceId, source?.baseUrl)
  }
}

export function getEmbeddingLinkedProfiles(): EmbeddingLinkedProfile[] {
  ensureActiveLlmProfileKeySealed()
  const activeLlmId = getSetting('llm_active_provider_id')
  const globalBase = normalizeEndpoint(getSetting('llm_base_url'))
  return listStoredLlmProfiles().map((profile) => {
    // Prefer per-profile vault; seal/fallback only when global key is for this profile.
    ensureLlmProfileKeySealed(profile.id, profile.baseUrl)
    const profileState = getCredentialPublicState(`llm_profile:${profile.id}`)
    if (profileState.configured && profileState.state === 'active') {
      return {
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        chatModel: profile.chatModel,
        apiKeyConfigured: true,
        apiKeyLast4: profileState.last4 || undefined,
        keySource: 'profile' as const,
      }
    }
    // Active AI profile, or same working endpoint as the global key slot.
    const sameActive = profile.id === activeLlmId
    const sameEndpoint = Boolean(globalBase && normalizeEndpoint(profile.baseUrl) === globalBase)
    if (sameActive || sameEndpoint) {
      const globalState = getCredentialPublicState('llm_api_key')
      if (globalState.configured && globalState.state === 'active') {
        return {
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          chatModel: profile.chatModel,
          apiKeyConfigured: true,
          apiKeyLast4: globalState.last4 || undefined,
          keySource: sameActive ? 'active-global' as const : 'active-global' as const,
        }
      }
    }
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      chatModel: profile.chatModel,
      apiKeyConfigured: false,
      apiKeyLast4: undefined,
      keySource: 'none' as const,
    }
  })
}

export function getEmbeddingBaseUrl(): string {
  const linked = resolveLinkedProfile()
  if (linked?.baseUrl) return linked.baseUrl
  const dedicated = getSetting(EMBEDDING_BASE_URL_KEY)
  if (dedicated) return dedicated.replace(/\/+$/, '')
  return DEFAULT_EMBEDDING_BASE_URL
}

export function getEmbeddingModel(): string {
  return getSetting(EMBEDDING_MODEL_KEY, DEFAULT_EMBEDDING_MODEL) || DEFAULT_EMBEDDING_MODEL
}

export function getEmbeddingApiKey(): string {
  ensureActiveLlmProfileKeySealed()
  const profileId = getSourceProfileId()
  if (profileId) {
    const linked = resolveLinkedProfile(profileId)
    ensureLlmProfileKeySealed(profileId, linked?.baseUrl)
    const fromProfile = readProtectedSetting(`llm_profile:${profileId}`).trim()
    if (fromProfile) return fromProfile
    const activeLlmId = getSetting('llm_active_provider_id')
    const globalBase = normalizeEndpoint(getSetting('llm_base_url'))
    const sameActive = profileId === activeLlmId
    const sameEndpoint = Boolean(linked && globalBase && normalizeEndpoint(linked.baseUrl) === globalBase)
    if (sameActive || sameEndpoint) {
      const active = readProtectedSetting('llm_api_key').trim()
      if (active) return active
    }
  }
  if (usesLlmCredentialsForEmbedding()) {
    return readProtectedSetting('llm_api_key').trim()
  }
  return readProtectedSetting('embedding_api_key').trim()
}

export function getActiveModelId(): string {
  const model = getEmbeddingModel()
  const dim = getMeta('dim')
  return dim ? `${model}@${dim}` : model
}

function float32ToBuffer(values: Float32Array | number[]): Buffer {
  const len = values.length
  const buf = Buffer.allocUnsafe(len * 4)
  if (values instanceof Float32Array) {
    for (let i = 0; i < len; i += 1) buf.writeFloatLE(values[i], i * 4)
    return buf
  }
  for (let i = 0; i < len; i += 1) buf.writeFloatLE(Number(values[i]) || 0, i * 4)
  return buf
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = buf.readFloatLE(i * 4)
  }
  return out
}

function l2Normalize(vec: Float32Array | number[]): Float32Array {
  const out = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  let sum = 0
  for (let i = 0; i < out.length; i += 1) sum += out[i] * out[i]
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < out.length; i += 1) out[i] = out[i] / norm
  return out
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i += 1) s += a[i] * b[i]
  return s
}

/**
 * Keep only human-readable body text for the embeddings API.
 * Drop accidental JSON blobs / locator-like payloads if they ever leak into segment text.
 */
function clipEmbedText(text: string): string {
  let value = String(text || '')
  // Reject pure machine payloads (not literature prose).
  const trimmed = value.trim()
  if (
    !trimmed
    || trimmed === '{"externalized":true}'
    || (/^\s*\{[\s\S]*"sourceRanges"\s*:/.test(trimmed) && /"sourceHash"\s*:/.test(trimmed))
    || (/^\s*\{[\s\S]*"stable-reader-locator/.test(trimmed))
  ) {
    return ''
  }
  value = value.replace(/\s+/g, ' ').trim()
  const maxChars = getMaxEmbedChars()
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars)
}

function emitProgress(partial: {
  status: 'queued' | 'processing' | 'completed' | 'error'
  progress?: number
  message?: string
  docId?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
}): void {
  emitBackgroundTaskStatus({
    taskId: TASK_ID,
    kind: 'embedding-index',
    ...partial,
  })
}

/** Snapshot for UI when opening 处理队列 / 文献库 after reload. */
export function getEmbeddingProgressSnapshot(): EmbeddingProgressEvent {
  const snap = getQueueSnapshot()
  const active = snap.queueQueued + snap.queueProcessing
  return {
    status: queuePaused
      ? 'idle'
      : snap.queueProcessing > 0
        ? 'processing'
        : snap.queueQueued > 0
          ? 'queued'
          : 'idle',
    progress: 0,
    message: snap.queueProcessing > 0 || snap.queueQueued > 0
      ? `向量化队列：处理中 ${snap.queueProcessing} · 排队 ${snap.queueQueued}`
      : getMeta('last_message') || '向量化队列空闲',
    ...snap,
    sessionTotal: sessionTotal || active,
    updatedAt: nowIso(),
  }
}

export function getEmbeddingIndexStats(): EmbeddingIndexStats {
  const model = getEmbeddingModel()
  const dimRaw = getMeta('dim')
  const dim = dimRaw ? Number(dimRaw) : null
  const modelId = dim ? `${model}@${dim}` : model
  const linked = resolveLinkedProfile()
  const linkedProfiles = getEmbeddingLinkedProfiles()
  const countStatus = (status: string) =>
    Number(queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embedding_index_status WHERE status = ?', [status])?.c || 0)
  const chunks = Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embedding_chunks WHERE model_id = ? OR model_id LIKE ?', [
      modelId,
      `${model}@%`,
    ])?.c || 0,
  )
  const baseUrl = getEmbeddingBaseUrl()
  const batchSizeCap = getProviderBatchCap(baseUrl, model)
  const batchSizeRequested = getRequestedBatchSize()
  const batchSize = Math.min(batchSizeCap, batchSizeRequested)
  const spec = resolveEmbeddingModelSpec(model)
  const dimensions = getEmbeddingDimensions()
  const docsReady = countStatus('ready')
  const docsStale = countStaleEmbeddingDocuments()
  return {
    modelId,
    dim: Number.isFinite(dim as number) ? (dim as number) : null,
    autoOnIngest: isEmbeddingAutoOnIngest(),
    useLlmCredentials: usesLlmCredentialsForEmbedding() || Boolean(linked),
    sourceProfileId: linked?.id || getSourceProfileId(),
    sourceProfileName: linked?.name || '',
    baseUrl,
    model,
    batchSize,
    batchSizeCap,
    batchSizeRequested,
    batchSizeAutoAdjusted: batchSizeRequested > batchSizeCap,
    batchSizeHint: getProviderBatchHint(baseUrl, model),
    dimensions,
    dimensionsOptions: spec?.dimensions?.length ? [...spec.dimensions] : [],
    dimensionsDefault: spec?.defaultDimensions ?? (spec?.dimensions?.[0] ?? null),
    modelSpecNote: spec?.note,
    apiKeyConfigured: Boolean(getEmbeddingApiKey()),
    docsReady,
    docsQueued: countStatus('queued'),
    docsProcessing: countStatus('processing'),
    docsError: countStatus('error'),
    docsPending: countStatus('pending'),
    /** Ready under old model / missing chunks for the active model. */
    docsStale,
    chunks,
    queuePaused,
    message: getMeta('last_message') || undefined,
    linkedProfiles,
  }
}

export function setEmbeddingSettings(input: {
  autoOnIngest?: boolean
  baseUrl?: string
  model?: string
  batchSize?: number
  /** 0 or omit = model default; otherwise must be in model dimensions list. */
  dimensions?: number | null
  /** When true, set batch size to the model/provider recommended default (capped). */
  resetBatchSizeToProviderDefault?: boolean
  useLlmCredentials?: boolean
  sourceProfileId?: string | null
}): EmbeddingIndexStats {
  let batchAutoAdjusted = false
  if (typeof input.autoOnIngest === 'boolean') {
    setSetting(EMBEDDING_AUTO_ON_INGEST_KEY, input.autoOnIngest ? 'true' : 'false')
  }
  if (typeof input.model === 'string' && input.model.trim()) {
    setSetting(EMBEDDING_MODEL_KEY, input.model.trim())
    // Changing model: re-clamp batch + dimensions to that model's official limits.
    batchAutoAdjusted = ensureBatchSizeFitsProvider(undefined, undefined, input.model.trim()) || batchAutoAdjusted
    ensureDimensionsFitModel(input.model.trim())
  }
  if (input.sourceProfileId !== undefined) {
    const profileId = String(input.sourceProfileId || '').trim()
    if (!profileId) {
      setSetting(EMBEDDING_SOURCE_PROFILE_ID_KEY, '')
    } else {
      const linked = resolveLinkedProfile(profileId)
      if (!linked) {
        throw new Error('未找到该 AI 服务商配置，请先在「AI 配置中心」保存服务商')
      }
      setSetting(EMBEDDING_SOURCE_PROFILE_ID_KEY, linked.id)
      setSetting(EMBEDDING_BASE_URL_KEY, linked.baseUrl)
      // Selecting a saved AI profile always reuses its Key (not a separate embedding key).
      setSetting(EMBEDDING_USE_LLM_CREDENTIALS_KEY, 'false')
      // If model looks like a chat model / empty, suggest provider embedding default.
      const currentModel = getEmbeddingModel()
      const looksLikeChat = /deepseek|chat|plus|turbo|flash/i.test(currentModel) && !/embed/i.test(currentModel)
      if ((!currentModel || looksLikeChat) && /dashscope|aliyun|maas\.aliyuncs/i.test(linked.baseUrl)) {
        setSetting(EMBEDDING_MODEL_KEY, DEFAULT_EMBEDDING_MODEL)
      }
      batchAutoAdjusted = ensureBatchSizeFitsProvider(linked.baseUrl, undefined, getEmbeddingModel()) || batchAutoAdjusted
      ensureDimensionsFitModel(getEmbeddingModel())
    }
  }
  if (typeof input.baseUrl === 'string' && !getSourceProfileId()) {
    setSetting(EMBEDDING_BASE_URL_KEY, input.baseUrl.trim().replace(/\/+$/, ''))
    batchAutoAdjusted = ensureBatchSizeFitsProvider(input.baseUrl, undefined, getEmbeddingModel()) || batchAutoAdjusted
  }
  // When linked to a profile, keep baseUrl in sync with that profile on every save.
  const linkedAfter = resolveLinkedProfile()
  if (linkedAfter?.baseUrl) {
    setSetting(EMBEDDING_BASE_URL_KEY, linkedAfter.baseUrl)
  }
  if (input.resetBatchSizeToProviderDefault) {
    const cap = getProviderBatchCap(undefined, getEmbeddingModel())
    const recommended = Math.min(DEFAULT_BATCH, cap)
    setSetting(EMBEDDING_BATCH_SIZE_KEY, String(recommended))
    batchAutoAdjusted = true
  } else if (typeof input.batchSize === 'number' && Number.isFinite(input.batchSize)) {
    batchAutoAdjusted = ensureBatchSizeFitsProvider(undefined, input.batchSize, getEmbeddingModel()) || batchAutoAdjusted
  } else {
    batchAutoAdjusted = ensureBatchSizeFitsProvider(undefined, undefined, getEmbeddingModel()) || batchAutoAdjusted
  }
  if (input.dimensions !== undefined) {
    const value = input.dimensions === null || input.dimensions === undefined
      ? 0
      : Math.round(Number(input.dimensions) || 0)
    setSetting(EMBEDDING_DIMENSIONS_KEY, String(Math.max(0, value)))
    ensureDimensionsFitModel(getEmbeddingModel(), value > 0 ? value : undefined)
  } else {
    ensureDimensionsFitModel(getEmbeddingModel())
  }
  if (typeof input.useLlmCredentials === 'boolean') {
    setSetting(EMBEDDING_USE_LLM_CREDENTIALS_KEY, input.useLlmCredentials ? 'true' : 'false')
  }
  saveDatabase()
  const stats = getEmbeddingIndexStats()
  if (batchAutoAdjusted) {
    setMeta(
      'last_message',
      `已按模型「${stats.model}」限制自动调整批次为 ${stats.batchSize}（上限 ${stats.batchSizeCap}）`
      + (stats.dimensions > 0 ? `，维度 ${stats.dimensions}` : ''),
    )
    return { ...getEmbeddingIndexStats(), batchSizeAutoAdjusted: true }
  }
  return stats
}

/** Re-queue documents that previously failed vectorization. */
export function requeueFailedEmbeddings(): {
  queued: number
  skipped: number
  reindexed: number
  clearedChunks: number
} {
  const rows = queryAll<{ doc_id: string }>(
    "SELECT doc_id FROM embedding_index_status WHERE status = 'error'",
  )
  const ids = rows.map((row) => String(row.doc_id || '').trim()).filter(Boolean)
  if (ids.length === 0) return { queued: 0, skipped: 0, reindexed: 0, clearedChunks: 0 }
  // Force clear any partial chunks from the failed run.
  return enqueueDocumentsForEmbedding(ids, { force: true })
}

export function setEmbeddingQueuePaused(paused: boolean): EmbeddingIndexStats {
  queuePaused = paused
  if (!paused) scheduleEmbeddingQueue()
  setMeta('last_message', paused ? '向量化队列已暂停' : '向量化队列已继续')
  saveDatabase()
  sendEmbeddingProgress({
    status: paused ? 'idle' : countEmbeddingStatus('queued') > 0 || countEmbeddingStatus('processing') > 0 ? 'queued' : 'idle',
    progress: 0,
    message: paused ? '向量化队列已暂停' : '向量化队列已继续',
  })
  emitQueueBackgroundProgress(paused ? 'queued' : 'processing', paused ? '向量化队列已暂停' : '向量化队列已继续')
  return getEmbeddingIndexStats()
}

function upsertDocStatus(
  docId: string,
  status: EmbeddingDocStatus,
  fields?: { segmentCount?: number; embeddedCount?: number; contentHash?: string; error?: string },
): void {
  const existing = queryOne<{ doc_id: string }>('SELECT doc_id FROM embedding_index_status WHERE doc_id = ?', [docId])
  const updatedAt = nowIso()
  if (!existing) {
    run(
      `INSERT INTO embedding_index_status (doc_id, status, segment_count, embedded_count, content_hash, error_message, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        status,
        fields?.segmentCount ?? 0,
        fields?.embeddedCount ?? 0,
        fields?.contentHash ?? '',
        fields?.error ?? '',
        updatedAt,
      ],
    )
    return
  }
  run(
    `UPDATE embedding_index_status
     SET status = ?,
         segment_count = COALESCE(?, segment_count),
         embedded_count = COALESCE(?, embedded_count),
         content_hash = COALESCE(?, content_hash),
         error_message = COALESCE(?, error_message),
         updated_at = ?
     WHERE doc_id = ?`,
    [
      status,
      fields?.segmentCount ?? null,
      fields?.embeddedCount ?? null,
      fields?.contentHash ?? null,
      fields?.error ?? null,
      updatedAt,
      docId,
    ],
  )
}

function getActiveEmbeddingModelIdPrefix(): string {
  const modelName = getEmbeddingModel()
  const dimMeta = getMeta('dim')
  return dimMeta ? `${modelName}@${dimMeta}` : modelName
}

/** Drop stored vectors for a document so the next run writes a clean index. */
function clearDocumentEmbeddingChunks(docId: string, options?: { onlyCurrentModel?: boolean }): number {
  const id = String(docId || '').trim()
  if (!id) return 0
  if (options?.onlyCurrentModel) {
    const modelId = getActiveEmbeddingModelIdPrefix()
    const before = Number(
      queryOne<{ c: number }>(
        'SELECT COUNT(*) as c FROM embedding_chunks WHERE doc_id = ? AND (model_id = ? OR model_id LIKE ?)',
        [id, modelId, `${getEmbeddingModel()}@%`],
      )?.c || 0,
    )
    run(
      'DELETE FROM embedding_chunks WHERE doc_id = ? AND (model_id = ? OR model_id LIKE ?)',
      [id, modelId, `${getEmbeddingModel()}@%`],
    )
    return before
  }
  const before = Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embedding_chunks WHERE doc_id = ?', [id])?.c || 0,
  )
  run('DELETE FROM embedding_chunks WHERE doc_id = ?', [id])
  return before
}

export interface EnqueueEmbeddingOptions {
  /**
   * Force re-vectorize: clear old chunks and re-queue even if status is already ready.
   * Use when switching to a stronger embedding model.
   */
  force?: boolean
  /** When force, only delete chunks for the current model family (default: delete all models for the doc). */
  onlyCurrentModel?: boolean
}

/** Manual path: user selected documents. */
export function enqueueDocumentsForEmbedding(
  docIds: string[],
  options?: EnqueueEmbeddingOptions,
): { queued: number; skipped: number; reindexed: number; clearedChunks: number } {
  const force = Boolean(options?.force)
  const unique = Array.from(new Set(docIds.map((id) => String(id || '').trim()).filter(Boolean)))
  let queued = 0
  let skipped = 0
  let reindexed = 0
  let clearedChunks = 0
  const queuedIds: string[] = []
  const priorActive = countEmbeddingStatus('queued') + countEmbeddingStatus('processing')
  for (const docId of unique) {
    const exists = queryOne<{ id: string }>('SELECT id FROM documents WHERE id = ?', [docId])
    if (!exists) {
      skipped += 1
      continue
    }
    const segments = Number(
      queryOne<{ c: number }>('SELECT COUNT(*) as c FROM search_index_segments WHERE doc_id = ?', [docId])?.c || 0,
    )
    if (segments <= 0) {
      upsertDocStatus(docId, 'pending', {
        segmentCount: 0,
        error: '检索分段尚未就绪，请等待搜索索引完成后再向量化',
      })
      sendEmbeddingProgress({
        docId,
        status: 'pending',
        progress: 0,
        segmentCount: 0,
        message: '检索分段尚未就绪，请等待搜索索引完成后再向量化',
        errorMessage: '检索分段尚未就绪',
      })
      skipped += 1
      continue
    }
    const previous = queryOne<{ status?: string }>('SELECT status FROM embedding_index_status WHERE doc_id = ?', [docId])
    const wasReady = String(previous?.status || '') === 'ready'
    if (force) {
      clearedChunks += clearDocumentEmbeddingChunks(docId, { onlyCurrentModel: options?.onlyCurrentModel })
      if (wasReady) reindexed += 1
    }
    upsertDocStatus(docId, 'queued', { segmentCount: segments, embeddedCount: 0, error: '' })
    queuedIds.push(docId)
    queued += 1
  }
  saveDatabase()
  if (queued > 0) {
    // Fresh session when the queue was idle; otherwise extend the current run.
    if (priorActive === 0 && !queueRunning) {
      sessionTotal = queued
      sessionCompleted = 0
      sessionFailed = 0
    } else {
      sessionTotal += queued
    }
    const label = force ? '重新向量化' : '向量化'
    setMeta('last_message', `已入队${label} ${queued} 篇文献`)
    for (const docId of queuedIds) {
      sendEmbeddingProgress({
        docId,
        status: 'queued',
        progress: 0,
        message: force ? '已排队，等待按当前模型重新向量化' : '已排队，等待向量化',
      })
    }
    emitQueueBackgroundProgress(
      'queued',
      force
        ? `已入队重新向量化 ${queued} 篇（当前模型 ${getEmbeddingModel()}）`
        : `已入队向量化 ${queued} 篇，可在处理队列与文献卡片查看进度`,
    )
    try {
      markLibraryStateCacheDirty()
    } catch {
      // ignore
    }
    scheduleEmbeddingQueue()
  }
  return { queued, skipped, reindexed, clearedChunks }
}

/**
 * Re-vectorize documents already marked ready (or any with chunks), using the *current* model settings.
 * Typical use: user upgraded embedding model and wants the corpus rebuilt.
 */
export function reindexDocumentsForEmbedding(docIds: string[]): {
  queued: number
  skipped: number
  reindexed: number
  clearedChunks: number
} {
  return enqueueDocumentsForEmbedding(docIds, { force: true })
}

/** Re-queue every document that currently has a ready vector index. */
export function reindexAllReadyEmbeddings(): {
  queued: number
  skipped: number
  reindexed: number
  clearedChunks: number
} {
  const rows = queryAll<{ doc_id: string }>(
    "SELECT doc_id FROM embedding_index_status WHERE status = 'ready'",
  )
  const ids = rows.map((row) => String(row.doc_id || '').trim()).filter(Boolean)
  if (ids.length === 0) return { queued: 0, skipped: 0, reindexed: 0, clearedChunks: 0 }
  return enqueueDocumentsForEmbedding(ids, { force: true })
}

/**
 * Re-queue docs that are "ready" but have no chunks for the active model
 * (e.g. user changed model/dimensions after a previous index build).
 */
export function reindexStaleEmbeddings(): {
  queued: number
  skipped: number
  reindexed: number
  clearedChunks: number
  stale: number
} {
  const modelName = getEmbeddingModel()
  const modelId = getActiveEmbeddingModelIdPrefix()
  const rows = queryAll<{ doc_id: string }>(
    `SELECT eis.doc_id
     FROM embedding_index_status eis
     WHERE eis.status = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM embedding_chunks ec
         WHERE ec.doc_id = eis.doc_id
           AND (ec.model_id = ? OR ec.model_id LIKE ?)
       )`,
    [modelId, `${modelName}@%`],
  )
  const ids = rows.map((row) => String(row.doc_id || '').trim()).filter(Boolean)
  if (ids.length === 0) {
    return { queued: 0, skipped: 0, reindexed: 0, clearedChunks: 0, stale: 0 }
  }
  const result = enqueueDocumentsForEmbedding(ids, { force: true })
  return { ...result, stale: ids.length }
}

/** Count docs ready under status table but missing vectors for the current model. */
export function countStaleEmbeddingDocuments(): number {
  const modelName = getEmbeddingModel()
  const modelId = getActiveEmbeddingModelIdPrefix()
  return Number(
    queryOne<{ c: number }>(
      `SELECT COUNT(*) as c
       FROM embedding_index_status eis
       WHERE eis.status = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM embedding_chunks ec
           WHERE ec.doc_id = eis.doc_id
             AND (ec.model_id = ? OR ec.model_id LIKE ?)
         )`,
      [modelId, `${modelName}@%`],
    )?.c || 0,
  )
}

/**
 * Called after ingest/OCR when auto-on-ingest is enabled,
 * or when an already-indexed doc's content hash may have changed.
 */
export function notifyDocumentReadyForEmbedding(docId: string, options?: { force?: boolean }): void {
  const id = String(docId || '').trim()
  if (!id) return
  const auto = isEmbeddingAutoOnIngest()
  const existing = queryOne<{ status: string }>('SELECT status FROM embedding_index_status WHERE doc_id = ?', [id])
  const alreadyTracked = Boolean(existing && ['ready', 'queued', 'processing', 'error'].includes(String(existing.status)))
  if (!options?.force && !auto && !alreadyTracked) return

  const segments = Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM search_index_segments WHERE doc_id = ?', [id])?.c || 0,
  )
  if (segments <= 0) {
    if (auto || alreadyTracked) {
      upsertDocStatus(id, 'pending', { segmentCount: 0, error: '等待搜索分段就绪' })
      saveDatabase()
    }
    return
  }
  upsertDocStatus(id, 'queued', { segmentCount: segments, error: '' })
  saveDatabase()
  scheduleEmbeddingQueue()
}

export function scheduleEmbeddingQueue(): void {
  if (queueTimer) return
  queueTimer = setTimeout(() => {
    queueTimer = null
    void processEmbeddingQueue()
  }, 200)
}

function formatEmbeddingsApiError(status: number, body: string): string {
  const text = String(body || '').trim()
  // DashScope: batch size is invalid, it should not be larger than 10
  if (/batch size is invalid|should not be larger than\s*(\d+)/i.test(text)) {
    const maxMatch = text.match(/should not be larger than\s*(\d+)/i)
    const max = maxMatch?.[1] || '10'
    return `Embeddings 批次过大：该服务商单次最多 ${max} 条文本（已自动按此上限拆分，请重新向量化）`
  }
  if (/InvalidParameter|invalid.?parameter/i.test(text) && /model/i.test(text)) {
    return `Embeddings 模型参数无效，请检查向量模型 ID 是否与当前服务商匹配`
  }
  if (status === 401 || status === 403) {
    return `Embeddings 鉴权失败（${status}）：请检查所选 AI 服务商的 API Key 是否有效`
  }
  if (status === 429) {
    return 'Embeddings 请求过于频繁（429），请稍后重试或降低并发'
  }
  const snippet = text.slice(0, 220).replace(/\s+/g, ' ')
  return `Embeddings API ${status}${snippet ? `：${snippet}` : ''}`
}

async function fetchEmbeddingsOnce(texts: string[]): Promise<number[][]> {
  const apiKey = getEmbeddingApiKey()
  if (!apiKey) {
    throw new Error('未配置 Embeddings API Key。请在设置 → 向量索引选择已保存 Key 的服务商（如通义）。')
  }
  const baseUrl = getEmbeddingBaseUrl()
  if (!baseUrl) throw new Error('未配置 Embeddings Base URL')
  const model = getEmbeddingModel()
  const dimensions = getEmbeddingDimensions()
  // OpenAI-compatible body (DashScope 百炼 compatible-mode).
  // dimensions is optional; omit when 0 so the model default applies (e.g. v3/v4 → 1024).
  const body: Record<string, unknown> = {
    model,
    input: texts.length === 1 ? texts[0] : texts,
  }
  if (dimensions > 0) body.dimensions = dimensions
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMBEDDINGS_FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error(`Embeddings 请求超时（>${Math.round(EMBEDDINGS_FETCH_TIMEOUT_MS / 1000)}s），请检查网络或减小批次`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(formatEmbeddingsApiError(response.status, errBody))
  }
  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>
  }
  const rows = Array.isArray(payload.data) ? payload.data : []
  const sorted = [...rows].sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
  if (sorted.length !== texts.length) {
    throw new Error(`Embeddings 返回条数不匹配：期望 ${texts.length}，实际 ${sorted.length}`)
  }
  return sorted.map((row) => {
    const emb = row.embedding
    if (!Array.isArray(emb) || emb.length === 0) throw new Error('Embeddings 返回空向量')
    // Keep as plain number[] for normalize; avoid nested typed-array copies later.
    const out = new Array<number>(emb.length)
    for (let i = 0; i < emb.length; i += 1) out[i] = Number(emb[i]) || 0
    return out
  })
}

/**
 * Call /embeddings, splitting when the provider rejects oversized batches.
 * DashScope text-embedding-v* hard-caps at 10 inputs per request.
 */
async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const cap = getProviderBatchCap()
  if (texts.length > cap) {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += cap) {
      const part = await fetchEmbeddingsOnce(texts.slice(i, i + cap))
      out.push(...part)
    }
    return out
  }
  try {
    return await fetchEmbeddingsOnce(texts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const maxMatch = message.match(/最多\s*(\d+)\s*条/) || message.match(/larger than\s*(\d+)/i)
    const forcedMax = maxMatch ? Math.max(1, Number(maxMatch[1]) || 10) : 0
    if (forcedMax > 0 && texts.length > forcedMax) {
      // Persist a safer batch size for subsequent documents.
      setSetting(EMBEDDING_BATCH_SIZE_KEY, String(forcedMax))
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += forcedMax) {
        const part = await fetchEmbeddingsOnce(texts.slice(i, i + forcedMax))
        out.push(...part)
      }
      return out
    }
    throw error
  }
}

async function embedDocument(docId: string): Promise<void> {
  // Only body text — never offset_map / title / href. Load in windows to avoid OOM on huge books.
  const totalSegments = Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM search_index_segments WHERE doc_id = ?', [docId])?.c || 0,
  )
  if (totalSegments <= 0) {
    upsertDocStatus(docId, 'pending', { segmentCount: 0, error: '无检索分段' })
    return
  }

  upsertDocStatus(docId, 'processing', { segmentCount: totalSegments, error: '' })
  sendEmbeddingProgress({
    docId,
    status: 'processing',
    progress: 0,
    segmentCount: totalSegments,
    embeddedCount: 0,
    message: `正在向量化… 0/${totalSegments} 段`,
  })
  emitQueueBackgroundProgress('processing', `正在向量化文献（0/${totalSegments} 段）`, docId)

  const batchSize = Math.max(1, getEmbeddingBatchSize())
  let embedded = 0
  let dim = 0
  const modelName = getEmbeddingModel()
  let offset = 0

  while (offset < totalSegments) {
    if (queuePaused) {
      upsertDocStatus(docId, 'queued', { segmentCount: totalSegments, embeddedCount: embedded })
      sendEmbeddingProgress({
        docId,
        status: 'queued',
        progress: Math.round((embedded / Math.max(1, totalSegments)) * 100),
        segmentCount: totalSegments,
        embeddedCount: embedded,
        message: '向量化已暂停，等待继续',
      })
      throw new Error('queue_paused')
    }

    const windowSize = Math.max(batchSize, SEGMENT_LOAD_WINDOW)
    const segments = queryAll<{
      segment_id: string
      doc_id: string
      page_id: string | null
      page_num: number | null
      body: string | null
      text_hash: string | null
    }>(
      `SELECT segment_id, doc_id, page_id, page_num,
              COALESCE(NULLIF(normalized_text, ''), text) AS body,
              text_hash
       FROM search_index_segments
       WHERE doc_id = ?
       ORDER BY page_num ASC, ordinal ASC
       LIMIT ? OFFSET ?`,
      [docId, windowSize, offset],
    )
    if (segments.length === 0) break

    for (let i = 0; i < segments.length; i += batchSize) {
      if (queuePaused) {
        upsertDocStatus(docId, 'queued', { segmentCount: totalSegments, embeddedCount: embedded })
        throw new Error('queue_paused')
      }
      const batch = segments.slice(i, i + batchSize)
      const texts = batch.map((seg) => clipEmbedText(String(seg.body || '')))
      const nonEmptyIndexes = texts.map((t, idx) => (t ? idx : -1)).filter((idx) => idx >= 0)
      if (nonEmptyIndexes.length === 0) {
        embedded += batch.length
        continue
      }
      const inputs = nonEmptyIndexes.map((idx) => texts[idx])
      const vectors = await fetchEmbeddings(inputs)
      const updatedAt = nowIso()
      // Write one batch in a single transaction to reduce WAL pressure / lock time.
      transaction(() => {
        for (let j = 0; j < nonEmptyIndexes.length; j += 1) {
          const seg = batch[nonEmptyIndexes[j]]
          const vec = l2Normalize(vectors[j])
          dim = vec.length
          const modelId = `${modelName}@${dim}`
          run(
            `INSERT OR REPLACE INTO embedding_chunks
             (segment_id, doc_id, page_id, page_num, model_id, dim, content_hash, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              seg.segment_id,
              seg.doc_id,
              seg.page_id,
              seg.page_num,
              modelId,
              dim,
              String(seg.text_hash || ''),
              float32ToBuffer(vec),
              updatedAt,
            ],
          )
        }
      })
      embedded += batch.length
      const percent = Math.round((embedded / totalSegments) * 100)
      upsertDocStatus(docId, 'processing', {
        segmentCount: totalSegments,
        embeddedCount: embedded,
      })
      sendEmbeddingProgress({
        docId,
        status: 'processing',
        progress: percent,
        segmentCount: totalSegments,
        embeddedCount: embedded,
        message: `向量化中 ${embedded}/${totalSegments} 段`,
      })
      emitQueueBackgroundProgress('processing', `向量化中 ${embedded}/${totalSegments} 段`, docId)
      // Defer checkpoint instead of full save; keep UI/IPC responsive.
      scheduleDatabaseSave({ minDelayMs: 2000 })
      await sleep(BATCH_YIELD_MS)
    }

    offset += segments.length
  }

  if (dim > 0) {
    setMeta('dim', String(dim))
    setMeta('model_id', `${modelName}@${dim}`)
  }
  upsertDocStatus(docId, 'ready', {
    segmentCount: totalSegments,
    embeddedCount: embedded,
    contentHash: '',
    error: '',
  })
  sessionCompleted += 1
  try {
    markLibraryStateCacheDirty()
  } catch {
    // non-fatal: sidebar counts refresh on next open
  }
  sendEmbeddingProgress({
    docId,
    status: 'ready',
    progress: 100,
    segmentCount: totalSegments,
    embeddedCount: embedded,
    message: `向量化完成 ${embedded} 段`,
  })
  scheduleDatabaseSave({ minDelayMs: 500 })
}

async function processEmbeddingQueue(): Promise<void> {
  if (queueRunning || queuePaused) return
  queueRunning = true
  try {
    while (!queuePaused) {
      const next = queryOne<{ doc_id: string }>(
        `SELECT doc_id FROM embedding_index_status
         WHERE status = 'queued'
         ORDER BY updated_at ASC
         LIMIT 1`,
      )
      if (!next?.doc_id) break
      try {
        await embedDocument(next.doc_id)
        setMeta('last_message', `已完成向量化：${next.doc_id}`)
        // Prefer deferred checkpoint — forcing WAL checkpoint after every book can freeze/kill the app.
        scheduleDatabaseSave({ minDelayMs: 800 })
        await sleep(DOC_YIELD_MS)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'queue_paused') break
        sessionFailed += 1
        try {
          upsertDocStatus(next.doc_id, 'error', { error: message.slice(0, 500) })
          setMeta('last_message', `向量化失败：${message.slice(0, 200)}`)
          scheduleDatabaseSave({ minDelayMs: 500 })
        } catch (statusError) {
          console.error('[embedding] failed to record doc error', statusError)
        }
        sendEmbeddingProgress({
          docId: next.doc_id,
          status: 'error',
          progress: 0,
          message: `向量化失败：${message.slice(0, 120)}`,
          errorMessage: message,
        })
        emitProgress({ status: 'error', docId: next.doc_id, errorMessage: message, message })
        // Continue with the next document instead of aborting the whole queue.
        await sleep(DOC_YIELD_MS)
      }
    }
    const remaining = Number(
      queryOne<{ c: number }>("SELECT COUNT(*) as c FROM embedding_index_status WHERE status = 'queued'")?.c || 0,
    )
    const processing = countEmbeddingStatus('processing')
    if (remaining === 0 && processing === 0 && !queuePaused) {
      emitQueueBackgroundProgress(
        'completed',
        `向量化完成：成功 ${sessionCompleted} 篇${sessionFailed > 0 ? `，失败 ${sessionFailed} 篇` : ''}`,
      )
      sendEmbeddingProgress({
        status: 'idle',
        progress: 100,
        message: `向量化队列空闲（本轮成功 ${sessionCompleted}，失败 ${sessionFailed}）`,
      })
      scheduleDatabaseSave({ minDelayMs: 300 })
    }
  } catch (error) {
    // Last-resort guard so a unexpected throw never leaves queueRunning stuck forever.
    const message = error instanceof Error ? error.message : String(error)
    console.error('[embedding] queue crashed', error)
    setMeta('last_message', `向量化队列异常中断：${message.slice(0, 200)}`)
    emitProgress({ status: 'error', message: `向量化队列异常：${message.slice(0, 120)}`, errorMessage: message })
    sendEmbeddingProgress({
      status: 'error',
      progress: 0,
      message: `向量化队列异常：${message.slice(0, 120)}`,
      errorMessage: message,
    })
  } finally {
    queueRunning = false
    const stillQueued = Number(
      queryOne<{ c: number }>("SELECT COUNT(*) as c FROM embedding_index_status WHERE status = 'queued'")?.c || 0,
    )
    if (stillQueued > 0 && !queuePaused) scheduleEmbeddingQueue()
  }
}

export async function vectorSearch(
  query: string,
  options?: { limit?: number; folderId?: string; tagId?: string },
): Promise<VectorSearchResult | VectorSearchError> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, code: 'invalid_args', message: 'query is required' }

  const modelName = getEmbeddingModel()
  const dimMeta = getMeta('dim')
  const modelId = dimMeta ? `${modelName}@${dimMeta}` : getMeta('model_id') || modelName
  const totalChunks = Number(
    queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embedding_chunks WHERE model_id = ?', [modelId])?.c || 0,
  )
  if (totalChunks <= 0) {
    return {
      ok: false,
      code: 'index_empty',
      message: '向量索引为空。请在设置中配置 Embeddings，并在文献库多选文献后执行「向量化」。',
    }
  }

  let queryVec: Float32Array
  try {
    const [raw] = await fetchEmbeddings([clipEmbedText(q)])
    queryVec = l2Normalize(raw)
  } catch (error) {
    return {
      ok: false,
      code: 'embed_failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  let allowedDocs: Set<string> | null = null
  if (options?.folderId) {
    const folderIds = resolveFolderAndDescendantIds([String(options.folderId)])
    if (folderIds.length > 0) {
      const placeholders = folderIds.map(() => '?').join(',')
      const rows = queryAll<{ doc_id: string }>(
        `SELECT DISTINCT doc_id FROM document_folders WHERE folder_id IN (${placeholders})`,
        folderIds,
      )
      allowedDocs = new Set(rows.map((r) => r.doc_id))
    } else {
      allowedDocs = new Set()
    }
  }
  if (options?.tagId) {
    const rows = queryAll<{ doc_id: string }>('SELECT doc_id FROM document_tags WHERE tag_id = ?', [String(options.tagId)])
    const tagSet = new Set(rows.map((r) => r.doc_id))
    allowedDocs = allowedDocs
      ? new Set([...allowedDocs].filter((id) => tagSet.has(id)))
      : tagSet
  }

  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.round(Number(options?.limit || 20)) || 20))
  type Cand = { segmentId: string; docId: string; pageId: string | null; pageNum: number | null; score: number }
  const best: Cand[] = []

  let offset = 0
  for (;;) {
    const rows = queryAll<{
      segment_id: string
      doc_id: string
      page_id: string | null
      page_num: number | null
      embedding: Buffer
    }>(
      `SELECT segment_id, doc_id, page_id, page_num, embedding
       FROM embedding_chunks
       WHERE model_id = ?
       LIMIT ? OFFSET ?`,
      [modelId, SCAN_CHUNK_ROWS, offset],
    )
    if (rows.length === 0) break
    for (const row of rows) {
      if (allowedDocs && !allowedDocs.has(row.doc_id)) continue
      const emb = bufferToFloat32(Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding as ArrayBuffer))
      if (emb.length !== queryVec.length) continue
      const score = cosine(queryVec, emb)
      if (best.length < limit) {
        best.push({
          segmentId: row.segment_id,
          docId: row.doc_id,
          pageId: row.page_id,
          pageNum: row.page_num,
          score,
        })
        best.sort((a, b) => b.score - a.score)
      } else if (score > best[best.length - 1].score) {
        best[best.length - 1] = {
          segmentId: row.segment_id,
          docId: row.doc_id,
          pageId: row.page_id,
          pageNum: row.page_num,
          score,
        }
        best.sort((a, b) => b.score - a.score)
      }
    }
    offset += rows.length
    if (rows.length < SCAN_CHUNK_ROWS) break
  }

  const hits: VectorSearchHit[] = best.map((item) => {
    const doc = queryOne<{ title?: string | null; author?: string | null }>(
      'SELECT title, author FROM documents WHERE id = ?',
      [item.docId],
    )
    const seg = queryOne<{ text?: string | null; normalized_text?: string | null }>(
      'SELECT text, normalized_text FROM search_index_segments WHERE segment_id = ?',
      [item.segmentId],
    )
    const excerpt = String(seg?.normalized_text || seg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    return {
      documentId: item.docId,
      title: doc?.title ?? null,
      author: doc?.author ?? null,
      pageNum: item.pageNum,
      excerpt,
      score: Math.round(item.score * 10000) / 10000,
      ref: { docId: item.docId, pageNum: item.pageNum, segmentId: item.segmentId },
    }
  })

  return {
    ok: true,
    query: q,
    modelId,
    totalHits: hits.length,
    hits,
    hint: '语义召回结果；请用 get_page_text(ref.docId, ref.pageNum) 精读正文。专名精确匹配可用 library_search。',
  }
}

/** Startup: resume queue if any. */
export function resumeEmbeddingQueueOnStartup(): void {
  const queued = Number(
    queryOne<{ c: number }>("SELECT COUNT(*) as c FROM embedding_index_status WHERE status IN ('queued','processing')")?.c || 0,
  )
  if (queued > 0) {
    run("UPDATE embedding_index_status SET status = 'queued' WHERE status = 'processing'")
    saveDatabase()
    sessionTotal = Math.max(sessionTotal, queued)
    scheduleEmbeddingQueue()
    sendEmbeddingProgress({
      status: 'queued',
      progress: 0,
      message: `启动恢复：继续向量化 ${queued} 篇`,
    })
  }
}
