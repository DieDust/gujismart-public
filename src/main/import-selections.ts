import { randomUUID } from 'crypto'
import type { Dir } from 'fs'
import { lstat, opendir, realpath, stat } from 'fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import {
  FileCapabilityError,
  fileCapabilityService,
  type FileCapabilityRef,
  type IssueTrustedPathsOptions,
} from './file-capabilities'
import type { ImportSelection, ImportSelectionBatch, ImportSourceRef } from '../shared/types'

const DEFAULT_SELECTION_TTL_MS = 8 * 60 * 60 * 1000
const MAX_BATCH_SIZE = 200
const MAX_ACTIVE_SELECTIONS = 64

interface RootIdentity {
  dev: string
  ino: string
}

interface DirectoryCursor {
  path: string
  sourceId: string
  rootPath: string
  handle: Dir | null
}

interface BatchCandidate {
  sourceId: string
  path: string
  displayName: string
  relativeDisplayPath?: string
}

interface SelectionSource {
  sourceId: string
  displayName: string
  kind: 'file' | 'directory'
  canonicalPath: string
  identity: RootIdentity
}

interface ImportSelectionSession {
  id: string
  ownerId: number
  createdAt: number
  expiresAt: number
  cursor: number
  sources: SelectionSource[]
  pendingFiles: SelectionSource[]
  pendingDirectories: DirectoryCursor[]
  retryCandidates: BatchCandidate[]
  emittedCanonicalPaths: Set<string>
  completedAt: number | null
}

export interface ImportSelectionServiceOptions {
  issueFileGrants?: (options: IssueTrustedPathsOptions) => Promise<FileCapabilityRef[]>
  maxActiveSelections?: number
  maxCompletedSelections?: number
}

const supportedExtensions = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.json',
  '.txt', '.md', '.markdown', '.epub', '.mobi', '.azw', '.azw3',
])

function fail(code: ConstructorParameters<typeof FileCapabilityError>[0]): never {
  throw new FileCapabilityError(code)
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel))
}

async function inspectRoot(rawPath: string): Promise<SelectionSource | null> {
  const candidate = resolve(String(rawPath || '').trim())
  if (!candidate) fail('CAPABILITY_INVALID_REQUEST')
  let linkInfo
  try {
    linkInfo = await lstat(candidate)
  } catch {
    fail('CAPABILITY_TARGET_MISSING')
  }
  if (linkInfo.isSymbolicLink()) fail('CAPABILITY_SYMLINK_REJECTED')
  const canonicalPath = await realpath(candidate)
  const info = await stat(canonicalPath)
  const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null
  if (!kind) return null
  if (kind === 'file' && !supportedExtensions.has(extname(canonicalPath).toLowerCase())) return null
  return {
    sourceId: randomUUID(),
    displayName: basename(canonicalPath),
    kind,
    canonicalPath,
    identity: { dev: String(info.dev), ino: String(info.ino) },
  }
}

async function revalidateSource(source: SelectionSource): Promise<void> {
  let info
  try {
    const linkInfo = await lstat(source.canonicalPath)
    if (linkInfo.isSymbolicLink()) fail('CAPABILITY_SYMLINK_REJECTED')
    const canonicalPath = await realpath(source.canonicalPath)
    if (canonicalPath !== source.canonicalPath) fail('CAPABILITY_TARGET_CHANGED')
    info = await stat(canonicalPath)
  } catch (error) {
    if (error instanceof FileCapabilityError) throw error
    fail('CAPABILITY_TARGET_MISSING')
  }
  if (String(info.dev) !== source.identity.dev || String(info.ino) !== source.identity.ino) {
    fail('CAPABILITY_TARGET_CHANGED')
  }
  if ((source.kind === 'file' && !info.isFile()) || (source.kind === 'directory' && !info.isDirectory())) {
    fail('CAPABILITY_KIND_MISMATCH')
  }
}

export class ImportSelectionService {
  private readonly sessions = new Map<string, ImportSelectionSession>()
  private readonly issueFileGrants: (options: IssueTrustedPathsOptions) => Promise<FileCapabilityRef[]>
  private readonly maxActiveSelections: number
  private readonly maxCompletedSelections: number

  constructor(options: ImportSelectionServiceOptions = {}) {
    this.issueFileGrants = options.issueFileGrants
      ?? ((grantOptions) => fileCapabilityService.issueTrustedPaths(grantOptions))
    this.maxActiveSelections = options.maxActiveSelections ?? MAX_ACTIVE_SELECTIONS
    this.maxCompletedSelections = options.maxCompletedSelections ?? MAX_ACTIVE_SELECTIONS * 2
  }

