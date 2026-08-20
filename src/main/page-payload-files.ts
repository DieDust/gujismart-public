import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, normalize, resolve } from 'path'
import { promisify } from 'util'
import { gunzipSync, gzip, gzipSync } from 'zlib'

const gzipAsync = promisify(gzip)

const PAYLOAD_ROOT_NAME = 'page-payloads'
const LEGACY_REF_PREFIX = 'page-payload:v1:'
const REF_PREFIX = 'page-payload:v2:'
let payloadDataDirOverride: string | null = null

export interface PagePayloadFileScan {
  fileCount: number
  bytes: number
  refs: string[]
}

export interface PagePayloadCleanupResult {
  scannedFiles: number
  deletedFiles: number
  deletedBytes: number
}

export function setPayloadDataDir(dataDir: string): void {
  payloadDataDirOverride = resolve(dataDir)
}

function getStableAppRoot(): string {
  const exePath = process.execPath || ''
  if (exePath && !/[\\/]node(?:\.exe)?$/i.test(exePath) && !/[\\/]electron(?:\.exe)?$/i.test(exePath)) {
    return join(dirname(exePath), 'data')
  }
  return resolve(process.cwd(), 'data')
}

export function resolvePayloadDataDir(): string {
  if (payloadDataDirOverride) {
    return payloadDataDirOverride
  }
  if (process.env.GUJISMART_DATA_DIR) {
    return resolve(process.env.GUJISMART_DATA_DIR)
  }
  return getStableAppRoot()
}

export function getPayloadRootDir(): string {
  return join(resolvePayloadDataDir(), 'storage', PAYLOAD_ROOT_NAME)
}

function normalizeRefPath(ref: string): string | null {
  const relative = ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : ref.startsWith(LEGACY_REF_PREFIX)
      ? ref.slice(LEGACY_REF_PREFIX.length)
      : ref
  if (!relative || relative.includes('..')) return null
  return relative
}

export function canonicalizePagePayloadRef(ref: string | null | undefined): string | null {
  if (!ref) return null
  const relative = normalizeRefPath(ref)
  return relative ? `${REF_PREFIX}${relative}` : null
}

function resolvePayloadPath(ref: string): string | null {
  const relative = normalizeRefPath(ref)
  if (!relative) return null
  const root = normalize(getPayloadRootDir())
  const target = normalize(join(root, ...relative.split('/')))
  if (!target.toLowerCase().startsWith(root.toLowerCase())) return null
  return target
}

export function pagePayloadRefExists(ref: string | null | undefined): boolean {
  if (!ref) return false
  const absolutePath = resolvePayloadPath(ref)
  return !!absolutePath && existsSync(absolutePath)
}

// Hot-path cache: open/proof/search repeatedly hydrate the same page payload refs.
// Completeness is unchanged — this only avoids re-reading and gunzipping identical files.
const PAGE_PAYLOAD_READ_CACHE_MAX = 256
const pagePayloadReadCache = new Map<string, string | null>()

function rememberPagePayloadRead(cacheKey: string, value: string | null): string | null {
  if (pagePayloadReadCache.has(cacheKey)) pagePayloadReadCache.delete(cacheKey)
  pagePayloadReadCache.set(cacheKey, value)
  while (pagePayloadReadCache.size > PAGE_PAYLOAD_READ_CACHE_MAX) {
    const oldest = pagePayloadReadCache.keys().next().value
    if (oldest === undefined) break
    pagePayloadReadCache.delete(oldest)
  }
  return value
}

export function invalidatePagePayloadReadCache(ref?: string | null): void {
  if (!ref) {
    pagePayloadReadCache.clear()
    return
  }
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath) return
  pagePayloadReadCache.delete(absolutePath)
}

export function buildPagePayloadRef(docId: string, pageId: string, field: string, value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  const prefix = hash.slice(0, 2)
  return `${REF_PREFIX}${['objects', prefix, `${hash}.json.gz`].join('/')}`
}

