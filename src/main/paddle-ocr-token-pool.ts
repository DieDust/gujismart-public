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
const TOKEN_RUNTIME_SETTING_KEY = 'paddleocr_token_runtime'
const TOKEN_CREDENTIAL_PREFIX = 'paddleocr_token:'
const MAX_POOL_SIZE = 32
/** Short cool-down after HTTP 429 "too many requests" — not the same as daily page quota. */
const RATE_LIMIT_COOLDOWN_MS = 90_000

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

interface StoredTokenRuntime {
  version: 1
  activeTokenId: string | null
  failures: Record<string, {
    status: Exclude<PaddleOcrTokenRuntimeStatus, 'active' | 'ready'>
    until: number | null
    message: string
  }>
}

export interface PaddleOcrTokenLease {
  id: string
  label: string
  token: string
}

const runtimeFailures = new Map<string, TokenRuntimeFailure>()
let activeTokenId: string | null = null
let runtimeHydrated = false

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

/** Next local-calendar day shortly after midnight — skip exhausted tokens for the rest of today. */
export function nextDailyQuotaReset(nowMs = Date.now()): number {
  const reset = new Date(nowMs)
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

/**
 * True daily page/credit quota — skip the token until the next local day.
 * Do NOT include "rate limit / too many requests" here; those are temporary.
 */
function isQuotaExhaustionMessage(message: string): boolean {
  return /(?:quota|credit|balance).*(?:exhaust|insufficient|exceed)|(?:daily|page).*(?:quota|limit).*(?:exceed|reach)|(?:额度|配额|余额|次数|页数).*(?:不足|耗尽|用完|超出|上限)|超出.*(?:解析|页面|单日).*(?:页数|上限|额度)|单日.*(?:页|额度)|当日.*额度|今日.*额度|日限额|已达.*(?:解析|页数).*上限/i.test(message)
}

/**
 * The hosted async API uses code 10010 / HTTP 400 when its shared submission
 * queue is full. This is provider backpressure, not a failure of any Token.
 */
function isProviderQueueBusyMessage(message: string): boolean {
  return /(?:任务)?提交队列已满|任务队列已满|submission\s+queue|queue\s*(?:is\s*)?full|queue\s+capacity|\b10010\b/i.test(message)
}

/** Provider throttling — short cool-down only; token still has daily quota. */
function isRateLimitMessage(message: string): boolean {
  return /请求频率|频率过高|请求过快|限流|rate.?limit|too many requests|throttl|并发.*过高/i.test(message)
}

function isInvalidTokenMessage(message: string): boolean {
  return /(?:token|access.?token|api.?key).*(?:invalid|expired|error|denied|unauthorized)|Token\s*(?:错误|无效|过期)|认证失败|鉴权失败|unauthorized|forbidden/i.test(message)
}

function classifyTokenFailure(error: unknown, redactSecret = ''): {
  status: Exclude<PaddleOcrTokenRuntimeStatus, 'active' | 'ready'>
  until: number
  message: string
} {
  const httpStatus = failureStatus(error)
  const rawMessage = failureMessage(error)
  const message = (redactSecret
    ? rawMessage.split(redactSecret).join('[redacted]')
    : rawMessage
  ).slice(0, 240)

  // Prefer explicit quota wording even when HTTP status is 429.
  if (isQuotaExhaustionMessage(message)) {
    return {
      status: 'quota_exhausted',
      until: nextDailyQuotaReset(),
      message: message || '当日 OCR 额度已用完',
    }
  }
  // "429 请求频率过高" is temporary throttling, not daily page quota.
  if (isRateLimitMessage(message) || httpStatus === 429) {
    return {
      status: 'rate_limited',
      until: Date.now() + RATE_LIMIT_COOLDOWN_MS,
      message: message || '请求频率过高，请稍后再试',
    }
  }
  if (httpStatus === 403 || isInvalidTokenMessage(message)) {
    return {
      status: 'invalid',
      until: Number.POSITIVE_INFINITY,
      message: message || 'Token 无效',
    }
  }
  return {
    status: 'invalid',
    until: Number.POSITIVE_INFINITY,
    message: message || 'Token 不可用',
  }
}

function persistRuntimeState(): void {
  const failures: StoredTokenRuntime['failures'] = {}
  runtimeFailures.forEach((failure, id) => {
    failures[id] = {
      status: failure.status,
      // Infinity is not JSON-safe; null means permanent (invalid token).
      until: Number.isFinite(failure.until) ? failure.until : null,
      message: failure.message,
    }
  })
  const payload: StoredTokenRuntime = {
    version: 1,
    activeTokenId,
    failures,
  }
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [TOKEN_RUNTIME_SETTING_KEY, JSON.stringify(payload)])
}

