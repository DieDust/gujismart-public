import type { CredentialPublicState, CredentialVault } from './credential-vault'

export const PROTECTED_SETTING_KEYS = [
  'llm_api_key',
  'paddleocr_api_key',
  'vision_ocr_api_key',
] as const

export type ProtectedSettingKey = (typeof PROTECTED_SETTING_KEYS)[number]

export interface SettingsRepository {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): boolean
  entries(): Array<{ key: string; value: string }>
}

export interface CredentialVaultPort {
  put(logicalKey: string, value: string): { version: number }
  read(logicalKey: string): string | null
  revoke(logicalKey: string): boolean
  revokeAll(): number
  getPublicState(logicalKey: string): CredentialPublicState
}

export interface ProtectedSettingsMigrationResult {
  migratedKeys: ProtectedSettingKey[]
  skippedKeys: ProtectedSettingKey[]
}

export interface PublicProviderProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  updatedAt?: string
  credential: CredentialPublicState
}

export function isProtectedSettingKey(key: string): key is ProtectedSettingKey {
  return (PROTECTED_SETTING_KEYS as readonly string[]).includes(String(key || '').trim())
}

export class ProtectedSettingsService {
  private readonly repository: SettingsRepository
  private readonly vault: CredentialVaultPort

  constructor(options: { repository: SettingsRepository; vault: CredentialVaultPort | CredentialVault }) {
    this.repository = options.repository
    this.vault = options.vault
  }

  migrateLegacyProtectedSettings(): ProtectedSettingsMigrationResult {
    const migratedKeys: ProtectedSettingKey[] = []
    const skippedKeys: ProtectedSettingKey[] = []
    for (const key of PROTECTED_SETTING_KEYS) {
      const legacy = this.repository.get(key)
      if (!legacy) {
        if (legacy !== null) this.repository.delete(key)
        skippedKeys.push(key)
        continue
      }
      this.vault.put(key, legacy)
      if (this.vault.read(key) !== legacy) {
        throw new Error('credential_migration_verification_failed')
      }
      this.repository.delete(key)
      migratedKeys.push(key)
    }
    return { migratedKeys, skippedKeys }
  }

  writeSecret(key: ProtectedSettingKey | string, value: string): CredentialPublicState {
    const logicalKey = String(key || '').trim()
    const secret = String(value || '')
    if (!secret) return this.vault.getPublicState(logicalKey)
    this.vault.put(logicalKey, secret)
    return this.vault.getPublicState(logicalKey)
  }

  readSecret(key: ProtectedSettingKey | string): string | null {
    return this.vault.read(String(key || '').trim())
  }

  revokeSecret(key: ProtectedSettingKey | string): boolean {
    return this.vault.revoke(String(key || '').trim())
  }

  revokeAllSecrets(): number {
    return this.vault.revokeAll()
  }

  getPublicState(key: ProtectedSettingKey | string): CredentialPublicState {
    return this.vault.getPublicState(String(key || '').trim())
  }
}

export function getRendererSettingsSnapshot(
  entries: Array<{ key: string; value: string }>,
  protectedSettings: ProtectedSettingsService,
): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const entry of entries) {
    if (isProtectedSettingKey(entry.key) || entry.key.startsWith('credential_ref:')) continue
    snapshot[entry.key] = entry.value
  }
  for (const key of PROTECTED_SETTING_KEYS) {
    const state = protectedSettings.getPublicState(key)
    snapshot[`${key}_configured`] = state.configured ? 'true' : 'false'
    snapshot[`${key}_last4`] = state.last4 || ''
    snapshot[`${key}_version`] = String(state.version)
    snapshot[`${key}_state`] = state.state
  }
  return snapshot
}

function parseProfileArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(String(value || ''))
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : []
  } catch {
    return []
  }
}

export function migrateLegacyProviderProfiles(
  kind: 'llm' | 'vision_ocr',
  serialized: string,
  protectedSettings: ProtectedSettingsService,
): { changed: boolean; serialized: string; publicProfiles: PublicProviderProfile[] } {
  let changed = false
  const normalized = parseProfileArray(serialized).map((item) => {
    const id = String(item.id || item.name || '').trim()
    const logicalKey = `${kind}_profile:${id}`
    const apiKey = String(item.apiKey || '')
    if (id && apiKey) {
      protectedSettings.writeSecret(logicalKey, apiKey)
      changed = true
    }
    const result: Record<string, unknown> = { ...item }
    if ('apiKey' in result) {
      delete result.apiKey
      changed = true
    }
    return result
  })
  const serializedProfiles = JSON.stringify(normalized)
  const publicProfiles = normalized
    .map((item): PublicProviderProfile | null => {
      const id = String(item.id || item.name || '').trim()
      if (!id) return null
      return {
        id,
        name: String(item.name || item.provider || '').trim(),
        provider: String(item.provider || item.name || '').trim(),
        baseUrl: String(item.baseUrl || '').trim(),
        model: String(item.model || '').trim(),
        ...(item.updatedAt ? { updatedAt: String(item.updatedAt) } : {}),
        credential: protectedSettings.getPublicState(`${kind}_profile:${id}`),
      }
    })
    .filter((profile): profile is PublicProviderProfile => profile !== null)
  return { changed, serialized: serializedProfiles, publicProfiles }
}
