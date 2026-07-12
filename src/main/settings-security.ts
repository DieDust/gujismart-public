import { app, safeStorage } from 'electron'
import { join } from 'path'
import { queryAll, queryOne, run } from './database'
import { CredentialVault, CredentialVaultError } from './credential-vault'
import {
  getRendererSettingsSnapshot,
  isProtectedSettingKey,
  migrateLegacyProviderProfiles,
  ProtectedSettingsService,
  type CredentialVaultPort,
  type SettingsRepository,
} from './protected-settings'
import type { CredentialPublicState } from './credential-vault'
import type { SettingsMap } from '../shared/types'
import { CredentialDraftRegistry } from './credential-drafts'

const CREDENTIAL_REF_PREFIX = 'credential_ref:'
const LLM_PROFILE_SETTINGS_KEY = 'llm_provider_profiles'
const VISION_OCR_PROFILE_SETTINGS_KEY = 'vision_ocr_provider_profiles'

const repository: SettingsRepository = {
  get(key) {
    return queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null
  },
  set(key, value) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
  },
  delete(key) {
    run('DELETE FROM settings WHERE key = ?', [key])
    return true
  },
  entries() {
    return queryAll<{ key: string; value: string }>('SELECT key, value FROM settings')
  },
}

let protectedSettings: ProtectedSettingsService | null = null
let initializationErrorCode: string | null = null
const credentialDrafts = new CredentialDraftRegistry()

function createElectronVault(): CredentialVault {
  return new CredentialVault({
    rootDir: join(app.getPath('userData'), 'secrets'),
    crypto: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
  })
}

function persistCredentialReference(logicalKey: string, state: CredentialPublicState): void {
  repository.set(`${CREDENTIAL_REF_PREFIX}${logicalKey}`, JSON.stringify({
    version: state.version,
    state: state.state,
    configured: state.configured,
    updatedAt: new Date().toISOString(),
  }))
}

function migrateProfiles(service: ProtectedSettingsService): string[] {
  const migrated: string[] = []
  const definitions = [
    { kind: 'llm' as const, key: LLM_PROFILE_SETTINGS_KEY },
    { kind: 'vision_ocr' as const, key: VISION_OCR_PROFILE_SETTINGS_KEY },
  ]
  for (const definition of definitions) {
    const current = repository.get(definition.key)
    if (!current) continue
    const result = migrateLegacyProviderProfiles(definition.kind, current, service)
    if (!result.changed) continue
    repository.set(definition.key, result.serialized)
    for (const profile of result.publicProfiles) {
      persistCredentialReference(`${definition.kind}_profile:${profile.id}`, profile.credential)
    }
    migrated.push(definition.key)
  }
  return migrated
}

export function initializeSettingsSecurity(): {
  available: boolean
  migratedKeys: string[]
  migratedProfiles: string[]
  credentialsReset: boolean
  errorCode?: string
} {
  try {
    const service = new ProtectedSettingsService({ repository, vault: createElectronVault() })
    protectedSettings = service
    const credentialsReset = repository.get('credentials_required_after_restore') === 'true'
    if (credentialsReset) {
      service.revokeAllSecrets()
      for (const entry of repository.entries()) {
        if (entry.key.startsWith(CREDENTIAL_REF_PREFIX)) repository.delete(entry.key)
      }
      repository.delete('credentials_required_after_restore')
    }
    const migration = service.migrateLegacyProtectedSettings()
    for (const key of migration.migratedKeys) {
      persistCredentialReference(key, service.getPublicState(key))
    }
    const migratedProfiles = migrateProfiles(service)
    initializationErrorCode = null
    return {
      available: safeStorage.isEncryptionAvailable(),
      migratedKeys: migration.migratedKeys,
      migratedProfiles,
      credentialsReset,
    }
  } catch (error) {
    protectedSettings = null
    initializationErrorCode = error instanceof CredentialVaultError ? error.code : 'credential_migration_failed'
    console.warn(`[SettingsSecurity] Initialization deferred: ${initializationErrorCode}`)
    return { available: false, migratedKeys: [], migratedProfiles: [], credentialsReset: false, errorCode: initializationErrorCode }
  }
}