function hydrateRuntimeState(): void {
  if (runtimeHydrated) return
  runtimeHydrated = true
  const row = queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [TOKEN_RUNTIME_SETTING_KEY])
  try {
    const parsed = JSON.parse(String(row?.value || '')) as Partial<StoredTokenRuntime>
    const now = Date.now()
    const failures = parsed.failures && typeof parsed.failures === 'object' ? parsed.failures : {}
    Object.entries(failures).forEach(([id, raw]) => {
      if (!raw || typeof raw !== 'object') return
      const message = String(raw.message || '').slice(0, 240)
      // Repair a previous bug: rate-limit 429s were persisted as "今日额度已用完".
      let status: Exclude<PaddleOcrTokenRuntimeStatus, 'active' | 'ready'> =
        raw.status === 'invalid'
          ? 'invalid'
          : raw.status === 'rate_limited'
            ? 'rate_limited'
            : 'quota_exhausted'
      if (isProviderQueueBusyMessage(message)) {
        // Older builds treated "queue full, retry later" as Token throttling.
        // Drop that false Token block immediately after upgrading.
        return
      }
      if (status === 'quota_exhausted' && isRateLimitMessage(message)) {
        // Drop the false daily ban so the token can be used again immediately after upgrade.
        return
      }
      const until = raw.until == null
        ? (status === 'invalid' ? Number.POSITIVE_INFINITY : now + RATE_LIMIT_COOLDOWN_MS)
        : Number(raw.until)
      if (!Number.isFinite(until) && status !== 'invalid') return
      if (Number.isFinite(until) && until <= now) return
      runtimeFailures.set(id, {
        status,
        until: status === 'invalid' && !Number.isFinite(until) ? Number.POSITIVE_INFINITY : until,
        message,
      })
    })
    const candidate = String(parsed.activeTokenId || '').trim()
    activeTokenId = candidate || null
  } catch {
    // Ignore corrupt runtime snapshots; in-memory pool starts empty.
  }
}

function getRuntimeFailure(id: string): TokenRuntimeFailure | null {
  hydrateRuntimeState()
  const failure = runtimeFailures.get(id)
  if (!failure) return null
  if (Number.isFinite(failure.until) && failure.until <= Date.now()) {
    runtimeFailures.delete(id)
    persistRuntimeState()
    return null
  }
  return failure
}

