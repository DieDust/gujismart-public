const assert = require('assert')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-credential-vault-'))
const bundlePath = path.join(tempRoot, 'credential-vault.cjs')

function mockCrypto(available = true) {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decrypt: (value) => {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('encrypted:')) throw new Error('ciphertext damaged')
      return text.slice('encrypted:'.length)
    },
  }
}

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'credential-vault.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const { CredentialVault, CredentialVaultError } = require(bundlePath)
  const vaultDir = path.join(tempRoot, 'secrets')
  const vault = new CredentialVault({ rootDir: vaultDir, crypto: mockCrypto() })

  const first = vault.put('llm_api_key', 'sk-first-secret')
  assert.strictEqual(first.logicalKey, 'llm_api_key')
  assert.strictEqual(first.version, 1)
  assert.strictEqual(first.last4, 'cret')
  assert.strictEqual(vault.read('llm_api_key'), 'sk-first-secret')
  assert.deepStrictEqual(vault.getPublicState('llm_api_key'), {
    configured: true,
    last4: 'cret',
    version: 1,
    state: 'active',
  })

  const sidecarPath = path.join(vaultDir, 'credentials.v1.json')
  assert.ok(existsSync(sidecarPath), 'credential vault should persist a versioned sidecar')
  const persisted = readFileSync(sidecarPath, 'utf8')
  assert.ok(!persisted.includes('sk-first-secret'), 'sidecar must never contain plaintext credentials')

  const second = vault.put('llm_api_key', 'sk-replacement')
  assert.strictEqual(second.version, 2)
  assert.strictEqual(vault.read('llm_api_key'), 'sk-replacement')
  assert.ok(!readFileSync(sidecarPath, 'utf8').includes('sk-replacement'))

  const reloaded = new CredentialVault({ rootDir: vaultDir, crypto: mockCrypto() })
  assert.strictEqual(reloaded.read('llm_api_key'), 'sk-replacement', 'vault should survive process restart')
  assert.strictEqual(reloaded.revoke('llm_api_key'), true)
  assert.strictEqual(reloaded.read('llm_api_key'), null)
  assert.strictEqual(reloaded.getPublicState('llm_api_key').configured, false)
  reloaded.put('paddleocr_api_key', 'paddle-secret')
  reloaded.put('vision_ocr_api_key', 'vision-secret')
  assert.strictEqual(reloaded.revokeAll(), 2)
  assert.strictEqual(reloaded.getPublicState('paddleocr_api_key').configured, false)
  assert.strictEqual(reloaded.getPublicState('vision_ocr_api_key').configured, false)

  const unavailable = new CredentialVault({ rootDir: path.join(tempRoot, 'unavailable'), crypto: mockCrypto(false) })
  assert.throws(
    () => unavailable.put('paddleocr_api_key', 'token'),
    (error) => error instanceof CredentialVaultError && error.code === 'credential_vault_unavailable',
  )

  const mismatchDir = path.join(tempRoot, 'mismatch')
  const mismatch = new CredentialVault({
    rootDir: mismatchDir,
    crypto: {
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: () => 'different-value',
    },
  })
  assert.throws(
    () => mismatch.put('llm_api_key', 'must-not-activate'),
    (error) => error instanceof CredentialVaultError && error.code === 'credential_vault_write_failed',
  )
  assert.strictEqual(mismatch.getPublicState('llm_api_key').configured, false, 'failed verification must not activate an entry')
  assert.ok(!existsSync(path.join(mismatchDir, 'credentials.v1.json')), 'failed verification must not replace the sidecar')

  const damagedDir = path.join(tempRoot, 'damaged')
  const damaged = new CredentialVault({ rootDir: damagedDir, crypto: mockCrypto() })
  damaged.put('vision_ocr_api_key', 'vision-secret')
  const damagedPath = path.join(damagedDir, 'credentials.v1.json')
  const damagedPayload = JSON.parse(readFileSync(damagedPath, 'utf8'))
  damagedPayload.entries.vision_ocr_api_key.ciphertext = Buffer.from('broken').toString('base64')
  writeFileSync(damagedPath, JSON.stringify(damagedPayload, null, 2), 'utf8')
  const damagedReload = new CredentialVault({ rootDir: damagedDir, crypto: mockCrypto() })
  assert.throws(
    () => damagedReload.read('vision_ocr_api_key'),
    (error) => error instanceof CredentialVaultError && error.code === 'credential_vault_corrupt',
  )
  assert.strictEqual(damagedReload.getPublicState('vision_ocr_api_key').state, 'corrupt')

  console.log('Credential vault regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
