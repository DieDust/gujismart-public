import { randomUUID } from 'crypto'
import { queryOne, run } from './database'
import {
  getCredentialPublicState,
  readProtectedSetting,
  revokeProtectedSetting,
  writeProtectedSetting,
} from './settings-security'
import type {
  PaddleOcrTokenPoolEntry,
  PaddleOcrTokenPoolState,
  PaddleOcrTokenRuntimeStatus,
} from '../shared/types'

const PRIMARY_TOKEN_ID = 'primary'
const PRIMARY_CREDENTIAL_KEY = 'paddleocr_api_key'
const TOKEN_POOL_SETTING_KEY = 'paddleocr_token_pool'
const TOKEN_CREDENTIAL_PREFIX = 'paddleocr_token:'
const MAX_POOL_SIZE = 32

interface StoredTokenEntry {
  id: string
  label: string
  enabled: boolean
}

interface StoredTokenPool {
  version: 1
  primaryLabel: string
  primaryEnabled: boolean
  entries: StoredTokenEntry[]
}

interface TokenRuntimeFailure {
  status: Exclude<PaddleOcrTokenRuntimeStatus, 'active' | 'ready'>
  until: number
  message: string
}

export interface PaddleOcrTokenLease {
  id: string
  label: string
  token: string
}

const runtimeFailures = new Map<string, TokenRuntimeFailure>()
let activeTokenId: string | null = null

function sanitizeLabel(value: unknown, fallback: string): string {
  return String(value || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 40) || fallback
}

function isStoredTokenEntry(value: unknown): value is StoredTokenEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return /^[a-f0-9-]{16,64}$/i.test(String(record.id || ''))
}

function readStoredPool(): StoredTokenPool {
  const row = queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [TOKEN_POOL_SETTING_KEY])
  try {
    const parsed = JSON.parse(String(row?.value || '')) as Partial<StoredTokenPool>
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(isStoredTokenEntry).slice(0, MAX_POOL_SIZE - 1).map((entry, index) => ({
        id: String(entry.id),
        label: sanitizeLabel(entry.label, `Token ${index + 2}`),
        enabled: entry.enabled !== false,
      }))
      : []
    return {
      version: 1,
      primaryLabel: sanitizeLabel(parsed.primaryLabel, 'Token 1'),
      primaryEnabled: parsed.primaryEnabled !== false,
      entries,
    }
  } catch {
    return { version: 1, primaryLabel: 'Token 1', primaryEnabled: true, entries: [] }
  }
}

function writeStoredPool(pool: StoredTokenPool): void {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [TOKEN_POOL_SETTING_KEY, JSON.stringify(pool)])
}

function getCredentialKey(id: string): string {
  if (id === PRIMARY_TOKEN_ID) return PRIMARY_CREDENTIAL_KEY
  if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('PaddleOCR Token 标识无效')
  return `${TOKEN_CREDENTIAL_PREFIX}${id}`
}

function getRuntimeFailure(id: string): TokenRuntimeFailure | null {
  const failure = runtimeFailures.get(id)
  if (!failure) return null
  if (Number.isFinite(failure.until) && failure.until <= Date.now()) {
    runtimeFailures.delete(id)
    return null
  }
  return failure
}

function getConfiguredTokens(): Array<{ id: string; label: string; enabled: boolean; primary: boolean; token: string }> {
  const pool = readStoredPool()
  const candidates = [
    {
      id: PRIMARY_TOKEN_ID,
      label: pool.primaryLabel,
      enabled: pool.primaryEnabled,
      primary: true,
      token: readProtectedSetting(PRIMARY_CREDENTIAL_KEY),
    },
    ...pool.entries.map((entry) => ({
      ...entry,
      primary: false,
      token: readProtectedSetting(getCredentialKey(entry.id)),
    })),
  ]
  return candidates.filter((entry) => Boolean(entry.token))
}

function nextDailyQuotaReset(): number {
  const reset = new Date()
  reset.setHours(24, 5, 0, 0)
  return reset.getTime()
}

function failureMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message || error || '').trim()
}

function failureStatus(error: unknown): number {
  const record = error as { status?: unknown; code?: unknown }
  const status = Number(record?.status || 0)
  if (status === 403 || status === 429) return status
  const code = Number(record?.code || 0)
  return code === 403 || code === 429 ? code : status
}

export function isPaddleOcrTokenFailure(error: unknown): boolean {
  const status = failureStatus(error)
  if (status === 403 || status === 429) return true
  const message = failureMessage(error)
  return /(?:quota|credit|balance).*(?:exhaust|insufficient|exceed|limit)|(?:daily|page).*(?:quota|limit).*(?:exceed|reach)|(?:token|access.?token).*(?:invalid|expired|error)|(?:额度|配额|余额|次数).*(?:不足|耗尽|用完|超出|上限)|超出.*(?:解析|页面).*(?:页数|上限)|Token\s*(?:错误|无效|过期)/i.test(message)
}

export function markPaddleOcrTokenFailure(lease: PaddleOcrTokenLease, error: unknown): void {
  if (!isPaddleOcrTokenFailure(error)) return
  const status = failureStatus(error)
  const message = failureMessage(error).split(lease.token).join('[redacted]').slice(0, 240)
    || (status === 429 ? '当日 OCR 额度已用完' : 'Token 无效')
  runtimeFailures.set(lease.id, {
    status: status === 403 || /token.*(?:invalid|expired|error)|Token\s*(?:错误|无效|过期)/i.test(message) ? 'invalid' : 'quota_exhausted',
    until: status === 403 ? Number.POSITIVE_INFINITY : nextDailyQuotaReset(),
    message,
  })
  if (activeTokenId === lease.id) activeTokenId = null
}

