const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-protected-settings-'))
const bundlePath = path.join(tempRoot, 'protected-settings.cjs')

function memoryRepository(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, String(value)),
    delete: (key) => values.delete(key),
    entries: () => [...values.entries()].map(([key, value]) => ({ key, value })),
    snapshot: () => Object.fromEntries(values),
  }
}

function memoryVault() {
  const values = new Map()
  const versions = new Map()
  return {
    put(logicalKey, value) {
      const version = (versions.get(logicalKey) || 0) + 1
      values.set(logicalKey, value)
      versions.set(logicalKey, version)
      return { logicalKey, version, last4: value.slice(-4), state: 'active' }
    },
    read: (logicalKey) => values.get(logicalKey) ?? null,
    revoke: (logicalKey) => values.delete(logicalKey),
    getPublicState(logicalKey) {
      const value = values.get(logicalKey)
      return value
        ? { configured: true, last4: value.slice(-4), version: versions.get(logicalKey), state: 'active' }
        : { configured: false, version: versions.get(logicalKey) || 0, state: 'missing' }
    },
  }
}

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'protected-settings.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const {
    PROTECTED_SETTING_KEYS,
    ProtectedSettingsService,
    getRendererSettingsSnapshot,
    migrateLegacyProviderProfiles,
  } = require(bundlePath)

  assert.deepStrictEqual([...PROTECTED_SETTING_KEYS].sort(), [
    'llm_api_key',
    'paddleocr_api_key',
    'vision_ocr_api_key',
  ])

  const legacyLlmSecret = ['legacy', 'llm', 'secret'].join('-')
  const legacyPaddleSecret = ['legacy', 'paddle', 'secret'].join('-')
  const legacyVisionSecret = ['legacy', 'vision', 'secret'].join('-')
  const repository = memoryRepository({
    theme: 'dark',
    llm_api_key: legacyLlmSecret,
    paddleocr_api_key: legacyPaddleSecret,
    vision_ocr_api_key: legacyVisionSecret,
  })
  const vault = memoryVault()
  const service = new ProtectedSettingsService({ repository, vault })
  const migration = service.migrateLegacyProtectedSettings()
  assert.deepStrictEqual(migration.migratedKeys.sort(), [...PROTECTED_SETTING_KEYS].sort())
  assert.strictEqual(repository.get('llm_api_key'), null, 'plaintext row must be removed after verified activation')
  assert.strictEqual(service.readSecret('llm_api_key'), legacyLlmSecret)

  const snapshot = getRendererSettingsSnapshot(repository.entries(), service)
  assert.strictEqual(snapshot.theme, 'dark')
  for (const key of PROTECTED_SETTING_KEYS) {
    assert.ok(!(key in snapshot), `${key} must not be returned to renderer`)
    assert.strictEqual(snapshot[`${key}_configured`], 'true')
    assert.strictEqual(snapshot[`${key}_last4`].length, 4)
    assert.ok(!JSON.stringify(snapshot).includes(service.readSecret(key)))
  }

  service.writeSecret('llm_api_key', 'new-llm-secret')
  assert.strictEqual(service.readSecret('llm_api_key'), 'new-llm-secret')
  service.revokeSecret('llm_api_key')
  assert.strictEqual(service.readSecret('llm_api_key'), null)
  assert.strictEqual(service.getPublicState('llm_api_key').configured, false)

  const profiles = migrateLegacyProviderProfiles(
    'llm',
    JSON.stringify([
      { id: 'deepseek', name: 'DeepSeek', provider: 'DeepSeek', baseUrl: 'https://api.example/v1', apiKey: 'profile-secret', model: 'chat' },
    ]),
    service,
  )
  assert.strictEqual(profiles.changed, true)
  assert.ok(!profiles.serialized.includes('profile-secret'))
  assert.strictEqual(service.readSecret('llm_profile:deepseek'), 'profile-secret')
  assert.deepStrictEqual(profiles.publicProfiles[0].credential, {
    configured: true,
    last4: 'cret',
    version: 1,
    state: 'active',
  })
  assert.ok(!('apiKey' in profiles.publicProfiles[0]), 'public profile must not contain apiKey')

  console.log('Protected settings regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
