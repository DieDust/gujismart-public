import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

export interface CredentialCryptoAdapter {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export type CredentialEntryState = 'active' | 'missing' | 'corrupt'

export interface CredentialPublicState {
  configured: boolean
  last4?: string
  version: number
  state: CredentialEntryState
}

export interface CredentialWriteResult {
  logicalKey: string
  version: number
  last4: string
  state: 'active'
}

interface PersistedCredentialEntry {
  ciphertext: string
  version: number
  last4: string
  updatedAt: string
}

interface PersistedCredentialVault {
  version: 1
  entries: Record<string, PersistedCredentialEntry>
}

export class CredentialVaultError extends Error {
  readonly code: 'credential_vault_unavailable' | 'credential_vault_corrupt' | 'credential_vault_write_failed'

  constructor(code: CredentialVaultError['code'], message: string) {
    super(message)
    this.name = 'CredentialVaultError'
    this.code = code
  }
}

function emptyVault(): PersistedCredentialVault {
  return { version: 1, entries: {} }
}

function isPersistedEntry(value: unknown): value is PersistedCredentialEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<PersistedCredentialEntry>
  return typeof entry.ciphertext === 'string'
    && Number.isInteger(entry.version)
    && Number(entry.version) > 0
    && typeof entry.last4 === 'string'
    && typeof entry.updatedAt === 'string'
}

function parseVaultFile(raw: string): PersistedCredentialVault {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid vault root')
  const payload = parsed as { version?: unknown; entries?: unknown }
  if (payload.version !== 1 || !payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
    throw new Error('invalid vault version')
  }
  const entries: Record<string, PersistedCredentialEntry> = {}
  for (const [key, value] of Object.entries(payload.entries)) {
    if (!key || !isPersistedEntry(value)) throw new Error('invalid vault entry')
    entries[key] = value
  }
  return { version: 1, entries }
}

export class CredentialVault {
  private readonly rootDir: string
  private readonly crypto: CredentialCryptoAdapter
  private readonly sidecarPath: string
  private readonly nextPath: string
  private readonly journalPath: string
  private payload: PersistedCredentialVault
  private readonly corruptKeys = new Set<string>()

  constructor(options: { rootDir: string; crypto: CredentialCryptoAdapter }) {
    this.rootDir = options.rootDir
    this.crypto = options.crypto
    this.sidecarPath = join(this.rootDir, 'credentials.v1.json')
    this.nextPath = join(this.rootDir, 'credentials.v1.next')
    this.journalPath = join(this.rootDir, 'credentials.v1.journal')
    this.recoverInterruptedWrite()
    this.payload = this.load()
  }

  put(logicalKey: string, plaintext: string): CredentialWriteResult {
    const key = String(logicalKey || '').trim()
    const value = String(plaintext || '')
    if (!key) throw new CredentialVaultError('credential_vault_write_failed', 'Credential key is required')
    if (!value) throw new CredentialVaultError('credential_vault_write_failed', 'Credential value is required')
    this.assertAvailable()

    try {
      const current = this.payload.entries[key]
      const version = (current?.version || 0) + 1
      const encrypted = this.crypto.encrypt(value)
      const entry: PersistedCredentialEntry = {
        ciphertext: Buffer.from(encrypted).toString('base64'),
        version,
        last4: value.slice(-4),
        updatedAt: new Date().toISOString(),
      }
      const next: PersistedCredentialVault = {
        version: 1,
        entries: { ...this.payload.entries, [key]: entry },
      }
      const verification = this.decryptEntry(entry)
      if (verification !== value) throw new Error('credential verification mismatch')
      this.persist(next)
      this.payload = next
      this.corruptKeys.delete(key)
      return { logicalKey: key, version, last4: entry.last4, state: 'active' }
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error
      throw new CredentialVaultError('credential_vault_write_failed', 'Credential could not be stored securely')
    }
  }

  read(logicalKey: string): string | null {
    const key = String(logicalKey || '').trim()
    const entry = this.payload.entries[key]
    if (!entry) return null
    this.assertAvailable()
    try {
      const plaintext = this.decryptEntry(entry)
      this.corruptKeys.delete(key)
      return plaintext
    } catch {
      this.corruptKeys.add(key)
      throw new CredentialVaultError('credential_vault_corrupt', 'Credential storage is damaged or unavailable')
    }
  }

  revoke(logicalKey: string): boolean {
    const key = String(logicalKey || '').trim()
    if (!this.payload.entries[key]) return false
    const entries = { ...this.payload.entries }
    delete entries[key]
    const next: PersistedCredentialVault = { version: 1, entries }
    this.persist(next)
    this.payload = next
    this.corruptKeys.delete(key)
    return true
  }

  revokeAll(): number {
    const count = Object.keys(this.payload.entries).length
    if (count === 0) return 0
    const next = emptyVault()
    this.persist(next)
    this.payload = next
    this.corruptKeys.clear()
    return count
  }

  getPublicState(logicalKey: string): CredentialPublicState {
    const key = String(logicalKey || '').trim()
    const entry = this.payload.entries[key]
    if (!entry) return { configured: false, version: 0, state: 'missing' }
    if (this.corruptKeys.has(key)) {
      return { configured: false, last4: entry.last4, version: entry.version, state: 'corrupt' }
    }
    return { configured: true, last4: entry.last4, version: entry.version, state: 'active' }
  }

  private decryptEntry(entry: PersistedCredentialEntry): string {
    return this.crypto.decrypt(Buffer.from(entry.ciphertext, 'base64'))
  }

  private assertAvailable(): void {
    if (!this.crypto.isAvailable()) {
      throw new CredentialVaultError('credential_vault_unavailable', 'Secure credential storage is unavailable')
    }
  }

  private load(): PersistedCredentialVault {
    if (!existsSync(this.sidecarPath)) return emptyVault()
    try {
      return parseVaultFile(readFileSync(this.sidecarPath, 'utf8'))
    } catch {
      throw new CredentialVaultError('credential_vault_corrupt', 'Credential storage metadata is damaged')
    }
  }

  private recoverInterruptedWrite(): void {
    if (!existsSync(this.journalPath)) return
    try {
      if (existsSync(this.nextPath)) {
        mkdirSync(this.rootDir, { recursive: true })
        renameSync(this.nextPath, this.sidecarPath)
      }
    } finally {
      rmSync(this.nextPath, { force: true })
      rmSync(this.journalPath, { force: true })
    }
  }

  private persist(payload: PersistedCredentialVault): void {
    mkdirSync(this.rootDir, { recursive: true })
    try {
      writeFileSync(this.journalPath, JSON.stringify({ version: 1, state: 'prepared' }), 'utf8')
      writeFileSync(this.nextPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(this.nextPath, this.sidecarPath)
      rmSync(this.journalPath, { force: true })
    } catch {
      rmSync(this.nextPath, { force: true })
      throw new CredentialVaultError('credential_vault_write_failed', 'Credential storage could not be updated')
    }
  }
}
