const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-credential-draft-'))
const bundlePath = path.join(tempRoot, 'credential-drafts.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'credential-drafts.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const { CredentialDraftRegistry, CredentialDraftError } = require(bundlePath)
  let now = 1_000
  let sequence = 0
  const registry = new CredentialDraftRegistry({
    now: () => now,
    createId: () => `draft-${++sequence}`,
    ttlMs: 300_000,
    maxActive: 4,
  })
  const ref = registry.prepare({ ownerId: 7, key: 'llm_api_key', value: 'draft-secret' })
  assert.deepStrictEqual(ref, { draftRef: 'draft-1', expiresAt: 301_000 })
  assert.throws(
    () => registry.consume({ draftRef: ref.draftRef, ownerId: 8, key: 'llm_api_key' }),
    (error) => error instanceof CredentialDraftError && error.code === 'credential_draft_owner_mismatch',
  )
  assert.throws(
    () => registry.consume({ draftRef: ref.draftRef, ownerId: 7, key: 'vision_ocr_api_key' }),
    (error) => error instanceof CredentialDraftError && error.code === 'credential_draft_purpose_mismatch',
  )
  assert.strictEqual(registry.consume({ draftRef: ref.draftRef, ownerId: 7, key: 'llm_api_key' }), 'draft-secret')
  assert.throws(
    () => registry.consume({ draftRef: ref.draftRef, ownerId: 7, key: 'llm_api_key' }),
    (error) => error instanceof CredentialDraftError && error.code === 'credential_draft_unknown',
  )

  const expired = registry.prepare({ ownerId: 7, key: 'paddleocr_api_key', value: 'paddle-secret' })
  now = expired.expiresAt + 1
  assert.throws(
    () => registry.consume({ draftRef: expired.draftRef, ownerId: 7, key: 'paddleocr_api_key' }),
    (error) => error instanceof CredentialDraftError && error.code === 'credential_draft_expired',
  )

  now += 1
  registry.prepare({ ownerId: 9, key: 'llm_api_key', value: 'one' })
  registry.prepare({ ownerId: 9, key: 'vision_ocr_api_key', value: 'two' })
  assert.strictEqual(registry.revokeOwner(9), 2)
  assert.strictEqual(registry.size, 0)
  assert.throws(() => registry.prepare({ ownerId: 1, key: 'llm_api_key', value: '' }), /credential_draft_value_required/)

  console.log('Credential draft regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
