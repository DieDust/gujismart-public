const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const settingsIpc = read('src/main/ipc/settings.ts')
const mainIndex = read('src/main/index.ts')
const backup = read('src/main/backup.ts')
const sharedTypes = read('src/shared/types.ts')
const settingsView = read('src/renderer/src/views/SettingsView.tsx')
const onboarding = read('src/renderer/src/components/OnboardingWizard.tsx')
const appView = read('src/renderer/src/App.tsx')
const paddleTokenPool = read('src/main/paddle-ocr-token-pool.ts')

assert.ok(mainIndex.includes('initializeSettingsSecurity'), 'main startup must initialize credential migration before IPC registration')
assert.ok(settingsIpc.includes('getRendererSettingsSnapshot'), 'settings IPC must build a redacted renderer snapshot')
assert.ok(settingsIpc.includes('isProtectedSettingKey'), 'generic setting handlers must recognize protected keys')
assert.ok(settingsIpc.includes('readProtectedSetting'), 'main-only settings consumers must use the protected reader')
assert.ok(settingsIpc.includes("settings:credential:prepare"), 'settings IPC must expose a dedicated one-time credential draft channel')
assert.ok(settingsIpc.includes('consumeCredentialDraft'), 'settings IPC must consume credential drafts in main')
assert.ok(settingsIpc.includes('protected_setting_requires_credential_api'), 'generic settings:set must reject protected keys')
assert.ok(!settingsIpc.includes('payload?.apiKey'), 'model listing IPC must not accept raw apiKey payloads')
assert.ok(!settingsIpc.includes('profile?.apiKey'), 'profile IPC must not accept raw apiKey fields')
assert.ok(!settingsIpc.includes("SELECT value FROM settings WHERE key = 'llm_api_key'"), 'settings IPC must not query plaintext LLM keys')

for (const relativePath of [
  'src/main/ai.ts',
  'src/main/metadata-reclassifier.ts',
  'src/main/ocr.ts',
  'src/main/ipc/ocr.ts',
  'src/main/vision-ocr.ts',
]) {
  const source = read(relativePath)
  assert.ok(!/SELECT\s+value\s+FROM\s+settings[^\n]+(?:llm|vision_ocr|paddleocr)_api_key/i.test(source), `${relativePath} must not read protected credentials with SQL`)
  const delegatesToSecurePaddlePool = relativePath === 'src/main/ocr.ts'
    && source.includes("from './paddle-ocr-token-pool'")
    && paddleTokenPool.includes('readProtectedSetting')
  assert.ok(source.includes('readProtectedSetting') || delegatesToSecurePaddlePool, `${relativePath} must use the main-only credential reader or the secure Paddle token pool`)
}

assert.ok(backup.includes('credentialsExcluded: true'), 'backup manifest must declare that credentials are excluded')
assert.ok(backup.includes('credentialRequiredAfterRestore'), 'backup manifest must declare post-restore credential requirements')
assert.ok(sharedTypes.includes('credential?: CredentialPublicState'), 'provider profiles must expose only credential public state')
assert.ok(!sharedTypes.includes('apiKey: string\n  model:'), 'provider profile apiKey must not be a required renderer-facing field')

for (const [name, source] of [['SettingsView', settingsView], ['OnboardingWizard', onboarding], ['App', appView]]) {
  assert.ok(!/settings\.(?:llm|vision_ocr|paddleocr)_api_key\b/.test(source), `${name} must not expect saved plaintext credentials`)
}
assert.ok(!settingsView.includes('profile.apiKey'), 'settings profile selection must not refill a saved secret')
const preload = read('src/preload/index.ts')
assert.ok(preload.includes("ipcRenderer.invoke('settings:credential:prepare'"), 'preload must exchange transient renderer drafts for opaque refs')
assert.ok(preload.includes("ipcRenderer.invoke('settings:credential:commit'"), 'preload must commit credentials through the dedicated channel')

console.log('Settings security boundary regression checks passed.')