  async create(ownerId: number, trustedPaths: string[]): Promise<ImportSelection> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !Array.isArray(trustedPaths) || trustedPaths.length === 0) {
      fail('CAPABILITY_INVALID_REQUEST')
    }
    this.sweepExpired()
    const activeSelectionCount = [...this.sessions.values()].filter((session) => session.completedAt === null).length
    if (activeSelectionCount >= this.maxActiveSelections) fail('CAPABILITY_BATCH_LIMIT')
    const normalized = [...new Set(trustedPaths.map((item) => String(item || '').trim()).filter(Boolean))]
    const inspected: SelectionSource[] = []
    for (const item of normalized) {
      const source = await inspectRoot(item)
      if (source) inspected.push(source)
    }
    if (inspected.length === 0) fail('CAPABILITY_INVALID_REQUEST')
    const createdAt = Date.now()
    const session: ImportSelectionSession = {
      id: randomUUID(),
      ownerId,
      createdAt,
      expiresAt: createdAt + DEFAULT_SELECTION_TTL_MS,
      cursor: 0,
      sources: inspected,
      pendingFiles: inspected.filter((source) => source.kind === 'file'),
      pendingDirectories: inspected
        .filter((source) => source.kind === 'directory')
        .map((source) => ({ path: source.canonicalPath, sourceId: source.sourceId, rootPath: source.canonicalPath, handle: null })),
      retryCandidates: [],
      emittedCanonicalPaths: new Set(),
      completedAt: null,
    }
    this.sessions.set(session.id, session)
    return this.toPublicSelection(session)
  }

  async readBatch(ownerId: number, selectionId: string, cursor?: string | null, requestedLimit?: number): Promise<ImportSelectionBatch> {
    const session = this.requireSession(ownerId, selectionId)
    if (session.completedAt !== null) fail('CAPABILITY_ALREADY_CONSUMED')
    const expectedCursor = String(session.cursor)
    if ((cursor ?? '0') !== expectedCursor) fail('CAPABILITY_INVALID_REQUEST')
    const limit = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(Number(requestedLimit) || MAX_BATCH_SIZE)))
    for (const source of session.sources) await revalidateSource(source)
    const candidates = session.retryCandidates.length > 0
      ? [...session.retryCandidates]
      : await this.collectCandidates(session, limit)

    let grants: FileCapabilityRef[]
    try {
      grants = candidates.length > 0
        ? await this.issueFileGrants({
          ownerId,
          purpose: 'document-import',
          paths: candidates.map((item) => item.path),
          kind: 'file',
          consumeMode: 'once',
        })
        : []
    } catch (error) {
      session.retryCandidates = candidates
      throw error
    }
    session.retryCandidates = []
    candidates.forEach((candidate) => session.emittedCanonicalPaths.add(candidate.path))
    session.cursor += 1
    const done = session.pendingFiles.length === 0 && session.pendingDirectories.length === 0
    const result: ImportSelectionBatch = {
      selectionId: session.id,
      items: grants.map((grant, index) => ({
        grantId: grant.grantId,
        sourceId: candidates[index].sourceId,
        displayName: candidates[index].displayName,
        relativeDisplayPath: candidates[index].relativeDisplayPath,
      })),
      nextCursor: done ? null : String(session.cursor),
      done,
    }
    if (done) this.completeSession(session)
    return result
  }

  async getDirectorySourcePath(ownerId: number, selectionId: string, sourceId: string): Promise<string> {
    const session = this.requireSession(ownerId, selectionId)
    const source = session.sources.find((item) => item.sourceId === sourceId && item.kind === 'directory')
    if (!source) fail('CAPABILITY_INVALID_REQUEST')
    await revalidateSource(source)
    return source.canonicalPath
  }

  async release(ownerId: number, selectionId: string): Promise<boolean> {
    const session = this.sessions.get(String(selectionId || ''))
    if (!session) return false
    if (session.ownerId !== ownerId) fail('CAPABILITY_OWNER_MISMATCH')
    await this.closeSessionHandles(session)
    this.finalizeSessionRelease(session)
    return true
  }

  revokeOwner(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.releaseSession(session)
    }
  }

  sweepExpired(now = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) this.releaseSession(session)
    }
  }

  private requireSession(ownerId: number, selectionId: string): ImportSelectionSession {
    const session = this.sessions.get(String(selectionId || ''))
    if (!session) fail('CAPABILITY_UNKNOWN')
    if (session.ownerId !== ownerId) fail('CAPABILITY_OWNER_MISMATCH')
    if (session.expiresAt <= Date.now()) {
      this.releaseSession(session)
      fail('CAPABILITY_EXPIRED')
    }
    return session
  }

  private toPublicSelection(session: ImportSelectionSession): ImportSelection {
    const sources: ImportSourceRef[] = session.sources.map((source) => ({
      sourceId: source.sourceId,
      grantId: source.sourceId,
      displayName: source.displayName,
      kind: source.kind,
      isDirectory: source.kind === 'directory',
      expiresAt: session.expiresAt,
    }))
    return {
      selectionId: session.id,
      sources,
      discoveredFileCount: session.pendingDirectories.length > 0 ? null : session.pendingFiles.length,
      authorizationStatus: 'authorized',
    }
  }

  private async collectCandidates(session: ImportSelectionSession, limit: number): Promise<BatchCandidate[]> {
    const candidates: BatchCandidate[] = []
    const candidatePaths = new Set<string>()
    while (session.pendingFiles.length > 0 && candidates.length < limit) {
      const source = session.pendingFiles.shift()
      if (source
        && !session.emittedCanonicalPaths.has(source.canonicalPath)
        && !candidatePaths.has(source.canonicalPath)) {
        candidatePaths.add(source.canonicalPath)
        candidates.push({ sourceId: source.sourceId, path: source.canonicalPath, displayName: source.displayName })
      }
    }
    while (session.pendingDirectories.length > 0 && candidates.length < limit) {
      const current = session.pendingDirectories[0]
      if (!current.handle) current.handle = await opendir(current.path)
      const entry = await current.handle.read()
      if (!entry) {
        await current.handle.close().catch(() => undefined)
        session.pendingDirectories.shift()
        continue
      }
      const itemPath = resolve(current.path, entry.name)
      if (!isInside(current.rootPath, itemPath)) continue
      const linkInfo = await lstat(itemPath).catch(() => null)
      if (!linkInfo || linkInfo.isSymbolicLink()) continue
      const canonicalPath = await realpath(itemPath).catch(() => '')
      if (!canonicalPath || !isInside(current.rootPath, canonicalPath)) continue
      if (linkInfo.isDirectory()) {
        session.pendingDirectories.push({
          path: canonicalPath,
          sourceId: current.sourceId,
          rootPath: current.rootPath,
          handle: null,
        })
      } else if (linkInfo.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
        if (session.emittedCanonicalPaths.has(canonicalPath) || candidatePaths.has(canonicalPath)) continue
        candidatePaths.add(canonicalPath)
        candidates.push({
          sourceId: current.sourceId,
          path: canonicalPath,
          displayName: entry.name,
          relativeDisplayPath: relative(current.rootPath, canonicalPath),
        })
      }
    }
    return candidates
  }

  private releaseSession(session: ImportSelectionSession): void {
    if (this.sessions.get(session.id) !== session) return
    void this.closeSessionHandles(session)
    this.finalizeSessionRelease(session)
  }

  private async closeSessionHandles(session: ImportSelectionSession): Promise<void> {
    const handles = session.pendingDirectories
      .map((cursor) => cursor.handle)
      .filter((handle): handle is Dir => Boolean(handle))
    session.pendingDirectories.forEach((cursor) => {
      cursor.handle = null
    })
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
  }

  private finalizeSessionRelease(session: ImportSelectionSession): void {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    session.pendingDirectories = []
    session.pendingFiles = []
    session.retryCandidates = []
    session.emittedCanonicalPaths.clear()
  }

  private completeSession(session: ImportSelectionSession): void {
    if (this.sessions.get(session.id) !== session || session.completedAt !== null) return
    for (const cursor of session.pendingDirectories) {
      if (cursor.handle) void cursor.handle.close().catch(() => undefined)
      cursor.handle = null
    }
    session.pendingDirectories = []
    session.pendingFiles = []
    session.retryCandidates = []
    session.emittedCanonicalPaths.clear()
    session.completedAt = Date.now()
    const completed = [...this.sessions.values()].filter((item) => item.completedAt !== null)
    while (completed.length > this.maxCompletedSelections) {
      const oldest = completed.shift()
      if (oldest) this.releaseSession(oldest)
    }
  }
}

export const importSelectionService = new ImportSelectionService()