export function writePagePayloadRef(docId: string, pageId: string, field: string, value: string): string {
  const ref = buildPagePayloadRef(docId, pageId, field, value)
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath) throw new Error('Invalid page payload path')
  mkdirSync(dirname(absolutePath), { recursive: true })
  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, gzipSync(JSON.stringify({
      version: 2,
      docId,
      pageId,
      field,
      sha256: createHash('sha256').update(value).digest('hex'),
      createdAt: new Date().toISOString(),
      value,
    })))
  }
  // New writes supersede any prior cached value for this path.
  pagePayloadReadCache.delete(absolutePath)
  return ref
}

// Async variant for interactive save paths: gzip runs on the zlib thread pool
// and the file lands via temp-file + rename so a crash cannot leave a truncated
// content-addressed object behind.
export async function writePagePayloadRefAsync(docId: string, pageId: string, field: string, value: string): Promise<string> {
  const hash = createHash('sha256').update(value).digest('hex')
  const ref = `${REF_PREFIX}${['objects', hash.slice(0, 2), `${hash}.json.gz`].join('/')}`
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath) throw new Error('Invalid page payload path')
  await mkdir(dirname(absolutePath), { recursive: true })
  if (!existsSync(absolutePath)) {
    const compressed = await gzipAsync(JSON.stringify({
      version: 2,
      docId,
      pageId,
      field,
      sha256: hash,
      createdAt: new Date().toISOString(),
      value,
    }))
    const tempPath = `${absolutePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, compressed)
    try {
      await rename(tempPath, absolutePath)
    } catch (error) {
      // A concurrent writer may have landed the same content-addressed object.
      await rm(tempPath, { force: true })
      if (!existsSync(absolutePath)) throw error
    }
  }
  pagePayloadReadCache.delete(absolutePath)
  return ref
}

export function readPagePayloadValue(ref: string | null | undefined): string | null {
  if (!ref) return null
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath) return null
  if (pagePayloadReadCache.has(absolutePath)) {
    const cached = pagePayloadReadCache.get(absolutePath) ?? null
    // LRU bump
    pagePayloadReadCache.delete(absolutePath)
    pagePayloadReadCache.set(absolutePath, cached)
    return cached
  }
  if (!existsSync(absolutePath)) return rememberPagePayloadRead(absolutePath, null)
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(absolutePath)).toString('utf-8')) as { value?: unknown }
    const value = typeof parsed.value === 'string' ? parsed.value : null
    return rememberPagePayloadRead(absolutePath, value)
  } catch {
    return rememberPagePayloadRead(absolutePath, null)
  }
}

function buildRefFromPayloadPath(root: string, entryPath: string): string {
  const relative = normalize(entryPath).slice(root.length).replace(/^[/\\]+/, '').split(/[/\\]+/).join('/')
  return `${REF_PREFIX}${relative}`
}

export function scanPayloadDirectory(): PagePayloadFileScan {
  const root = getPayloadRootDir()
  if (!existsSync(root)) return { fileCount: 0, bytes: 0, refs: [] }
  let fileCount = 0
  let bytes = 0
  const refs: string[] = []
  const normalizedRoot = normalize(root)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
      } else {
        fileCount += 1
        bytes += statSync(entryPath).size
        if (entry.name.endsWith('.json.gz')) {
          refs.push(buildRefFromPayloadPath(normalizedRoot, entryPath))
        }
      }
    }
  }
  return { fileCount, bytes, refs }
}

export function deleteUnreferencedPayloadFiles(referencedRefs: Set<string>): PagePayloadCleanupResult {
  const root = getPayloadRootDir()
  if (!existsSync(root)) return { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0 }
  let scannedFiles = 0
  let deletedFiles = 0
  let deletedBytes = 0
  const normalizedRoot = normalize(root)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      scannedFiles += 1
      if (!entry.name.endsWith('.json.gz')) continue
      const ref = buildRefFromPayloadPath(normalizedRoot, entryPath)
      const legacyRef = `${LEGACY_REF_PREFIX}${ref.slice(REF_PREFIX.length)}`
      if (referencedRefs.has(ref) || referencedRefs.has(legacyRef)) continue
      const size = statSync(entryPath).size
      rmSync(entryPath, { force: true })
      // Keep the hot-path read cache honest: a deleted object must not read back.
      pagePayloadReadCache.delete(normalize(entryPath))
      deletedFiles += 1
      deletedBytes += size
    }
  }
  return { scannedFiles, deletedFiles, deletedBytes }
}
