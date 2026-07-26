import { randomUUID } from 'crypto'
import { lstat, realpath, stat } from 'fs/promises'
import { basename, resolve } from 'path'

export type FileCapabilityPurpose =
  | 'document-import'
  | 'pdf-repository'
  | 'pdf-restore'

export type FileCapabilityKind = 'file' | 'directory'
export type FileCapabilityConsumeMode = 'once' | 'session'

export type FileCapabilityErrorCode =
  | 'CAPABILITY_UNKNOWN'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_OWNER_MISMATCH'
  | 'CAPABILITY_PURPOSE_MISMATCH'
  | 'CAPABILITY_KIND_MISMATCH'
  | 'CAPABILITY_ALREADY_CONSUMED'
  | 'CAPABILITY_ALREADY_LOCKED'
  | 'CAPABILITY_TARGET_MISSING'
  | 'CAPABILITY_TARGET_CHANGED'
  | 'CAPABILITY_SYMLINK_REJECTED'
  | 'CAPABILITY_BATCH_LIMIT'
  | 'CAPABILITY_INVALID_REQUEST'
  | 'CAPABILITY_LEASE_UNKNOWN'
  | 'CAPABILITY_LEASE_EXPIRED'
  | 'CAPABILITY_LEASE_MISMATCH'

export class FileCapabilityError extends Error {
  readonly code: FileCapabilityErrorCode

  constructor(code: FileCapabilityErrorCode) {
    super(code)
    this.name = 'FileCapabilityError'
    this.code = code
  }
}

export interface FileCapabilityRef {
  grantId: string
  displayName: string
  kind: FileCapabilityKind
  expiresAt: number
}

export interface FileCapabilityBatch {
  leaseId: string
  entries: Array<{ grantId: string; path: string }>
}

interface FileIdentity {
  dev: string
  ino: string
  size?: number
  mtimeMs?: number
  ctimeMs?: number
  birthtimeMs?: number
}

interface FileCapabilityRecord {
  id: string
  ownerId: number
  purpose: FileCapabilityPurpose
  kind: FileCapabilityKind
  canonicalPath: string
  identity: FileIdentity
  createdAt: number
  expiresAt: number
  consumeMode: FileCapabilityConsumeMode
  leaseId?: string
}

interface FileCapabilityLease {
  id: string
  grantIds: Set<string>
  createdAt: number
  expiresAt: number
  maxExpiresAt: number
}

interface ConsumedCapabilityTombstone {
  ownerId: number
  purpose: FileCapabilityPurpose
  kind: FileCapabilityKind
  expiresAt: number
}

export interface FileCapabilityServiceOptions {
  defaultTtlMs?: number
  leaseTtlMs?: number
  maxLeaseTtlMs?: number
  maxActive?: number
  maxTombstones?: number
  now?: () => number
  idFactory?: () => string
}

export interface IssueTrustedPathsOptions {
  ownerId: number
  purpose: FileCapabilityPurpose
  paths: string[]
  kind: FileCapabilityKind
  consumeMode?: FileCapabilityConsumeMode
  ttlMs?: number
}

const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_LEASE_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_MAX_ACTIVE = 4096