function requireProtectedSettings(): ProtectedSettingsService {
  if (!protectedSettings) {
    throw new CredentialVaultError('credential_vault_unavailable', 'Secure credential storage is unavailable')
  }
  return protectedSettings
}

export function readProtectedSetting(logicalKey: string): string {
  if (protectedSettings) {
    try {
      return protectedSettings.readSecret(logicalKey) || ''
    } catch (error) {
      const code = error instanceof CredentialVaultError ? error.code : 'credential_read_failed'
      console.warn(`[SettingsSecurity] Credential read failed: ${code}`)
      return ''
    }
  }
  // Compatibility fallback is main-only and remains hidden from all renderer snapshots.
  return isProtectedSettingKey(logicalKey) ? String(repository.get(logicalKey) || '') : ''
}

export function writeProtectedSetting(logicalKey: string, value: string): CredentialPublicState {
  const service = requireProtectedSettings()
  const state = service.writeSecret(logicalKey, value)
  if (isProtectedSettingKey(logicalKey) && value) repository.delete(logicalKey)
  persistCredentialReference(logicalKey, state)
  return state
}

export function revokeProtectedSetting(logicalKey: string): boolean {
  const service = requireProtectedSettings()
  const revoked = service.revokeSecret(logicalKey)
  repository.delete(`${CREDENTIAL_REF_PREFIX}${logicalKey}`)
  if (isProtectedSettingKey(logicalKey)) repository.delete(logicalKey)
  return revoked
}

export function getCredentialPublicState(logicalKey: string): CredentialPublicState {
  if (protectedSettings) return protectedSettings.getPublicState(logicalKey)
  const legacyConfigured = isProtectedSettingKey(logicalKey) && Boolean(repository.get(logicalKey))
  return {
    configured: legacyConfigured,
    version: 0,
    state: initializationErrorCode === 'credential_vault_corrupt' ? 'corrupt' : 'missing',
  }
}

export function getPublicSettingsMap(): SettingsMap {
  if (protectedSettings) return getRendererSettingsSnapshot(repository.entries(), protectedSettings)
  const snapshot: SettingsMap = {}
  for (const entry of repository.entries()) {
    if (isProtectedSettingKey(entry.key) || entry.key.startsWith(CREDENTIAL_REF_PREFIX)) continue
    snapshot[entry.key] = entry.value
  }
  for (const key of ['llm_api_key', 'paddleocr_api_key', 'vision_ocr_api_key'] as const) {
    const state = getCredentialPublicState(key)
    snapshot[`${key}_configured`] = state.configured ? 'true' : 'false'
    snapshot[`${key}_last4`] = state.last4 || ''
    snapshot[`${key}_version`] = String(state.version)
    snapshot[`${key}_state`] = state.state
  }
  return snapshot
}

export function readPublicSetting(key: string): string {
  if (isProtectedSettingKey(key)) return ''
  return String(repository.get(key) || '')
}

export function writePublicSetting(key: string, value: string): void {
  if (isProtectedSettingKey(key)) {
    writeProtectedSetting(key, value)
    return
  }
  repository.set(key, value)
}

export function getSettingsRepositoryForBackupAudit(): SettingsRepository {
  return repository
}

export function prepareCredentialDraft(ownerId: number, key: string, value: string): { draftRef: string; expiresAt: number } {
  if (!isProtectedSettingKey(key)) throw new Error('credential_draft_purpose_invalid')
  return credentialDrafts.prepare({ ownerId, key, value })
}

export function consumeCredentialDraft(ownerId: number, key: string, draftRef: string): string {
  if (!isProtectedSettingKey(key)) throw new Error('credential_draft_purpose_invalid')
  return credentialDrafts.consume({ ownerId, key, draftRef })
}

export function revokeCredentialDraftOwner(ownerId: number): number {
  return credentialDrafts.revokeOwner(ownerId)
}

export type { CredentialVaultPort }
