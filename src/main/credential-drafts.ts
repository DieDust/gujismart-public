import { randomUUID } from 'crypto'

export class CredentialDraftError extends Error {
  readonly code:
    | 'credential_draft_unknown'
    | 'credential_draft_expired'
    | 'credential_draft_owner_mismatch'
    | 'credential_draft_purpose_mismatch'
    | 'credential_draft_value_required'
    | 'credential_draft_capacity'

  constructor(code: CredentialDraftError['code']) {
    super(code)
    this.name = 'CredentialDraftError'
    this.code = code
  }
}

interface CredentialDraftEntry {
  ownerId: number
  key: string
  value: string
  expiresAt: number
}

export class CredentialDraftRegistry {
  private readonly entries = new Map<string, CredentialDraftEntry>()
  private readonly now: () => number
  private readonly createId: () => string
  private readonly ttlMs: number
  private readonly maxActive: number

  constructor(options?: { now?: () => number; createId?: () => string; ttlMs?: number; maxActive?: number }) {
    this.now = options?.now || Date.now
    this.createId = options?.createId || randomUUID
    this.ttlMs = Math.max(1_000, options?.ttlMs || 5 * 60 * 1000)
    this.maxActive = Math.max(1, options?.maxActive || 128)
  }

  get size(): number {
    this.sweepExpired()
    return this.entries.size
  }

  prepare(input: { ownerId: number; key: string; value: string }): { draftRef: string; expiresAt: number } {
    this.sweepExpired()
    const value = String(input.value || '')
    if (!value) throw new CredentialDraftError('credential_draft_value_required')
    if (this.entries.size >= this.maxActive) throw new CredentialDraftError('credential_draft_capacity')
    const draftRef = this.createId()
    const expiresAt = this.now() + this.ttlMs
    this.entries.set(draftRef, {
      ownerId: input.ownerId,
      key: String(input.key || '').trim(),
      value,
      expiresAt,
    })
    return { draftRef, expiresAt }
  }

  consume(input: { draftRef: string; ownerId: number; key: string }): string {
    const draftRef = String(input.draftRef || '').trim()
    const entry = this.entries.get(draftRef)
    if (!entry) throw new CredentialDraftError('credential_draft_unknown')
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(draftRef)
      throw new CredentialDraftError('credential_draft_expired')
    }
    if (entry.ownerId !== input.ownerId) throw new CredentialDraftError('credential_draft_owner_mismatch')
    if (entry.key !== String(input.key || '').trim()) throw new CredentialDraftError('credential_draft_purpose_mismatch')
    this.entries.delete(draftRef)
    return entry.value
  }

  revokeOwner(ownerId: number): number {
    let revoked = 0
    for (const [draftRef, entry] of this.entries) {
      if (entry.ownerId !== ownerId) continue
      this.entries.delete(draftRef)
      revoked += 1
    }
    return revoked
  }

  sweepExpired(): number {
    const now = this.now()
    let removed = 0
    for (const [draftRef, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.entries.delete(draftRef)
      removed += 1
    }
    return removed
  }
}