function capabilityError(code: FileCapabilityErrorCode): never {
  throw new FileCapabilityError(code)
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

function buildIdentity(
  kind: FileCapabilityKind,
  value: NonNullable<Awaited<ReturnType<typeof stat>>>,
): FileIdentity {
  const identity: FileIdentity = {
    dev: String(value.dev),
    ino: String(value.ino),
  }
  if (kind === 'file') {
    identity.size = Number(value.size)
    identity.mtimeMs = Number(value.mtimeMs)
    identity.ctimeMs = Number(value.ctimeMs)
    identity.birthtimeMs = Number(value.birthtimeMs)
  }
  return identity
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

async function inspectTarget(
  rawPath: string,
  expectedKind: FileCapabilityKind,
): Promise<{ canonicalPath: string; identity: FileIdentity }> {
  const candidate = String(rawPath || '').trim()
  if (!candidate) capabilityError('CAPABILITY_INVALID_REQUEST')

  const absolutePath = resolve(candidate)
  try {
    const linkStat = await lstat(absolutePath)
    if (linkStat.isSymbolicLink()) capabilityError('CAPABILITY_SYMLINK_REJECTED')

    const canonicalPath = await realpath(absolutePath)
    const targetStat = await stat(canonicalPath)
    const actualKind: FileCapabilityKind | null = targetStat.isFile()
      ? 'file'
      : targetStat.isDirectory()
        ? 'directory'
        : null
    if (actualKind !== expectedKind) capabilityError('CAPABILITY_KIND_MISMATCH')

    return {
      canonicalPath,
      identity: buildIdentity(expectedKind, targetStat),
    }
  } catch (error) {
    if (error instanceof FileCapabilityError) throw error
    if (isMissingError(error)) capabilityError('CAPABILITY_TARGET_MISSING')
    throw error
  }
}

export class FileCapabilityService {
  private readonly defaultTtlMs: number
  private readonly leaseTtlMs: number
  private readonly maxLeaseTtlMs: number
  private readonly maxActive: number
  private readonly maxTombstones: number
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly grants = new Map<string, FileCapabilityRecord>()
  private readonly leases = new Map<string, FileCapabilityLease>()
  private readonly consumedTombstones = new Map<string, ConsumedCapabilityTombstone>()
  private readonly expiredLeaseTombstones = new Map<string, number>()

  constructor(options: FileCapabilityServiceOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? DEFAULT_MAX_LEASE_TTL_MS
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE
    this.maxTombstones = options.maxTombstones ?? this.maxActive
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    if (!Number.isFinite(this.defaultTtlMs)
      || this.defaultTtlMs <= 0
      || !Number.isFinite(this.leaseTtlMs)
      || this.leaseTtlMs <= 0
      || !Number.isFinite(this.maxLeaseTtlMs)
      || this.maxLeaseTtlMs < this.leaseTtlMs) {
      capabilityError('CAPABILITY_INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(this.maxActive)
      || this.maxActive <= 0
      || !Number.isSafeInteger(this.maxTombstones)
      || this.maxTombstones <= 0) {
      capabilityError('CAPABILITY_INVALID_REQUEST')
    }
  }

  get activeCount(): number {
    return this.grants.size
  }

  async issueTrustedPaths(options: IssueTrustedPathsOptions): Promise<FileCapabilityRef[]> {
    const { ownerId, purpose, paths, kind } = options
    const consumeMode = options.consumeMode ?? 'once'
    const ttlMs = options.ttlMs ?? this.defaultTtlMs
    if (!Number.isSafeInteger(ownerId)
      || ownerId <= 0
      || !purpose
      || (kind !== 'file' && kind !== 'directory')
      || (consumeMode !== 'once' && consumeMode !== 'session')
      || !Array.isArray(paths)
      || paths.length === 0
      || !Number.isFinite(ttlMs)
      || ttlMs <= 0) {
      capabilityError('CAPABILITY_INVALID_REQUEST')
    }

    this.sweepExpired()
    if (paths.length > this.maxActive - this.grants.size) {
      capabilityError('CAPABILITY_BATCH_LIMIT')
    }

    const inspected = await Promise.all(paths.map((filePath) => inspectTarget(filePath, kind)))
    this.sweepExpired()
    if (paths.length > this.maxActive - this.grants.size) {
      capabilityError('CAPABILITY_BATCH_LIMIT')
    }
    const createdAt = this.now()
    const expiresAt = createdAt + ttlMs
    const pending: FileCapabilityRecord[] = []
    const pendingIds = new Set<string>()
    for (const target of inspected) {
      let id = ''
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = String(this.idFactory() || '')
        if (candidate
          && !this.grants.has(candidate)
          && !this.leases.has(candidate)
          && !this.consumedTombstones.has(candidate)
          && !this.expiredLeaseTombstones.has(candidate)
          && !pendingIds.has(candidate)) {
          id = candidate
          break
        }
      }
      if (!id) capabilityError('CAPABILITY_INVALID_REQUEST')
      pendingIds.add(id)
      pending.push({
        id,
        ownerId,
        purpose,
        kind,
        canonicalPath: target.canonicalPath,
        identity: target.identity,
        createdAt,
        expiresAt,
        consumeMode,
      })
    }

    for (const record of pending) this.grants.set(record.id, record)
    return pending.map((record) => ({
      grantId: record.id,
      displayName: basename(record.canonicalPath),
      kind: record.kind,
      expiresAt: record.expiresAt,
    }))
  }

  async consumeFile(ownerId: number, grantId: string, purpose: FileCapabilityPurpose): Promise<string> {
    const record = await this.validateGrant(ownerId, grantId, purpose, 'file')
    this.assertRecordState(record, ownerId, purpose, 'file')
    if (record.leaseId) capabilityError('CAPABILITY_ALREADY_LOCKED')
    const canonicalPath = record.canonicalPath
    if (record.consumeMode === 'once') this.retireConsumed(record)
    return canonicalPath
  }

  async useDirectory(ownerId: number, grantId: string, purpose: FileCapabilityPurpose): Promise<string> {
    const record = await this.validateGrant(ownerId, grantId, purpose, 'directory')
    this.assertRecordState(record, ownerId, purpose, 'directory')
    if (record.leaseId) capabilityError('CAPABILITY_ALREADY_LOCKED')
    const canonicalPath = record.canonicalPath
    if (record.consumeMode === 'once') this.retireConsumed(record)
    return canonicalPath
  }

  async beginFileBatch(
    ownerId: number,
    grantIds: string[],
    purpose: FileCapabilityPurpose,
    leaseTtlMs = this.leaseTtlMs,
  ): Promise<FileCapabilityBatch> {
    if (!Array.isArray(grantIds)
      || grantIds.length === 0
      || new Set(grantIds).size !== grantIds.length
      || !Number.isFinite(leaseTtlMs)
      || leaseTtlMs <= 0
      || leaseTtlMs > this.maxLeaseTtlMs) {
      capabilityError('CAPABILITY_INVALID_REQUEST')
    }

    const records: FileCapabilityRecord[] = []
    for (const grantId of grantIds) {
      records.push(await this.validateGrant(ownerId, grantId, purpose, 'file'))
    }
    for (const record of records) this.assertRecordState(record, ownerId, purpose, 'file')
    if (records.some((record) => Boolean(record.leaseId))) {
      capabilityError('CAPABILITY_ALREADY_LOCKED')
    }

    let leaseId = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = String(this.idFactory() || '')
      if (candidate
        && !this.grants.has(candidate)
        && !this.leases.has(candidate)
        && !this.consumedTombstones.has(candidate)
        && !this.expiredLeaseTombstones.has(candidate)) {
        leaseId = candidate
        break
      }
    }
    if (!leaseId) capabilityError('CAPABILITY_INVALID_REQUEST')

    const createdAt = this.now()
    const lease: FileCapabilityLease = {
      id: leaseId,
      grantIds: new Set(grantIds),
      createdAt,
      expiresAt: createdAt + leaseTtlMs,
      maxExpiresAt: createdAt + this.maxLeaseTtlMs,
    }
    for (const record of records) record.leaseId = leaseId
    this.leases.set(leaseId, lease)
    return {
      leaseId,
      entries: records.map((record) => ({ grantId: record.id, path: record.canonicalPath })),
    }
  }

  renewFileBatch(leaseId: string, leaseTtlMs = this.leaseTtlMs): number {
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0 || leaseTtlMs > this.maxLeaseTtlMs) {
      capabilityError('CAPABILITY_INVALID_REQUEST')
    }
    const lease = this.requireActiveLease(leaseId)
    const expiresAt = Math.min(this.now() + leaseTtlMs, lease.maxExpiresAt)
    if (expiresAt <= this.now()) {
      this.expireLease(lease, this.now())
      capabilityError('CAPABILITY_LEASE_EXPIRED')
    }
    lease.expiresAt = expiresAt
    return expiresAt
  }

  settleFileBatch(leaseId: string, settledGrantIds: string[]): void {
    const lease = this.requireActiveLease(leaseId)
    if (!Array.isArray(settledGrantIds)
      || new Set(settledGrantIds).size !== settledGrantIds.length
      || settledGrantIds.some((grantId) => !lease.grantIds.has(grantId))) {
      capabilityError('CAPABILITY_LEASE_MISMATCH')
    }

    const settled = new Set(settledGrantIds)
    for (const grantId of lease.grantIds) {
      const record = this.grants.get(grantId)
      if (!record || record.leaseId !== leaseId) capabilityError('CAPABILITY_LEASE_MISMATCH')
    }
    this.leases.delete(leaseId)
    for (const grantId of lease.grantIds) {
      const record = this.grants.get(grantId)
      if (!record) continue
      record.leaseId = undefined
      if (settled.has(grantId) && record.consumeMode === 'once') {
        this.retireConsumed(record)
      } else if (record.expiresAt <= this.now()) {
        this.grants.delete(record.id)
      }
    }
  }

  abortFileBatch(leaseId: string): void {
    const lease = this.requireActiveLease(leaseId)
    this.leases.delete(leaseId)
    for (const grantId of lease.grantIds) {
      const record = this.grants.get(grantId)
      if (record?.leaseId !== leaseId) continue
      record.leaseId = undefined
      if (record.expiresAt <= this.now()) this.grants.delete(record.id)
    }
  }

  revoke(grantId: string): void {
    const record = this.grants.get(grantId)
    if (!record) return
    this.detachFromLease(record)
    this.grants.delete(grantId)
  }

  revokeOwner(ownerId: number): void {
    for (const record of [...this.grants.values()]) {
      if (record.ownerId === ownerId) this.revoke(record.id)
    }
    for (const [grantId, tombstone] of this.consumedTombstones) {
      if (tombstone.ownerId === ownerId) this.consumedTombstones.delete(grantId)
    }
  }

  revokeAll(): void {
    this.grants.clear()
    this.leases.clear()
    this.consumedTombstones.clear()
    this.expiredLeaseTombstones.clear()
  }

  sweepExpired(at = this.now()): number {
    const activeBefore = this.grants.size
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt <= at) this.expireLease(lease, at)
    }
    for (const record of [...this.grants.values()]) {
      if (!record.leaseId && record.expiresAt <= at) this.grants.delete(record.id)
    }
    for (const [grantId, tombstone] of this.consumedTombstones) {
      if (tombstone.expiresAt <= at) this.consumedTombstones.delete(grantId)
    }
    for (const [leaseId, expiresAt] of this.expiredLeaseTombstones) {
      if (expiresAt <= at) this.expiredLeaseTombstones.delete(leaseId)
    }
    return activeBefore - this.grants.size
  }

  private async validateGrant(
    ownerId: number,
    grantId: string,
    purpose: FileCapabilityPurpose,
    kind: FileCapabilityKind,
  ): Promise<FileCapabilityRecord> {
    const record = this.grants.get(String(grantId || ''))
    if (!record) this.throwConsumedOrUnknown(ownerId, grantId, purpose, kind)
    this.assertRecordState(record, ownerId, purpose, kind)

    const current = await inspectTarget(record.canonicalPath, record.kind)
    if (current.canonicalPath !== record.canonicalPath || !identitiesMatch(current.identity, record.identity)) {
      capabilityError('CAPABILITY_TARGET_CHANGED')
    }
    return record
  }

  private assertRecordState(
    record: FileCapabilityRecord,
    ownerId: number,
    purpose: FileCapabilityPurpose,
    kind: FileCapabilityKind,
  ): void {
    if (this.grants.get(record.id) !== record) capabilityError('CAPABILITY_UNKNOWN')
    if (record.ownerId !== ownerId) capabilityError('CAPABILITY_OWNER_MISMATCH')
    if (record.purpose !== purpose) capabilityError('CAPABILITY_PURPOSE_MISMATCH')
    if (record.kind !== kind) capabilityError('CAPABILITY_KIND_MISMATCH')
    if (record.expiresAt <= this.now()) capabilityError('CAPABILITY_EXPIRED')
  }

  private throwConsumedOrUnknown(
    ownerId: number,
    grantId: string,
    purpose: FileCapabilityPurpose,
    kind: FileCapabilityKind,
  ): never {
    const normalizedId = String(grantId || '')
    const tombstone = this.consumedTombstones.get(normalizedId)
    if (!tombstone || tombstone.expiresAt <= this.now()) {
      if (tombstone) this.consumedTombstones.delete(normalizedId)
      capabilityError('CAPABILITY_UNKNOWN')
    }
    if (tombstone.ownerId !== ownerId) capabilityError('CAPABILITY_OWNER_MISMATCH')
    if (tombstone.purpose !== purpose) capabilityError('CAPABILITY_PURPOSE_MISMATCH')
    if (tombstone.kind !== kind) capabilityError('CAPABILITY_KIND_MISMATCH')
    capabilityError('CAPABILITY_ALREADY_CONSUMED')
  }

  private retireConsumed(record: FileCapabilityRecord): void {
    record.leaseId = undefined
    this.grants.delete(record.id)
    this.consumedTombstones.delete(record.id)
    this.consumedTombstones.set(record.id, {
      ownerId: record.ownerId,
      purpose: record.purpose,
      kind: record.kind,
      expiresAt: this.now() + this.defaultTtlMs,
    })
    while (this.consumedTombstones.size > this.maxTombstones) {
      const oldestId = this.consumedTombstones.keys().next().value
      if (typeof oldestId !== 'string') break
      this.consumedTombstones.delete(oldestId)
    }
  }

  private requireActiveLease(leaseId: string): FileCapabilityLease {
    const normalizedId = String(leaseId || '')
    const lease = this.leases.get(normalizedId)
    if (lease) {
      if (lease.expiresAt <= this.now()) {
        this.expireLease(lease, this.now())
        capabilityError('CAPABILITY_LEASE_EXPIRED')
      }
      return lease
    }
    const tombstoneExpiresAt = this.expiredLeaseTombstones.get(normalizedId)
    if (tombstoneExpiresAt && tombstoneExpiresAt > this.now()) {
      capabilityError('CAPABILITY_LEASE_EXPIRED')
    }
    if (tombstoneExpiresAt) this.expiredLeaseTombstones.delete(normalizedId)
    capabilityError('CAPABILITY_LEASE_UNKNOWN')
  }

  private expireLease(lease: FileCapabilityLease, at: number): void {
    this.leases.delete(lease.id)
    for (const grantId of lease.grantIds) {
      const record = this.grants.get(grantId)
      if (record?.leaseId !== lease.id) continue
      record.leaseId = undefined
      if (record.expiresAt <= at) this.grants.delete(record.id)
    }
    this.expiredLeaseTombstones.delete(lease.id)
    this.expiredLeaseTombstones.set(lease.id, at + this.leaseTtlMs)
    while (this.expiredLeaseTombstones.size > this.maxTombstones) {
      const oldestId = this.expiredLeaseTombstones.keys().next().value
      if (typeof oldestId !== 'string') break
      this.expiredLeaseTombstones.delete(oldestId)
    }
  }

  private detachFromLease(record: FileCapabilityRecord): void {
    if (!record.leaseId) return
    const lease = this.leases.get(record.leaseId)
    lease?.grantIds.delete(record.id)
    if (lease?.grantIds.size === 0) this.leases.delete(lease.id)
    record.leaseId = undefined
  }
}

export const fileCapabilityService = new FileCapabilityService()
