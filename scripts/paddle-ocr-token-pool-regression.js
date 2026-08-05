const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const pool = read('src/main/paddle-ocr-token-pool.ts')
const ocr = read('src/main/ocr.ts')
const settings = read('src/main/ipc/settings.ts')
const preload = read('src/preload/index.ts')
const view = read('src/renderer/src/views/SettingsView.tsx')
const sharedTypes = read('src/shared/types.ts')

assert.ok(pool.includes("const PRIMARY_CREDENTIAL_KEY = 'paddleocr_api_key'"), 'the existing single Paddle token must remain the compatible primary credential')
assert.ok(pool.includes("const TOKEN_CREDENTIAL_PREFIX = 'paddleocr_token:'"), 'additional tokens must use isolated vault keys')
assert.ok(pool.includes("const TOKEN_RUNTIME_SETTING_KEY = 'paddleocr_token_runtime'"), 'daily quota exhaustion must persist across restarts')
assert.ok(pool.includes('readProtectedSetting(getCredentialKey(entry.id))'), 'pool tokens must only be read in the main process')
assert.ok(pool.includes('writeProtectedSetting(getCredentialKey(id), token)'), 'additional tokens must be written through secure storage')
assert.ok(!pool.includes('token: entry.token'), 'token plaintext must never be placed in public pool metadata')
assert.ok(pool.includes('status === 403 || status === 429'), '403 and official daily-quota 429 responses must trigger token failover')
assert.ok(pool.includes('isQuotaExhaustionMessage') && pool.includes("'quota_exhausted'"), 'runtime state must distinguish invalid and quota-exhausted tokens')
assert.ok(pool.includes('isRateLimitMessage') && pool.includes("'rate_limited'"), 'rate-limit 429 must not be labeled as daily quota exhaustion')
assert.ok(pool.includes('isProviderQueueBusyMessage'), 'provider queue backpressure must have a separate classifier')
assert.ok(pool.includes('if (isProviderQueueBusyMessage(message)) return false'), 'queue-full responses must never fail over or cool down a Token')
assert.ok(pool.includes('请求频率过高') || pool.includes('RATE_LIMIT_COOLDOWN_MS'), 'rate-limit cool-down should be short-lived')
assert.ok(pool.includes('nextDailyQuotaReset()'), 'quota-exhausted tokens must remain skipped until the next daily reset')
assert.ok(pool.includes('persistRuntimeState') && pool.includes('hydrateRuntimeState'), 'quota exhaustion must survive app restarts without retrying the same token today')
assert.ok(pool.includes('activeTokenId') && pool.includes('usable.find((entry) => entry.id === activeTokenId)'), 'the active token must stay sticky until it fails')
assert.ok(pool.includes('preferNextActiveToken'), 'marking a token exhausted must immediately point concurrent workers at the next usable token')
assert.ok(pool.includes('这不是当日额度用完'), 'user-facing rate-limit errors must explain they are not daily quota exhaustion')

assert.ok(ocr.includes('const ASYNC_PDF_MAX_PAGES_PER_JOB = 100'), 'hosted Paddle PDF jobs must respect the official 100-page limit')
assert.ok(ocr.includes('markPaddleOcrTokenFailure(lease, error)'), 'single-page OCR must mark and switch failed tokens')
assert.ok(ocr.includes('markPaddleOcrTokenFailure(submission.lease, error)'), 'async PDF polling failures must switch tokens')
assert.ok(ocr.includes('excludedTokenIds.add(submission.lease.id)'), 'a failed PDF chunk must not retry the same exhausted token')
assert.ok(ocr.includes('只重试第 ${chunkStartPage}-${chunkEndPage} 页'), 'the user-facing progress message must explain failed-chunk-only retry')
assert.ok(ocr.includes('await runChunkCompleteCallbackSerially'), 'successful PDF chunks must continue to be persisted independently')

for (const channel of [
  'settings:paddleOcrTokens:list',
  'settings:paddleOcrTokens:add',
  'settings:paddleOcrTokens:remove',
  'settings:paddleOcrTokens:setEnabled',
]) {
  assert.ok(settings.includes(channel), `settings main process must register ${channel}`)
  assert.ok(preload.includes(channel), `preload must expose ${channel}`)
}
assert.ok(preload.includes("prepareCredentialDraft('paddleocr_api_key', apiKey)"), 'new Paddle tokens must cross IPC as one-time credential drafts')
assert.ok(view.includes('支持多 Token 自动接力'), 'settings UI must explain token failover')
assert.ok(view.includes('window.api.addPaddleOcrToken'), 'settings UI must let users add pool tokens')
assert.ok(view.includes('window.api.removePaddleOcrToken'), 'settings UI must let users remove pool tokens')
assert.ok(view.includes('window.api.setPaddleOcrTokenEnabled'), 'settings UI must let users enable and disable pool tokens')
assert.ok(sharedTypes.includes('export interface PaddleOcrTokenPoolState'), 'the shared main/preload/renderer contract must include token pool state')

console.log('PaddleOCR token pool regression checks passed.')
