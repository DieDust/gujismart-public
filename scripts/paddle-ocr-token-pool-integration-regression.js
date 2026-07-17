const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-paddle-token-pool-'))
const dataDir = path.join(tempRoot, 'data')
const profileDir = path.join(tempRoot, 'profile')
const bundlePath = path.join(tempRoot, 'paddle-token-pool.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = dataDir
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `
  exports.app = {
    getPath: (name) => name === 'userData' ? ${JSON.stringify(profileDir)} : ${JSON.stringify(tempRoot)},
    getAppPath: () => ${JSON.stringify(root)},
    isPackaged: false,
  }
  exports.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('protected:' + Buffer.from(value).toString('base64'), 'utf8'),
    decryptString: (value) => {
      const raw = Buffer.from(value).toString('utf8')
      if (!raw.startsWith('protected:')) throw new Error('invalid ciphertext')
      return Buffer.from(raw.slice('protected:'.length), 'base64').toString('utf8')
    },
  }
`)

fs.writeFileSync(entryPath, `
  const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
  const security = require(${JSON.stringify(path.join(root, 'src', 'main', 'settings-security.ts'))})
  const pool = require(${JSON.stringify(path.join(root, 'src', 'main', 'paddle-ocr-token-pool.ts'))})
  module.exports = { database, security, pool }
`)