export function resetPaddleOcrTokenRuntime(id?: string): void {
  if (id) runtimeFailures.delete(id)
  else runtimeFailures.clear()
  if (id && activeTokenId === id) activeTokenId = null
}

export function acquirePaddleOcrToken(excludedIds: ReadonlySet<string> = new Set()): PaddleOcrTokenLease {
  const configured = getConfiguredTokens()
  const usable = configured.filter((entry) => entry.enabled && !excludedIds.has(entry.id) && !getRuntimeFailure(entry.id))
  if (usable.length === 0) {
    if (configured.length === 0) {
      throw new Error('尚未配置 PaddleOCR API Token，请先到设置页添加 Token。')
    }
    throw new Error('所有可用的 PaddleOCR Token 均已达到当日额度、无效或被停用，请添加新的 Token 后继续。')
  }
  const selected = usable.find((entry) => entry.id === activeTokenId) || usable[0]
  activeTokenId = selected.id
  return { id: selected.id, label: selected.label, token: selected.token }
}

export function getPaddleOcrTokenPoolState(): PaddleOcrTokenPoolState {
  const configured = getConfiguredTokens()
  if (!configured.some((entry) => entry.id === activeTokenId && entry.enabled && !getRuntimeFailure(entry.id))) {
    activeTokenId = configured.find((entry) => entry.enabled && !getRuntimeFailure(entry.id))?.id || null
  }
  const entries: PaddleOcrTokenPoolEntry[] = configured.map((entry) => {
    const credential = getCredentialPublicState(getCredentialKey(entry.id))
    const failure = getRuntimeFailure(entry.id)
    const status: PaddleOcrTokenRuntimeStatus = failure?.status || (entry.id === activeTokenId ? 'active' : 'ready')
    return {
      id: entry.id,
      label: entry.label,
      last4: credential.last4 || entry.token.slice(-4),
      enabled: entry.enabled,
      primary: entry.primary,
      status,
      ...(failure && Number.isFinite(failure.until) ? { unavailableUntil: new Date(failure.until).toISOString() } : {}),
      ...(failure?.message ? { lastError: failure.message } : {}),
    }
  })
  return {
    entries,
    activeTokenId,
    configuredCount: entries.length,
    enabledCount: entries.filter((entry) => entry.enabled).length,
  }
}

export function addPaddleOcrToken(label: string, tokenValue: string): PaddleOcrTokenPoolState {
  const token = String(tokenValue || '').trim()
  if (!token) throw new Error('PaddleOCR API Token 不能为空')
  const configured = getConfiguredTokens()
  if (configured.some((entry) => entry.token === token)) throw new Error('这个 PaddleOCR Token 已经在轮询池中')
  if (configured.length >= MAX_POOL_SIZE) throw new Error(`PaddleOCR Token 最多可添加 ${MAX_POOL_SIZE} 个`)

  const pool = readStoredPool()
  pool.entries = pool.entries.filter((entry) => Boolean(readProtectedSetting(getCredentialKey(entry.id))))
  let addedId = PRIMARY_TOKEN_ID
  if (!readProtectedSetting(PRIMARY_CREDENTIAL_KEY)) {
    writeProtectedSetting(PRIMARY_CREDENTIAL_KEY, token)
    pool.primaryLabel = sanitizeLabel(label, 'Token 1')
    pool.primaryEnabled = true
    writeStoredPool(pool)
    activeTokenId = PRIMARY_TOKEN_ID
  } else {
    const id = randomUUID()
    addedId = id
    writeProtectedSetting(getCredentialKey(id), token)
    pool.entries.push({ id, label: sanitizeLabel(label, `Token ${configured.length + 1}`), enabled: true })
    writeStoredPool(pool)
  }
  resetPaddleOcrTokenRuntime(addedId)
  return getPaddleOcrTokenPoolState()
}

export function removePaddleOcrToken(id: string): PaddleOcrTokenPoolState {
  const pool = readStoredPool()
  if (id === PRIMARY_TOKEN_ID) {
    const replacement = pool.entries.find((entry) => readProtectedSetting(getCredentialKey(entry.id)))
    if (replacement) {
      const replacementToken = readProtectedSetting(getCredentialKey(replacement.id))
      writeProtectedSetting(PRIMARY_CREDENTIAL_KEY, replacementToken)
      revokeProtectedSetting(getCredentialKey(replacement.id))
      pool.primaryLabel = replacement.label
      pool.primaryEnabled = replacement.enabled
      pool.entries = pool.entries.filter((entry) => entry.id !== replacement.id)
    } else {
      revokeProtectedSetting(PRIMARY_CREDENTIAL_KEY)
    }
  } else {
    revokeProtectedSetting(getCredentialKey(id))
    pool.entries = pool.entries.filter((entry) => entry.id !== id)
  }
  writeStoredPool(pool)
  resetPaddleOcrTokenRuntime(id)
  activeTokenId = null
  return getPaddleOcrTokenPoolState()
}

export function setPaddleOcrTokenEnabled(id: string, enabled: boolean): PaddleOcrTokenPoolState {
  const pool = readStoredPool()
  if (id === PRIMARY_TOKEN_ID) {
    pool.primaryEnabled = Boolean(enabled)
  } else {
    const entry = pool.entries.find((item) => item.id === id)
    if (!entry) throw new Error('未找到 PaddleOCR Token')
    entry.enabled = Boolean(enabled)
  }
  writeStoredPool(pool)
  resetPaddleOcrTokenRuntime(id)
  if (!enabled && activeTokenId === id) activeTokenId = null
  return getPaddleOcrTokenPoolState()
}