function getConfiguredTokens(): Array<{ id: string; label: string; enabled: boolean; primary: boolean; token: string }> {
  hydrateRuntimeState()
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

function listUsableTokens(excludedIds: ReadonlySet<string> = new Set()) {
  return getConfiguredTokens().filter((entry) => (
    entry.enabled
    && !excludedIds.has(entry.id)
    && !getRuntimeFailure(entry.id)
  ))
}

function preferNextActiveToken(excludedIds: ReadonlySet<string> = new Set()): void {
  const usable = listUsableTokens(excludedIds)
  if (usable.some((entry) => entry.id === activeTokenId)) return
  activeTokenId = usable[0]?.id || null
}

export function isPaddleOcrTokenFailure(error: unknown): boolean {
  const status = failureStatus(error)
  const code = Number((error as { code?: unknown })?.code || 0)
  const message = failureMessage(error)
  if (isProviderQueueBusyMessage(message)) return false
  if (code === 10010) return false
  if (status === 403 || status === 429) return true
  return isQuotaExhaustionMessage(message) || isRateLimitMessage(message) || isInvalidTokenMessage(message)
}

export function markPaddleOcrTokenFailure(lease: PaddleOcrTokenLease, error: unknown): void {
  if (!isPaddleOcrTokenFailure(error)) return
  hydrateRuntimeState()
  const classified = classifyTokenFailure(error, lease.token)
  const message = classified.message

  runtimeFailures.set(lease.id, {
    status: classified.status,
    until: classified.until,
    message,
  })

  // Leave this token temporarily so concurrent workers try another one (or cool down).
  if (activeTokenId === lease.id || !activeTokenId) {
    preferNextActiveToken(new Set([lease.id]))
  }
  persistRuntimeState()
}

export function resetPaddleOcrTokenRuntime(id?: string): void {
  hydrateRuntimeState()
  if (id) runtimeFailures.delete(id)
  else runtimeFailures.clear()
  if (id && activeTokenId === id) activeTokenId = null
  if (!id) activeTokenId = null
  preferNextActiveToken()
  persistRuntimeState()
}

/**
 * Acquire the sticky active token when still usable.
 * - quota_exhausted: skipped until nextDailyQuotaReset()
 * - rate_limited: skipped only for a short cool-down (not the whole day)
 * - invalid: skipped until the user re-enables/replaces the token
 */
export function acquirePaddleOcrToken(excludedIds: ReadonlySet<string> = new Set()): PaddleOcrTokenLease {
  hydrateRuntimeState()
  const configured = getConfiguredTokens()
  const usable = listUsableTokens(excludedIds)
  if (usable.length === 0) {
    if (configured.length === 0) {
      throw new Error('尚未配置 PaddleOCR API Token，请先到设置页添加 Token。')
    }
    const enabled = configured.filter((entry) => entry.enabled && !excludedIds.has(entry.id))
    const failures = enabled.map((entry) => getRuntimeFailure(entry.id)).filter(Boolean) as TokenRuntimeFailure[]
    const allRateLimited = failures.length > 0 && failures.every((failure) => failure.status === 'rate_limited')
    if (allRateLimited) {
      const waitMs = Math.max(0, ...failures.map((failure) => failure.until - Date.now()))
      const waitSec = Math.max(1, Math.ceil(waitMs / 1000))
      throw new Error(`PaddleOCR 请求过于频繁（限流），约 ${waitSec} 秒后可自动恢复。可降低 OCR 并发或稍后再试；这不是当日额度用完。`)
    }
    throw new Error('所有可用的 PaddleOCR Token 均已达到当日额度、无效或被停用，请添加新的 Token 后继续。')
  }
  const selected = usable.find((entry) => entry.id === activeTokenId) || usable[0]
  if (activeTokenId !== selected.id) {
    activeTokenId = selected.id
    persistRuntimeState()
  }
  return { id: selected.id, label: selected.label, token: selected.token }
}

export function getPaddleOcrTokenPoolState(): PaddleOcrTokenPoolState {
  hydrateRuntimeState()
  const configured = getConfiguredTokens()
  if (!configured.some((entry) => entry.id === activeTokenId && entry.enabled && !getRuntimeFailure(entry.id))) {
    preferNextActiveToken()
    persistRuntimeState()
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
  preferNextActiveToken()
  persistRuntimeState()
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
  // Re-enable clears runtime blocks so the user can force-retry after topping up quota.
  resetPaddleOcrTokenRuntime(id)
  if (!enabled && activeTokenId === id) activeTokenId = null
  preferNextActiveToken()
  persistRuntimeState()
  return getPaddleOcrTokenPoolState()
}