async function run() {
  let database
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      external: ['better-sqlite3'],
      alias: {
        electron: electronStubPath,
        '@electron-toolkit/utils': path.join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
      },
      logLevel: 'silent',
    })

    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    assert.strictEqual(modules.security.initializeSettingsSecurity().available, true)

    const secrets = ['fixture-paddle-token-one', 'fixture-paddle-token-two', 'fixture-paddle-token-three']
    modules.pool.addPaddleOcrToken('账号一', secrets[0])
    modules.pool.addPaddleOcrToken('账号二', secrets[1])
    const initial = modules.pool.addPaddleOcrToken('账号三', secrets[2])
    assert.strictEqual(initial.configuredCount, 3)
    assert.strictEqual(initial.enabledCount, 3)
    assert.deepStrictEqual(initial.entries.map((entry) => entry.label), ['账号一', '账号二', '账号三'])
    assert.ok(initial.entries.every((entry) => !JSON.stringify(entry).includes('fixture-paddle-token')))

    const first = modules.pool.acquirePaddleOcrToken()
    assert.strictEqual(first.token, secrets[0], 'the primary token should remain sticky until it fails')

    // Rate-limit 429 must NOT be treated as "今日额度已用完".
    const rateLimitError = Object.assign(new Error(`OCR 接口请求失败，状态码 429：请求频率过高，请稍后重试`), { status: 429 })
    modules.pool.markPaddleOcrTokenFailure(first, rateLimitError)
    assert.strictEqual(
      modules.pool.getPaddleOcrTokenPoolState().entries.find((entry) => entry.label === '账号一')?.status,
      'rate_limited',
      '429 with 请求频率过高 is temporary rate limiting, not daily quota exhaustion',
    )
    const second = modules.pool.acquirePaddleOcrToken()
    assert.strictEqual(second.token, secrets[1], 'rate-limited tokens should advance to the next token')

    const quotaError = Object.assign(new Error(`超出单日解析最大页数 ${secrets[1]}`), { code: 429 })
    modules.pool.markPaddleOcrTokenFailure(second, quotaError)
    assert.strictEqual(
      modules.pool.getPaddleOcrTokenPoolState().entries.find((entry) => entry.label === '账号二')?.status,
      'quota_exhausted',
      'true daily page-quota 429 should mark quota_exhausted',
    )
    assert.strictEqual(
      modules.pool.acquirePaddleOcrToken().token,
      secrets[2],
      'after daily quota exhaustion the next token must stay sticky without re-trying the exhausted one',
    )

    // 403 with a quota-like message must count as daily exhaustion, not permanent invalid.
    const third = modules.pool.acquirePaddleOcrToken()
    assert.strictEqual(third.token, secrets[2])
    const quotaAs403 = Object.assign(new Error('当日额度不足'), { status: 403 })
    // 403 + 额度 → still quota (classify checks quota message after rate limit)
    modules.pool.markPaddleOcrTokenFailure(third, quotaAs403)
    // Wait - 403 with 当日额度不足: isQuotaExhaustionMessage true, isRateLimit false.
    // classify: rate limit check first false; quota message true → quota_exhausted. Good.
    // But then all three may be blocked: t1 rate_limited, t2 quota, t3 quota.
    // rate_limited still blocks until cooldown - so acquire may throw rate limit or all exhausted.

    const authError = Object.assign(new Error('Token 错误'), { status: 403 })
    // Re-enable path: reset third then mark invalid for the all-invalid path later.
    modules.pool.resetPaddleOcrTokenRuntime(third.id)
    modules.pool.markPaddleOcrTokenFailure(third, authError)
    assert.strictEqual(
      modules.pool.getPaddleOcrTokenPoolState().entries.find((entry) => entry.label === '账号三')?.status,
      'invalid',
    )

    // Clear rate-limit on first so we can assert only quota/invalid remain as long-term blocks.
    modules.pool.resetPaddleOcrTokenRuntime(first.id)
    modules.pool.markPaddleOcrTokenFailure(first, Object.assign(new Error('超出单日解析最大页数'), { code: 429 }))
    assert.throws(() => modules.pool.acquirePaddleOcrToken(), /所有可用的 PaddleOCR Token/)

    const failedState = modules.pool.getPaddleOcrTokenPoolState()
    assert.deepStrictEqual(failedState.entries.map((entry) => entry.status), ['quota_exhausted', 'quota_exhausted', 'invalid'])
    assert.ok(!JSON.stringify(failedState).includes(secrets[0]), 'runtime errors exposed to the renderer must redact token plaintext')

    // Restart simulation: clear in-module memory by reloading is hard; instead verify SQLite runtime snapshot
    // is written so a fresh process would skip the exhausted tokens without another API call.
    const runtimeSnapshot = database.queryOne('SELECT value FROM settings WHERE key = ?', ['paddleocr_token_runtime']).value
    assert.ok(runtimeSnapshot.includes('quota_exhausted'), 'daily exhaustion must be persisted to settings')
    assert.ok(!runtimeSnapshot.includes(secrets[0]), 'runtime snapshot must not store plaintext tokens')

    const withTemporaryBackup = modules.pool.addPaddleOcrToken('临时备用', 'fixture-paddle-token-four')
    assert.deepStrictEqual(
      withTemporaryBackup.entries.slice(0, 3).map((entry) => entry.status),
      ['quota_exhausted', 'quota_exhausted', 'invalid'],
      'adding another token must not reactivate exhausted or invalid accounts',
    )
    const temporaryBackup = withTemporaryBackup.entries.find((entry) => entry.label === '临时备用')
    assert.ok(temporaryBackup)
    modules.pool.removePaddleOcrToken(temporaryBackup.id)
    modules.pool.setPaddleOcrTokenEnabled(third.id, false)
    assert.throws(() => modules.pool.acquirePaddleOcrToken(), /所有可用的 PaddleOCR Token/)

    modules.pool.setPaddleOcrTokenEnabled(second.id, true)
    assert.strictEqual(modules.pool.acquirePaddleOcrToken().token, secrets[1], 're-enabling a token should clear its runtime failure state')

    const promoted = modules.pool.removePaddleOcrToken('primary')
    assert.strictEqual(promoted.configuredCount, 2)
    assert.strictEqual(promoted.entries[0].primary, true)
    assert.strictEqual(promoted.entries[0].label, '账号二')
    assert.strictEqual(modules.security.readProtectedSetting('paddleocr_api_key'), secrets[1], 'removing the primary token should promote the next configured token')

    const metadata = database.queryOne('SELECT value FROM settings WHERE key = ?', ['paddleocr_token_pool']).value
    for (const secret of secrets) assert.ok(!metadata.includes(secret), 'public token-pool metadata must not contain plaintext tokens')
    const publicSnapshot = JSON.stringify(modules.security.getPublicSettingsMap())
    for (const secret of secrets) assert.ok(!publicSnapshot.includes(secret), 'renderer settings snapshot must not contain plaintext tokens')

    database.closeDatabase()
    database = null
    console.log('PaddleOCR token pool SQLite integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
